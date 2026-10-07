import { test } from "node:test";
import assert from "node:assert/strict";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { customType, pgTable, serial, text } from "drizzle-orm/pg-core";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  buildKeywords,
  keywordQuery,
  keywordSearch,
  keywordsVector,
  normalizeWords,
} from "../../src/keywords/index.js";

test("normalizeWords lowercases, strips diacritics, splits on - _ and punctuation, dedupes", () => {
  assert.deepEqual(normalizeWords("Žluťoučký kůň-úpěl  ÓDY_ódy, kůň!"), [
    "zlutoucky",
    "kun",
    "upel",
    "ody",
  ]);
  assert.deepEqual(normalizeWords("server-kit 0.7.0"), ["server", "kit", "0", "7"]);
  assert.deepEqual(normalizeWords("  \n "), []);
});

test("buildKeywords joins the configured fields and skips missing ones", () => {
  const task = {
    id: 1,
    title: "Pridať vyhľadávanie",
    description: null as string | null,
    status: "done",
  };
  assert.equal(buildKeywords(task, ["title", "description"]), "pridat vyhladavanie");
  assert.equal(
    buildKeywords({ ...task, description: "Vyhľadávanie v úlohách" }, ["title", "description"]),
    "pridat vyhladavanie v ulohach",
  );
});

test("keywordQuery prefix-matches every word in any order", () => {
  assert.equal(keywordQuery("Úlohy vyhľad"), "'ulohy':* & 'vyhlad':*");
  assert.equal(keywordQuery("it's"), "'it':* & 's':*");
  assert.equal(keywordQuery("'):* | !x"), "'x':*");
  assert.equal(keywordQuery(" - "), null);
});

test("keywordSearch binds the query as a parameter, undefined for an empty term", () => {
  const table = pgTable("t", { keyColumn: text("k") });
  const condition = keywordSearch(table.keyColumn, "a'b");
  assert.ok(condition);
  const compiled = new PgDialect().sqlToQuery(condition);
  assert.equal(compiled.sql, `"t"."k" @@ to_tsquery('simple', $1)`);
  assert.deepEqual(compiled.params, ["'a':* & 'b':*"]);
  assert.equal(keywordSearch(table.keyColumn, "  "), undefined);
});

// Needs a throwaway Postgres, see ownership.test.ts.
const dbUrl = process.env.TEST_DATABASE_URL;

test(
  "keywordSearch finds rows by diacritic-free, reordered prefixes",
  { skip: !dbUrl && "TEST_DATABASE_URL not set" },
  async () => {
    assert.ok(dbUrl);
    const client = postgres(dbUrl, { onnotice: () => {} });
    // eslint-disable-next-line id-denylist -- `data` is drizzle's customType option name
    const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
    const things = pgTable("keyword_things", {
      id: serial("id").primaryKey(),
      title: text("title").notNull(),
      keywords: tsvector("keywords"),
    });
    try {
      await client`drop table if exists keyword_things`;
      await client`create table keyword_things (id serial primary key, title text not null, keywords tsvector)`;
      await client`create index on keyword_things using gin (keywords)`;
      const db = drizzle(client);
      for (const title of [
        "Pridať vyhľadávanie projektov",
        "Oprava prihlásenia",
        "server-kit keyword search",
      ]) {
        // eslint-disable-next-line unicorn/no-unused-array-method-return -- drizzle's insert().values(), not Array#values
        await db.insert(things).values({ title, keywords: keywordsVector({ title }, ["title"]) });
      }
      const find = async (term: string) => {
        const rows = await db
          .select({ title: things.title })
          .from(things)
          .where(keywordSearch(things.keywords, term))
          .orderBy(things.id);
        return rows.map((row) => row.title);
      };
      assert.deepEqual(await find("projekt vyhladav"), ["Pridať vyhľadávanie projektov"]);
      assert.deepEqual(await find("PRIHLAS"), ["Oprava prihlásenia"]);
      assert.deepEqual(await find("kit server"), ["server-kit keyword search"]);
      assert.deepEqual(await find("server nope"), []);
      assert.deepEqual(await find("x' | 'y"), []);
    } finally {
      await client`drop table if exists keyword_things`;
      await client.end();
    }
  },
);
