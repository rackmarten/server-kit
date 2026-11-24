import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createApp, type CoreOptions } from "../../src/core.js";
import { createUsageSender } from "../../src/usage/sender.js";
import type {
  UsageActorResolver,
  UsageEvent,
  UsageEventBatch,
  UsageInventory,
  UsageOptions,
} from "../../src/usage/index.js";

const INGEST = "https://ingest.example.com";

interface Sent {
  url: string;
  body: unknown;
}

const bodyOf = (init?: RequestInit): unknown => JSON.parse(init?.body as string);

// A stand-in ingest: records every POST and answers 202.
const fakeIngest = () => {
  const sent: Sent[] = [];
  const fetch = (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: url as string, body: bodyOf(init) });
    return Promise.resolve(new Response(null, { status: 202 }));
  };
  const events = () =>
    sent
      .filter((entry) => entry.url.endsWith("/v1/events"))
      .flatMap((entry) => (entry.body as UsageEventBatch).events);
  const inventory = () =>
    sent
      .filter((entry) => entry.url.endsWith("/v1/inventory"))
      .map((entry) => entry.body as UsageInventory);
  return { sent, fetch, events, inventory };
};

const counting = () => {
  const calls = { count: 0 };
  const fetch = () => {
    calls.count++;
    return Promise.resolve(new Response(null, { status: 202 }));
  };
  return { calls, fetch };
};

const buildApp = async (usage?: Partial<UsageOptions>, extra: Partial<CoreOptions> = {}) => {
  const app = await createApp({
    auth: { strategy: "tailnet-trust" },
    logger: false,
    ...extra,
    usage: usage && { app: "demo", endpoint: `${INGEST}/`, ...usage },
    // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin signature must be async
    registerServices: async (scope) => {
      scope.get("/api/things/:id", () => Promise.resolve({ ok: true }));
      scope.post("/api/things", () => Promise.resolve({ ok: true }));
      scope.get("/api/boom", () => Promise.reject(new Error("boom")));
    },
  });
  await app.ready();
  return app;
};

// Lets the fire-and-forget inventory POST settle.
const tick = () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const actorOf = (event: UsageEvent) => `${event.actorType}:${event.actorName}/${event.surface}`;

test("disabled by default: no relay route, nothing sent", async () => {
  const realFetch = globalThis.fetch;
  const { calls, fetch } = counting();
  globalThis.fetch = fetch;
  try {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/things/1" });
    assert.equal(response.statusCode, 200);
    const relay = await app.inject({ method: "POST", url: "/api/usage/events", payload: {} });
    assert.equal(relay.statusCode, 404);
    await app.close();
    await tick();
    assert.equal(calls.count, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a request event carries the route pattern, never the URL", async () => {
  const ingest = fakeIngest();
  const app = await buildApp({ fetch: ingest.fetch });
  await app.inject({ method: "GET", url: "/api/things/xyzzy?secret=hunter2" });
  await app.inject({ method: "POST", url: "/api/things", payload: { name: "x" } });
  await app.close();

  const events = ingest.events();
  assert.equal(events.length, 2);
  const [get, post] = events as [UsageEvent, UsageEvent];
  assert.equal(get.kind, "request");
  assert.equal(get.route, "/api/things/:id");
  assert.equal(get.method, "GET");
  assert.equal(get.status, 200);
  assert.equal(typeof get.durationMs, "number");
  assert.ok(!Number.isNaN(Date.parse(get.ts)));
  assert.equal(actorOf(get), "system:api/api");
  assert.equal(post.route, "/api/things");
  assert.equal(post.method, "POST");
  assert.ok(!JSON.stringify(ingest.sent).includes("hunter2"));
  // A non-numeric id, so a timestamp or duration can't match it by chance.
  assert.ok(!JSON.stringify(ingest.sent).includes("xyzzy"));
  assert.ok(ingest.sent.every((entry) => (entry.body as { app: string }).app === "demo"));
});

test("health, OpenAPI, docs, unmatched routes and the relay itself are not recorded", async () => {
  const ingest = fakeIngest();
  const app = await buildApp({ fetch: ingest.fetch });
  for (const url of ["/health", "/api/openapi.json", "/api/docs", "/api/docs/json", "/nope"]) {
    await app.inject({ method: "GET", url });
  }
  await app.inject({ method: "POST", url: "/api/usage/events", payload: { events: [] } });
  await app.close();
  assert.deepEqual(ingest.events(), []);
});

test("with an SPA only routes under the API prefix are recorded", async () => {
  const ingest = fakeIngest();
  const root = new URL(".", import.meta.url).pathname;
  const app = await buildApp({ fetch: ingest.fetch }, { spa: { root } });
  await app.inject({ method: "GET", url: "/usage.test.js" });
  await app.inject({ method: "GET", url: "/tasks/12" });
  await app.inject({ method: "GET", url: "/api/things/1" });
  await app.close();
  assert.deepEqual(
    ingest.events().map((event) => event.route),
    ["/api/things/:id"],
  );
});

// A minimal gate-shaped token for the jwt strategy (see test/auth/jwt.test.ts).
const jwtFixture = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keys = `k1:${publicKey.export({ format: "jwk" }).x ?? ""}`;
  const b64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: "k1" }));
  const payload = b64url(
    JSON.stringify({
      iss: "tower",
      aud: "homelab",
      iat: now,
      exp: now + 300,
      sub: "p1",
      name: "Demo",
      roles: [],
      groups: [],
      services: [],
    }),
  );
  const input = `${header}.${payload}`;
  const token = `${input}.${b64url(sign(null, Buffer.from(input), privateKey))}`;
  return { keys, token };
};

const demoResolver: UsageActorResolver = (request) =>
  request.headers["x-demo-actor"] === "bot"
    ? { actorType: "agent", actorName: "demo-bot", surface: "cli" }
    : null;

test("actor resolution: jwt user, actor header, resolver, PWA, fallback", async () => {
  const { keys, token } = jwtFixture();
  const withJwt = fakeIngest();
  const jwtApp = await buildApp(
    { fetch: withJwt.fetch, resolveActor: demoResolver },
    { auth: { strategy: "jwt", options: { keys } }, openapi: false },
  );
  // The jwt user beats every header.
  await jwtApp.inject({
    method: "GET",
    url: "/api/things/1",
    headers: {
      "x-homelab-token": token,
      "x-homelab-actor": "agent:runner",
      "x-demo-actor": "bot",
      "x-homelab-client": "pwa",
    },
  });
  await jwtApp.close();
  assert.deepEqual(
    withJwt.events().map((event) => actorOf(event)),
    ["human:p1/pwa"],
  );
  // The jwt strategy's own route is in the inventory too.
  const [jwtInventory] = withJwt.inventory();
  assert.ok(jwtInventory.items.some((item) => item.key === "GET /api/me"));

  const ingest = fakeIngest();
  const app = await buildApp({ fetch: ingest.fetch, resolveActor: demoResolver });
  const call = (headers: Record<string, string>) =>
    app.inject({ method: "GET", url: "/api/things/1", headers });
  // The actor header beats the resolver and the PWA.
  await call({
    "x-homelab-actor": "foreman:runner",
    "x-demo-actor": "bot",
    "x-homelab-client": "pwa",
  });
  // The resolver beats the PWA.
  await call({ "x-demo-actor": "bot", "x-homelab-client": "pwa" });
  await call({ "x-homelab-client": "pwa" });
  await call({});
  // An actor header with an unknown type falls through.
  await call({ "x-homelab-actor": "boss:me" });
  await app.close();
  assert.deepEqual(
    ingest.events().map((event) => actorOf(event)),
    [
      "foreman:runner/pwa",
      "agent:demo-bot/pwa",
      "human:operator/pwa",
      "system:api/api",
      "system:api/api",
    ],
  );
});

test("surface: cli for a named actor, otherwise the resolver's own surface", async () => {
  const ingest = fakeIngest();
  const app = await buildApp({
    fetch: ingest.fetch,
    resolveActor: (request) =>
      request.headers["x-demo-client"] === "pwa"
        ? { actorType: "human", actorName: "operator", surface: "pwa" }
        : null,
  });
  const call = (headers: Record<string, string>) =>
    app.inject({ method: "GET", url: "/api/things/1", headers });
  await call({ "x-homelab-actor": "agent:runner" });
  await call({ "x-demo-client": "pwa" });
  await app.close();
  assert.deepEqual(
    ingest.events().map((event) => actorOf(event)),
    ["agent:runner/cli", "human:operator/pwa"],
  );
});

test("relay: stamps the server-resolved actor, ignores the client's, always 204", async () => {
  const ingest = fakeIngest();
  const app = await buildApp({ fetch: ingest.fetch });
  const batch = {
    events: [
      {
        ts: "2026-11-23T10:00:00.000Z",
        kind: "view",
        route: "/tasks/:id?q=secret",
        module: "tasks",
        actorType: "agent",
        actorName: "spoofed",
        surface: "cli",
        app: "other",
      },
      { ts: "2026-11-23T10:01:00.000Z", kind: "active", route: "/tasks/:id", value: 42 },
      { kind: "click", route: "/tasks", feature: "new-task", ts: "not a date" },
      { kind: "request", route: "/api/things" },
      { kind: "view" },
      "junk",
    ],
  };
  const fromPwa = await app.inject({
    method: "POST",
    url: "/api/usage/events",
    headers: { "x-homelab-client": "pwa" },
    payload: batch,
  });
  assert.equal(fromPwa.statusCode, 204);
  // sendBeacon sets no headers, hence ?client=pwa, and may send text/plain.
  const beacon = await app.inject({
    method: "POST",
    url: "/api/usage/events?client=pwa",
    headers: { "content-type": "text/plain" },
    payload: JSON.stringify({ events: [{ kind: "view", route: "/home" }] }),
  });
  assert.equal(beacon.statusCode, 204);
  for (const payload of [{ events: "lots" }, "not json", {}]) {
    const response = await app.inject({ method: "POST", url: "/api/usage/events", payload });
    assert.equal(response.statusCode, 204);
  }
  const oversized = await app.inject({
    method: "POST",
    url: "/api/usage/events",
    headers: { "content-type": "text/plain" },
    payload: "x".repeat(2 * 1024 * 1024),
  });
  assert.equal(oversized.statusCode, 204);
  const badJson = await app.inject({
    method: "POST",
    url: "/api/usage/events",
    headers: { "content-type": "application/json" },
    payload: "{",
  });
  assert.equal(badJson.statusCode, 204);
  await app.close();

  const events = ingest.events();
  assert.equal(events.length, 4);
  for (const event of events) {
    assert.equal(actorOf(event), "human:operator/pwa");
    assert.ok(!("app" in event));
  }
  const [view, active, click, home] = events as [UsageEvent, UsageEvent, UsageEvent, UsageEvent];
  assert.deepEqual(view, {
    ts: "2026-11-23T10:00:00.000Z",
    kind: "view",
    route: "/tasks/:id",
    module: "tasks",
    actorType: "human",
    actorName: "operator",
    surface: "pwa",
  });
  assert.equal(active.value, 42);
  assert.equal(click.feature, "new-task");
  assert.ok(!Number.isNaN(Date.parse(click.ts)));
  assert.equal(home.route, "/home");
  assert.ok(ingest.sent.every((entry) => (entry.body as { app: string }).app === "demo"));
});

test("inventory: API routes on ready, merged with the app's view and feature keys", async () => {
  const ingest = fakeIngest();
  const app = await buildApp({
    fetch: ingest.fetch,
    inventory: [
      { kind: "view", key: "/tasks" },
      { kind: "feature", key: "new-task" },
      { kind: "view", key: "/tasks" },
    ],
  });
  await tick();
  const [inventory] = ingest.inventory();
  assert.ok(inventory);
  assert.equal(inventory.app, "demo");
  assert.deepEqual(
    inventory.items.map((item) => `${item.kind} ${item.key}`),
    [
      "api GET /api/things/:id",
      "api POST /api/things",
      "api GET /api/boom",
      "view /tasks",
      "feature new-task",
    ],
  );
  await app.close();
});

const sampleEvent: UsageEvent = {
  ts: "2026-11-23T10:00:00.000Z",
  kind: "request",
  route: "/r",
  actorType: "system",
  actorName: "api",
  surface: "api",
};

test("ingest down: requests still succeed, nothing throws, logged at most once a minute", async () => {
  const calls = { count: 0 };
  const refused = () => {
    calls.count++;
    return Promise.reject(new Error("connect ECONNREFUSED"));
  };
  const app = await buildApp({ fetch: refused });
  for (let i = 0; i < 3; i++) {
    const response = await app.inject({ method: "GET", url: "/api/things/1" });
    assert.equal(response.statusCode, 200);
  }
  const boom = await app.inject({ method: "GET", url: "/api/boom" });
  assert.equal(boom.statusCode, 500);
  const relay = await app.inject({
    method: "POST",
    url: "/api/usage/events",
    payload: { events: [{ kind: "view", route: "/x" }] },
  });
  assert.equal(relay.statusCode, 204);
  await app.close();
  // The inventory and the final flush were both tried.
  assert.ok(calls.count >= 2);

  const logged: unknown[] = [];
  const sender = createUsageSender({
    app: "demo",
    endpoint: INGEST,
    logger: { debug: (context) => logged.push(context) },
    fetch: () => Promise.resolve(new Response(null, { status: 503 })),
  });
  for (let i = 0; i < 3; i++) {
    sender.record({ ...sampleEvent, route: `/r${String(i)}` });
    await sender.flush();
  }
  // Failed batches are dropped, not retried.
  assert.equal(sender.buffered, 0);
  assert.equal(logged.length, 1);
  await sender.close();
});

test("buffer cap drops the oldest events", async () => {
  const batches: string[][] = [];
  const gate: { release?: () => void } = {};
  const released = new Promise<void>((resolve) => {
    gate.release = resolve;
  });
  const sender = createUsageSender({
    app: "demo",
    endpoint: INGEST,
    maxBuffer: 3,
    logger: { debug: () => {} },
    fetch: async (_url, init) => {
      const batch = bodyOf(init) as UsageEventBatch;
      batches.push(batch.events.map((event) => event.route));
      await released;
      return new Response(null, { status: 202 });
    },
  });
  // The third event starts a flush, which hangs; the next five pile up
  // behind it and only the newest three are kept.
  for (let i = 1; i <= 8; i++) sender.record({ ...sampleEvent, route: `/r${String(i)}` });
  assert.equal(sender.buffered, 3);
  gate.release?.();
  await sender.close();
  assert.deepEqual(batches, [
    ["/r1", "/r2", "/r3"],
    ["/r6", "/r7", "/r8"],
  ]);
});

test("an empty endpoint records nothing", async () => {
  const { calls, fetch } = counting();
  const app = await buildApp({ endpoint: "", fetch });
  await app.inject({ method: "GET", url: "/api/things/1" });
  await app.close();
  await tick();
  assert.equal(calls.count, 0);
});

test("close gives up on a hanging ingest after one deadline", async () => {
  const sender = createUsageSender({
    app: "demo",
    endpoint: INGEST,
    logger: { debug: () => {} },
    // Never answers, and ignores the abort signal too.
    fetch: () => new Promise<Response>(() => {}),
  });
  for (let i = 0; i < 1200; i++) sender.record({ ...sampleEvent, route: `/r${String(i)}` });
  const started = Date.now();
  await sender.close();
  assert.ok(Date.now() - started < 6000);
});
