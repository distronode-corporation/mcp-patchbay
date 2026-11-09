#!/usr/bin/env python3
"""write-gate: an example Claude Code hook that asks once per session before a tool call whose
input names a configured "write identity" (an account, a bot user, a production project...).

It runs on two hook events:

* PreToolUse:  if the tool input mentions a write identity and nothing has been approved for that
               identity in this session yet, return permissionDecision "ask".
* PostToolUse: when such a call actually ran (so the person approved it), remember that for the
               session, so later calls are not asked again.

Tool names behind mcp-patchbay are normalised so one rule covers both forms:
``mcp__patchbay__<server>__<tool>`` becomes ``mcp__<server>__<tool>``. The split is on the FIRST
``__`` after ``mcp__patchbay__``; server names never contain ``__`` or end with ``_``, while tool
names may contain ``___``. A patchbay name that cannot be parsed always gets "ask".

Standard library only. Configure it with a JSON file (see write-gate.example.json):

    {"identities": ["deploy-bot@example.com"], "tools": ["mcp__example-remote__*"]}

``tools`` is optional (fnmatch patterns on the normalised name); without it every tool is checked.
"""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import sys
import tempfile
from typing import Any, Iterable, Optional

PATCHBAY_PREFIX = "mcp__patchbay__"
# The patchbay's own tools have no server segment.
PATCHBAY_OWN_TOOLS = {"servers", "enable", "disable", "restart", "info"}
_SEGMENT = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def normalize_tool_name(name: str) -> Optional[str]:
    """Maps a patchbay tool name to the direct form; returns None if it cannot be parsed.

    Non-patchbay names are returned unchanged.
    """
    if not name.startswith(PATCHBAY_PREFIX):
        return name
    rest = name[len(PATCHBAY_PREFIX):]
    if rest in PATCHBAY_OWN_TOOLS:
        return name
    idx = rest.find("__")
    if idx <= 0:
        return None
    server, tool = rest[:idx], rest[idx + 2:]
    if not tool or not _SEGMENT.match(server) or server.endswith("_"):
        return None
    return f"mcp__{server}__{tool}"


def _strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for k, v in value.items():
            yield str(k)
            yield from _strings(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            yield from _strings(v)
    elif value is not None:
        yield str(value)


def named_identities(tool_input: Any, identities: Iterable[str]) -> list[str]:
    """The configured identities that appear (case-insensitively) anywhere in the tool input."""
    haystack = "\n".join(_strings(tool_input)).lower()
    return [i for i in identities if i and i.lower() in haystack]


def load_config(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    identities = cfg.get("identities")
    if not isinstance(identities, list) or not all(isinstance(i, str) and i for i in identities):
        raise ValueError("config: identities must be a non-empty list of strings")
    tools = cfg.get("tools")
    if tools is not None and (not isinstance(tools, list) or not all(isinstance(t, str) for t in tools)):
        raise ValueError("config: tools must be a list of strings")
    return {"identities": identities, "tools": tools}


def state_dir() -> str:
    base = os.environ.get("WRITE_GATE_STATE_DIR")
    if not base:
        uid = os.getuid() if hasattr(os, "getuid") else os.environ.get("USERNAME", "user")
        base = os.path.join(tempfile.gettempdir(), f"write-gate-{uid}")
    os.makedirs(base, mode=0o700, exist_ok=True)
    return base


def _state_file(session_id: str) -> str:
    digest = hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:32]
    return os.path.join(state_dir(), f"{digest}.json")


def approved(session_id: str) -> set[str]:
    try:
        with open(_state_file(session_id), encoding="utf-8") as f:
            return set(json.load(f))
    except (OSError, ValueError):
        return set()


def remember(session_id: str, identities: Iterable[str]) -> None:
    done = approved(session_id) | {i.lower() for i in identities}
    path = _state_file(session_id)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(sorted(done), f)
    os.replace(tmp, path)


def ask(reason: str) -> dict:
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "ask",
            "permissionDecisionReason": reason,
        }
    }


def decide(event: dict, config: dict) -> Optional[dict]:
    """Returns the hook output for one event, or None to stay silent."""
    hook = event.get("hook_event_name", "PreToolUse")
    tool_name = str(event.get("tool_name", ""))
    session_id = str(event.get("session_id", ""))
    normalized = normalize_tool_name(tool_name)
    if normalized is None:
        if hook == "PreToolUse":
            return ask(f"write-gate: cannot parse patchbay tool name {tool_name!r}; asking to be safe")
        return None
    patterns = config.get("tools")
    if patterns and not any(fnmatch.fnmatchcase(normalized, p) for p in patterns):
        return None
    hits = named_identities(event.get("tool_input"), config["identities"])
    if not hits:
        return None
    if hook == "PostToolUse":
        if session_id:
            remember(session_id, hits)
        return None
    pending = [h for h in hits if h.lower() not in approved(session_id)] if session_id else hits
    if not pending:
        return None
    return ask(f"write-gate: {normalized} acts as {', '.join(pending)}; confirm once for this session")


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    default = os.environ.get("WRITE_GATE_CONFIG") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "write-gate.json")
    parser.add_argument("--config", default=default)
    args = parser.parse_args(argv)
    try:
        # Hook input is UTF-8 JSON whatever the locale (cp1252 on many Windows systems).
        event = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        if not isinstance(event, dict):
            raise ValueError("event is not an object")
    except ValueError:  # UnicodeDecodeError included
        # Fail closed: we cannot tell what is being called.
        print(json.dumps(ask("write-gate: unreadable hook input; asking to be safe")))
        return 0
    try:
        config = load_config(args.config)
    except (OSError, ValueError) as e:
        if event.get("hook_event_name", "PreToolUse") == "PreToolUse":
            print(json.dumps(ask(f"write-gate: config problem ({e}); asking to be safe")))
        return 0
    try:
        out = decide(event, config)
    except Exception as e:  # a crash exits non-zero, which Claude Code treats as "go ahead"
        if event.get("hook_event_name", "PreToolUse") == "PreToolUse":
            print(json.dumps(ask(f"write-gate: internal error ({type(e).__name__}); asking to be safe")))
        return 0
    if out is not None:
        print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
