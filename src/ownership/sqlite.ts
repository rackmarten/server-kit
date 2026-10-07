import type { HomelabUser } from "../auth/types.js";
import { isAdmin, principalsOf, type Owned } from "./rules.js";

// Plain-SQL variant of the ownership convention for SQLite apps,
// which have no array type: shared_with holds a JSON array of principals.

// Paste into CREATE TABLE.
export const SQLITE_OWNERSHIP_COLUMNS =
  "owner_id TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'private', shared_with TEXT NOT NULL DEFAULT '[]'";

export interface SqliteWhere {
  sql: string;
  params: string[];
}

// WHERE fragment and its parameters limiting a query to rows `user` may see.
// Pass `table` (a name or alias) when the query joins other tables.
export const sqliteVisibleTo = (
  user: HomelabUser | null | undefined,
  table?: string,
): SqliteWhere => {
  if (!user) return { sql: "0 = 1", params: [] };
  if (isAdmin(user)) return { sql: "1 = 1", params: [] };
  const col = (name: string) => (table ? `${table}.${name}` : name);
  const principals = principalsOf(user);
  return {
    sql:
      `(${col("owner_id")} = ? OR (${col("visibility")} = 'shared' AND EXISTS ` +
      `(SELECT 1 FROM json_each(${col("shared_with")}) WHERE json_each.value IN (${principals.map(() => "?").join(", ")}))))`,
    params: [user.id, ...principals],
  };
};

export interface SqliteOwnedRow {
  owner_id: string;
  visibility: string;
  shared_with: string | null;
}

// A row's ownership columns in the shape canSee/canUse take.
export const ownedFromSqliteRow = (row: SqliteOwnedRow): Owned => {
  let sharedWith: string[] = [];
  try {
    const parsed = JSON.parse(row.shared_with ?? "[]") as unknown;
    if (Array.isArray(parsed))
      sharedWith = parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    // Unparseable share list: treat as shared with nobody.
  }
  return { ownerId: row.owner_id, visibility: row.visibility, sharedWith };
};
