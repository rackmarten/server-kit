export { createApp, DEFAULT_TRUSTED_PROXIES } from "./core.js";
export type { CoreOptions } from "./core.js";

export { defineDto, registerOpenApi } from "./openapi.js";
export type { OpenApiOptions } from "./openapi.js";
// TypeBox, so a route's schema types its handler without the app adding
// its own dependencies: app.withTypeProvider<TypeBoxTypeProvider>().
export {
  Type,
  type Static,
  type TSchema,
  type TypeBoxTypeProvider,
  type FastifyPluginAsyncTypebox,
} from "@fastify/type-provider-typebox";

export { registerSpa } from "./spa.js";
export type { SpaOptions, CreateAppSpaOptions } from "./spa.js";

export {
  createAuthStrategy,
  createJwtStrategy,
  registerJwtAuth,
  parsePublicKeys,
  tokenFromHeaders,
  verifyToken,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
} from "./auth/index.js";
export type {
  AuthConfig,
  AuthStrategy,
  HomelabUser,
  JwtOptions,
  JwtStrategy,
  TailnetTrustOptions,
  TokenClaims,
} from "./auth/index.js";

export { forwardTokenHeaders, homelabFetch } from "./forward.js";

export {
  canSee,
  canUse,
  isAdmin,
  isOwner,
  principal,
  principalsOf,
  ownershipColumns,
  visibleTo,
  SQLITE_OWNERSHIP_COLUMNS,
  ownedFromSqliteRow,
  sqliteVisibleTo,
} from "./ownership/index.js";
export type { Owned, SqliteOwnedRow, SqliteWhere, Visibility } from "./ownership/index.js";

export { EightBallClient } from "./eightball/client.js";
export type {
  EightBallClientOptions,
  EightBallItem,
  EightBallItemResult,
  BatchInferenceResult,
  InferenceRequestBody,
  InferenceResult,
  Priority,
  Privacy,
} from "./eightball/client.js";

export { createNtfyClient } from "./ntfy/index.js";
export type {
  NtfyClient,
  NtfyClientOptions,
  NtfyLogger,
  NtfyMessage,
  NtfyPriority,
} from "./ntfy/index.js";

export { createDb } from "./db/index.js";

export { evenlySpacedTimestamps, extractFrames } from "./video/frames.js";
export type { ExtractFramesOptions, ExtractedFrame } from "./video/frames.js";

export {
  clampLimit,
  createNotifications,
  notifications,
  registerNotificationRoutes,
  DEFAULT_NOTIFICATION_LIMIT,
  MAX_NOTIFICATION_LIMIT,
} from "./notifications/index.js";
export type {
  ListNotificationsOptions,
  NotificationInput,
  NotificationRoutesOptions,
  NotificationRow,
  NotificationsOptions,
  NotificationStore,
} from "./notifications/index.js";

export {
  buildKeywords,
  keywordQuery,
  keywordSearch,
  keywordsVector,
  normalizeWords,
} from "./keywords/index.js";
