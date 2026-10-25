"""Language detection and highlighting.

Tree-sitter grammars are used where available (Textual's builtins plus C and C++).
Assembly, Makefiles, linker scripts and diffs have no packaged grammar, so they get
small regex highlighters that feed the same highlight map.
"""

from __future__ import annotations

import re
from pathlib import Path

BY_NAME = {
    "makefile": "makefile", "gnumakefile": "makefile", "dockerfile": "bash",
    ".bashrc": "bash", ".bash_profile": "bash", ".profile": "bash", ".zshrc": "bash",
    ".bash_aliases": "bash", "pkgbuild": "bash", "cargo.lock": "toml",
}
BY_EXT = {
    ".c": "c", ".h": "c",
    ".cc": "cpp", ".cpp": "cpp", ".cxx": "cpp", ".c++": "cpp", ".hpp": "cpp", ".hh": "cpp",
    ".hxx": "cpp", ".inl": "cpp", ".ipp": "cpp", ".tpp": "cpp",
    ".s": "asm", ".asm": "asm", ".nasm": "asm", ".inc": "asm",
    ".sh": "bash", ".bash": "bash", ".zsh": "bash", ".ksh": "bash",
    ".rs": "rust", ".py": "python", ".pyi": "python",
    ".md": "markdown", ".markdown": "markdown",
    ".json": "json", ".toml": "toml", ".yml": "yaml", ".yaml": "yaml",
    ".xml": "xml", ".html": "html", ".htm": "html", ".css": "css",
    ".js": "javascript", ".mjs": "javascript", ".go": "go", ".java": "java", ".sql": "sql",
    ".mk": "makefile", ".mak": "makefile", ".ld": "linkerscript", ".lds": "linkerscript",
    ".diff": "diff", ".patch": "diff", ".ini": "ini", ".cfg": "ini", ".conf": "ini",
}
DISPLAY = {
    "c": "C", "cpp": "C++", "asm": "Assembly", "bash": "Shell", "rust": "Rust", "python": "Python",
    "markdown": "Markdown", "makefile": "Makefile", "linkerscript": "Linker Script", "diff": "Diff",
    "ini": "INI", None: "Plain Text",
}


def detect(path: Path | None, first_line: str = "") -> str | None:
    if path is not None:
        name = path.name.lower()
        if name in BY_NAME:
            return BY_NAME[name]
        lang = BY_EXT.get(path.suffix.lower())
        if lang:
            return lang
    if first_line.startswith("#!"):
        if re.search(r"\b(ba|z|k|da)?sh\b", first_line):
            return "bash"
        if "python" in first_line:
            return "python"
    return None


def display_name(lang: str | None) -> str:
    return DISPLAY.get(lang, (lang or "plain").capitalize())


# ---------------------------------------------------------------- tree-sitter extras
_TS_CACHE: dict[str, tuple[object, str]] = {}


def tree_sitter_language(lang: str):
    """Return (Language, highlight_query) for grammars Textual doesn't ship, or None."""
    if lang in _TS_CACHE:
        return _TS_CACHE[lang]
    try:
        from tree_sitter import Language
        import tree_sitter_c
        if lang == "c":
            result = (Language(tree_sitter_c.language()), tree_sitter_c.HIGHLIGHTS_QUERY)
        elif lang == "cpp":
            import tree_sitter_cpp
            # The C++ query only adds to the C one, so both are combined.
            result = (Language(tree_sitter_cpp.language()), tree_sitter_c.HIGHLIGHTS_QUERY + "\n" + tree_sitter_cpp.HIGHLIGHTS_QUERY)
        else:
            return None
    except Exception:  # grammar missing or ABI mismatch: fall back to plain text
        return None
    _TS_CACHE[lang] = result
    return result


# ---------------------------------------------------------------- regex highlighters
# Each rule: (highlight name, compiled regex, group). Later rules win, so comments go last.
_ASM_REGS = (
    r"r[abcd]x|r[sd]i|r[bs]p|rip|e[abcd]x|e[sd]i|e[bs]p|eip|[abcd][xlh]|[sd]il?|[bs]pl?|ip|"
    r"r(?:[89]|1[0-5])[dwb]?|[cdefgs]s|cr[0-48]|dr[0-367]|[re]?flags|[xyz]mm\d+|st\d|"
    r"[xw](?:\d|[12]\d|30)|xzr|wzr|lr|pc|fp|r\d|a[0-7]|t[0-6]|s(?:\d|1[01])|ra|gp|tp|zero"
)
_NASM_DIRECTIVES = (
    r"section|segment|global|extern|bits|org|d[bwdqtoy]|res[bwdq]|times|equ|default|rel|abs|"
    r"align|alignb|struc|endstruc|istruc|iend|at|incbin|use16|use32|use64"
)
RULES: dict[str, list[tuple[str, re.Pattern, int]]] = {
    "asm": [
        ("keyword", re.compile(r"^\s*([a-z][\w.]*)\b(?!:)", re.I), 1),
        ("keyword", re.compile(rf"\b(?:{_NASM_DIRECTIVES})\b", re.I), 0),
        ("type", re.compile(r"\b(?:byte|word|dword|qword|tword|oword|yword|zword|ptr|near|far|short)\b", re.I), 0),
        ("function.special", re.compile(r"(?<![\w%])\.[A-Za-z_]\w*"), 0),
        ("variable.builtin", re.compile(rf"%?\b(?:{_ASM_REGS})\b", re.I), 0),
        ("number", re.compile(r"\$?\b(?:0x[0-9a-f_]+|0b[01_]+|[0-9][0-9a-f_]*h|\d+)\b", re.I), 0),
        ("function", re.compile(r"^\s*([A-Za-z_.$][\w.$]*|\d+):"), 1),
        ("string", re.compile(r"\"(?:[^\"\\]|\\.)*\"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`"), 0),
        ("function.special", re.compile(r"^\s*[#%]\s*\w+.*$"), 0),
        ("comment", re.compile(r"(?:;|#(?!\s*(?:include|define|if|ifdef|ifndef|else|endif|undef|pragma)\b)|//|@ ).*$"), 0),
        ("comment", re.compile(r"/\*.*?(?:\*/|$)"), 0),
    ],
    "makefile": [
        ("keyword", re.compile(r"^\s*-?(?:ifeq|ifneq|ifdef|ifndef|else|endif|include|sinclude|define|endef|export|unexport|override|vpath)\b"), 0),
        ("function", re.compile(r"^([\w./%$(){}-]+(?:\s+[\w./%$(){}-]+)*)\s*::?(?!=)"), 1),
        ("function.special", re.compile(r"^\s*\.(?:PHONY|SUFFIXES|DEFAULT|PRECIOUS|SILENT|ONESHELL)\b"), 0),
        ("property", re.compile(r"^\s*([\w.-]+)\s*(?::=|\?=|\+=|::=|=)"), 1),
        ("operator", re.compile(r"(?::=|\?=|\+=|::=)"), 0),
        ("variable.builtin", re.compile(r"\$[@<^?*+%|]"), 0),
        ("variable", re.compile(r"\$[({][\w.-]+[)}]"), 0),
        ("keyword", re.compile(r"\$\((?:wildcard|patsubst|subst|shell|foreach|filter|filter-out|addprefix|addsuffix|notdir|dir|basename|call|eval|if|strip|sort|word|words|abspath|realpath)\b"), 0),
        ("keyword", re.compile(r"^\t[@-]+"), 0),
        ("string", re.compile(r"\"[^\"]*\"|'[^']*'"), 0),
        ("comment", re.compile(r"(?<!\\)#.*$"), 0),
    ],
    "linkerscript": [
        ("keyword", re.compile(r"\b(?:ENTRY|SECTIONS|MEMORY|OUTPUT_FORMAT|OUTPUT_ARCH|INPUT|GROUP|OUTPUT|SEARCH_DIR|STARTUP|PROVIDE|PROVIDE_HIDDEN|KEEP|ALIGN|SIZEOF|ADDR|LOADADDR|AT|ORIGIN|LENGTH|ASSERT|DEFINED|PHDRS|FILL|NOLOAD|INCLUDE|HIDDEN|SORT|BYTE|SHORT|LONG|QUAD)\b"), 0),
        ("function", re.compile(r"(?<![\w])\.[\w.]+"), 0),
        ("number", re.compile(r"\b(?:0x[0-9a-fA-F]+|\d+)[KM]?\b"), 0),
        ("string", re.compile(r"\"[^\"]*\""), 0),
        ("comment", re.compile(r"/\*.*?(?:\*/|$)"), 0),
    ],
    "diff": [
        ("diff.add", re.compile(r"^\+.*$"), 0),
        ("diff.del", re.compile(r"^-.*$"), 0),
        ("heading", re.compile(r"^(?:diff --git|index|\+\+\+|---) .*$"), 0),
        ("keyword", re.compile(r"^@@.*?@@"), 0),
    ],
    "ini": [
        ("heading", re.compile(r"^\s*\[.*\]"), 0),
        ("property", re.compile(r"^\s*([\w.-]+)\s*="), 1),
        ("string", re.compile(r"\"[^\"]*\""), 0),
        ("comment", re.compile(r"^\s*[#;].*$"), 0),
    ],
}


def regex_highlights(lines: list[str], rules) -> dict[int, list[tuple[int, int, str]]]:
    out: dict[int, list[tuple[int, int, str]]] = {}
    in_block_comment = False
    has_block = any(name == "comment" and "/\\*" in rx.pattern for name, rx, _ in rules)
    for i, line in enumerate(lines):
        spans = []
        if in_block_comment:
            end = line.find("*/")
            if end < 0:
                out[i] = [(0, len(line), "comment")]
                continue
            spans.append((0, end + 2, "comment"))
            in_block_comment = False
        for name, rx, group in rules:
            for m in rx.finditer(line):
                if m.group(group) is not None and m.end(group) > m.start(group):
                    spans.append((m.start(group), m.end(group), name))
        if has_block:
            start = line.rfind("/*")
            if start >= 0 and line.find("*/", start) < 0:
                in_block_comment = True
        if spans:
            out[i] = spans
    return out
