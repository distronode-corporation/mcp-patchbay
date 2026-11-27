# Contributing

Thank you for helping. Some ground rules keep the patchbay small and trustworthy.

New here? Issues labelled [good first issue](https://github.com/distronode-corporation/mcp-patchbay/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22) are small, well scoped and need no access beyond this repository.

## Principles

- **No generic call or exec tool, ever.** The patchbay's own tool surface is `servers`, `enable`,
  `disable`, `restart` and `info`, plus `enable_confirm` with `confirmVia: "host"`.
- **Fail closed.** Anything about consent (`confirm`, elicitation) must refuse when in doubt.
- **The naming contract is public.** Changes to how tool names are formed (see the README) are
  breaking changes.
- **Runtime dependencies are pinned exactly.** Today they are `@modelcontextprotocol/sdk`, its
  `zod` peer, and `mcp-remote`. Adding one needs a very good reason, written down in
  `DECISIONS.md`.
- **Plain JavaScript with JSDoc types, ESM, no build step.**
- **stdout is for MCP only.** Log to stderr, through `src/log.js`, which redacts.

## Setup

```sh
npm ci
npm run lint
npm test
npm run test:coverage   # what CI runs on Linux: the suite with its coverage floors
python3 -m unittest discover -s examples/write-gate -v
```

The tests use `node:test` and spawn real processes: the patchbay itself, a fake MCP server in
`test/fixtures/fake-server.js`, and the real mcp-remote against a local HTTP server. They take
about 40 seconds.

## Style

Code follows oxlint's `correctness` rules (oxlint's own rules and its ports of the ESLint and
unicorn rules, for code that is outright wrong), configured in `.oxlintrc.json`, plus the
principles above. Formatting follows `.editorconfig`. CI runs `npm run lint` (warnings fail it
too) in every test job, and a pull request that fails it does not merge. A rule is never switched
off for one line to make a change pass; fix the code, or argue for changing the config in the
pull request.

## Tests

- A pull request that adds or changes functionality adds tests for it to the automated suite, and
  a bug fix adds a test that fails without the fix.
- On Linux, CI runs `npm run test:coverage`, which fails below the floors in `package.json`
  (lines 94%, branches 82%, functions 86% of `src/`). The floors only go up: never lower one or
  exclude a file to get a change through.
- The tests run with `--throw-deprecation`, so a call to a deprecated Node.js API fails them.
- Tests that rely on POSIX process groups or signals are skipped on Windows, with a reason.
- A flaky test is a bug. Fix the cause. Do not add retries or loosen assertions.

## Changes

- Update `SPEC.md` when behaviour changes, and `CHANGELOG.md` for anything user-visible.
- Use only synthetic examples: `example-files`, `https://mcp.example.com/mcp`, `/path/to/...`.
  Never include real hosts, account ids, tokens or names.
- Security issues go through private vulnerability reporting (see `SECURITY.md`), not public
  issues.

## Commits and pull requests

There is no Developer Certificate of Origin sign-off requirement. By opening a pull
request you agree that your contribution is licensed under the Apache License, Version
2.0, as section 5 of that licence describes.

Documentation moves with the code: a pull request that changes behaviour changes the README,
`SPEC.md` or `SECURITY-MODEL.md` that describes it in the same pull request. A known mismatch
between the docs and the code is a bug; open an issue for it.

The project's roles, and how a change is accepted, are in the organization's
[GOVERNANCE.md](https://github.com/distronode-corporation/.github/blob/main/GOVERNANCE.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
