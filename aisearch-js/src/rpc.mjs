














import path from "node:path";


import { VERSION, find_project_root, is_relative_to } from "./config.mjs";
import * as engine from "./engine.mjs";
import * as reader from "./reader.mjs";
import { PyValueError, safe_int, abs_path } from "./util.mjs";


export const MAX_LINE_BYTES = 1 * 1024 * 1024;

export const METHODS = ["search", "symbols", "def", "ref", "read", "context", "tree", "health"];


export class RpcSession {
  
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



  handle(req) {
    const rid = req.id === undefined ? null : req.id;
    const method = req.method ?? "";


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

      return { id: rid, ok: false, error: `${e.name}: ${e.message}` };
    }
  }



  _path(params) {
    return params.path || this.default_path;
  }

  _checkPath(params) {
    




    const p = this._path(params);
    if (this.boundary === "root") {
      const base = abs_path(this.default_path);
      const root = abs_path(find_project_root(p));
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
      root: abs_path(this.default_path),
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
  



  const default_path = root ? root : ".";
  const boundary = root ? "root" : "system";
  const session = new RpcSession(default_path, boundary);


  process.stdout.on("error", (e) => {
    if (e.code === "EPIPE") process.exit(0);
    throw e;
  });




  const tooLarge = {
    id: null, ok: false,
    error: `Request line too large (>${MAX_LINE_BYTES} bytes)`,
  };

  const handleLine = (line) => {
    let resp;
    try {
      const req = JSON.parse(line);
      if (req === null || typeof req !== "object" || Array.isArray(req)) {
        throw new PyValueError("Request must be a JSON object");
      }
      resp = session.handle(req);
    } catch (e) {
      resp = { id: null, ok: false, error: `Invalid request: ${e.message}` };
    }
    process.stdout.write(JSON.stringify(resp) + "\n");
  };

  let buf = Buffer.alloc(0);
  let dropping = false;
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk]);
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) {
        if (!dropping && buf.length > MAX_LINE_BYTES) {
          dropping = true;
          buf = Buffer.alloc(0);
          process.stdout.write(JSON.stringify(tooLarge) + "\n");
        }
        return;
      }
      const raw = buf.subarray(0, nl);
      buf = buf.subarray(nl + 1);
      if (dropping) {
        dropping = false;
        continue;
      }
      if (raw.length > MAX_LINE_BYTES) {
        process.stdout.write(JSON.stringify(tooLarge) + "\n");
        continue;
      }

      const line = raw.toString("utf8").trim().replace(/^\uFEFF/, "").trim();
      if (!line) continue;
      handleLine(line);
    }
  });


  process.stdin.on("end", () => {
    if (buf.length && !dropping) {
      if (buf.length > MAX_LINE_BYTES) {
        process.stdout.write(JSON.stringify(tooLarge) + "\n");
      } else {
        const line = buf.toString("utf8").trim().replace(/^\uFEFF/, "").trim();
        if (line) handleLine(line);
      }
    }
    process.exit(0);
  });
}
