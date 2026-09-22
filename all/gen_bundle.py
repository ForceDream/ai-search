#!/usr/bin/env python3
"""生成 all/ 下的通用源码全集与源码归档（可复跑，跨平台）。

用法（任何平台）：
    python all/gen_bundle.py

产出：
    all/SOURCE.md              —— 全仓源码全集（文件清单 + 行数 + 内容）
    all/aisearch-source.tar.gz —— 同一文件集合的 tar 归档

安全：生成前扫描"机器/项目专有"禁用串（本地绝对路径、服务器地址等），
      命中即拒绝生成并列出位置，保证产物可直接对外分发。
"""
from __future__ import annotations

import os
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent


SKIP_DIRS = {".git", "__pycache__", ".pytest_cache", ".mypy_cache",
             "node_modules", ".venv", "venv", "build", "dist", "htmlcov", "all"}
SKIP_FILES = {"source.md", "aisearch-source.tar.gz", "python.exe"}
INCLUDE_SUFFIX = {".py", ".mjs", ".js", ".json", ".toml", ".md",
                  ".sh", ".ps1", ".cmd", ".css", ".txt"}
EXTRA_NAMES = {"LICENSE", ".gitignore"}



_SLASH = chr(47)
_BSLASH = chr(92)
FORBIDDEN = [
    "D:" + _SLASH, "D:" + _BSLASH,
    "C:" + _SLASH + "Users", "C:" + _BSLASH + "Users",
    _SLASH + "workspace", _SLASH + "tmp" + _SLASH + "aisearch",
    "bao" + "zi", "120" + ".53", "Code" + "Buddy",
]


def collect() -> list[Path]:
    files: list[Path] = []
    for dp, dns, fns in os.walk(REPO):
        dns[:] = sorted(d for d in dns if d not in SKIP_DIRS)
        for fn in sorted(fns):
            if fn in SKIP_FILES:
                continue
            p = Path(dp) / fn
            if p.suffix.lower() in INCLUDE_SUFFIX or p.name in EXTRA_NAMES:
                files.append(p)
    return sorted(files)


def rel(p: Path) -> str:
    return p.relative_to(REPO).as_posix()


def main() -> int:
    files = collect()
    if not files:
        print("未收集到任何文件，请检查仓库结构。")
        return 1


    bad: list[tuple[str, str]] = []
    for p in files:
        try:
            text = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for s in FORBIDDEN:
            if s in text:
                bad.append((rel(p), s))
    if bad:
        print("拒绝生成：以下文件含机器/项目专有串，请先清理：")
        for r, s in bad:
            print(f"  {r}   <- 命中 {s!r}")
        return 1


    head = [
        "# aisearch 源码全集（通用版 / all）",
        "",
        f"由 `all/gen_bundle.py` 生成，共 **{len(files)}** 个文件。",
        "内容不含任何机器/项目专有路径（生成前已扫描拒绝）。",
        "",
        "## 文件清单",
        "",
        "| # | 路径 | 行数 |",
        "| --- | --- | --- |",
    ]
    bodies: list[str] = []
    total_lines = 0
    for i, p in enumerate(files, 1):
        try:
            text = p.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        n = len(text.splitlines())
        total_lines += n
        head.append(f"| {i} | `{rel(p)}` | {n} |")
        fence = "````" if "```" in text else "```"
        bodies.append(f"## `{rel(p)}`\n\n{fence}\n{text.rstrip()}\n{fence}\n")
    head.append(f"| | **合计** | **{total_lines}** |")

    out_md = HERE / "SOURCE.md"
    out_md.write_text("\n".join(head) + "\n\n" + "\n".join(bodies), encoding="utf-8")


    out_tar = HERE / "aisearch-source.tar.gz"
    with tarfile.open(out_tar, "w:gz") as tf:
        for p in files:
            tf.add(p, arcname=rel(p))

    print("生成完成：")
    print(f"  {out_md}")
    print(f"  {out_tar}")
    print(f"  （{len(files)} 个文件 / {total_lines} 行）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
