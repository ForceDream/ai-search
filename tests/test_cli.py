import json
import sys

import pytest

from aisearch.cli import main


def _run(capsys, argv):
    sys.argv = ["aisearch"] + argv
    main()
    out = capsys.readouterr().out
    return json.loads(out)


def test_cli_grep(sample_root, capsys):
    data = _run(capsys, ["grep", "process_data", str(sample_root), "--json"])
    assert data["ok"]
    assert data["data"]["total"] >= 1


def test_cli_sym(sample_root, capsys):
    data = _run(capsys, ["sym", "process", str(sample_root), "--json"])
    assert data["ok"]
    assert any(m["name"] == "process_data" for m in data["data"]["matches"])


def test_cli_def(sample_root, capsys):
    data = _run(capsys, ["def", "App", str(sample_root), "--json"])
    assert data["ok"]
    assert data["data"]["matches"][0]["kind"] == "class"


def test_cli_ref(sample_root, capsys):
    data = _run(capsys, ["ref", "process_data", str(sample_root), "--json"])
    assert data["ok"]
    assert data["data"]["total"] >= 1


def test_cli_cat_symbol(sample_root, capsys):
    data = _run(capsys, ["cat", "src/main.py#process_data", str(sample_root), "--json"])
    assert data["ok"]
    assert data["data"]["symbol"]["name"] == "process_data"


def test_cli_cat_outline(sample_root, capsys):
    data = _run(capsys, ["cat", "src/main.py", str(sample_root), "--outline", "--json"])
    assert data["ok"]
    assert data["data"]["symbols"]


def test_cli_ctx(sample_root, capsys):
    from aisearch.symbols import extract_symbols
    lines = (sample_root / "src/main.py").read_text().splitlines()
    run_line = next(
        s.line for s in extract_symbols(lines, "python") if s.name == "run"
    )
    data = _run(capsys, ["ctx", f"src/main.py:{run_line}", str(sample_root), "--json"])
    assert data["ok"]
    assert data["data"]["containing_symbol"]["name"] == "run"


def test_cli_tree(sample_root, capsys):
    data = _run(capsys, ["tree", str(sample_root), "--json"])
    assert data["ok"]
    assert any(e["name"] == "src" for e in data["data"]["tree"])


def test_cli_no_command_exits(capsys):
    sys.argv = ["aisearch"]
    with pytest.raises(SystemExit) as exc:
        main()
    assert exc.value.code == 1
