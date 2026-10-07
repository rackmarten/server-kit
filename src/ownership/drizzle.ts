import { and, arrayOverlaps, eq, or, sql, type SQL } from "drizzle-orm";
import { text, type PgColumn } from "drizzle-orm/pg-core";
import type { HomelabUser } from "../auth/types.js";
import { isAdmin, principalsOf, type Visibility } from "./rules.js";

// The convention's columns, to spread into an app's own pgTable:
//   pgTable("albums", { id: serial("id").primaryKey(), ...ownershipColumns(), ... })
// A fresh object per call, since Drizzle columns belong to one table.
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- the inferred Drizzle column-builder type is the contract; spelling it out would be unwieldy and could drift
export const ownershipColumns = () => ({
  ownerId: text("owner_id").notNull(),
  visibility: text("visibility").$type<Visibility>().notNull().default("private"),
  sharedWith: text("shared_with")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
});

// WHERE clause limiting a list query to rows `user` may see (canSee's rules
// in SQL). undefined for an admin, which and()/where() treat as no filter.
export const visibleTo = (
  table: { ownerId: PgColumn; visibility: PgColumn; sharedWith: PgColumn },
  user: HomelabUser | null | undefined,
): SQL | undefined => {
  if (!user) return sql`false`;
  if (isAdmin(user)) return undefined;
  return or(
    eq(table.ownerId, user.id),
    and(eq(table.visibility, "shared"), arrayOverlaps(table.sharedWith, principalsOf(user))),
  );
};
