"""Agent side panel for cnano-tui."""

from __future__ import annotations

import time
from pathlib import Path
from typing import TYPE_CHECKING

from rich.text import Text
from textual import work
from textual.binding import Binding
from textual.command import CommandPalette, DiscoveryHit, Hit, Hits, Provider
from textual.containers import Vertical, VerticalScroll
from textual.widgets import Collapsible, Input, Label, Markdown, Static

from . import agent as backend
from .theme import ACCENT, BLUE, FG_DIM, FG_FAINT, GREEN, RED, YELLOW

if TYPE_CHECKING:
    from .app import CnanoApp

TOOL_SUMMARY = {
    "list_files": ("▤", lambda a: f"List {a.get('path', '.')}"),
    "read_file": ("▤", lambda a: f"Read {a.get('path')}"),
    "search": ("⌕", lambda a: f"Search /{a.get('pattern')}/"),
    "edit_file": ("✎", lambda a: f"Edit {a.get('path')}"),
    "write_file": ("✎", lambda a: f"Write {a.get('path')}"),
    "run_command": ("$", lambda a: a.get("command", "")),
    # Claude Code tool names
    "Read": ("▤", lambda a: f"Read {a.get('file_path')}"), "Edit": ("✎", lambda a: f"Edit {a.get('file_path')}"),
    "MultiEdit": ("✎", lambda a: f"Edit {a.get('file_path')}"), "Write": ("✎", lambda a: f"Write {a.get('file_path')}"),
    "Bash": ("$", lambda a: a.get("command", "")), "Grep": ("⌕", lambda a: f"Search /{a.get('pattern')}/"),
    "Glob": ("⌕", lambda a: f"Find {a.get('pattern')}"), "LS": ("▤", lambda a: f"List {a.get('path')}"),
    "WebFetch": ("◎", lambda a: a.get("url", "")), "WebSearch": ("◎", lambda a: a.get("query", "")),
    "TodoWrite": ("☑", lambda a: "Update plan"), "Task": ("◆", lambda a: a.get("description") or "Sub-agent"),
}


def diff_text(before: str, after: str, limit: int = 120) -> Text:
    a, b = before.split("\n"), after.split("\n")
    s = 0
    while s < len(a) and s < len(b) and a[s] == b[s]:
        s += 1
    ea, eb = len(a), len(b)
    while ea > s and eb > s and a[ea - 1] == b[eb - 1]:
        ea, eb = ea - 1, eb - 1
    rows = [(" ", l) for l in a[max(0, s - 2):s]] + [("-", l) for l in a[s:ea]] + [("+", l) for l in b[s:eb]] + [(" ", l) for l in a[ea:ea + 2]]
    out = Text()
    for sign, line in rows[:limit]:
        style = GREEN if sign == "+" else RED if sign == "-" else FG_DIM
        out.append(f"{sign} {line}\n", style=style)
    if len(rows) > limit:
        out.append("…\n", style=FG_FAINT)
    return out


class ToolCard(Collapsible):
    def __init__(self, tool_id: str, name: str, args: dict) -> None:
        icon, summarize = TOOL_SUMMARY.get(name, ("⚙", lambda a: name))
        try:
            summary = summarize(args) or name
        except Exception:
            summary = name
        self.body = Static("", classes="tool-body")
        super().__init__(self.body, title=f"{icon} {summary[:70]}  …", collapsed=True, classes="tool-card running")
        self.tool_id, self.name_, self.args = tool_id, name, args
        self.summary = f"{icon} {summary[:70]}"
        self.preview: Text | None = None

    def set_state(self, state: str, mark: str) -> None:
        self.remove_class("running", "awaiting", "ok", "error", "declined")
        self.add_class(state)
        self.title = f"{self.summary}  {mark}"


class AgentPanel(Vertical):
    BINDINGS = [
        Binding("y", "approve(True)", "Apply", show=False),
        Binding("n", "approve(False)", "Reject", show=False),
        Binding("a", "approve_always", "Always", show=False),
        Binding("escape", "stop", "Stop", show=False),
    ]

    def __init__(self, **kw) -> None:
        super().__init__(**kw)
        self.settings = backend.load_settings()
        self.session: backend.AgentSession | None = None
        self.running = False
        self.turn_text: Markdown | None = None
        self.text_buf = ""
        self._flush_pending = False
        self.cards: dict[str, ToolCard] = {}
        self.pending: dict | None = None
        self.include_context = True
        self.changed_files: set[str] = set()

    # ------------------------------------------------------------ settings
    @property
    def provider(self) -> str:
        return self.settings.get("provider", "claude-cli")

    @property
    def model(self) -> str:
        return self.settings.get("models", {}).get(self.provider) or backend.PROVIDERS[self.provider]["model"]

    def set_provider(self, p: str) -> None:
        self.settings["provider"] = p
        backend.save_settings(self.settings)
        self.update_header()

    def set_model(self, m: str) -> None:
        self.settings.setdefault("models", {})[self.provider] = m
        backend.save_settings(self.settings)
        self.update_header()

    # ------------------------------------------------------------ layout
    def compose(self):
        yield Label("", id="agent-header")
        with VerticalScroll(id="agent-log"):
            yield Static(self.empty_text(), id="agent-empty")
        yield Label("", id="agent-context")
        yield Input(placeholder="Ask the agent…  (Enter send · Esc stop)", id="agent-input")

    def on_mount(self) -> None:
        self.update_header()
        self.query_one("#agent-log").can_focus = True

    def empty_text(self) -> Text:
        t = Text(justify="center")
        t.append("\n✦\n", style=f"bold {ACCENT}")
        t.append("What are we building?\n\n", style="bold")
        t.append("The agent reads, searches and edits files\nin your project and runs commands like make.\n\n", style=FG_DIM)
        t.append("F1 › Agent: … for provider, model and keys\n", style=FG_FAINT)
        return t

    def update_header(self) -> None:
        p = self.provider
        t = Text()
        t.append(" AGENT ", style=f"bold {FG_DIM}")
        t.append(backend.PROVIDERS[p]["label"], style=ACCENT)
        t.append(f" · {self.model}", style=FG_DIM)
        if not backend.has_key(p):
            t.append("  no key", style=f"bold {YELLOW}")
        self.query_one("#agent-header", Label).update(t)

    def update_context(self, ctx: dict | None) -> None:
        label = self.query_one("#agent-context", Label)
        if not ctx:
            label.update("")
            return
        rng = f":{ctx['start']}-{ctx['end']}" if ctx.get("text") else ""
        style = ACCENT if self.include_context else f"strike {FG_FAINT}"
        label.update(Text.assemble((" ▤ ", style), (f"{ctx['name']}{rng}", style), ("  (context)" if self.include_context else "", FG_FAINT)))

    # ------------------------------------------------------------ sending
    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "agent-input":
            return
        event.stop()
        text = event.value.strip()
        if not text or self.running:
            return
        app: CnanoApp = self.app  # type: ignore[assignment]
        if not backend.has_key(self.provider):
            env = backend.PROVIDERS[self.provider]["env"]
            app.notify(f"Set a key with F1 › Agent: Set API Key…, or export {env}.", title="API key needed", severity="error")
            return
        event.input.value = ""
        self.add_user(text)
        if self.session is None or self.session.root != app.root:
            self.session = backend.AgentSession(app.root)
        prompt = text
        ctx = app.editor_context() if self.include_context else None
        if ctx:
            prompt += f"\n\n<editor_context>\nActive file: {ctx['rel']}"
            if ctx.get("text"):
                prompt += f"\nSelected lines {ctx['start']}-{ctx['end']}:\n```{ctx['lang'] or ''}\n{ctx['text']}\n```"
            else:
                prompt += f" (cursor on line {ctx['line']})"
            prompt += "\n</editor_context>"
        self.running = True
        self.turn_text = None
        self.add_class("busy")
        self.thinking = Static(Text("● ● ●", style=ACCENT), classes="thinking")
        self.query_one("#agent-log").mount(self.thinking)
        self.scroll_end()
        self._run(prompt)

    @work(thread=True, exclusive=True, group="agent")
    def _run(self, prompt: str) -> None:
        s = self.settings
        self.session.run(self.provider, self.model, prompt, lambda ev: self.app.call_from_thread(self.handle, ev),
                         s.get("auto", {}), s.get("claude_mode", "acceptEdits"))

    def action_stop(self) -> None:
        if self.running and self.session:
            self.session.stop()

    def new_chat(self) -> None:
        if self.running:
            self.action_stop()
        self.session = None
        log = self.query_one("#agent-log")
        log.remove_children()
        log.mount(Static(self.empty_text(), id="agent-empty"))
        self.query_one("#agent-input", Input).focus()

    # ------------------------------------------------------------ rendering
    def scroll_end(self) -> None:
        self.query_one("#agent-log", VerticalScroll).scroll_end(animate=False)

    def _drop_empty(self) -> None:
        for w in self.query("#agent-empty"):
            w.remove()

    def _drop_thinking(self) -> None:
        t = getattr(self, "thinking", None)
        if t is not None and t.is_mounted:
            t.remove()
        self.thinking = None

    def add_user(self, text: str) -> None:
        self._drop_empty()
        self.query_one("#agent-log").mount(Static(text, classes="msg-user"))
        self.scroll_end()

    def append_text(self, chunk: str) -> None:
        self._drop_thinking()
        if self.turn_text is None:
            self.turn_text = Markdown(classes="msg-assistant")
            self.text_buf = ""
            self.query_one("#agent-log").mount(self.turn_text)
        self.text_buf += chunk
        # Re-render Markdown at most ~12×/s while streaming.
        if not self._flush_pending:
            self._flush_pending = True
            self.set_timer(0.08, self._flush_text)

    def _flush_text(self) -> None:
        self._flush_pending = False
        if self.turn_text is not None:
            self._set_markdown(self.turn_text, self.text_buf)
            self.scroll_end()

    def end_text(self) -> None:
        if self.turn_text is not None:
            if self.text_buf.strip():
                self._set_markdown(self.turn_text, self.text_buf)
            else:
                self.turn_text.remove()
        self.turn_text = None
        self.text_buf = ""

    def _set_markdown(self, md: Markdown, text: str) -> None:
        # A short reply can finish before its Markdown widget is mounted; updating then would be lost.
        if md.is_mounted:
            md.update(text)
        else:
            md._initial_markdown = text  # rendered by Markdown's own mount handler

    def handle(self, ev: dict) -> None:
        t = ev["type"]
        log = self.query_one("#agent-log")
        if t == "text":
            self.append_text(ev["text"])
        elif t == "tool_call":
            self.end_text()
            self._drop_thinking()
            card = ToolCard(ev["id"], ev["name"], ev.get("args") or {})
            card.summary = card.summary.replace(f"{self.app.root}/", "")
            card.title = f"{card.summary}  …"
            self.cards[ev["id"]] = card
            log.mount(card)
            if ev["name"] == "TodoWrite":
                todos = (ev.get("args") or {}).get("todos") or []
                card.body.update(Text("\n".join(f"{'✓' if x.get('status') == 'completed' else '◐' if x.get('status') == 'in_progress' else '○'} {x.get('content')}" for x in todos)))
                card.collapsed = False
            self.scroll_end()
        elif t == "approval":
            card = self.cards.get(ev["id"])
            if not card:
                return
            a = ev.get("args") or {}
            if ev["name"] == "run_command":
                preview = Text(f"$ {a.get('command')}\n", style="bold")
            elif ev["name"] == "edit_file":
                before = ev.get("before") or ""
                old, new = a.get("old_string", ""), a.get("new_string", "")
                preview = diff_text(before, before.replace(old, new, 1)) if old in before else diff_text(old, new)
            else:
                preview = Text("overwrites existing file\n" if ev.get("before") else "new file\n", style=FG_FAINT) + diff_text(ev.get("before") or "", a.get("content", ""))
            hint = Text.assemble(("\n y ", f"bold #13141c on {GREEN}"), (" apply   ", ""), (" n ", f"bold #13141c on {RED}"), (" reject   ", ""),
                                 (" a ", f"bold #13141c on {ACCENT}"), (f" always allow {'commands' if ev['name'] == 'run_command' else 'edits'}", ""))
            card.preview = preview
            card.body.update(preview + hint)
            card.collapsed = False
            card.set_state("awaiting", "⏸ waiting for you")
            self.pending = ev
            self.query_one("#agent-log").focus()
            self.scroll_end()
            self.app.bell()
        elif t == "tool_result":
            card = self.cards.get(ev["id"])
            if not card:
                return
            result = ev.get("result") or ""
            body = (card.preview.copy() + Text("\n")) if card.preview else Text()
            body.append(result[:6000], style=FG_DIM if not ev.get("error") else RED)
            if card.name_ != "TodoWrite":
                card.body.update(body)
            if ev.get("declined"):
                card.set_state("declined", "✗ declined")
                card.collapsed = True
            elif ev.get("error"):
                card.set_state("error", "✗")
                card.collapsed = False
            else:
                card.set_state("ok", "✓")
                if card.name_ != "TodoWrite":
                    card.collapsed = True
        elif t == "file_changed":
            self.changed_files.add(ev["path"])
            self.set_timer(0.2, self._flush_files)
        elif t == "usage":
            self.end_text()
            parts = []
            if ev.get("turns"):
                parts.append(f"{ev['turns']} turn{'s' if ev['turns'] > 1 else ''}")
            if ev.get("cost"):
                parts.append(f"≈ ${ev['cost']:.3f} (covered by plan)")
            if ev.get("denials"):
                parts.append(f"denied: {', '.join(ev['denials'])} — F1 › Agent: Claude Permission Mode")
            if parts:
                log.mount(Static(Text(" · ".join(parts), style=FG_FAINT), classes="msg-meta"))
        elif t == "error":
            self.end_text()
            self._drop_thinking()
            log.mount(Static(Text(ev["message"], style=RED), classes="msg-error"))
            self.scroll_end()
        elif t == "done":
            self.end_text()
            self._drop_thinking()
            for card in self.cards.values():
                if card.has_class("running") or card.has_class("awaiting"):
                    card.set_state("declined", "✗ cancelled")
            if ev.get("aborted"):
                log.mount(Static(Text("Stopped.", style=FG_FAINT), classes="msg-meta"))
            self.cards.clear()
            self.pending = None
            self.running = False
            self.remove_class("busy")
            self.scroll_end()
            if self.app.focused is None or self.app.focused.id == "agent-log":
                self.query_one("#agent-input", Input).focus()

    def _flush_files(self) -> None:
        if not self.changed_files:
            return
        app: CnanoApp = self.app  # type: ignore[assignment]
        for p in self.changed_files:
            app.reload_from_disk(Path(p), notify_dirty=True)
        self.changed_files.clear()
        app.after_disk_change()

    # ------------------------------------------------------------ approvals
    def action_approve(self, ok: bool) -> None:
        ev = self.pending
        if not ev or not self.session:
            return
        self.pending = None
        card = self.cards.get(ev["id"])
        if card and card.preview is not None:
            card.body.update(card.preview)
            card.set_state("running", "…")
        self.session.answer(ev["approval_id"], ok)
        self.query_one("#agent-input", Input).focus()

    def action_approve_always(self) -> None:
        ev = self.pending
        if not ev:
            return
        kind = "commands" if ev["name"] == "run_command" else "edits"
        self.settings.setdefault("auto", {})[kind] = True
        backend.save_settings(self.settings)
        self.app.notify(f"Auto-approving {kind} from now on (F1 › Agent: Toggle Auto-approve to undo).", timeout=3)
        self.action_approve(True)

    def check_action(self, action: str, parameters) -> bool | None:
        # y / n / a only mean something while an approval is pending and the input isn't focused.
        if action in ("approve", "approve_always"):
            focused = self.app.focused
            return self.pending is not None and not isinstance(focused, Input)
        return True


# ====================================================================== palette pickers
def pick(app, items: list[tuple[str, str, object]], placeholder: str, on_pick, allow_custom: bool = False) -> None:
    """Show a palette over (label, help, value) items; on_pick(value) is called with the choice."""

    class _Picker(Provider):
        async def search(self, query: str) -> Hits:
            matcher = self.matcher(query)
            for label, help_, value in items:
                score = matcher.match(label)
                if score > 0:
                    yield Hit(score, matcher.highlight(label), lambda v=value: on_pick(v), help=help_ or None)
            if allow_custom and query.strip():
                yield Hit(0.01, f"Use “{query.strip()}”", lambda q=query.strip(): on_pick(q), help="custom value")

        async def discover(self) -> Hits:
            for label, help_, value in items:
                yield DiscoveryHit(label, lambda v=value: on_pick(v), help=help_ or None)

    app.push_screen(CommandPalette(providers=[_Picker], placeholder=placeholder))
