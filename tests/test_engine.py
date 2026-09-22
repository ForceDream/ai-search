from aisearch import engine


def test_search_text_finds_def(sample_root):
    resp = engine.search_text("process_data", path=str(sample_root), max_results=10)
    assert resp.ok
    assert resp.total >= 1
    assert any("main.py" in m.file for m in resp.matches)


def test_search_text_with_extension_filter(sample_root):
    resp = engine.search_text("func", path=str(sample_root), extensions={".go"})
    assert resp.ok
    assert all(m.file.endswith(".go") for m in resp.matches)


def test_search_text_case_insensitive(sample_root):
    resp = engine.search_text("BOOTSTRAP", path=str(sample_root), case_insensitive=True)
    assert resp.ok
    assert resp.total >= 1


def test_search_symbols_partial(sample_root):
    resp = engine.search_symbols("process", path=str(sample_root))
    assert resp.ok
    assert any(m.symbol.name == "process_data" for m in resp.matches)


def test_search_symbols_exact(sample_root):
    resp = engine.search_symbols("process_data", path=str(sample_root), partial=False)
    assert resp.ok
    assert all(m.symbol.name == "process_data" for m in resp.matches)


def test_search_symbols_kind_filter(sample_root):
    resp = engine.search_symbols("App", path=str(sample_root), kind="class")
    assert resp.ok
    assert all(m.symbol.kind == "class" for m in resp.matches)


def test_find_definition_prioritizes_class(sample_root):
    resp = engine.find_definition("App", path=str(sample_root))
    assert resp.ok
    assert resp.matches[0].symbol.kind == "class"


def test_find_references(sample_root):
    resp = engine.find_references("process_data", path=str(sample_root))
    assert resp.ok
    assert resp.total >= 1


def test_project_tree(sample_root):
    tree = engine.project_tree(path=str(sample_root), depth=5)
    assert tree["root"]

    assert any(e["type"] == "dir" and e["name"] == "src" for e in tree["tree"])


def test_invalid_regex_returns_error(sample_root):
    resp = engine.search_text(r"([a-z", path=str(sample_root))

    assert (not resp.ok) or resp.total == 0




def _norm(p: str) -> str:
    return p.replace("\\", "/")


def test_search_text_scoped_to_single_file(sample_root):
    """path 指向单文件时只搜该文件。"""
    target = sample_root / "src" / "main.py"
    resp = engine.search_text("def", path=str(target), max_results=100)
    assert resp.ok
    assert resp.files_searched == 1
    assert resp.total >= 1
    assert {_norm(m.file) for m in resp.matches} == {"src/main.py"}


def test_search_text_scoped_to_subdir(sample_root):
    """path 指向子目录时只搜该子树。"""
    resp = engine.search_text("def", path=str(sample_root / "src"), max_results=100)
    assert resp.ok
    assert all(_norm(m.file).startswith("src/") for m in resp.matches)


def test_search_symbols_scoped_to_single_file(sample_root):
    """符号搜索同样支持按文件限定。"""
    target = sample_root / "src" / "main.py"
    resp = engine.search_symbols("process", path=str(target))
    assert resp.ok
    assert resp.files_searched == 1
    assert all(_norm(m.file) == "src/main.py" for m in resp.matches)


def test_project_tree_started_at_subdir(sample_root):
    """tree 传子目录时以该目录为显示起点，并给出 project_root。"""
    tree = engine.project_tree(path=str(sample_root / "src"), depth=5)
    names = [e["name"] for e in tree["tree"]]
    assert "main.py" in names
    assert "src" not in names
    assert tree.get("project_root")
