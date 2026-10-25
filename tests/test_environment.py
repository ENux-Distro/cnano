"""Does this machine have what cnano needs?

Required tools fail the run; optional ones (extra compilers, language servers) are reported as skips
with the reason, so `make test` doubles as a readiness checklist.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

from helpers import ELECTRON, LSP_DIR, ROOT, TUI_STAGE, run, version_tuple, which


class RequiredTools(unittest.TestCase):
    """Without these, cnano doesn't build or run."""

    def test_git(self):
        self.assertIsNotNone(which("git"), "git is required (source control panel, clone, gutter)")
        self.assertGreaterEqual(version_tuple(run("git", "--version").stdout), (2, 23), "git ≥ 2.23 needed for `git restore`")

    def test_node_and_npm(self):
        self.assertIsNotNone(which("node"), "node is required to build the GUI")
        self.assertIsNotNone(which("npm"), "npm is required to install GUI dependencies")
        self.assertGreaterEqual(version_tuple(run("node", "--version").stdout), (18,), "node ≥ 18 required")

    def test_python_version(self):
        self.assertGreaterEqual(sys.version_info[:2], (3, 10), "cnano-tui needs Python ≥ 3.10")

    def test_python_venv(self):
        r = run(sys.executable, "-c", "import venv, ensurepip")
        self.assertEqual(r.returncode, 0, "python3 venv/ensurepip missing (needed by `make stage-tui`); install python3-venv")

    def test_build_toolchain(self):
        # node-pty (the GUI terminal) is a native module rebuilt against Electron.
        for tool in ("make", "g++"):
            self.assertIsNotNone(which(tool), f"{tool} is required to build node-pty")

    def test_bash(self):
        self.assertIsNotNone(which("bash"), "bash runs the terminal, run commands and agent shell tool")


class GuiInstall(unittest.TestCase):
    """The npm dependencies are installed and usable."""

    def setUp(self):
        if not (ROOT / "node_modules").is_dir():
            self.fail("node_modules missing — run `npm install` (or `make`)")

    def test_npm_packages_present(self):
        for pkg in ("electron", "monaco-editor", "marked", "dompurify", "node-pty", "@xterm/xterm", "@xterm/addon-fit"):
            self.assertTrue((ROOT / "node_modules" / pkg / "package.json").exists(), f"npm package {pkg} missing — run `npm install`")

    def test_electron_binary(self):
        self.assertTrue(ELECTRON.exists(), "Electron binary missing — run `npm install`")
        r = run(str(ELECTRON), "--version", env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"})
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_node_pty_loads_in_electron(self):
        # Catches the classic "compiled against a different Node.js version" ABI mismatch.
        script = "const p=require('node-pty');const t=p.spawn('bash',['-c','echo pty-ok'],{});" \
                 "t.onData(d=>process.stdout.write(d));t.onExit(()=>process.exit(0));"
        r = run(str(ELECTRON), "-e", script, cwd=ROOT, env={**os.environ, "ELECTRON_RUN_AS_NODE": "1"}, timeout=30)
        self.assertIn("pty-ok", r.stdout, f"node-pty doesn't load in Electron — run `npx electron-rebuild -f -w node-pty`\n{r.stderr[-800:]}")

    def test_javascript_syntax(self):
        files = ["main.js", "agent.js", "lsp.js", "preload.js", *[f"renderer/{f.name}" for f in (ROOT / "renderer").glob("*.js")]]
        for f in files:
            r = run("node", "--check", str(ROOT / f))
            self.assertEqual(r.returncode, 0, f"{f}: {r.stderr}")


class TuiInstall(unittest.TestCase):
    """cnano-tui's Python dependencies import cleanly."""

    def test_textual_and_grammars_import(self):
        env = {**os.environ, "PYTHONPATH": f"{ROOT / 'tui'}:{TUI_STAGE}"}
        r = run(sys.executable, "-c",
                "import textual, tree_sitter, tree_sitter_c, tree_sitter_cpp;"
                "from tree_sitter import Language; Language(tree_sitter_c.language()); Language(tree_sitter_cpp.language());"
                "import cnano_tui.app; print(textual.__version__)", env=env)
        self.assertEqual(r.returncode, 0, f"TUI deps not importable — run `make stage-tui`\n{r.stderr[-800:]}")

    def test_tui_starts(self):
        env = {**os.environ, "PYTHONPATH": f"{ROOT / 'tui'}:{TUI_STAGE}"}
        r = run(sys.executable, "-m", "cnano_tui", "--version", env=env)
        self.assertEqual(r.returncode, 0, r.stderr[-500:])
        self.assertIn("cnano-tui", r.stdout)


class Compilers(unittest.TestCase):
    """Toolchains used by Super+C / F5 (compile & run). Missing ones only disable that language."""

    def _needs(self, *tools):
        missing = [t for t in tools if not which(t)]
        if missing:
            self.skipTest(f"not installed: {', '.join(missing)} (only needed to run those files)")

    def _compile_and_run(self, filename: str, source: str, expect: str):
        sys.path.insert(0, str(ROOT / "tui"))
        from cnano_tui.app import run_command_for
        from cnano_tui.langs import detect
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / filename
            p.write_text(source)
            cmd = run_command_for(p, detect(p))
            r = run("bash", "-c", cmd, cwd=d, timeout=120)
            self.assertEqual(r.returncode, 0, f"{cmd}\n{r.stderr[-800:]}")
            self.assertIn(expect, r.stdout)

    def test_c(self):
        self._needs("gcc")
        self._compile_and_run("t.c", '#include <stdio.h>\n#include <math.h>\nint main(void){printf("c %.0f\\n", sqrt(4.0));}\n', "c 2")

    def test_cpp(self):
        self._needs("g++")
        self._compile_and_run("t.cpp", '#include <iostream>\nint main(){std::cout<<"cpp ok\\n";}\n', "cpp ok")

    def test_nasm(self):
        self._needs("nasm", "ld")
        self._compile_and_run("t.asm", 'global _start\nsection .data\nm db "nasm ok",10\nsection .text\n_start:\n mov rax,1\n mov rdi,1\n'
                              ' lea rsi,[rel m]\n mov rdx,8\n syscall\n mov rax,60\n xor edi,edi\n syscall\n', "nasm ok")

    def test_gas(self):
        self._needs("as", "ld")
        self._compile_and_run("t.s", '.globl _start\n.data\nm: .ascii "gas ok\\n"\n.text\n_start:\n mov $1,%rax\n mov $1,%rdi\n'
                              ' lea m(%rip),%rsi\n mov $7,%rdx\n syscall\n mov $60,%rax\n xor %edi,%edi\n syscall\n', "gas ok")

    def test_rust(self):
        self._needs("rustc")
        self._compile_and_run("t.rs", 'fn main(){println!("rust ok");}\n', "rust ok")

    def test_python(self):
        self._compile_and_run("t.py", 'print("py ok")\n', "py ok")


class ClaudeCode(unittest.TestCase):
    """The agent's "Claude Code (Pro plan)" provider shells out to `claude -p`.

    The live check sends one tiny prompt (costs a few cents of plan usage); set CNANO_SKIP_CLAUDE=1 to skip it.
    """

    def setUp(self):
        self.claude = which("claude")
        if not self.claude:
            self.fail("`claude` not found on PATH — install Claude Code (https://claude.com/claude-code) to use the Pro-plan provider")

    def test_claude_version(self):
        r = run(self.claude, "--version", timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertRegex(r.stdout, r"\d+\.\d+", "unexpected `claude --version` output")

    def test_claude_supports_stream_json(self):
        r = run(self.claude, "-p", "--help", timeout=30)
        for flag in ("--output-format", "--include-partial-messages", "--permission-mode", "--resume"):
            self.assertIn(flag, r.stdout, f"`claude` is too old: missing {flag} (update Claude Code)")

    @unittest.skipIf(os.environ.get("CNANO_SKIP_CLAUDE"), "CNANO_SKIP_CLAUDE set")
    def test_claude_answers_a_prompt(self):
        with tempfile.TemporaryDirectory() as d:
            r = run(self.claude, "-p", "Reply with exactly: cnano-ok", "--output-format", "stream-json", "--verbose",
                    "--model", "haiku", "--permission-mode", "plan", cwd=d, timeout=180)
        events = [json.loads(l) for l in r.stdout.splitlines() if l.startswith("{")]
        result = next((e for e in events if e.get("type") == "result"), None)
        self.assertIsNotNone(result, f"no result from `claude -p` — are you logged in? Run `claude` once.\n{r.stderr[-800:]}")
        self.assertFalse(result.get("is_error"), f"claude reported an error: {result.get('result')}")
        self.assertIn("cnano-ok", result.get("result", ""))
        self.assertTrue(result.get("session_id"), "no session id (needed to continue chats)")


class LanguageServers(unittest.TestCase):
    """Optional: each server cnano knows about, plus a real initialize handshake."""

    def _handshake(self, kind: str, filename: str, source: str):
        sys.path.insert(0, str(ROOT / "tui"))
        import asyncio
        from cnano_tui.lsp import LspManager, available

        if not available()[kind]:
            hint = "your distro's clangd package" if kind == "clangd" else f"`make lsp` (installs into {LSP_DIR})"
            self.skipTest(f"{kind} language server not installed — {hint}")

        async def go():
            diags = {}
            mgr = LspManager(lambda p, d: diags.setdefault("d", d), lambda *a: None)
            with tempfile.TemporaryDirectory() as d:
                root = Path(d)
                p = root / filename
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(source)
                if kind == "rust":
                    (root / "Cargo.toml").write_text('[package]\nname="t"\nversion="0.1.0"\nedition="2021"\n')
                srv = await mgr.open(root, p, {"clangd": "c", "rust": "rust", "python": "python", "asm": "asm"}[kind], source)
                self.assertIsNotNone(srv, f"{kind}: server failed to start")
                self.assertTrue(srv.capabilities, f"{kind}: empty capabilities from initialize")
                hover = await mgr.request(p, "textDocument/hover", {"position": {"line": 0, "character": 1}})
                await mgr.stop_all()
                return srv.capabilities, hover
        return asyncio.run(asyncio.wait_for(go(), 120))

    def test_clangd(self):
        caps, _ = self._handshake("clangd", "t.c", "int main(void) { return 0; }\n")
        self.assertIn("completionProvider", caps)

    def test_pyright(self):
        caps, _ = self._handshake("python", "t.py", "import os\nprint(os.getcwd())\n")
        self.assertIn("hoverProvider", caps)

    def test_rust_analyzer(self):
        caps, _ = self._handshake("rust", "src/main.rs", "fn main() {}\n")
        self.assertIn("definitionProvider", caps)

    def test_asm_lsp(self):
        caps, hover = self._handshake("asm", "t.asm", "syscall\n")
        self.assertIn("hoverProvider", caps)
        self.assertIn("syscall", json.dumps(hover or {}).lower())


if __name__ == "__main__":
    unittest.main(verbosity=2)
