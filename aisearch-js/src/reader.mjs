







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


export const MAX_FILE_BYTES = 5 * 1024 * 1024;


const PREVIEW_LINES = 200;


const SYMBOL_SCAN_CAP = 200_000;


export const MAX_CONTENT_CHARS = 200_000;


export function _cap_content(text) {
  
  if (text.length <= MAX_CONTENT_CHARS) return [text, false];
  return [text.slice(0, MAX_CONTENT_CHARS), true];
}


export function _is_binary(full) {
  
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
      return false;
    }
    return head.includes(0);
  } catch {
    return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {

    }
  }
}




export function read_result_to_dict(r) {
  if (!r.ok) return { ok: false, error: r.error };

  const [content, capped] = _cap_content(r.content ?? "");
  let end = r.end;
  if (capped && r.start) {

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

  if (r.symbols.length) d.data.symbols = r.symbols;
  if (r.truncated || capped) d.data.truncated = true;


  return d;
}

export function context_result_to_dict(r) {
  if (!r.ok) return { ok: false, error: r.error };
  const [content, capped] = _cap_content(r.content ?? "");


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
  } catch {  }
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




function* iter_lines_sync(p, encoding) {
  
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




export function _resolve_path(file_ref, root, boundary = "root") {
  








  try {
    const as_whole = safe_resolve(file_ref, root, boundary);
    try {
      if (fs.statSync(as_whole).isFile()) {
        return [as_whole, null, null, null];
      }
    } catch {

    }
  } catch {

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


  if (_is_binary(full)) {
    return fail_read(`Binary file (${st.size} bytes); not text`, {
      file: rel, language: lang,
    });
  }


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


  if (start_line && end_line && start_line > end_line) {
    const r = fail_read(`Invalid line range: ${start_line} > ${end_line}`);
    r.file = rel;
    r.language = lang;
    return r;
  }


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




export function get_context(file_ref, line, path_arg = ".", radius = 5, boundary = "root", human = false) {
  
  const root = find_project_root(path_arg);



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


  const r_parsed = py_int(radius);
  if (r_parsed === null) {
    throw new PyValueError(`invalid literal for int() with base 10: '${radius}'`);
  }
  radius = Math.max(0, Math.min(r_parsed, 200));

  const rel = _rel(root, full);
  const lang = detect_lang(full);
  const large = st.size > MAX_FILE_BYTES;


  if (_is_binary(full)) {
    return fail_ctx(`Binary file (${st.size} bytes); not text`, {
      file: rel, language: lang, line,
    });
  }


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


  let containing_sym = null;
  if (lang) {
    const sym = find_containing_symbol(lines, lang, line);
    if (sym) containing_sym = symbol_to_dict(sym);
  }


  const imports = lang ? extract_imports(lines, lang) : [];


  let outline = [];
  if (lang && human) {
    const syms = extract_symbols(lines, lang, rel);
    outline = syms.map(symbol_to_dict);
  }


  const ctx_start = Math.max(0, line - 1 - radius);
  const ctx_end = Math.min(total, line + radius);
  const ctx_content = lines.slice(ctx_start, ctx_end).join("\n");

  return {
    ok: true, file: rel, line, content: ctx_content,
    language: lang, containing_symbol: containing_sym,
    imports, outline, total_lines: total, window_start: ctx_start + 1, error: "",
  };
}
