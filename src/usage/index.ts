import type { FastifyInstance, FastifyRequest } from "fastify";
import { createUsageSender, type UsageSender } from "./sender.js";
import {
  USAGE_MAX_BATCH,
  USAGE_RELAY_ROUTE,
  type UsageActor,
  type UsageActorType,
  type UsageEvent,
  type UsageInventoryItem,
  type UsageSurface,
} from "./types.js";

export type * from "./types.js";
export { USAGE_MAX_BATCH, USAGE_RELAY_ROUTE } from "./types.js";
export { DEFAULT_USAGE_FLUSH_INTERVAL_MS, DEFAULT_USAGE_MAX_BUFFER } from "./sender.js";

// An app's own way to name a caller, for whatever its headers say that
// server-kit doesn't know (e.g. an app-specific actor header). Return null
// to fall through to the next rule.
export type UsageActorResolver = (
  request: FastifyRequest,
) => (UsageActor & { surface?: UsageSurface }) | null | undefined;

export interface UsageOptions {
  // The app's name in the central store.
  app: string;
  // The usage ingest's base URL (`/v1/events` and `/v1/inventory` are
  // appended). Empty records nothing, for local dev.
  endpoint: string;
  resolveActor?: UsageActorResolver;
  // The app's `view` and `feature` keys, sent along with its API routes as
  // its inventory.
  inventory?: UsageInventoryItem[];
  // Default 15s.
  flushIntervalMs?: number;
  // Events held while the ingest is slow or down; the oldest go first.
  // Default 5000.
  maxBuffer?: number;
  // For tests.
  fetch?: typeof fetch;
}

// Paths createApp keeps out of the usage data: its own plumbing (/health,
// the OpenAPI document and UI) and, with an SPA, everything outside the API
// prefix (pages are counted as views by the browser instead).
export interface UsageScope {
  ignore: string[];
  apiPrefix?: string;
}

const ACTOR_TYPES = new Set<string>(["human", "agent", "foreman", "system"]);
const CLIENT_KINDS = new Set<string>(["view", "active", "click"]);
// A name, never something that could carry free text.
const ACTOR_NAME = /^[\w.@-]{1,64}$/;
const UNTRACKED_METHODS = new Set(["HEAD", "OPTIONS"]);
const MAX_NAME_LENGTH = 200;

const isUnder = (urlPath: string, prefix: string): boolean =>
  urlPath === prefix || urlPath.startsWith(`${prefix}/`);

const header = (request: FastifyRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim();
};

// `x-homelab-actor: <type>:<name>`, from a script or agent naming itself.
const actorFromHeader = (request: FastifyRequest): UsageActor | null => {
  const value = header(request, "x-homelab-actor");
  if (!value) return null;
  const separator = value.indexOf(":");
  const actorType = value.slice(0, separator);
  const actorName = value.slice(separator + 1);
  if (separator === -1 || !ACTOR_TYPES.has(actorType) || !ACTOR_NAME.test(actorName)) return null;
  return { actorType: actorType as UsageActorType, actorName };
};

const fromResolver = (
  request: FastifyRequest,
  resolve: UsageActorResolver | undefined,
): (UsageActor & { surface?: UsageSurface }) | null => {
  if (!resolve) return null;
  try {
    const actor = resolve(request);
    if (!actor || !ACTOR_TYPES.has(actor.actorType) || !actor.actorName) return null;
    return actor;
  } catch {
    return null;
  }
};

// Who is behind a request, first match wins: the jwt strategy's verified
// user, `x-homelab-actor`, the app's resolver, the PWA (`x-homelab-client:
// pwa`, or `?client=pwa` where allowed), else an unnamed API caller.
export const resolveUsageActor = (
  request: FastifyRequest,
  resolve?: UsageActorResolver,
  allowClientQuery = false,
): UsageActor & { surface: UsageSurface } => {
  const query = request.query as Record<string, unknown> | undefined;
  const isPwa =
    header(request, "x-homelab-client") === "pwa" || (allowClientQuery && query?.client === "pwa");
  const named = actorFromHeader(request);
  const resolved = fromResolver(request, resolve);
  let surface: UsageSurface = resolved?.surface ?? "api";
  if (named) surface = "cli";
  if (isPwa || resolved?.surface === "pwa") surface = "pwa";

  // Not decorated at all under tailnet-trust, hence the optional chain.
  if (request.user?.id) return { actorType: "human", actorName: request.user.id, surface };
  if (named) return { ...named, surface };
  if (resolved) return { actorType: resolved.actorType, actorName: resolved.actorName, surface };
  if (isPwa) return { actorType: "human", actorName: "operator", surface };
  return { actorType: "system", actorName: "api", surface };
};

const shortString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_NAME_LENGTH
    ? value
    : undefined;

// A browser event as the relay passes it on: only the contract's fields,
// a route without its query string, and a valid timestamp.
const clientEvent = (
  input: unknown,
  now: string,
): Omit<UsageEvent, keyof UsageActor | "surface"> | null => {
  if (typeof input !== "object" || input === null) return null;
  const raw = input as Record<string, unknown>;
  if (typeof raw.kind !== "string" || !CLIENT_KINDS.has(raw.kind)) return null;
  const route = shortString(
    typeof raw.route === "string" ? raw.route.split(/[?#]/, 1)[0] : undefined,
  );
  if (!route) return null;
  const ts = typeof raw.ts === "string" ? new Date(raw.ts) : null;
  const event: Omit<UsageEvent, keyof UsageActor | "surface"> = {
    ts: ts && !Number.isNaN(ts.getTime()) ? ts.toISOString() : now,
    kind: raw.kind as UsageEvent["kind"],
    route,
  };
  const module = shortString(raw.module);
  const feature = shortString(raw.feature);
  if (module) event.module = module;
  if (feature) event.feature = feature;
  if (typeof raw.value === "number" && Number.isFinite(raw.value)) event.value = raw.value;
  return event;
};

// The raw body, whatever its content type: sendBeacon sends JSON as
// text/plain or with no type at all.
const clientEvents = (body: unknown): unknown[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(body));
  } catch {
    return [];
  }
  const events = (parsed as { events?: unknown } | null)?.events;
  return Array.isArray(events) ? events.slice(0, USAGE_MAX_BATCH) : [];
};

// createApp's `usage` option. Registered before the app's routes, so the
// onRoute hook sees every one of them for the inventory.
export const registerUsage = async (
  app: FastifyInstance,
  options: UsageOptions,
  scope: UsageScope,
): Promise<UsageSender> => {
  const sender = createUsageSender({
    app: options.app,
    endpoint: options.endpoint,
    flushIntervalMs: options.flushIntervalMs,
    maxBuffer: options.maxBuffer,
    logger: app.log,
    fetch: options.fetch,
  });
  const ignore = [...scope.ignore, USAGE_RELAY_ROUTE];
  const tracked = (url: string | undefined, method: string): url is string =>
    url !== undefined &&
    !UNTRACKED_METHODS.has(method) &&
    !ignore.some((prefix) => isUnder(url, prefix)) &&
    (scope.apiPrefix === undefined || isUnder(url, scope.apiPrefix));

  const routes = new Set<string>();
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (tracked(route.url, method)) routes.add(`${method} ${route.url}`);
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    try {
      const route = request.routeOptions.url;
      if (!tracked(route, request.method)) return;
      sender.record({
        ts: new Date().toISOString(),
        kind: "request",
        route,
        method: request.method,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
        ...resolveUsageActor(request, options.resolveActor),
      });
    } catch {
      // Usage tracking never fails a request.
    }
  });

  // The browser tracker's batches. Always 204: a bad batch or a down ingest
  // is the tracker's loss, not something to retry. In its own context so it
  // can take any content type as a string without affecting the app's
  // parsers.
  // eslint-disable-next-line @typescript-eslint/require-await -- fastify plugins are async
  await app.register(async (relay) => {
    // An oversized or unreadable body is the tracker's loss too.
    relay.setErrorHandler((_error, _request, reply) => reply.code(204).send());
    relay.removeAllContentTypeParsers();
    relay.addContentTypeParser("*", { parseAs: "string" }, (_request, body, done) => {
      done(null, body);
    });
    relay.post(USAGE_RELAY_ROUTE, { schema: { hide: true } }, async (request, reply) => {
      try {
        const actor = resolveUsageActor(request, options.resolveActor, true);
        const now = new Date().toISOString();
        for (const input of clientEvents(request.body)) {
          const event = clientEvent(input, now);
          if (event) sender.record({ ...event, ...actor });
        }
      } catch {
        // see onResponse
      }
      return reply.code(204).send();
    });
  });

  // Not awaited: the app must not wait on the ingest to start.
  app.addHook("onReady", (done) => {
    const items: UsageInventoryItem[] = [...routes].map((key) => ({ kind: "api", key }));
    const seen = new Set(items.map((item) => `${item.kind} ${item.key}`));
    for (const item of options.inventory ?? []) {
      if (!seen.has(`${item.kind} ${item.key}`)) items.push(item);
      seen.add(`${item.kind} ${item.key}`);
    }
    void sender.sendInventory(items);
    done();
  });

  app.addHook("onClose", async () => {
    await sender.close();
  });

  return sender;
};
