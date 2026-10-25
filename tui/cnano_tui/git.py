"""Thin async wrapper over the git CLI."""

from __future__ import annotations

import asyncio
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

ENV = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}  # never hang on a credential prompt


@dataclass
class Result:
    ok: bool
    stdout: str
    stderr: str

    @property
    def message(self) -> str:
        return (self.stderr or self.stdout).strip()


@dataclass
class Change:
    path: str
    status: str  # M A D R U(ntracked) …


@dataclass
class Status:
    repo: bool = False
    root: Path | None = None
    branch: str = ""
    upstream: str | None = None
    ahead: int = 0
    behind: int = 0
    staged: list[Change] = field(default_factory=list)
    unstaged: list[Change] = field(default_factory=list)
    remotes: list[str] = field(default_factory=list)


async def run(cwd: Path, *args: str, timeout: float = 600) -> Result:
    try:
        proc = await asyncio.create_subprocess_exec(
            "git", *args, cwd=cwd, env=ENV,
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except FileNotFoundError:
        return Result(False, "", "git is not installed")
    except asyncio.TimeoutError:
        proc.kill()
        return Result(False, "", f"git {args[0]} timed out")
    return Result(proc.returncode == 0, out.decode(errors="replace"), err.decode(errors="replace"))


async def status(cwd: Path) -> Status:
    top = await run(cwd, "rev-parse", "--show-toplevel")
    if not top.ok:
        return Status()
    root = Path(top.stdout.strip())
    st = await run(root, "status", "--porcelain=v1", "-b", "-z", "-uall")
    s = Status(repo=True, root=root)
    parts = st.stdout.split("\0")
    i = 0
    while i < len(parts):
        p = parts[i]
        i += 1
        if not p:
            continue
        if p.startswith("## "):
            m = re.match(r"^(?:No commits yet on |Initial commit on )?([^.\s]+)(?:\.\.\.(\S+))?(?: \[(.*)\])?", p[3:])
            if m:
                s.branch, s.upstream = m.group(1), m.group(2)
                info = m.group(3) or ""
                a, b = re.search(r"ahead (\d+)", info), re.search(r"behind (\d+)", info)
                s.ahead, s.behind = int(a.group(1)) if a else 0, int(b.group(1)) if b else 0
            continue
        x, y, path = p[0], p[1], p[3:]
        if x in "RC":
            i += 1  # skip the original path
        if x == "?" and y == "?":
            s.unstaged.append(Change(path, "U"))
            continue
        if x != " ":
            s.staged.append(Change(path, x))
        if y != " ":
            s.unstaged.append(Change(path, y))
    s.remotes = [r for r in (await run(root, "remote")).stdout.split() if r]
    return s


async def log(root: Path, n: int = 30) -> list[tuple[str, str, str]]:
    r = await run(root, "log", f"-n{n}", "--date=relative", "--pretty=format:%h\x1f%ad\x1f%s")
    return [tuple(line.split("\x1f", 2)) for line in r.stdout.splitlines() if line.count("\x1f") == 2] if r.ok else []


async def branches(root: Path) -> list[str]:
    return (await run(root, "branch", "--format=%(refname:short)")).stdout.split()
