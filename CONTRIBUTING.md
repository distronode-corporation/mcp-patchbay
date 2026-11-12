# Contributing

Thank you for helping. Some ground rules keep the patchbay small and trustworthy.

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
npm test
python3 -m unittest discover -s examples/write-gate -v
```

The tests use `node:test` and spawn real processes: the patchbay itself, a fake MCP server in
`test/fixtures/fake-server.js`, and the real mcp-remote against a local HTTP server. They take
about 40 seconds.

- Tests that rely on POSIX process groups or signals are skipped on Windows, with a reason.
- A flaky test is a bug. Fix the cause. Do not add retries or loosen assertions.

## Changes

- Update `SPEC.md` when behaviour changes, and `CHANGELOG.md` for anything user-visible.
- Use only synthetic examples: `example-files`, `https://mcp.example.com/mcp`, `/path/to/...`.
  Never include real hosts, account ids, tokens or names.
- Security issues go through private vulnerability reporting (see `SECURITY.md`), not public
  issues.

By contributing, you agree that your contributions are licensed under the Apache License 2.0.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
