# Decisions

This file records the decisions made while building v0.1.0 without anyone to ask. Each entry
says what was decided and why. Entries marked **(deviation)** differ from the original build
brief.

## Dependencies

- **`@modelcontextprotocol/sdk` 1.32.2, `zod` 4.6.7 and `mcp-remote` 0.15.2, pinned exactly.**
  - The SDK declares the peer range `zod: "^3.25 || ^4.0"`. 4.6.7 was the registry's `latest` on
    the build date, so that is the pin.
- **No devDependencies.** Tests use `node:test`. YAML in the workflows was checked with the
  system Python, which is not a project dependency.

## Repository bootstrap

- **(deviation)** The brief said that LICENSE, NOTICE and a placeholder README were already
  there. The working directory was in fact empty.
  - LICENSE was copied from the system's canonical Apache-2.0 text
    (`/usr/share/common-licenses/Apache-2.0`, sha256 `cfc7749b…3d30`, which is the apache.org
    text).
  - NOTICE was written with the standard form: product name and `Copyright 2026 Distronode
    Corporation`.
  - The maintainer should replace NOTICE if the organisation has its own wording.

## What reading the sources changed

### mcp-remote 0.15.2 (`node_modules/mcp-remote/dist/chunk-UZ6Y4QJH.js`)

- **The URL is on the line after the auth marker.**
  - `redirectToAuthorization()` logs
    `` `\nPlease authorize this client by visiting:\n${url}\n` ``.
  - `log()` writes `[<pid>] …` to stderr through `console.error`.
  - So the URL is on the line *after* the marker. The detector accepts a URL on the marker line,
    or on any of the next three non-empty lines.
- **The flags match the brief.** `--auth-timeout <seconds>` (a positive integer, or a warning and
  the 30 s default) and `--header Name:Value` both exist.
  - Header names must match `^[A-Za-z0-9_-]+$` (`parseHeaderLine`). The config validator enforces
    the same rule, so a header is never silently dropped.
- **`MCP_REMOTE_CONFIG_DIR`** is the base directory. mcp-remote stores its files under
  `<dir>/mcp-remote-v1/`.
- **Plain HTTP** is allowed only for `localhost` and `127.0.0.1` (or with `--allow-http`). The
  validator mirrors this.
- **mcp-remote starts its stdio server only after the remote connection, which includes
  sign-in.** So the child's `initialize` simply stays pending, and the patchbay's start timeout
  for `url` servers is `authTimeoutSeconds + 60 s`.
- **(deviation) Header values are passed by environment reference, not literally.**
  - mcp-remote expands `${VAR}` in header values from its own environment (`substituteEnvVars`,
    applied to every header).
  - The patchbay therefore passes `--header Name:${MCP_PATCHBAY_HEADER_<n>}` and puts the value
    in the child's env. argv is world-readable through `ps` and `/proc/<pid>/cmdline`; env is not.
  - Values that already contain `${` are passed literally, because the expansion is
    single-level.
  - The brief's "each header as `--header K:V`" is kept in form, but the secret is not on the
    command line.
- **The bin is resolved without npx.** `require.resolve('mcp-remote/package.json')` and
  `bin['mcp-remote']` (`dist/proxy.js`). mcp-remote has no `exports` map, so this resolution is
  allowed.

### SDK 1.32.2

- **`Server.setRequestHandler` re-validates every `tools/call` result with `CallToolResultSchema`.**
  That schema is loose at the top level, so the brief's raw `client.request(...)` approach is kept,
  and "unchanged" means what any SDK client would see.
- **`ToolSchema` and the annotation schema strip unknown keys.**
  - The child's `tools/list` is therefore requested with a loose schema.
  - Each tool is checked separately with `ToolSchema.safeParse`, and the **original** object is
    republished. So unknown annotation hints and other fields pass through, and one malformed
    tool cannot break the client's whole list.
- **`Client.setRequestHandler` refuses to register handlers for capabilities the client did not
  declare.**
  - Sampling is therefore refused through `fallbackRequestHandler`, with a clear message.
  - The same handler gives clear messages for `roots/list` and `elicitation/create` when the
    patchbay's own client did not declare them.
- **"No cap" is the largest delay `setTimeout` accepts.** `Protocol.request` uses a plain
  `setTimeout`. A larger value overflows to 1 ms, so "no cap" is 2147483647 ms (about 24.8 days).
- **Progress handlers receive params without the token.** The SDK replaces the token toward the
  child with its own message id. The patchbay re-attaches the client's original token when
  forwarding.
- **The patchbay wraps `initialize` around the SDK's `_oninitialize`.**
  - Children's capabilities (roots, elicitation) must mirror the client's, which are only known
    at initialize time. Autostarted servers' instructions must also be in the initialize result.
  - The wrapper lets the SDK record the capabilities, then autostarts (waiting up to 15 s), then
    attaches the instructions.
  - It relies on a private method of a pinned SDK version. A test covers it.
- **`McpServer` turns errors thrown in a tool into `isError` results.** The fake server
  therefore raises its protocol-level error from a wrapped `tools/call` handler.

## Interpretations of the brief

- **(deviation) Server names use `[A-Za-z0-9_-]{1,64}`, not `[A-Za-z0-9-]`.** The brief's extra
  rules ("no `__`, no trailing `_`") only make sense if `_` is allowed, and Claude Code server
  names often contain `_`. Those two rules are exactly what makes "split on the first `__`"
  unambiguous.
- **Config owner check.** Beyond the brief's writable check, a config owned by anyone other than
  you or root is also refused (POSIX). That file would not be "your own config".
- **(review fix) Config symlinks are allowed only if the target passes the same checks.** People
  often keep dotfiles in a repository and symlink them into `~/.config`, so refusing symlinks
  outright would break a common setup for little gain. The file is opened once, following the
  link, and its mode and owner are checked on the descriptor (`fstat`), which is the target.
  Both the directory holding the link and the directory holding the resolved target must be
  owned by you or root and must not be group- or world-writable. So nobody else can re-point
  the link or replace the target. Only the immediate parent directories are checked, not every
  ancestor.
- **(review fix) Sticky world-writable directories (`/tmp`) are refused too.** The sticky bit
  stops others from replacing a file you own, but not from creating the path first, or a
  symlink, before you do. A config has no reason to live there.
- **Redaction scope.** The patchbay redacts everything *it* produces about children: logs,
  errors, `servers`/`info`/`enable` output, doctor output, and child error messages it relays.
  - Tool results, tool lists and child instructions are pass-through content and are **not**
    redacted. The brief's "child args and env never appear in … tool results" is read as
    "the patchbay never puts them there".
  - Scrubbing a server's own results would break it. For example, a filesystem server's root
    directory is one of its args.
- **The sign-in URL is the one deliberate exception.** It goes unredacted to the person, inside
  the elicitation, because sign-in cannot work otherwise. **(review fix)** The patchbay's own log
  line no longer includes it, not even redacted. mcp-remote's stderr lines that contain it stay
  in the redacted stderr ring buffer.
- **Child elicitations are prefixed `[<server>] `.** This attributes them, and stops a child from
  passing its request off as the patchbay's own confirmation. It is a small, deliberate change to
  pass-through.
- **Tools that require tasks are skipped.** Tools with `execution.taskSupport: "required"` cannot
  be called without task support, which v1 does not have. They are reported in `skippedTools`.
- **Name collisions after sanitizing** (`a.b` and `a_b`): the first one listed wins, and the rest
  are skipped and reported. Segments (names and prefixes) must be unique, ignoring case, so two
  servers can never collide.
- **Sign-in decline.** A declined or cancelled sign-in elicitation aborts the start, and the
  server becomes `failed`.
  - When the client lacks elicitation entirely, the patchbay logs that a sign-in is needed.
    mcp-remote opens a browser itself.
  - **(review fix)** The detector runs only for mcp-remote children: `url` entries, commands
    whose basename is `mcp-remote`, and package runners (`npx` and similar) with an
    `mcp-remote[@version]` argument. That keeps the `npx mcp-remote` stdio case working. It acts
    only while the slot is starting, and the prompt is always labelled `[<server>] `. Before
    this, any child could make the patchbay show its own unattributed "Sign in" prompt, with any
    link, at any time.
- **`import` details.**
  - `autostart.default` is `[]`, because the brief only defines the per-project list.
  - Entries that point at mcp-patchbay itself are skipped, to avoid recursion.
  - Each entry is validated on its own, so one odd server is reported rather than failing the
    import.
  - Descriptions are generated (`Imported from Claude Code (<type>)`), because Claude configs
    have none.
- **`rename-permissions`.** Additions are appended to each list, in the order of their source
  rules. Rules already present are not duplicated, and the file's indentation and mode are kept.
  `--config` names the config that maps server names to their `prefix`. **(review fix)** Without
  the flag, the default config (`resolveConfigPath()`) is used. A missing file is a warning, not
  an error, because the tool is still useful when no server has a prefix.
- **`doctor`.** It allows 60 s per stdio server (auth timeout + 60 s for `url`), and prints the
  first stderr line as "the first error". It exits 1 if any server failed and 78 on config errors.
- **`write-gate` "once per session".** It asks until a matching call has actually *run*, which
  PostToolUse reports, rather than only on the first attempt. Otherwise a person who declined
  once would never be asked again.
  - The patchbay's own tools (`mcp__patchbay__enable`, …) are recognised and not treated as
    unparseable.
- **Logging capability.** Not declared, because child `notifications/message` are not forwarded
  in v1. `MCP_PATCHBAY_DEBUG=1` copies (redacted) child stderr into the patchbay's stderr.
- **`MCP_PATCHBAY_MCP_REMOTE_BIN`** replaces the mcp-remote script. It exists so the suite can test
  the remote flow with a fake. Anyone who can set the patchbay's environment can already choose
  what it runs (`PATH`, `NODE_OPTIONS`), so it adds no new capability.
- **Shutdown** also triggers on SIGHUP (POSIX), SIGBREAK (Windows) and EPIPE on stdout. After a
  shutdown nobody can talk to the patchbay anyway.
- **The exit-time group kill.** When a child exits, the patchbay immediately sends SIGTERM to its
  process group, to clean up grandchildren. Later closes do not signal that group again.
  - **(review fix)** There is one follow-up: SIGKILL to the same group 500 ms later, for members
    that ignore SIGTERM. The leader has exited by then, so the id stays reserved by the kernel
    while any member is left. A new group with that id needs a new process with that pid as its
    leader, so the follow-up is skipped when a process with that pid exists.
- **(review fix) Shutdown escalation.** Shutdown must stay synchronous and fast, so the SIGKILL
  follow-up runs in a detached `node -e` helper, which the patchbay does not wait for. A
  child's pidfile is kept until its exit is observed, so if the helper fails, the next start's
  reaper sends SIGTERM and, 1 s later, SIGKILL.

## Things deliberately not done

- No generic call or exec tool.
- No resources, prompts, completions or logging forwarding.
- No automatic restarts.
- No hot reload of the config.
- No `${VAR}` expansion of `command`, `args` or `env`, unlike Claude Code's own config. It is
  documented as an import caveat.

## Flakiness

- The suite was run three times in a row, and once more as two suites in parallel to add CPU
  contention. All runs passed (79/79 each).
- One latent race was found and fixed by design before it ever failed: the original test
  assertion "the client finished re-listing before `enable` returned".
  - The patchbay can only guarantee that the client's `tools/list` request arrived, and that its
    response was written before `enable`'s. In what order the client finishes the two is
    microtask scheduling on the client side.
  - The patchbay resolves its waiter in `setImmediate`, after the `tools/list` response is
    written. The test asserts that the re-list was *requested* before `enable` returned. The
    "waits about 2 s when the client never re-lists" test bounds it from the other side.

## Review log (step 3)

The diff was read end to end, focusing on security, correctness and the accuracy of the docs.

1. **Confirm path.** Every path to a spawn of a `confirm` server goes through `#confirm`,
   except two:
   - joining a start already in progress (which was itself confirmed, or autostarted);
   - restarting a server that is `on`.

   `restart` of an off server calls `enable`. Only `accept` with `allow === true` proceeds, and
   an exception means "no". Without form elicitation the answer is no. `deny` is checked first in
   `enable` and `restart`, and rejected in `autostart` at load time. Concurrent confirmations
   share one promise. **No issue.**
2. **Env.** Spawn env is `{...process.env, ...entry.env}`, built per child, and nothing is shared
   between entries. A test confirms isolation. **No issue.**
3. **Redaction.**
   - Every log line passes through `redact()`.
   - `lastError`, `stderrTail`, `stdoutNoise` and relayed child errors use the child's own secret
     list.
   - Spawn errors are reduced to their `code`, so the command path and args are not echoed.
   - A test checks that tokens, URL queries, env and arg secrets are absent from `servers`,
     `info`, `enable` and stderr.
   - The error for an unknown tool name, and the unknown-server message, redact the
     agent-supplied name and cap its length. Verified; nothing to fix.
4. **Process groups.**
   - **Fixed:** `close()` and `killNow()` could signal a group id again after its leader had
     exited. They no longer do; the group is signalled once, at exit time.
   - Shutdown is synchronous. The SIGTERM and SIGINT tests check pid liveness (zombie-aware) for
     children and grandchildren within 500 ms.
5. **Missing `cwd`.** **Fixed:** spawn reported it as ENOENT, which read like "command not
   found". It is now checked before spawning and has its own message and test.
6. **Doc accuracy.**
   - **Fixed:** the README's comparison table claimed licenses for third-party projects that
     could not be verified offline. Those cells are now "—".
   - **Fixed:** a response-time promise was removed from SECURITY-MODEL.md, because the
     maintainers have not made it.
   - **Fixed:** a repo link in CHANGELOG.md was removed. The brief allows the organisation name
     only in NOTICE, package.json and README links.
   - **Fixed:** `homepage` and `bugs` were removed from package.json, for the same reason.
   - The SPEC was updated for the loopback hosts, SIGBREAK, and the `cwd` check.
   - The quick start was checked live with `@modelcontextprotocol/server-filesystem@2.2.0` through
     npx: confirm prompt, 16 tools, and a file read through the proxy.
7. **Packaging.**
   - `npm pack --dry-run` lists only `src/`, the docs, LICENSE, NOTICE and `examples/servers.json`.
   - Installing the tarball into an empty directory gives a working `mcp-patchbay` bin, and
     mcp-remote resolves inside the installed tree.
