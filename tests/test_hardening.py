"""针对安全边界与健壮性的回归测试（覆盖审计中发现的缺陷）。"""

import json
import subprocess
import sys

import pytest

from aisearch import engine, reader, rpc
from aisearch.config import safe_resolve
from pathlib import Path




@pytest.mark.parametrize("bad_limit", [-1, 0, -999, "abc", None, 1e9, float("inf")])
def test_search_text_never_crashes_on_bad_limit(sample_root, bad_limit):
    resp = engine.search_text("def", path=str(sample_root), max_results=bad_limit)
    assert resp.ok
    assert resp.total >= 0


def test_negative_limit_clamped_to_positive(sample_root):
    resp = engine.search_text("def", path=str(sample_root), max_results=-1)
    assert resp.ok
    assert resp.total >= 1


def test_huge_limit_is_capped(sample_root):
    resp = engine.search_text("def", path=str(sample_root), max_results=10**9)
    assert resp.ok
    assert resp.total <= engine.MAX_RESULTS_CAP


def test_bad_context_never_crashes(sample_root):
    for ctx in [-5, 10**9, "x"]:
        resp = engine.search_text("def", path=str(sample_root), context_lines=ctx)
        assert resp.ok


def test_tree_depth_clamped(sample_root):
    tree = engine.project_tree(path=str(sample_root), depth=10**6)

    def max_depth(nodes, d=1):
        m = d
        for n in nodes:
            if n.get("type") == "dir":
                m = max(m, max_depth(n.get("children", []), d + 1))
        return m

    assert max_depth(tree["tree"]) <= engine.MAX_TREE_DEPTH + 1




@pytest.mark.parametrize("ref", [
    "/etc/passwd",
    "../../../../etc/passwd",
    "../" * 10 + "etc/passwd",
    "aisearch/../../../etc/passwd",
    "src/../../etc/passwd",
])
def test_path_traversal_blocked(sample_root, ref):
    res = reader.read_file(ref, path=str(sample_root))
    assert not res.ok
    assert "escapes project root" in res.error


def test_absolute_path_blocked_in_root_mode(sample_root):
    res = reader.read_file("/etc/hostname", path=str(sample_root), boundary="root")
    assert not res.ok


def test_system_boundary_allows_absolute_path(sample_root):
    res = reader.read_file("/etc/hostname", path=str(sample_root), boundary="system")
    assert res.ok


def test_safe_resolve_rejects_nul_byte(sample_root):
    with pytest.raises(ValueError):
        safe_resolve("a\x00b", sample_root)


def test_get_context_traversal_blocked(sample_root):
    res = reader.get_context("../../etc/passwd", line=1, path=str(sample_root))
    assert not res.ok




def test_large_file_streaming(tmp_path):

    big = tmp_path / "big.py"
    big.write_text("x = 1\n" * (reader.MAX_FILE_BYTES // 6 + 2000))
    (tmp_path / "pyproject.toml").write_text("[project]\nname='t'\n")


    res = reader.read_file("big.py", path=str(tmp_path))
    assert res.ok
    assert res.truncated is True
    assert res.total_lines > reader.MAX_FILE_BYTES // 6
    assert "x = 1" in res.content


    res2 = reader.read_file("big.py:2-4", path=str(tmp_path))
    assert res2.ok
    assert res2.start == 2 and res2.end == 4
    assert "x = 1" in res2.content


    res3 = reader.get_context("big.py", line=3, path=str(tmp_path))
    assert res3.ok
    assert "x = 1" in res3.content


def test_radius_clamped(tmp_path):
    f = tmp_path / "a.py"
    f.write_text("\n".join(f"line{i}" for i in range(100)))
    (tmp_path / "pyproject.toml").write_text("[project]\nname='t'\n")
    res = reader.get_context("a.py", line=50, path=str(tmp_path), radius=10**9)
    assert res.ok




def _make_project(tmp_path):
    (tmp_path / "pyproject.toml").write_text("[project]\nname='t'\n")
    return tmp_path


def test_aisearchignore_path_pattern(tmp_path):
    """`.aisearchignore` 中 `src/generated` 这类含 / 的路径模式应生效。"""
    root = _make_project(tmp_path)
    (root / "src" / "generated").mkdir(parents=True)
    (root / "src" / "keep.py").write_text("def a():\n    pass\n")
    (root / "src" / "generated" / "gen.py").write_text("x = 1\n")
    (root / ".aisearchignore").write_text("src/generated\n")

    files = engine.search_text("x", path=str(root))
    assert not any("gen.py" in m.file for m in files.matches)

    tree = engine.project_tree(path=str(root), depth=5)

    def all_names(nodes):
        out = []
        for n in nodes:
            out.append(n["name"])
            out += all_names(n.get("children", []))
        return out

    assert "generated" not in all_names(tree["tree"])


def test_filename_with_hash_and_colon(tmp_path):
    """文件名本身含 # 或 : 时，整体路径存在则按普通路径读取。"""
    root = _make_project(tmp_path)
    weird = root / "src"
    weird.mkdir()
    (weird / "wei#rd:name.py").write_text("def helper():\n    pass\n")

    res = reader.read_file("src/wei#rd:name.py", path=str(root), boundary="system")
    assert res.ok
    assert "def helper" in res.content


def test_symbol_unique_partial_fallback(tmp_path):
    """精确未命中但子串唯一命中时回退；多个候选时报 ambiguous。"""
    root = _make_project(tmp_path)
    (root / "a.py").write_text(
        "def real_one():\n    return 1\n\n\ndef other():\n    return 2\n"
    )
    ok = reader.read_file("a.py#real", path=str(root))
    assert ok.ok and ok.symbol["name"] == "real_one"

    (root / "b.py").write_text("def dup_x():\n    pass\n\n\ndef dup_y():\n    pass\n")

    ok2 = reader.read_file("a.py#_o", path=str(root))
    assert ok2.ok

    (root / "c.py").write_text("def da():\n    pass\n\n\ndef db():\n    pass\n")
    amb = reader.read_file("c.py#d", path=str(root))
    assert not amb.ok
    assert "ambiguous" in amb.error


def test_empty_pattern_rejected(sample_root):
    resp = engine.search_text("   ", path=str(sample_root))
    assert not resp.ok
    assert "Empty search pattern" in resp.error


def test_symbol_range_no_trailing_blank_lines(tmp_path):
    root = _make_project(tmp_path)
    (root / "a.py").write_text("def f():\n    return 1\n\n\n")
    from aisearch.symbols import extract_symbols
    lines = (root / "a.py").read_text().splitlines()
    s = extract_symbols(lines, "python")[0]
    assert (s.line, s.line_end) == (1, 2)




def test_rpc_session_dispatch(sample_root):
    s = rpc.RpcSession(default_path=str(sample_root), boundary="root")
    resp = s.handle({"id": 1, "method": "health", "params": {}})
    assert resp["ok"] and "search" in resp["data"]["methods"]
    resp = s.handle({"id": 2, "method": "search", "params": {"pattern": "def"}})
    assert resp["ok"] and resp["data"]["total"] >= 1
    resp = s.handle({"id": 3, "method": "nope", "params": {}})
    assert not resp["ok"] and "Unknown method" in resp["error"]


def test_rpc_subprocess_no_responses_for_blank_lines(sample_root):
    proc = subprocess.Popen(
        [sys.executable, "-m", "aisearch", "rpc", "--root", str(sample_root)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True,
    )
    payload = json.dumps({"id": 1, "method": "health", "params": {}}) + "\n"
    out, err = proc.communicate(payload, timeout=60)
    lines = [l for l in out.splitlines() if l.strip()]
    assert len(lines) == 1
    assert json.loads(lines[0])["data"]["version"]
