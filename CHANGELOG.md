# Changelog

All notable changes to `@rackmarten/server-kit` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is 0.x, a minor bump may contain breaking changes.

## [Unreleased]

## [0.10.0] - 2026-10-06

The first public release.

### Added

- `EightBallClient` cancels a request it gives up on (running past
  `pollTimeoutMs`, queued past the new `queuedTimeoutMs`, or a failed poll)
  with `DELETE /v1/requests/:id` before retrying, so a retry no longer leaves
  the old request to run too.
- `InferenceRequestBody` takes litellm sampling fields `temperature`,
  `maxTokens` and `think` (text/vision only).

- Fastify 5 building blocks: `createApp` (cors, helmet, `/health`, body
  limit, trusted proxies), auth strategies (`tailnet-trust`, and `jwt`
  verifying Ed25519 identity tokens locally, with `GET /api/me`, read-only
  view-as and token forwarding via `homelabFetch`), an OpenAPI 3.1 document
  with TypeBox-typed routes, an SPA fallback for web-history PWAs, a per-row
  ownership and sharing convention for Postgres and SQLite, a retrying
  inference gateway client (`EightBallClient`: batches, blobs, model
  pinning), `createDb` for Drizzle + postgres-js, a notifications table and
  routes, an ntfy client, keyword search helpers and ffmpeg video frame
  extraction.

### Changed

- `EightBallClient`'s `pollTimeoutMs` only counts time the request is
  `running`. A request waiting in a busy queue keeps being polled on the same
  id instead of being resubmitted, up to `queuedTimeoutMs` (default 30
  minutes).
- Internal refactor to the @rackmarten/eslint-config rules; no API change.
- Renamed to the `@rackmarten` scope and published to the public npm
  registry under the MIT license.
- Tests moved out of `src/` into `test/`, mirroring the `src/` tree, and the
  test script finds them by glob, so a new test folder can't be skipped.
- The package builds and tests on its own, with its own lockfile and a
  `tsconfig.json` that doesn't extend anything outside the package.
- ESLint (`@rackmarten/eslint-config`) and Prettier, with `lint`,
  `lint:fix` and `format` scripts; the source was reformatted by Prettier
  and `eslint --fix`, with no change in behavior.

[Unreleased]: https://github.com/rackmarten/server-kit/commits/main
[0.10.0]: https://github.com/rackmarten/server-kit/releases/tag/v0.10.0
