"""The "cnano night" palette, shared with the GUI."""

from rich.style import Style
from textual.theme import Theme
from textual.widgets.text_area import TextAreaTheme

BG0, BG1, BG2, BG3, BG4 = "#13141c", "#181922", "#1e1f2b", "#262838", "#2f3247"
BORDER = "#2a2c3d"
FG, FG_DIM, FG_FAINT = "#c8cbe0", "#7d8199", "#545870"
ACCENT, BLUE, GREEN, YELLOW, RED, CYAN, ORANGE, PURPLE = (
    "#a882ff", "#7aa2f7", "#9ece6a", "#e0af68", "#f7768e", "#7dcfff", "#ff9e64", "#bb9af7",
)

APP_THEME = Theme(
    name="cnano-night",
    primary=ACCENT,
    secondary=BLUE,
    accent=ACCENT,
    warning=YELLOW,
    error=RED,
    success=GREEN,
    foreground=FG,
    background=BG2,
    surface=BG1,
    panel=BG0,
    boost="#ffffff08",
    dark=True,
    variables={
        "border": BORDER,
        "border-blurred": BORDER,
        "footer-background": BG0,
        "footer-key-foreground": ACCENT,
        "footer-description-foreground": FG_DIM,
        "input-selection-background": "#a882ff44",
        "block-cursor-background": ACCENT,
        "block-cursor-foreground": BG0,
        "scrollbar": BG3,
        "scrollbar-hover": BG4,
        "scrollbar-active": ACCENT,
        "scrollbar-background": BG2,
    },
)

EDITOR_THEME = TextAreaTheme(
    name="cnano-night",
    base_style=Style(color=FG, bgcolor=BG2),
    gutter_style=Style(color="#3b3e54", bgcolor=BG2),
    cursor_style=Style(color=BG0, bgcolor="#c0a6ff"),
    cursor_line_style=Style(bgcolor="#232434"),
    cursor_line_gutter_style=Style(color=ACCENT, bgcolor="#232434", bold=True),
    bracket_matching_style=Style(bgcolor="#3a3358", bold=True),
    selection_style=Style(bgcolor="#3d3566"),
    syntax_styles={
        "comment": Style(color="#5c6283", italic=True),
        "string": Style(color=GREEN),
        "string.documentation": Style(color=GREEN),
        "string.special": Style(color=CYAN),
        "escape": Style(color="#89ddff"),
        "number": Style(color=ORANGE),
        "float": Style(color=ORANGE),
        "constant": Style(color=ORANGE),
        "constant.builtin": Style(color=ORANGE),
        "boolean": Style(color=ORANGE),
        "keyword": Style(color=PURPLE),
        "keyword.function": Style(color=PURPLE),
        "keyword.return": Style(color=PURPLE),
        "keyword.operator": Style(color=PURPLE),
        "conditional": Style(color=PURPLE),
        "repeat": Style(color=PURPLE),
        "exception": Style(color=PURPLE),
        "include": Style(color=RED),
        "function.special": Style(color=RED),     # C preprocessor / asm directives
        "label": Style(color=BLUE),
        "type": Style(color="#2ac3de"),
        "type.builtin": Style(color="#2ac3de"),
        "type.class": Style(color="#2ac3de"),
        "class": Style(color="#2ac3de"),
        "function": Style(color=BLUE),
        "function.call": Style(color=BLUE),
        "method": Style(color=BLUE),
        "method.call": Style(color=BLUE),
        "constructor": Style(color="#2ac3de"),
        "property": Style(color="#73daca"),
        "variable": Style(color=FG),
        "variable.builtin": Style(color=YELLOW),
        "variable.parameter": Style(color=YELLOW),
        "operator": Style(color="#89ddff"),
        "delimiter": Style(color="#89ddff"),
        "punctuation.bracket": Style(color="#a9b1d6"),
        "punctuation.delimiter": Style(color="#89ddff"),
        "punctuation.special": Style(color="#89ddff"),
        "tag": Style(color=RED),
        "regex": Style(color="#b4f9f8"),
        # markdown
        "heading": Style(color=ACCENT, bold=True),
        "heading.marker": Style(color=FG_FAINT),
        "bold": Style(bold=True, color="#eceef9"),
        "italic": Style(italic=True, color="#e4ddff"),
        "strikethrough": Style(strike=True),
        "link.uri": Style(color=BLUE, underline=True),
        "link.label": Style(color=ACCENT),
        "list.marker": Style(color=ACCENT),
        "inline_code": Style(color="#f2a7c3"),
        "info_string": Style(color=YELLOW, italic=True),
        # data formats
        "json.label": Style(color=BLUE),
        "json.null": Style(color=ORANGE),
        "yaml.field": Style(color=BLUE),
        "toml.type": Style(color=BLUE),
        "css.property": Style(color=BLUE),
        # LSP diagnostics (layered over syntax colours)
        "diag.error": Style(bgcolor="#3d2232", underline=True),
        "diag.warning": Style(bgcolor="#3a3122", underline=True),
        "diag.info": Style(underline=True),
        # diff (regex highlighter)
        "diff.add": Style(color=GREEN, bgcolor="#262f2a"),
        "diff.del": Style(color=RED, bgcolor="#30232f"),
    },
)
