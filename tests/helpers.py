"""Shared helpers for cnano's test suite (stdlib only)."""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TUI_SRC = ROOT / "tui"
TUI_STAGE = ROOT / "build" / "stage" / "tui"
LSP_DIR = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "cnano" / "lsp" / "bin"
ELECTRON = ROOT / "node_modules" / "electron" / "dist" / "electron"

# Make the TUI package importable from the source tree, with deps from the staged build if present.
for p in (TUI_STAGE, TUI_SRC):
    if p.is_dir() and str(p) not in sys.path:
        sys.path.insert(0, str(p))


def which(cmd: str) -> str | None:
    return shutil.which(cmd) or (str(LSP_DIR / cmd) if (LSP_DIR / cmd).exists() else None)


def run(*args: str, timeout: float = 60, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(list(args), capture_output=True, text=True, timeout=timeout, **kw)


def version_tuple(text: str) -> tuple[int, ...]:
    m = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", text)
    return tuple(int(x) for x in m.groups() if x is not None) if m else ()
