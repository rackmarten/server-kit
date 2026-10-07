import { statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";

// The URL convention: pages live at `/<route>`
// (vue-router web history, no `/#/`), every JSON API lives under `/api`.
export interface SpaOptions {
  // The built PWA's dist/ directory, index.html included.
  root: string;
  apiPrefix?: string;
}

export interface CreateAppSpaOptions extends SpaOptions {
  // Transition aid: keep answering the pre-/api root paths (e.g. GET /tasks
  // from an old CLI or webhook) by rewriting them to `/api/...`, so clients
  // can move over before the aliases go. Only requests that aren't a page
  // load (Accept without text/html) and don't name a real static file are
  // rewritten; `/` and `/health` never are. Remove once every client of the
  // app has moved.
  legacyApiAliases?: boolean;
}

const DEFAULT_API_PREFIX = "/api";

const pathOf = (url: string): string => {
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : url.slice(0, queryStart);
};

const isUnder = (urlPath: string, prefix: string): boolean =>
  urlPath === prefix || urlPath.startsWith(`${prefix}/`);

// A missing /assets/app-1234.js should 404, not come back as index.html
// (the browser would then report a MIME error instead of a missing chunk).
const looksLikeFile = (urlPath: string): boolean => path.posix.extname(urlPath) !== "";

// Serves the built PWA: real files as themselves, any other GET/HEAD outside
// the API prefix as index.html (so a deep link or reload of /tasks/12 opens
// the app), and a JSON 404 for everything under the API prefix.
export const registerSpa = async (app: FastifyInstance, options: SpaOptions): Promise<void> => {
  const apiPrefix = options.apiPrefix ?? DEFAULT_API_PREFIX;

  await app.register(fastifyStatic, { root: options.root });

  app.setNotFoundHandler((request, reply) => {
    const urlPath = pathOf(request.url);
    const isPage =
      (request.method === "GET" || request.method === "HEAD") &&
      !isUnder(urlPath, apiPrefix) &&
      !looksLikeFile(urlPath);
    if (isPage) return reply.type("text/html; charset=utf-8").sendFile("index.html");
    return reply.code(404).send({
      message: `Route ${request.method}:${urlPath} not found`,
      error: "Not Found",
      statusCode: 404,
    });
  });
};

const isStaticFile = (root: string, urlPath: string): boolean => {
  try {
    const file = path.join(root, decodeURIComponent(urlPath));
    if (!file.startsWith(path.resolve(root) + path.sep)) return false;
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

// Fastify's rewriteUrl, which has to be set when the instance is created -
// that's why the aliases are a createApp option rather than part of
// registerSpa.
export const legacyApiRewrite = (options: SpaOptions): ((req: IncomingMessage) => string) => {
  const apiPrefix = options.apiPrefix ?? DEFAULT_API_PREFIX;
  const root = path.resolve(options.root);
  return (req) => {
    const url = req.url ?? "/";
    const urlPath = pathOf(url);
    if (urlPath === "/" || urlPath === "/health" || isUnder(urlPath, apiPrefix)) return url;
    const isRead = req.method === "GET" || req.method === "HEAD";
    if (isRead && (req.headers.accept ?? "").includes("text/html")) return url;
    if (isRead && isStaticFile(root, urlPath)) return url;
    return apiPrefix + url;
  };
};
