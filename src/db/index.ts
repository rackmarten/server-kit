import postgres, { type Sql } from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";

// Points at sandbox's shared Postgres instance in production (one database
// per project inside it - see sandbox's README, "Shared Postgres
// instance") or a project's own dedicated Postgres for local dev. Either
// way the caller just supplies its own DATABASE_URL and schema module;
// this only standardizes how the connection itself is opened.
//
// Returns both the Drizzle instance and the raw `postgres` client on one
// connection - a service that also runs raw tagged-template SQL alongside
// Drizzle (e.g. for aggregate queries Drizzle's query
// builder doesn't cover well) needs both without opening a second pool.
export const createDb = <TSchema extends Record<string, unknown>>(
  url: string,
  schema: TSchema,
): { db: PostgresJsDatabase<TSchema>; sql: Sql } => {
  const sql = postgres(url);
  const db = drizzle(sql, { schema });
  return { db, sql };
};
