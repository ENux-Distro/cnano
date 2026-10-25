"""cnano-tui — the terminal edition of cnano."""

from __future__ import annotations

import argparse
import difflib
import os
import shlex
import subprocess
import sys
from pathlib import Path

from rich.segment import Segment
from rich.style import Style
from rich.text import Text
from textual import on, work
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.command import CommandPalette, DiscoveryHit, Hit, Hits, Provider
from textual.containers import Horizontal, Vertical
from textual.css.query import NoMatches
from textual.screen import ModalScreen
from textual.strip import Strip
from textual.widgets import (
    ContentSwitcher, DirectoryTree, Footer, Input, Label, ListItem, ListView, Markdown, OptionList, Static, TabbedContent,
    TabPane, TextArea,
)
from textual.widgets.option_list import Option

from . import __version__, agent as agent_backend, git
from .agent_ui import AgentPanel, pick
from .lsp import LspManager, available as lsp_available, from_utf16, to_utf16, uri_to_path
from .langs import RULES, detect, display_name, regex_highlights, tree_sitter_language
from .theme import ACCENT, APP_THEME, BG0, BLUE, EDITOR_THEME, FG_DIM, FG_FAINT, GREEN, RED, YELLOW

IGNORED_DIRS = {".git", "node_modules", "target", "build", ".cache", "__pycache__", ".venv", "dist"}
GIT_COLORS = {"M": YELLOW, "A": GREEN, "U": GREEN, "R": GREEN, "D": RED}


# ====================================================================== editor widget
class CodeArea(TextArea):
    """TextArea with cnano's languages, dirty tracking and a git gutter."""

    BINDINGS = [
        # nano: ^K cuts the line (repeats build one block); M-Bksp deletes the word to the left.
        Binding("ctrl+k", "cut_line", "Cut line", show=False),
        Binding("alt+backspace", "delete_word_left", "Delete word", show=False),
    ]
    _cut = {"text": "", "area": None, "version": None, "loc": None}  # shared cutbuffer, like nano's

    def __init__(self, path: Path | None, text: str, *, read_only: bool = False, lang: str | None = None) -> None:
        super().__init__(
            text, soft_wrap=False, tab_behavior="indent", show_line_numbers=True, read_only=read_only,
            highlight_cursor_line=True,
        )
        self.path = path
        self.saved_text = text
        self.lang = lang if lang is not None else detect(path, text.split("\n", 1)[0])
        self.regex_rules = RULES.get(self.lang or "")
        self.gutter_marks: dict[int, str] = {}
        self.diagnostics: list[dict] = []
        self.diag_lines: dict[int, int] = {}  # row -> worst severity
        self._lsp_timer = None

    def on_mount(self) -> None:
        self.register_theme(EDITOR_THEME)
        self.theme = "cnano-night"
        if self.lang in ("c", "cpp"):
            ts = tree_sitter_language(self.lang)
            if ts:
                self.register_language(self.lang, *ts)
                self.language = self.lang
        elif self.lang in self.available_languages:
            self.language = self.lang
        # Indentation conventions: hard tabs where toolchains want them, else follow the file.
        lines = self.text.splitlines()[:300]
        tabbed = sum(1 for l in lines if l.startswith("\t"))
        spaced = sum(1 for l in lines if l.startswith("  "))
        self.indent_width = 8 if self.lang in ("makefile", "asm") else 4
        self.indent_type = "tabs" if self.lang == "makefile" or tabbed > spaced else "spaces"
        if self.regex_rules:
            self._build_highlight_map()

    def action_cut_line(self) -> None:
        if self.read_only:
            return
        start, end = sorted(self.selection)
        first, last = start[0], end[0]
        if last > first and end[1] == 0:  # selection ending at column 0 doesn't include that line
            last -= 1
        lines = self.document.lines
        if last + 1 < len(lines):
            frm, to = (first, 0), (last + 1, 0)
            text = "\n".join(lines[first:last + 1]) + "\n"
        elif first > 0:  # last line: take the newline before it instead
            frm, to = (first - 1, len(lines[first - 1])), (last, len(lines[last]))
            text = "\n".join(lines[first:last + 1]) + "\n"
        else:
            frm, to = (first, 0), (last, len(lines[last]))
            text = "\n".join(lines[first:last + 1]) + "\n"
        cut = CodeArea._cut
        continuing = cut["area"] is self and cut["version"] == self.history_version() and cut["loc"] == self.cursor_location
        cut["text"] = cut["text"] + text if continuing else text
        self.delete(frm, to)
        row = min(first, self.document.line_count - 1)
        line = self.document.lines[row]
        self.cursor_location = (row, len(line) - len(line.lstrip()))
        cut["area"], cut["version"], cut["loc"] = self, self.history_version(), self.cursor_location
        self.app.copy_to_clipboard(cut["text"])

    def history_version(self) -> tuple:
        # Changes whenever the text changes; equal only if nothing happened since the last cut.
        return (self.document.line_count, hash(self.text))

    @property
    def dirty(self) -> bool:
        return not self.read_only and self.text != self.saved_text

    # Regex highlighting for languages without a tree-sitter grammar, then diagnostics on top.
    def _build_highlight_map(self) -> None:
        rules = getattr(self, "regex_rules", None)
        if not rules:
            super()._build_highlight_map()
        else:
            self._line_cache.clear()
            self._highlights.clear()
            for row, spans in regex_highlights(self.document.lines, rules).items():
                self._highlights[row].extend(spans)
        self._add_diagnostic_spans()

    def _add_diagnostic_spans(self) -> None:
        lines = self.document.lines
        for d in getattr(self, "diagnostics", []):
            name = {1: "diag.error", 2: "diag.warning"}.get(d.get("severity", 1), "diag.info")
            r = d["range"]
            for row in range(r["start"]["line"], min(r["end"]["line"], len(lines) - 1) + 1):
                if row >= len(lines):
                    break
                line = lines[row]
                start = from_utf16(line, r["start"]["character"]) if row == r["start"]["line"] else 0
                end = from_utf16(line, r["end"]["character"]) if row == r["end"]["line"] else len(line)
                if end <= start:  # zero-width: mark the token under it
                    end = min(len(line), start + 1) or len(line)
                    if end <= start:
                        continue
                self._highlights[row].append((start, end, name))

    def set_diagnostics(self, diags: list[dict]) -> None:
        self.diagnostics = diags
        self.diag_lines = {}
        for d in diags:
            row = d["range"]["start"]["line"]
            self.diag_lines[row] = min(self.diag_lines.get(row, 9), d.get("severity", 1))
        self._build_highlight_map()
        self.refresh()

    async def _on_key(self, event) -> None:
        menu = self.app.completion_menu if hasattr(self.app, "completion_menu") else None
        if menu is not None and menu.display and menu.area is self:
            if event.key in ("up", "down"):
                menu.action_cursor_up() if event.key == "up" else menu.action_cursor_down()
                event.prevent_default(); event.stop()
                return
            if event.key in ("enter", "tab"):
                self.app.accept_completion()
                event.prevent_default(); event.stop()
                return
            if event.key == "escape":
                menu.hide()
                event.prevent_default(); event.stop()
                return
        await super()._on_key(event)

    def set_gutter_marks(self, marks: dict[int, str]) -> None:
        if marks != self.gutter_marks:
            self.gutter_marks = marks
            self._line_cache.clear()
            self.refresh()

    # Paint a coloured bar in the gutter margin for changed lines.
    def _render_line(self, y: int) -> Strip:
        strip = super()._render_line(y)
        if (not self.gutter_marks and not self.diag_lines) or not self.show_line_numbers:
            return strip
        y_offset = y + self.scroll_offset.y
        try:
            line_index, section = self.wrapped_document._offset_to_line_info[y_offset]
        except (IndexError, KeyError):
            return strip
        kind = self.gutter_marks.get(line_index)
        sev = self.diag_lines.get(line_index)
        if (not kind and not sev) or section:
            return strip
        gw = self.gutter_width
        if sev:
            char, color = "●", {1: RED, 2: YELLOW}.get(sev, BLUE)
        else:
            char, color = {"added": ("▎", GREEN), "modified": ("▎", YELLOW), "deleted": ("▁", RED)}[kind]
        bg = (self._theme.cursor_line_gutter_style if line_index == self.cursor_location[0] else self._theme.gutter_style).bgcolor
        marker = Strip([Segment(char, Style(color=color, bgcolor=bg))], 1)
        return Strip.join([strip.crop(0, gw - 2), marker, strip.crop(gw - 1, strip.cell_length)])


def gutter_marks(base: str | None, current: str) -> dict[int, str]:
    cur = current.split("\n")
    if base is None:
        return {i: "added" for i in range(len(cur))}
    marks: dict[int, str] = {}
    sm = difflib.SequenceMatcher(None, base.split("\n"), cur, autojunk=False)
    for tag, _i1, _i2, j1, j2 in sm.get_opcodes():
        if tag == "insert":
            marks.update({j: "added" for j in range(j1, j2)})
        elif tag == "replace":
            marks.update({j: "modified" for j in range(j1, j2)})
        elif tag == "delete":
            marks.setdefault(max(0, j1 - 1), "deleted")
    return marks


def run_command_for(path: Path, lang: str | None) -> str | None:
    """Build + run command, chosen by language and (for assembly) by extension:
    .asm/.nasm → nasm + ld · .s → GNU as + ld · .S → gcc -c (C preprocessor) + ld"""
    q = shlex.quote
    src, base = q(str(path)), str(path.with_suffix(""))
    binary, obj = q(base), q(base + ".o")
    run = f"&& {binary}"
    if lang == "c":
        return f"gcc -Wall -Wextra -g {src} -o {binary} -lm {run}"
    if lang == "cpp":
        return f"g++ -Wall -Wextra -std=c++20 -g {src} -o {binary} {run}"
    if lang == "rust":
        return f"rustc -g {src} -o {binary} {run}"
    if lang == "python":
        return f"$(command -v python3 || command -v python) {src}"
    if lang == "bash":
        return f"bash {src}"
    if lang == "makefile":
        return f"make -C {q(str(path.parent))}"
    if lang == "asm":
        if path.suffix.lower() in (".asm", ".nasm"):
            return f"nasm -f elf64 -g {src} -o {obj} && ld {obj} -o {binary} {run}"
        if path.suffix == ".S":
            return f"gcc -c -g {src} -o {obj} && ld {obj} -o {binary} {run}"
        return f"as -g {src} -o {obj} && ld {obj} -o {binary} {run}"
    return None


COMPLETION_KINDS = {1: "txt", 2: "meth", 3: "fn", 4: "ctor", 5: "fld", 6: "var", 7: "cls", 8: "ifc", 9: "mod", 10: "prop",
                    11: "unit", 12: "val", 13: "enum", 14: "kw", 15: "snip", 17: "file", 20: "enum", 21: "const",
                    22: "struct", 23: "evt", 24: "op", 25: "type"}


class CompletionMenu(OptionList):
    """Dropdown at the cursor. Keys are routed here from CodeArea while it's open."""

    can_focus = False

    def __init__(self) -> None:
        super().__init__(id="completion")
        self.display = False
        self.items: list[dict] = []
        self.area: CodeArea | None = None
        self.anchor: tuple[int, int] = (0, 0)  # (row, col) where the word being completed starts

    def show(self, area: CodeArea, items: list[dict], anchor: tuple[int, int]) -> None:
        self.area, self.anchor, self.all_items = area, anchor, items
        self.refilter()

    def refilter(self) -> None:
        area = self.area
        if area is None:
            return
        row, col = area.cursor_location
        if row != self.anchor[0] or col < self.anchor[1]:
            self.hide()
            return
        prefix = area.document.lines[row][self.anchor[1]:col].lower()
        items = [it for it in self.all_items if (it.get("filterText") or it["label"]).strip().lower().startswith(prefix)]
        if not items and prefix:
            items = [it for it in self.all_items if prefix in (it.get("filterText") or it["label"]).lower()]
        items.sort(key=lambda it: it.get("sortText") or it["label"])
        self.items = items[:80]
        if not self.items:
            self.hide()
            return
        self.clear_options()
        width = 0
        for it in self.items:
            label = Text(it["label"].strip()[:48])
            label.append(f"  {COMPLETION_KINDS.get(it.get('kind'), '')}", style=FG_FAINT)
            if it.get("detail"):
                label.append(f"  {it['detail'].strip()[:40]}", style=FG_DIM)
            width = max(width, label.cell_len)
            self.add_option(Option(label))
        self.highlighted = 0
        x, y = area.cursor_screen_offset
        screen_w, screen_h = self.app.size
        height = min(len(self.items), 10) + 2
        self.styles.width = min(width + 4, 80)
        self.styles.height = height
        top = y + 1 if y + 1 + height <= screen_h - 2 else max(0, y - height)
        self.styles.offset = (max(0, min(x - (col - self.anchor[1]) - 1, screen_w - width - 6)), top)
        self.display = True

    def hide(self) -> None:
        self.display = False
        self.items = []

    def selected(self) -> dict | None:
        i = self.highlighted
        return self.items[i] if i is not None and 0 <= i < len(self.items) else None


class HoverScreen(ModalScreen[None]):
    BINDINGS = [Binding("escape,q,f6", "dismiss_hover", "Close")]

    def __init__(self, text: str) -> None:
        super().__init__()
        self.text = text

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog hover"):
            yield Markdown(self.text)

    def action_dismiss_hover(self) -> None:
        self.dismiss(None)

    def on_click(self) -> None:
        self.dismiss(None)


def hover_markdown(contents) -> str:
    if contents is None:
        return ""
    if isinstance(contents, str):
        return contents
    if isinstance(contents, list):
        return "\n\n".join(filter(None, (hover_markdown(c) for c in contents)))
    if "kind" in contents:
        return contents["value"] if contents["kind"] == "markdown" else f"```\n{contents['value']}\n```"
    if "language" in contents:
        return f"```{contents['language']}\n{contents['value']}\n```"
    return ""


class EditorPane(TabPane):
    def __init__(self, area: CodeArea, pane_id: str, title: str) -> None:
        super().__init__(title, id=pane_id)
        self.area = area
        self.preview = Markdown(classes="preview")
        self.preview.display = False

    def compose(self) -> ComposeResult:
        with Horizontal():
            yield self.area
            yield self.preview


# ====================================================================== sidebar
class ExplorerTree(DirectoryTree):
    def __init__(self, path: Path, **kw) -> None:
        super().__init__(path, **kw)
        self.marks: dict[Path, str] = {}

    def filter_paths(self, paths):
        return [p for p in paths if p.name != ".git"]

    def render_label(self, node, base_style, style):
        label = super().render_label(node, base_style, style)
        path = node.data.path if node.data else None
        mark = self.marks.get(path) if path else None
        if mark:
            label.stylize(GIT_COLORS.get(mark, YELLOW))
            if not node.allow_expand:
                label.append(f"  {mark}", style=f"bold {GIT_COLORS.get(mark, YELLOW)}")
        return label


class GitPanel(Vertical):
    BINDINGS = [
        Binding("s", "toggle_stage", "Stage/Unstage"),
        Binding("a", "stage_all", "Stage all"),
        Binding("u", "unstage_all", "Unstage all", show=False),
        Binding("x", "discard", "Discard"),
        Binding("c", "focus_commit", "Commit"),
        Binding("p", "app.git_push", "Push"),
        Binding("l", "app.git_pull", "Pull"),
        Binding("b", "app.git_branch", "Branch", show=False),
        Binding("r", "app.refresh_git", "Refresh", show=False),
    ]

    def compose(self) -> ComposeResult:
        yield Label("", id="git-branch")
        yield Input(placeholder="Commit message…", id="commit-msg")
        yield ListView(id="git-list")
        yield Label("HISTORY", classes="section-title")
        yield Static("", id="git-log")

    def selected_change(self):
        lv = self.query_one("#git-list", ListView)
        item = lv.highlighted_child
        return getattr(item, "change", None), getattr(item, "kind", None)

    def action_focus_commit(self) -> None:
        self.query_one("#commit-msg", Input).focus()

    async def action_toggle_stage(self) -> None:
        change, kind = self.selected_change()
        if not change:
            return
        args = ("restore", "--staged", "--", change.path) if kind == "staged" else ("add", "--", change.path)
        await self.app.git_op(*args, quiet=True)

    async def action_stage_all(self) -> None:
        await self.app.git_op("add", "-A", quiet=True)

    async def action_unstage_all(self) -> None:
        await self.app.git_op("reset", "-q", quiet=True)

    @work
    async def action_discard(self) -> None:
        change, kind = self.selected_change()
        if not change or kind != "changes":
            return
        untracked = change.status == "U"
        q = f"Delete untracked file {change.path}?" if untracked else f"Discard changes in {change.path}?"
        if await self.app.push_screen_wait(ChoiceScreen(q, [("y", "Yes, discard"), ("n", "Cancel")])) != "y":
            return
        await self.app.git_op(*(("clean", "-f", "--") if untracked else ("restore", "--")), change.path, quiet=True)
        self.app.reload_from_disk(self.app.git.root / change.path)


# ====================================================================== dialogs
class PromptScreen(ModalScreen[str | None]):
    BINDINGS = [Binding("escape", "cancel", "Cancel")]

    def __init__(self, title: str, value: str = "", placeholder: str = "") -> None:
        super().__init__()
        self.title_text, self.value, self.placeholder = title, value, placeholder

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Label(self.title_text, classes="dialog-title")
            yield Input(self.value, placeholder=self.placeholder)

    def on_input_submitted(self, event: Input.Submitted) -> None:
        self.dismiss(event.value)

    def action_cancel(self) -> None:
        self.dismiss(None)


class ChoiceScreen(ModalScreen[str]):
    """A question with single-key answers, e.g. [(s) Save] [(d) Don't save] [(esc) Cancel]."""

    def __init__(self, question: str, choices: list[tuple[str, str]]) -> None:
        super().__init__()
        self.question, self.choices = question, choices

    def compose(self) -> ComposeResult:
        with Vertical(classes="dialog"):
            yield Label(self.question, classes="dialog-title")
            yield Static(Text.assemble(*[t for key, label in self.choices
                                         for t in ((f" {key} ", f"bold {BG0} on {ACCENT}"), (f" {label}    ", ""))]))

    def on_key(self, event) -> None:
        keys = [k for k, _ in self.choices]
        if event.key in keys:
            self.dismiss(event.key)
        elif event.key == "escape":
            self.dismiss(keys[-1])
        event.stop()


# ====================================================================== palette providers
class FileProvider(Provider):
    async def search(self, query: str) -> Hits:
        app: CnanoApp = self.app  # type: ignore[assignment]
        matcher = self.matcher(query)
        for rel in app.project_files():
            score = matcher.match(rel)
            if score > 0:
                yield Hit(score, matcher.highlight(rel), lambda r=rel: app.open_file(app.root / r), help=None)

    async def discover(self) -> Hits:
        app: CnanoApp = self.app  # type: ignore[assignment]
        for rel in app.project_files()[:60]:
            yield DiscoveryHit(rel, lambda r=rel: app.open_file(app.root / r))


class CommandsProvider(Provider):
    COMMANDS = [
        ("File: Save", "save"), ("File: Save All", "save_all"), ("File: New File…", "new_file"),
        ("File: Open Folder / File…", "open_path"), ("File: Rename Current…", "rename_file"),
        ("File: Delete Current…", "delete_file"), ("Editor: Close Tab", "close_tab"),
        ("Editor: Go to Line…", "goto_line"), ("Editor: Find", "find"), ("Editor: Find & Replace", "replace"),
        ("Editor: Replace All", "replace_all"), ("Editor: Toggle Word Wrap", "toggle_wrap"),
        ("Markdown: Toggle Preview", "toggle_preview"), ("View: Toggle Sidebar", "toggle_sidebar"),
        ("View: Explorer", "show_explorer"), ("View: Source Control", "show_git"),
        ("Run: Compile & Run Current File", "run_file"), ("Shell: Drop to Shell", "shell"),
        ("Git: Refresh", "refresh_git"), ("Git: Commit…", "git_commit_prompt"), ("Git: Push", "git_push"),
        ("Git: Pull", "git_pull"), ("Git: Fetch", "git_fetch"), ("Git: Checkout / New Branch…", "git_branch"),
        ("Git: Clone…", "git_clone"), ("Git: Init", "git_init"), ("Git: Show Diff of Current File", "git_diff_current"),
        ("Git: Amend Last Commit", "git_amend"), ("Git: Stash", "git_stash"), ("Git: Stash Pop", "git_stash_pop"),
        ("Agent: Toggle Panel", "toggle_agent"), ("Agent: New Chat", "agent_new"),
        ("Agent: Choose Provider…", "agent_provider"), ("Agent: Choose Model…", "agent_model"),
        ("Agent: Set API Key…", "agent_key"), ("Agent: Toggle Auto-approve Edits", "agent_auto('edits')"),
        ("Agent: Toggle Auto-approve Commands", "agent_auto('commands')"),
        ("Agent: Claude Permission Mode…", "agent_claude_mode"), ("Agent: Toggle Editor Context", "agent_context"),
        ("LSP: Go to Definition", "lsp_definition"), ("LSP: Find References", "lsp_references"),
        ("LSP: Hover Info", "lsp_hover"), ("LSP: Go to Symbol in File", "lsp_symbols"), ("LSP: Next Problem", "next_problem"),
        ("LSP: Quick Fix…", "lsp_quickfix"), ("LSP: Rename Symbol…", "lsp_rename"), ("LSP: Format Document", "lsp_format"),
        ("LSP: Trigger Completion", "complete"), ("LSP: Restart Servers", "lsp_restart"), ("LSP: Server Status", "lsp_status"),
        ("App: Quit", "quit"),
    ]

    async def search(self, query: str) -> Hits:
        matcher = self.matcher(query)
        for label, action in self.COMMANDS:
            score = matcher.match(label)
            if score > 0:
                yield Hit(score, matcher.highlight(label), lambda a=action: self.app.run_action(a))

    async def discover(self) -> Hits:
        for label, action in self.COMMANDS:
            yield DiscoveryHit(label, lambda a=action: self.app.run_action(a))


# ====================================================================== app
class CnanoApp(App):
    CSS_PATH = "cnano.tcss"
    TITLE = "cnano"
    COMMAND_PALETTE_BINDING = "f1"
    COMMANDS = {CommandsProvider}
    BINDINGS = [
        Binding("ctrl+s", "save", "Save", priority=True),
        Binding("ctrl+q", "quit", "Quit", priority=True),
        Binding("ctrl+p", "quick_open", "Files", priority=True),
        Binding("f1", "command_palette", "Commands", priority=True),
        Binding("ctrl+f", "find", "Find", priority=True),
        Binding("ctrl+r", "replace", "Replace", show=False, priority=True),
        Binding("ctrl+g", "goto_line", "Go to", priority=True),
        Binding("ctrl+w", "close_tab", "Close", priority=True),
        Binding("ctrl+n", "new_file", "New", show=False, priority=True),
        Binding("ctrl+o", "open_path", "Open", show=False, priority=True),
        Binding("ctrl+b", "toggle_sidebar", "Sidebar", show=False, priority=True),
        Binding("f2", "show_git", "Git", priority=True),
        Binding("f3", "toggle_preview", "Preview", priority=True),
        Binding("f4", "show_explorer", "Explorer", show=False, priority=True),
        # Super+C needs a terminal speaking the kitty keyboard protocol (kitty, foot, WezTerm, Ghostty…); F5 works everywhere.
        Binding("super+c,f5", "run_file", "Run", key_display="⊞C/F5", priority=True),
        Binding("f9", "shell", "Shell", priority=True),
        Binding("ctrl+l", "toggle_agent", "Agent", priority=True),
        Binding("ctrl+space,ctrl+@", "complete", "Complete", show=False, priority=True),
        Binding("f6", "lsp_hover", "Hover", show=False, priority=True),
        Binding("f7", "lsp_symbols", "Symbols", show=False, priority=True),
        Binding("f8", "next_problem", "Next problem", show=False, priority=True),
        Binding("f12", "lsp_definition", "Definition", show=False, priority=True),
        Binding("shift+f12", "lsp_references", "References", show=False, priority=True),
        Binding("alt+enter", "lsp_quickfix", "Quick fix", show=False, priority=True),
        Binding("alt+z", "toggle_wrap", "Wrap", show=False, priority=True),
        Binding("ctrl+pagedown,alt+right", "next_tab", "Next tab", show=False, priority=True),
        Binding("ctrl+pageup,alt+left", "prev_tab", "Prev tab", show=False, priority=True),
        Binding("escape", "escape", show=False),
    ]

    def __init__(self, root: Path, files: list[Path]) -> None:
        super().__init__()
        self.root = root
        self.initial_files = files
        self.git = git.Status()
        self.tab_seq = 0
        self._files_cache: list[str] | None = None
        self._gutter_base: dict[str, str | None] = {}
        self.lsp = LspManager(self._on_diagnostics, self._on_lsp_status)
        self.lsp_status: dict[str, str] = {}

    # ------------------------------------------------------------ layout
    def compose(self) -> ComposeResult:
        yield Static(id="titlebar")
        with Horizontal(id="workbench"):
            with ContentSwitcher(initial="explorer", id="sidebar"):
                with Vertical(id="explorer"):
                    yield Label(self.root.name.upper() or "/", classes="section-title")
                    yield ExplorerTree(self.root, id="tree")
                yield GitPanel(id="git")
            with Vertical(id="main"):
                yield Static(self.welcome_text(), id="welcome")
                yield TabbedContent(id="tabs")
                with Horizontal(id="findbar"):
                    yield Input(placeholder="Find (Enter: next)", id="find")
                    yield Input(placeholder="Replace (Enter: replace & next)", id="replace")
            yield AgentPanel(id="agent")
        with Horizontal(id="statusbar"):
            yield Static("", id="sb-left")
            yield Static("", id="sb-right")
        yield Footer(compact=True, show_command_palette=False)
        yield CompletionMenu()

    def welcome_text(self) -> Text:
        t = Text(justify="center")
        t.append("\n\n\nc", style=f"{FG_DIM}")
        t.append("nano", style=f"bold {ACCENT}")
        t.append("  tui\n", style=FG_FAINT)
        t.append("a calm place to write code\n\n", style=FG_DIM)
        for key, desc in [("Ctrl+P", "go to file"), ("F1", "all commands"), ("Ctrl+N", "new file"),
                          ("F2", "source control"), ("Super+C", "compile & run"), ("F9", "drop to shell"), ("Ctrl+Q", "quit")]:
            t.append(f" {key:>7} ", style=f"bold {ACCENT}")
            t.append(f" {desc:<16}\n", style=FG_DIM)
        return t

    # App.query*() searches the *top* screen; background updates (git poll, diagnostics) must
    # still find the editor widgets while a dialog or the palette is open.
    def query_one(self, *args, **kwargs):
        return self.screen_stack[0].query_one(*args, **kwargs) if self.screen_stack else super().query_one(*args, **kwargs)

    def query(self, *args, **kwargs):
        return self.screen_stack[0].query(*args, **kwargs) if self.screen_stack else super().query(*args, **kwargs)

    @property
    def completion_menu(self) -> CompletionMenu:
        return self.query_one(CompletionMenu)

    async def on_unmount(self) -> None:
        await self.lsp.stop_all()

    async def on_mount(self) -> None:
        self.register_theme(APP_THEME)
        self.theme = "cnano-night"
        self.query_one("#findbar").display = False
        self.query_one("#tabs").display = False
        panel = self.query_one(AgentPanel)
        panel.display = bool(panel.settings.get("open"))
        for f in self.initial_files:
            await self.open_file(f)
        await self.refresh_git()
        self.set_interval(5, self.refresh_git)
        self.update_chrome()

    # ------------------------------------------------------------ helpers
    @property
    def tabs(self) -> TabbedContent:
        return self.query_one("#tabs", TabbedContent)

    def panes(self) -> list[EditorPane]:
        return list(self.query(EditorPane))

    def active_pane(self) -> EditorPane | None:
        pane = self.tabs.active_pane
        return pane if isinstance(pane, EditorPane) else None

    def active_area(self) -> CodeArea | None:
        pane = self.active_pane()
        return pane.area if pane else None

    def rel(self, p: Path) -> str:
        try:
            return str(p.relative_to(self.root))
        except ValueError:
            return str(p)

    def project_files(self) -> list[str]:
        if self._files_cache is None:
            out: list[str] = []
            for dirpath, dirnames, filenames in os.walk(self.root):
                dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS)
                for f in sorted(filenames):
                    out.append(os.path.relpath(os.path.join(dirpath, f), self.root))
                    if len(out) > 20000:
                        break
            self._files_cache = out
        return self._files_cache

    def tab_title(self, pane: EditorPane) -> str:
        a = pane.area
        name = a.path.name if a.path else "untitled"
        if a.read_only and a.lang == "diff":
            name += " (diff)"
        return ("● " if a.dirty else "") + name

    def update_chrome(self) -> None:
        a = self.active_area()
        has_tabs = bool(self.panes())
        self.query_one("#welcome").display = not has_tabs
        self.tabs.display = has_tabs
        folder = self.root.name
        title = Text()
        title.append(" c", style=FG_DIM)
        title.append("nano ", style=f"bold {ACCENT}")
        title.append(" " + " — ".join(x for x in [(("● " if a and a.dirty else "") + a.path.name) if a and a.path else None, folder] if x), style=FG_DIM)
        self.query_one("#titlebar", Static).update(title)
        left = Text()
        g = self.git
        if g.repo:
            left.append(f"  {g.branch or 'detached'}{'*' if g.staged or g.unstaged else ''} ", style=f"bold {ACCENT}")
            left.append(f" {g.behind}↓ {g.ahead}↑ " if g.upstream else " unpublished ", style=FG_DIM)
        self.query_one("#sb-left", Static).update(left)
        right = Text(style=FG_DIM)
        if a:
            row, col = a.cursor_location
            srv = self.lsp.server_for(a.path) if a.path else None
            if srv:
                errors = sum(1 for d in a.diagnostics if d.get("severity", 1) == 1)
                warnings = sum(1 for d in a.diagnostics if d.get("severity") == 2)
                right.append(f"⊗ {errors} ", style=RED if errors else FG_DIM)
                right.append(f"⚠ {warnings}   ", style=YELLOW if warnings else FG_DIM)
                st = self.lsp_status.get(srv.name, "ready")
                dot = GREEN if st == "ready" else YELLOW if st.startswith(("busy", "starting")) else RED
                right.append("● ", style=dot)
                right.append(f"{srv.name}   ")
            here = [d for d in a.diagnostics if d["range"]["start"]["line"] <= row <= d["range"]["end"]["line"]]
            if here:
                d = min(here, key=lambda d: d.get("severity", 1))
                left.append("  " + d["message"].split("\n")[0][:100], style=RED if d.get("severity", 1) == 1 else YELLOW)
                self.query_one("#sb-left", Static).update(left)
            right.append(f"Ln {row + 1}, Col {col + 1}   ")
            right.append(f"{'Tab' if a.indent_type == 'tabs' else 'Spaces'}: {a.indent_width}   ")
            right.append(display_name(a.lang) + " ")
        self.query_one("#sb-right", Static).update(right)

    # ------------------------------------------------------------ files
    async def open_file(self, path: Path, line: int | None = None) -> None:
        path = path.resolve()
        for pane in self.panes():
            if pane.area.path == path and not pane.area.read_only:
                self.tabs.active = pane.id
                pane.area.focus()
                if line:
                    pane.area.cursor_location = (line - 1, 0)
                return
        try:
            raw = path.read_bytes() if path.exists() else b""
        except OSError as e:
            self.notify(str(e), title="Can't open file", severity="error")
            return
        if b"\0" in raw[:8192]:
            self.notify(f"{path.name} looks binary.", severity="warning")
            return
        area = CodeArea(path, raw.decode("utf-8", errors="replace"))
        await self._add_pane(area)
        if line:
            area.cursor_location = (line - 1, 0)
            area.scroll_cursor_visible(center=True)
        self.update_gutter()
        self.run_worker(self._lsp_open(area))

    async def _lsp_open(self, area: CodeArea) -> None:
        if area.path is None or area.read_only:
            return
        srv = await self.lsp.open(self.root, area.path, area.lang, area.text)
        if srv and area.path in self.lsp.diagnostics:
            area.set_diagnostics(self.lsp.diagnostics[area.path])
        self.update_chrome()

    async def _add_pane(self, area: CodeArea) -> EditorPane:
        self.tab_seq += 1
        pane = EditorPane(area, f"t{self.tab_seq}", "")
        await self.tabs.add_pane(pane)
        self.tabs.active = pane.id
        self.refresh_tab_label(pane)
        self.update_chrome()
        area.focus()
        return pane

    def refresh_tab_label(self, pane: EditorPane) -> None:
        try:
            self.tabs.get_tab(pane.id).label = self.tab_title(pane)
        except Exception:
            pass

    def save_area(self, area: CodeArea) -> bool:
        if area.read_only or area.path is None:
            return False
        try:
            area.path.parent.mkdir(parents=True, exist_ok=True)
            area.path.write_text(area.text, encoding="utf-8")
        except OSError as e:
            self.notify(str(e), title="Save failed", severity="error")
            return False
        area.saved_text = area.text
        self.lsp.save(area.path, area.text)
        for pane in self.panes():
            if pane.area is area:
                self.refresh_tab_label(pane)
        self.update_chrome()
        return True

    def reload_from_disk(self, path: Path, notify_dirty: bool = False) -> None:
        for pane in self.panes():
            a = pane.area
            if notify_dirty and a.path == path.resolve() and a.dirty:
                self.notify(f"{path.name} changed on disk but has unsaved edits; not reloaded.", severity="warning")
            if a.path == path.resolve() and not a.dirty and not a.read_only:
                try:
                    text = path.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                if text != a.text:
                    loc = a.cursor_location
                    a.load_text(text)
                    a.saved_text = text
                    a.cursor_location = (min(loc[0], a.document.line_count - 1), loc[1])

    # ------------------------------------------------------------ events
    @on(TextArea.Changed)
    def _changed(self, event: TextArea.Changed) -> None:
        area = event.text_area
        if isinstance(area, CodeArea) and area.path and self.lsp.server_for(area.path):
            if area._lsp_timer:
                area._lsp_timer.stop()
            area._lsp_timer = self.set_timer(0.2, lambda a=area: self.lsp.change(a.path, a.text))
            menu = self.completion_menu
            if menu.display and menu.area is area:
                menu.refilter()
            else:
                row, col = area.cursor_location
                before = area.document.lines[row][:col]
                if before.endswith((".", "->", "::")) and not before.endswith(("..", "...")):
                    self.call_after_refresh(self.action_complete)
        for pane in self.panes():
            if pane.area is event.text_area:
                self.refresh_tab_label(pane)
                if pane.preview.display:
                    self.call_after_refresh(pane.preview.update, pane.area.text)
        self.update_chrome()
        self.update_gutter()

    @on(TextArea.SelectionChanged)
    def _selection(self, event: TextArea.SelectionChanged) -> None:
        menu = self.completion_menu
        if menu.display and menu.area is event.text_area:
            row, col = event.selection.end
            if row != menu.anchor[0] or col < menu.anchor[1]:
                menu.hide()
        self.update_chrome()
        self.query_one(AgentPanel).update_context(self.editor_context())

    @on(TabbedContent.TabActivated)
    def _tab_activated(self) -> None:
        self.completion_menu.hide()
        self.update_chrome()
        self.query_one(AgentPanel).update_context(self.editor_context())
        self.update_gutter()
        a = self.active_area()
        if a:
            self.call_after_refresh(a.focus)

    @on(DirectoryTree.FileSelected)
    async def _file_selected(self, event: DirectoryTree.FileSelected) -> None:
        await self.open_file(event.path)

    @on(Input.Submitted, "#commit-msg")
    async def _commit_submitted(self, event: Input.Submitted) -> None:
        await self.git_commit(event.value)

    @on(Input.Submitted, "#find")
    def _find_submitted(self, event: Input.Submitted) -> None:
        self.find_next(event.value)
        event.input.focus()

    @on(Input.Submitted, "#replace")
    def _replace_submitted(self, event: Input.Submitted) -> None:
        a = self.active_area()
        needle = self.query_one("#find", Input).value
        if a and needle and a.selected_text == needle:
            a.replace(event.value, a.selection.start, a.selection.end)
        self.find_next(needle)
        event.input.focus()

    @on(ListView.Selected, "#git-list")
    async def _git_item(self, event: ListView.Selected) -> None:
        change, kind = getattr(event.item, "change", None), getattr(event.item, "kind", None)
        if change:
            await self.open_diff(change, kind == "staged")

    # ------------------------------------------------------------ editing actions
    def action_save(self) -> None:
        a = self.active_area()
        if a is None:
            return
        if a.path is None:
            self.save_as(a)
        elif self.save_area(a):
            self.notify(f"Saved {a.path.name}", timeout=1.5)
            self.after_disk_change()

    @work
    async def save_as(self, a: CodeArea) -> None:
        name = await self.push_screen_wait(PromptScreen("Save as (relative to project)", "", "src/main.c"))
        if name:
            a.path = (self.root / name).resolve()
            if self.save_area(a):
                self.after_disk_change()

    def action_save_all(self) -> None:
        for p in self.panes():
            if p.area.dirty:
                self.save_area(p.area)
        self.after_disk_change()

    def after_disk_change(self) -> None:
        self._files_cache = None
        self._gutter_base.clear()
        self.query_one(ExplorerTree).reload()
        self.run_worker(self.refresh_git(), exclusive=True, group="git")

    @work
    async def action_close_tab(self) -> None:
        pane = self.active_pane()
        if pane is None:
            return
        if pane.area.dirty:
            choice = await self.push_screen_wait(
                ChoiceScreen(f"Save changes to {pane.area.path.name if pane.area.path else 'untitled'}?",
                             [("s", "Save"), ("d", "Don't save"), ("escape", "Cancel")]))
            if choice == "escape" or (choice == "s" and not self.save_area(pane.area)):
                return
        await self.tabs.remove_pane(pane.id)
        if pane.area.path and not pane.area.read_only:
            self.lsp.close(pane.area.path)
        self.completion_menu.hide()
        self.update_chrome()
        if not self.panes():
            self.query_one(ExplorerTree).focus()

    @work
    async def action_quit(self) -> None:
        for pane in self.panes():
            if not pane.area.dirty:
                continue
            self.tabs.active = pane.id
            choice = await self.push_screen_wait(
                ChoiceScreen(f"Save changes to {pane.area.path.name if pane.area.path else 'untitled'}?",
                             [("s", "Save"), ("d", "Don't save"), ("escape", "Cancel")]))
            if choice == "escape" or (choice == "s" and not self.save_area(pane.area)):
                return
        self.exit()

    @work
    async def action_new_file(self) -> None:
        name = await self.push_screen_wait(PromptScreen("New file (relative to project; folders are created)", "", "src/main.c"))
        if not name:
            return
        p = (self.root / name.strip()).resolve()
        if p.exists():
            await self.open_file(p)
            return
        p.parent.mkdir(parents=True, exist_ok=True)
        p.touch()
        self.after_disk_change()
        await self.open_file(p)

    @work
    async def action_open_path(self) -> None:
        value = await self.push_screen_wait(PromptScreen("Open file or folder", str(self.root) + "/"))
        if not value:
            return
        p = Path(value).expanduser().resolve()
        if p.is_dir():
            await self.switch_root(p)
        else:
            await self.open_file(p)

    async def switch_root(self, p: Path) -> None:
        if any(x.area.dirty for x in self.panes()):
            self.notify("Save or close modified files first.", severity="warning")
            return
        await self.tabs.clear_panes()
        self.root = p
        os.chdir(p)
        self._files_cache = None
        self._gutter_base.clear()
        tree = self.query_one(ExplorerTree)
        tree.path = p
        self.query_one("#explorer .section-title", Label).update(p.name.upper())
        await self.refresh_git()
        self.update_chrome()

    @work
    async def action_rename_file(self) -> None:
        a = self.active_area()
        if not a or not a.path:
            return
        name = await self.push_screen_wait(PromptScreen("Rename to", self.rel(a.path)))
        if not name:
            return
        new = (self.root / name).resolve()
        new.parent.mkdir(parents=True, exist_ok=True)
        a.path.rename(new)
        a.path = new
        self.refresh_tab_label(self.active_pane())
        self.after_disk_change()

    @work
    async def action_delete_file(self) -> None:
        a = self.active_area()
        if not a or not a.path or not a.path.exists():
            return
        if await self.push_screen_wait(ChoiceScreen(f"Delete {self.rel(a.path)} permanently?", [("y", "Delete"), ("n", "Cancel")])) != "y":
            return
        a.path.unlink()
        a.saved_text = a.text
        await self.tabs.remove_pane(self.active_pane().id)
        self.update_chrome()
        self.after_disk_change()

    def action_quick_open(self) -> None:
        self.push_screen(CommandPalette(providers=[FileProvider], placeholder="Go to file…"))

    @work
    async def action_goto_line(self) -> None:
        a = self.active_area()
        if not a:
            return
        v = await self.push_screen_wait(PromptScreen(f"Go to line (1–{a.document.line_count}), optionally line:col"))
        if not v:
            return
        try:
            parts = [int(x) for x in v.split(":")]
        except ValueError:
            return
        a.cursor_location = (max(0, parts[0] - 1), max(0, (parts[1] if len(parts) > 1 else 1) - 1))
        a.scroll_cursor_visible(center=True)
        a.focus()

    def action_find(self, replace: bool = False) -> None:
        bar = self.query_one("#findbar")
        bar.display = True
        self.query_one("#replace").display = replace
        find = self.query_one("#find", Input)
        a = self.active_area()
        if a and a.selected_text and "\n" not in a.selected_text:
            find.value = a.selected_text
        find.focus()

    def action_replace(self) -> None:
        self.action_find(replace=True)

    def action_replace_all(self) -> None:
        a = self.active_area()
        needle = self.query_one("#find", Input).value
        if not a or not needle:
            self.action_replace()
            return
        count = a.text.count(needle)
        if count:
            a.replace(a.text.replace(needle, self.query_one("#replace", Input).value), (0, 0), a.document.end)
        self.notify(f"Replaced {count} occurrence(s)")

    def find_next(self, needle: str) -> None:
        a = self.active_area()
        if not a or not needle:
            return
        lines = a.document.lines
        row, col = a.selection.end
        hay = needle.lower()
        # Search forward from the cursor, wrapping once around the document.
        for i in range(len(lines) + 1):
            r = (row + i) % len(lines)
            start = col if i == 0 else 0
            idx = lines[r].lower().find(hay, start)
            if idx >= 0:
                a.selection = a.selection.__class__((r, idx), (r, idx + len(needle)))
                a.scroll_cursor_visible(center=True)
                return
        self.notify(f"No results for “{needle}”", severity="warning", timeout=2)

    def action_escape(self) -> None:
        bar = self.query_one("#findbar")
        if bar.display:
            bar.display = False
            a = self.active_area()
            if a:
                a.focus()

    def action_toggle_wrap(self) -> None:
        a = self.active_area()
        if a:
            a.soft_wrap = not a.soft_wrap

    def action_toggle_preview(self) -> None:
        pane = self.active_pane()
        if not pane:
            return
        if pane.area.lang != "markdown":
            self.notify("Preview is for markdown files.", severity="warning", timeout=2)
            return
        pane.preview.display = not pane.preview.display
        if pane.preview.display:
            pane.preview.update(pane.area.text)

    def action_next_tab(self, step: int = 1) -> None:
        panes = self.panes()
        if not panes:
            return
        ids = [p.id for p in panes]
        i = ids.index(self.tabs.active) if self.tabs.active in ids else 0
        self.tabs.active = ids[(i + step) % len(ids)]

    def action_prev_tab(self) -> None:
        self.action_next_tab(-1)

    # ------------------------------------------------------------ views
    def action_toggle_sidebar(self) -> None:
        sb = self.query_one("#sidebar")
        sb.display = not sb.display

    def action_show_explorer(self) -> None:
        sb = self.query_one("#sidebar", ContentSwitcher)
        sb.display = True
        sb.current = "explorer"
        self.query_one(ExplorerTree).focus()

    async def action_show_git(self) -> None:
        sb = self.query_one("#sidebar", ContentSwitcher)
        if sb.display and sb.current == "git" and self.focused and self.query_one(GitPanel) in self.focused.ancestors_with_self:
            a = self.active_area()
            (a or self.query_one(ExplorerTree)).focus()
            return
        sb.display = True
        sb.current = "git"
        await self.refresh_git()
        self.query_one("#git-list", ListView).focus()

    # ------------------------------------------------------------ run / shell
    def action_run_file(self) -> None:
        a = self.active_area()
        if not a or not a.path or a.read_only:
            self.notify("Open a source file first.", severity="warning")
            return
        if a.dirty and not self.save_area(a):
            return
        cmd = run_command_for(a.path, a.lang)
        if not cmd:
            self.notify(f"Don't know how to run {a.path.name} ({display_name(a.lang)}).", severity="warning")
            return
        q = shlex.quote
        self._run_suspended(f"printf '\\033[1;35m$ %s\\033[0m\\n' {q(cmd)}; {cmd}; "
                            f"printf '\\n\\033[90m[exit %s — press Enter]\\033[0m' $?; read _")

    def action_shell(self) -> None:
        shell = os.environ.get("SHELL", "/bin/bash")
        self._run_suspended(f"printf '\\033[90m[cnano: type exit to return]\\033[0m\\n'; exec {shlex.quote(shell)}")

    def _run_suspended(self, script: str) -> None:
        with self.suspend():
            subprocess.call(["bash", "-c", script], cwd=self.root)
        self.after_disk_change()
        for pane in self.panes():
            if pane.area.path:
                self.reload_from_disk(pane.area.path)

    # ------------------------------------------------------------ lsp
    # Server callbacks can arrive while the app is shutting down (servers exit after the widgets).
    def _on_diagnostics(self, path: Path, diags: list) -> None:
        try:
            for pane in self.panes():
                if pane.area.path == path and not pane.area.read_only:
                    pane.area.set_diagnostics(diags)
            self.update_chrome()
        except NoMatches:
            pass

    def _on_lsp_status(self, server: str, status: str) -> None:
        self.lsp_status[server] = status
        try:
            if status.startswith("error:"):
                self.notify(status[6:], title=server, severity="error")
            self.update_chrome()
        except NoMatches:
            pass

    def _lsp_pos(self, area: CodeArea) -> dict:
        row, col = area.cursor_location
        return {"line": row, "character": to_utf16(area.document.lines[row], col)}

    def _lsp_area(self) -> CodeArea | None:
        a = self.active_area()
        if not a or not a.path or a.read_only or not self.lsp.server_for(a.path):
            if a and a.path and not a.read_only:
                self.notify("No language server for this file. F1 › LSP: Server Status", severity="warning", timeout=3)
            return None
        return a

    async def _flush_lsp(self, a: CodeArea) -> None:
        if a._lsp_timer:
            a._lsp_timer.stop()
            a._lsp_timer = None
            self.lsp.change(a.path, a.text)

    def _loc(self, area: CodeArea, pos: dict) -> tuple[int, int]:
        row = min(pos["line"], area.document.line_count - 1)
        return row, from_utf16(area.document.lines[row], pos["character"])

    async def action_complete(self) -> None:
        a = self._lsp_area()
        if not a:
            return
        await self._flush_lsp(a)
        row, col = a.cursor_location
        line = a.document.lines[row]
        start = col
        while start > 0 and (line[start - 1].isalnum() or line[start - 1] == "_"):
            start -= 1
        res = await self.lsp.request(a.path, "textDocument/completion", {"position": self._lsp_pos(a)})
        items = res.get("items", []) if isinstance(res, dict) else (res or [])
        if not items or self.active_area() is not a:
            return
        self.completion_menu.show(a, items, (row, start))

    def accept_completion(self) -> None:
        menu = self.completion_menu
        it, a = menu.selected(), menu.area
        menu.hide()
        if not it or not a:
            return
        te = it.get("textEdit")
        text = (te or {}).get("newText") or it.get("insertText") or it["label"].strip()
        start = menu.anchor
        if te:
            rng = te.get("range") or te.get("replace")
            start = self._loc(a, rng["start"])
        a.replace(text, start, a.cursor_location)
        for e in it.get("additionalTextEdits") or []:
            a.replace(e["newText"], self._loc(a, e["range"]["start"]), self._loc(a, e["range"]["end"]))

    @work
    async def action_lsp_hover(self) -> None:
        a = self._lsp_area()
        if not a:
            return
        await self._flush_lsp(a)
        res = await self.lsp.request(a.path, "textDocument/hover", {"position": self._lsp_pos(a)})
        text = hover_markdown(res.get("contents")) if res else ""
        here = [d["message"] for d in a.diagnostics if d["range"]["start"]["line"] <= a.cursor_location[0] <= d["range"]["end"]["line"]]
        if here:
            text = "\n\n".join(f"**⚠** {m}" for m in here) + ("\n\n---\n\n" + text if text else "")
        if text.strip():
            await self.push_screen_wait(HoverScreen(text))
        else:
            self.notify("No hover info here.", timeout=1.5)

    async def _goto(self, loc: dict) -> None:
        path = uri_to_path(loc.get("uri") or loc.get("targetUri"))
        rng = loc.get("range") or loc.get("targetSelectionRange")
        await self.open_file(path)
        a = self.active_area()
        if a and rng:
            a.cursor_location = self._loc(a, rng["start"])
            a.scroll_cursor_visible(center=True)

    async def action_lsp_definition(self) -> None:
        a = self._lsp_area()
        if not a:
            return
        await self._flush_lsp(a)
        res = await self.lsp.request(a.path, "textDocument/definition", {"position": self._lsp_pos(a)})
        locs = res if isinstance(res, list) else ([res] if res else [])
        if not locs:
            self.notify("No definition found.", timeout=1.5)
        elif len(locs) == 1:
            await self._goto(locs[0])
        else:
            self._pick_locations(locs, "Definitions…")

    def _pick_locations(self, locs: list[dict], title: str) -> None:
        items = []
        for loc in locs[:300]:
            p = uri_to_path(loc.get("uri") or loc.get("targetUri"))
            rng = loc.get("range") or loc.get("targetSelectionRange")
            line = rng["start"]["line"]
            try:
                snippet = p.read_text(errors="replace").split("\n")[line].strip()[:60]
            except (OSError, IndexError):
                snippet = ""
            items.append((f"{self.rel(p)}:{line + 1}  {snippet}", "", loc))
        pick(self, items, title, lambda loc: self.run_worker(self._goto(loc)))

    async def action_lsp_references(self) -> None:
        a = self._lsp_area()
        if not a:
            return
        await self._flush_lsp(a)
        res = await self.lsp.request(a.path, "textDocument/references", {"position": self._lsp_pos(a), "context": {"includeDeclaration": True}})
        if not res:
            self.notify("No references found.", timeout=1.5)
            return
        self._pick_locations(res, f"{len(res)} references…")

    async def action_lsp_symbols(self) -> None:
        a = self._lsp_area()
        if not a:
            return
        await self._flush_lsp(a)
        res = await self.lsp.request(a.path, "textDocument/documentSymbol", {}) or []
        items = []

        def walk(syms, depth=0):
            for s_ in syms:
                rng = s_.get("selectionRange") or s_.get("range") or s_["location"]["range"]
                items.append(("  " * depth + s_["name"], (s_.get("detail") or "")[:40], rng))
                walk(s_.get("children") or [], depth + 1)
        walk(res)
        if not items:
            self.notify("No symbols.", timeout=1.5)
            return

        def jump(rng):
            a.cursor_location = self._loc(a, rng["start"])
            a.scroll_cursor_visible(center=True)
            a.focus()
        pick(self, items, "Go to symbol…", jump)

    def action_next_problem(self) -> None:
        a = self.active_area()
        if not a or not a.diagnostics:
            self.notify("No problems.", timeout=1.5)
            return
        row, col = a.cursor_location
        ds = sorted(a.diagnostics, key=lambda d: (d["range"]["start"]["line"], d["range"]["start"]["character"]))
        nxt = next((d for d in ds if (d["range"]["start"]["line"], d["range"]["start"]["character"]) > (row, to_utf16(a.document.lines[row], col))), ds[0])
        a.cursor_location = self._loc(a, nxt["range"]["start"])
        a.scroll_cursor_visible(center=True)
        a.focus()

    async def apply_text_edits(self, a: CodeArea, edits: list[dict]) -> None:
        # Apply bottom-up so earlier ranges stay valid.
        for e in sorted(edits, key=lambda e: (e["range"]["start"]["line"], e["range"]["start"]["character"]), reverse=True):
            a.replace(e["newText"], self._loc(a, e["range"]["start"]), self._loc(a, e["range"]["end"]))

    async def apply_workspace_edit(self, we: dict) -> int:
        changes = dict(we.get("changes") or {})
        for dc in we.get("documentChanges") or []:
            if "textDocument" in dc:
                changes[dc["textDocument"]["uri"]] = dc["edits"]
        files = 0
        for uri, edits in changes.items():
            p = uri_to_path(uri)
            pane = next((x for x in self.panes() if x.area.path == p and not x.area.read_only), None)
            if pane:
                await self.apply_text_edits(pane.area, edits)
            else:
                lines = p.read_text(errors="replace").split("\n")
                offset = lambda pos: sum(len(l) + 1 for l in lines[:pos["line"]]) + from_utf16(lines[pos["line"]] if pos["line"] < len(lines) else "", pos["character"])  # noqa: E731
                text = "\n".join(lines)
                for e in sorted(edits, key=lambda e: offset(e["range"]["start"]), reverse=True):
                    text = text[:offset(e["range"]["start"])] + e["newText"] + text[offset(e["range"]["end"]):]
                p.write_text(text)
            files += 1
        return files

    @work
    async def action_lsp_rename(self) -> None:
        a = self._lsp_area()
        if not a:
            return
        row, col = a.cursor_location
        line = a.document.lines[row]
        s0 = col
        while s0 > 0 and (line[s0 - 1].isalnum() or line[s0 - 1] == "_"):
            s0 -= 1
        e0 = col
        while e0 < len(line) and (line[e0].isalnum() or line[e0] == "_"):
            e0 += 1
        new = await self.push_screen_wait(PromptScreen("Rename symbol to", line[s0:e0]))
        if not new or new == line[s0:e0]:
            return
        await self._flush_lsp(a)
        res = await self.lsp.request(a.path, "textDocument/rename", {"position": self._lsp_pos(a), "newName": new})
        if not res:
            self.notify("Rename not possible here.", severity="warning")
            return
        n = await self.apply_workspace_edit(res)
        self.notify(f"Renamed in {n} file(s).", timeout=2)
        self.after_disk_change()

    async def action_lsp_format(self) -> None:
        a = self._lsp_area()
        if not a:
            return
        await self._flush_lsp(a)
        res = await self.lsp.request(a.path, "textDocument/formatting", {"options": {"tabSize": a.indent_width, "insertSpaces": a.indent_type == "spaces"}})
        if res:
            await self.apply_text_edits(a, res)
        self.notify("Formatted." if res else "Nothing to format (or not supported).", timeout=1.5)

    async def action_lsp_quickfix(self) -> None:
        a = self._lsp_area()
        if not a:
            return
        await self._flush_lsp(a)
        row = a.cursor_location[0]
        diags = [d for d in a.diagnostics if d["range"]["start"]["line"] <= row <= d["range"]["end"]["line"]]
        rng = diags[0]["range"] if diags else {"start": self._lsp_pos(a), "end": self._lsp_pos(a)}
        res = await self.lsp.request(a.path, "textDocument/codeAction", {"range": rng, "context": {"diagnostics": diags}}) or []
        actions = [x for x in res if x.get("edit")]
        if not actions:
            self.notify("No quick fixes here.", timeout=1.5)
            return

        def apply(action):
            self.run_worker(self.apply_workspace_edit(action["edit"]))
        pick(self, [(x["title"], x.get("kind", ""), x) for x in actions], "Quick fix…", apply)

    async def action_lsp_restart(self) -> None:
        await self.lsp.stop_all()
        for pane in self.panes():
            pane.area.set_diagnostics([])
            self.run_worker(self._lsp_open(pane.area))
        self.notify("Language servers restarted.", timeout=2)

    def action_lsp_status(self) -> None:
        names = {"clangd": "C / C++", "rust": "Rust", "python": "Python", "asm": "Assembly"}
        lines = [f"{names[k]:<9} {v or 'not installed — scripts/install-lsp.sh'}" for k, v in lsp_available().items()]
        self.notify("\n".join(lines), title="Language servers", timeout=8)

    # ------------------------------------------------------------ agent
    def editor_context(self) -> dict | None:
        a = self.active_area()
        if not a or not a.path or a.read_only:
            return None
        ctx = {"name": a.path.name, "rel": self.rel(a.path), "lang": a.lang, "line": a.cursor_location[0] + 1}
        if a.selected_text.strip():
            top, bottom = sorted([a.selection.start, a.selection.end])
            ctx.update(text=a.selected_text, start=top[0] + 1, end=bottom[0] + 1)
        return ctx

    def action_toggle_agent(self) -> None:
        panel = self.query_one(AgentPanel)
        box = panel.query_one("#agent-input", Input)
        if not panel.display:
            panel.display = True
            panel.update_context(self.editor_context())
            box.focus()
        elif self.focused is not None and panel in self.focused.ancestors_with_self:
            panel.display = False
            a = self.active_area()
            self.call_after_refresh((a or self.query_one(ExplorerTree)).focus)
        else:
            box.focus()
        panel.settings["open"] = panel.display
        agent_backend.save_settings(panel.settings)

    def _agent(self) -> AgentPanel:
        panel = self.query_one(AgentPanel)
        if not panel.display:
            self.action_toggle_agent()
        return panel

    def action_agent_new(self) -> None:
        self._agent().new_chat()

    def action_agent_provider(self) -> None:
        panel = self._agent()
        items = [(v["label"], "" if agent_backend.has_key(k) else f"needs key ({v['env']})", k) for k, v in agent_backend.PROVIDERS.items()]
        pick(self, items, "Agent provider…", panel.set_provider)

    @work(thread=True, exclusive=True, group="models")
    def action_agent_model(self) -> None:
        panel = self.query_one(AgentPanel)
        try:
            models = agent_backend.list_models(panel.provider)
        except Exception as e:  # noqa: BLE001
            self.call_from_thread(self.notify, f"{e}\nYou can still type any model id.", title="Couldn't fetch models", severity="warning")
            models = []
        items = [(m, "current" if m == panel.model else "", m) for m in models]
        self.call_from_thread(pick, self, items, f"Model for {agent_backend.PROVIDERS[panel.provider]['label']} (type any id)",
                              panel.set_model, True)

    def action_agent_key(self) -> None:
        items = [(v["label"], "saved" if agent_backend.get_key(k) else "", k) for k, v in agent_backend.PROVIDERS.items() if v["env"]]
        pick(self, items, "Set API key for…", self._ask_key)

    @work
    async def _ask_key(self, provider: str) -> None:
        label = agent_backend.PROVIDERS[provider]["label"]
        key = await self.push_screen_wait(PromptScreen(f"{label} API key (empty = remove; stored 0600 in ~/.config/cnano)", "", "paste key"))
        if key is None:
            return
        agent_backend.set_key(provider, key.strip() or None)
        self.notify(f"{label} key {'saved' if key.strip() else 'removed'}.", timeout=2)
        self.query_one(AgentPanel).update_header()

    def action_agent_auto(self, kind: str) -> None:
        panel = self.query_one(AgentPanel)
        auto = panel.settings.setdefault("auto", {})
        auto[kind] = not auto.get(kind)
        agent_backend.save_settings(panel.settings)
        self.notify(f"Auto-approve {kind}: {'on' if auto[kind] else 'off'}", timeout=2)

    def action_agent_claude_mode(self) -> None:
        panel = self.query_one(AgentPanel)
        modes = [("acceptEdits", "edits allowed; other tools need allow-rules"), ("bypassPermissions", "full auto, runs commands"),
                 ("default", "anything needing approval is denied"), ("plan", "read-only planning")]
        current = panel.settings.get("claude_mode", "acceptEdits")

        def choose(m: str) -> None:
            panel.settings["claude_mode"] = m
            agent_backend.save_settings(panel.settings)
            self.notify(f"Claude Code permission mode: {m}", timeout=2)

        pick(self, [(m, ("● " if m == current else "") + d, m) for m, d in modes], "Claude Code permission mode…", choose)

    def action_agent_context(self) -> None:
        panel = self.query_one(AgentPanel)
        panel.include_context = not panel.include_context
        panel.update_context(self.editor_context())

    # ------------------------------------------------------------ git
    async def refresh_git(self) -> None:
        self.git = await git.status(self.root)
        g = self.git
        tree = self.query_one(ExplorerTree)
        marks: dict[Path, str] = {}
        if g.repo:
            for c in g.staged + g.unstaged:
                p = (g.root / c.path).resolve()
                marks[p] = "U" if c.status == "U" else ("A" if c.status == "R" else c.status)
                for parent in p.parents:
                    if parent == g.root or g.root not in parent.parents:
                        break
                    marks.setdefault(parent, "M")
        if marks != tree.marks:
            tree.marks = marks
            tree.refresh()
        await self.render_git_panel()
        self.update_chrome()
        self.update_gutter()

    async def render_git_panel(self) -> None:
        g = self.git
        panel = self.query_one(GitPanel)
        lv = panel.query_one("#git-list", ListView)
        branch = panel.query_one("#git-branch", Label)
        if not g.repo:
            branch.update(Text("Not a git repository — F1 › Git: Init / Clone", style=FG_DIM))
            await lv.clear()
            panel.query_one("#git-log", Static).update("")
            return
        branch.update(Text.assemble((f" {g.branch or 'detached'}", f"bold {ACCENT}"),
                                    (f"  → {g.upstream}" if g.upstream else "  (no upstream)", FG_DIM)))
        key = repr((g.staged, g.unstaged))
        if getattr(panel, "_last_key", None) != key:
            panel._last_key = key
            index = lv.index
            items: list[ListItem] = []
            for kind, title, changes in (("staged", "STAGED", g.staged), ("changes", "CHANGES", g.unstaged)):
                if kind == "staged" and not changes:
                    continue
                head = ListItem(Label(Text(f"{title} ({len(changes)})", style=f"bold {FG_DIM}")), classes="git-head", disabled=True)
                items.append(head)
                for c in changes:
                    color = GIT_COLORS.get(c.status, YELLOW)
                    name, _, folder = c.path.rpartition("/")[::-1] if "/" in c.path else (c.path, "", "")
                    label = Text.assemble((f" {c.status} ", f"bold {color}"), (name, color), (f"  {folder}" if folder else "", FG_FAINT))
                    item = ListItem(Label(label))
                    item.change, item.kind = c, kind
                    items.append(item)
            await lv.clear()
            await lv.extend(items)
            if index is not None and items:
                lv.index = min(index, len(items) - 1)
        commits = await git.log(g.root, 15)
        log = Text()
        for h, when, subj in commits:
            log.append("● ", style=ACCENT)
            log.append(subj[:60] + "\n")
            log.append(f"  {h} · {when}\n", style=FG_FAINT)
        panel.query_one("#git-log", Static).update(log or Text("No commits yet.", style=FG_FAINT))

    @work(exclusive=True, group="gutter")
    async def update_gutter(self) -> None:
        a = self.active_area()
        g = self.git
        if not a or a.read_only or not a.path or not g.repo or g.root not in a.path.parents:
            if a:
                a.set_gutter_marks({})
            return
        rel = str(a.path.relative_to(g.root))
        if rel not in self._gutter_base:
            untracked = any(c.path == rel and c.status == "U" for c in g.unstaged)
            if untracked:
                self._gutter_base[rel] = None
            else:
                r = await git.run(g.root, "show", f":{rel}")
                self._gutter_base[rel] = r.stdout if r.ok else a.saved_text  # ignored/unknown → compare to disk
        if a.document.line_count > 50000:
            return
        a.set_gutter_marks(gutter_marks(self._gutter_base[rel], a.text))

    async def git_op(self, *args: str, quiet: bool = False, cwd: Path | None = None) -> git.Result | None:
        root = cwd or (self.git.root if self.git.repo else None)
        if root is None:
            self.notify("Not a git repository.", severity="warning")
            return None
        self.query_one("#sb-left", Static).update(Text(f"  git {args[0]}…", style=ACCENT))
        r = await git.run(root, *args)
        if not r.ok:
            self.notify(r.message[-1500:] or "failed", title=f"git {args[0]} failed", severity="error", timeout=10)
        elif not quiet:
            self.notify("\n".join(r.message.splitlines()[-5:]) or "done", title=f"git {args[0]}", timeout=4)
        self._gutter_base.clear()
        await self.refresh_git()
        return r

    async def git_commit(self, message: str) -> None:
        message = message.strip()
        if not self.git.repo:
            return
        if not message:
            self.notify("Write a commit message first.", severity="warning")
            return
        for p in self.panes():
            if p.area.dirty:
                self.save_area(p.area)
        await self.refresh_git()
        if not self.git.staged:
            if not self.git.unstaged:
                self.notify("Nothing to commit.")
                return
            await git.run(self.git.root, "add", "-A")  # smart commit: nothing staged → stage all
        r = await self.git_op("commit", "-m", message)
        if r and r.ok:
            self.query_one("#commit-msg", Input).value = ""

    @work
    async def action_git_commit_prompt(self) -> None:
        msg = await self.push_screen_wait(PromptScreen("Commit message"))
        if msg:
            await self.git_commit(msg)

    @work
    async def action_git_push(self) -> None:
        g = self.git
        if not g.repo:
            return
        if not g.remotes:
            url = await self.push_screen_wait(PromptScreen("No remote yet. URL for 'origin'", "", "git@github.com:you/repo.git"))
            if not url:
                return
            if not (await self.git_op("remote", "add", "origin", url.strip(), quiet=True)).ok:
                return
        g = self.git
        if not g.upstream:
            remote = "origin" if "origin" in g.remotes else g.remotes[0]
            await self.git_op("push", "-u", remote, g.branch)
        else:
            await self.git_op("push")

    async def action_git_pull(self) -> None:
        await self.git_op("pull", "--ff-only")
        for p in self.panes():
            if p.area.path:
                self.reload_from_disk(p.area.path)

    async def action_git_fetch(self) -> None:
        await self.git_op("fetch", "--all", "--prune")

    async def action_git_stash(self) -> None:
        await self.git_op("stash", "push", "-u")

    async def action_git_stash_pop(self) -> None:
        await self.git_op("stash", "pop")

    async def action_git_amend(self) -> None:
        msg = self.query_one("#commit-msg", Input).value.strip()
        await self.git_op("commit", "--amend", *(("-m", msg) if msg else ("--no-edit",)))

    async def action_git_init(self) -> None:
        await self.git_op("init", cwd=self.root)

    @work
    async def action_git_branch(self) -> None:
        if not self.git.repo:
            return
        names = await git.branches(self.git.root)
        hint = "existing: " + ", ".join(names[:12]) if names else ""
        name = await self.push_screen_wait(PromptScreen("Checkout branch (a new name creates it)", "", hint))
        if not name:
            return
        name = name.strip()
        await self.git_op(*(("checkout", name) if name in names else ("checkout", "-b", name)))
        for p in self.panes():
            if p.area.path:
                self.reload_from_disk(p.area.path)

    @work
    async def action_git_clone(self) -> None:
        url = await self.push_screen_wait(PromptScreen("Repository URL to clone", "", "https://github.com/user/repo.git"))
        if not url:
            return
        dest = await self.push_screen_wait(PromptScreen("Clone into folder", str(self.root.parent)))
        if not dest:
            return
        parent = Path(dest).expanduser().resolve()
        parent.mkdir(parents=True, exist_ok=True)
        self.notify(f"Cloning {url}…", timeout=3)
        r = await git.run(parent, "clone", url.strip(), timeout=3600)
        if not r.ok:
            self.notify(r.message[-1500:], title="Clone failed", severity="error", timeout=10)
            return
        name = url.strip().rstrip("/").rsplit("/", 1)[-1].removesuffix(".git")
        for line in r.stderr.splitlines():
            if line.startswith("Cloning into '"):
                name = line.split("'")[1]
        await self.switch_root(parent / name)
        self.notify(f"Cloned into {parent / name}")

    async def action_git_diff_current(self) -> None:
        a = self.active_area()
        if not a or not a.path or not self.git.repo:
            return
        rel = str(a.path.relative_to(self.git.root))
        change = next((c for c in self.git.unstaged + self.git.staged if c.path == rel), None)
        if not change:
            self.notify("No changes in this file.")
            return
        await self.open_diff(change, change not in self.git.unstaged)

    async def open_diff(self, change: git.Change, staged: bool) -> None:
        root = self.git.root
        if change.status == "U":
            r = await git.run(root, "diff", "--no-index", "--", "/dev/null", change.path)
        else:
            r = await git.run(root, "diff", *(["--cached"] if staged else []), "--", change.path)
        text = r.stdout or r.stderr or "(no textual changes)"
        for pane in self.panes():
            if pane.area.read_only and pane.area.path == (root / change.path):
                await self.tabs.remove_pane(pane.id)
        await self._add_pane(CodeArea(root / change.path, text, read_only=True, lang="diff"))


# ====================================================================== entry point
def main() -> None:
    ap = argparse.ArgumentParser(prog="cnano-tui", description="cnano in your terminal")
    ap.add_argument("paths", nargs="*", help="folder to open and/or files to edit (file:line works too)")
    ap.add_argument("--version", action="version", version=f"cnano-tui {__version__}")
    args = ap.parse_args()

    root: Path | None = None
    files: list[Path] = []
    for raw in args.paths:
        p = Path(raw).expanduser()
        if p.is_dir():
            root = root or p.resolve()
        else:
            files.append(p.resolve())
    if root is None:
        if files:
            # Editing a file inside a repo: use the repo as the project, else the file's folder.
            top = subprocess.run(["git", "-C", str(files[0].parent), "rev-parse", "--show-toplevel"],
                                 capture_output=True, text=True)
            root = Path(top.stdout.strip()) if top.returncode == 0 else files[0].parent
        else:
            root = Path.cwd()
    os.chdir(root)
    CnanoApp(root, files).run()


if __name__ == "__main__":
    sys.exit(main())
