"""Tests for write_gate.py. Run: python3 -m unittest discover -s examples/write-gate -v"""
import json
import os
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import write_gate as wg  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "write_gate.py")
CONFIG = {"identities": ["deploy-bot@example.com", "prod-example"], "tools": ["mcp__example-remote__*"]}


class NormalizeTests(unittest.TestCase):
    def test_direct_names_unchanged(self):
        self.assertEqual(wg.normalize_tool_name("mcp__example-remote__create_item"), "mcp__example-remote__create_item")
        self.assertEqual(wg.normalize_tool_name("Bash"), "Bash")

    def test_patchbay_names(self):
        self.assertEqual(wg.normalize_tool_name("mcp__patchbay__example-remote__create_item"), "mcp__example-remote__create_item")

    def test_split_on_first_double_underscore(self):
        self.assertEqual(wg.normalize_tool_name("mcp__patchbay__files___hidden"), "mcp__files___hidden")
        self.assertEqual(wg.normalize_tool_name("mcp__patchbay__files__a__b"), "mcp__files__a__b")
        self.assertEqual(wg.normalize_tool_name("mcp__patchbay__under_score__do"), "mcp__under_score__do")

    def test_own_tools_kept(self):
        self.assertEqual(wg.normalize_tool_name("mcp__patchbay__enable"), "mcp__patchbay__enable")

    def test_unparseable(self):
        for bad in ["mcp__patchbay__", "mcp__patchbay__nosplit", "mcp__patchbay____x", "mcp__patchbay__srv__", "mcp__patchbay__bad.seg__t"]:
            self.assertIsNone(wg.normalize_tool_name(bad), bad)


class DecideTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["WRITE_GATE_STATE_DIR"] = self.tmp.name

    def tearDown(self):
        os.environ.pop("WRITE_GATE_STATE_DIR", None)
        self.tmp.cleanup()

    def event(self, tool, tool_input, hook="PreToolUse", session="s1"):
        return {"hook_event_name": hook, "session_id": session, "tool_name": tool, "tool_input": tool_input}

    def test_asks_once_per_session_after_approval(self):
        e = self.event("mcp__patchbay__example-remote__create_item", {"owner": "Deploy-Bot@example.com", "title": "x"})
        out = wg.decide(e, CONFIG)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "ask")
        self.assertIn("deploy-bot@example.com", out["hookSpecificOutput"]["permissionDecisionReason"])
        # still asks until the call has actually run
        self.assertIsNotNone(wg.decide(e, CONFIG))
        wg.decide(dict(e, hook_event_name="PostToolUse"), CONFIG)
        self.assertIsNone(wg.decide(e, CONFIG))
        # the direct name shares the approval, a new session does not
        self.assertIsNone(wg.decide(self.event("mcp__example-remote__create_item", {"a": ["prod", {"b": "deploy-bot@example.com"}]}), CONFIG))
        self.assertIsNotNone(wg.decide(self.event("mcp__example-remote__create_item", {"owner": "deploy-bot@example.com"}, session="s2"), CONFIG))

    def test_other_identity_still_asks(self):
        wg.remember("s1", ["deploy-bot@example.com"])
        out = wg.decide(self.event("mcp__example-remote__delete_item", {"project": "prod-example"}), CONFIG)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "ask")

    def test_silent_without_identity_or_outside_tools(self):
        self.assertIsNone(wg.decide(self.event("mcp__patchbay__example-remote__create_item", {"title": "hello"}), CONFIG))
        self.assertIsNone(wg.decide(self.event("mcp__example-files__write_file", {"owner": "deploy-bot@example.com"}), CONFIG))

    def test_unparseable_patchbay_name_always_asks(self):
        out = wg.decide(self.event("mcp__patchbay__weird", {"title": "nothing relevant"}), CONFIG)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "ask")

    def test_no_tool_filter_checks_everything(self):
        cfg = {"identities": ["prod-example"], "tools": None}
        out = wg.decide(self.event("Bash", {"command": "deploy --project prod-example"}), cfg)
        self.assertEqual(out["hookSpecificOutput"]["permissionDecision"], "ask")


class ScriptTests(unittest.TestCase):
    def run_script(self, payload, config=CONFIG):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = os.path.join(tmp, "write-gate.json")
            with open(cfg, "w", encoding="utf-8") as f:
                json.dump(config, f)
            env = dict(os.environ, WRITE_GATE_STATE_DIR=os.path.join(tmp, "state"))
            r = subprocess.run([sys.executable, SCRIPT, "--config", cfg], input=payload, capture_output=True, text=True, env=env, timeout=30)
            return r

    def test_end_to_end_ask(self):
        payload = json.dumps({"hook_event_name": "PreToolUse", "session_id": "abc", "tool_name": "mcp__patchbay__example-remote__create_item", "tool_input": {"owner": "deploy-bot@example.com"}})
        r = self.run_script(payload)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["hookSpecificOutput"]["permissionDecision"], "ask")

    def test_end_to_end_silent(self):
        payload = json.dumps({"hook_event_name": "PreToolUse", "session_id": "abc", "tool_name": "Read", "tool_input": {"file_path": "/path/to/x"}})
        r = self.run_script(payload)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "")

    def test_a_config_that_is_not_an_object_fails_closed(self):
        payload = json.dumps({"hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": {}})
        r = self.run_script(payload, config=["not", "an", "object"])
        self.assertEqual(r.returncode, 0, r.stderr)
        out = json.loads(r.stdout)["hookSpecificOutput"]
        self.assertEqual(out["permissionDecision"], "ask")
        self.assertIn("config problem", out["permissionDecisionReason"])

    def test_garbage_input_fails_closed(self):
        r = self.run_script("not json")
        self.assertEqual(json.loads(r.stdout)["hookSpecificOutput"]["permissionDecision"], "ask")

    def run_bytes(self, payload, extra_env=None):
        with tempfile.TemporaryDirectory() as tmp:
            cfg = os.path.join(tmp, "write-gate.json")
            with open(cfg, "w", encoding="utf-8") as f:
                json.dump(CONFIG, f)
            env = dict(os.environ, WRITE_GATE_STATE_DIR=os.path.join(tmp, "state"), **(extra_env or {}))
            return subprocess.run([sys.executable, SCRIPT, "--config", cfg], input=payload, capture_output=True, env=env, timeout=30)

    def test_utf8_input_is_read_as_utf8_whatever_the_locale(self):
        payload = json.dumps({"hook_event_name": "PreToolUse", "tool_name": "mcp__patchbay__example-remote__create_item", "tool_input": {"note": "\u201cquoted\u201d", "owner": "deploy-bot@example.com"}}, ensure_ascii=False).encode("utf-8")
        r = self.run_bytes(payload, {"PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0"})
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["hookSpecificOutput"]["permissionDecision"], "ask")

    def test_input_that_is_not_utf8_fails_closed(self):
        r = self.run_bytes(b'{"tool_name": "\xff"}')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout)["hookSpecificOutput"]["permissionDecision"], "ask")

    def test_an_internal_error_fails_closed(self):
        import contextlib
        import io
        from unittest import mock
        payload = json.dumps({"hook_event_name": "PreToolUse", "tool_name": "Read", "tool_input": {}}).encode("utf-8")
        out = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp:
            cfg = os.path.join(tmp, "write-gate.json")
            with open(cfg, "w", encoding="utf-8") as f:
                json.dump(CONFIG, f)
            with mock.patch.object(wg, "decide", side_effect=RuntimeError("boom")), \
                    mock.patch.object(sys, "stdin", io.TextIOWrapper(io.BytesIO(payload), encoding="utf-8")), \
                    contextlib.redirect_stdout(out):
                self.assertEqual(wg.main(["--config", cfg]), 0)
        self.assertEqual(json.loads(out.getvalue())["hookSpecificOutput"]["permissionDecision"], "ask")


if __name__ == "__main__":
    unittest.main()
