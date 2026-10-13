import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createApp } from "../../src/core.js";
import { parsePublicKeys, verifyToken } from "../../src/auth/token.js";

// Mirrors the gate's signToken, so these
// tokens are shaped exactly like the ones the gate injects.
const b64url = (input: string | Buffer) => Buffer.from(input).toString("base64url");

const makeKey = (kid: string) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { kid, privateKey, entry: `${kid}:${publicKey.export({ format: "jwk" }).x ?? ""}` };
};

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const nowSeconds = Math.floor(NOW / 1000);

const mint = (
  key: { kid: string; privateKey: KeyObject },
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
) => {
  const encodedHeader = b64url(
    JSON.stringify({ alg: "EdDSA", typ: "JWT", kid: key.kid, ...header }),
  );
  const encodedPayload = b64url(
    JSON.stringify({
      iss: "tower",
      aud: "homelab",
      iat: nowSeconds,
      exp: nowSeconds + 300,
      sub: "p1",
      name: "Marek",
      roles: [],
      groups: ["family"],
      services: ["app.example.com"],
      ...claims,
    }),
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  return `${signingInput}.${b64url(sign(null, Buffer.from(signingInput), key.privateKey))}`;
};

const current = makeKey("tower-a");
const previous = makeKey("tower-b");
const stranger = makeKey("tower-a"); // same kid, different key

test("verifyToken: valid, expired, unknown kid, wrong key, tampered, alg none, wrong audience", () => {
  const keys = parsePublicKeys(current.entry);
  assert.equal(verifyToken(mint(current), keys, NOW)?.sub, "p1");
  assert.equal(verifyToken(mint(current, { exp: nowSeconds }), keys, NOW), null);
  assert.equal(verifyToken(mint(previous), keys, NOW), null);
  assert.equal(verifyToken(mint(stranger), keys, NOW), null);

  const [encodedHeader, , signature] = mint(current).split(".");
  const forged = b64url(
    JSON.stringify({
      iss: "tower",
      aud: "homelab",
      exp: nowSeconds + 300,
      sub: "p1",
      roles: ["admin"],
    }),
  );
  assert.equal(verifyToken(`${encodedHeader}.${forged}.${signature}`, keys, NOW), null);

  const noneHeader = b64url(JSON.stringify({ alg: "none", kid: "tower-a" }));
  const noneToken = `${noneHeader}.${mint(current).split(".", 2)[1]}.`;
  assert.equal(verifyToken(noneToken, keys, NOW), null);

  assert.equal(verifyToken(mint(current, { aud: "elsewhere" }), keys, NOW), null);
  assert.equal(verifyToken(mint(current, { iss: "someone" }), keys, NOW), null);
  assert.equal(verifyToken("not-a-token", keys, NOW), null);
});

test("verifyToken: both keys verify during a rotation", () => {
  const keys = parsePublicKeys(`${current.entry}, ${previous.entry}`);
  assert.equal(verifyToken(mint(current), keys, NOW)?.sub, "p1");
  assert.equal(verifyToken(mint(previous), keys, NOW)?.sub, "p1");
});

const buildApp = async () => {
  const app = await createApp({
    auth: { strategy: "jwt", options: { keys: current.entry, now: () => NOW } },
    logger: false,
    // eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugin signature must be async
    registerServices: async (instance) => {
      instance.get("/api/things", (req) => Promise.resolve({ user: req.user?.id }));
      instance.post("/api/things", () => Promise.resolve({ ok: true }));
      instance.post("/api/callback", { config: { public: true } }, (req) =>
        Promise.resolve({ user: req.user?.id ?? null }),
      );
    },
  });
  return app;
};

test("jwt strategy: 401 without a token, 401 with a bad one", async () => {
  const app = await buildApp();
  const unauthenticated = await app.inject({ url: "/api/things" });
  assert.equal(unauthenticated.statusCode, 401);
  const bad = await app.inject({
    url: "/api/things",
    headers: { "x-homelab-token": mint(previous) },
  });
  assert.equal(bad.statusCode, 401);
});

test("jwt strategy: X-Homelab-Token and Bearer fallback both fill req.user", async () => {
  const app = await buildApp();
  const direct = await app.inject({
    url: "/api/things",
    headers: { "x-homelab-token": mint(current) },
  });
  assert.deepEqual(direct.json(), { user: "p1" });
  const bearer = await app.inject({
    url: "/api/things",
    headers: { authorization: `Bearer ${mint(current)}` },
  });
  assert.deepEqual(bearer.json(), { user: "p1" });
});

test("jwt strategy: a view-as token reads but cannot write", async () => {
  const app = await buildApp();
  const token = mint(current, { act: { sub: "admin1", name: "Admin" } });
  const read = await app.inject({ url: "/api/things", headers: { "x-homelab-token": token } });
  assert.equal(read.statusCode, 200);
  const write = await app.inject({
    method: "POST",
    url: "/api/things",
    headers: { "x-homelab-token": token },
  });
  assert.equal(write.statusCode, 403);
  const plain = await app.inject({
    method: "POST",
    url: "/api/things",
    headers: { "x-homelab-token": mint(current) },
  });
  assert.equal(plain.statusCode, 200);
});

test("jwt strategy: public routes and /health skip the 401", async () => {
  const app = await buildApp();
  const health = await app.inject({ url: "/health" });
  assert.equal(health.statusCode, 200);
  const anonymous = await app.inject({ method: "POST", url: "/api/callback" });
  assert.deepEqual(anonymous.json(), { user: null });
  const withToken = await app.inject({
    method: "POST",
    url: "/api/callback",
    headers: { "x-homelab-token": mint(current) },
  });
  assert.deepEqual(withToken.json(), { user: "p1" });
});

test("jwt strategy: /api/me returns the caller, including the admin behind view-as", async () => {
  const app = await buildApp();
  const me = await app.inject({
    url: "/api/me",
    headers: { "x-homelab-token": mint(current, { act: { sub: "a1", name: "Admin" } }) },
  });
  assert.deepEqual(me.json(), {
    id: "p1",
    name: "Marek",
    roles: [],
    groups: ["family"],
    services: ["app.example.com"],
    actor: { id: "a1", name: "Admin" },
  });
});

test("jwt strategy refuses to start without keys", async () => {
  const saved = process.env.HOMELAB_TOKEN_KEYS;
  delete process.env.HOMELAB_TOKEN_KEYS;
  try {
    await assert.rejects(
      createApp({ auth: { strategy: "jwt" }, logger: false }),
      /HOMELAB_TOKEN_KEYS/,
    );
  } finally {
    if (saved !== undefined) process.env.HOMELAB_TOKEN_KEYS = saved;
  }
});

test("jwt strategy: the OpenAPI document requires the token except on public routes", async () => {
  const app = await buildApp();
  const response = await app.inject({
    url: "/api/openapi.json",
    headers: { "x-homelab-token": mint(current) },
  });
  const doc = response.json<{
    components: { securitySchemes: Record<string, { type: string }> };
    security: Record<string, string[]>[];
    paths: Record<string, Record<string, { security?: unknown }>>;
  }>();
  assert.deepEqual(Object.keys(doc.components.securitySchemes), ["bearerAuth", "tokenHeader"]);
  assert.deepEqual(doc.security, [{ bearerAuth: [] }, { tokenHeader: [] }]);
  assert.equal(doc.paths["/api/things"].get.security, undefined);
  assert.deepEqual(doc.paths["/api/callback"].post.security, []);
  assert.deepEqual(doc.paths["/health"].get.security, []);
  // The UI sits behind the token like every other route.
  const docs = await app.inject({ url: "/api/docs" });
  assert.equal(docs.statusCode, 401);
  await app.close();
});
