import { and, count, desc, eq, isNull, lt, type SQL } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { FastifyInstance } from "fastify";
import { notifications, type NotificationRow } from "./schema.js";

export { notifications } from "./schema.js";
export type { NotificationRow } from "./schema.js";

export interface NotificationInput {
  kind: string;
  title: string;
  body?: string | null;
  url?: string | null;
  // See the schema: one open notification per key until resolve(key).
  dedupKey?: string | null;
}

export interface ListNotificationsOptions {
  limit?: number;
  beforeId?: number;
  unread?: boolean;
}

// What the routes need; createNotifications is the Postgres implementation.
export interface NotificationStore {
  notify(input: NotificationInput): Promise<NotificationRow | null>;
  resolve(dedupKey: string): Promise<number>;
  list(options?: ListNotificationsOptions): Promise<NotificationRow[]>;
  unreadCount(): Promise<number>;
  markRead(id: number): Promise<void>;
  markAllRead(): Promise<void>;
}

export interface NotificationsOptions {
  // Called for every notification actually created (not for deduplicated
  // repeats), e.g. to forward it to ntfy. Errors are the caller's to handle.
  onNotify?: (row: NotificationRow) => void | Promise<void>;
}

export const DEFAULT_NOTIFICATION_LIMIT = 50;
export const MAX_NOTIFICATION_LIMIT = 200;

export const clampLimit = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_NOTIFICATION_LIMIT;
  return Math.min(Math.floor(parsed), MAX_NOTIFICATION_LIMIT);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any driver, schema and relations must stay assignable (public signature)
type AnyPgDatabase = PgDatabase<any, any, any>;

export const createNotifications = (
  db: AnyPgDatabase,
  options: NotificationsOptions = {},
): NotificationStore => ({
  async notify(input) {
    // The partial unique index on open dedup keys makes a repeat a no-op,
    // race-free even when two workers notify at once.
    const [row] = await db
      .insert(notifications)
      .values({
        kind: input.kind,
        title: input.title,
        body: input.body ?? null,
        url: input.url ?? null,
        dedupKey: input.dedupKey ?? null,
      })
      .onConflictDoNothing()
      .returning();
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- row is undefined when the insert hit the dedup conflict; the array element type does not say so
    if (row && options.onNotify) await options.onNotify(row);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see above: row can be undefined at runtime
    return row ?? null;
  },

  async resolve(dedupKey) {
    const rows = await db
      .update(notifications)
      .set({ resolvedAt: new Date() })
      .where(and(eq(notifications.dedupKey, dedupKey), isNull(notifications.resolvedAt)))
      .returning({ id: notifications.id });
    return rows.length;
  },

  async list(opts = {}) {
    const where: SQL[] = [];
    if (opts.unread) where.push(isNull(notifications.readAt));
    if (opts.beforeId) where.push(lt(notifications.id, opts.beforeId));
    return db
      .select()
      .from(notifications)
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(notifications.id))
      .limit(clampLimit(opts.limit));
  },

  async unreadCount() {
    const [row] = await db
      .select({ total: count() })
      .from(notifications)
      .where(isNull(notifications.readAt));
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition, @typescript-eslint/no-unnecessary-type-conversion -- no row at runtime is possible per the driver, and Number() keeps a string count working
    return Number(row?.total ?? 0);
  },

  async markRead(id) {
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.id, id), isNull(notifications.readAt)));
  },

  async markAllRead() {
    await db.update(notifications).set({ readAt: new Date() }).where(isNull(notifications.readAt));
  },
});

export interface NotificationRoutesOptions {
  prefix?: string;
}

// The HTTP side of ui-kit's NotificationSource (and createHttpNotificationSource
// there): GET <prefix>?limit&beforeId&unread, GET <prefix>/unread-count,
// POST <prefix>/:id/read, POST <prefix>/read-all.
export const registerNotificationRoutes = (
  app: FastifyInstance,
  store: NotificationStore,
  options: NotificationRoutesOptions = {},
): void => {
  const prefix = options.prefix ?? "/api/notifications";

  app.get(prefix, async (req) => {
    const query = req.query as Record<string, string | undefined>;
    const beforeId = Number(query.beforeId);
    return store.list({
      limit: clampLimit(query.limit),
      beforeId: Number.isInteger(beforeId) && beforeId > 0 ? beforeId : undefined,
      unread: query.unread === "true",
    });
  });

  app.get(`${prefix}/unread-count`, async () => ({ unread: await store.unreadCount() }));

  app.post(`${prefix}/:id/read`, async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id) || id < 1) return reply.code(400).send({ error: "invalid id" });
    await store.markRead(id);
    return reply.code(204).send();
  });

  app.post(`${prefix}/read-all`, async (_req, reply) => {
    await store.markAllRead();
    return reply.code(204).send();
  });
};
