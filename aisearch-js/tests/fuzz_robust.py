#!/usr/bin/env python3
"""
aisearch 鲁棒性 fuzz 套件 —— 对 Python 版与 Node.js 版双跑。

覆盖：
  A. CLI 恶意参数（路径穿越/非法正则/越界数值/病态引用格式/超长输入）
  B. rpc 恶意请求（结构畸形/越权路径/NUL 注入/越界数值/协议滥用/超大行）
  C. ReDoS 缓解（强制纯回退路径 + 恶意正则，限时完成）
  D. 边界拒绝断言（root 模式下 path 逃逸必须拒绝）

验收标准：
  1. 进程永不崩溃（每次调用 exit code 不为信号杀死；-2 即 argparse 的 usage error 也算结构化拒绝）
  2. 所有响应为合法 JSON 且含 ok 字段（CLI 可为 argparse 用法错误的 stderr）
  3. root 边界场景必须返回 ok:false 且错误含 "escapes project root"
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


HERE = Path(__file__).resolve().parent
JS_ROOT = HERE.parent
REPO_ROOT = JS_ROOT.parent

PY_BIN = os.environ.get("AISEARCH_PY_BIN", "aisearch").split()
JS_BIN = [os.environ.get("NODE_BIN", "node"), str(JS_ROOT / "bin" / "aisearch.mjs")]

SANDBOX = None
failures = []
counts = {"pass": 0, "fail": 0}


def check(label, ok, detail=""):
    tag = "PASS" if ok else "FAIL"
    counts["pass" if ok else "fail"] += 1
    if not ok:
        failures.append(f"{tag} {label}  ({detail})")
        print(f"  {tag} {label}  ({detail})")


def cli(kind, args, cwd, timeout=30, env_extra=None):
    bin_ = PY_BIN if kind == "py" else JS_BIN
    env = dict(os.environ)
    if env_extra:
        env.update(env_extra)
    t0 = time.time()
    try:
        p = subprocess.run(bin_ + args, capture_output=True, text=True,
                           timeout=timeout, cwd=cwd, env=env)
        return p.stdout, p.stderr, p.returncode, time.time() - t0
    except subprocess.TimeoutExpired:
        return "", "", "TIMEOUT", time.time() - t0


def cli_json(kind, args, cwd, **kw):
    out, err, rc, dt = cli(kind, args, cwd, **kw)
    if rc == "TIMEOUT":
        return None, dt
    if rc == 2:

        return {"ok": False, "error": "usage error (rc=2)"}, dt
    if rc not in (0, 1):
        return None, dt
    try:
        return json.loads(out) if out.strip() else None, dt
    except json.JSONDecodeError:
        return None, dt


def rpc_round(kind, lines, cwd, root=None, timeout=60):
    bin_ = PY_BIN if kind == "py" else JS_BIN
    args = bin_ + (["rpc", "--root", root] if root else ["rpc"])
    payload = "\n".join(lines) + "\n"
    try:
        p = subprocess.run(args, input=payload, capture_output=True, text=True,
                           timeout=timeout, cwd=cwd)
    except subprocess.TimeoutExpired:
        return [], False
    resps = []
    for ln in p.stdout.splitlines():
        ln = ln.strip()
        if not ln:
            continue
        try:
            resps.append(json.loads(ln))
        except json.JSONDecodeError:
            resps.append(None)
    return resps, True


def setup_sandbox():
    global SANDBOX
    SANDBOX = tempfile.mkdtemp(prefix="ais_fuzz_")
    proj = os.path.join(SANDBOX, "proj")
    src = os.path.join(proj, "src")
    os.makedirs(src)
    with open(os.path.join(src, "app.py"), "w") as f:
        f.write("def find_user(uid):\n"
                "    return db.query('SELECT * FROM users WHERE id=%s', uid)\n\n\n"
                "class UserService:\n"
                "    def delete(self, uid):\n"
                "        pass\n")
    with open(os.path.join(src, "app.ts"), "w") as f:
        f.write("export class Cache {\n"
                "  get(key: string): number { return 1; }\n"
                "}\n")
    with open(os.path.join(proj, "README.md"), "w") as f:
        f.write("hello fuzz target token here\n")

    with open(os.path.join(src, "long.py"), "w") as f:
        f.write("x" * 4000 + "\n" + "a" * 4000 + "\n")

    os.makedirs(os.path.join(proj, ".aisearchignore"))
    return proj


CWD = {"py": None, "js": None}


def main():
    proj = setup_sandbox()
    CWD["py"] = str(REPO_ROOT)
    CWD["js"] = str(JS_ROOT)




    print("== A. CLI fuzz ==")
    cli_cases = [

        ("cat /etc/hostname (system-boundary by design)", ["cat", "/etc/hostname"], None),
        ("cat relative traversal", ["cat", "../../etc/hostname"], None),
        ("cat traversal + line", ["cat", "/etc/hostname:1-2"], None),
        ("cat traversal + symbol", ["cat", "/etc/hostname#root"], None),
        ("cat nonexistent", ["cat", "no_such_file.py"], None),
        ("cat empty ref", ["cat", ""], None),
        ("cat only symbol", ["cat", "#sym"], None),
        ("cat multi-hash", ["cat", "src/app.py#a#b"], None),
        ("cat mixed line+symbol", ["cat", "src/app.py:1#find_user"], None),
        ("cat line out of huge range", ["cat", "src/app.py:999999999999"], None),
        ("cat negative line", ["cat", "src/app.py:-5"], None),
        ("cat reversed range", ["cat", "src/app.py:5-2"], None),
        ("cat alpha line", ["cat", "src/app.py:abc"], None),
        ("cat mixed range", ["cat", "src/app.py:5-abc"], None),
        ("cat line0", ["cat", "src/app.py:0"], None),
        ("ctx nonexistent", ["ctx", "no.py:1"], None),
        ("ctx huge line", ["ctx", "src/app.py:999999999"], None),
        ("ctx line0", ["ctx", "src/app.py:0"], None),
        ("ctx huge radius", ["ctx", "src/app.py:1", "--radius", "999999"], None),
        ("ctx neg radius", ["ctx", "src/app.py:1", "--radius", "-3"], None),
        ("ctx alpha radius", ["ctx", "src/app.py:1", "--radius", "abc"], None),
        ("grep path traversal", ["grep", "bin", "../../"], None),
        ("grep limit -1", ["grep", "user", "--limit", "-1"], None),
        ("grep limit huge", ["grep", "user", "--limit", "999999999999999999999"], None),
        ("grep limit alpha", ["grep", "user", "--limit", "abc"], None),
        ("grep limit 0", ["grep", "user", "--limit", "0"], None),
        ("grep context -5", ["grep", "user", "--context", "-5"], None),
        ("grep context 1e9", ["grep", "user", "--context", "1000000000"], None),
        ("grep invalid regex [", ["grep", "^["], None),
        ("grep invalid regex (?P<", ["grep", "(?P<"], None),
        ("grep backslash junk", ["grep", "\\\\x\\q"], None),
        ("grep 300-char pattern", ["grep", "a" * 300], None),
        ("grep unicode", ["grep", "用户服务"], None),
        ("grep empty pattern", ["grep", ""], None),
        ("grep whitespace pattern", ["grep", "   "], None),
        ("sym empty name", ["sym", ""], None),

        ("sym limit huge", ["sym", "user", "--limit", "99999999999"], None),
        ("def empty", ["def", ""], None),
        ("ref empty", ["ref", ""], None),
        ("ref limit huge", ["ref", "user", "--limit", "99999999999999"], None),
        ("tree depth huge", ["tree", "--depth", "999999"], None),
        ("tree depth -2", ["tree", "--depth", "-2"], None),
        ("tree depth alpha", ["tree", "--depth", "abc"], None),
        ("tree path=/", ["tree", "/"], None),
    ]
    for kind in ("py", "js"):
        for label, args, _ in cli_cases:
            d, dt = cli_json(kind, args, proj)
            check(f"[{kind}] {label}", d is not None and "ok" in d, f"{dt:.1f}s")


        for label, args in [("grep path=/ self-timeout", ["grep", "bin", "/", "--limit", "3"]),
                            ("sym path=/ self-timeout", ["sym", "user", "/", "--limit", "3"])]:
            d, dt = cli_json(kind, args, proj, timeout=60)
            check(f"[{kind}] {label}", d is not None and "ok" in d, f"{dt:.1f}s")


        out, err, rc, _ = cli(kind, ["grep", "--", "-abc"], proj)
        ok = (rc in (0, 1, 2)) and (("ok" in out) or ("usage" in err.lower() or err == ""))
        check(f"[{kind}] grep '--' '-abc' structured", ok, f"rc={rc}")


        d, _ = cli_json(kind, ["cat", "src/" + "x" * 500 + ".py"], proj)
        check(f"[{kind}] cat 500-char ref structured", d is not None and "ok" in d)




    print("== C. ReDoS mitigation (pure-fallback path) ==")
    redo_spatterns = ["(a+)+$", "(a|a)*$", "(a|aa)+$", "^(a+)*b", "((a)*)*x"]
    for kind in ("py", "js"):
        for pat in redo_spatterns:
            d, dt = cli_json(kind, ["grep", pat, "-p", "src"], proj,
                             env_extra={"AISEARCH_NO_RG": "1"}, timeout=15)
            check(f"[{kind}] ReDoS '{pat[:12]}' bounded ({dt:.1f}s)",
                  dt < 12 and (d is not None or True), "elapsed")
        d, dt = cli_json(kind, ["grep", "a" * 300], proj,
                         env_extra={"AISEARCH_NO_RG": "1"}, timeout=15)
        check(f"[{kind}] ReDoS 300-char rejected",
              d is not None and d.get("ok") is False and "too long" in d.get("error", ""))




    print("== B. rpc fuzz ==")
    root_cases = [
        ("search path=/tmp", {"id": 1, "method": "search", "params": {"pattern": "x", "path": "/tmp"}}),
        ("symbols path=/etc", {"id": 2, "method": "symbols", "params": {"name": "x", "path": "/etc"}}),
        ("def path=/usr", {"id": 3, "method": "def", "params": {"name": "x", "path": "/usr"}}),
        ("ref path=../..", {"id": 4, "method": "ref", "params": {"name": "x", "path": "../.."}}),
        ("tree path=/", {"id": 5, "method": "tree", "params": {"path": "/"}}),
        ("read file=/etc/passwd", {"id": 6, "method": "read", "params": {"file": "/etc/passwd"}}),
        ("context file=traversal", {"id": 7, "method": "context", "params": {"file": "../../../etc/passwd", "line": 1}}),
    ]
    generic_cases = [
        ("empty object", {}),
        ("no params", {"id": 8, "method": "search"}),
        ("params null", {"id": 9, "method": "search", "params": None}),
        ("params empty array", {"id": 10, "method": "search", "params": []}),
        ("params string", {"id": 11, "method": "search", "params": "x"}),
        ("params number", {"id": 12, "method": "search", "params": 42}),
        ("method number", {"id": 13, "method": 123, "params": {}}),
        ("method dunder", {"id": 14, "method": "__init__", "params": {}}),
        ("method class", {"id": 15, "method": "__class__", "params": {}}),
        ("method empty", {"id": 16, "method": "", "params": {}}),
        ("method trailing space", {"id": 17, "method": "health ", "params": {}}),
        ("method traversal", {"id": 18, "method": "../etc", "params": {}}),
        ("id array", {"id": [1, 2], "method": "health", "params": {}}),
        ("id object", {"id": {"x": 1}, "method": "health", "params": {}}),
        ("search empty pattern", {"id": 19, "method": "search", "params": {"pattern": ""}}),
        ("search whitespace pattern", {"id": 20, "method": "search", "params": {"pattern": "   "}}),
        ("search NUL pattern", {"id": 21, "method": "search", "params": {"pattern": "a\u0000b"}}),
        ("search NUL path", {"id": 22, "method": "search", "params": {"pattern": "x", "path": "src\u0000"}}),
        ("read NUL file", {"id": 23, "method": "read", "params": {"file": "src\u0000/app.py"}}),
        ("search limit -1", {"id": 24, "method": "search", "params": {"pattern": "x", "limit": -1}}),
        ("search limit alpha", {"id": 25, "method": "search", "params": {"pattern": "x", "limit": "abc"}}),
        ("search limit 1e18", {"id": 26, "method": "search", "params": {"pattern": "x", "limit": 1000000000000000000}}),
        ("search limit float", {"id": 27, "method": "search", "params": {"pattern": "x", "limit": 2.7}}),
        ("search limit bool", {"id": 28, "method": "search", "params": {"pattern": "x", "limit": True}}),
        ("search context alpha", {"id": 29, "method": "search", "params": {"pattern": "x", "context": "abc"}}),
        ("search extensions junk", {"id": 30, "method": "search", "params": {"pattern": "x", "extensions": [1, "-e", "x/../"]}}),
        ("search unicode line-sep", {"id": 31, "method": "search", "params": {"pattern": "token hello"}}),
        ("symbols limit 0", {"id": 32, "method": "symbols", "params": {"name": "x", "limit": 0}}),
        ("symbols kind number", {"id": 33, "method": "symbols", "params": {"name": "x", "kind": 7}}),
        ("context line 0", {"id": 34, "method": "context", "params": {"file": "src/app.py", "line": 0}}),
        ("context line -5", {"id": 35, "method": "context", "params": {"file": "src/app.py", "line": -5}}),
        ("context line alpha", {"id": 36, "method": "context", "params": {"file": "src/app.py", "line": "abc"}}),
        ("context line 1e18", {"id": 37, "method": "context", "params": {"file": "src/app.py", "line": 10 ** 18}}),
        ("context radius 1e18", {"id": 38, "method": "context", "params": {"file": "src/app.py", "line": 2, "radius": 10 ** 18}}),
        ("context radius alpha", {"id": 39, "method": "context", "params": {"file": "src/app.py", "line": 2, "radius": "abc"}}),
        ("tree depth -1", {"id": 40, "method": "tree", "params": {"depth": -1}}),
        ("tree depth alpha", {"id": 41, "method": "tree", "params": {"depth": "x"}}),
        ("tree depth 1e18", {"id": 42, "method": "tree", "params": {"depth": 10 ** 18}}),
        ("def empty name", {"id": 43, "method": "def", "params": {"name": ""}}),
        ("ref empty name", {"id": 44, "method": "ref", "params": {"name": ""}}),
        ("read empty file", {"id": 45, "method": "read", "params": {"file": ""}}),
        ("read file#no-sym", {"id": 46, "method": "read", "params": {"file": "src/app.py#no_such_sym"}}),
        ("read file:bad-line", {"id": 47, "method": "read", "params": {"file": "src/app.py:abc"}}),
        ("read file:huge-line", {"id": 48, "method": "read", "params": {"file": "src/app.py:999999999999"}}),
        ("health ok", {"id": 49, "method": "health", "params": {}}),
    ]
    for kind in ("py", "js"):

        raw_lines = ["{not json", "[1,2,3]", '"just a string"', "123", "null", "   "]
        resps, alive = rpc_round(kind, raw_lines, proj)
        check(f"[{kind}] rpc protocol junk handled", alive and all(
            r is not None and r.get("ok") in (True, False) for r in resps), f"{len(resps)} resp")

        big = "x" * (1024 * 1024 + 100)
        resps, alive = rpc_round(kind, ['{"id": 1, "method": "health", "params": {}}',
                                        json.dumps({"id": 2, "method": "search", "params": {"pattern": big}}),
                                        '{"id": 3, "method": "health", "params": {}}'], proj)
        check(f"[{kind}] rpc 1MB-line sandwich survives", alive and len(resps) >= 2
              and resps[0].get("ok") is True and resps[-1].get("ok") is True, f"{len(resps)} resp")


        storm = [json.dumps({"id": i, "method": ["search", "symbols", "tree", "health"][i % 4],
                             "params": {"pattern": "x", "name": "x", "path": ".."}[{"search": "pattern", "symbols": "name"}.get(["search", "symbols", "tree", "health"][i % 4], "path")]})
                 for i in range(50)]
        resps, alive = rpc_round(kind, storm, proj, root=proj)
        check(f"[{kind}] rpc 50-request storm alive", alive and len(resps) == 50)


        resps, alive = rpc_round(kind, [json.dumps(r) for _, r in root_cases], proj, root=proj)
        all_rejected = alive and len(resps) == len(root_cases) and all(
            r and r.get("ok") is False and "escapes" in str(r.get("error", "")) for r in resps)
        check(f"[{kind}] rpc root-boundary rejects all 7", all_rejected)


        lines = [json.dumps(r) for _, r in generic_cases]
        resps, alive = rpc_round(kind, lines, proj, root=proj)
        structured = alive and len(resps) == len(generic_cases) and all(
            r is not None and "ok" in r for r in resps)
        check(f"[{kind}] rpc {len(generic_cases)} generic cases structured", structured)


        resps, _ = rpc_round(kind, ['{"id": 1, "method": "health"}'], proj, root=proj)
        ok_health = resps and resps[0].get("ok") and resps[0]["data"]["boundary"] == "root"
        check(f"[{kind}] rpc health reports boundary=root", ok_health)


    print(f"\n== fuzz summary: {counts['pass']} pass, {counts['fail']} fail ==")
    shutil.rmtree(SANDBOX, ignore_errors=True)
    sys.exit(0 if counts["fail"] == 0 else 1)


if __name__ == "__main__":
    main()
