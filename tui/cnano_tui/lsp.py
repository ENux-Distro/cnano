"""Minimal asyncio LSP client for cnano-tui (same servers and lookup paths as the GUI's lsp.js)."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote, urlparse

LSP_DIR = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "cnano" / "lsp" / "bin"

# First available candidate wins. C and C++ share one clangd per project.
SERVERS: dict[str, dict] = {
    "clangd": {"langs": ["c", "cpp"], "candidates": [["clangd", "--background-index", "--header-insertion=never", "--clang-tidy"]]},
    "rust": {"langs": ["rust"], "candidates": [["rust-analyzer"]], "root_markers": ["Cargo.toml"]},
    "python": {"langs": ["python"], "candidates": [["basedpyright-langserver", "--stdio"], ["pyright-langserver", "--stdio"], ["pylsp"], ["jedi-language-server"]]},
    "asm": {"langs": ["asm"], "candidates": [["asm-lsp"]]},
}
SERVER_FOR_LANG = {lang: kind for kind, v in SERVERS.items() for lang in v["langs"]}
LANGUAGE_IDS = {"c": "c", "cpp": "cpp", "rust": "rust", "python": "python", "asm": "asm"}


def which(cmd: str) -> str | None:
    found = shutil.which(cmd)
    if found:
        return found
    p = LSP_DIR / cmd
    return str(p) if p.exists() and os.access(p, os.X_OK) else None


def available() -> dict[str, str | None]:
    return {k: next((c[0] for c in v["candidates"] if which(c[0])), None) for k, v in SERVERS.items()}


def path_to_uri(p: Path) -> str:
    return p.resolve().as_uri()


def uri_to_path(uri: str) -> Path:
    return Path(unquote(urlparse(uri).path))


# LSP positions count UTF-16 code units; TextArea columns count code points.
def to_utf16(line: str, col: int) -> int:
    return len(line[:col].encode("utf-16-le")) // 2


def from_utf16(line: str, units: int) -> int:
    count = 0
    for i, ch in enumerate(line):
        if count >= units:
            return i
        count += 2 if ord(ch) > 0xFFFF else 1
    return len(line)


class Server:
    def __init__(self, kind: str, root: Path, argv: list[str], on_notify: Callable[[str, dict], None]) -> None:
        self.kind, self.root, self.argv, self.on_notify = kind, root, argv, on_notify
        self.name = Path(argv[0]).name
        self.seq = 0
        self.pending: dict[int, asyncio.Future] = {}
        self.docs: dict[str, int] = {}
        self.capabilities: dict = {}
        self.proc: asyncio.subprocess.Process | None = None
        self.dead = False
        self.ready: asyncio.Task | None = None

    async def start(self) -> dict:
        self.proc = await asyncio.create_subprocess_exec(
            *self.argv, cwd=self.root, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL)
        asyncio.get_running_loop().create_task(self._reader())
        root_uri = path_to_uri(self.root)
        res = await self.request("initialize", {
            "processId": os.getpid(), "clientInfo": {"name": "cnano-tui"}, "rootUri": root_uri,
            "workspaceFolders": [{"uri": root_uri, "name": self.root.name}],
            "capabilities": {
                "general": {"positionEncodings": ["utf-16"]},
                "workspace": {"configuration": True, "workspaceFolders": True},
                "window": {"workDoneProgress": True},
                "textDocument": {
                    "synchronization": {"didSave": True},
                    "completion": {"completionItem": {"snippetSupport": False, "documentationFormat": ["plaintext", "markdown"]}},
                    "hover": {"contentFormat": ["markdown", "plaintext"]},
                    "definition": {}, "references": {}, "rename": {}, "formatting": {},
                    "documentSymbol": {"hierarchicalDocumentSymbolSupport": True},
                    "codeAction": {"codeActionLiteralSupport": {"codeActionKind": {"valueSet": ["quickfix", "refactor", "source"]}}},
                    "publishDiagnostics": {},
                },
            },
            "initializationOptions": {"fallbackFlags": ["-Wall", "-Wextra"]} if self.kind == "clangd" else None,
        }, timeout=60)
        self.capabilities = (res or {}).get("capabilities", {})
        self.notify("initialized", {})
        return self.capabilities

    def _write(self, msg: dict) -> None:
        if self.dead or not self.proc or not self.proc.stdin:
            return
        body = json.dumps({"jsonrpc": "2.0", **msg}).encode()
        self.proc.stdin.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)

    async def request(self, method: str, params: Any, timeout: float = 15) -> Any:
        if self.dead:
            return None
        self.seq += 1
        fut = asyncio.get_running_loop().create_future()
        self.pending[self.seq] = fut
        self._write({"id": self.seq, "method": method, "params": params})
        try:
            return await asyncio.wait_for(fut, timeout)
        except (asyncio.TimeoutError, ConnectionError):
            return None

    def notify(self, method: str, params: Any) -> None:
        self._write({"method": method, "params": params})

    async def _reader(self) -> None:
        assert self.proc and self.proc.stdout
        out = self.proc.stdout
        try:
            while True:
                length = 0
                while True:
                    line = await out.readline()
                    if not line:
                        raise ConnectionError
                    line = line.strip()
                    if not line:
                        break
                    if line.lower().startswith(b"content-length:"):
                        length = int(line.split(b":")[1])
                body = await out.readexactly(length)
                try:
                    self._dispatch(json.loads(body))
                except ValueError:
                    continue
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        self.dead = True
        for fut in self.pending.values():
            if not fut.done():
                fut.set_exception(ConnectionError(f"{self.name} exited"))
        self.on_notify("$/cnano/exit", {"server": self.name})

    def _dispatch(self, msg: dict) -> None:
        if "id" in msg and "method" not in msg:
            fut = self.pending.pop(msg["id"], None)
            if fut and not fut.done():
                fut.set_result(msg.get("result"))
            return
        if "id" in msg:  # server → client request
            result: Any = None
            if msg["method"] == "workspace/configuration":
                result = [None for _ in msg.get("params", {}).get("items", [])]
            elif msg["method"] == "workspace/workspaceFolders":
                result = [{"uri": path_to_uri(self.root), "name": self.root.name}]
            self._write({"id": msg["id"], "result": result})
            return
        self.on_notify(msg["method"], msg.get("params") or {})

    async def stop(self) -> None:
        if self.dead:
            return
        await self.request("shutdown", None, timeout=2)
        self.notify("exit", None)
        await asyncio.sleep(0.2)
        if self.proc and self.proc.returncode is None:
            self.proc.kill()


class LspManager:
    def __init__(self, on_diagnostics: Callable[[Path, list], None], on_status: Callable[[str, str], None]) -> None:
        self.on_diagnostics, self.on_status = on_diagnostics, on_status
        self.servers: dict[tuple[str, Path], Server] = {}
        self.by_path: dict[Path, Server] = {}
        self.versions: dict[Path, int] = {}
        self.diagnostics: dict[Path, list] = {}

    def _root_for(self, kind: str, path: Path, workspace: Path) -> Path:
        for d in [path.parent, *path.parent.parents]:
            if workspace not in (d, *d.parents):
                break
            if any((d / m).exists() for m in SERVERS[kind].get("root_markers", [])):
                return d
        return workspace

    def _notify(self, server: Server, method: str, params: dict) -> None:
        if method == "textDocument/publishDiagnostics":
            p = uri_to_path(params["uri"])
            self.diagnostics[p] = params.get("diagnostics", [])
            self.on_diagnostics(p, self.diagnostics[p])
        elif method == "$/progress":
            v = params.get("value") or {}
            if v.get("kind") == "begin":
                self.on_status(server.name, f"busy:{v.get('title', '')}")
            elif v.get("kind") == "end":
                self.on_status(server.name, "ready")
        elif method == "$/cnano/exit":
            self.on_status(server.name, "stopped")

    async def open(self, workspace: Path, path: Path, lang: str | None, text: str) -> Server | None:
        kind = SERVER_FOR_LANG.get(lang or "")
        if not kind:
            return None
        root = self._root_for(kind, path, workspace)
        srv = self.servers.get((kind, root))
        if srv is None or srv.dead:
            argv = next((c for c in SERVERS[kind]["candidates"] if which(c[0])), None)
            if not argv:
                return None
            srv = Server(kind, root, [which(argv[0]), *argv[1:]], lambda m, p, s=None: None)
            srv.on_notify = lambda m, p, s=srv: self._notify(s, m, p)
            self.servers[(kind, root)] = srv
            self.on_status(srv.name, "starting")
            srv.ready = asyncio.get_running_loop().create_task(srv.start())
        try:
            await srv.ready
        except Exception as e:  # noqa: BLE001
            srv.dead = True
            self.on_status(srv.name, f"error:{e}")
            return None
        self.on_status(srv.name, "ready")
        uri = path_to_uri(path)
        self.by_path[path] = srv
        if uri not in srv.docs:
            srv.docs[uri] = 1
            self.versions[path] = 1
            srv.notify("textDocument/didOpen", {"textDocument": {"uri": uri, "languageId": LANGUAGE_IDS[lang], "version": 1, "text": text}})
        return srv

    def change(self, path: Path, text: str) -> None:
        srv = self.by_path.get(path)
        if not srv:
            return
        self.versions[path] = self.versions.get(path, 1) + 1
        srv.notify("textDocument/didChange", {"textDocument": {"uri": path_to_uri(path), "version": self.versions[path]}, "contentChanges": [{"text": text}]})

    def save(self, path: Path, text: str) -> None:
        srv = self.by_path.get(path)
        if srv:
            srv.notify("textDocument/didSave", {"textDocument": {"uri": path_to_uri(path)}, "text": text})

    def close(self, path: Path) -> None:
        srv = self.by_path.pop(path, None)
        if srv:
            uri = path_to_uri(path)
            srv.docs.pop(uri, None)
            srv.notify("textDocument/didClose", {"textDocument": {"uri": uri}})
        self.diagnostics.pop(path, None)

    def server_for(self, path: Path) -> Server | None:
        srv = self.by_path.get(path)
        return srv if srv and not srv.dead else None

    async def request(self, path: Path, method: str, params: dict) -> Any:
        srv = self.server_for(path)
        if not srv:
            return None
        return await srv.request(method, {"textDocument": {"uri": path_to_uri(path)}, **params})

    async def stop_all(self) -> None:
        await asyncio.gather(*(s.stop() for s in self.servers.values()), return_exceptions=True)
        self.servers.clear()
        self.by_path.clear()
