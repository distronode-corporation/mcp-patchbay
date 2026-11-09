# write-gate: an example PreToolUse hook

`write_gate.py` is a generic Claude Code hook
example. It uses the Python 3 standard library only. It **asks once per session** before any tool
call whose input names one of your "write identities", such as a bot account, a production
project, or a shared mailbox.

It works the same whether a server is connected directly or through mcp-patchbay:

- `mcp__patchbay__<server>__<tool>` is normalised to `mcp__<server>__<tool>`.
- The split is on the **first** `__` after `mcp__patchbay__`. Server names never contain `__` or
  end with `_`, while tool names may contain `___`.
- A patchbay tool name it cannot parse always gets `"ask"`.
- The patchbay's own tools (`mcp__patchbay__enable`, …) are left as they are.

"Once per session" means: it asks until a matching call has actually run, which the PostToolUse
event tells it. After that, calls naming the same identity in the same session pass to your normal
permission rules. If you decline, it keeps asking.

## Setup

1. Copy `write-gate.example.json` to `write-gate.json` next to the script, and list your
   identities. The optional `tools` holds `fnmatch` patterns on the normalised name; without it,
   every tool is checked.
2. Register it for both events in `~/.claude/settings.json`:

   ```json
   {
     "hooks": {
       "PreToolUse": [
         { "matcher": "mcp__.*", "hooks": [{ "type": "command", "command": "python3 /path/to/write_gate.py --config /path/to/write-gate.json" }] }
       ],
       "PostToolUse": [
         { "matcher": "mcp__.*", "hooks": [{ "type": "command", "command": "python3 /path/to/write_gate.py --config /path/to/write-gate.json" }] }
       ]
     }
   }
   ```

Session state is kept in `$WRITE_GATE_STATE_DIR`, or by default in
`<tmp>/write-gate-<uid>/`, as one small file per session (named by a hash of the session id).

## Tests

```sh
python3 -m unittest discover -s examples/write-gate -v
```
