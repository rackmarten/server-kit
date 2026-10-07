import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import type { HomelabUser } from "../../src/auth/types.js";
import {
  canSee,
  canUse,
  ownedFromSqliteRow,
  ownershipColumns,
  principal,
  sqliteVisibleTo,
  SQLITE_OWNERSHIP_COLUMNS,
  visibleTo,
  type Owned,
} from "../../src/ownership/index.js";

const user = (id: string, extra: Partial<HomelabUser> = {}): HomelabUser => ({
  id,
  name: id,
  roles: [],
  groups: [],
  services: [],
  ...extra,
});

const owner = user("owner");
const friend = user("friend");
const member = user("member", { groups: ["family"] });
const admin = user("admin", { roles: ["admin"] });
const outsider = user("outsider", { groups: ["other"] });
const viewAs = user("owner", { actor: { id: "admin", name: "admin" } });

const privateThing: Owned = {
  ownerId: "owner",
  visibility: "private",
  sharedWith: [principal.person("friend")],
};
const sharedThing: Owned = {
  ownerId: "owner",
  visibility: "shared",
  sharedWith: [principal.person("friend"), principal.group("family")],
};

test("canSee / canUse matrix", () => {
  const cases: [string, HomelabUser | null, Owned, boolean, boolean][] = [
    ["owner, private", owner, privateThing, true, true],
    ["shared person, private (list ignored)", friend, privateThing, false, false],
    ["admin, private", admin, privateThing, true, true],
    ["stranger, private", outsider, privateThing, false, false],
    ["owner, shared", owner, sharedThing, true, true],
    ["shared person", friend, sharedThing, true, true],
    ["shared group member", member, sharedThing, true, true],
    ["admin, shared", admin, sharedThing, true, true],
    ["stranger, shared", outsider, sharedThing, false, false],
    ["no user", null, sharedThing, false, false],
    ["view-as the owner reads, never uses", viewAs, privateThing, true, false],
  ];
  for (const [label, who, resource, isSeen, isUsed] of cases) {
    assert.equal(canSee(who, resource), isSeen, `canSee: ${label}`);
    assert.equal(canUse(who, resource), isUsed, `canUse: ${label}`);
  }
});

// Three rows: owner's private, owner's shared with friend + family, and
// outsider's private. Expected visible ids per user.
const expected: [HomelabUser | null, number[]][] = [
  [owner, [1, 2]],
  [friend, [2]],
  [member, [2]],
  [outsider, [3]],
  [admin, [1, 2, 3]],
  [null, []],
];

test("sqliteVisibleTo matches canSee", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE things (id INTEGER PRIMARY KEY, ${SQLITE_OWNERSHIP_COLUMNS})`);
  const insert = db.prepare(
    "INSERT INTO things (id, owner_id, visibility, shared_with) VALUES (?, ?, ?, ?)",
  );
  insert.run(1, "owner", "private", JSON.stringify(["person:friend"]));
  insert.run(2, "owner", "shared", JSON.stringify(["person:friend", "group:family"]));
  insert.run(3, "outsider", "private", "[]");

  for (const [who, ids] of expected) {
    const where = sqliteVisibleTo(who, "t");
    const rows = db
      .prepare(`SELECT t.id FROM things t WHERE ${where.sql} ORDER BY t.id`)
      .all(...where.params) as { id: number }[];
    assert.deepEqual(
      rows.map((row) => row.id),
      ids,
      `sqlite: ${who?.id ?? "nobody"}`,
    );
  }

  const row = db
    .prepare("SELECT owner_id, visibility, shared_with FROM things WHERE id = 2")
    .get() as never;
  assert.equal(canSee(member, ownedFromSqliteRow(row)), true);
  assert.deepEqual(
    ownedFromSqliteRow({ owner_id: "o", visibility: "shared", shared_with: "nope" }).sharedWith,
    [],
  );
});

// Needs a throwaway Postgres, e.g.
//   docker run -d --rm --name kit-pg -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:16
//   TEST_DATABASE_URL=postgres://postgres:pg@localhost:55432/postgres npm test
const dbUrl = process.env.TEST_DATABASE_URL;

test(
  "visibleTo (Drizzle) matches canSee",
  { skip: !dbUrl && "TEST_DATABASE_URL not set" },
  async () => {
    assert.ok(dbUrl);
    const sql = postgres(dbUrl, { onnotice: () => {} });
    try {
      await sql`drop table if exists ownership_things`;
      await sql`create table ownership_things (
      id serial primary key, label text, owner_id text not null,
      visibility text not null default 'private', shared_with text[] not null default '{}'::text[])`;
      const things = pgTable("ownership_things", {
        id: serial("id").primaryKey(),
        label: text("label"),
        ...ownershipColumns(),
      });
      const db = drizzle(sql);
      await db
        .insert(things)
        // eslint-disable-next-line unicorn/no-unused-array-method-return -- drizzle's insert().values(), not Array#values
        .values([
          { ownerId: "owner", visibility: "private", sharedWith: ["person:friend"] },
          { ownerId: "owner", visibility: "shared", sharedWith: ["person:friend", "group:family"] },
          { ownerId: "outsider" },
        ]);
      for (const [who, ids] of expected) {
        const rows = await db
          .select({ id: things.id })
          .from(things)
          .where(visibleTo(things, who))
          .orderBy(things.id);
        assert.deepEqual(
          rows.map((row) => row.id),
          ids,
          `postgres: ${who?.id ?? "nobody"}`,
        );
      }
    } finally {
      await sql`drop table if exists ownership_things`;
      await sql.end();
    }
  },
);
