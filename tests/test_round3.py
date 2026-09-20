"""第三轮审计（用 aisearch 自审自身）发现的缺陷回归测试。"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from aisearch import reader
from aisearch.symbols import extract_symbols, extract_imports

REPO_ROOT = Path(__file__).parents[1]


def _make_project(tmp_path):
    (tmp_path / "pyproject.toml").write_text("[project]\nname='t'\n")
    return tmp_path


# ── 修复 A1：Python 多行函数签名不再截断符号范围 ────

MULTILINE_SIG = '''def search_thing(
    pattern: str,
    path: str = ".",
    max_results: int = 50,
) -> dict:
    """Docstring."""
    found = []
    for line in lines:
        if pattern in line:
            found.append(line)
    return {"found": found}


def next_function():
    return 1
'''


def test_multiline_signature_full_range(tmp_path):
    root = _make_project(tmp_path)
    (root / "a.py").write_text(MULTILINE_SIG)
    syms = extract_symbols(MULTILINE_SIG.splitlines(), "python")
    st = next(s for s in syms if s.name == "search_thing")
    # 函数体最后一行是 `    return {"found": found}`（第 11 行）
    assert st.line_end == 11, f"got {st.line}, {st.line_end}"
    res = reader.read_file("a.py#search_thing", path=str(root))
    assert res.ok
    assert 'return {"found": found}' in res.content


def test_multiline_signature_real_codebase():
    """对本仓库自身：engine.search_text 的 #symbol 读取应包含完整函数体。"""
    res = reader.read_file("aisearch/engine.py#search_text", path=str(REPO_ROOT))
    assert res.ok
    assert "return _search_with_rg" in res.content
    assert res.end - res.start >= 15  # 实际约 31 行，修复前只有 9 行


def test_ctx_inside_multiline_sig_function():
    # 行号动态定位：取 search_text 定义行之后、落在多行签名参数区的某行，
    # 避免 engine.py 行数变动时硬编码行号失配（原为固定的 320）。
    lines = (REPO_ROOT / "aisearch" / "engine.py").read_text(encoding="utf-8").splitlines()
    sym = next(s for s in extract_symbols(lines, "python") if s.name == "search_text")
    ctx = reader.get_context("aisearch/engine.py", line=sym.line + 3, path=str(REPO_ROOT))
    assert ctx.ok
    assert ctx.containing_symbol is not None
    assert ctx.containing_symbol["name"] == "search_text"


# ── 修复 A2：花括号语言嵌套成员不再截断类范围 ────────

TS_CLASS = """export class BigController {
    start() {
        this.a();
        this.b();
        this.c();
        this.d();
        this.e();
    }

    handleAlpha() {
        return this.compute(1, 2, 3,
            4, 5, 6);
    }

    handleBeta() {
        return 2;
    }
}
"""


def test_brace_lang_class_range_with_nested_members(tmp_path):
    root = _make_project(tmp_path)
    (root / "big.ts").write_text(TS_CLASS)
    syms = extract_symbols(TS_CLASS.splitlines(), "typescript")
    cls = next(s for s in syms if s.name == "BigController")
    assert cls.line_end == 18  # 类的结束大括号所在行
    res = reader.read_file("big.ts#BigController", path=str(root))
    assert len(res.content.splitlines()) == 18


# ── 修复 B：rpc 在非 UTF-8 locale 下的健壮性 ─────────

def test_rpc_utf8_under_c_locale(sample_root):
    env = dict(os.environ, LC_ALL="C", LANG="C")
    reqs = json.dumps({"id": 1, "method": "search",
                       "params": {"pattern": "函数"}}, ensure_ascii=False) + "\n"
    proc = subprocess.run(
        [sys.executable, "-m", "aisearch", "rpc", "--root", str(sample_root)],
        input=reqs, capture_output=True, text=True, encoding="utf-8",
        env=env, timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    resp = json.loads(proc.stdout.splitlines()[0])
    assert resp["ok"]


# ── 修复 C：行范围显式校验 ───────────────────────────

def test_read_line_range_validation(tmp_path):
    root = _make_project(tmp_path)
    (root / "a.py").write_text("l1\nl2\nl3\n")
    bad = reader.read_file("a.py:3-1", path=str(root))
    assert not bad.ok and "Invalid line range" in bad.error
    beyond = reader.read_file("a.py:99", path=str(root))
    assert not beyond.ok and "beyond end of file" in beyond.error


# ── 修复 D：Go 多行 import 块 ────────────────────────

GO_BLOCK = '''package main

import (
    "fmt"
    x "os"
)

func main() {
    fmt.Println(x.Args)
}
'''


def test_go_import_block():
    imports = extract_imports(GO_BLOCK.splitlines(), "go")
    assert "fmt" in imports
    assert "x os" in imports  # 别名保留


def test_go_single_import():
    imports = extract_imports(['package m\n', 'import "fmt"\n'], "go")
    assert imports == ["fmt"]
