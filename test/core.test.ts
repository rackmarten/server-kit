/* eslint-disable sonarjs/no-hardcoded-ip -- the fixtures are literal client and proxy addresses */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/core.js";

// Echoes what tailnet-trust decided and which IP Fastify resolved, so each
// case can be driven through app.inject with a chosen socket address.
const buildApp = async (trustProxy?: string | string[]) => {
  const app = await createApp({ auth: { strategy: "tailnet-trust" }, logger: false, trustProxy });
  app.get("/whoami", async (request) => ({
    ip: request.ip,
    allowed: await app.auth.authenticate(request),
  }));
  return app;
};

const whoami = async (
  app: Awaited<ReturnType<typeof buildApp>>,
  remoteAddress: string,
  xff?: string,
) => {
  const response = await app.inject({
    method: "GET",
    url: "/whoami",
    remoteAddress,
    headers: xff ? { "x-forwarded-for": xff } : {},
  });
  return response.json<{ ip: string; allowed: boolean }>();
};

test("forged X-Forwarded-For from an untrusted source is ignored", async () => {
  const app = await buildApp();
  assert.deepEqual(await whoami(app, "203.0.113.9", "100.64.0.5"), {
    ip: "203.0.113.9",
    allowed: false,
  });
  // A LAN peer that is not the reverse proxy is just as untrusted.
  assert.deepEqual(await whoami(app, "192.168.0.150", "100.64.0.5"), {
    ip: "192.168.0.150",
    allowed: false,
  });
});

test("the reverse proxy's Caddy forwarding a tailnet client passes", async () => {
  const app = await buildApp();
  assert.deepEqual(await whoami(app, "192.168.0.103", "100.64.0.5"), {
    ip: "100.64.0.5",
    allowed: true,
  });
  // Caddy on the same host connects over loopback.
  assert.deepEqual(await whoami(app, "127.0.0.1", "100.64.0.5"), {
    ip: "100.64.0.5",
    allowed: true,
  });
});

test("Caddy forwarding a non-tailnet client is rejected", async () => {
  const app = await buildApp();
  assert.deepEqual(await whoami(app, "192.168.0.103", "203.0.113.9"), {
    ip: "203.0.113.9",
    allowed: false,
  });
});

test("a direct tailnet connection without a proxy still passes", async () => {
  const app = await buildApp();
  assert.deepEqual(await whoami(app, "100.64.0.7"), { ip: "100.64.0.7", allowed: true });
});

test("trustProxy is configurable per service", async () => {
  const app = await buildApp(["172.18.0.1"]);
  assert.deepEqual(await whoami(app, "172.18.0.1", "100.64.0.5"), {
    ip: "100.64.0.5",
    allowed: true,
  });
  assert.deepEqual(await whoami(app, "192.168.0.103", "100.64.0.5"), {
    ip: "192.168.0.103",
    allowed: false,
  });
});
