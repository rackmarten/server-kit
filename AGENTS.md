# Agent Instructions

> **This repository is public.** Everything committed here, including commit
> messages, PR titles and descriptions, is world-readable. Read
> "Public repository, private homelab" at the end of this file before
> committing.

## Project

`server-kit` is a library, not a deployed service. Fastify 5 + TypeScript
backend building blocks (auth strategies, inference gateway client, db
connection, health route, notifications, ...), published to npm as
`@rackmarten/server-kit` and consumed by the maintainer's self-hosted apps.
Its frontend counterpart is `@rackmarten/ui-kit`, in its own repository.

See `README.md` for what it provides.

## General rules

- It exists to be installed by the maintainer's apps, not to grow
  speculative features nobody needs yet: add to it when a real consuming
  app needs the capability, not preemptively.
- Keep it unopinionated about each app's own data model: it only
  standardizes how a Postgres connection is opened, not the schema.
- Tests use `node:test` with `node:assert`. They live in `test/`, mirroring
  `src/` (`src/auth/jwt.ts` -> `test/auth/jwt.test.ts`), helpers in
  `test/helpers/`. `tsconfig.test.json` compiles `src/` and `test/` into
  `dist-test/` and `npm test` runs every `dist-test/test/**/*.test.js`, so
  `dist/` never holds a test.
- Public API names (`createApp`, `EightBallClient`, `HomelabUser`, ...) are
  stable identifiers; renaming one is a breaking change.
- Do not commit secrets, credentials, tokens, or private keys.
- Prefer small, focused changes; run `npm run build`, `npm run typecheck`
  and `npm test` before considering a change complete, and add the change
  to the `[Unreleased]` section of `CHANGELOG.md`.

## Releases

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
with semver headings. To release: bump `version` in `package.json`, rename
`[Unreleased]` to `[<version>] - <YYYY-MM-DD>` (add a fresh empty
`[Unreleased]` above it and update the link references at the bottom), merge,
then push the tag `v<version>`. `.github/workflows/publish.yml` refuses a tag
that doesn't match `package.json`, publishes to npm with provenance through npm trusted publishing
(OIDC from this workflow, no token secret), and creates a GitHub release whose notes are
that version's `CHANGELOG.md` section.

## Public repository, private homelab

This repository is published under the MIT license. The maintainer's homelab
uses it, but homelab-specific state does not live here. Keep it that way:

- No private inventory: hostnames, domains, internal service names, task
  numbers or email addresses. Examples and test fixtures use invented values
  (`example.com`, `app`, `demo`). RFC1918 addresses such as `192.168.0.x` are
  fine.
- Comments keep the technical reason, not the private history behind it
  ("an inference gateway", "a consuming app", not a named service or task).
- No links to private repositories in docs. CI is self-contained
  (`.github/workflows/ci.yml`, GitHub-hosted runner), because a public repo
  cannot call a reusable workflow in a private one.

Why some defaults look the way they do:

- **`DEFAULT_TRUSTED_PROXIES`** is loopback plus the address the
  maintainer's reverse proxy connects from. Anyone else passes `trustProxy`.
- **The `jwt` strategy's token issuer** (`TOKEN_ISSUER`) matches the
  maintainer's auth gate; the token format is documented in `README.md`.

Before pushing, the leak check in CI (`.github/scripts/leak-check.sh`, run
with `--tree --log`) must pass. Its patterns are private and reach CI as the
org's `LEAK_PATTERNS` secret; a hit prints only an opaque id and a location.
`.leak-allow` lists intentional exceptions (`<path-glob>:<id>`), for
functional configuration only. Rephrase a hit rather than allowlisting it.
The script is a vendored copy: change it upstream, not here.
