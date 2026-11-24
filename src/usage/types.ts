// The usage ingest contract, shared by createApp's `usage` option, the
// browser tracker that posts to its relay route, and the ingest service
// itself. Privacy: routes are patterns (`/tasks/:id`), modules and features
// are names. No ids, no free text, no query strings.

export type UsageActorType = "human" | "agent" | "foreman" | "system";

// How the caller reached the app: the PWA in a browser, a script or agent
// naming itself, or an unnamed API call.
export type UsageSurface = "pwa" | "cli" | "api";

export type UsageEventKind = "request" | "view" | "active" | "click";

export interface UsageActor {
  actorType: UsageActorType;
  actorName: string;
}

export interface UsageEvent extends UsageActor {
  // ISO 8601 timestamp.
  ts: string;
  kind: UsageEventKind;
  // A route pattern: the matched API route for `request`, the page route
  // for browser events. Never a raw URL.
  route: string;
  // `request` only.
  method?: string;
  status?: number;
  durationMs?: number;
  module?: string;
  feature?: string;
  // `active`: seconds (1-60) active in that minute.
  value?: number;
  surface: UsageSurface;
}

// POST <ingest>/v1/events, at most USAGE_MAX_BATCH events. Answers 202;
// invalid events are dropped, not the whole batch.
export interface UsageEventBatch {
  app: string;
  events: UsageEvent[];
}

export type UsageInventoryKind = "api" | "view" | "feature";

// `api` keys are `<METHOD> <route pattern>` (`GET /api/tasks/:id`), so they
// match a `request` event's method and route.
export interface UsageInventoryItem {
  kind: UsageInventoryKind;
  key: string;
}

// POST <ingest>/v1/inventory. Replaces the app's inventory: what "never
// used" is computed against.
export interface UsageInventory {
  app: string;
  items: UsageInventoryItem[];
}

// What the browser posts to the app's relay route. The app stamps its name,
// actor and surface; a client-supplied actor is ignored.
export type ClientUsageEvent = Pick<UsageEvent, "ts" | "route" | "module" | "feature" | "value"> & {
  kind: "view" | "active" | "click";
};

export interface ClientUsageBatch {
  events: ClientUsageEvent[];
}

export const USAGE_MAX_BATCH = 1000;
export const USAGE_RELAY_ROUTE = "/api/usage/events";
