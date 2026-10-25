"""Offline unit tests for cnano's own logic (no network, no GUI)."""

from __future__ import annotations

import json
import os
import random
import shlex
import tempfile
import threading
import time
import unittest
from pathlib import Path

from helpers import ROOT, run

from cnano_tui import agent as A
from cnano_tui.app import gutter_marks, run_command_for
from cnano_tui.langs import RULES, detect, regex_highlights
from cnano_tui.lsp import from_utf16, to_utf16


def node_fn(file: str, name: str, call: str) -> str:
    """Extract a top-level JS function from a renderer file and evaluate `call` with it."""
    script = (f"const src=require('fs').readFileSync({json.dumps(str(ROOT / file))},'utf8');"
              f"const m=src.match(/function {name}[\\s\\S]*?\\n}}\\n/);"
              f"const {name}=new Function(m[0]+';return {name}')();"
              f"process.stdout.write(JSON.stringify({call}));")
    r = run("node", "-e", script)
    if r.returncode:
        raise AssertionError(r.stderr)
    return json.loads(r.stdout)


class LanguageDetection(unittest.TestCase):
    def test_extensions(self):
        cases = {"a.c": "c", "a.h": "c", "a.cpp": "cpp", "a.hpp": "cpp", "a.s": "asm", "a.S": "asm", "a.asm": "asm",
                 "a.nasm": "asm", "a.rs": "rust", "a.py": "python", "a.sh": "bash", "Makefile": "makefile", "x.ld": "linkerscript",
                 "a.md": "markdown", "a.patch": "diff", "notes.txt": None}
        for name, lang in cases.items():
            self.assertEqual(detect(Path(name)), lang, name)

    def test_shebang(self):
        self.assertEqual(detect(Path("run"), "#!/bin/bash"), "bash")
        self.assertEqual(detect(Path("run"), "#!/usr/bin/env sh"), "bash")
        self.assertEqual(detect(Path("tool"), "#!/usr/bin/env python3"), "python")

    def test_asm_regex_highlighting(self):
        spans = regex_highlights(["_start:", "    movq $60, %rax   # exit", "    syscall"], RULES["asm"])
        names = {n for row in spans.values() for *_, n in row}
        self.assertTrue({"function", "keyword", "number", "variable.builtin", "comment"} <= names, names)

    def test_block_comment_spans_lines(self):
        spans = regex_highlights(["/* start", "middle", "end */ mov"], RULES["asm"])
        self.assertEqual(spans[1], [(0, 6, "comment")])


class RunCommands(unittest.TestCase):
    """Super+C picks the toolchain by language and, for assembly, by extension."""

    def test_assembler_by_extension(self):
        self.assertIn("nasm -f elf64", run_command_for(Path("/w/a.asm"), "asm"))
        self.assertIn("nasm -f elf64", run_command_for(Path("/w/a.nasm"), "asm"))
        self.assertTrue(run_command_for(Path("/w/a.s"), "asm").startswith("as -g"))
        self.assertTrue(run_command_for(Path("/w/a.S"), "asm").startswith("gcc -c -g"))

    def test_quoting(self):
        cmd = run_command_for(Path("/w/it's here/x.c"), "c")
        r = run("bash", "-c", f"set -- {cmd.split(' && ')[0]}; printf '%s\\n' \"$@\"")
        self.assertIn("/w/it's here/x.c", r.stdout.splitlines())

    def test_unknown_language(self):
        self.assertIsNone(run_command_for(Path("/w/a.txt"), None))

    def test_gui_and_tui_agree(self):
        for f, lang, gui_lang in [("/w/a.c", "c", "c"), ("/w/a.cpp", "cpp", "cpp"), ("/w/a.rs", "rust", "rust"),
                                  ("/w/a.asm", "asm", "asm"), ("/w/a.s", "asm", "asm"), ("/w/a.S", "asm", "asm")]:
            gui = node_fn("renderer/terminal.js", "runCommandFor", f"runCommandFor({json.dumps(f)},{json.dumps(gui_lang)})")
            # Quoting style may differ ('/w/a' vs /w/a); what the shell executes must not.
            self.assertEqual(shlex.split(gui), shlex.split(run_command_for(Path(f), lang)), f)


class GitGutter(unittest.TestCase):
    def test_marks(self):
        base = "a\nb\nc\nd"
        self.assertEqual(gutter_marks(base, "a\nB\nc\nd"), {1: "modified"})
        self.assertEqual(gutter_marks(base, "a\nb\nx\nc\nd"), {2: "added"})
        self.assertEqual(gutter_marks(base, "a\nc\nd"), {0: "deleted"})
        self.assertEqual(gutter_marks(None, "new\nfile"), {0: "added", 1: "added"})

    def test_gui_myers_diff_reconstructs(self):
        # The GUI's own diff: applying its hunks to `a` must yield `b`, for many random inputs.
        rnd = random.Random(7)
        pairs = [(["abc"[rnd.randrange(3)] for _ in range(rnd.randrange(12))], ["abc"[rnd.randrange(3)] for _ in range(rnd.randrange(12))]) for _ in range(300)]
        hunks = node_fn("renderer/gutter.js", "diffLines", f"{json.dumps(pairs)}.map(([a,b])=>diffLines(a,b))")
        for (a, b), hs in zip(pairs, hunks):
            out, ai = [], 0
            for h in hs:
                out += a[ai:h["aStart"]] + b[h["bStart"]:h["bStart"] + h["bLen"]]
                ai = h["aStart"] + h["aLen"]
            self.assertEqual(out + a[ai:], b)


class Utf16Positions(unittest.TestCase):
    def test_round_trip(self):
        line = "a😀b"  # the emoji is 2 UTF-16 code units
        self.assertEqual(to_utf16(line, 2), 3)
        self.assertEqual(from_utf16(line, 3), 2)
        self.assertEqual(from_utf16("abc", 99), 3)


class _Resp:
    def __init__(self, events):
        self.lines = [f"data: {json.dumps(e)}\n".encode() for e in events]

    def __iter__(self):
        return iter(self.lines)

    def close(self):
        pass


class AgentBackend(unittest.TestCase):
    """Provider adapters against canned streams in each provider's real format."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ws = Path(self.tmp.name)
        (self.ws / "a.c").write_text("int x = 1;\n")
        self._cfg = A.CONFIG_DIR, A.KEYS_FILE, A.SETTINGS_FILE
        A.CONFIG_DIR = self.ws / "cfg"
        A.KEYS_FILE, A.SETTINGS_FILE = A.CONFIG_DIR / "tui-keys.json", A.CONFIG_DIR / "tui.json"
        self._request = A._request
        self.bodies, self.turn = [], 0
        A._request = self.fake

    def tearDown(self):
        A._request = self._request
        A.CONFIG_DIR, A.KEYS_FILE, A.SETTINGS_FILE = self._cfg
        self.tmp.cleanup()

    def fake(self, url, headers, body, holder=None):
        self.bodies.append((url, body))
        first = self.turn % 2 == 0
        self.turn += 1
        if "anthropic" in url:
            return _Resp([
                {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}},
                {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Editing."}},
                {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": "tu1", "name": "edit_file"}},
                {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": '{"path":"a.c","old_str'}},
                {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": 'ing":"x = 1","new_string":"x = 2"}'}},
            ] if first else [{"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Done."}}])
        if "generativelanguage" in url:
            return _Resp([{"candidates": [{"content": {"parts": [{"functionCall": {"name": "read_file", "args": {"path": "a.c"}}, "thoughtSignature": "SIG"}]}}]}]
                         if first else [{"candidates": [{"content": {"parts": [{"text": "Read."}]}}]}])
        return _Resp([
            {"choices": [{"delta": {"content": "Run."}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "c1", "function": {"name": "run_command", "arguments": '{"comm'}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": 'and":"echo hi"}'}}]}}]},
        ] if first else [{"choices": [{"delta": {"content": "ok"}}]}])

    def _run(self, provider, auto=None):
        A.set_key(provider, "test-key")
        s, events = A.AgentSession(self.ws), []
        s.run(provider, "m", "go", events.append, auto if auto is not None else {"edits": True, "commands": True}, "acceptEdits")
        return s, events

    def test_anthropic_edits_file(self):
        s, ev = self._run("anthropic")
        self.assertEqual([e["type"] for e in ev], ["text", "tool_call", "file_changed", "tool_result", "text", "done"])
        self.assertEqual((self.ws / "a.c").read_text(), "int x = 2;\n")
        self.assertEqual([m["role"] for m in self.bodies[1][1]["messages"]], ["user", "assistant", "user"])

    def test_openai_compatible_providers_run_commands(self):
        for provider in ("openai", "openrouter", "nvidia"):
            s, ev = self._run(provider)
            result = next(e for e in ev if e["type"] == "tool_result")
            self.assertIn("hi", result["result"], provider)
            self.assertEqual(ev[-1], {"type": "done", "aborted": False})

    def test_gemini_keeps_thought_signature(self):
        self._run("gemini")
        self.assertEqual(self.bodies[1][1]["contents"][1]["parts"][0].get("thoughtSignature"), "SIG")

    def test_declined_action(self):
        A.set_key("openai", "k")
        s, ev = A.AgentSession(self.ws), []
        t = threading.Thread(target=s.run, args=("openai", "m", "x", ev.append, {}, "acceptEdits"))
        t.start()
        deadline = time.time() + 10
        while not any(e["type"] == "approval" for e in ev) and time.time() < deadline:
            time.sleep(0.01)
        approval = next(e for e in ev if e["type"] == "approval")
        s.answer(approval["approval_id"], False)
        t.join(10)
        self.assertTrue(next(e for e in ev if e["type"] == "tool_result")["declined"])

    def test_stop_repairs_history(self):
        A.set_key("openai", "k")
        s, ev = A.AgentSession(self.ws), []
        t = threading.Thread(target=s.run, args=("openai", "m", "x", ev.append, {}, "acceptEdits"))
        t.start()
        deadline = time.time() + 10
        while not any(e["type"] == "approval" for e in ev) and time.time() < deadline:
            time.sleep(0.01)
        s.stop()
        t.join(10)
        self.assertEqual(ev[-1], {"type": "done", "aborted": True})
        self.assertEqual([h["role"] for h in s.history], ["user", "assistant", "tool"])  # every tool call answered

    def test_key_file_is_private(self):
        A.set_key("anthropic", "secret")
        self.assertEqual(os.stat(A.KEYS_FILE).st_mode & 0o777, 0o600)
        self.assertEqual(A.get_key("anthropic"), "secret")

    def test_env_var_fallback(self):
        os.environ["NVIDIA_API_KEY"] = "from-env"
        try:
            self.assertEqual(A.get_key("nvidia"), "from-env")
        finally:
            del os.environ["NVIDIA_API_KEY"]


if __name__ == "__main__":
    unittest.main(verbosity=2)
