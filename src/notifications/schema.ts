import { sql } from "drizzle-orm";
import { index, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

// An app's notification history, the data behind ui-kit's NotificationBell.
// Re-export it from the app's own Drizzle schema module
// so drizzle-kit generates the table in that app's migrations:
//   export { notifications } from "@rackmarten/server-kit";
export const notifications = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    // App-defined category (e.g. "failure", "completed"); the PWA maps it to
    // an icon and colour.
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    // PWA route to open on tap, e.g. /posts/12.
    url: text("url"),
    // A condition that stays true for a while ("gateway unreachable") notifies
    // once: while a row with this key is unresolved, notify() with the same
    // key is a no-op. resolve(key) closes it so the next occurrence notifies.
    dedupKey: text("dedup_key"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("notifications_created_at_idx").on(table.createdAt),
    uniqueIndex("notifications_open_dedup_key_idx")
      .on(table.dedupKey)
      .where(sql`${table.resolvedAt} is null`),
  ],
);

export type NotificationRow = typeof notifications.$inferSelect;
