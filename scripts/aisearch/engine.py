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

# ── 数据结构 ────────────────────────────────────────

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


# ── 参数归一化 / 防护 ──────────────────────────────

MAX_RESULTS_CAP = 5000      # 单次查询结果上限，防止 DoS
MAX_TREE_DEPTH = 16         # 目录树深度上限，防止递归爆炸
MAX_CONTEXT_LINES = 200     # 上下文行数上限
MAX_PATTERN_LEN = 256       # 搜索模式长度上限：缓解 ReDoS 回溯爆炸
                            # 与超长模式拖慢 rg（rg 路径同样受益）

# 嵌套量词（(a+)+ 、(a*)* 、(a+){2,} 等）会让回溯引擎指数级爆炸——单个
# search() 即可挂死进程，长度上限挡不住。rg 是线性引擎不受影响，故仅在
# Python 正则回退路径拒绝这类模式。
_REDOS_RE = re.compile(r"\([^()]*[*+][^()]*\)\s*(?:[*+]|\{\d+,\})")


def _safe_int(value, default: int, lo: int, hi: int) -> int:
    """把任意输入安全地转成 [lo, hi] 区间内的整数，非法输入回退默认值。"""
    try:
        n = int(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return max(lo, min(hi, n))


# ── ripgrep 检测 ────────────────────────────────────

_has_rg: Optional[bool] = None

def has_ripgrep() -> bool:
    global _has_rg
    if _has_rg is None:
        # AISEARCH_NO_RG=1 强制走纯实现（基准测试 / 调试用）
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


# ── ripgrep JSON 解析 ───────────────────────────────

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
) -> SearchResponse:
    t0 = time.monotonic()
    cmd = [
        "rg", "--json",
        "-C", str(context_lines),
        "--max-count", str(max(1, max_results * 3)),  # 多取一些，后面截断
    ]
    if case_insensitive:
        cmd.append("-i")
    if whole_word:
        cmd.append("-w")
    if extensions:
        for ext in extensions:
            cmd.extend(["-g", f"*{ext}"])

    # 添加 ignore 目录
    for ig in ignore:
        cmd.extend(["--glob", f"!{ig}"])

    # -e 显式传模式：防止以 "-" 开头的 pattern 被解析为 rg flag（参数注入）
    cmd.extend(["-e", pattern])
    # 搜索范围：scope（文件/子目录）以 root 为基准传入；否则整个 root（"."）
    cmd.append("." if scope is None else _rel_to(root, scope))

    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, timeout=30,
            cwd=str(root),  # 关键：在 root 内搜索，glob 与输出路径都以 root 为基准，
                            # 与调用方 cwd 无关（可移植性）
        )
    except subprocess.TimeoutExpired:
        return SearchResponse(ok=False, error="Search timed out (30s)")

    # ripgrep 非 0 退出通常表示正则无效或严重错误
    if proc.returncode not in (0, 1):
        err = proc.stderr.strip().splitlines()
        msg = err[-1] if err else f"ripgrep exited with {proc.returncode}"
        return SearchResponse(ok=False, error=msg)

    matches: list[Match] = []
    files_searched: set[str] = set()
    current_file = ""
    context_buf: list[str] = []
    in_context_before = True

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
            current_file = data.get("path", {}).get("text", "")
            files_searched.add(current_file)
            context_buf = []
            in_context_before = True

        elif msg_type == "match":
            path_text = data.get("path", {}).get("text", "")
            line_num = data.get("line_number", 0)
            line_content = data.get("lines", {}).get("text", "").rstrip("\n")
            subs = data.get("submatches", [])
            col = subs[0]["start"] if subs else 0

            rel_path = _rel_path(path_text, root)

            m = Match(
                file=rel_path,
                line=line_num,
                col=col,
                text=line_content,
                context_before=list(context_buf),
            )
            matches.append(m)
            context_buf = []
            in_context_before = False

        elif msg_type == "context":
            ctx_line = data.get("lines", {}).get("text", "").rstrip("\n")
            if in_context_before:
                context_buf.append(ctx_line)
                if len(context_buf) > context_lines:
                    context_buf.pop(0)
            else:
                if matches and len(matches[-1].context_after) < context_lines:
                    matches[-1].context_after.append(ctx_line)

        elif msg_type == "end":
            in_context_before = True
            context_buf = []

    # 截断
    matches = matches[:max_results]

    elapsed = (time.monotonic() - t0) * 1000
    return SearchResponse(
        matches=matches,
        total=len(matches),
        files_searched=len(files_searched),
        elapsed_ms=elapsed,
    )


def _rel_path(full: str, root: Path) -> str:
    # cwd=root 模式下 rg 返回相对路径，去掉可能存在的 "./" 前缀
    p = full[2:] if full.startswith("./") else full
    try:
        return str(Path(p).relative_to(root))
    except ValueError:
        return p


def _rel_to(root: Path, p: Path) -> str:
    """把 p 表示为相对 root 的路径；不在 root 内时返回其字符串形式。"""
    try:
        return str(Path(p).relative_to(root))
    except ValueError:
        return str(p)


def _resolve_scope(path: str, root: Path) -> Optional[Path]:
    """把 path 解析为"搜索范围"，使 path 能限定到单文件或子目录。

    返回：
      * 文件路径        → 只搜该文件
      * root 内的目录   → 只搜该子树
      * 其它（含 None） → 搜整个项目 root（保持原有"以项目根为工作目录"语义）

    安全：仅接受 root 内的目录，避免 path="." 恰好位于项目之上时把整盘当范围。
    """
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


# ── Python regex 回退 ───────────────────────────────

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
        if whole_word:
            pat = re.compile(rf"\b{re.escape(pattern)}\b", flags)
        else:
            pat = re.compile(pattern, flags)
    except re.error as e:
        return SearchResponse(ok=False, error=f"Invalid regex: {e}")

    # 搜索范围：scope 为文件 → 只搜该文件；为目录 → 只搜该子树；否则整个 root
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


# ── 公开 API：文本搜索 ─────────────────────────────

def search_text(
    pattern: str,
    path: str = ".",
    extensions: Optional[set[str]] = None,
    context_lines: int = 2,
    case_insensitive: bool = False,
    max_results: int = 50,
    whole_word: bool = False,
    extra_ignore: Optional[list[str]] = None,
) -> SearchResponse:
    root = find_project_root(path)
    scope = _resolve_scope(path, root)
    ignore = DEFAULT_IGNORE + (extra_ignore or []) + load_extra_ignore(root)

    # 空 pattern 会让 rg 匹配每一行，属于误用，直接拒绝
    if not pattern or not pattern.strip():
        return SearchResponse(ok=False, error="Empty search pattern")

    if len(pattern) > MAX_PATTERN_LEN:
        return SearchResponse(
            ok=False,
            error=f"Search pattern too long ({len(pattern)} chars > {MAX_PATTERN_LEN})",
        )

    # 参数归一化，防止负数 / 非法值 / DoS
    context_lines = _safe_int(context_lines, 2, 0, MAX_CONTEXT_LINES)
    max_results = _safe_int(max_results, 50, 1, MAX_RESULTS_CAP)

    if has_ripgrep():
        return _search_with_rg(
            pattern, root, scope, extensions, ignore,
            context_lines, case_insensitive, max_results, whole_word,
        )
    else:
        return _search_with_regex(
            pattern, root, scope, extensions, ignore,
            context_lines, case_insensitive, max_results, whole_word,
        )


# ── 公开 API：符号搜索 ─────────────────────────────

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
    # def 专用：exact=候选全部来自精确同名；substring=已回退子串匹配（需核对候选）
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


def search_symbols(
    name: str,
    path: str = ".",
    kind: Optional[str] = None,
    max_results: int = 50,
    extra_ignore: Optional[list[str]] = None,
    partial: bool = True,
) -> SymbolResponse:
    """
    搜索代码符号（函数、类、结构体等）。

    partial=True 时按子串（大小写不敏感）匹配，更适合 AI 模糊查找；
    partial=False 时仅精确匹配同名符号。
    """
    if partial:
        needle = name.lower()
    t0 = time.monotonic()
    root = find_project_root(path)
    scope = _resolve_scope(path, root)
    ignore = DEFAULT_IGNORE + (extra_ignore or []) + load_extra_ignore(root)
    max_results = _safe_int(max_results, 50, 1, MAX_RESULTS_CAP)

    # 搜索范围：scope 为文件 → 只搜该文件；为目录 → 只搜该子树；否则整个 root
    if scope is not None and scope.is_file():
        base, names = scope.parent, [scope.name]
    elif scope is not None:
        base, names = scope, build_file_list(scope, None, ignore)
    else:
        base, names = root, build_file_list(root, None, ignore)
    prefix = "" if base == root else _rel_to(root, base)
    if prefix in (".", ""):
        prefix = ""

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


# ── 公开 API：查找定义 ─────────────────────────────

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
    resp = search_symbols(name, path, max_results=max_results,
                          extra_ignore=extra_ignore, partial=False)
    mode = "exact"
    if not resp.matches and substring_fallback:
        resp = search_symbols(name, path, max_results=max_results,
                              extra_ignore=extra_ignore, partial=True)
        mode = "substring"

    def _key(m):
        exact = 0 if m.symbol.name == name else 1
        return (exact, priority.get(m.symbol.kind, 99), m.symbol.line)
    resp.matches.sort(key=_key)
    resp.match_mode = mode
    return resp


# ── 公开 API：查找引用 ─────────────────────────────

def find_references(
    name: str,
    path: str = ".",
    max_results: int = 100,
    extra_ignore: Optional[list[str]] = None,
) -> SearchResponse:
    """查找符号的所有引用（使用文本搜索）。"""
    return search_text(
        pattern=name,
        path=path,
        whole_word=True,
        max_results=_safe_int(max_results, 100, 1, MAX_RESULTS_CAP),
        extra_ignore=extra_ignore,
    )


# ── 公开 API：项目树 ───────────────────────────────

def project_tree(
    path: str = ".",
    depth: int = 3,
    extra_ignore: Optional[list[str]] = None,
) -> dict:
    root = find_project_root(path)
    scope = _resolve_scope(path, root)
    ignore = DEFAULT_IGNORE + (extra_ignore or []) + load_extra_ignore(root)
    depth = _safe_int(depth, 3, 0, MAX_TREE_DEPTH)

    # 传入子目录/文件时以它为显示起点（ignore 的相对路径仍以项目根为基准）
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
