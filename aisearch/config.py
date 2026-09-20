"""语言检测、忽略规则、项目根查找、路径安全。"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional

# ── 默认忽略目录/文件 ──────────────────────────────
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

# ── 扩展名 → 语言 ──────────────────────────────────
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

# 扩展名集合，用于快速过滤
CODE_EXTS: set[str] = set(EXT_LANG.keys())


# ── 工具函数 ────────────────────────────────────────

def detect_lang(path: str | Path) -> Optional[str]:
    p = Path(path)
    # 特殊文件名
    name = p.name.lower()
    if name in ("dockerfile", "makefile", "rakefile", "gemfile"):
        return name
    if name.endswith(".dockerfile"):
        return "dockerfile"
    return EXT_LANG.get(p.suffix.lower())


def should_ignore(name: str, ignore_list: list[str], rel_path: str = "") -> bool:
    """
    判断是否应忽略。
    支持：精确目录/文件名、*.ext 通配、以及含 / 的相对路径前缀（如 src/generated）。
    rel_path 为相对项目根的路径，用于路径前缀匹配。
    """
    # Windows 下 os.walk / relative_to 产出的是反斜杠，模式里写的是正斜杠，
    # 不归一化会让 `src/generated` 这类规则在 Windows 上静默失效
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
    """读取 .aisearchignore 文件中的额外忽略规则。"""
    ignore_file = root / ".aisearchignore"
    if not ignore_file.exists():
        return []
    # 防御：.aisearchignore 可能是目录或不可读（恶意/异常项目结构），静默跳过
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
    """跨版本兼容的 Path.is_relative_to（3.9+ 原生支持）。"""
    try:
        path.relative_to(other)
        return True
    except ValueError:
        return False


def detect_encoding(path, chunk: int = 65536) -> str:
    """
    探测文件编码，优先 BOM，否则按 utf-8 → gb18030 试探，兜底 utf-8(replace)。
    解决 Windows 上大量 GBK/GB18030 中文文档被当 UTF-8 读成乱码的问题。
    """
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
    """读取文本并自动探测编码（utf-8/gb18030/utf-16）。仅用于中小文件。"""
    enc = detect_encoding(path)
    try:
        return Path(path).read_text(encoding=enc, errors="replace")
    except (OSError, PermissionError) as e:
        raise


def safe_resolve(ref: str, root: Path, boundary: str = "root") -> Path:
    """
    将 ref 解析为绝对路径，并按边界策略校验。

    boundary:
      "root"   —— 只允许 root 目录内的路径（用于 rpc --root，防止
                  通过 `../../etc/passwd` 之类的相对路径越权读取）
      "system" —— 允许任意路径（用于本地 CLI 显式指定系统路径，如 `aisearch cat /etc/hosts`）

    注意：会拒绝包含 NUL 字节的路径。
    """
    if "\x00" in ref:
        raise ValueError("Path contains NUL byte")

    # 绝对路径按原样解析；相对路径相对 root 解析
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
    """递归遍历项目文件列表。"""
    ignore = ignore or DEFAULT_IGNORE
    files: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        cur = Path(dirpath)
        # 目录也按相对路径剪枝：否则 `src/generated` 这种规则拦不住目录，
        # 仍会整棵走下去（大仓库上白白遍历几千个文件）
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
