"""
正则驱动的符号提取 —— 不需要 LSP，开箱即用。
支持 tree-sitter 可选增强（未来扩展，当前以正则为主，零依赖）。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

from .config import detect_lang



MAX_SYMBOLS_PER_FILE = 5000



@dataclass
class Symbol:
    kind: str
    name: str
    line: int
    line_end: int = 0
    col: int = 0
    indent: int = 0
    parent: str = ""

    def to_dict(self) -> dict:
        d: dict = {"kind": self.kind, "name": self.name, "line": self.line}
        if self.line_end:
            d["line_end"] = self.line_end
        if self.parent:
            d["parent"] = self.parent
        return d




_LangPatterns = list[tuple[str, str, int]]

PYTHON_PATTERNS: _LangPatterns = [
    ("class",     r"^(\s*)class\s+(\w+)", 2),
    ("function",  r"^(\s*)(?:async\s+)?def\s+(\w+)", 2),
]


_JS_KW = r"get|set|if|for|while|switch|catch|return|typeof|new|do|else|await|class|function|with|try|finally|throw|delete|yield|using|lock"

JAVASCRIPT_PATTERNS: _LangPatterns = [
    ("class",    r"^(\s*)(?:export\s+(?:default\s+)?)?class\s+(\w+)", 2),
    ("function", r"^(\s*)(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)", 2),
    ("function", r"^(\s*)(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(", 2),
    ("function", r"^(\s*)(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>", 2),


    ("method",   r"^(\s*)(?:async\s+)?(?!(?:" + _JS_KW + r")\b)(\w+)\s*\([^)]*\)\s*[\{:]", 2),
]

TYPESCRIPT_EXTRA: _LangPatterns = [
    ("interface", r"^(\s*)(?:export\s+)?interface\s+(\w+)", 2),


    ("type",      r"^(\s*)(?:export\s+)?type\s+(\w+)\s*[=<{]", 2),
    ("enum",      r"^(\s*)(?:export\s+)?(?:const\s+)?enum\s+(\w+)", 2),
]

GO_PATTERNS: _LangPatterns = [
    ("function",  r"^(\s*)func\s+(?:\([^)]+\)\s+)?(\w+)", 2),
    ("struct",    r"^(\s*)type\s+(\w+)\s+struct", 2),
    ("interface", r"^(\s*)type\s+(\w+)\s+interface", 2),
    ("type",      r"^(\s*)type\s+(\w+)", 2),
]

RUST_PATTERNS: _LangPatterns = [
    ("function",  r"^(\s*)(?:pub\s+)?(?:async\s+)?(?:const\s+)?fn\s+(\w+)", 2),
    ("struct",    r"^(\s*)(?:pub\s+)?struct\s+(\w+)", 2),
    ("enum",      r"^(\s*)(?:pub\s+)?enum\s+(\w+)", 2),
    ("trait",     r"^(\s*)(?:pub\s+)?trait\s+(\w+)", 2),



    ("impl",      r"^(\s*)impl(?:\s*<[^>]*>)?\s+(?:.*?\sfor\s+)?(\w+)\s*(?:<[^>]*>)?\s*(?:\{|where|$)", 2),
    ("type",      r"^(\s*)(?:pub\s+)?type\s+(\w+)", 2),
    ("macro",     r"^(\s*)(?:pub\s+)?macro_rules!\s+(\w+)", 2),
]

JAVA_PATTERNS: _LangPatterns = [
    ("class",     r"^\s*(?:public\s+)?(?:abstract\s+)?(?:final\s+)?class\s+(\w+)", 1),
    ("interface", r"^\s*(?:public\s+)?interface\s+(\w+)", 1),
    ("enum",      r"^\s*(?:public\s+)?enum\s+(\w+)", 1),
    ("method",    r"^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?[\w<>\[\],\s]+\s+(\w+)\s*\(", 1),
]

CPP_EXTRA: _LangPatterns = [
    ("class",     r"^\s*(?:class|struct)\s+(\w+)", 1),
    ("function",  r"^\s*[\w~:*&]+\s+(?:[\w:*&]+\s+)*(\w+)\s*\([^)]*\)\s*(?:const\s*)?(?:override\s*)?\{", 1),
    ("namespace", r"^\s*namespace\s+(\w+)", 1),
]

RUBY_PATTERNS: _LangPatterns = [
    ("class",   r"^\s*class\s+(\w+)", 1),
    ("module",  r"^\s*module\s+(\w+)", 1),
    ("method",  r"^\s*def\s+(\w+)", 1),
]

PHP_PATTERNS: _LangPatterns = [
    ("class",     r"^\s*(?:abstract\s+)?class\s+(\w+)", 1),
    ("interface", r"^\s*interface\s+(\w+)", 1),
    ("trait",     r"^\s*trait\s+(\w+)", 1),
    ("function",  r"^\s*(?:public|protected|private)\s+(?:static\s+)?function\s+(\w+)", 1),
]

C_PATTERNS: _LangPatterns = [
    ("struct",   r"^\s*struct\s+(\w+)", 1),
    ("function", r"^\s*[\w\*]+\s+[\w\*]+\s+(\w+)\s*\([^)]*\)\s*\{", 1),
]

SHELL_PATTERNS: _LangPatterns = [
    ("function", r"^(?:function\s+)?(\w+)\s*\(\s*\)", 1),
]

LANG_PATTERNS: dict[str, _LangPatterns] = {
    "python": PYTHON_PATTERNS,
    "javascript": JAVASCRIPT_PATTERNS,
    "typescript": JAVASCRIPT_PATTERNS + TYPESCRIPT_EXTRA,
    "go": GO_PATTERNS,
    "rust": RUST_PATTERNS,
    "java": JAVA_PATTERNS,
    "ruby": RUBY_PATTERNS,
    "php": PHP_PATTERNS,
    "c": C_PATTERNS,
    "cpp": CPP_EXTRA,
    "csharp": JAVA_PATTERNS,
    "shell": SHELL_PATTERNS,
    "lua": [("function", r"^(\s*)(?:local\s+)?function\s+(\w+)", 2)],
    "swift": [
        ("class",    r"^\s*(?:public\s+)?class\s+(\w+)", 1),
        ("struct",   r"^\s*(?:public\s+)?struct\s+(\w+)", 1),
        ("protocol", r"^\s*(?:public\s+)?protocol\s+(\w+)", 1),
        ("function", r"^\s*(?:public\s+)?(?:static\s+)?func\s+(\w+)", 1),
    ],
    "kotlin": JAVA_PATTERNS + [
        ("function", r"^\s*(?:suspend\s+)?fun\s+(\w+)", 1),
    ],
    "scala": [
        ("class",     r"^\s*(?:case\s+)?class\s+(\w+)", 1),
        ("object",    r"^\s*object\s+(\w+)", 1),
        ("trait",     r"^\s*trait\s+(\w+)", 1),
        ("function",  r"^\s*def\s+(\w+)", 1),
    ],
}




@dataclass
class _CompiledPattern:
    kind: str
    regex: re.Pattern
    group: int

_compiled_cache: dict[str, list[_CompiledPattern]] = {}

def _get_compiled(lang: str) -> list[_CompiledPattern]:
    if lang in _compiled_cache:
        return _compiled_cache[lang]
    patterns = LANG_PATTERNS.get(lang, [])
    compiled = []
    for kind, pat, grp in patterns:
        compiled.append(_CompiledPattern(kind, re.compile(pat), grp))
    _compiled_cache[lang] = compiled
    return compiled




def extract_symbols(
    lines: list[str],
    lang: str,
    file_path: str = "",
) -> list[Symbol]:
    """从源代码行列表中提取所有符号。"""
    compiled = _get_compiled(lang)
    if not compiled:
        return []

    symbols: list[Symbol] = []
    current_class = ""

    for idx, line in enumerate(lines):
        if len(symbols) >= MAX_SYMBOLS_PER_FILE:
            break
        lineno = idx + 1
        stripped = line.rstrip()
        if not stripped:
            continue
        ls = stripped.lstrip()

        if ls.startswith("#") or ls.startswith("//") or ls.startswith("--"):
            continue

        indent = len(line) - len(line.lstrip())

        for cp in compiled:
            m = cp.regex.match(stripped)
            if m:
                name = m.group(cp.group) if cp.group else cp.kind
                if not name:
                    continue

                sym = Symbol(
                    kind=cp.kind,
                    name=name,
                    line=lineno,
                    indent=indent,
                )


                if cp.kind in ("class", "struct", "interface", "trait", "enum", "module", "namespace", "object"):
                    current_class = name
                elif indent > 0 and current_class:
                    sym.parent = current_class

                symbols.append(sym)
                break


    _calc_ranges(symbols, lines, lang)

    return symbols


def iter_symbol_decls(line_iter, lang, file_path: str = "", max_symbols: int = MAX_SYMBOLS_PER_FILE):
    """
    流式扫描符号声明（line_end 置 0，不计算范围），用于大文件避免整文件载入内存。
    line_iter 产出 (lineno, line) 元组。
    """
    compiled = _get_compiled(lang)
    if not compiled:
        return []
    symbols: list[Symbol] = []
    current_class = ""
    for lineno, line in line_iter:
        if len(symbols) >= max_symbols:
            break
        stripped = line.rstrip()
        if not stripped:
            continue
        ls = stripped.lstrip()
        if ls.startswith("#") or ls.startswith("//") or ls.startswith("--"):
            continue
        indent = len(line) - len(line.lstrip())
        for cp in compiled:
            m = cp.regex.match(stripped)
            if m:
                name = m.group(cp.group) if cp.group else cp.kind
                if not name:
                    continue
                sym = Symbol(kind=cp.kind, name=name, line=lineno, indent=indent)
                if cp.kind in ("class", "struct", "interface", "trait", "enum", "module", "namespace", "object"):
                    current_class = name
                elif indent > 0 and current_class:
                    sym.parent = current_class
                symbols.append(sym)
                break
    return symbols


def compute_symbol_end_from_chunk(chunk: list[str], lang: str, sym: Symbol) -> int:
    """
    在从 sym.line 起头的行块上复用 _calc_ranges 推算结束行，并映射回原文行号。
    当块被截断（line_end == len(chunk)）时返回截断处，调用方应再按 total 收敛。
    """
    temp = Symbol(kind=sym.kind, name=sym.name, line=1, indent=sym.indent)
    _calc_ranges([temp], chunk, lang)
    return sym.line - 1 + temp.line_end


def _calc_ranges(symbols: list[Symbol], lines: list[str], lang: str):
    """推算每个符号的结束行：花括号语言按配平计数，缩进语言按缩进扫描。"""
    if not symbols:
        return

    brace_langs = {
        "javascript", "typescript", "java", "go", "rust", "c", "cpp",
        "csharp", "swift", "kotlin", "scala", "php", "ruby",
    }
    n = len(lines)

    if lang in brace_langs:





        delta = [0] * n
        opens = [False] * n
        for j in range(n):
            line = lines[j]
            d = 0
            has = False
            for ch in line:
                if ch == '{':
                    d += 1
                    has = True
                elif ch == '}':
                    d -= 1
            delta[j] = d
            opens[j] = has
        depth = [0] * (n + 1)
        for j in range(n):
            depth[j + 1] = depth[j] + delta[j]

        next_open = [n] * (n + 1)
        for j in range(n - 1, -1, -1):
            next_open[j] = j if opens[j] else next_open[j + 1]







        activate_at: dict[int, list[tuple[int, int]]] = {}
        activated: set[int] = set()
        for idx, sym in enumerate(symbols):
            start0 = sym.line - 1
            act = next_open[start0]
            if act < n:
                activate_at.setdefault(act, []).append((idx, depth[start0]))
                activated.add(idx)

        end_of: dict[int, int] = {}
        active: dict[int, list[int]] = {}
        max_base: Optional[int] = None
        for j in range(n):
            for idx, b in activate_at.get(j, ()):
                active.setdefault(b, []).append(idx)
                if max_base is None or b > max_base:
                    max_base = b
            d_after = depth[j + 1]

            while max_base is not None and max_base >= d_after:
                for idx in active.pop(max_base, ()):
                    end_of[idx] = j + 1
                max_base = max(active) if active else None

        for idx, sym in enumerate(symbols):
            if idx in end_of:
                e = end_of[idx]
            elif idx in activated:
                e = n
            else:
                e = sym.line - 1
            sym.line_end = max(e, sym.line)
    else:
        for sym in symbols:



            base_indent = sym.indent
            j0 = sym.line - 1
            header_end = j0
            header_done = False
            bal = 0
            for j in range(j0, n):
                stripped = lines[j].rstrip()
                bal += stripped.count("(") - stripped.count(")")
                header_end = j
                if bal <= 0 and stripped.endswith(":"):
                    header_done = True
                    break
            body_start = (header_end + 1) if header_done else sym.line

            end = sym.line
            for j in range(body_start, n):
                l = lines[j]
                if l.strip() == '':
                    end = j + 1
                    continue
                cur_indent = len(l) - len(l.lstrip())
                if cur_indent > base_indent:
                    end = j + 1
                else:
                    break

            while end > sym.line and lines[end - 1].strip() == "":
                end -= 1
            sym.line_end = max(end, sym.line)


def find_symbol_by_name(
    lines: list[str],
    lang: str,
    name: str,
    partial: bool = False,
) -> Optional[Symbol]:
    """查找特定名称的符号（partial=True 时支持子串匹配）。"""
    syms = extract_symbols(lines, lang)
    for s in syms:
        if partial:
            if name.lower() in s.name.lower():
                return s
        elif s.name == name:
            return s
    return None


def find_containing_symbol(
    lines: list[str],
    lang: str,
    target_line: int,
) -> Optional[Symbol]:
    """查找包含 target_line 的最小范围符号。"""
    syms = extract_symbols(lines, lang)
    best: Optional[Symbol] = None
    best_size = float("inf")

    for s in syms:
        if s.line <= target_line <= s.line_end:
            size = s.line_end - s.line
            if size < best_size:
                best = s
                best_size = size
    return best


def extract_imports(lines: list[str], lang: str) -> list[str]:
    """提取 import 语句。"""
    imports: list[str] = []






    if lang == "go":
        in_block = False
        for line in lines:
            s = line.strip()
            if in_block:
                if s.startswith(")"):
                    in_block = False
                else:
                    m = re.match(r'(?:(\w+)\s+)?"([^"]+)"', s)
                    if m:
                        imports.append(m.group(1) + " " + m.group(2) if m.group(1) else m.group(2))
                continue
            m = re.match(r'import\s+\($', s)
            if m:
                in_block = True
                continue
            m = re.match(r'import\s+"([^"]+)"', s)
            if m:
                imports.append(m.group(1))
        return imports

    patterns = {
        "python": re.compile(r"^\s*(?:from\s+\S+\s+)?import\s+(.+)"),
        "javascript": re.compile(r"""^\s*import\s+.*from\s+['"](.+)['"]"""),
        "typescript": re.compile(r"""^\s*import\s+.*from\s+['"](.+)['"]"""),
        "rust": re.compile(r"^\s*use\s+(.+)"),
        "java": re.compile(r"^\s*import\s+([\w.]+)"),
    }
    pat = patterns.get(lang)
    if not pat:
        return imports
    for line in lines:
        m = pat.match(line.rstrip())
        if m:
            raw = m.group(1).strip() if m.group(1) else line.strip()
            imports.append(raw)
    return imports
