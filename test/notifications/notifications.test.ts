import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  clampLimit,
  createNotifications,
  registerNotificationRoutes,
  type ListNotificationsOptions,
  type NotificationRow,
  type NotificationStore,
} from "../../src/notifications/index.js";

test("clampLimit defaults junk and caps large values", () => {
  // eslint-disable-next-line unicorn/no-useless-undefined -- the parameter is required; this passes an explicit undefined
  assert.equal(clampLimit(undefined), 50);
  assert.equal(clampLimit("abc"), 50);
  assert.equal(clampLimit("0"), 50);
  assert.equal(clampLimit("7.9"), 7);
  assert.equal(clampLimit(5000), 200);
});

const fakeStore = () => {
  const calls: { list: ListNotificationsOptions[]; read: number[]; readAll: number } = {
    list: [],
    read: [],
    readAll: 0,
  };
  const row: NotificationRow = {
    id: 3,
    kind: "failure",
    title: "gateway unreachable",
    body: null,
    url: null,
    dedupKey: "8ball-down",
    resolvedAt: null,
    readAt: null,
    createdAt: new Date("2026-09-25T10:00:00Z"),
  };
  const store: NotificationStore = {
    notify: () => Promise.resolve(row),
    resolve: () => Promise.resolve(0),
    list: (options) => {
      calls.list.push(options ?? {});
      return Promise.resolve([row]);
    },
    unreadCount: () => Promise.resolve(4),
    markRead: (id) => {
      calls.read.push(id);
      return Promise.resolve();
    },
    markAllRead: () => {
      calls.readAll++;
      return Promise.resolve();
    },
  };
  return { store, calls };
};

test("routes speak the shape ui-kit's NotificationSource expects", async () => {
  const { store, calls } = fakeStore();
  const app = Fastify();
  registerNotificationRoutes(app, store);

  const list = await app.inject({ url: "/api/notifications?limit=5&beforeId=10&unread=true" });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(calls.list[0], { limit: 5, beforeId: 10, unread: true });
  assert.equal(list.json<{ createdAt: string }[]>()[0].createdAt, "2026-09-25T10:00:00.000Z");

  await app.inject({ url: "/api/notifications?beforeId=-1" });
  assert.deepEqual(calls.list[1], { limit: 50, beforeId: undefined, unread: false });

  const unread = await app.inject({ url: "/api/notifications/unread-count" });
  assert.deepEqual(unread.json(), { unread: 4 });

  const markRead = await app.inject({ method: "POST", url: "/api/notifications/3/read" });
  assert.equal(markRead.statusCode, 204);
  assert.deepEqual(calls.read, [3]);
  const invalidRead = await app.inject({ method: "POST", url: "/api/notifications/x/read" });
  assert.equal(invalidRead.statusCode, 400);

  const markAll = await app.inject({ method: "POST", url: "/api/notifications/read-all" });
  assert.equal(markAll.statusCode, 204);
  assert.equal(calls.readAll, 1);
});

test("routes honour a custom prefix", async () => {
  const { store } = fakeStore();
  const app = Fastify();
  registerNotificationRoutes(app, store, { prefix: "/api/bell" });
  const custom = await app.inject({ url: "/api/bell/unread-count" });
  assert.equal(custom.statusCode, 200);
  const standard = await app.inject({ url: "/api/notifications/unread-count" });
  assert.equal(standard.statusCode, 404);
});

// Dedup lives in SQL (a partial unique index), so it needs a real Postgres:
//   docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=pg --name kit-pg postgres:16
//   TEST_DATABASE_URL=postgres://postgres:pg@localhost:55432/postgres npm test
const dbUrl = process.env.TEST_DATABASE_URL;

test(
  "Postgres store: dedup, resolve, read state, paging",
  { skip: !dbUrl && "TEST_DATABASE_URL not set" },
  async () => {
    assert.ok(dbUrl);
    const sql = postgres(dbUrl, { onnotice: () => {} });
    try {
      await sql`drop table if exists notifications`;
      // Mirrors schema.ts; a consumer gets this from drizzle-kit instead.
      await sql`create table notifications (
      id serial primary key, kind text not null, title text not null, body text, url text,
      dedup_key text, resolved_at timestamptz, read_at timestamptz,
      notifiedat timestamptz not null default now())`;
      await sql`create unique index notifications_open_dedup_key_idx on notifications (dedup_key) where resolved_at is null`;

      const created: string[] = [];
      const store = createNotifications(drizzle(sql), {
        onNotify: (notified) => {
          created.push(notified.title);
        },
      });

      assert.ok(await store.notify({ kind: "failure", title: "down", dedupKey: "8ball" }));
      assert.equal(
        await store.notify({ kind: "failure", title: "down again", dedupKey: "8ball" }),
        null,
      );
      assert.ok(await store.notify({ kind: "completed", title: "scan done" }));
      assert.ok(
        await store.notify({ kind: "completed", title: "scan done" }),
        "no key never dedups",
      );
      assert.deepEqual(created, ["down", "scan done", "scan done"]);

      assert.equal(await store.resolve("8ball"), 1);
      assert.equal(await store.resolve("8ball"), 0);
      assert.ok(
        await store.notify({ kind: "failure", title: "down later", dedupKey: "8ball" }),
        "notifies again after resolve",
      );

      assert.equal(await store.unreadCount(), 4);
      const all = await store.list();
      assert.deepEqual(
        all.map((item) => item.title),
        ["down later", "scan done", "scan done", "down"],
      );
      await store.markRead(all[0].id);
      assert.equal(await store.unreadCount(), 3);
      const unreadRows = await store.list({ unread: true });
      assert.equal(unreadRows.length, 3);
      const page = await store.list({ beforeId: all[1].id, limit: 1 });
      assert.deepEqual(
        page.map((item) => item.id),
        [all[2].id],
      );
      await store.markAllRead();
      assert.equal(await store.unreadCount(), 0);
    } finally {
      await sql`drop table if exists notifications`;
      await sql.end();
    }
  },
);
