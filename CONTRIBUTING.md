# Contributing

Thanks for taking the time to help. Bug reports and feature ideas go in
[GitHub issues](https://github.com/rackmarten/server-kit/issues); pull
requests are welcome too. Keep them small and focused, and for anything
larger than a small fix, open an issue first so we can agree on the
approach. This kit follows what the maintainer's own apps need, so a feature
nobody uses yet may be declined even if it's a good idea.

## Running the checks

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run lint       # lint:fix and format apply the automatic fixes
```

Linting uses `@rackmarten/eslint-config` (ESLint and Prettier); CI runs it
but doesn't fail on it yet, while the remaining violations are fixed.
CI runs the same, plus a gitleaks secret scan, on every push and pull request
(`.github/workflows/ci.yml`). Some tests need Postgres and are skipped
unless `TEST_DATABASE_URL` is set.

Tests live in `test/`, at the path mirroring the source file they cover
(`src/auth/jwt.ts` -> `test/auth/jwt.test.ts`), with shared test-only
helpers in `test/helpers/`. They use `node:test` and `node:assert`.

Add tests, and update `README.md` and the `[Unreleased]` section of
`CHANGELOG.md`, along with any change in behavior. Don't bump the package
version in a PR; that happens when a release is cut.

## Commits

Keep commits focused, and start the subject with one of these prefixes:

| Prefix    | Use for                                     |
| --------- | ------------------------------------------- |
| `Add:`    | new functionality                           |
| `Edit:`   | changes to existing functionality           |
| `Fix:`    | bug fixes                                   |
| `Update:` | dependency or configuration updates         |
| `Remove:` | removing functionality                      |
| `Docs:`   | documentation-only changes                  |
| `DevOps:` | CI, packaging and other operational changes |

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
