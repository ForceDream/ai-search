/**
 * 智能文件阅读：按行读、按符号读、获取上下文 —— 对齐 Python 版 reader.py。
 *
 * A：编码自动探测（utf-8 → gb18030 → utf-16），中文文档不再乱码。
 * B：大文件（>5MB）按行范围流式读取，无范围时返回头部预览，不再硬拒。
 * C：JSON 正文只序列化一次；行号由 lines.{start,end} 提供（不再输出带行号副本）。
 */

import fs from "node:fs";
import path from "node:path";

import {
  detect_encoding_path,
  decode_buffer,
  detect_lang,
  find_project_root,
  is_relative_to,
  safe_resolve,
} from "./config.mjs";
import {
  compute_symbol_end_from_chunk,
  extract_imports,
  extract_symbols,
  find_containing_symbol,
  find_symbol_by_name,
  iter_symbol_decls,
  symbol_to_dict,
} from "./symbols.mjs";
import { PyValueError, py_int, splitLines } from "./util.mjs";

// 单文件读取上限（字节），中小文件整文件载入；超过则走流式路径
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB

// 大文件无范围全量读取时，返回的头部预览行数
const PREVIEW_LINES = 200;

// 大文件按符号读取时，为推算符号范围而向前扫描的最大行数
const SYMBOL_SCAN_CAP = 200_000;

// 单次返回正文上限（字符）：防止超大文件 / 超长单行撑爆 AI 上下文
export const MAX_CONTENT_CHARS = 200_000;


export function _cap_content(text) {
  /** 截断过长正文，返回 [正文, 是否被截断]。 */
  if (text.length <= MAX_CONTENT_CHARS) return [text, false];
  return [text.slice(0, MAX_CONTENT_CHARS), true];
}


export function _is_binary(full) {
  /** 无 BOM 且头部含 NUL 字节 → 视为二进制，避免按文本读出乱码。 */
  let fd;
  try {
    fd = fs.openSync(full, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, 8192, 0);
    const head = buf.subarray(0, n);
    if (head.length >= 2 &&
        ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff))) {
      return false; // UTF-16 BOM：属于文本
    }
    return head.includes(0);
  } catch {
    return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}


// ── 结果对象 to_dict ────────────────────────────────

export function read_result_to_dict(r) {
  if (!r.ok) return { ok: false, error: r.error };
  // 正文上限：超大文件 / 超长单行在此截断并标记 truncated
  const [content, capped] = _cap_content(r.content ?? "");
  let end = r.end;
  if (capped && r.start) {
    // lines.end 需反映实际返回范围，而不是仍报整文件
    const kept = (content.match(/\n/g) || []).length + 1;
    end = Math.min(end, r.start + kept - 1);
  }
  const d = {
    ok: true,
    data: {
      file: r.file,
      lines: { start: r.start, end },
      total_lines: r.total_lines,
      content,
    },
  };
  if (r.language) d.data.language = r.language;
  if (r.symbol) d.data.symbol = r.symbol;
  // 整文件大纲仅在 human（文本渲染）时才有值；AI/rpc 侧为空，自然不输出。
  if (r.symbols.length) d.data.symbols = r.symbols;
  if (r.truncated || capped) d.data.truncated = true;
  // 正文只序列化一次：content 纯文本 + lines.{start,end} 提供行号，
  // 避免重复输出带行号副本导致 ~2x token 浪费（与 Python 版对齐）。
  return d;
}

export function context_result_to_dict(r) {
  if (!r.ok) return { ok: false, error: r.error };
  const [content, capped] = _cap_content(r.content ?? "");
  // 字段顺序刻意安排：metadata（file/line/language/containing_symbol...）在前，
  // 大体积的 content 放最后——避免 Agent 只解析 JSON 前段就误判「没有 containing_symbol」。
  const d = {
    ok: true,
    data: {
      file: r.file,
      line: r.line,
    },
  };
  if (r.language) d.data.language = r.language;
  if (r.containing_symbol) d.data.containing_symbol = r.containing_symbol;
  if (r.imports.length) d.data.imports = r.imports;
  if (r.outline.length) d.data.file_outline = r.outline;
  if (r.total_lines) d.data.total_lines = r.total_lines;
  if (r.window_start) d.data.window_start = r.window_start;
  if (capped) d.data.truncated = true;
  d.data.content = content;
  return d;
}

// File not found 的可行动提示：file 里重复带了 root 最后一级目录名（如
// --root=.../my-project/src 却传 src/app.py，双写 src/）是高频误用
function file_nf_error(root, full) {
  let msg = `File not found: ${full}`;
  try {
    const rel = path.relative(root, full);
    const parts = rel.split(path.sep);
    if (parts.length > 1 && parts[0] === path.basename(root)) {
      const stripped = path.join(root, ...parts.slice(1));
      if (fs.existsSync(stripped) && fs.statSync(stripped).isFile()) {
        msg += ` (looks double-prefixed with the root's last segment '${parts[0]}/'; try file "${parts.slice(1).join('/')}")`;
      }
    }
  } catch { /* hint 尽力而为 */ }
  return msg;
}

function fail_read(error, extra = {}) {
  return {
    ok: false, file: "", language: null, start: 0, end: 0, total_lines: 0,
    content: "", symbol: null, symbols: [], truncated: false, window_start: 0,
    error, ...extra,
  };
}

function fail_ctx(error, extra = {}) {
  return {
    ok: false, file: "", line: 0, content: "", language: null,
    containing_symbol: null, imports: [], outline: [], total_lines: 0,
    window_start: 0, truncated: false, error, ...extra,
  };
}


// ── 大文件流式读取辅助（B）──────────────────────────

function* iter_lines_sync(p, encoding) {
  /** 按行同步流式产出（不含行终止符），避免整文件载入内存。 */
  const fd = fs.openSync(p, "r");
  try {
    const CHUNK = 1 << 20;
    const buf = Buffer.alloc(CHUNK);
    const decoder = new TextDecoder(encoding, { fatal: false });
    let pos = 0;
    let tail = "";
    for (;;) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      pos += n;
      const text = n > 0 ? decoder.decode(buf.subarray(0, n), { stream: true }) : decoder.decode();
      tail += text;
      let idx;
      while ((idx = tail.indexOf("\n")) >= 0) {
        let line = tail.slice(0, idx);
        tail = tail.slice(idx + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        yield line;
      }
      if (n === 0) {
        if (tail.length) yield tail;
        break;
      }
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

function stream_read_range(p, encoding, start, end) {
  const out = [];
  let i = 0;
  for (const line of iter_lines_sync(p, encoding)) {
    i += 1;
    if (i < start) continue;
    if (i > end) break;
    out.push(line);
  }
  return out.join("\n");
}

function stream_count_lines(p, encoding) {
  let total = 0;
  for (const _ of iter_lines_sync(p, encoding)) total += 1;
  return total;
}

function stream_head(p, encoding, preview) {
  const keep = [];
  let total = 0;
  for (const line of iter_lines_sync(p, encoding)) {
    total += 1;
    if (total <= preview) keep.push(line);
  }
  return { content: keep.join("\n"), total, truncated: total > preview };
}

function stream_read_chunk(p, encoding, start_line, cap) {
  const out = [];
  let i = 0;
  for (const line of iter_lines_sync(p, encoding)) {
    i += 1;
    if (i < start_line) continue;
    out.push(line);
    if (out.length >= cap) break;
  }
  return out;
}

function scan_decls_stream(p, encoding, lang) {
  if (!lang) return [];
  function* gen() {
    let i = 0;
    for (const line of iter_lines_sync(p, encoding)) {
      i += 1;
      yield [i, line];
    }
  }
  return iter_symbol_decls(gen(), lang);
}


// ── 解析文件路径引用 ─────────────────────────────────

export function _resolve_path(file_ref, root, boundary = "root") {
  /**
   * 解析多种文件引用格式：
   *   path/to/file.py
   *   path/to/file.py:10-50
   *   path/to/file.py:42
   *   path/to/file.py#symbol_name
   * 若整个引用本身就是一个存在的文件（文件名含 # 或 : 的场景），直接按普通路径处理。
   */
  // 先尝试整体作为一个路径（兼容文件名中含 # 或 : 的情况）
  try {
    const as_whole = safe_resolve(file_ref, root, boundary);
    try {
      if (fs.statSync(as_whole).isFile()) {
        return [as_whole, null, null, null];
      }
    } catch {
      // stat 失败 → 继续拆分解析
    }
  } catch {
    // 越界/NUL → 继续拆分解析（最后统一 safe_resolve 校验）
  }

  let path_part = file_ref;
  let start_line = null;
  let end_line = null;
  let symbol_name = null;

  if (path_part.includes("#")) {
    const i = path_part.lastIndexOf("#");
    symbol_name = path_part.slice(i + 1);
    path_part = path_part.slice(0, i);
    if (!symbol_name) {
      throw new PyValueError(`Empty symbol name after '#' in file reference: ${file_ref}`);
    }
  }

  if (path_part.includes(":")) {
    const i = path_part.lastIndexOf(":");
    // 跳过 Windows 盘符 C:（索引 1 处、后跟分隔符的冒号），不能当作行号分隔符
    const is_drive =
      i === 1 &&
      /[a-zA-Z]/.test(path_part[0]) &&
      (path_part.length === 2 || path_part[2] === "\\" || path_part[2] === "/");
    if (!is_drive && i > 1) {
      const line_spec = path_part.slice(i + 1);
      path_part = path_part.slice(0, i);
      if (line_spec.includes("-")) {
        const j = line_spec.indexOf("-");
        const a = py_int(line_spec.slice(0, j));
        const b = py_int(line_spec.slice(j + 1));
        if (a !== null && b !== null) {
          start_line = a;
          end_line = b;
        }
      } else {
        const a = py_int(line_spec);
        if (a !== null) {
          start_line = a;
          end_line = a;
        }
      }
    }
  }

  const full = safe_resolve(path_part, root, boundary);
  return [full, start_line, end_line, symbol_name];
}


function _rel(root, full) {
  if (is_relative_to(full, root)) {
    return path.relative(root, full);
  }
  return String(full);
}


function read_symbol_from_lines(lines, rel, lang, symbol_name, total, human = false) {
  const syms = lang ? extract_symbols(lines, lang, rel) : [];
  let sym = lang ? find_symbol_by_name(lines, lang, symbol_name) : null;
  if (sym === null && lang) {
    const needle = symbol_name.toLowerCase();
    const partials = syms.filter((s) => s.name.toLowerCase().includes(needle));
    if (partials.length === 1) {
      sym = partials[0];
    } else if (partials.length > 1) {
      const r = fail_read(
        `Symbol '${symbol_name}' is ambiguous (${partials.length} partial matches); ` +
        `candidates: ` + partials.slice(0, 20).map((s) => s.name).join(", ")
      );
      r.file = rel;
      r.language = lang;
      r.total_lines = total;
      r.symbols = syms.map(symbol_to_dict);
      return r;
    }
  }
  if (sym) {
    const s = Math.max(1, sym.line);
    const e = Math.min(total, sym.line_end);
    const content = lines.slice(s - 1, e).join("\n");
    return {
      ok: true, file: rel, language: lang,
      start: s, end: e, total_lines: total,
      content, window_start: s,
      symbol: symbol_to_dict(sym),
      symbols: human ? syms.filter((x) => x.line_end > 0).map(symbol_to_dict) : [],
      truncated: false, error: "",
    };
  }
  const r = fail_read(`Symbol '${symbol_name}' not found`);
  r.file = rel;
  r.language = lang;
  r.total_lines = total;
  r.symbols = syms.length ? syms.map(symbol_to_dict) : [];
  return r;
}

function read_symbol_large(full, rel, lang, symbol_name, encoding, human = false) {
  if (!lang) {
    const r = fail_read(`Symbol '${symbol_name}' not found (no language)`);
    r.file = rel;
    return r;
  }
  const decls = scan_decls_stream(full, encoding, lang);
  const total = stream_count_lines(full, encoding);

  const exact = decls.filter((s) => s.name === symbol_name);
  const needle = symbol_name.toLowerCase();
  const partials = decls.filter((s) => s.name.toLowerCase().includes(needle));
  let sym = exact.length ? exact[0] : null;
  if (sym === null && partials.length === 1) sym = partials[0];
  if (sym === null && partials.length > 1) {
    const r = fail_read(
      `Symbol '${symbol_name}' is ambiguous (${partials.length} partial matches); ` +
      `candidates: ` + partials.slice(0, 20).map((s) => s.name).join(", ")
    );
    r.file = rel;
    r.language = lang;
    r.total_lines = total;
    r.symbols = decls.map(symbol_to_dict);
    return r;
  }
  if (sym === null) {
    const r = fail_read(`Symbol '${symbol_name}' not found`);
    r.file = rel;
    r.language = lang;
    r.total_lines = total;
    r.symbols = decls.map(symbol_to_dict);
    return r;
  }

  const chunk = stream_read_chunk(full, encoding, sym.line, SYMBOL_SCAN_CAP);
  let end = compute_symbol_end_from_chunk(chunk, lang, sym);
  end = Math.min(end, total);
  const span = end - sym.line + 1;
  const content = span > 0 ? chunk.slice(0, span).join("\n") : "";
  return {
    ok: true, file: rel, language: lang,
    start: sym.line, end, total_lines: total,
    content, window_start: sym.line,
    symbol: symbol_to_dict(sym),
    symbols: human ? decls.map(symbol_to_dict) : [],
    truncated: false, error: "",
  };
}


export function read_file(file_ref, path_arg = ".", outline_only = false, boundary = "root", human = false) {
  /**
   * 读取文件，支持多种引用格式。
   * outline_only=true 时只返回符号大纲，不返回内容。
   * boundary="root" 时限制在项目根目录内；"system" 允许任意路径。
   */
  const root = find_project_root(path_arg);
  let full, start_line, end_line, symbol_name;
  try {
    [full, start_line, end_line, symbol_name] = _resolve_path(file_ref, root, boundary);
  } catch (e) {
    return fail_read(e.message);
  }

  let st;
  try {
    st = fs.statSync(full);
  } catch {
    return fail_read(file_nf_error(root, full));
  }
  if (!st.isFile()) {
    return fail_read(`Not a file: ${full}`);
  }

  const rel = _rel(root, full);
  const lang = detect_lang(full);
  const large = st.size > MAX_FILE_BYTES;

  // 二进制文件：按文本读只会产出乱码，直接结构化拒绝
  if (_is_binary(full)) {
    return fail_read(`Binary file (${st.size} bytes); not text`, {
      file: rel, language: lang,
    });
  }

  // ── 符号模式 ──
  if (symbol_name) {
    if (large) {
      const enc = detect_encoding_path(full);
      return read_symbol_large(full, rel, lang, symbol_name, enc, human);
    }
    let text;
    try {
      text = decode_buffer(fs.readFileSync(full));
    } catch (e) {
      return fail_read(e.message);
    }
    const lines = splitLines(text);
    return read_symbol_from_lines(lines, rel, lang, symbol_name, lines.length, human);
  }

  // ── 大纲模式 ──
  if (outline_only) {
    if (large) {
      const enc = detect_encoding_path(full);
      const decls = scan_decls_stream(full, enc, lang);
      const total = stream_count_lines(full, enc);
      return {
        ok: true, file: rel, language: lang,
        start: 1, end: 0, total_lines: total,
        content: "", symbol: null,
        symbols: decls.map(symbol_to_dict),
        truncated: false, window_start: 0, error: "",
      };
    }
    let text;
    try {
      text = decode_buffer(fs.readFileSync(full));
    } catch (e) {
      return fail_read(e.message);
    }
    const lines = splitLines(text);
    const syms = lang ? extract_symbols(lines, lang, rel) : [];
    return {
      ok: true, file: rel, language: lang,
      start: 1, end: lines.length, total_lines: lines.length,
      content: "", symbol: null,
      symbols: syms.map(symbol_to_dict),
      truncated: false, window_start: 1, error: "",
    };
  }

  // ── 行范围非法检查 ──
  if (start_line && end_line && start_line > end_line) {
    const r = fail_read(`Invalid line range: ${start_line} > ${end_line}`);
    r.file = rel;
    r.language = lang;
    return r;
  }

  // ── 大文件：按范围流式读；无范围则头部预览 ──
  if (large) {
    const enc = detect_encoding_path(full);
    const total = stream_count_lines(full, enc);
    if (start_line && end_line) {
      const content = stream_read_range(full, enc, start_line, end_line);
      let s = Math.max(1, start_line);
      let e = Math.min(total, end_line);
      e = Math.max(e, s);
      return {
        ok: true, file: rel, language: lang,
        start: s, end: e, total_lines: total, content, window_start: s,
        symbol: null, symbols: [], truncated: end_line < total, error: "",
      };
    }
    const { content, truncated } = stream_head(full, enc, PREVIEW_LINES);
    return {
      ok: true, file: rel, language: lang,
      start: 1, end: Math.min(PREVIEW_LINES, total), total_lines: total,
      content, window_start: 1,
      symbol: null, symbols: [], truncated, error: "",
    };
  }

  // ── 中小文件：整体载入（编码自动探测）──
  let text;
  try {
    text = decode_buffer(fs.readFileSync(full));
  } catch (e) {
    return fail_read(e.message);
  }

  const lines = splitLines(text);
  const total = lines.length;

  let s = start_line || 1;
  let e = end_line || total;
  s = Math.max(1, s);
  e = Math.min(total, e);
  if (s > total) {
    const r = fail_read(`Start line ${s} beyond end of file (${total} lines)`);
    r.file = rel;
    r.language = lang;
    r.total_lines = total;
    return r;
  }
  e = Math.max(e, s);

  const content = lines.slice(s - 1, e).join("\n");
  return {
    ok: true, file: rel, language: lang,
    start: s, end: e, total_lines: total,
    content, window_start: s,
    symbol: null, symbols: [], truncated: false, error: "",
  };
}


// ── 获取上下文 ──────────────────────────────────────

export function get_context(file_ref, line, path_arg = ".", radius = 5, boundary = "root", human = false) {
  /** 获取某一行的丰富上下文。 */
  const root = find_project_root(path_arg);

  // 复用统一解析（兼容 file:line、file#symbol 及文件名含特殊字符的情况），
  // 行号以显式参数为准
  let full;
  try {
    [full] = _resolve_path(file_ref, root, boundary);
  } catch (e) {
    return fail_ctx(e.message);
  }

  let st;
  try {
    st = fs.statSync(full);
  } catch {
    return fail_ctx(file_nf_error(root, full));
  }
  if (!st.isFile()) {
    return fail_ctx(`Not a file: ${full}`);
  }

  // 上下文半径上限，防止超大范围读取
  const r_parsed = py_int(radius);
  if (r_parsed === null) {
    throw new PyValueError(`invalid literal for int() with base 10: '${radius}'`);
  }
  radius = Math.max(0, Math.min(r_parsed, 200));

  const rel = _rel(root, full);
  const lang = detect_lang(full);
  const large = st.size > MAX_FILE_BYTES;

  // 二进制文件：按文本读只会产出乱码，直接结构化拒绝
  if (_is_binary(full)) {
    return fail_ctx(`Binary file (${st.size} bytes); not text`, {
      file: rel, language: lang, line,
    });
  }

  // ── 大文件：只流式读取窗口，避免整文件载入 ──
  if (large) {
    const enc = detect_encoding_path(full);
    const total = stream_count_lines(full, enc);
    if (line < 1 || line > total) {
      return fail_ctx(`Line ${line} out of range (1-${total})`);
    }
    const window_start = Math.max(1, line - radius);
    const window_end = line + radius;
    const content = stream_read_range(full, enc, window_start, window_end);
    return {
      ok: true, file: rel, line, content, language: lang,
      containing_symbol: null, imports: [], outline: [],
      total_lines: total, window_start, error: "",
    };
  }

  // ── 中小文件 ──
  let text;
  try {
    text = decode_buffer(fs.readFileSync(full));
  } catch (e) {
    return fail_ctx(e.message);
  }

  const lines = splitLines(text);
  const total = lines.length;
  if (line < 1 || line > total) {
    return fail_ctx(`Line ${line} out of range (1-${total})`);
  }

  // 包含的符号
  let containing_sym = null;
  if (lang) {
    const sym = find_containing_symbol(lines, lang, line);
    if (sym) containing_sym = symbol_to_dict(sym);
  }

  // imports
  const imports = lang ? extract_imports(lines, lang) : [];

  // 文件大纲（人类/文本渲染专属；AI（rpc）不需要，省 token）
  let outline = [];
  if (lang && human) {
    const syms = extract_symbols(lines, lang, rel);
    outline = syms.map(symbol_to_dict);
  }

  // 上下文窗口
  const ctx_start = Math.max(0, line - 1 - radius);
  const ctx_end = Math.min(total, line + radius);
  const ctx_content = lines.slice(ctx_start, ctx_end).join("\n");

  return {
    ok: true, file: rel, line, content: ctx_content,
    language: lang, containing_symbol: containing_sym,
    imports, outline, total_lines: total, window_start: ctx_start + 1, error: "",
  };
}
