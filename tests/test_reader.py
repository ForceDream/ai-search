from aisearch import reader


def test_read_full_file(sample_root):
    res = reader.read_file("src/main.py", path=str(sample_root))
    assert res.ok
    assert "def process_data" in res.content
    assert res.total_lines > 0


def test_read_line_range(sample_root):
    res = reader.read_file("src/main.py:3-5", path=str(sample_root))
    assert res.ok
    assert res.start == 3
    assert res.end == 5


def test_read_symbol(sample_root):
    res = reader.read_file("src/main.py#process_data", path=str(sample_root))
    assert res.ok
    assert res.symbol is not None
    assert res.symbol["name"] == "process_data"
    assert "def process_data" in res.content


def test_read_outline(sample_root):
    res = reader.read_file("src/main.py", path=str(sample_root), outline_only=True)
    assert res.ok
    names = {s["name"] for s in res.symbols}
    assert "App" in names
    assert "process_data" in names
    assert res.content == ""


def test_read_missing_file(sample_root):
    res = reader.read_file("src/nope.py", path=str(sample_root))
    assert not res.ok
    assert "File not found" in res.error


def test_read_traversal_blocked(sample_root):
    res = reader.read_file("../conftest.py", path=str(sample_root))
    assert not res.ok
    assert "escapes project root" in res.error


def test_get_context(sample_root):
    from aisearch.symbols import extract_symbols, detect_lang
    text = (sample_root / "src/main.py").read_text()
    lines = text.splitlines()
    run_line = next(
        s.line for s in extract_symbols(lines, "python") if s.name == "run"
    )
    res = reader.get_context("src/main.py", line=run_line, path=str(sample_root))
    assert res.ok
    assert res.containing_symbol is not None
    assert res.containing_symbol["name"] == "run"
    assert "os" in res.imports




def _mini_project(tmp_path):
    (tmp_path / "pyproject.toml").write_text("[project]\nname='t'\n")
    return tmp_path


def test_binary_file_rejected(tmp_path):
    """二进制文件应结构化拒绝，而不是按文本读出乱码。"""
    root = _mini_project(tmp_path)
    (root / "blob.png").write_bytes(b"\x89PNG\r\n\x1a\n" + bytes(range(256)) * 8)
    res = reader.read_file("blob.png", path=str(root))
    assert not res.ok
    assert "Binary file" in res.error


def test_binary_file_rejected_for_context(tmp_path):
    root = _mini_project(tmp_path)
    (root / "blob.png").write_bytes(b"\x89PNG\r\n\x1a\n" + bytes(range(256)) * 8)
    res = reader.get_context("blob.png", line=1, path=str(root))
    assert not res.ok
    assert "Binary file" in res.error


def test_huge_single_line_content_capped(tmp_path):
    """超长单行（预览按行截断失效）必须按字符上限截断。"""
    root = _mini_project(tmp_path)
    (root / "huge.py").write_text("x = '" + "a" * 300_000 + "'\n")
    res = reader.read_file("huge.py", path=str(root))
    assert res.ok
    assert res.truncated is True
    assert len(res.content) == reader.MAX_CONTENT_CHARS


def test_content_cap_updates_line_range(tmp_path):
    """截断后 lines.end 必须反映实际覆盖范围，而不是仍报整文件。"""
    root = _mini_project(tmp_path)
    (root / "big.py").write_text("".join(f"x{i} = 1\n" for i in range(60000)))
    res = reader.read_file("big.py", path=str(root))
    assert res.ok
    assert res.truncated is True
    assert len(res.content) == reader.MAX_CONTENT_CHARS
    assert res.end < res.total_lines
    assert res.end == res.content.count("\n") + 1


def test_ctx_content_capped(tmp_path):
    root = _mini_project(tmp_path)
    (root / "huge.py").write_text("x = '" + "a" * 300_000 + "'\n")
    res = reader.get_context("huge.py", line=1, path=str(root))
    assert res.ok
    assert res.truncated is True
    assert len(res.content) == reader.MAX_CONTENT_CHARS


def test_utf16_bom_not_treated_as_binary(tmp_path):
    """带 BOM 的 UTF-16 含 NUL 字节，但属于文本，不应被误判为二进制。"""
    root = _mini_project(tmp_path)
    (root / "u16.py").write_bytes(b"\xff\xfe" + "def f():\n    return 1\n".encode("utf-16-le"))
    res = reader.read_file("u16.py", path=str(root))
    assert res.ok
    assert "def f" in res.content


def test_get_context_out_of_range(sample_root):
    res = reader.get_context("src/main.py", line=99999, path=str(sample_root))
    assert not res.ok
