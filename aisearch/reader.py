"""智能文件阅读：按行读、按符号读、获取上下文。"""

from __future__ import annotations

import io
import stat as _stat_mod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Optional

from .config import (
    detect_encoding,
    detect_lang,
    find_project_root,
    is_relative_to,
    read_text_auto,
    safe_resolve,
)
from .symbols import (
    Symbol,
    compute_symbol_end_from_chunk,
    extract_imports,
    extract_symbols,
    find_containing_symbol,
    iter_symbol_decls,
)


MAX_FILE_BYTES = 5 * 1024 * 1024


PREVIEW_LINES = 200


SYMBOL_SCAN_CAP = 200_000


def _file_nf_error(root: Path, full: Path) -> str:
    msg = f"File not found: {full}"
    try:
        rel = full.relative_to(root)
        parts = rel.parts
        if len(parts) > 1 and parts[0] == root.name:
            stripped = root.joinpath(*parts[1:])
            if stripped.is_file():
                msg += (f" (looks double-prefixed with the root's last segment "
                        f"'{root.name}/'; try file \"{'/'.join(parts[1:])}\")")
    except (ValueError, OSError):
        pass
    return msg


MAX_CONTENT_CHARS = 200_000


def _cap_content(text: str) -> tuple[str, bool]:
    if len(text) <= MAX_CONTENT_CHARS:
        return text, False
    return text[:MAX_CONTENT_CHARS], True


def _is_binary(full: Path) -> bool:
    try:
        with open(full, "rb") as f:
            head = f.read(8192)
    except OSError:
        return False
    if head.startswith((b"\xff\xfe", b"\xfe\xff")):
        return False
    return b"\x00" in head


@dataclass
class FileOutline:
    file: str
    language: Optional[str]
    total_lines: int
    symbols: list[Symbol] = field(default_factory=list)

    def to_dict(self) -> dict:
        d: dict = {
            "file": self.file,
            "total_lines": self.total_lines,
        }
        if self.language:
            d["language"] = self.language
        if self.symbols:
            d["symbols"] = [s.to_dict() for s in self.symbols]
        return d


@dataclass
class ReadResult:
    ok: bool = True
    file: str = ""
    language: Optional[str] = None
    start: int = 0
    end: int = 0
    total_lines: int = 0
    content: str = ""
    symbol: Optional[dict] = None
    symbols: list[dict] = field(default_factory=list)
    truncated: bool = False
    window_start: int = 0
    error: str = ""

    def __post_init__(self):

        self.content, capped = _cap_content(self.content)
        if capped:
            self.truncated = True

            kept = self.content.count("\n") + 1
            if self.start:
                self.end = min(self.end, self.start + kept - 1)

    def to_dict(self) -> dict:
        if not self.ok:
            return {"ok": False, "error": self.error}
        d: dict = {
            "ok": True,
            "data": {
                "file": self.file,
                "lines": {"start": self.start, "end": self.end},
                "total_lines": self.total_lines,
                "content": self.content,
            },
        }
        if self.language:
            d["data"]["language"] = self.language
        if self.symbol:
            d["data"]["symbol"] = self.symbol


        if self.symbols:
            d["data"]["symbols"] = self.symbols
        if self.truncated:
            d["data"]["truncated"] = True


        return d


@dataclass
class ContextResult:
    ok: bool = True
    file: str = ""
    line: int = 0
    content: str = ""
    language: Optional[str] = None
    containing_symbol: Optional[dict] = None
    imports: list[str] = field(default_factory=list)
    outline: list[dict] = field(default_factory=list)
    total_lines: int = 0
    window_start: int = 0
    truncated: bool = False
    error: str = ""

    def __post_init__(self):
        self.content, capped = _cap_content(self.content)
        if capped:
            self.truncated = True

    def to_dict(self) -> dict:
        if not self.ok:
            return {"ok": False, "error": self.error}


        d: dict = {
            "ok": True,
            "data": {
                "file": self.file,
                "line": self.line,
            },
        }
        if self.language:
            d["data"]["language"] = self.language
        if self.containing_symbol:
            d["data"]["containing_symbol"] = self.containing_symbol
        if self.imports:
            d["data"]["imports"] = self.imports
        if self.outline:
            d["data"]["file_outline"] = self.outline
        if self.total_lines:
            d["data"]["total_lines"] = self.total_lines
        if self.window_start:
            d["data"]["window_start"] = self.window_start
        if self.truncated:
            d["data"]["truncated"] = True
        d["data"]["content"] = self.content
        return d




def _iter_lines(path: Path, encoding: str) -> Iterator[str]:
    with open(path, "rb") as fb:
        with io.TextIOWrapper(
            io.BufferedReader(fb), encoding=encoding, errors="replace", newline=""
        ) as tw:
            for ln in tw:
                if ln.endswith("\n"):
                    ln = ln[:-1]
                if ln.endswith("\r"):
                    ln = ln[:-1]
                yield ln


def _stream_read_range(path: Path, encoding: str, start: int, end: int) -> str:
    out: list[str] = []
    for i, ln in enumerate(_iter_lines(path, encoding), start=1):
        if i < start:
            continue
        if i > end:
            break
        out.append(ln)
    return "\n".join(out)


def _stream_count_lines(path: Path, encoding: str) -> int:
    return sum(1 for _ in _iter_lines(path, encoding))


def _stream_head(path: Path, encoding: str, preview: int) -> tuple[str, int, bool]:
    keep: list[str] = []
    total = 0
    for ln in _iter_lines(path, encoding):
        total += 1
        if total <= preview:
            keep.append(ln)
    return "\n".join(keep), total, total > preview


def _stream_read_chunk(path: Path, encoding: str, start_line: int, cap: int) -> list[str]:
    out: list[str] = []
    for i, ln in enumerate(_iter_lines(path, encoding), start=1):
        if i < start_line:
            continue
        out.append(ln)
        if len(out) >= cap:
            break
    return out


def _scan_decls_stream(path: Path, encoding: str, lang: Optional[str]) -> list[Symbol]:
    if not lang:
        return []

    def gen() -> Iterator[tuple[int, str]]:
        for i, ln in enumerate(_iter_lines(path, encoding), start=1):
            yield (i, ln)

    return iter_symbol_decls(gen(), lang)




def _resolve_path(
    file_ref: str,
    root: Path,
    boundary: str = "root",
) -> tuple[Path, Optional[int], Optional[int], Optional[str]]:

    try:
        as_whole = safe_resolve(file_ref, root, boundary=boundary)
        if as_whole.is_file():
            return as_whole, None, None, None
    except (ValueError, OSError):
        pass

    path_part = file_ref
    start_line = None
    end_line = None
    symbol_name = None

    if "#" in path_part:
        path_part, symbol_name = path_part.rsplit("#", 1)
        if not symbol_name:
            raise ValueError(f"Empty symbol name after '#' in file reference: {file_ref}")

    if ":" in path_part:


        ci = path_part.rfind(":")
        if ci == 1 and path_part[0].isalpha() and (
            len(path_part) < 3 or path_part[2] in ("\\", "/")
        ):
            ci = -1
        if ci > 1:
            line_spec = path_part[ci + 1 :]
            path_part = path_part[:ci]
            if "-" in line_spec:
                parts = line_spec.split("-", 1)
                try:
                    start_line = int(parts[0])
                    end_line = int(parts[1])
                except ValueError:
                    pass
            else:
                try:
                    start_line = int(line_spec)
                    end_line = start_line
                except ValueError:
                    pass

    full = safe_resolve(path_part, root, boundary=boundary)
    return full, start_line, end_line, symbol_name


def _rel(root: Path, full: Path) -> str:
    if is_relative_to(full, root):
        return str(full.relative_to(root))
    return str(full)


def _read_symbol_from_lines(
    lines: list[str], rel: str, lang: Optional[str], symbol_name: str, total: int,
    human: bool = False,
) -> ReadResult:
    syms = extract_symbols(lines, lang, rel) if lang else []
    sym = None
    if lang:
        sym = next((s for s in syms if s.name == symbol_name), None)
        if sym is None:
            partials = [s for s in syms if symbol_name.lower() in s.name.lower()]
            if len(partials) == 1:
                sym = partials[0]
            elif len(partials) > 1:
                return ReadResult(
                    ok=False,
                    file=rel, language=lang, total_lines=total,
                    error=f"Symbol '{symbol_name}' is ambiguous ({len(partials)} partial matches); "
                          f"candidates: " + ", ".join(s.name for s in partials[:20]),
                    symbols=[x.to_dict() for x in syms],
                )
    if sym:
        s = max(1, sym.line)
        e = min(total, sym.line_end) if sym.line_end else total
        content = "\n".join(lines[s - 1 : e])
        return ReadResult(
            file=rel, language=lang,
            start=s, end=e, total_lines=total,
            content=content,
            symbol=sym.to_dict(),
            symbols=[x.to_dict() for x in syms if x.line_end > 0] if human else [],
        )
    return ReadResult(
        ok=False,
        file=rel, language=lang, total_lines=total,
        error=f"Symbol '{symbol_name}' not found",
        symbols=[x.to_dict() for x in syms] if syms else [],
    )


def _read_symbol_large(
    full: Path, rel: str, lang: Optional[str], symbol_name: str, encoding: str,
    human: bool = False,
) -> ReadResult:
    if not lang:
        return ReadResult(ok=False, file=rel, error=f"Symbol '{symbol_name}' not found (no language)")
    decls = _scan_decls_stream(full, encoding, lang)
    total = _stream_count_lines(full, encoding)

    exact = [s for s in decls if s.name == symbol_name]
    partials = [s for s in decls if symbol_name.lower() in s.name.lower()]
    sym = exact[0] if exact else None
    if sym is None and len(partials) == 1:
        sym = partials[0]
    if sym is None and len(partials) > 1:
        return ReadResult(
            ok=False, file=rel, language=lang, total_lines=total,
            error=f"Symbol '{symbol_name}' is ambiguous ({len(partials)} partial matches); "
                  f"candidates: " + ", ".join(s.name for s in partials[:20]),
            symbols=[x.to_dict() for x in decls],
        )
    if sym is None:
        return ReadResult(
            ok=False, file=rel, language=lang, total_lines=total,
            error=f"Symbol '{symbol_name}' not found",
            symbols=[x.to_dict() for x in decls],
        )

    chunk = _stream_read_chunk(full, encoding, sym.line, SYMBOL_SCAN_CAP)
    end = compute_symbol_end_from_chunk(chunk, lang, sym)
    end = min(end, total)
    span = end - sym.line + 1
    content = "\n".join(chunk[:span]) if span > 0 else ""
    return ReadResult(
        file=rel, language=lang,
        start=sym.line, end=end, total_lines=total,
        content=content,
        symbol=sym.to_dict(),
        symbols=[x.to_dict() for x in decls] if human else [],
    )


def read_file(
    file_ref: str,
    path: str = ".",
    outline_only: bool = False,
    boundary: str = "root",
    human: bool = False,
) -> ReadResult:
    root = find_project_root(path)
    try:
        full, start_line, end_line, symbol_name = _resolve_path(file_ref, root, boundary=boundary)
    except ValueError as e:
        return ReadResult(ok=False, error=str(e))



    try:
        st = full.stat()
    except FileNotFoundError:
        return ReadResult(ok=False, error=_file_nf_error(root, full))
    except OSError as e:
        return ReadResult(ok=False, error=str(e))
    if not _stat_mod.S_ISREG(st.st_mode):
        return ReadResult(ok=False, error=f"Not a file: {full}")

    rel = _rel(root, full)
    lang = detect_lang(full)
    large = st.st_size > MAX_FILE_BYTES


    if _is_binary(full):
        return ReadResult(
            ok=False, file=rel, language=lang, total_lines=0,
            error=f"Binary file ({st.st_size} bytes); not text",
        )


    if symbol_name:
        if large:
            enc = detect_encoding(full)
            return _read_symbol_large(full, rel, lang, symbol_name, enc, human=human)
        text = read_text_auto(full)
        lines = text.splitlines()
        total = len(lines)
        return _read_symbol_from_lines(lines, rel, lang, symbol_name, total, human=human)


    if outline_only:
        if large:
            enc = detect_encoding(full)
            decls = _scan_decls_stream(full, enc, lang)
            return ReadResult(
                file=rel, language=lang,
                start=1, end=0, total_lines=_stream_count_lines(full, enc),
                content="", symbols=[x.to_dict() for x in decls],
            )
        text = read_text_auto(full)
        lines = text.splitlines()
        total = len(lines)
        syms = extract_symbols(lines, lang, rel) if lang else []
        return ReadResult(
            file=rel, language=lang,
            start=1, end=total, total_lines=total,
            content="", symbols=[x.to_dict() for x in syms],
        )


    if start_line and end_line and start_line > end_line:
        return ReadResult(
            ok=False, file=rel, language=lang,
            error=f"Invalid line range: {start_line} > {end_line}",
        )


    if large:
        enc = detect_encoding(full)
        total = _stream_count_lines(full, enc)
        if start_line and end_line:
            content = _stream_read_range(full, enc, start_line, end_line)
            s = max(1, start_line)
            e = min(total, end_line)
            e = max(e, s)
            return ReadResult(
                file=rel, language=lang,
                start=s, end=e, total_lines=total,
                content=content, truncated=(end_line < total),
            )
        content, total, truncated = _stream_head(full, enc, PREVIEW_LINES)
        return ReadResult(
            file=rel, language=lang,
            start=1, end=min(PREVIEW_LINES, total), total_lines=total,
            content=content, truncated=truncated,
        )


    try:
        text = read_text_auto(full)
    except (OSError, PermissionError) as e:
        return ReadResult(ok=False, error=str(e))

    lines = text.splitlines()
    total = len(lines)

    s = start_line or 1
    e = end_line or total
    s = max(1, s)
    e = min(total, e)
    if s > total:
        return ReadResult(
            ok=False, file=rel, language=lang, total_lines=total,
            error=f"Start line {s} beyond end of file ({total} lines)",
        )
    e = max(e, s)

    content = "\n".join(lines[s - 1 : e])
    return ReadResult(
        file=rel, language=lang,
        start=s, end=e, total_lines=total,
        content=content,
    )




def get_context(
    file_ref: str,
    line: int,
    path: str = ".",
    radius: int = 5,
    boundary: str = "root",
    human: bool = False,
) -> ContextResult:
    root = find_project_root(path)



    try:
        full, _s, _e, _sym = _resolve_path(file_ref, root, boundary=boundary)
    except ValueError as e:
        return ContextResult(ok=False, error=str(e))


    try:
        st = full.stat()
    except FileNotFoundError:
        return ContextResult(ok=False, error=_file_nf_error(root, full))
    except OSError as e:
        return ContextResult(ok=False, error=str(e))
    if not _stat_mod.S_ISREG(st.st_mode):
        return ContextResult(ok=False, error=f"Not a file: {full}")


    radius = max(0, min(int(radius), 200))

    rel = _rel(root, full)
    lang = detect_lang(full)
    large = st.st_size > MAX_FILE_BYTES


    if _is_binary(full):
        return ContextResult(
            ok=False, file=rel, language=lang, line=line,
            error=f"Binary file ({st.st_size} bytes); not text",
        )


    if large:
        enc = detect_encoding(full)
        total = _stream_count_lines(full, enc)
        if line < 1 or line > total:
            return ContextResult(ok=False, error=f"Line {line} out of range (1-{total})")
        window_start = max(1, line - radius)
        window_end = line + radius
        content = _stream_read_range(full, enc, window_start, window_end)
        return ContextResult(
            file=rel, line=line, content=content, language=lang,
            total_lines=total, window_start=window_start,
        )


    try:
        text = read_text_auto(full)
    except (OSError, PermissionError) as e:
        return ContextResult(ok=False, error=str(e))

    lines = text.splitlines()
    total = len(lines)
    if line < 1 or line > total:
        return ContextResult(ok=False, error=f"Line {line} out of range (1-{total})")


    containing_sym = None
    if lang:
        sym = find_containing_symbol(lines, lang, line)
        if sym:
            containing_sym = sym.to_dict()


    imports = extract_imports(lines, lang) if lang else []


    outline = []
    if lang and human:
        syms = extract_symbols(lines, lang, rel)
        outline = [s.to_dict() for s in syms]


    ctx_start = max(0, line - 1 - radius)
    ctx_end = min(total, line + radius)
    ctx_content = "\n".join(lines[ctx_start:ctx_end])

    return ContextResult(
        file=rel,
        line=line,
        content=ctx_content,
        language=lang,
        containing_symbol=containing_sym,
        imports=imports,
        outline=outline,
        total_lines=total,
        window_start=ctx_start + 1,
    )
