#!/usr/bin/env python3
"""
token 消耗对比基准：AI 用不同方式读同一个代码库（默认本仓库，可用 AISEARCH_TOKEN_CORPUS 指定）。

对比 5 种方式：
  grep   —— 原生 grep/sed/find 基线（AI 不用 aisearch 时的典型做法）
  py-cli —— Python 版 aisearch CLI
  js-cli —— Node 版 aisearch CLI（--path 指向同一语料库）
  py-rpc —— Python 版 rpc 会话（--root 同一语料库）
  js-rpc —— Node 版 rpc 会话

任务：6 个 AI 典型阅读任务（T1-T5 单任务 + T6 八步审计会话）。
统计：调用数、输入 token（AI 发出的命令/请求）、输出 token（工具 stdout 进 AI 上下文）、总 token。

token 计量：分桶启发式（ASCII 代码/JSON ≈3.7 字符/token，CJK ≈1.05 字符/token）。
aisearch JSON 输出中的 elapsed_ms 每轮浮动，计数前统一归零以保证确定性。
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

# 路径相对本脚本解析 + 环境变量可覆盖 → 不绑定任何机器/本地目录。
HERE = Path(__file__).resolve().parent   # .../aisearch-js/bench
JS_ROOT = HERE.parent                     # .../aisearch-js
REPO_ROOT = JS_ROOT.parent                # 含 aisearch/ 与 aisearch-js/

CORPUS = os.environ.get("AISEARCH_TOKEN_CORPUS", str(REPO_ROOT))  # 被读的代码库（所有方式统一）
PY = os.environ.get("AISEARCH_PY_BIN", "aisearch").split()        # py console script
JS = [os.environ.get("NODE_BIN", "node"), str(JS_ROOT / "bin" / "aisearch.mjs")]


# ── token 估算 ───────────────────────────────
def est_tokens(text: str) -> int:
    cjk = 0
    other = 0
    for ch in text:
        if "\u4e00" <= ch <= "\u9fff" or ch in "，。：；（）【】「」——、":
            cjk += 1
        else:
            other += 1
    return int(other / 3.7 + cjk * 1.05)


_ELAPSED = re.compile(r'("elapsed_ms":\s*)[0-9.]+')

def norm_tokens(text: str) -> int:
    """elapsed_ms 归零后计 token（保证确定性）。"""
    return est_tokens(_ELAPSED.sub(r"\g<1>0", text))


# ── 执行器 ───────────────────────────────────
def sh(cmd, cwd):
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=60, cwd=cwd)
    return p.stdout, time.time() - t0


def run_grep(steps, cwd):
    """基线：steps 为 shell 命令列表（sh -c）。"""
    outs = []
    for s in steps:
        out, dt = sh(["sh", "-c", s], cwd)
        outs.append((s, out, dt))
    return outs


def run_cli(kind, steps, cwd):
    """steps: [argv,...]；py 直接在 cwd 内读（相对路径）；js 用 --path 指语料库。"""
    bin_ = PY if kind == "py" else JS
    outs = []
    for argv in steps:
        # js 在自身目录启动，语料库路径用 PATH 占位符精确替换（可出现在任何位置）
        a = list(bin_) + [CORPUS if x == "PATH" else x for x in argv]
        out, dt = sh(a, cwd)
        outs.append((" ".join(argv), out, dt))
    return outs


def run_rpc(kind, reqs, cwd):
    bin_ = PY if kind == "py" else JS
    args = bin_ + ["rpc", "--root", CORPUS]
    lines = "\n".join(json.dumps(r) for r in reqs) + "\n"
    t0 = time.time()
    p = subprocess.run(args, input=lines, capture_output=True, text=True, timeout=120, cwd=cwd)
    dt = time.time() - t0
    resps = [json.loads(l) for l in p.stdout.splitlines() if l.strip()]
    outs = []
    for req, resp in zip(reqs, resps):
        outs.append((json.dumps(req), json.dumps(resp), 0))
    return outs


def measure(steps_out):
    """[(输入文本, 输出文本, dt)] → 汇总。"""
    in_tok = sum(norm_tokens(i) for i, _, _ in steps_out)
    out_tok = sum(norm_tokens(o) for _, o, _ in steps_out)
    calls = len(steps_out)
    elapsed = sum(d for _, _, d in steps_out)
    return {"calls": calls, "in_tok": in_tok, "out_tok": out_tok,
            "total": in_tok + out_tok, "elapsed_s": round(elapsed, 2)}


# ── 任务定义 ─────────────────────────────────
# 所有路径相对 CORPUS（js 版由 run_cli 把最后一个参数换成 CORPUS；
# 注意：js 任务里 path 参数必须是最后一个位置参数）
TASKS = {}

# T1 定位并读取完整方法体：RpcSession.handle
TASKS["T1 读方法体"] = {
    "grep": [
        r'grep -rn "def handle" aisearch/',
        r"sed -n '51,101p' aisearch/rpc.py",
    ],
    "py-cli": [["cat", "aisearch/rpc.py#handle"]],
    "js-cli": [["cat", "aisearch/rpc.py#handle", "PATH"]],
    "py-rpc": [{"id": 1, "method": "read", "params": {"file": "aisearch/rpc.py#handle"}}],
    "js-rpc": [{"id": 1, "method": "read", "params": {"file": "aisearch/rpc.py#handle"}}],
}

# T2 文件大纲：config.py 顶层结构
TASKS["T2 文件大纲"] = {
    "grep": [r'grep -n "^def \|^class \|^MAX\|^EXT\|^CODE" aisearch/config.py'],
    "py-cli": [["cat", "aisearch/config.py", "--outline"]],
    "js-cli": [["cat", "aisearch/config.py", "--outline", "PATH"]],
    "py-rpc": [{"id": 1, "method": "read", "params": {"file": "aisearch/config.py", "outline": True}}],
    "js-rpc": [{"id": 1, "method": "read", "params": {"file": "aisearch/config.py", "outline": True}}],
}

# T3 查引用：find_containing_symbol 的使用点
TASKS["T3 查引用"] = {
    "grep": [r'grep -rn "find_containing_symbol" aisearch/'],
    "py-cli": [["ref", "find_containing_symbol"]],
    "js-cli": [["ref", "find_containing_symbol", "PATH"]],
    "py-rpc": [{"id": 1, "method": "ref", "params": {"name": "find_containing_symbol"}}],
    "js-rpc": [{"id": 1, "method": "ref", "params": {"name": "find_containing_symbol"}}],
}

# T4 行上下文（两步：先拿行号，再看上下文）
TASKS["T4 行上下文"] = {
    "grep": [
        r'grep -n "MAX_LINE_BYTES" aisearch/rpc.py',
        r"sed -n '204,214p' aisearch/rpc.py",
    ],
    "py-cli": [["ref", "MAX_LINE_BYTES"], ["ctx", "aisearch/rpc.py:209", "--radius", "5"]],
    "js-cli": [["ref", "MAX_LINE_BYTES", "PATH"], ["ctx", "aisearch/rpc.py:209", "PATH", "--radius", "5"]],
    "py-rpc": [{"id": 1, "method": "ref", "params": {"name": "MAX_LINE_BYTES"}},
               {"id": 2, "method": "context", "params": {"file": "aisearch/rpc.py", "line": 209, "radius": 5}}],
    "js-rpc": [{"id": 1, "method": "ref", "params": {"name": "MAX_LINE_BYTES"}},
               {"id": 2, "method": "context", "params": {"file": "aisearch/rpc.py", "line": 209, "radius": 5}}],
}

# T5 找定义：extract_symbols
TASKS["T5 找定义"] = {
    "grep": [r'grep -rn "def extract_symbols" aisearch/'],
    "py-cli": [["def", "extract_symbols"]],
    "js-cli": [["def", "extract_symbols", "PATH"]],
    "py-rpc": [{"id": 1, "method": "def", "params": {"name": "extract_symbols"}}],
    "js-rpc": [{"id": 1, "method": "def", "params": {"name": "extract_symbols"}}],
}

# T6 八步审计会话
TASKS["T6 审计会话(8步)"] = {
    "grep": [
        r'find aisearch -name "*.py" | sort',
        r'grep -rn "MAX_PATTERN_LEN" aisearch/',
        r'grep -rn "def search_text" aisearch/',
        r"sed -n '318,368p' aisearch/engine.py",
        r'grep -rn "has_ripgrep" aisearch/',
        r"sed -n '120,132p' aisearch/engine.py",
        r'grep -rn "def _search_with_rg" aisearch/',
        r"sed -n '150,180p' aisearch/rpc.py",
    ],
    "py-cli": [
        ["tree", ".", "-d", "2"],
        ["grep", "MAX_PATTERN_LEN"],
        ["sym", "search_text"],
        ["cat", "aisearch/engine.py#search_text"],
        ["ref", "has_ripgrep"],
        ["ctx", "aisearch/engine.py:120", "--radius", "5"],
        ["sym", "_search_with_rg"],
        ["cat", "aisearch/rpc.py#_m_search"],
    ],
    "js-cli": [
        ["tree", "PATH", "-d", "2"],  # tree 只有 1 个位置参数(path)，PATH 替换而非追加
        ["grep", "MAX_PATTERN_LEN", "PATH"],
        ["sym", "search_text", "PATH"],
        ["cat", "aisearch/engine.py#search_text", "PATH"],
        ["ref", "has_ripgrep", "PATH"],
        ["ctx", "aisearch/engine.py:120", "PATH", "--radius", "5"],
        ["sym", "_search_with_rg", "PATH"],
        ["cat", "aisearch/rpc.py#_m_search", "PATH"],
    ],
    "py-rpc": [
        {"id": 1, "method": "tree", "params": {"depth": 2}},
        {"id": 2, "method": "search", "params": {"pattern": "MAX_PATTERN_LEN"}},
        {"id": 3, "method": "symbols", "params": {"name": "search_text"}},
        {"id": 4, "method": "read", "params": {"file": "aisearch/engine.py#search_text"}},
        {"id": 5, "method": "ref", "params": {"name": "has_ripgrep"}},
        {"id": 6, "method": "context", "params": {"file": "aisearch/engine.py", "line": 120, "radius": 5}},
        {"id": 7, "method": "symbols", "params": {"name": "_search_with_rg"}},
        {"id": 8, "method": "read", "params": {"file": "aisearch/rpc.py#_m_search"}},
    ],
    "js-rpc": None,  # 与 py-rpc 相同，运行时填充
}
TASKS["T6 审计会话(8步)"]["js-rpc"] = TASKS["T6 审计会话(8步)"]["py-rpc"]


def main():
    results = {}
    for tname, ways in TASKS.items():
        results[tname] = {}
        for way, steps in ways.items():
            if way == "grep":
                outs = run_grep(steps, CORPUS)
            elif way == "py-cli":
                outs = run_cli("py", steps, CORPUS)
            elif way == "js-cli":
                outs = run_cli("js", steps, str(JS_ROOT))
            elif way == "py-rpc":
                outs = run_rpc("py", steps, CORPUS)
            elif way == "js-rpc":
                outs = run_rpc("js", steps, str(JS_ROOT))
            results[tname][way] = measure(outs)

    # ── 输出 ──
    print("=" * 88)
    print(f"{'任务':<14}{'方式':<8}{'调用':>5}{'输入tok':>9}{'输出tok':>9}{'总tok':>8}{'耗时s':>8}")
    print("-" * 88)
    for tname, ways in results.items():
        for way in ["grep", "py-cli", "js-cli", "py-rpc", "js-rpc"]:
            m = ways[way]
            print(f"{tname:<14}{way:<8}{m['calls']:>5}{m['in_tok']:>9}{m['out_tok']:>9}{m['total']:>8}{m['elapsed_s']:>8}")
        print("-" * 88)

    # 汇总
    print("\n== 汇总（T1-T6 总 token）==")
    summary = {}
    for way in ["grep", "py-cli", "js-cli", "py-rpc", "js-rpc"]:
        tot_in = sum(results[t][way]["in_tok"] for t in results)
        tot_out = sum(results[t][way]["out_tok"] for t in results)
        tot_calls = sum(results[t][way]["calls"] for t in results)
        summary[way] = {"in_tok": tot_in, "out_tok": tot_out, "calls": tot_calls,
                        "total": tot_in + tot_out}
        base = summary["grep"]["total"]
        print(f"{way:<8} calls={tot_calls:>3}  in={tot_in:>5}  out={tot_out:>6}  total={tot_in+tot_out:>6}"
              f"  ({(tot_in+tot_out)/base*100:.0f}% of grep)")

    # py vs js 专节
    print("\n== py vs js（token 逐项比）==")
    for tname in results:
        pc, jc = results[tname]["py-cli"]["total"], results[tname]["js-cli"]["total"]
        pr, jr = results[tname]["py-rpc"]["total"], results[tname]["js-rpc"]["total"]
        print(f"{tname:<14} cli: py={pc} js={jc} (Δ{abs(pc-jc)})   rpc: py={pr} js={jr} (Δ{abs(pr-jr)})")

    out_path = str(HERE / "token_results.json")
    with open(out_path, "w") as f:
        json.dump({"results": results, "summary": summary,
                   "method": "heuristic est: ascii/3.7 + cjk*1.05, elapsed_ms normalized"}, f,
                  ensure_ascii=False, indent=2)
    print(f"\nsaved -> {out_path}")


if __name__ == "__main__":
    main()
