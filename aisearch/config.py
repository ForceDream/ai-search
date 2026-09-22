"""语言检测、忽略规则、项目根查找、路径安全。"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional


DEFAULT_IGNORE: list[str] = [
    ".git", ".svn", ".hg",
    "node_modules", "__pycache__", ".pytest_cache",
    ".mypy_cache", ".tox", ".eggs", ".ruff_cache",
    "dist", "build", "target", "out", ".repoctx",
    ".venv", "venv", "env", ".env",
    ".idea", ".vscode", ".vs",
    ".DS_Store", "Thumbs.db",
    "vendor", "Pods", ".next", ".nuxt",
]


EXT_LANG: dict[str, str] = {
    ".py": "python", ".pyi": "python",
    ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript",
    ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".php": "php",
    ".c": "c", ".h": "c",
    ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
    ".cs": "csharp",
    ".swift": "swift",
    ".scala": "scala", ".sc": "scala",
    ".sh": "shell", ".bash": "shell", ".zsh": "shell",
    ".lua": "lua",
    ".r": "r", ".R": "r",
    ".ex": "elixir", ".exs": "elixir",
    ".erl": "erlang",
    ".hs": "haskell",
    ".dart": "dart",
    ".zig": "zig",
    ".nim": "nim",
    ".vue": "vue",
    ".svelte": "svelte",
    ".html": "html", ".htm": "html",
    ".css": "css", ".scss": "scss", ".less": "less",
    ".json": "json",
    ".yaml": "yaml", ".yml": "yaml",
    ".toml": "toml",
    ".xml": "xml",
    ".md": "markdown", ".mdx": "markdown",
    ".sql": "sql",
    ".proto": "protobuf",
    ".graphql": "graphql", ".gql": "graphql",
    ".tf": "terraform",
    ".dockerfile": "dockerfile",
}


CODE_EXTS: set[str] = set(EXT_LANG.keys())




def detect_lang(path: str | Path) -> Optional[str]:
    p = Path(path)

    name = p.name.lower()
    if name in ("dockerfile", "makefile", "rakefile", "gemfile"):
        return name
    if name.endswith(".dockerfile"):
        return "dockerfile"
    return EXT_LANG.get(p.suffix.lower())


def should_ignore(name: str, ignore_list: list[str], rel_path: str = "") -> bool:


    rel_norm = rel_path.replace("\\", "/") if rel_path else ""
    for pat in ignore_list:
        pat_norm = pat.replace("\\", "/")
        if pat.startswith("*."):
            if name.endswith(pat[1:]) or name == pat[2:]:
                return True
        elif "/" in pat_norm:
            if rel_norm and (rel_norm == pat_norm or rel_norm.startswith(pat_norm + "/")):
                return True
        elif pat == name:
            return True
    return False


def find_project_root(start: str = ".") -> Path:
    markers = [
        ".git", "pyproject.toml", "setup.py", "setup.cfg",
        "package.json", "Cargo.toml", "go.mod", "pom.xml",
        "build.gradle", "build.gradle.kts", "Makefile",
        ".aisearch.json",
    ]
    cur = Path(start).resolve()
    while True:
        for m in markers:
            if (cur / m).exists():
                return cur
        parent = cur.parent
        if parent == cur:
            return Path(start).resolve()
        cur = parent


def load_extra_ignore(root: Path) -> list[str]:
    ignore_file = root / ".aisearchignore"
    if not ignore_file.exists():
        return []

    try:
        text = ignore_file.read_text(encoding="utf-8", errors="replace")
    except (OSError, PermissionError):
        return []
    patterns: list[str] = []
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            patterns.append(line.rstrip("/"))
    return patterns


def is_output_tty() -> bool:
    return sys.stdout.isatty()


def is_relative_to(path: Path, other: Path) -> bool:
    try:
        path.relative_to(other)
        return True
    except ValueError:
        return False


def detect_encoding(path, chunk: int = 65536) -> str:
    data = b""
    try:
        with open(path, "rb") as f:
            data = f.read(chunk)
    except OSError:
        return "utf-8"
    if data.startswith(b"\xef\xbb\xbf"):
        return "utf-8-sig"
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return "utf-16"
    try:
        data.decode("utf-8")
        return "utf-8"
    except UnicodeDecodeError:
        pass
    try:
        data.decode("gb18030")
        return "gb18030"
    except UnicodeDecodeError:
        pass
    return "utf-8"


def read_text_auto(path) -> str:
    enc = detect_encoding(path)
    try:
        return Path(path).read_text(encoding=enc, errors="replace")
    except (OSError, PermissionError) as e:
        raise


def safe_resolve(ref: str, root: Path, boundary: str = "root") -> Path:
    if "\x00" in ref:
        raise ValueError("Path contains NUL byte")


    p = Path(ref)
    full = (p if p.is_absolute() else (root / ref)).resolve()

    if boundary == "root":
        root_resolved = root.resolve()
        if not is_relative_to(full, root_resolved):
            raise ValueError(f"Path '{ref}' escapes project root")
    return full


def build_file_list(
    root: Path,
    extensions: Optional[set[str]] = None,
    ignore: Optional[list[str]] = None,
) -> list[str]:
    ignore = ignore or DEFAULT_IGNORE
    files: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        cur = Path(dirpath)


        dirnames[:] = sorted(
            d for d in dirnames if not should_ignore(d, ignore, rel_path=_rel_of(cur / d, root))
        )
        for fn in sorted(filenames):
            fp = cur / fn
            rel = _rel_of(fp, root)
            if should_ignore(fn, ignore, rel_path=rel):
                continue
            if extensions and fp.suffix.lower() not in extensions:
                continue
            files.append(rel)
    return files


def _rel_of(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)
