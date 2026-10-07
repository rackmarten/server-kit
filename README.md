# @rackmarten/server-kit

[![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/rackmarten)

Fastify 5 + TypeScript building blocks for the backend of a small
self-hosted web app that ships its own PWA: auth, an inference gateway
client, a Postgres connection, OpenAPI, notifications, an SPA fallback and
more. Its frontend counterpart is
[`@rackmarten/ui-kit`](https://www.npmjs.com/package/@rackmarten/ui-kit).

> **Heads-up:** this kit exists to serve the maintainer's own self-hosted
> apps, and new features land when one of those apps needs them. It is
> published in case it is useful to you too, but the API may change between
> 0.x minor versions. Pin a version range and read `CHANGELOG.md` before
> bumping.

```bash
npm i @rackmarten/server-kit
```

No `.npmrc` or token is needed; it is public on the npm registry.

## Usage

Fastify 5 + TypeScript. `createApp(options)` wires up the cross-cutting
concerns (cors, helmet, an auth strategy, an optional inference gateway
client, a `/health` route, the OpenAPI document, the SPA fallback) and then
registers the app's own routes via `options.registerServices`.

```ts
import { createApp, createDb } from "@rackmarten/server-kit";
import * as schema from "./schema.js";

const { db, sql } = createDb(process.env.DATABASE_URL!, schema);

const app = await createApp({
  auth: { strategy: "tailnet-trust" },
  healthCheck: async () => {
    await sql`select 1`;
  },
  spa: { root: new URL("../pwa/dist", import.meta.url).pathname },
  registerServices: async (app) => {
    app.get("/api/things", async () => db.select().from(schema.things));
  },
});

await app.listen({ port: 3000, host: "0.0.0.0" });
```

What it exports:

- **`createApp`, `DEFAULT_TRUSTED_PROXIES`**: the app factory. Options:
  `auth`, `eightball`, `cors`, `helmet`, `logger`, `trustProxy`, `bodyLimit`,
  `healthCheck`, `openapi`, `spa`, `registerServices`.
- **Auth** (`createAuthStrategy`, `createJwtStrategy`, `registerJwtAuth`,
  `verifyToken`, `parsePublicKeys`, `tokenFromHeaders`):
  - `tailnet-trust` re-checks that the request's source IP is on the tailnet
    (`100.64.0.0/10` by default, `cidr` to change it). It is a
    defense-in-depth backstop behind a reverse proxy that already restricts
    access, not a login. Only `trustProxy` addresses may set
    `X-Forwarded-For`; anyone else gets their socket address as `request.ip`,
    so a forged header cannot claim a tailnet IP. `DEFAULT_TRUSTED_PROXIES`
    is loopback plus the maintainer's proxy address, so pass your own
    `trustProxy` list.
  - `jwt` trusts an identity token instead: an auth gate in front of the app
    injects a short-lived Ed25519 JWT as `X-Homelab-Token` (or
    `Authorization: Bearer` for app-to-app calls), and server-kit verifies it
    locally against the public keys in `HOMELAB_TOKEN_KEYS`
    (`<kid>:<base64url x>` entries, space or comma separated; the app refuses
    to start without them). Every route gets `request.user`
    (`{ id, name, roles, groups, services, actor? }`) or a 401. Opt a route
    out with `{ config: { public: true } }`; `/health` is always public.
    While `actor` is set (an admin viewing as someone else), anything but
    GET/HEAD/OPTIONS is a 403. `GET /api/me` returns `request.user`
    (`meRoute` renames or disables it).
  - `real` (sessions/passkeys) is not implemented yet.
- **`homelabFetch(request, url, init)`, `forwardTokenHeaders`**: forward the
  caller's token to another app, so it sees the same person. Tokens live 5
  minutes, so forward while serving the request, not from a later job.
- **OpenAPI and typed routes** (`registerOpenApi`, re-exported TypeBox
  `Type`/`Static`/`TypeBoxTypeProvider`): every app serves its OpenAPI 3.1
  document at `/api/openapi.json`. Name it with `openapi: { title, version }`
  or turn it off with `openapi: false`. A route with a TypeBox schema gets a
  typed handler, validated input and a typed entry in the document:

  ```ts
  import { Type, type TypeBoxTypeProvider } from "@rackmarten/server-kit";

  registerServices: async (app) => {
    const r = app.withTypeProvider<TypeBoxTypeProvider>();
    r.get(
      "/api/things/:id",
      { schema: { params: Type.Object({ id: Type.Integer() }) } },
      async (request) => getThing(request.params.id), // id: number
    );
  },
  ```

- **Ownership** (`ownershipColumns`, `visibleTo`, `canSee`, `canUse`,
  `isOwner`, `isAdmin`, `principal`, plus `SQLITE_OWNERSHIP_COLUMNS`,
  `sqliteVisibleTo`, `ownedFromSqliteRow` for SQLite): a convention for rows
  owned by a person (`owner_id`, `visibility` `private`/`shared`,
  `shared_with` of `person:<id>`/`group:<id>` principals). Admins see and use
  everything; otherwise the owner, plus every listed person and group member
  while the row is `shared`. A view-as request can see but never use.
- **`EightBallClient`**: a client for an inference gateway that queues
  requests (submit, then poll to completion), with a configurable retry
  (`retries`/`retryDelayMs`, default 2 retries 5s apart) around the whole
  submit-and-poll flow, so a paused queue or a briefly unhealthy backend
  doesn't become a permanent failure. `pollTimeoutMs` (default 90s) limits
  time spent `running`; a `queued` request keeps being polled on the same id
  up to `queuedTimeoutMs` (default 30 minutes). A request the client gives up
  on is cancelled with `DELETE /v1/requests/:id` before any retry, so it never
  runs twice. Text/vision requests also take `temperature`, `maxTokens` and
  `think`. `uploadBlob(bytes, mime)` uploads an
  image once and returns an id to reference as `blob:<id>`.
  `infer({ capability, items, model })` sends a batch and returns one
  `{ ok, output?, error? }` per item; `infer({ capability: "vision", image,
prompt })` returns `{ content, model }`. Always pin `model` when outputs
  are compared across calls (embeddings), since different models' vectors
  are not comparable. `forCaller(request)` forwards the caller's identity.
- **`createDb(url, schema)`**: opens a `drizzle-orm/postgres-js` client and
  returns `{ db, sql }`, the Drizzle instance and the raw `postgres` client on
  one connection. Each app still owns its schema and migrations.
- **Notifications** (`notifications` table, `createNotifications`,
  `registerNotificationRoutes`): the backend half of ui-kit's
  `NotificationBell`. Re-export `notifications` from your Drizzle schema so
  drizzle-kit migrates it, then
  `registerNotificationRoutes(app, createNotifications(db, { onNotify }))`.
  Routes under `/api/notifications`: `GET ?limit&beforeId&unread`,
  `GET /unread-count`, `POST /:id/read`, `POST /read-all`.
  `store.notify({ kind, title, body?, url?, dedupKey? })` records one; a
  repeat with an unresolved `dedupKey` is a no-op until `store.resolve(key)`.
- **`createNtfyClient({ url, token, logger })`**: publishes to an
  [ntfy](https://ntfy.sh) server with
  `notify({ topic, message, title?, clickUrl?, priority?, tags? })`. Uses
  ntfy's JSON publish, so non-ASCII titles work. It never rejects: a failure
  is logged via `logger.warn` and resolves `false`. An empty `url` is a
  silent no-op (local dev).
- **Keyword search** (`buildKeywords`, `keywordsVector`, `keywordSearch`,
  `normalizeWords`, `keywordQuery`): store normalized keywords (lowercased,
  diacritics stripped) in a `tsvector` column with a GIN index;
  `keywordSearch(table.keywords, term)` is a WHERE condition where every word
  of the term must prefix-match some keyword. Normalizing happens in JS
  because Postgres `unaccent` can't be used in a generated column.
- **Video frames** (`evenlySpacedTimestamps`, `extractFrames`): sample JPEG
  frames from a video with `ffmpeg` (must be on `PATH`), optionally scored
  for sharpness.
- **SPA** (`registerSpa`, or `spa: { root }` on `createApp`): pages at
  `/<route>` (vue-router web history), JSON under `/api`. Real files are
  served as themselves, any other `GET`/`HEAD` outside `/api` gets
  `index.html`, and `/api/...`, other methods and missing files with an
  extension get a JSON 404. `legacyApiAliases: true` rewrites non-page
  requests to old root paths onto `/api/...` while clients migrate.
- **Body size**: Fastify's default 1MiB body limit applies unless you pass
  `bodyLimit` (bytes), e.g. for a route that receives base64 images.

## Helmet and Content-Security-Policy

`helmet: true` (the default) registers `@fastify/helmet` with its defaults,
including a locked-down CSP (`'self'` for nearly everything). The browser
silently refuses anything else, and the server sees nothing: no error status,
nothing in the logs, a clean health check. The directives most likely to
bite:

| Directive               | What it blocks                                                              |
| ----------------------- | --------------------------------------------------------------------------- |
| `script-src`            | Any inline `<script>` or `onclick=` handler: the page renders but is inert. |
| `img-src` / `media-src` | Images and video from another origin.                                       |
| `connect-src`           | `fetch`/XHR/WebSocket to another origin.                                    |

Fix it by serving the content same-origin first (move inline scripts into a
`.js` file, or proxy the resource through your API). Only if the content
really is cross-origin, pass helmet options to loosen just that directive:
`helmet: { contentSecurityPolicy: { directives: { imgSrc: ["'self'", "https://example.com"] } } }`.
Health checks cannot catch this; give a new UI one browser pass with
DevTools open.

## Development

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run lint       # lint:fix and format apply the automatic fixes
```

Tests live in `test/`, mirroring `src/` (`src/auth/jwt.ts` ->
`test/auth/jwt.test.ts`); shared test-only helpers go in `test/helpers/`.
They run on `node:test` with `node:assert`, compiled to `dist-test/`, so
`dist/` never contains them. Tests that need Postgres are skipped unless
`TEST_DATABASE_URL` is set.

## Support this project

If server-kit saves you time, you can support its development on
[Ko-fi](https://ko-fi.com/rackmarten):

[![Support on Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/rackmarten)

Bug reports, ideas and pull requests
are just as welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

See `CONTRIBUTING.md` for how to contribute and `CHANGELOG.md` for what
changed in each release. Licensed under the [MIT License](LICENSE).
