import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/core.js";

let root: string;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "spa-test-"));
  writeFileSync(path.join(root, "index.html"), "<!doctype html><title>app</title>");
  mkdirSync(path.join(root, "assets"));
  writeFileSync(path.join(root, "assets", "app.js"), "console.log(1)");
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

const buildApp = async (legacyApiAliases = false) => {
  const app = await createApp({
    auth: { strategy: "tailnet-trust" },
    logger: false,
    spa: { root, legacyApiAliases },
    // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin signature must be async
    registerServices: async (scope) => {
      scope.get("/api/tasks", () => Promise.resolve({ tasks: [] }));
      scope.post("/api/tasks", () => Promise.resolve({ created: true }));
    },
  });
  return app;
};

const HTML = "text/html,application/xhtml+xml,*/*;q=0.8";

test("a page GET outside /api gets index.html", async () => {
  const app = await buildApp();
  for (const url of ["/", "/tasks", "/tasks/12?tab=log"]) {
    const response = await app.inject({ url, headers: { accept: HTML } });
    assert.equal(response.statusCode, 200, url);
    assert.match(response.headers["content-type"] as string, /text\/html/);
    assert.match(response.body, /<title>app<\/title>/);
  }
});

test("static files are served as themselves, missing ones 404", async () => {
  const app = await buildApp();
  const js = await app.inject({ url: "/assets/app.js" });
  assert.equal(js.statusCode, 200);
  assert.match(js.headers["content-type"] as string, /javascript/);
  const missing = await app.inject({ url: "/assets/gone-1234.js" });
  assert.equal(missing.statusCode, 404);
});

test("unknown /api paths get a JSON 404, known ones answer", async () => {
  const app = await buildApp();
  const response = await app.inject({ url: "/api/nope", headers: { accept: HTML } });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json<{ statusCode: number }>().statusCode, 404);
  const known = await app.inject({ url: "/api/tasks" });
  assert.deepEqual(known.json(), { tasks: [] });
  const bareApi = await app.inject({ method: "POST", url: "/api" });
  assert.equal(bareApi.statusCode, 404);
});

test("non-GET outside /api is a JSON 404, not index.html", async () => {
  const app = await buildApp();
  const response = await app.inject({ method: "POST", url: "/tasks" });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json<{ error: string }>().error, "Not Found");
});

test("without legacy aliases the old root API path is just a page", async () => {
  const app = await buildApp(false);
  const response = await app.inject({ url: "/tasks", headers: { accept: "application/json" } });
  assert.match(response.headers["content-type"] as string, /text\/html/);
});

test("legacy aliases answer old root API paths for non-HTML clients", async () => {
  const app = await buildApp(true);
  const aliasedGet = await app.inject({ url: "/tasks", headers: { accept: "*/*" } });
  assert.deepEqual(aliasedGet.json(), { tasks: [] });
  const aliasedPost = await app.inject({ method: "POST", url: "/tasks" });
  assert.deepEqual(aliasedPost.json(), { created: true });
  // A browser page load still gets the app, and real files still win.
  const page = await app.inject({ url: "/tasks", headers: { accept: HTML } });
  assert.match(page.body, /<title>app<\/title>/);
  const asset = await app.inject({ url: "/assets/app.js" });
  assert.equal(asset.statusCode, 200);
  // Root and health are never rewritten.
  const health = await app.inject({ url: "/health" });
  assert.equal(health.statusCode, 200);
  const rootPage = await app.inject({ url: "/" });
  assert.match(rootPage.body, /<title>app<\/title>/);
  // Already-prefixed paths aren't prefixed twice.
  const prefixed = await app.inject({ url: "/api/tasks" });
  assert.deepEqual(prefixed.json(), { tasks: [] });
});

test("legacy aliases don't treat a path escaping root as a static file", async () => {
  const app = await buildApp(true);
  const response = await app.inject({ url: "/..%2F..%2Fetc%2Fpasswd" });
  // @fastify/static refuses the traversal itself (403); what matters is that
  // nothing outside root is served.
  assert.ok(
    response.statusCode === 403 || response.statusCode === 404,
    String(response.statusCode),
  );
  assert.doesNotMatch(response.body, /root:/);
});
