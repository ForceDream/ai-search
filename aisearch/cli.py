"""CLI 入口 —— 7 个命令覆盖 AI 90% 的代码导航需求。

默认输出策略：
  - 显式 --text / --json 优先
  - 否则：管道（非 TTY，AI 读取）→ JSON；交互终端 → 人类可读彩色文本
"""

from __future__ import annotations

import argparse
import json
import sys

from . import __version__
from .config import is_output_tty


def main():
    # Windows 下 stdout/stderr 默认 gbk，输出含中文/emoji 的 UTF-8 JSON 会崩溃。
    # AI 消费场景要求严格 UTF-8，故强制重配置（管道/文件重定向同样受益）。
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    parser = argparse.ArgumentParser(
        prog="aisearch",
        description="AI-optimized code search and navigation tool",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")

    sub = parser.add_subparsers(dest="command", help="可用命令")

    # ── grep: 文本搜索 ───────────────────────────
    p_grep = sub.add_parser("grep", help="文本搜索 (grep 替代)")
    p_grep.add_argument("pattern", help="搜索模式 (正则)")
    p_grep.add_argument("path", nargs="?", default=".", help="搜索路径 (默认当前目录)")
    p_grep.add_argument("-t", "--type", help="文件扩展名过滤，如 py,js,ts")
    p_grep.add_argument("-C", "--context", type=int, default=2, help="上下文行数 (默认 2)")
    p_grep.add_argument("-i", "--ignore-case", action="store_true", help="忽略大小写")
    p_grep.add_argument("-w", "--whole-word", action="store_true", help="全词匹配")
    p_grep.add_argument("-n", "--limit", type=int, default=50, help="最大结果数 (默认 50)")
    p_grep.add_argument("--json", action="store_true", help="JSON 输出")
    p_grep.add_argument("--text", action="store_true", help="文本输出")

    # ── sym: 符号搜索 ───────────────────────────
    p_sym = sub.add_parser("sym", help="符号搜索 (函数/类/结构体)")
    p_sym.add_argument("name", help="符号名称（默认按子串匹配）")
    p_sym.add_argument("path", nargs="?", default=".", help="搜索路径")
    p_sym.add_argument("-k", "--kind", help="符号类型过滤 (class/function/method/...)")
    p_sym.add_argument("-x", "--exact", action="store_true", help="仅精确匹配同名符号")
    p_sym.add_argument("-n", "--limit", type=int, default=50)
    p_sym.add_argument("--json", action="store_true")
    p_sym.add_argument("--text", action="store_true")

    # ── def: 查找定义 ───────────────────────────
    p_def = sub.add_parser("def", help="查找符号定义")
    p_def.add_argument("name", help="符号名称")
    p_def.add_argument("path", nargs="?", default=".", help="搜索路径")
    p_def.add_argument("--json", action="store_true")
    p_def.add_argument("--text", action="store_true")

    # ── ref: 查找引用 ───────────────────────────
    p_ref = sub.add_parser("ref", help="查找符号引用")
    p_ref.add_argument("name", help="符号名称")
    p_ref.add_argument("path", nargs="?", default=".", help="搜索路径")
    p_ref.add_argument("-n", "--limit", type=int, default=100)
    p_ref.add_argument("--json", action="store_true")
    p_ref.add_argument("--text", action="store_true")

    # ── cat: 智能读文件 ─────────────────────────
    p_cat = sub.add_parser("cat", help="智能读取文件")
    p_cat.add_argument("file", help="文件引用 (file.py / file.py:10-50 / file.py#func)")
    p_cat.add_argument("path", nargs="?", default=".", help="项目路径")
    p_cat.add_argument("--outline", action="store_true", help="只输出符号大纲")
    p_cat.add_argument("--json", action="store_true")
    p_cat.add_argument("--text", action="store_true")

    # ── ctx: 获取上下文 ─────────────────────────
    p_ctx = sub.add_parser("ctx", help="获取某行的丰富上下文")
    p_ctx.add_argument("location", help="位置 (file.py:42)")
    p_ctx.add_argument("path", nargs="?", default=".", help="项目路径")
    p_ctx.add_argument("-r", "--radius", type=int, default=5, help="上下文半径 (默认 5)")
    p_ctx.add_argument("--json", action="store_true")
    p_ctx.add_argument("--text", action="store_true")

    # ── tree: 项目目录树 ────────────────────────
    p_tree = sub.add_parser("tree", help="项目目录树")
    p_tree.add_argument("path", nargs="?", default=".", help="项目路径")
    p_tree.add_argument("-d", "--depth", type=int, default=3, help="显示深度 (默认 3)")
    p_tree.add_argument("--json", action="store_true")
    p_tree.add_argument("--text", action="store_true")

    # ── rpc: stdio 无服务模式 ───────────────────
    p_rpc = sub.add_parser(
        "rpc",
        help="stdio JSON 模式：不监听端口，AI 以子进程拉起，stdin/stdout 通信",
    )
    p_rpc.add_argument(
        "--root", default=None,
        help="锁定项目根目录（启用后 boundary=root，仅允许读项目内文件）",
    )

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    # 输出格式判断
    use_json = _choose_output(args)

    # ── 执行命令 ────────────────────────────────

    # CLI 全局兜底：任何未预期异常都转为结构化输出（JSON 或 stderr 文本），
    # 绝不让 traceback 污染 AI 读取的 stdout
    try:
        if args.command == "grep":
            _cmd_grep(args, use_json)
        elif args.command == "sym":
            _cmd_sym(args, use_json)
        elif args.command == "def":
            _cmd_def(args, use_json)
        elif args.command == "ref":
            _cmd_ref(args, use_json)
        elif args.command == "cat":
            _cmd_cat(args, use_json)
        elif args.command == "ctx":
            _cmd_ctx(args, use_json)
        elif args.command == "tree":
            _cmd_tree(args, use_json)

        elif args.command == "rpc":
            _cmd_rpc(args)
    except KeyboardInterrupt:
        raise
    except Exception as e:
        if use_json:
            print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        else:
            print(f"aisearch: error: {type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)


def _choose_output(args) -> bool:
    """返回 True 表示 JSON 输出。"""
    if getattr(args, "text", False):
        return False
    if getattr(args, "json", False):
        return True
    # 默认：管道（非 TTY，通常是 AI 调用）→ JSON；交互终端 → 文本
    return not is_output_tty()


# ── 命令实现 ────────────────────────────────────────

def _cmd_grep(args, use_json):
    from .engine import search_text

    exts = None
    if args.type:
        exts = {t.lower() if t.startswith(".") else f".{t.lower()}" for t in args.type.split(",")}

    resp = search_text(
        pattern=args.pattern,
        path=args.path,
        extensions=exts,
        context_lines=args.context,
        case_insensitive=args.ignore_case,
        max_results=args.limit,
        whole_word=args.whole_word,
    )

    if use_json:
        _print_json(resp.to_dict())
    else:
        _print_grep_text(resp)


def _cmd_sym(args, use_json):
    from .engine import search_symbols

    resp = search_symbols(
        name=args.name,
        path=args.path,
        kind=args.kind,
        max_results=args.limit,
        partial=not args.exact,
    )

    if use_json:
        _print_json(resp.to_dict())
    else:
        _print_sym_text(resp)


def _cmd_def(args, use_json):
    from .engine import find_definition

    resp = find_definition(name=args.name, path=args.path)

    if use_json:
        _print_json(resp.to_dict())
    else:
        _print_sym_text(resp)


def _cmd_ref(args, use_json):
    from .engine import find_references

    resp = find_references(
        name=args.name,
        path=args.path,
        max_results=args.limit,
    )

    if use_json:
        _print_json(resp.to_dict())
    else:
        _print_grep_text(resp)


def _cmd_cat(args, use_json):
    from .reader import read_file

    # 本地 CLI 显式读取时与用户同级信任（boundary=system）；rpc --root 才锁定项目根
    result = read_file(
        file_ref=args.file,
        path=args.path,
        outline_only=args.outline,
        boundary="system",
        human=not use_json,  # 文本渲染=人；--json/管道=AI（不带整文件大纲）
    )

    if use_json:
        _print_json(result.to_dict())
    else:
        _print_cat_text(result)


def _cmd_ctx(args, use_json):
    from .reader import get_context

    loc = args.location
    if ":" not in loc:
        _print_json({"ok": False, "error": "Location format: file.py:line"})
        sys.exit(1)

    file_ref, line_str = loc.rsplit(":", 1)
    try:
        line = int(line_str)
    except ValueError:
        _print_json({"ok": False, "error": f"Invalid line number: {line_str}"})
        sys.exit(1)

    # 本地 CLI 显式读取时允许系统路径
    result = get_context(
        file_ref=file_ref,
        line=line,
        path=args.path,
        radius=args.radius,
        boundary="system",
        human=not use_json,
    )

    if use_json:
        _print_json(result.to_dict())
    else:
        _print_ctx_text(result)


def _cmd_tree(args, use_json):
    from .engine import project_tree

    result = project_tree(path=args.path, depth=args.depth)

    if use_json:
        _print_json({"ok": True, "data": result})
    else:
        _print_tree_text(result)


def _cmd_rpc(args):
    from .rpc import run_rpc
    run_rpc(root=args.root)


# ── 输出函数 ────────────────────────────────────────

def _print_json(data):
    print(json.dumps(data, ensure_ascii=False, indent=2))


def _print_grep_text(resp):
    """以类似 ripgrep 的格式输出文本。"""
    data = resp.to_dict()
    if not data.get("ok"):
        print(f"Error: {data.get('error')}", file=sys.stderr)
        return

    matches = data["data"]["matches"]
    stats = data["data"]

    for m in matches:
        f = m["file"]
        ln = m["line"]
        text = m["text"]
        sym = m.get("symbol")

        header = f"\033[35m{f}\033[0m:\033[32m{ln}\033[0m"
        if sym:
            header += f" \033[36m[{sym.get('kind', '')} {sym.get('name', '')}]\033[0m"
        print(header)

        for cb in m.get("context_before", []):
            print(f"  \033[90m│\033[0m {cb}")

        print(f"  \033[90m│\033[0m \033[1;33m{text}\033[0m")

        for ca in m.get("context_after", []):
            print(f"  \033[90m│\033[0m {ca}")

        print()

    print(f"\033[90m── {stats['total']} matches in {stats['files_searched']} files ({stats['elapsed_ms']}ms)\033[0m")


def _print_sym_text(resp):
    data = resp.to_dict()
    if not data.get("ok"):
        print(f"Error: {data.get('error')}", file=sys.stderr)
        return

    matches = data["data"]["matches"]
    for m in matches:
        kind = m.get("kind", "?")
        name = m.get("name", "?")
        f = m.get("file", "?")
        ln = m.get("line", 0)
        parent = m.get("parent", "")
        text = m.get("text", "").strip()

        scope = f"\033[36m{parent}.\033[0m" if parent else ""
        kind_color = {
            "class": "\033[33m", "struct": "\033[33m",
            "interface": "\033[35m", "trait": "\033[35m",
            "function": "\033[32m", "method": "\033[32m",
            "type": "\033[34m", "enum": "\033[34m",
        }.get(kind, "\033[0m")

        print(f"\033[35m{f}\033[0m:\033[32m{ln}\033[0m  {kind_color}{kind}\033[0m {scope}\033[1m{name}\033[0m  \033[90m{text}\033[0m")

    stats = data["data"]
    print(f"\033[90m── {stats['total']} results ({stats['elapsed_ms']}ms)\033[0m")


def _print_cat_text(result):
    data = result.to_dict()
    if not data.get("ok"):
        print(f"Error: {data.get('error')}", file=sys.stderr)
        return

    d = data["data"]
    f = d["file"]
    lang = d.get("language", "")
    lines_range = d["lines"]
    total = d["total_lines"]

    lang_tag = f" \033[90m({lang})\033[0m" if lang else ""
    print(f"\033[1;35m── {f}\033[0m{lang_tag}  \033[90mlines {lines_range['start']}-{lines_range['end']}/{total}\033[0m")

    symbols = d.get("symbols", [])
    if symbols:
        print(f"\033[90m┌─ symbols:\033[0m")
        for s in symbols:
            kind = s.get("kind", "?")
            name = s.get("name", "?")
            ln = s.get("line", 0)
            end = s.get("line_end", 0)
            parent = s.get("parent", "")
            prefix = f"  {parent}." if parent else "  "
            rng = f" ({ln}-{end})" if end else ""
            print(f"\033[90m│\033[0m{prefix}\033[36m{kind}\033[0m \033[1m{name}\033[0m\033[90m{rng}\033[0m")
        print(f"\033[90m└─\033[0m")

    content = d.get("content", "")
    if content:
        start = lines_range["start"]
        print()
        for i, line in enumerate(content.splitlines()):
            lineno = start + i
            print(f"\033[90m{lineno:>5} │\033[0m {line}")
        print()


def _print_ctx_text(result):
    data = result.to_dict()
    if not data.get("ok"):
        print(f"Error: {data.get('error')}", file=sys.stderr)
        return

    d = data["data"]
    f = d["file"]
    line = d["line"]
    lang = d.get("language", "")

    print(f"\033[1;35m── {f}\033[0m:\033[32m{line}\033[0m  \033[90m({lang})\033[0m")

    sym = d.get("containing_symbol")
    if sym:
        print(f"\033[90m  in:\033[0m \033[36m{sym['kind']}\033[0m \033[1m{sym['name']}\033[0m \033[90m(lines {sym['line']}-{sym.get('line_end', '?')})\033[0m")

    imports = d.get("imports", [])
    if imports:
        print(f"\033[90m  imports ({len(imports)}):\033[0m", ", ".join(imports[:10]))

    content = d.get("content", "")
    if content:
        content_lines = content.splitlines()
        # 内容窗口起点：优先用数据里给的真实起点（窗口被文件头/尾截断时估算必错位）
        start_line = d.get("window_start") or max(1, line - (len(content_lines) // 2))
        print()
        for i, cl in enumerate(content_lines):
            estimated_line = start_line + i
            marker = " \033[1;31m<<\033[0m" if estimated_line == line else ""
            print(f"\033[90m{estimated_line:>5} │\033[0m {cl}{marker}")
        print()

    outline = d.get("file_outline", [])
    if outline:
        print(f"\033[90m  file symbols ({len(outline)}):\033[0m")
        for s in outline[:30]:
            parent = f"{s.get('parent', '')}." if s.get("parent") else ""
            print(f"    \033[36m{s['kind']}\033[0m {parent}\033[1m{s['name']}\033[0m \033[90m:{s['line']}\033[0m")
        if len(outline) > 30:
            print(f"    \033[90m... and {len(outline) - 30} more\033[0m")


def _print_tree_text(tree_data: dict):
    """以 tree 命令的格式输出目录树。"""
    root = tree_data.get("root", ".")
    entries = tree_data.get("tree", [])
    print(f"\033[1;35m{root}\033[0m")
    _print_tree_entries(entries, "")


def _print_tree_entries(entries: list, prefix: str):
    for i, entry in enumerate(entries):
        is_last = i == len(entries) - 1
        connector = "└── " if is_last else "├── "

        if entry.get("type") == "dir":
            name = entry["name"]
            print(f"{prefix}{connector}\033[1;34m{name}/\033[0m")
            children = entry.get("children", [])
            child_prefix = prefix + ("    " if is_last else "│   ")
            _print_tree_entries(children, child_prefix)
        elif entry.get("type") == "file":
            name = entry["name"]
            lang = entry.get("lang", "")
            size = entry.get("size", 0)
            lang_tag = f" \033[90m({lang})\033[0m" if lang else ""
            size_tag = f" \033[90m[{_format_size(size)}]\033[0m" if size else ""
            print(f"{prefix}{connector}{name}{lang_tag}{size_tag}")
        elif entry.get("type") == "truncated":
            print(f"{prefix}{connector}\033[90m...\033[0m")


def _format_size(n: int) -> str:
    if n < 1024:
        return f"{n}B"
    elif n < 1024 * 1024:
        return f"{n / 1024:.1f}K"
    else:
        return f"{n / (1024 * 1024):.1f}M"
