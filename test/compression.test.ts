import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createApp } from "../src/core.js";
import { etagMatches } from "../src/compression.js";

// Big enough to cross @fastify/compress's default 1KiB threshold.
const rows = Array.from({ length: 200 }, (_, index) => ({
  id: index + 1,
  title: `Task ${String(index + 1)}`,
  description: "Some longer description text that repeats a fair bit. ".repeat(4),
}));

let root: string;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "compression-test-"));
  writeFileSync(
    path.join(root, "index.html"),
    `<!doctype html><title>t</title>${"<div></div>".repeat(500)}`,
  );
  mkdirSync(path.join(root, "assets"));
  writeFileSync(
    path.join(root, "assets", "app-1234.js"),
    `console.log(${JSON.stringify("x".repeat(5000))});`,
  );
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const buildApp = async (compression?: boolean) =>
  createApp({
    auth: { strategy: "tailnet-trust" },
    logger: false,
    compression,
    spa: { root },
    // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin signature must be async
    registerServices: async (scope) => {
      scope.get("/api/tasks", () => rows);
      scope.get("/api/tasks/1", () => rows[0]);
      scope.patch("/api/tasks/1", () => rows[0]);
      scope.get("/api/missing", async (_request, reply) => {
        await reply.code(404).send({ error: "no such task" });
      });
      scope.get("/api/cached", (_request, reply) => {
        reply.header("cache-control", "max-age=60");
        return { ok: true };
      });
      // Raw writes and no return value, like an SSE endpoint.
      scope.get("/api/events", (request, reply) => {
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
        });
        reply.raw.write(": connected\n\n");
        const timer = setInterval(() => reply.raw.write("data: ping\n\n"), 20);
        request.raw.on("close", () => {
          clearInterval(timer);
        });
      });
    },
  });

test("the SPA, a deep link, a hashed asset and the API are br-compressed", async () => {
  const app = await buildApp();
  for (const url of ["/", "/tasks/12", "/assets/app-1234.js", "/api/tasks"]) {
    const response = await app.inject({ url, headers: { "accept-encoding": "br, gzip" } });
    assert.equal(response.statusCode, 200, url);
    assert.equal(response.headers["content-encoding"], "br", `${url} not compressed`);
  }
  await app.close();
});

test("gzip when that is all the client takes, identity when it takes nothing", async () => {
  const app = await buildApp();
  const gz = await app.inject({ url: "/api/tasks", headers: { "accept-encoding": "gzip" } });
  assert.equal(gz.headers["content-encoding"], "gzip");
  const body = JSON.parse(gunzipSync(gz.rawPayload).toString("utf8")) as unknown[];
  assert.equal(body.length, 200);
  assert.ok(gz.rawPayload.length < JSON.stringify(body).length / 3);

  const plain = await app.inject({ url: "/api/tasks" });
  assert.equal(plain.headers["content-encoding"], undefined);
  await app.close();
});

test("compression: false leaves responses as they were", async () => {
  const app = await buildApp(false);
  const response = await app.inject({
    url: "/api/tasks",
    headers: { "accept-encoding": "br, gzip" },
  });
  assert.equal(response.headers["content-encoding"], undefined);
  assert.equal(response.headers.etag, undefined);
  assert.equal(response.headers["cache-control"], undefined);
  await app.close();
});

test("an unchanged API response is an empty 304 when the client sends its ETag back", async () => {
  const app = await buildApp();
  const first = await app.inject({ url: "/api/tasks", headers: { "accept-encoding": "gzip" } });
  const tag = first.headers.etag;
  assert.ok(
    typeof tag === "string" && tag.startsWith('W/"'),
    `expected a weak ETag, got ${String(tag)}`,
  );
  assert.equal(first.headers["cache-control"], "no-cache");

  const again = await app.inject({
    url: "/api/tasks",
    headers: { "accept-encoding": "gzip", "if-none-match": tag },
  });
  assert.equal(again.statusCode, 304);
  assert.equal(again.rawPayload.length, 0);

  // The tag is of the uncompressed body, so it doesn't depend on encoding.
  const plain = await app.inject({ url: "/api/tasks" });
  assert.equal(plain.headers.etag, tag);

  const stale = await app.inject({
    url: "/api/tasks",
    headers: { "if-none-match": '"something-else"' },
  });
  assert.equal(stale.statusCode, 200);
  await app.close();
});

test("only a GET/HEAD 200 becomes a 304, never an error or a write", async () => {
  const app = await buildApp();
  const missing = await app.inject({ url: "/api/missing" });
  assert.equal(missing.statusCode, 404);
  const missingAgain = await app.inject({
    url: "/api/missing",
    headers: { "if-none-match": missing.headers.etag as string },
  });
  assert.equal(missingAgain.statusCode, 404);
  assert.match(missingAgain.body, /no such task/);

  const got = await app.inject({ url: "/api/tasks/1" });
  const tag = got.headers.etag as string;
  const patched = await app.inject({
    method: "PATCH",
    url: "/api/tasks/1",
    payload: {},
    headers: { "if-none-match": tag },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json<{ id: number }>().id, 1);
  await app.close();
});

test("a HEAD with a matching ETag is a 304, not a 500", async () => {
  const app = await buildApp();
  const got = await app.inject({ url: "/api/tasks/1" });
  const head = await app.inject({
    method: "HEAD",
    url: "/api/tasks/1",
    headers: { "if-none-match": got.headers.etag as string },
  });
  assert.equal(head.statusCode, 304);
  assert.equal(head.rawPayload.length, 0);
  await app.close();
});

test("a route's own cache-control is kept, and only JSON gets the default", async () => {
  const app = await buildApp();
  const cached = await app.inject({ url: "/api/cached" });
  assert.equal(cached.headers["cache-control"], "max-age=60");
  const page = await app.inject({ url: "/tasks/12" });
  assert.notEqual(page.headers["cache-control"], "no-cache");
  await app.close();
});

test("hashed assets are immutable for a year, index.html is revalidated", async () => {
  const app = await buildApp();
  const asset = await app.inject({ url: "/assets/app-1234.js" });
  assert.equal(asset.statusCode, 200);
  assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
  for (const url of ["/", "/index.html", "/tasks/12"]) {
    const page = await app.inject({ url });
    assert.equal(page.headers["cache-control"], "public, max-age=0", url);
    assert.ok(page.headers.etag, `${url} has no ETag`);
  }
  const missing = await app.inject({ url: "/assets/gone-1234.js" });
  assert.equal(missing.statusCode, 404);
  await app.close();
});

test("an unchanged index.html is still a 304 through @fastify/static", async () => {
  const app = await buildApp();
  const first = await app.inject({ url: "/" });
  const again = await app.inject({
    url: "/",
    headers: { "if-none-match": first.headers.etag as string },
  });
  assert.equal(again.statusCode, 304);
  await app.close();
});

test("SSE written to reply.raw is not compressed or buffered", async () => {
  const app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  const first = await new Promise<{ headers: http.IncomingHttpHeaders; chunk: string }>(
    (resolve, reject) => {
      const request = http.get(
        { port, host: "127.0.0.1", path: "/api/events", headers: { "accept-encoding": "gzip" } },
        (response) => {
          response.once("data", (chunk: Buffer) => {
            resolve({ headers: response.headers, chunk: chunk.toString("utf8") });
            request.destroy();
          });
        },
      );
      request.on("error", reject);
    },
  );
  assert.equal(first.headers["content-encoding"], undefined);
  assert.equal(first.headers["content-type"], "text/event-stream");
  assert.match(first.chunk, /: connected/);
  await app.close();
});

test("etagMatches: weak comparison, lists and *", () => {
  assert.equal(etagMatches(undefined, 'W/"a"'), false);
  assert.equal(etagMatches('W/"a"', 'W/"a"'), true);
  assert.equal(etagMatches('"a"', 'W/"a"'), true);
  assert.equal(etagMatches('"b", W/"a"', 'W/"a"'), true);
  assert.equal(etagMatches("*", 'W/"a"'), true);
  assert.equal(etagMatches('"b"', 'W/"a"'), false);
});
