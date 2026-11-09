# mcp-patchbay v0.1.0 — specification

This is the protocol and lifecycle contract that the code and tests implement. Where it differs
from the original build brief, the difference is marked **[resolved]** and explained. The reasons
are recorded in more detail in `DECISIONS.md`.

Versions this was checked against (in `node_modules`): `@modelcontextprotocol/sdk` 1.32.2,
`zod` 4.6.7, `mcp-remote` 0.15.2.

## 1. Roles

```
MCP client (e.g. Claude Code)  ⇄ stdio ⇄  mcp-patchbay  ⇄ stdio ⇄  child MCP servers
        "the client"                      "the patchbay"            "children"
```

- The patchbay is an MCP **server** to the client. It uses the SDK's low-level `Server`, because
  its tool list changes at run time.
- The patchbay is an MCP **client** to each child. It uses one SDK `Client` per child, over a
  custom child-process transport (§7).
- The person is a human who answers elicitations in the client UI. The agent is the model that
  calls tools. The config file is trusted. The agent, the children, and everything the children
  return are not trusted.

## 2. Configuration

### 2.1 Location and load

1. `--config <path>`, else `$MCP_PATCHBAY_CONFIG`, else `~/.config/mcp-patchbay/servers.json`.
2. The file is read exactly once, at startup. Changes need a restart of the patchbay; in Claude
   Code that is `/mcp` → reconnect.
3. **Refusal (POSIX).** The patchbay stats the file, following symlinks, and refuses to start with
   exit code **78** (`EX_CONFIG`) and a one-paragraph stderr message in either case:
   - the mode has any group- or world-write bit (`mode & 0o022`);
   - **[resolved]** the owner is neither the current user nor root.

   The second check was added because a file another user can rewrite is not "the person's own
   config". On Windows both checks are skipped (README known limit).
4. Every other config error also exits with 78, and the message names the offending JSON path.
   That includes a missing file, invalid JSON, schema violations and unknown keys.

### 2.2 Schema (strict)

Unknown keys are rejected at every level, with `unknown key "<k>" at <path>`.

| Key | Type | Rule |
|---|---|---|
| `version` | `1` | required |
| `servers` | object | required; may be empty |
| `servers.<name>` | object | name matches `^[A-Za-z0-9_-]{1,64}$`, contains no `__`, does not end with `_` **[resolved]**, see below |
| `.description` | string | optional (default `""`), one line (no CR/LF), ≤ 300 chars |
| `.policy` | `"allow"｜"confirm"｜"deny"` | default `"confirm"` |
| `.command` | non-empty string | stdio server; exactly one of `command`/`url` |
| `.args` | string[] | stdio only |
| `.env` | `{[K]: string}` | K matches `^[A-Za-z_][A-Za-z0-9_]*$`; allowed for both kinds (for `url` it is passed to mcp-remote) |
| `.cwd` | absolute path string | stdio only |
| `.url` | string | `https:`, or `http:` only for the hosts `localhost` and `127.0.0.1` (this is mcp-remote 0.15.2's own rule) |
| `.headers` | `{[K]: string}` | url only; K matches `^[A-Za-z0-9_-]+$` (this is mcp-remote's `parseHeaderLine`); values contain no CR/LF |
| `.prefix` | string | same rules as a server name |
| `.timeoutMs` | integer `0..2147483647` | default 0 = no cap |
| `autostart.default` | string[] | known, non-`deny` names |
| `autostart.projects` | `{[absDir]: string[]}` | keys are absolute paths; values are known, non-`deny` names |
| `oauth.configDir` | string | default `~/.config/mcp-patchbay/oauth`; a leading `~` is expanded |
| `oauth.authTimeoutSeconds` | integer `1..86400` | default 300 |

The tool-name segment of a server is its `prefix ?? name`. It must be unique across servers,
compared case-insensitively, so two servers can never publish the same exposed name.

**[resolved] Name character set.** The brief gives `[A-Za-z0-9-]{1,64}` but also says "no `__`
and no trailing `_`". Those two rules only make sense if `_` is allowed, and Claude Code server
names often contain `_`. So the class is `[A-Za-z0-9_-]`. "No `__` and no trailing `_`" is what
makes the split unambiguous (§4).

### 2.3 Autostart

The patchbay picks the project directory from `CLAUDE_PROJECT_DIR`, or else `process.cwd()`, and
normalises it with `path.resolve` (compared case-insensitively on Windows). If
`autostart.projects` has that key, its list is used. Otherwise `autostart.default` is used.

Autostarted servers start with **no confirmation, whatever their policy** (except `deny`, which
is rejected at load time). Autostart is the person's own config choice, so it counts as consent.

## 3. The patchbay's own tools

There are exactly five. Each one has `_meta: {"anthropic/alwaysLoad": true}`. All results are
`content: [{type:"text", text: <JSON>}]`. Refusals and failures set `isError: true`. Protocol
errors are used only for malformed requests.

| Tool | Input | Behaviour |
|---|---|---|
| `servers` | `{}` | For every configured server: `name, description, policy, state, toolCount?` (when `on`), `lastError?` (redacted, when `failed`), `skippedTools?`, `canEnable`, `whyNot?`. |
| `enable` | `{name}` | See §3.1. |
| `disable` | `{name}` | Refuses with `"<name> has N call(s) in flight"` while calls are running. Otherwise closes the child, drops its tools and sends `list_changed`. Disabling a server that is `starting` or `waiting-for-sign-in` aborts the start. Disabling a `failed` server resets it to `off`. |
| `restart` | `{name}` | If `on`: disable (the in-flight rule applies), then start again with **no** new confirmation. If `off` or `failed`: exactly `enable`, including confirmation. If `starting`: refused. |
| `info` | `{name}` | `description, policy, state, toolCount, skippedTools, lastError, stderrTail` (redacted, last 5 lines), plus `instructions` in full when `on`. |

The `name` inputs are `{type:"string", enum:[configured names]}`, and `additionalProperties` is
false. There is no generic call or exec tool, and none will be added.

### 3.1 enable

1. If the name is unknown, the result is an error. If the policy is `deny`, the result is the
   error `"<name> is denied by policy"`.
2. If the server is already `on`, enable returns its summary and does nothing else. If it is
   `starting` or `waiting-for-sign-in`, enable joins the start that is already running.
3. Policy `confirm`:
   - If the client did not declare form-mode elicitation, enable refuses: `"<name> needs a
     person's approval, but this client cannot ask (no elicitation support). A person must add
     it to autostart in the patchbay config, or set policy: allow."` It fails closed.
   - Otherwise it sends `elicitation/create` with `mode:"form"`, the message `Allow the agent to
     turn on <name> (<description>)?` (the ` (<description>)` part is omitted when the
     description is empty), and
     `requestedSchema: {type:"object", properties:{allow:{type:"boolean", title:"Allow"}}, required:["allow"]}`.
   - It proceeds only when `action === "accept"` and `content.allow === true`. Anything else
     refuses: decline, cancel, a malformed answer, a timeout, or an error.
   - The elicitation has no timeout of its own; cancelling the `enable` call cancels it.
   - Several enable calls for the same server share one pending confirmation.
4. Policy `allow` proceeds without asking.
5. Start (§7): spawn, `initialize`, list all tools (following `nextCursor`), build the name map
   (§4), publish, and send `notifications/tools/list_changed`.
6. Wait for the client's next `tools/list`. This resolves early when the request arrives and gives
   up after 2000 ms. The waiter is armed before the notification is sent, so the request cannot be
   missed.
7. Return `{name, state:"on", toolCount, sampleTools: first ≤10 exposed names, skippedTools,
   instructions: child instructions truncated to 2000 chars (with "…[truncated]")}`.

### 3.2 Instructions (initialize result)

The client's `initialize` request is handled by a wrapper. It runs the SDK's own
`_oninitialize`, so the client capabilities get recorded. It then starts the autostart set in
parallel, waits up to **15 s** for it, and returns the result with `instructions` attached.
Autostart children that are still starting after 15 s keep starting in the background; when they
come up they publish their tools with `list_changed`.

The text has three parts:

1. A header of about four lines on how to use `servers`, `enable` and `disable`, and the naming
   contract.
2. A catalogue, one line per server: `- <name> [<state>, <policy>]: <description>`, with the
   description cut to 120 chars.
3. For each autostarted server that is `on` and has instructions:
   `\n## <name> instructions\n<text>`.

The total is ≤ **4096** characters. The catalogue takes what it needs. If it alone would exceed
3000 chars, it is cut and ends with `- … N more; call servers`. The remaining budget is shared
between autostarted servers by water-filling: each server gets `min(its length, an equal share
of what is left)`, and any unused share is redistributed. Cut text ends with `…[truncated]`.
Afterwards the total is asserted ≤ 4096 and hard-cut if needed.

## 4. Naming contract (public)

```
exposed   = <segment> "__" <sanitize(tool)>
segment   = prefix ?? name
sanitize  = replace every char outside [A-Za-z0-9_-] with "_"
client    = "mcp__patchbay__" + exposed          (if the patchbay is registered as "patchbay")
```

- A segment never contains `__` and never ends with `_`. So in an exposed name, the **first**
  `__` is always the separator, even when the tool name itself contains `__` or starts with `_`
  (for example `files___hidden` is segment `files` and tool `_hidden`).
- If `"mcp__patchbay__".length + exposed.length > 128`, the tool is skipped and reported in
  `skippedTools` with reason `name too long`. The segment is never shortened.
- Empty tool names are skipped as `empty name`.
- If two tools of one child sanitize to the same name, the first one listed wins and the others
  are skipped as `name collides with <original>`.
- A tool that fails the SDK's `ToolSchema` is skipped as `invalid tool definition`, so that one
  bad tool cannot break the client's whole `tools/list`.
- **[resolved]** A tool with `execution.taskSupport: "required"` is skipped, because the patchbay
  does not support tasks in v1.
- The reverse map `exposed → {server, original name}` is rebuilt on every publish.
- The tool object is published as the child sent it, apart from `name`: `title`, `description`,
  `inputSchema`, `outputSchema`, `annotations`, `icons`, `execution`, `_meta` and any unknown
  keys are kept. **[resolved]** To keep it that way, children's `tools/list` is requested with a
  loose result schema, and each tool is checked separately with `ToolSchema.safeParse`. The SDK's
  `listTools()` would strip unknown keys.

## 5. Proxying

### 5.1 tools/call

- The patchbay looks up the exposed name in the reverse map. If the server for that segment is
  not `on`, the result is `isError` with `"<server> is not enabled; call enable"`. Otherwise it
  is a protocol error (InvalidParams) `"Unknown tool"`.
- Forwarding uses `client.request({method:"tools/call", params:{...params, name: original}},
  CallToolResultSchema, opts)`, never `callTool`, so `outputSchema` is not enforced. A result
  that has an `outputSchema` but no `structuredContent` passes through as it is.
- "Unchanged" means the same as what any SDK client sees: the object comes out of
  `CallToolResultSchema`, and the SDK's server wrapper parses it again with the same schema.
- `opts.timeout` is `timeoutMs`, or 2147483647 when `timeoutMs` is 0. That is the largest delay
  `setTimeout` accepts, about 24.8 days, which in practice means no cap. `opts.signal` is the
  incoming request's `AbortSignal`.
- In-flight count per server: incremented before the forward, decremented in `finally`.
- **Errors**: a child JSON-RPC error is re-thrown with the same `code` and `data`, and with a
  redacted message. If the child exits mid-call, the error is `"<server> exited during the call"`.

### 5.2 Cancellation and progress

- When the client sends `notifications/cancelled`, the SDK aborts the handler signal. The SDK
  `Protocol.request` then sends `notifications/cancelled` to the child with the child-side
  request id.
- If the client's request carried `_meta.progressToken = T`, the patchbay passes `onprogress`.
  The SDK replaces the token toward the child with its own message id. Each child progress
  notification is re-sent to the client as `{progressToken: T, progress, total?, message?}`. So
  the client always sees its own original token.

### 5.3 Requests from children

| From child | Handling |
|---|---|
| `roots/list` | Registered only if the client declared `roots`. Waits until the client has sent `initialized` (≤ 30 s), then calls `server.listRoots()` and returns the client's answer. |
| `elicitation/create` | Registered only if the client declared `elicitation`. Forwarded to the client with **[resolved]** the message prefixed `[<server>] `, so the person can tell which server is asking and a child cannot pass its prompt off as the patchbay's own confirmation. The answer is returned as it is, with no timeout beyond cancellation. |
| `sampling/createMessage` | Refused through the child client's `fallbackRequestHandler`: `McpError(-32601, "mcp-patchbay does not forward sampling/createMessage; sampling is not available to hosted servers")`. |
| anything else | `-32601 Method not found`. |
| `notifications/tools/list_changed` | Re-list, rebuild the map, publish, and send our own `list_changed`. Re-lists are serialised and coalesced. |
| `notifications/elicitation/complete` | Forwarded to the client if the client declared URL elicitation. |
| `notifications/progress`, `notifications/cancelled` | Handled by the SDK as described in §5.2. |

From the client: `notifications/roots/list_changed` is forwarded to every child that is `on`.

### 5.4 Capabilities

- To the client: `{tools: {listChanged: true}}`. Logging is not implemented, so it is not
  declared.
- To children: `roots: {listChanged: true}` only if the client declared `roots`, and
  `elicitation: <the client's elicitation object>` only if the client declared it. Children
  therefore see exactly the modes (`form`, `url`) the client supports.
- v1 is tools only: no resources, prompts, completions or tasks.

## 6. Redaction

`redact(text, secrets?)` is applied to every string the patchbay itself produces about a child:
stderr ring-buffer lines, logs, `lastError`, `servers`/`info`/`enable` output, doctor output, and
error messages re-thrown from children. In order:

1. Exact secrets: the child entry's `env` values, `args`, and `headers` values with length ≥ 6.
   Each is replaced with `[redacted]`, longest first.
2. URL userinfo: `scheme://user:pass@` → `scheme://[redacted]@`.
3. URL query strings: `?…` up to whitespace, a quote or `#` → `?[redacted]`.
4. `Bearer <x>` → `Bearer [redacted]`. `Basic <x>` likewise.
5. `key=value` and `"key": "value"` where key matches
   `token|secret|password|passwd|api[_-]?key|authorization|cookie|session`.
6. Known prefixes: `sk-…`, `sk_live_…`, `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`, `github_pat_`,
   `xox[abprs]-`, `glpat-`, `AKIA…`.
7. JWT-shaped: `eyJ<b64url>.<b64url>.<b64url?>`.
8. Hex runs of ≥ 32 characters.
9. Base64/base64url runs of ≥ 40 characters that contain an upper-case letter, a lower-case letter
   and a digit, and do not start with `/` (that last condition spares most absolute paths).

**Not** redacted, because they are pass-through content: tool lists, tool results (including
`isError` results), and child `instructions`. **[resolved]** The brief's "child args and env never
appear in … tool results" is read as "the patchbay never puts them there". A hosted server's own
answers are the server's business; scrubbing them would break, for example, a filesystem server
whose root directory is one of its args.

The one deliberate exception is the sign-in URL, which is sent **unredacted** to the person in
the URL-mode elicitation (§8). Without it the sign-in cannot work. It never goes into logs,
`servers` output or errors.

## 7. Children

### 7.1 stdio transport

- `spawn(command, args, {cwd, env: {...process.env, ...entry.env}, stdio: "pipe", shell: false,
  windowsHide: true, detached: process.platform !== "win32"})`.
- The SDK's `StdioClientTransport` is not used, because its default env is a filtered allow-list.
- stdout is split on `\n`, and a trailing `\r` is dropped. A line is delivered only if
  `JSON.parse` succeeds **and** `JSONRPCMessageSchema.safeParse` succeeds; the **original** object
  is then passed on. Any other line goes to the "noise" ring buffer (20 lines, redacted, each cut
  to 500 chars) and nothing else happens. A partial line longer than 64 MiB is discarded as noise.
- stderr is split into lines, redacted and kept in a 20-line ring buffer. Raw lines go to the
  auth-line detector (§8) and are never stored.
- stdin `EPIPE` and other write errors are logged (redacted) and not thrown.
- A `pidfile` is written after the `spawn` event (§9).

### 7.2 Remote (`url`) children

- Command: `process.execPath <mcp-remote bin>`. The bin is resolved without `npx`: the patchbay
  calls `require.resolve("mcp-remote/package.json")`, reads `bin["mcp-remote"]` from it (in 0.15.2
  that is `dist/proxy.js`), and joins the two. The package has no `exports` map, so that
  resolution is allowed. **[resolved]**
  Setting the env `MCP_PATCHBAY_MCP_REMOTE_BIN` replaces that path; this exists for the test
  suite, which uses a fake mcp-remote.
- Args: `<url> --auth-timeout <authTimeoutSeconds>`, then for each header, in config order:
  `--header <K>:${MCP_PATCHBAY_HEADER_<i>}`. The value goes into the child's env
  as `MCP_PATCHBAY_HEADER_<i>`. **[resolved]** mcp-remote 0.15.2 expands `${VAR}` in header values
  from its own env (`substituteEnvVars`, `chunk-UZ6Y4QJH.js`). Passing values this way keeps
  secrets out of argv, where other local users could read them through `ps` or
  `/proc/*/cmdline`. Values that already contain `${` (the user's own placeholders) are passed
  literally, because mcp-remote expands only one level.
- Env: `{...process.env, ...entry.env, MCP_REMOTE_CONFIG_DIR: oauth.configDir, MCP_PATCHBAY_HEADER_<i>...}`.
  `configDir` is created with `mkdir -p` and then `chmod 0700`.
- Start timeout: `authTimeoutSeconds*1000 + 60000`. mcp-remote starts its stdio server only after
  the remote connection is up, which includes sign-in. Until then, our `initialize` waits in its
  stdin buffer.

### 7.3 Startup and state machine

```
off ──enable──▶ starting ──initialized+listed──▶ on ──disable──▶ off
                  │  ▲ auth line                    │ exit/crash
                  ▼  │                              ▼
          waiting-for-sign-in ──initialized──▶ on   failed ──enable/restart──▶ starting
                  │ timeout/exit/decline
                  ▼
                failed
```

- stdio startup timeout: 120 s for `initialize`, then 60 s for the first `tools/list`. A
  configured `cwd` that does not exist fails the start with a clear message, before spawning.
- `lastError` is a redacted one-line message, plus the last stderr line when there is one.
- A crash means an unexpected exit in any state other than `off`. It marks only that server
  `failed`, drops its tools, sends `list_changed`, sends SIGTERM to the rest of its process group,
  and removes its pidfile. 500 ms later it sends SIGKILL to that group, unless a process with the
  leader's pid exists by then (that would be a new process, since ours has exited). The bare pid
  is never signalled here. There is no automatic restart.
- Graceful close (disable, restart): close stdin, SIGTERM the group, wait up to 2 s for exit, then
  SIGKILL the group.

## 8. Sign-in (mcp-remote auth line)

The text was verified in `node_modules/mcp-remote/dist/chunk-UZ6Y4QJH.js`, in
`redirectToAuthorization`:

```js
log(`\nPlease authorize this client by visiting:\n${authorizationUrl.toString()}\n`);
```

`log` writes to stderr, prefixed with `[<pid>] `. **[resolved]** So the URL is on the line *after*
the marker, not on the same line. The detector accepts both forms: a URL on the marker line, or
the first `https?://` token on any of the next 3 lines. The detector runs on every child's stderr,
not only on `url` children. That covers people who run `npx mcp-remote` as a stdio command
themselves.

When a URL is found during start:

1. The state becomes `waiting-for-sign-in`.
2. After the client has initialized, the patchbay sends one elicitation per distinct URL:
   - if the client declared `elicitation.url`: `{mode:"url", message:"Sign in to <name> to finish
     turning it on.", url, elicitationId}`;
   - else if it declared form: `{mode:"form", message:"Sign in to <name> to finish turning it on.
     Open this link in your browser: <url>", requestedSchema:{type:"object", properties:{done:
     {type:"boolean", title:"I have signed in"}}}}`;
   - else nothing is sent. The log says that sign-in is needed (redacted). mcp-remote also tries
     to open a browser itself.
3. If the person declines or cancels, the start is aborted and the server becomes `failed`
   (`sign-in declined`).
4. `enable` stays pending until the child initializes, which moves the state to `on` and sends
   `notifications/elicitation/complete` when URL mode was used. It fails when the auth timeout
   passes, the child exits, or the person declines. Other tool calls are served concurrently
   throughout.

If the line appears while the server is already `on` (mcp-remote re-auth during a session), the
same elicitation is sent, but the state does not change.

## 9. Lifecycle

- **Pidfiles**: one per child, in the directory `${XDG_RUNTIME_DIR || os.tmpdir()}/mcp-patchbay-<uid>/`.
  `<uid>` is `process.getuid()`, or the sanitised user name on Windows. The directory is created
  at 0700. If it exists but is not a directory owned by us, pidfiles are disabled with a warning
  (protection against symlinks in a shared tmp). The file is `<ownerPid>-<childPid>.json` and
  contains `{v:2, owner, pid, cmd: sha256(command line as the OS reports it), start?, created}`.
  `start` is the process start time (Linux, field 22 of `/proc/<pid>/stat`). No args are stored,
  only their hash. A pidfile is removed only once the child's exit has been observed (by the
  patchbay, by the shutdown helper, or by a later reaper).
- **Reaping** at startup: for each pidfile whose owner pid is not alive, if the child pid is alive
  **and** the hash of its current command line equals `cmd`, the patchbay kills the tree (POSIX
  `kill(-pid, SIGTERM)`, Windows `taskkill /T /F /PID`). If after 1 s the same process is still
  there, it sends SIGKILL to the group, and then removes the pidfile. Otherwise the pidfile is
  removed at once. Pidfiles of live owners are left alone (another session is running). Command lines are read from
  `/proc/<pid>/cmdline` on Linux, `ps -ww -o command= -p` on other POSIX systems, and PowerShell
  `Get-CimInstance Win32_Process` on Windows.
- **Shutdown** on SIGINT, SIGTERM, SIGHUP (POSIX), SIGBREAK (Windows), stdin `end`/`close`, or
  `EPIPE` on stdout: synchronously, for every
  child, `process.kill(-pid, "SIGTERM")` on POSIX, or on Windows a detached, unref'd
  `taskkill /T /F /PID`. On POSIX it then spawns one detached, unref'd helper (`node -e`) that,
  500 ms later, sends SIGKILL to each of those groups. It skips a group whose leader pid now
  belongs to a process with a different start time (Linux). Then it removes the pidfiles of the
  leaders that are gone. The patchbay does not wait for the helper: it calls `process.exit(0)`
  straight away. No awaits, so it takes milliseconds. The pidfiles of children that have not
  been seen to exit are kept, so if the helper fails, the next start's reaper finishes the job.
- `uncaughtException` and `unhandledRejection` are logged (redacted) and the patchbay keeps
  serving.
- Logging goes to stderr only, as lines prefixed `[mcp-patchbay]`. stdout carries only MCP
  messages.

## 10. CLI

```
mcp-patchbay [--config <path>]
mcp-patchbay import --from <claude.json> [--project <dir>] [--out <servers.json>]
mcp-patchbay doctor [--config <path>] [--all]
mcp-patchbay rename-permissions <settings.json> [--write] [--config <path>]
mcp-patchbay --help | --version
```

- **import**: takes top-level `mcpServers`, plus `projects[<dir>].mcpServers` when `--project`
  is given (project entries win on name clashes).
  - `type` `http`/`sse` (or a bare `url`) becomes a `url` entry with `headers`. `stdio` (or a bare
    `command`) becomes a `command` entry with `args` and `env`. Other types are skipped.
  - It skips `claude.ai *`, `plugin:*`, `claude-in-chrome*` and names that are invalid here.
    **[resolved]** It also skips the patchbay itself: any `command` or arg that mentions
    `mcp-patchbay`.
  - Policy is `confirm` if the name is in `projects[<dir>].disabledMcpServers`, otherwise `allow`.
  - `autostart.projects[<dir>]` lists the imported names not disabled there. **[resolved]**
    `autostart.default` is `[]`, because the brief gives no rule for it.
  - The output defaults to the default config path. An existing file is first copied to
    `<out>.bak-<UTC timestamp>` (mode 0600).
  - The file is written at mode 0600 (and the dir at 0700 if created), through a temp file and a
    rename. The output is checked by the same validator as the config.
  - It prints names, policies, kinds and skips, but never env or header values.
- **doctor**: validates the config (exit 78 on error). For each `allow` server, or every
  non-`deny` server with `--all`, it starts the server with a 60 s budget (the auth timeout + 60 s
  for `url`), prints `name: ok, N tools` or `name: failed: <first error, redacted>`, then stops it.
  It exits 1 if any server failed.
- **rename-permissions**: for each list in `permissions.allow`, `ask` and `deny`:
  - `mcp__X__tool` adds `mcp__patchbay__<seg(X)>__tool`, and `mcp__X` adds
    `mcp__patchbay__<seg(X)>__*`. `seg` is `X`, or that server's `prefix` when `--config` is given.
  - Rules are skipped if they match `mcp__claude-in-chrome__*`, `mcp__plugin_*`, `mcp__claude_ai_*`
    or `mcp__patchbay__*`, contain `(`, have an invalid server segment, or would be longer than 128.
  - It never removes or reorders rules, and adds no duplicates.
  - Without `--write` it is a dry run that prints a diff. With `--write` it copies the file to
    `<file>.bak-<ts>` and then writes atomically with the same mode.

## 11. Known limits (v1)

- Tools only.
- No `logging` forwarding.
- Elicitation needs the client's support for `confirm` servers.
- The 128-character rule assumes the patchbay is registered under the name `patchbay`.
- On Windows: no permission check on the config, `.cmd` shims need `cmd /c`, and tree-kill
  depends on `taskkill`.
- The sign-in URL is only as good as mcp-remote's stderr format.
