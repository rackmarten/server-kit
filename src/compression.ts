import { Readable } from "node:stream";
import compress from "@fastify/compress";
import etag from "@fastify/etag";
import type { FastifyInstance } from "fastify";

// Small responses on the wire and cheap polling, for every route registered
// after this call (@fastify/compress only hooks routes added after it, which
// is why createApp calls this before its own routes and the SPA):
//
// - br/gzip compression for clients that accept it.
// - A weak ETag on every string/Buffer body, and an empty 304 when a GET or
//   HEAD 200 is unchanged, so a client polling a JSON list re-downloads it
//   only when it changed.
// - `cache-control: no-cache` on JSON that set no cache-control of its own,
//   so the browser revalidates (and gets that 304) instead of guessing.
//
// A route writing to reply.raw (SSE) bypasses Fastify's send pipeline, so
// none of this touches it. Static files keep @fastify/static's own ETag and
// conditional handling.

const opaque = (tag: string): string => tag.trim().replace(/^W\//, "");

/** RFC 9110 weak comparison of an If-None-Match header against one tag. */
export const etagMatches = (ifNoneMatch: string | undefined, tag: string): boolean => {
  if (!ifNoneMatch) return false;
  const want = opaque(tag);
  return ifNoneMatch.split(",").some((value) => value.trim() === "*" || opaque(value) === want);
};

export const registerCompression = async (app: FastifyInstance): Promise<void> => {
  // etag first: its onSend hook has to hash the serialized body before
  // compress turns it into a stream (a stream gets no ETag). Weak, because
  // one tag covers the br, gzip and identity encodings of the same body. Its
  // own 304 is off: it answers 304 for any method and status, and its null
  // payload crashes Fastify's HEAD handler. The hook below does it instead.
  await app.register(etag, { weak: true, replyWith304: false });
  app.addHook("onSend", async (request, reply, payload) => {
    const type = reply.getHeader("content-type");
    if (typeof type === "string" && type.includes("json") && !reply.hasHeader("cache-control"))
      reply.header("cache-control", "no-cache");

    if (request.method !== "GET" && request.method !== "HEAD") return payload;
    if (reply.statusCode !== 200 || payload instanceof Readable) return payload;
    const tag = reply.getHeader("etag");
    if (typeof tag !== "string" || !etagMatches(request.headers["if-none-match"], tag))
      return payload;
    reply.code(304);
    // "" rather than null: Fastify's HEAD handler throws on a null payload.
    // Either way no body goes out with a 304.
    return "";
  });
  // Request bodies are left alone (no Content-Encoding inflation, which
  // would also turn an unknown encoding into a 415): only responses change.
  await app.register(compress, {
    global: true,
    encodings: ["br", "gzip"],
    globalDecompression: false,
  });
};
