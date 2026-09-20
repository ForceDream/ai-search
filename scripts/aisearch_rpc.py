#!/usr/bin/env python3
"""aisearch 技能入口：一次拉起 rpc 会话，发送 1..N 个请求。

本技能自带实现（无需安装）：
  · Python 实现：<SKILL_DIR>/scripts/aisearch/        （默认使用，仅需 Python >= 3.9）
  · Node   实现：<SKILL_DIR>/scripts/aisearch-js/     （用 --tool 切换）

用法：
    python aisearch_rpc.py --root <项目根> <METHOD> ['<PARAMS_JSON>']
    python aisearch_rpc.py --root <项目根> --stdin < reqs.jsonl   # 每行一个 {"id","method","params"}
    python aisearch_rpc.py --root <项目根> --pretty read '{"file":"src/a.py#foo"}'
    python aisearch_rpc.py --root <项目根> --tool "node <SKILL_DIR>/scripts/aisearch-js/bin/aisearch.mjs" tree '{}'

选项：
    --root DIR     项目根（传给 `rpc --root`，锁定边界、拒越权路径）
    --stdin        从标准输入逐行读取完整请求对象
    --pretty       响应按缩进输出（默认每行一个紧凑 JSON，便于管道）
    --tool CMD     覆盖命令（如切到 Node 实现，或指向已安装的 aisearch）

命令探测顺序：--tool > 环境变量 AISEARCH_CMD > PATH 上的 aisearch > 本技能自带的 Python 实现
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent                 # <SKILL_DIR>/scripts
BUNDLED_PY = HERE / "aisearch"                         # 自带的 Python 实现（`python -m aisearch`）


def _split(cmd: str) -> list[str]:
    """Windows 上必须保留反斜杠：POSIX 版 shlex 会把 `D:\\a\\b.mjs` 里的 `\\` 当转义符吃掉。"""
    if os.name != "nt":
        return shlex.split(cmd)
    out = []
    for p in shlex.split(cmd, posix=False):
        if len(p) >= 2 and p[0] == p[-1] and p[0] in "\"'":
            p = p[1:-1]
        out.append(p)
    return out


def _tool_cmd(explicit: str | None) -> list[str]:
    if explicit:
        return _split(explicit)
    env_cmd = os.environ.get("AISEARCH_CMD")
    if env_cmd:
        return _split(env_cmd)
    if shutil.which("aisearch"):
        return ["aisearch"]
    py = os.environ.get("AISEARCH_PY_BIN", sys.executable)
    if (BUNDLED_PY / "__init__.py").exists():
        return [py, "-m", "aisearch"]
    # 既没自带实现、PATH 上也没有 aisearch：仍然给出命令，让 stderr 暴露真实原因
    return [py, "-m", "aisearch"]


def _env() -> dict:
    # PYTHONDONTWRITEBYTECODE：别让 `__pycache__` 落进技能目录（保持包干净、可只读分发）
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONDONTWRITEBYTECODE": "1"}
    if (BUNDLED_PY / "__init__.py").exists():
        env["PYTHONPATH"] = str(HERE) + os.pathsep + env.get("PYTHONPATH", "")
    return env


def main() -> int:
    ap = argparse.ArgumentParser(description="aisearch rpc 原生工具")
    ap.add_argument("--root", required=True, help="项目根")
    ap.add_argument("--stdin", action="store_true", help="从 stdin 逐行读请求")
    ap.add_argument("--pretty", action="store_true", help="缩进输出")
    ap.add_argument("--tool", default=None, help="覆盖 aisearch 命令（如 node <SKILL_DIR>/scripts/aisearch-js/bin/aisearch.mjs）")
    ap.add_argument("rest", nargs="*", help="METHOD [PARAMS_JSON]")
    args = ap.parse_args()

    # stdin 用 utf-8-sig 容忍 Windows 管道（PowerShell）首行的 BOM；
    # stdout 必须用纯 utf-8 —— utf-8-sig 写出时会自行加 BOM，污染下游解析。
    try:
        sys.stdin.reconfigure(encoding="utf-8-sig", errors="replace")
    except Exception:
        pass
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    # ── 组装请求 ──
    reqs: list[dict] = []
    if args.stdin:
        for i, line in enumerate(sys.stdin, 1):
            line = line.strip().lstrip("\ufeff").strip()
            if not line:
                continue
            try:
                reqs.append(json.loads(line))
            except json.JSONDecodeError as e:
                print(f"stdin 第 {i} 行不是合法 JSON: {e}", file=sys.stderr)
                return 2
        if not reqs:
            print("stdin 没有请求", file=sys.stderr)
            return 2
    else:
        if not args.rest:
            ap.error("需要 METHOD（或使用 --stdin）")
        params: dict = {}
        if len(args.rest) > 1:
            try:
                params = json.loads(args.rest[1])
            except json.JSONDecodeError as e:
                print(f"PARAMS_JSON 不合法: {e}", file=sys.stderr)
                return 2
        reqs.append({"method": args.rest[0], "params": params})

    for i, r in enumerate(reqs, 1):
        r.setdefault("id", i)

    # ── 单次会话执行 ──
    cmd = _tool_cmd(args.tool) + ["rpc", "--root", args.root]
    # 子进程工作目录固定为 --root：否则调用方 shell 的 cwd 会决定相对 path 的解析基准，
    # 于是 `tree '{"path":"src"}'` 会以"调用方 cwd 下的 src"去比对 root 而被判越界。
    cwd = args.root if os.path.isdir(args.root) else None
    try:
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, text=True, encoding="utf-8",
                             errors="replace", env=_env(), cwd=cwd)
    except OSError as e:
        print(f"无法启动 aisearch rpc: {e}", file=sys.stderr)
        return 1

    got = 0
    try:
        assert p.stdin and p.stdout
        for r in reqs:
            p.stdin.write(json.dumps(r) + "\n")
            p.stdin.flush()
            line = p.stdout.readline()
            if not line:
                break
            got += 1
            if args.pretty:
                print(json.dumps(json.loads(line), ensure_ascii=False, indent=2))
            else:
                print(line.rstrip("\n"))
    finally:
        try:
            p.stdin.close()
            p.wait(timeout=5)
        except Exception:
            p.kill()

    if got != len(reqs):
        err = (p.stderr.read() if p.stderr else "") or ""
        print(f"rpc 异常：仅收到 {got}/{len(reqs)} 个响应。{err.strip()[:300]}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
