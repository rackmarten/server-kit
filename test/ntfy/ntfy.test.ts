/* eslint-disable sonarjs/no-clear-text-protocols -- fixture URLs for a fake local ntfy server */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createNtfyClient } from "../../src/ntfy/index.js";

interface Call {
  url: string;
  init: RequestInit;
}

const stubFetch = (respond: () => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: url instanceof Request ? url.url : String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { fn, calls };
};

const stubLogger = () => {
  const warnings: Array<{ context: unknown; msg?: string }> = [];
  return {
    warnings,
    logger: { warn: (context: unknown, msg?: string) => warnings.push({ context, msg }) },
  };
};

test("notify posts ntfy's JSON publish with the bearer token", async () => {
  const { fn, calls } = stubFetch(() => new Response("{}", { status: 200 }));
  const ntfy = createNtfyClient({ url: "http://192.168.0.42/", token: "tk_abc", fetch: fn });
  const didSend = await ntfy.notify({
    topic: "app",
    title: "Úloha hotová",
    message: "Job 12 is done",
    clickUrl: "https://app.example.com/jobs/12",
    priority: "high",
    tags: ["white_check_mark"],
  });
  assert.equal(didSend, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://192.168.0.42");
  assert.equal(calls[0].init.method, "POST");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer tk_abc");
  assert.deepEqual(JSON.parse(calls[0].init.body as string), {
    topic: "app",
    message: "Job 12 is done",
    title: "Úloha hotová",
    click: "https://app.example.com/jobs/12",
    priority: 4,
    tags: ["white_check_mark"],
  });
});

test("optional fields are left out and numeric priority passes through", async () => {
  const { fn, calls } = stubFetch(() => new Response("{}"));
  const ntfy = createNtfyClient({ url: "http://ntfy", token: undefined, fetch: fn });
  await ntfy.notify({ topic: "demo", message: "hi" });
  await ntfy.notify({ topic: "demo", message: "hi", priority: 2, tags: [] });
  assert.deepEqual(JSON.parse(calls[0].init.body as string), { topic: "demo", message: "hi" });
  assert.deepEqual(JSON.parse(calls[1].init.body as string), {
    topic: "demo",
    message: "hi",
    priority: 2,
  });
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, undefined);
});

test("a network failure logs and resolves false", async () => {
  const { fn } = stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  const { logger, warnings } = stubLogger();
  const ntfy = createNtfyClient({ url: "http://ntfy", token: "t", fetch: fn, logger });
  assert.equal(await ntfy.notify({ topic: "app", message: "down" }), false);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0].context, { topic: "app", err: "fetch failed" });
});

test("a non-2xx response logs status and body and resolves false", async () => {
  const { fn } = stubFetch(() => new Response('{"error":"forbidden"}', { status: 403 }));
  const { logger, warnings } = stubLogger();
  const ntfy = createNtfyClient({ url: "http://ntfy", token: "t", fetch: fn, logger });
  assert.equal(await ntfy.notify({ topic: "grafana", message: "x" }), false);
  assert.deepEqual(warnings[0].context, {
    topic: "grafana",
    status: 403,
    detail: '{"error":"forbidden"}',
  });
});

test("no url makes notify a silent no-op", async () => {
  const { fn, calls } = stubFetch(() => new Response("{}"));
  const { logger, warnings } = stubLogger();
  const ntfy = createNtfyClient({ url: "", token: "t", fetch: fn, logger });
  assert.equal(await ntfy.notify({ topic: "app", message: "x" }), false);
  assert.equal(calls.length, 0);
  assert.equal(warnings.length, 0);
});
