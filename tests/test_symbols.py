from aisearch.symbols import (
    extract_symbols,
    find_containing_symbol,
    find_symbol_by_name,
    extract_imports,
)


PY = [
    "import os",
    "",
    "def bootstrap():",
    "    return 1",
    "",
    "class App:",
    "    def __init__(self):",
    "        self.x = 0",
    "",
    "    def run(self):",
    "        return self.x",
]


def test_extract_python_symbols():
    syms = extract_symbols(PY, "python")
    names = {s.name for s in syms}
    assert "bootstrap" in names
    assert "App" in names
    assert "run" in names


def test_symbol_parent_for_method():
    syms = extract_symbols(PY, "python")
    run_sym = next(s for s in syms if s.name == "run")
    assert run_sym.parent == "App"
    assert run_sym.kind == "function"


def test_symbol_range_python():
    syms = extract_symbols(PY, "python")
    boot = next(s for s in syms if s.name == "bootstrap")
    assert boot.line_end >= boot.line


def test_find_symbol_by_name_exact():
    sym = find_symbol_by_name(PY, "python", "App")
    assert sym is not None
    assert sym.kind == "class"


def test_find_symbol_by_name_partial():
    sym = find_symbol_by_name(PY, "python", "boot", partial=True)
    assert sym is not None
    assert sym.name == "bootstrap"


def test_find_containing_symbol():
    sym = find_containing_symbol(PY, "python", 11)
    assert sym is not None
    assert sym.name == "run"


def test_extract_imports_python():
    imports = extract_imports(PY, "python")
    assert "os" in imports


TS = [
    "export class Controller {",
    "    handle_request() {",
    "        return 1;",
    "    }",
    "}",
    "",
    "function bootstrap() {",
    "    return 0;",
    "}",
]


def test_extract_typescript_symbols():
    syms = extract_symbols(TS, "typescript")
    kinds = {s.name: s.kind for s in syms}
    assert kinds.get("Controller") == "class"
    assert kinds.get("handle_request") == "method"
    assert kinds.get("bootstrap") == "function"


GO = [
    "package main",
    "",
    "func handleRequest() int {",
    "    return 1",
    "}",
    "",
    "type Server struct {",
    "    addr string",
    "}",
]


def test_extract_go_symbols():
    syms = extract_symbols(GO, "go")
    kinds = {s.name: s.kind for s in syms}
    assert kinds.get("handleRequest") == "function"
    assert kinds.get("Server") == "struct"
