"""
核心搜索引擎：文本搜索 + 符号搜索。
优先使用 ripgrep（速度快 10x+），不可用时回退到 Python re。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .config import (
    DEFAULT_IGNORE,
    build_file_list,
    detect_lang,
    find_project_root,
    is_relative_to,
    load_extra_ignore,
    read_text_auto,
    should_ignore,
)
from .symbols import Symbol, extract_symbols, find_containing_symbol



@dataclass
class Match:
    file: str
    line: int
    col: int
    text: str
    symbol: Optional[dict] = field(default=None)
    context_before: list[str] = field(default_factory=list)
    context_after: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        d: dict = {
            "file": self.file,
            "line": self.line,
            "col": self.col,
            "text": self.text,
        }
        if self.symbol:
            d["symbol"] = self.symbol
        if self.context_before:
            d["context_before"] = self.context_before
        if self.context_after:
            d["context_after"] = self.context_after
        return d


@dataclass
class SearchResponse:
    ok: bool = True
    matches: list[Match] = field(default_factory=list)
    total: int = 0
    files_searched: int = 0
    elapsed_ms: float = 0
    error: str = ""

    def to_dict(self) -> dict:
        if not self.ok:
            return {"ok": False, "error": self.error}
        return {
            "ok": True,
            "data": {
                "matches": [m.to_dict() for m in self.matches],
                "total": self.total,
                "files_searched": self.files_searched,
                "elapsed_ms": round(self.elapsed_ms, 1),
            },
        }




MAX_RESULTS_CAP = 5000
MAX_TREE_DEPTH = 16
MAX_CONTEXT_LINES = 200
MAX_PATTERN_LEN = 256





_REDOS_RE = re.compile(r"\([^()]*[*+][^()]*\)\s*(?:[*+]|\{\d+,\})")


def _safe_int(value, default: int, lo: int, hi: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return max(lo, min(hi, n))




_has_rg: Optional[bool] = None

def has_ripgrep() -> bool:
    global _has_rg
    if _has_rg is None:

        if os.environ.get("AISEARCH_NO_RG"):
            _has_rg = False
            return _has_rg
        try:
            r = subprocess.run(
                ["rg", "--version"],
                capture_output=True, timeout=5,
            )
            _has_rg = r.returncode == 0
        except (FileNotFoundError, subprocess.TimeoutExpired):
            _has_rg = False
    return _has_rg




def _search_with_rg(
    pattern: str,
    root: Path,
    scope: Optional[Path],
    extensions: Optional[set[str]],
    ignore: list[str],
    context_lines: int,
    case_insensitive: bool,
    max_results: int,
    whole_word: bool,
    literal: bool = False,
) -> SearchResponse:
    t0 = time.monotonic()
    cmd = [
        "rg", "--json",
        "-C", str(context_lines),
        "--max-count", str(max(1, max_results * 3)),
    ]
    if case_insensitive:
        cmd.append("-i")
    if whole_word:
        cmd.append("-w")
    if extensions:
        for ext in extensions:
            cmd.extend(["-g", f"*{ext}"])


    for ig in ignore:
        cmd.extend(["--glob", f"!{ig}"])




    cmd.extend(["-e", re.escape(pattern) if literal else pattern])

    cmd.append("." if scope is None else _rel_to(root, scope))

    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30,
            cwd=str(root),

        )
    except subprocess.TimeoutExpired:
        return SearchResponse(ok=False, error="Search timed out (30s)")


    if proc.returncode not in (0, 1):
        err = proc.stderr.strip().splitlines()
        msg = err[-1] if err else f"ripgrep exited with {proc.returncode}"
        return SearchResponse(ok=False, error=msg)

    matches: list[Match] = []
    files_searched: set[str] = set()
    current_file = ""
    file_matches: list[Match] = []
    ctx_lines: dict[int, str] = {}

    def _attach_context() -> None:
        if context_lines > 0:
            for m in file_matches:
                m.context_before = [ctx_lines[k] for k in range(max(1, m.line - context_lines), m.line) if k in ctx_lines]
                m.context_after = [ctx_lines[k] for k in range(m.line + 1, m.line + 1 + context_lines) if k in ctx_lines]
        file_matches.clear()
        ctx_lines.clear()

    for line_text in proc.stdout.splitlines():
        if not line_text:
            continue
        try:
            msg = json.loads(line_text)
        except json.JSONDecodeError:
            continue

        msg_type = msg.get("type")
        data = msg.get("data", {})

        if msg_type == "begin":

            _attach_context()
            current_file = data.get("path", {}).get("text", "")
            files_searched.add(current_file)

        elif msg_type == "match":
            path_text = data.get("path", {}).get("text", "")
            line_num = data.get("line_number", 0)
            line_content = data.get("lines", {}).get("text", "").rstrip("\n")
            subs = data.get("submatches", [])

            col = _byte_offset_to_col(line_content, subs[0]["start"]) if subs else 0

            rel_path = _rel_path(path_text, root)

            m = Match(
                file=rel_path,
                line=line_num,
                col=col,
                text=line_content,
                context_before=[],
            )
            matches.append(m)
            file_matches.append(m)

        elif msg_type == "context":

            ctx_lines[data.get("line_number", 0)] = data.get("lines", {}).get("text", "").rstrip("\n")

        elif msg_type == "end":
            _attach_context()


    _attach_context()


    matches = matches[:max_results]

    elapsed = (time.monotonic() - t0) * 1000
    return SearchResponse(
        matches=matches,
        total=len(matches),
        files_searched=len(files_searched),
        elapsed_ms=elapsed,
    )


def _byte_offset_to_col(text: str, byte_off: int) -> int:
    if byte_off <= 0:
        return 0
    acc = 0
    for i, ch in enumerate(text):
        if acc >= byte_off:
            return i
        acc += len(ch.encode("utf-8"))
    return len(text)


def _rel_path(full: str, root: Path) -> str:

    p = full[2:] if full.startswith("./") else full
    try:
        return str(Path(p).relative_to(root))
    except ValueError:
        return p


def _rel_to(root: Path, p: Path) -> str:
    try:
        return str(Path(p).relative_to(root))
    except ValueError:
        return str(p)


def _resolve_scope(path: str, root: Path) -> Optional[Path]:
    try:
        p = Path(path).expanduser()
        if not p.is_absolute():
            p = Path.cwd() / p
        p = p.resolve()
    except (OSError, RuntimeError):
        return None
    root_r = root.resolve()
    try:
        if p.is_file():
            return p
        if p.is_dir() and p != root_r and is_relative_to(p, root_r):
            return p
    except OSError:
        return None
    return None




def _search_with_regex(
    pattern: str,
    root: Path,
    scope: Optional[Path],
    extensions: Optional[set[str]],
    ignore: list[str],
    context_lines: int,
    case_insensitive: bool,
    max_results: int,
    whole_word: bool,
    literal: bool = False,
) -> SearchResponse:
    t0 = time.monotonic()

    flags = re.IGNORECASE if case_insensitive else 0

    if not whole_word and _REDOS_RE.search(pattern):
        return SearchResponse(
            ok=False,
            error="Pattern may cause catastrophic backtracking (nested quantifiers); "
                  "simplify it (e.g. (a+)+ -> a+) or install ripgrep for linear-time search",
        )

    try:





        src = re.escape(pattern) if literal else pattern
        if whole_word:
            pat = re.compile(rf"(?<!\w){src}(?!\w)", flags)
        else:
            pat = re.compile(src, flags)
    except re.error as e:
        return SearchResponse(ok=False, error=f"Invalid regex: {e}")


    if scope is not None and scope.is_file():
        base, names = scope.parent, [scope.name]
    elif scope is not None:
        base, names = scope, build_file_list(scope, extensions, ignore)
    else:
        base, names = root, build_file_list(root, extensions, ignore)
    prefix = "" if base == root else _rel_to(root, base)
    if prefix in (".", ""):
        prefix = ""

    matches: list[Match] = []
    files_searched = 0

    for fname in names:
        full = base / fname
        fpath = str(Path(prefix) / fname) if prefix else fname
        try:
            lines = read_text_auto(full).splitlines()
        except (OSError, PermissionError):
            continue

        files_searched += 1

        for idx, line in enumerate(lines):
            m = pat.search(line)
            if m:
                cb = lines[max(0, idx - context_lines) : idx]
                ca = lines[idx + 1 : idx + 1 + context_lines]
                matches.append(Match(
                    file=fpath,
                    line=idx + 1,
                    col=m.start(),
                    text=line,
                    context_before=cb,
                    context_after=ca,
                ))
                if len(matches) >= max_results:
                    break
        if len(matches) >= max_results:
            break

    elapsed = (time.monotonic() - t0) * 1000
    return SearchResponse(
        matches=matches,
        total=len(matches),
        files_searched=files_searched,
        elapsed_ms=elapsed,
    )




def search_text(
    pattern: str,
    path: str = ".",
    extensions: Optional[set[str]] = None,
    context_lines: int = 2,
    case_insensitive: bool = False,
    max_results: int = 50,
    whole_word: bool = False,
    extra_ignore: Optional[list[str]] = None,
    literal: bool = False,
) -> SearchResponse:
    root = find_project_root(path)
    scope = _resolve_scope(path, root)
    ignore = DEFAULT_IGNORE + (extra_ignore or []) + load_extra_ignore(root)


    if not pattern or not pattern.strip():
        return SearchResponse(ok=False, error="Empty search pattern")

    if len(pattern) > MAX_PATTERN_LEN:
        return SearchResponse(
            ok=False,
            error=f"Search pattern too long ({len(pattern)} chars > {MAX_PATTERN_LEN})",
        )


    context_lines = _safe_int(context_lines, 2, 0, MAX_CONTEXT_LINES)
    max_results = _safe_int(max_results, 50, 1, MAX_RESULTS_CAP)

    if has_ripgrep():
        return _search_with_rg(
            pattern, root, scope, extensions, ignore,
            context_lines, case_insensitive, max_results, whole_word, literal,
        )
    else:
        return _search_with_regex(
            pattern, root, scope, extensions, ignore,
            context_lines, case_insensitive, max_results, whole_word, literal,
        )




@dataclass
class SymbolMatch:
    file: str
    symbol: Symbol
    line_text: str

    def to_dict(self) -> dict:
        d = self.symbol.to_dict()
        d["file"] = self.file
        d["text"] = self.line_text
        return d


@dataclass
class SymbolResponse:
    ok: bool = True
    matches: list[SymbolMatch] = field(default_factory=list)
    total: int = 0
    files_searched: int = 0
    elapsed_ms: float = 0
    error: str = ""

    match_mode: str = ""

    def to_dict(self) -> dict:
        if not self.ok:
            return {"ok": False, "error": self.error}
        data = {
            "matches": [m.to_dict() for m in self.matches],
            "total": self.total,
            "files_searched": self.files_searched,
            "elapsed_ms": round(self.elapsed_ms, 1),
        }
        if self.match_mode:
            data["match_mode"] = self.match_mode
        return {"ok": True, "data": data}


def _resolve_scan_scope(path: str, extra_ignore: Optional[list[str]]):
    root = find_project_root(path)
    scope = _resolve_scope(path, root)
    ignore = DEFAULT_IGNORE + (extra_ignore or []) + load_extra_ignore(root)

    if scope is not None and scope.is_file():
        base, names = scope.parent, [scope.name]
    elif scope is not None:
        base, names = scope, build_file_list(scope, None, ignore)
    else:
        base, names = root, build_file_list(root, None, ignore)
    prefix = "" if base == root else _rel_to(root, base)
    if prefix in (".", ""):
        prefix = ""
    return base, names, prefix


def search_symbols(
    name: str,
    path: str = ".",
    kind: Optional[str] = None,
    max_results: int = 50,
    extra_ignore: Optional[list[str]] = None,
    partial: bool = True,
) -> SymbolResponse:
    if partial:
        needle = name.lower()
    t0 = time.monotonic()
    max_results = _safe_int(max_results, 50, 1, MAX_RESULTS_CAP)
    base, names, prefix = _resolve_scan_scope(path, extra_ignore)

    matches: list[SymbolMatch] = []
    searched = 0

    for fname in names:
        fpath = str(Path(prefix) / fname) if prefix else fname
        lang = detect_lang(fpath)
        if not lang:
            continue

        full = base / fname
        try:
            lines = read_text_auto(full).splitlines()
        except (OSError, PermissionError):
            continue

        searched += 1
        syms = extract_symbols(lines, lang, fpath)

        for s in syms:
            hit = (needle in s.name.lower()) if partial else (s.name == name)
            if not hit:
                continue
            if kind and s.kind != kind:
                continue
            line_text = lines[s.line - 1] if s.line <= len(lines) else ""
            matches.append(SymbolMatch(file=fpath, symbol=s, line_text=line_text.rstrip()))
            if len(matches) >= max_results:
                break

        if len(matches) >= max_results:
            break

    elapsed = (time.monotonic() - t0) * 1000
    return SymbolResponse(
        matches=matches,
        total=len(matches),
        files_searched=searched,
        elapsed_ms=elapsed,
    )




def find_definition(
    name: str,
    path: str = ".",
    extra_ignore: Optional[list[str]] = None,
    max_results: int = 50,
    substring_fallback: bool = True,
) -> SymbolResponse:
    """查找符号定义，两级匹配：

    1) exact：只接受符号名与请求**完全相等**的候选 —— 它们全部来自定义正则
       （extract_symbols 的行级声明模式），从根上杜绝两 类假定义：
       a) 子串命中稀释（旧版 def 'Text' 会混入 TextView/findToolByName 等 50 个候选）；
       b) 使用/导入位置被当定义（名字精确匹配定义行才算候选）。
    2) substring_fallback：exact 无命中时回退子串匹配（大小写不敏感），并在响应
       `match_mode="substring"` 显式披露 —— 调用方据此知道候选需人工核对。

    排序不变：精确名 > class/struct/interface/trait > enum/type > function > method > 行号。
    """
    priority = {"class": 0, "struct": 0, "interface": 0, "trait": 0,
                "enum": 1, "type": 1, "function": 2, "method": 3}





    max_results = _safe_int(max_results, 50, 1, MAX_RESULTS_CAP)
    base, names, prefix = _resolve_scan_scope(path, extra_ignore)
    needle = name.lower()
    t0 = time.monotonic()
    exact: list[SymbolMatch] = []
    sub: list[SymbolMatch] = []
    searched = 0

    for fname in names:
        fpath = str(Path(prefix) / fname) if prefix else fname
        lang = detect_lang(fpath)
        if not lang:
            continue
        full = base / fname
        try:
            lines = read_text_auto(full).splitlines()
        except (OSError, PermissionError):
            continue
        searched += 1

        for s in extract_symbols(lines, lang, fpath):
            if s.name == name:
                if len(exact) < max_results:
                    line_text = lines[s.line - 1] if s.line <= len(lines) else ""
                    exact.append(SymbolMatch(file=fpath, symbol=s, line_text=line_text.rstrip()))
            elif not exact and len(sub) < max_results and needle in s.name.lower():



                line_text = lines[s.line - 1] if s.line <= len(lines) else ""
                sub.append(SymbolMatch(file=fpath, symbol=s, line_text=line_text.rstrip()))

        if len(exact) >= max_results:
            break

    if exact or not substring_fallback:
        matches, mode = exact, "exact"
    else:
        matches, mode = sub, "substring"

    def _key(m):
        e = 0 if m.symbol.name == name else 1
        return (e, priority.get(m.symbol.kind, 99), m.symbol.line)
    matches.sort(key=_key)
    return SymbolResponse(
        matches=matches,
        total=len(matches),
        files_searched=searched,
        elapsed_ms=(time.monotonic() - t0) * 1000,
        match_mode=mode,
    )




def find_references(
    name: str,
    path: str = ".",
    max_results: int = 100,
    extra_ignore: Optional[list[str]] = None,
) -> SearchResponse:


    return search_text(
        pattern=name,
        path=path,
        whole_word=True,
        literal=True,
        max_results=_safe_int(max_results, 100, 1, MAX_RESULTS_CAP),
        extra_ignore=extra_ignore,
    )




def project_tree(
    path: str = ".",
    depth: int = 3,
    extra_ignore: Optional[list[str]] = None,
) -> dict:
    root = find_project_root(path)
    scope = _resolve_scope(path, root)
    ignore = DEFAULT_IGNORE + (extra_ignore or []) + load_extra_ignore(root)
    depth = _safe_int(depth, 3, 0, MAX_TREE_DEPTH)


    start = root
    if scope is not None:
        start = scope.parent if scope.is_file() else scope

    result: dict = {
        "root": str(start),
        "tree": _build_tree(root, start, depth, ignore),
    }
    if start != root:
        result["project_root"] = str(root)
    return result


def _build_tree(root: Path, current: Path, depth: int, ignore: list[str]) -> list:
    if depth <= 0:
        return [{"name": "...", "type": "truncated"}]

    entries: list = []
    try:
        children = sorted(current.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except (PermissionError, OSError):
        return entries

    for child in children:
        rel = str(child.relative_to(root))
        if should_ignore(child.name, ignore, rel_path=rel):
            continue
        try:
            is_dir = child.is_dir()
        except OSError:
            continue
        if is_dir:
            entries.append({
                "name": child.name,
                "type": "dir",
                "children": _build_tree(root, child, depth - 1, ignore),
            })
        else:
            lang = detect_lang(child)
            entry: dict = {"name": child.name, "type": "file"}
            if lang:
                entry["lang"] = lang
            try:
                entry["size"] = child.stat().st_size
            except OSError:
                pass
            entries.append(entry)

    return entries
