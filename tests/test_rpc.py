"""stdio 无服务模式（rpc）测试：协议、边界、端到端子进程。"""

import json
import subprocess
import sys
from pathlib import Path

import pytest

from aisearch import rpc


@pytest.fixture
def session(sample_root):
    return rpc.RpcSession(default_path=str(sample_root), boundary="root")


def _req(session, method, params, rid=1):
    return session.handle({"id": rid, "method": method, "params": params})




def test_health(session):
    resp = _req(session, "health", {})
    assert resp["ok"]
    assert "search" in resp["data"]["methods"]
    assert resp["data"]["boundary"] == "root"


def test_unknown_method(session):
    resp = _req(session, "nope", {})
    assert not resp["ok"]
    assert "Unknown method" in resp["error"]


def test_search(session):
    resp = _req(session, "search", {"pattern": "process_data"})
    assert resp["ok"]
    assert resp["data"]["total"] >= 1


def test_search_empty_pattern_raises(session):
    resp = _req(session, "search", {"pattern": "  "})
    assert not resp["ok"]


def test_symbols_and_def(session):
    resp = _req(session, "symbols", {"name": "process_data"})
    assert resp["ok"] and resp["data"]["total"] >= 1
    resp = _req(session, "def", {"name": "App"})
    assert resp["ok"]
    assert resp["data"]["matches"][0]["kind"] == "class"


def test_read_symbol(session):
    resp = _req(session, "read", {"file": "src/main.py#process_data"})
    assert resp["ok"]
    assert resp["data"]["symbol"]["name"] == "process_data"


def test_context(session):
    lines = (Path(session.default_path) / "src/main.py").read_text().splitlines()
    from aisearch.symbols import extract_symbols
    run_line = next(s.line for s in extract_symbols(lines, "python") if s.name == "run")
    resp = _req(session, "context", {"file": "src/main.py", "line": run_line})
    assert resp["ok"]
    assert resp["data"]["containing_symbol"]["name"] == "run"


def test_tree(session):
    resp = _req(session, "tree", {"depth": 2})
    assert resp["ok"]
    assert any(e["name"] == "src" for e in resp["data"]["tree"])




def test_rpc_root_boundary_blocks_traversal(session):
    resp = _req(session, "read", {"file": "../../../etc/passwd"})
    assert not resp["ok"]
    assert "escapes project root" in resp["error"]


def test_rpc_system_boundary_allows_absolute(sample_root):
    s = rpc.RpcSession(default_path=str(sample_root), boundary="system")
    resp = s.handle({"id": 1, "method": "read",
                     "params": {"file": "/etc/hostname"}})
    assert resp["ok"]


def test_rpc_bad_params_never_crash(session):
    for bad in [
        {"method": "search", "params": None},
        {"method": "search", "params": []},
        {"method": "read", "params": {}},
        {"method": "context", "params": {"file": "x.py", "line": "abc"}},
        {"method": "context", "params": {"file": "x.py", "line": -5}},
    ]:
        resp = session.handle({"id": 7, **bad})
        assert resp["id"] == 7
        assert not resp["ok"]


def test_rpc_missing_params_defaults(session):

    resp = session.handle({"id": 1, "method": "search"})
    assert resp["id"] == 1
    assert not resp["ok"]




def _run_rpc_proc(args, requests, raw_lines=None):
    proc = subprocess.Popen(
        [sys.executable, "-m", "aisearch", "rpc"] + args,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, encoding="utf-8",
    )
    payload = "".join(json.dumps(r) + "\n" for r in requests)
    payload += "".join(l + "\n" for l in (raw_lines or []))
    out, err = proc.communicate(payload, timeout=60)
    assert proc.returncode == 0, f"rpc exited {proc.returncode}: {err}"
    return [json.loads(l) for l in out.splitlines() if l.strip()]


def test_rpc_end_to_end_subprocess(sample_root):
    responses = _run_rpc_proc(
        ["--root", str(sample_root)],
        [
            {"id": 1, "method": "health", "params": {}},
            {"id": 2, "method": "search", "params": {"pattern": "process_data"}},
            {"id": 3, "method": "read", "params": {"file": "src/main.py#process_data"}},
            {"id": 4, "method": "bogus", "params": {}},
        ],
        raw_lines=["{not valid json"],
    )
    assert len(responses) == 5
    assert responses[0]["ok"] and responses[0]["data"]["version"]
    assert responses[1]["ok"] and responses[1]["data"]["total"] >= 1
    assert responses[2]["ok"]
    assert not responses[3]["ok"]
    assert responses[4]["id"] is None and not responses[4]["ok"]


def test_rpc_blank_and_oversize_lines(sample_root):
    proc = subprocess.Popen(
        [sys.executable, "-m", "aisearch", "rpc", "--root", str(sample_root)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True,
    )
    lines = [
        "",
        json.dumps({"id": 1, "method": "health", "params": {}}),
    ]
    out, err = proc.communicate("\n".join(lines) + "\n", timeout=60)
    resp_lines = [l for l in out.splitlines() if l.strip()]
    assert len(resp_lines) == 1
    assert json.loads(resp_lines[0])["id"] == 1
