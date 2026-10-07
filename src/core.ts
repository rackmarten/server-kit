import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import cors from "@fastify/cors";
import helmet, { type FastifyHelmetOptions } from "@fastify/helmet";
import { createAuthStrategy } from "./auth/index.js";
import { registerJwtAuth, type JwtStrategy } from "./auth/jwt.js";
import type { AuthConfig, AuthStrategy } from "./auth/types.js";
import { EightBallClient, type EightBallClientOptions } from "./eightball/client.js";
import { registerHealth } from "./health.js";
import { registerOpenApi, type OpenApiOptions } from "./openapi.js";
import { legacyApiRewrite, registerSpa, type CreateAppSpaOptions } from "./spa.js";

declare module "fastify" {
  interface FastifyInstance {
    auth: AuthStrategy;
    eightball?: EightBallClient;
  }
}

export interface CoreOptions {
  auth: AuthConfig;
  eightball?: EightBallClientOptions;
  cors?: boolean;
  // `true` (the default) registers @fastify/helmet with its own defaults, including a
  // locked-down Content-Security-Policy (img-src/media-src/etc. 'self' only) - fine for a
  // service that only ever serves its own assets, but it silently blocks anything a page loads
  // cross-origin (e.g. an app loading images from a separate media server's domain).
  // Pass helmet options (e.g. `{ contentSecurityPolicy: { directives: { imgSrc: ["'self'", "https://example.com"] } } }`)
  // to override just the directives that need loosening, rather than disabling helmet outright.
  helmet?: boolean | FastifyHelmetOptions;
  logger?: boolean;
  // Addresses allowed to set X-Forwarded-For, in Fastify's `trustProxy`
  // format (IPs, CIDRs, or proxy-addr keywords like "loopback"). Only a
  // request arriving from one of these has its XFF believed; anyone else
  // gets their socket address as `request.ip`. `true` would believe any
  // client's XFF, which let anyone reaching a port directly claim a tailnet
  // IP and pass tailnet-trust. Defaults to
  // DEFAULT_TRUSTED_PROXIES; a service behind a different proxy (e.g. a
  // Docker bridge gateway) passes its own list.
  trustProxy?: string | string[];
  // Fastify's default (1MiB) is too small for a route that receives a
  // base64-encoded image in its request body - e.g. an inference gateway
  // completion callback for a `vision` request, which echoes the full
  // original request (image included) back. Raise this
  // per-service when a real route needs it rather than raising the
  // default for everyone.
  bodyLimit?: number;
  // Runs as part of the /health route so a caller can fold in its own
  // check (e.g. a DB ping) instead of registering a competing route.
  healthCheck?: () => Promise<void> | void;
  // The OpenAPI document at /api/openapi.json (see openapi.ts). On unless
  // `false`; pass options to name the app in it. Under the jwt strategy the
  // document needs a token like any other route.
  openapi?: false | OpenApiOptions;
  // Serve the built PWA with the homelab URL convention (pages at /<route>,
  // JSON under /api) - see spa.ts. Same as calling registerSpa yourself,
  // except that only this route can turn on `legacyApiAliases`.
  spa?: CreateAppSpaOptions;
  // Service-specific routes/hooks/plugins - the equivalent of the old
  // Feathers `app.options` registration step. Each service's own app.ts
  // supplies these; core.ts only wires up the cross-cutting concerns
  // above before handing the instance off.
  registerServices?: FastifyPluginAsync;
}

// The maintainer's reverse proxy (Caddy) reaches backends from this LAN
// address, and anything co-located with it from loopback. Pass `trustProxy`
// to createApp for any other setup.
// eslint-disable-next-line sonarjs/no-hardcoded-ip -- functional default: the reverse proxy's LAN address
export const DEFAULT_TRUSTED_PROXIES = ["loopback", "192.168.0.103"];

export const createApp = async (options: CoreOptions): Promise<FastifyInstance> => {
  const app = Fastify({
    logger: options.logger ?? true,
    // Real client IPs must survive through the reverse proxy for the
    // tailnet-trust auth strategy to see anything other than Caddy's own
    // address (Caddy runs with network_mode: host for that). Only the
    // proxy itself is trusted to say what that IP was.
    trustProxy: options.trustProxy ?? DEFAULT_TRUSTED_PROXIES,
    bodyLimit: options.bodyLimit,
    rewriteUrl: options.spa?.legacyApiAliases ? legacyApiRewrite(options.spa) : undefined,
  });

  if (options.cors ?? true) await app.register(cors);
  if (options.helmet ?? true) {
    await (typeof options.helmet === "object"
      ? app.register(helmet, options.helmet)
      : app.register(helmet));
  }

  // Before any route, so it sees them all.
  if (options.openapi !== false) await registerOpenApi(app, options.openapi ?? {});

  const auth = createAuthStrategy(options.auth);
  app.decorate("auth", auth);
  // tailnet-trust stays advisory (apps call app.auth themselves); jwt is
  // enforced on every route not marked public, see auth/jwt.ts.
  if (options.auth.strategy === "jwt")
    registerJwtAuth(app, auth as JwtStrategy, options.auth.options);

  if (options.eightball) {
    app.decorate("eightball", new EightBallClient(options.eightball));
  }

  await registerHealth(app, options.healthCheck);

  if (options.spa) await registerSpa(app, options.spa);

  if (options.registerServices) {
    await app.register(options.registerServices);
  }

  return app;
};
