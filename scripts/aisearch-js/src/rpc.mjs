/**
 * stdio 无服务模式 —— 不需要监听任何端口。对齐 Python 版 rpc.py。
 *
 * 用法（AI 集成推荐）：
 *   aisearch rpc                # 以 cwd 为项目根，CLI 级信任（boundary=system）
 *   aisearch rpc --root /path   # 锁定项目根并限制 boundary=root
 *
 * 协议：行分隔 JSON（stdin 进，stdout 出，每请求一行响应）
 *   请求: {"id": 1, "method": "search", "params": {"pattern": "def foo"}}
 *   响应: {"id": 1, "ok": true, "data": {...}}
 *   错误: {"id": 1, "ok": false, "error": "..."}
 *
 * 方法：search / symbols / def / ref / read / context / tree / health
 */

import path from "node:path";
import readline from "node:readline";

import { VERSION, find_project_root, is_relative_to } from "./config.mjs";
import * as engine from "./engine.mjs";
import * as reader from "./reader.mjs";
import { PyValueError, safe_int } from "./util.mjs";

// 单行请求上限（字符），防止恶意超大行撑爆内存
export const MAX_LINE_BYTES = 1 * 1024 * 1024; // 1 MB

export const METHODS = ["search", "symbols", "def", "ref", "read", "context", "tree", "health"];


export class RpcSession {
  /** 一次 rpc 会话：持有默认路径与边界策略。 */
  constructor(default_path = ".", boundary = "system") {
    this.default_path = default_path;
    this.boundary = boundary;
    this._handlers = {
      health: (p) => this._m_health(p),
      search: (p) => this._m_search(p),
      symbols: (p) => this._m_symbols(p),
      def: (p) => this._m_def(p),
      ref: (p) => this._m_ref(p),
      read: (p) => this._m_read(p),
      context: (p) => this._m_context(p),
      tree: (p) => this._m_tree(p),
    };
  }

  // ── 单请求处理 ──────────────────────────────

  handle(req) {
    const rid = req.id === undefined ? null : req.id;
    const method = req.method ?? "";
    // 对齐 Python `req.get("params") or {}`：
    // falsy（None/空数组/空串/0/False）→ {}；非 dict 的真值 → 报错
    let raw_params = req.params;
    let params;
    if (!raw_params || (Array.isArray(raw_params) && raw_params.length === 0)) {
      params = {};
    } else if (typeof raw_params !== "object" || Array.isArray(raw_params)) {
      return { id: rid, ok: false, error: "'params' must be an object" };
    } else {
      params = raw_params;
    }

    const handler = Object.prototype.hasOwnProperty.call(this._handlers, method)
      ? this._handlers[method]
      : null;
    if (handler === null) {
      return {
        id: rid, ok: false,
        error: `Unknown method '${method}'; available: ${METHODS.join(", ")}`,
      };
    }
    try {
      const data = handler(params);
      return { id: rid, ok: true, data };
    } catch (e) {
      // 任何处理异常都转为结构化错误，绝不崩进程
      return { id: rid, ok: false, error: `${e.name}: ${e.message}` };
    }
  }

  // ── 方法实现 ────────────────────────────────

  _path(params) {
    return params.path || this.default_path;
  }

  _checkPath(params) {
    /**
     * boundary=root 时校验查询路径锁定在本项目内，防止通过
     * path=/ 或 ../../ 越权枚举任意目录（search/symbols/def/ref/tree）。
     * 校验 find_project_root 的结果：所有文件读取都发生在该 root 下。
     */
    const p = this._path(params);
    if (this.boundary === "root") {
      const base = path.resolve(this.default_path);
      const root = path.resolve(find_project_root(p));
      if (!is_relative_to(root, base)) {
        throw new PyValueError(`Path '${p}' escapes project root`);
      }
    }
    return p;
  }

  _m_health() {
    return {
      version: VERSION,
      methods: METHODS.slice(),
      root: path.resolve(this.default_path),
      boundary: this.boundary,
    };
  }

  _m_search(params) {
    const pattern = params.pattern ?? "";
    if (!pattern || !String(pattern).trim()) {
      throw new PyValueError("Missing 'pattern'");
    }
    let exts = null;
    const raw_exts = params.extensions;
    const norm_ext = (e) => (e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`);
    if (Array.isArray(raw_exts)) {
      exts = new Set(raw_exts.map((e) => norm_ext(String(e))));
    } else if (typeof raw_exts === "string") {
      exts = new Set(raw_exts.split(",").map((e) => norm_ext(e)));
    }
    const resp = engine.search_text(
      pattern,
      this._checkPath(params),
      exts,
      params.context ?? 2,
      Boolean(params.ignore_case),
      params.limit ?? 50,
      Boolean(params.whole_word),
    );
    if (!resp.ok) throw new PyValueError(resp.error);
    return engine.search_response_to_dict(resp).data;
  }

  _m_symbols(params) {
    const name = params.name ?? "";
    if (!name) throw new PyValueError("Missing 'name'");
    const resp = engine.search_symbols(
      name,
      this._checkPath(params),
      params.kind ?? null,
      params.limit ?? 50,
      null,
      params.partial === undefined ? true : Boolean(params.partial),
    );
    return engine.symbol_response_to_dict(resp).data;
  }

  _m_def(params) {
    const name = params.name ?? "";
    if (!name) throw new PyValueError("Missing 'name'");
    const resp = engine.find_definition(
      name,
      this._checkPath(params),
      null,
      params.limit ?? 50,
      params.substring_fallback === undefined ? true : Boolean(params.substring_fallback),
    );
    return engine.symbol_response_to_dict(resp).data;
  }

  _m_ref(params) {
    const name = params.name ?? "";
    if (!name) throw new PyValueError("Missing 'name'");
    const resp = engine.find_references(
      name,
      this._checkPath(params),
      params.limit ?? 100,
    );
    if (!resp.ok) throw new PyValueError(resp.error);
    return engine.search_response_to_dict(resp).data;
  }

  _m_read(params) {
    const file_ref = params.file ?? "";
    if (!file_ref) throw new PyValueError("Missing 'file'");
    const result = reader.read_file(
      file_ref,
      this._path(params),
      Boolean(params.outline),
      this.boundary,
    );
    if (!result.ok) throw new PyValueError(result.error);
    return reader.read_result_to_dict(result).data;
  }

  _m_context(params) {
    const file_ref = params.file ?? "";
    const line = safe_int(params.line ?? 0, 0, 0, 1e9);
    if (!file_ref || line <= 0) {
      throw new PyValueError("Missing 'file' and 'line'");
    }
    const result = reader.get_context(
      file_ref,
      line,
      this._path(params),
      safe_int(params.radius ?? 5, 5, 0, 200),
      this.boundary,
    );
    if (!result.ok) throw new PyValueError(result.error);
    return reader.context_result_to_dict(result).data;
  }

  _m_tree(params) {
    return engine.project_tree(
      this._checkPath(params),
      params.depth ?? 3,
    );
  }
}


export function run_rpc(root = null) {
  /**
   * 运行 stdio 循环。root 非空时锁定项目根并启用 boundary=root；
   * 否则以 cwd 为默认路径，boundary=system（与 CLI 同级信任）。
   */
  const default_path = root ? root : ".";
  const boundary = root ? "root" : "system";
  const session = new RpcSession(default_path, boundary);

  // 调用方提前关闭管道：正常结束，不污染 stderr
  process.stdout.on("error", (e) => {
    if (e.code === "EPIPE") process.exit(0);
    throw e;
  });

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on("line", (raw) => {
    let resp;
    if (raw.length > MAX_LINE_BYTES) {
      resp = {
        id: null, ok: false,
        error: `Request line too large (>${MAX_LINE_BYTES} bytes)`,
      };
    } else {
      // 兼容 Windows 管道/PowerShell 在首行插入的 BOM（\uFEFF）
      const line = raw.trim().replace(/^\uFEFF/, "").trim();
      if (!line) return;
      let req;
      try {
        req = JSON.parse(line);
        if (req === null || typeof req !== "object" || Array.isArray(req)) {
          throw new PyValueError("Request must be a JSON object");
        }
      } catch (e) {
        resp = { id: null, ok: false, error: `Invalid request: ${e.message}` };
      }
      if (!resp) {
        resp = session.handle(req);
      }
    }
    process.stdout.write(JSON.stringify(resp) + "\n");
  });

  // stdin 结束即退出（对齐 Python for 循环自然结束）
  rl.on("close", () => {
    process.exit(0);
  });
}
