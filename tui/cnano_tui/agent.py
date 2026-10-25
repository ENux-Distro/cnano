"""AI agent backend for cnano-tui — a Python port of the GUI's agent.js.

Providers: Claude Code (`claude -p`, uses the logged-in plan), Anthropic, OpenAI, Gemini,
OpenRouter and NVIDIA Build. Runs in a worker thread and reports through an `emit` callback;
approvals block the thread until the UI answers.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Callable

CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "cnano"
KEYS_FILE = CONFIG_DIR / "tui-keys.json"
SETTINGS_FILE = CONFIG_DIR / "tui.json"

PROVIDERS = {
    "claude-cli": {"label": "Claude Code (Pro plan)", "model": "default", "env": None},
    "anthropic": {"label": "Anthropic API", "model": "claude-sonnet-5-5", "env": "ANTHROPIC_API_KEY"},
    "openai": {"label": "OpenAI", "model": "gpt-5", "env": "OPENAI_API_KEY"},
    "gemini": {"label": "Google Gemini", "model": "gemini-2.5-pro", "env": "GEMINI_API_KEY"},
    "openrouter": {"label": "OpenRouter", "model": "anthropic/claude-sonnet-4.5", "env": "OPENROUTER_API_KEY"},
    "nvidia": {"label": "NVIDIA Build", "model": "meta/llama-3.3-70b-instruct", "env": "NVIDIA_API_KEY"},
}
OPENAI_COMPAT = {
    "openai": "https://api.openai.com/v1",
    "openrouter": "https://openrouter.ai/api/v1",
    "nvidia": "https://integrate.api.nvidia.com/v1",
}
CLAUDE_CLI_MODELS = ["default", "opus", "sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]
MAX_TOOL_OUTPUT = 30000
MAX_STEPS = 50
IGNORED = {".git", "node_modules", "target", "build", ".cache", "__pycache__", ".venv", "dist"}


# ---------------------------------------------------------------- settings & keys
def _load(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def _save(path: Path, data: dict, private: bool = False) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    if private:
        os.chmod(tmp, 0o600)
    tmp.replace(path)


def load_settings() -> dict:
    return _load(SETTINGS_FILE)


def save_settings(data: dict) -> None:
    _save(SETTINGS_FILE, data)


def get_key(provider: str) -> str | None:
    key = _load(KEYS_FILE).get(provider)
    env = PROVIDERS[provider]["env"]
    if not key and provider == "gemini":
        key = os.environ.get("GOOGLE_API_KEY")
    return key or (os.environ.get(env) if env else None)


def set_key(provider: str, key: str | None) -> None:
    keys = _load(KEYS_FILE)
    if key:
        keys[provider] = key
    else:
        keys.pop(provider, None)
    _save(KEYS_FILE, keys, private=True)


def has_key(provider: str) -> bool:
    return PROVIDERS[provider]["env"] is None or bool(get_key(provider))


# ---------------------------------------------------------------- tools
TOOLS = [
    {"name": "list_files",
     "description": "List files and folders in a directory of the workspace. Use recursive=true for a tree (ignores .git, node_modules, build dirs).",
     "parameters": {"type": "object", "properties": {"path": {"type": "string", "description": 'Directory relative to the workspace root ("." for root).'},
                                                     "recursive": {"type": "boolean"}}, "required": ["path"]}},
    {"name": "read_file",
     "description": "Read a text file. Returns numbered lines. Optionally pass start_line/end_line (1-based, inclusive) for large files.",
     "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "start_line": {"type": "integer"}, "end_line": {"type": "integer"}}, "required": ["path"]}},
    {"name": "search",
     "description": "Search file contents in the workspace with a regular expression (grep -E). Returns file:line:text matches.",
     "parameters": {"type": "object", "properties": {"pattern": {"type": "string"}, "path": {"type": "string", "description": "Optional subdirectory to search in."}}, "required": ["pattern"]}},
    {"name": "edit_file",
     "description": "Replace an exact snippet in a file. old_string must appear exactly once in the file; include enough surrounding context to make it unique. Prefer this over write_file for changes to existing files.",
     "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "old_string": {"type": "string"}, "new_string": {"type": "string"}}, "required": ["path", "old_string", "new_string"]}},
    {"name": "write_file",
     "description": "Create a new file or completely overwrite an existing one with the given content. Parent folders are created.",
     "parameters": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}},
    {"name": "run_command",
     "description": "Run a shell command (bash) in the workspace root, e.g. to build (make, gcc, cargo), run tests, or inspect the system. Returns exit code and output. Times out after 120s; do not start long-running servers.",
     "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}},
]
NEEDS_APPROVAL = {"edit_file": "edits", "write_file": "edits", "run_command": "commands"}


def _truncate(s: str) -> str:
    return s if len(s) <= MAX_TOOL_OUTPUT else s[:MAX_TOOL_OUTPUT] + f"\n… [truncated {len(s) - MAX_TOOL_OUTPUT} chars]"


def run_tool(name: str, args: dict, root: Path, emit, cancel: threading.Event) -> str:
    resolve = lambda p: (root / (p or ".")).resolve()  # noqa: E731
    if name == "list_files":
        base = resolve(args.get("path"))
        out: list[str] = []
        if args.get("recursive"):
            for dirpath, dirnames, filenames in os.walk(base):
                dirnames[:] = sorted(d for d in dirnames if d not in IGNORED)
                rel = os.path.relpath(dirpath, base)
                for d in dirnames:
                    out.append(os.path.join(rel, d).removeprefix("./") + "/")
                for f in sorted(filenames):
                    out.append(os.path.join(rel, f).removeprefix("./"))
                if len(out) > 1500:
                    break
        else:
            out = [e.name + ("/" if e.is_dir() else "") for e in sorted(base.iterdir(), key=lambda e: e.name)]
        return "\n".join(sorted(out)) or "(empty directory)"
    if name == "read_file":
        lines = resolve(args["path"]).read_text(errors="replace").split("\n")
        s = max(1, int(args.get("start_line") or 1))
        e = min(len(lines), int(args.get("end_line") or len(lines)))
        return _truncate("\n".join(f"{i:>5}\t{lines[i - 1]}" for i in range(s, e + 1)))
    if name == "search":
        target = resolve(args.get("path"))
        r = subprocess.run(["grep", "-rnIE", "--exclude-dir=.git", "--exclude-dir=node_modules", "--exclude-dir=target",
                            "--exclude-dir=build", "-m", "30", "--", args["pattern"], str(target)],
                           capture_output=True, text=True, timeout=30)
        lines = [l.removeprefix(str(root) + "/")[:400] for l in r.stdout.splitlines()[:300]]
        return _truncate("\n".join(lines)) if lines else "No matches."
    if name == "edit_file":
        p = resolve(args["path"])
        text = p.read_text()
        count = text.count(args["old_string"])
        if count == 0:
            raise ValueError("old_string not found in file. Re-read the file and copy the snippet exactly (including whitespace).")
        if count > 1:
            raise ValueError(f"old_string appears {count} times; include more context so it is unique.")
        p.write_text(text.replace(args["old_string"], args["new_string"], 1))
        emit({"type": "file_changed", "path": str(p)})
        return f"Edited {args['path']}."
    if name == "write_file":
        p = resolve(args["path"])
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(args["content"])
        emit({"type": "file_changed", "path": str(p)})
        return f"Wrote {args['content'].count(chr(10)) + 1} lines to {args['path']}."
    if name == "run_command":
        proc = subprocess.Popen(["bash", "-lc", args["command"]], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, text=True, errors="replace",
                                env={**os.environ, "TERM": "dumb", "GIT_TERMINAL_PROMPT": "0"})
        deadline = time.monotonic() + 120
        while proc.poll() is None:
            if cancel.is_set() or time.monotonic() > deadline:
                proc.kill()
                break
            time.sleep(0.05)
        out = ""
        if proc.stdout:
            out = proc.stdout.read()
            proc.stdout.close()
        note = "\n[cancelled]" if cancel.is_set() else ("\n[timed out after 120s, killed]" if proc.returncode is None or proc.returncode < 0 else "")
        return _truncate(f"exit code: {proc.returncode}\n{out}{note}")
    raise ValueError(f"Unknown tool {name}")


# ---------------------------------------------------------------- HTTP helpers
class HTTPError(Exception):
    pass


def _request(url: str, headers: dict, body: dict | None, holder: dict | None = None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json", **headers}, method="POST" if body is not None else "GET")
    try:
        resp = urllib.request.urlopen(req, timeout=300)
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            j = json.loads(raw)
            err = j.get("error", j)
            raw = err.get("message", json.dumps(err)) if isinstance(err, dict) else str(err)
        except ValueError:
            pass
        raise HTTPError(f"HTTP {e.code}: {raw[:800]}") from None
    except urllib.error.URLError as e:
        raise HTTPError(f"Network error: {e.reason}") from None
    if holder is not None:
        holder["resp"] = resp  # lets the UI thread close it to cancel
    return resp


def _sse(resp):
    for raw in resp:
        line = raw.decode(errors="replace").strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            yield json.loads(data)
        except ValueError:
            continue


# ---------------------------------------------------------------- providers
# Neutral history: {"role":"user","text"} | {"role":"assistant","text","calls":[{id,name,args}],"raw"} | {"role":"tool","id","name","result","error"}

def call_anthropic(key, model, system, history, on_text, holder):
    messages: list[dict] = []
    for h in history:
        if h["role"] == "user":
            messages.append({"role": "user", "content": h["text"]})
        elif h["role"] == "assistant":
            content = ([{"type": "text", "text": h["text"]}] if h["text"] else []) + \
                      [{"type": "tool_use", "id": c["id"], "name": c["name"], "input": c["args"]} for c in h["calls"]]
            messages.append({"role": "assistant", "content": content})
        else:
            block = {"type": "tool_result", "tool_use_id": h["id"], "content": h["result"], "is_error": bool(h.get("error"))}
            last = messages[-1] if messages else None
            if last and last["role"] == "user" and isinstance(last["content"], list) and last["content"][0].get("type") == "tool_result":
                last["content"].append(block)
            else:
                messages.append({"role": "user", "content": [block]})
    resp = _request("https://api.anthropic.com/v1/messages", {"x-api-key": key, "anthropic-version": "2023-06-01"}, {
        "model": model, "max_tokens": 16000, "stream": True,
        "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
        "tools": [{"name": t["name"], "description": t["description"], "input_schema": t["parameters"]} for t in TOOLS],
        "messages": messages,
    }, holder)
    text, blocks = "", {}
    for ev in _sse(resp):
        t = ev.get("type")
        if t == "content_block_start" and ev["content_block"]["type"] == "tool_use":
            blocks[ev["index"]] = {"id": ev["content_block"]["id"], "name": ev["content_block"]["name"], "json": ""}
        elif t == "content_block_delta":
            d = ev["delta"]
            if d["type"] == "text_delta":
                text += d["text"]
                on_text(d["text"])
            elif d["type"] == "input_json_delta":
                blocks[ev["index"]]["json"] += d["partial_json"]
        elif t == "error":
            raise HTTPError(ev.get("error", {}).get("message", "stream error"))
    calls = [{"id": b["id"], "name": b["name"], "args": json.loads(b["json"]) if b["json"] else {}} for b in blocks.values()]
    return text, calls, None


def call_openai_compat(provider, key, model, system, history, on_text, holder):
    messages: list[dict] = [{"role": "system", "content": system}]
    for h in history:
        if h["role"] == "user":
            messages.append({"role": "user", "content": h["text"]})
        elif h["role"] == "assistant":
            m: dict[str, Any] = {"role": "assistant", "content": h["text"] or None}
            if h["calls"]:
                m["tool_calls"] = [{"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": json.dumps(c["args"])}} for c in h["calls"]]
            messages.append(m)
        else:
            messages.append({"role": "tool", "tool_call_id": h["id"], "content": h["result"]})
    headers = {"authorization": f"Bearer {key}"}
    if provider == "openrouter":
        headers.update({"HTTP-Referer": "https://github.com/cnano", "X-Title": "cnano"})
    resp = _request(f"{OPENAI_COMPAT[provider]}/chat/completions", headers, {
        "model": model, "stream": True, "messages": messages,
        "tools": [{"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["parameters"]}} for t in TOOLS],
    }, holder)
    text, calls = "", {}
    for ev in _sse(resp):
        if ev.get("error"):
            raise HTTPError(ev["error"].get("message", json.dumps(ev["error"])))
        choices = ev.get("choices") or []
        if not choices:
            continue
        d = choices[0].get("delta") or {}
        if d.get("content"):
            text += d["content"]
            on_text(d["content"])
        for tc in d.get("tool_calls") or []:
            c = calls.setdefault(tc.get("index", len(calls)), {"id": "", "name": "", "json": ""})
            c["id"] = tc.get("id") or c["id"]
            fn = tc.get("function") or {}
            c["name"] += fn.get("name") or ""
            c["json"] += fn.get("arguments") or ""
    out = [{"id": c["id"] or f"call_{time.time_ns()}_{i}", "name": c["name"], "args": json.loads(c["json"]) if c["json"] else {}}
           for i, c in sorted(calls.items())]
    return text, out, None


def call_gemini(key, model, system, history, on_text, holder):
    contents: list[dict] = []
    for h in history:
        if h["role"] == "user":
            contents.append({"role": "user", "parts": [{"text": h["text"]}]})
        elif h["role"] == "assistant":
            # Replay raw parts so thought signatures survive across tool turns.
            parts = h.get("raw") or ([{"text": h["text"]}] if h["text"] else []) + \
                [{"functionCall": {"name": c["name"], "args": c["args"]}} for c in h["calls"]]
            contents.append({"role": "model", "parts": parts})
        else:
            part = {"functionResponse": {"name": h["name"], "response": {"result": h["result"]}}}
            last = contents[-1] if contents else None
            if last and last["role"] == "user" and "functionResponse" in last["parts"][0]:
                last["parts"].append(part)
            else:
                contents.append({"role": "user", "parts": [part]})
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{urllib.request.quote(model)}:streamGenerateContent?alt=sse"
    resp = _request(url, {"x-goog-api-key": key}, {
        "systemInstruction": {"parts": [{"text": system}]}, "contents": contents,
        "tools": [{"functionDeclarations": [{"name": t["name"], "description": t["description"], "parameters": t["parameters"]} for t in TOOLS]}],
    }, holder)
    text, raw, calls = "", [], []
    for ev in _sse(resp):
        if ev.get("error"):
            raise HTTPError(ev["error"].get("message", "error"))
        for part in ((ev.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []:
            raw.append(part)
            if part.get("text") and not part.get("thought"):
                text += part["text"]
                on_text(part["text"])
            if part.get("functionCall"):
                calls.append({"id": f"g_{time.time_ns()}_{len(calls)}", "name": part["functionCall"]["name"],
                              "args": part["functionCall"].get("args") or {}})
    return text, calls, raw


def list_models(provider: str) -> list[str]:
    if provider == "claude-cli":
        return CLAUDE_CLI_MODELS
    key = get_key(provider)
    if not key:
        raise HTTPError("No API key set for this provider.")
    if provider == "anthropic":
        data = json.load(_request("https://api.anthropic.com/v1/models?limit=100", {"x-api-key": key, "anthropic-version": "2023-06-01"}, None))
        return [m["id"] for m in data["data"]]
    if provider == "gemini":
        data = json.load(_request("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {"x-goog-api-key": key}, None))
        return [m["name"].removeprefix("models/") for m in data["models"] if "generateContent" in m.get("supportedGenerationMethods", [])]
    data = json.load(_request(f"{OPENAI_COMPAT[provider]}/models", {"authorization": f"Bearer {key}"}, None))
    ids = [m["id"] for m in data["data"]]
    if provider == "openai":
        ids = [i for i in ids if re.match(r"^(gpt|o\d|chatgpt|codex)", i) and not re.search(r"audio|realtime|tts|transcribe|image|search", i)]
    return sorted(ids)


# ---------------------------------------------------------------- sessions
def system_prompt(root: Path) -> str:
    return f"""You are cnano's coding agent, embedded in a terminal code editor. The user mostly writes C, C++, Assembly and shell scripts (bash/sh), sometimes Rust and Python.
Workspace root: {root}
Platform: {os.uname().sysname}. Today: {date.today().isoformat()}.

Work like a careful senior engineer:
- Explore with list_files / search / read_file before changing code. Never guess file contents.
- Make focused changes with edit_file; use write_file for new files.
- After changing code, build or test with run_command when that's possible (e.g. make, gcc -Wall -Wextra, cargo build, shellcheck).
- Keep answers concise. Use Markdown; put code in fenced blocks with a language tag.
- Paths are relative to the workspace root."""


@dataclass
class AgentSession:
    """One chat. `run()` is called from a worker thread; `emit` must be thread-safe."""
    root: Path
    history: list[dict] = field(default_factory=list)
    claude_session: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
    _holder: dict = field(default_factory=dict)
    _proc: subprocess.Popen | None = None
    _approvals: dict = field(default_factory=dict)

    def stop(self) -> None:
        self.cancel.set()
        for ev in list(self._approvals.values()):
            ev["answer"] = False
            ev["event"].set()
        resp = self._holder.pop("resp", None)
        if resp is not None:
            try:
                resp.close()
            except Exception:
                pass
        if self._proc and self._proc.poll() is None:
            self._proc.terminate()

    def answer(self, approval_id: str, ok: bool) -> None:
        entry = self._approvals.get(approval_id)
        if entry:
            entry["answer"] = ok
            entry["event"].set()

    def run(self, provider: str, model: str, text: str, emit: Callable[[dict], None], auto: dict, claude_mode: str) -> None:
        self.cancel.clear()
        try:
            if provider == "claude-cli":
                self._run_claude(model, text, emit, claude_mode)
            else:
                try:
                    self._run_api(provider, model, text, emit, auto)
                finally:
                    self._repair_history()
            emit({"type": "done", "aborted": self.cancel.is_set()})
        except Exception as e:  # noqa: BLE001 — surfaced to the user verbatim
            if self.cancel.is_set():
                emit({"type": "done", "aborted": True})
            else:
                emit({"type": "error", "message": str(e)})
                emit({"type": "done", "aborted": False})

    # Every tool call must be answered before the next request, or providers reject the history.
    def _repair_history(self) -> None:
        answered = {h["id"] for h in self.history if h["role"] == "tool"}
        for i in range(len(self.history) - 1, -1, -1):
            h = self.history[i]
            if h["role"] != "assistant":
                continue
            missing = [c for c in h["calls"] if c["id"] not in answered]
            insert_at = i + 1 + len(h["calls"]) - len(missing)
            self.history[insert_at:insert_at] = [{"role": "tool", "id": c["id"], "name": c["name"], "result": "Cancelled by user.", "error": True} for c in missing]
            break

    def _run_api(self, provider, model, text, emit, auto) -> None:
        key = get_key(provider)
        if not key:
            raise HTTPError(f"No API key for {PROVIDERS[provider]['label']}. F1 › Agent: Set API Key…")
        self.history.append({"role": "user", "text": text})
        system = system_prompt(self.root)
        for _ in range(MAX_STEPS):
            if self.cancel.is_set():
                return
            on_text = lambda t: emit({"type": "text", "text": t})  # noqa: E731
            if provider == "anthropic":
                reply, calls, raw = call_anthropic(key, model, system, self.history, on_text, self._holder)
            elif provider == "gemini":
                reply, calls, raw = call_gemini(key, model, system, self.history, on_text, self._holder)
            else:
                reply, calls, raw = call_openai_compat(provider, key, model, system, self.history, on_text, self._holder)
            self.history.append({"role": "assistant", "text": reply, "calls": calls, "raw": raw})
            if not calls:
                return
            for tc in calls:
                emit({"type": "tool_call", "id": tc["id"], "name": tc["name"], "args": tc["args"]})
                kind = NEEDS_APPROVAL.get(tc["name"])
                approved = True
                if kind and not auto.get(kind):
                    before = ""
                    if tc["name"] in ("edit_file", "write_file"):
                        try:
                            before = (self.root / tc["args"].get("path", "")).read_text(errors="replace")
                        except OSError:
                            pass
                    aid = f"{tc['id']}_a"
                    entry = {"event": threading.Event(), "answer": False}
                    self._approvals[aid] = entry
                    emit({"type": "approval", "id": tc["id"], "approval_id": aid, "name": tc["name"], "args": tc["args"], "before": before})
                    entry["event"].wait()
                    self._approvals.pop(aid, None)
                    approved = entry["answer"]
                error = False
                if self.cancel.is_set():
                    result, error = "Cancelled by user.", True
                elif not approved:
                    result, error = "The user declined this action. Ask them how to proceed or try a different approach.", True
                else:
                    try:
                        result = run_tool(tc["name"], tc["args"] or {}, self.root, emit, self.cancel)
                    except Exception as e:  # noqa: BLE001
                        result, error = f"Error: {e}", True
                self.history.append({"role": "tool", "id": tc["id"], "name": tc["name"], "result": result, "error": error})
                emit({"type": "tool_result", "id": tc["id"], "result": result, "error": error, "declined": not approved})
        emit({"type": "text", "text": f"\n\n_Stopped after {MAX_STEPS} steps._"})

    def _run_claude(self, model, text, emit, mode) -> None:
        args = ["claude", "-p", text, "--output-format", "stream-json", "--verbose", "--include-partial-messages",
                "--permission-mode", mode or "acceptEdits"]
        if model and model != "default":
            args += ["--model", model]
        if self.claude_session:
            args += ["--resume", self.claude_session]
        try:
            self._proc = subprocess.Popen(args, cwd=self.root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                          stderr=subprocess.PIPE, text=True, errors="replace")
        except FileNotFoundError:
            raise HTTPError("Could not start `claude`. Is Claude Code installed and on PATH?") from None
        tool_inputs: dict[str, dict] = {}
        result_seen = False
        assert self._proc.stdout
        for line in self._proc.stdout:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("session_id"):
                self.claude_session = ev["session_id"]
            if ev.get("parent_tool_use_id"):
                continue  # sub-agent chatter
            t = ev.get("type")
            if t == "stream_event":
                e = ev["event"]
                if e.get("type") == "content_block_delta" and e["delta"].get("type") == "text_delta":
                    emit({"type": "text", "text": e["delta"]["text"]})
                elif e.get("type") == "message_start":
                    emit({"type": "step_start"})
            elif t == "assistant":
                for b in ev["message"].get("content") or []:
                    if b.get("type") == "tool_use":
                        tool_inputs[b["id"]] = b
                        emit({"type": "tool_call", "id": b["id"], "name": b["name"], "args": b.get("input") or {}})
            elif t == "user":
                for b in (ev.get("message") or {}).get("content") or []:
                    if not isinstance(b, dict) or b.get("type") != "tool_result":
                        continue
                    c = b.get("content")
                    out = "\n".join(x.get("text", "") for x in c) if isinstance(c, list) else str(c or "")
                    emit({"type": "tool_result", "id": b["tool_use_id"], "result": _truncate(out), "error": bool(b.get("is_error"))})
                    tu = tool_inputs.get(b["tool_use_id"]) or {}
                    fp = (tu.get("input") or {}).get("file_path")
                    if fp and tu.get("name") in ("Edit", "Write", "MultiEdit", "NotebookEdit"):
                        emit({"type": "file_changed", "path": str((self.root / fp).resolve())})
            elif t == "result":
                result_seen = True
                emit({"type": "usage", "cost": ev.get("total_cost_usd"), "turns": ev.get("num_turns"),
                      "denials": sorted({d.get("tool_name", "?") for d in ev.get("permission_denials") or []})})
                if ev.get("is_error") and ev.get("result"):
                    emit({"type": "text", "text": f"\n\n**Error:** {ev['result']}"})
        self._proc.wait()
        if not (self.cancel.is_set() or self._proc.returncode == 0 or result_seen):
            err = self._proc.stderr.read().strip() if self._proc.stderr else ""
            raise HTTPError(err or f"claude exited with code {self._proc.returncode}")
