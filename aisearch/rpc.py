"""
stdio 无服务模式 —— 不需要监听任何端口。

用法（AI 集成推荐）：
    aisearch rpc                # 以 cwd 为项目根，CLI 级信任（boundary=system）
    aisearch rpc --root /path   # 锁定项目根并限制 boundary=root

协议：行分隔 JSON（stdin 进，stdout 出，每请求一行响应）
    请求: {"id": 1, "method": "search", "params": {"pattern": "def foo"}}
    响应: {"id": 1, "ok": true, "data": {...}}
    错误: {"id": 1, "ok": false, "error": "..."}

方法：search / symbols / def / ref / read / context / tree / health

rpc 由调用方（AI harness）以子进程拉起，
无端口、无网络监听、无鉴权需求；进程退出即结束，适合本地 AI Agent。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from . import __version__, engine, reader
from .config import find_project_root, is_relative_to


MAX_LINE_BYTES = 1 * 1024 * 1024

_METHODS = ("search", "symbols", "def", "ref", "read", "context", "tree", "health")


def _clamp(value, default, lo, hi):
    try:
        n = int(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return max(lo, min(hi, n))


class RpcSession:

    def __init__(self, default_path: str = ".", boundary: str = "system"):
        self.default_path = default_path
        self.boundary = boundary



    def handle(self, req: dict) -> dict:
        rid = req.get("id")
        method = req.get("method", "")
        params = req.get("params") or {}
        if not isinstance(params, dict):
            return {"id": rid, "ok": False, "error": "'params' must be an object"}

        handler = getattr(self, f"_m_{method}", None)
        if handler is None:
            return {
                "id": rid, "ok": False,
                "error": f"Unknown method '{method}'; available: {', '.join(_METHODS)}",
            }
        try:
            data = handler(params)
        except Exception as e:
            return {"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"}
        return {"id": rid, "ok": True, "data": data}



    def _path(self, params: dict) -> str:
        return params.get("path") or self.default_path

    def _check_path(self, params: dict) -> str:
        p = self._path(params)
        if self.boundary == "root":
            base = Path(self.default_path).resolve()
            root = find_project_root(p).resolve()
            if not is_relative_to(root, base):
                raise ValueError(f"Path '{p}' escapes project root")
        return p

    def _m_health(self, params: dict) -> dict:
        return {"version": __version__, "methods": list(_METHODS),
                "root": str(Path(self.default_path).resolve()),
                "boundary": self.boundary}

    def _m_search(self, params: dict) -> dict:
        pattern = params.get("pattern", "")
        if not pattern or not str(pattern).strip():
            raise ValueError("Missing 'pattern'")
        exts = params.get("extensions")
        if isinstance(exts, list):
            exts = {str(e).lower() if str(e).startswith(".") else f".{str(e).lower()}" for e in exts}
        elif isinstance(exts, str):
            exts = {e.lower() if e.startswith(".") else f".{e.lower()}" for e in exts.split(",")}
        resp = engine.search_text(
            pattern=pattern,
            path=self._check_path(params),
            extensions=exts,
            context_lines=params.get("context", 2),
            case_insensitive=bool(params.get("ignore_case", False)),
            max_results=params.get("limit", 50),
            whole_word=bool(params.get("whole_word", False)),
        )
        if not resp.ok:
            raise ValueError(resp.error)
        return resp.to_dict()["data"]

    def _m_symbols(self, params: dict) -> dict:
        name = params.get("name", "")
        if not name:
            raise ValueError("Missing 'name'")
        resp = engine.search_symbols(
            name=name,
            path=self._check_path(params),
            kind=params.get("kind"),
            max_results=params.get("limit", 50),
            partial=bool(params.get("partial", True)),
        )
        return resp.to_dict()["data"]

    def _m_def(self, params: dict) -> dict:
        name = params.get("name", "")
        if not name:
            raise ValueError("Missing 'name'")
        resp = engine.find_definition(
            name,
            self._check_path(params),
            max_results=params.get("limit", 50),
            substring_fallback=bool(params.get("substring_fallback", True)),
        )
        return resp.to_dict()["data"]

    def _m_ref(self, params: dict) -> dict:
        name = params.get("name", "")
        if not name:
            raise ValueError("Missing 'name'")
        resp = engine.find_references(
            name=name,
            path=self._check_path(params),
            max_results=params.get("limit", 100),
        )
        if not resp.ok:
            raise ValueError(resp.error)
        return resp.to_dict()["data"]

    def _m_read(self, params: dict) -> dict:
        file_ref = params.get("file", "")
        if not file_ref:
            raise ValueError("Missing 'file'")
        result = reader.read_file(
            file_ref=file_ref,
            path=self._path(params),
            outline_only=bool(params.get("outline", False)),
            boundary=self.boundary,
        )
        if not result.ok:
            raise ValueError(result.error)
        return result.to_dict()["data"]

    def _m_context(self, params: dict) -> dict:
        file_ref = params.get("file", "")
        line = _clamp(params.get("line", 0), 0, 0, 10**9)
        if not file_ref or line <= 0:
            raise ValueError("Missing 'file' and 'line'")
        result = reader.get_context(
            file_ref=file_ref,
            line=line,
            path=self._path(params),
            radius=_clamp(params.get("radius", 5), 5, 0, 200),
            boundary=self.boundary,
        )
        if not result.ok:
            raise ValueError(result.error)
        return result.to_dict()["data"]

    def _m_tree(self, params: dict) -> dict:
        return engine.project_tree(
            path=self._check_path(params),
            depth=params.get("depth", 3),
        )


def run_rpc(root: str | None = None):


    try:
        sys.stdin.reconfigure(encoding="utf-8", errors="replace")
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

    default_path = root if root else "."
    boundary = "root" if root else "system"
    session = RpcSession(default_path=default_path, boundary=boundary)

    stdin = sys.stdin
    stdout = sys.stdout

    def _emit(resp: dict) -> None:

        stdout.write(json.dumps(resp, ensure_ascii=False, separators=(",", ":")) + "\n")
        stdout.flush()

    def _handle_line(line: str) -> None:
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise ValueError("Request must be a JSON object")
        except (json.JSONDecodeError, ValueError) as e:
            _emit({"id": None, "ok": False, "error": f"Invalid request: {e}"})
            return
        _emit(session.handle(req))

    try:




        buf = b""
        dropping = False
        too_large = {"id": None, "ok": False,
                     "error": f"Request line too large (>{MAX_LINE_BYTES} bytes)"}
        while True:
            chunk = stdin.buffer.read1(65536) if hasattr(stdin, "buffer") else stdin.read(65536)
            if not chunk:
                break
            if isinstance(chunk, str):
                chunk = chunk.encode("utf-8", "replace")
            buf += chunk
            while True:
                nl = buf.find(b"\n")
                if nl < 0:
                    if not dropping and len(buf) > MAX_LINE_BYTES:
                        dropping = True
                        buf = b""
                        _emit(too_large)
                    break
                raw, buf = buf[:nl], buf[nl + 1:]
                if dropping:
                    dropping = False
                    continue
                if len(raw) > MAX_LINE_BYTES:
                    _emit(too_large)
                    continue

                line = raw.decode("utf-8", errors="replace").strip().lstrip("\ufeff").strip()
                if not line:
                    continue
                _handle_line(line)
        if buf and not dropping:

            if len(buf) > MAX_LINE_BYTES:
                _emit(too_large)
            else:
                line = buf.decode("utf-8", errors="replace").strip().lstrip("\ufeff").strip()
                if line:
                    _handle_line(line)
    except BrokenPipeError:

        return
    except KeyboardInterrupt:
        return
