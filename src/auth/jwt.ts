import type { FastifyInstance, FastifyRequest } from "fastify";
import { parsePublicKeys, tokenFromHeaders, verifyToken } from "./token.js";
import type { AuthStrategy, HomelabUser, JwtOptions } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    // The verified caller, or null on a public route without a valid token.
    user: HomelabUser | null;
    // The raw token behind `user`, for forwarding on app-to-app calls.
    homelabToken: string | null;
  }
  interface FastifyContextConfig {
    // Mark a route `{ config: { public: true } }` to skip the jwt strategy's
    // 401 (e.g. an inference gateway callback, or anything reached without the gate).
    // `user` is still filled in when a valid token happens to be present.
    public?: boolean;
  }
}

export interface JwtStrategy extends AuthStrategy {
  identify(request: FastifyRequest): { user: HomelabUser; token: string } | null;
}

// Methods a view-as token may use. Everything else is a write, and view-as
// is read-only in v1.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const createJwtStrategy = (options: JwtOptions = {}): JwtStrategy => {
  const keys = parsePublicKeys(options.keys ?? process.env.HOMELAB_TOKEN_KEYS);
  if (keys.size === 0) throw new Error("jwt auth strategy needs HOMELAB_TOKEN_KEYS");
  const now = options.now ?? Date.now;

  const identify = (request: FastifyRequest) => {
    const token = tokenFromHeaders(request.headers);
    if (!token) return null;
    const claims = verifyToken(token, keys, now());
    if (!claims) return null;
    const user: HomelabUser = {
      id: claims.sub,
      name: claims.name,
      // Claims come from untrusted JSON, so a token may omit these lists.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- claims are only cast to TokenClaims, not validated
      roles: claims.roles ?? [],
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see roles
      groups: claims.groups ?? [],
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see roles
      services: claims.services ?? [],
    };
    if (claims.act) user.actor = { id: claims.act.sub, name: claims.act.name };
    return { user, token };
  };

  return {
    name: "jwt",
    identify,
    authenticate(request) {
      if (request.user) return true;
      const found = identify(request);
      if (!found) return false;
      request.user = found.user;
      request.homelabToken = found.token;
      return true;
    },
  };
};

// Enforced for every route unless marked public: fill `request.user` from
// the token, 401 without a valid one, 403 on a write while viewing as
// someone else. Registered by createApp on the root instance, so it covers
// registerServices' routes too.
export const registerJwtAuth = (
  app: FastifyInstance,
  strategy: JwtStrategy,
  options: JwtOptions = {},
): void => {
  app.decorateRequest("user", null);
  app.decorateRequest("homelabToken", null);

  app.addHook("onRequest", async (request, reply) => {
    await strategy.authenticate(request);
    if (!request.user) {
      // config is undefined on routes without options (e.g. the not-found handler).
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime-undefined config despite the declared type
      if (request.routeOptions.config?.public) return;
      return reply.code(401).send({ error: "missing or invalid identity token" });
    }
    if (request.user.actor && !SAFE_METHODS.has(request.method)) {
      return reply.code(403).send({ error: "read-only while viewing as another person" });
    }
  });

  const meRoute = options.meRoute ?? "/api/me";
  if (meRoute) app.get(meRoute, (request) => Promise.resolve(request.user));
};
