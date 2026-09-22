




import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import {
  DEFAULT_IGNORE,
  build_file_list,
  decode_buffer,
  detect_lang,
  find_project_root,
  is_relative_to,
  load_extra_ignore,
  should_ignore,
} from "./config.mjs";
import { extract_symbols, find_containing_symbol, symbol_to_dict } from "./symbols.mjs";
import { abs_path, escape_regex, rstrip, rstrip_nl, round1, safe_int, splitLines } from "./util.mjs";



export function match_to_dict(m) {
  const d = {
    file: m.file,
    line: m.line,
    col: m.col,
    text: m.text,
  };
  if (m.symbol) d.symbol = m.symbol;
  if (m.context_before.length) d.context_before = m.context_before;
  if (m.context_after.length) d.context_after = m.context_after;
  return d;
}

function _byte_offset_to_col(text, byteOff) {
  




  if (byteOff <= 0) return 0;
  let acc = 0;
  let i = 0;
  for (const ch of text) {
    if (acc >= byteOff) return i;
    acc += Buffer.byteLength(ch, "utf8");
    i += 1;
  }
  return i;
}


export function make_match(file, line, col, text) {
  return {
    file, line, col, text,
    symbol: null,
    context_before: [],
    context_after: [],
  };
}

function fail_response(error) {
  return { ok: false, matches: [], total: 0, files_searched: 0, elapsed_ms: 0, error };
}

export function search_response_to_dict(r) {
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    data: {
      matches: r.matches.map(match_to_dict),
      total: r.total,
      files_searched: r.files_searched,
      elapsed_ms: round1(r.elapsed_ms),
    },
  };
}

export function symbol_match_to_dict(m) {
  const d = symbol_to_dict(m.symbol);
  d.file = m.file;
  d.text = m.line_text;
  return d;
}

export function symbol_response_to_dict(r) {
  if (!r.ok) return { ok: false, error: r.error };
  const data = {
    matches: r.matches.map(symbol_match_to_dict),
    total: r.total,
    files_searched: r.files_searched,
    elapsed_ms: round1(r.elapsed_ms),
  };
  if (r.match_mode) data.match_mode = r.match_mode;
  return { ok: true, data };
}



export const MAX_RESULTS_CAP = 5000;
export const MAX_TREE_DEPTH = 16;
export const MAX_CONTEXT_LINES = 200;
export const MAX_PATTERN_LEN = 256;


const REDOS_RE = /\([^()]*[*+][^()]*\)\s*(?:[*+]|\{\d+,\})/;




let _has_rg = null;

export function has_ripgrep() {
  if (_has_rg === null) {

    if (process.env.AISEARCH_NO_RG) {
      _has_rg = false;
      return _has_rg;
    }
    try {
      const r = spawnSync("rg", ["--version"], { timeout: 5000 });
      _has_rg = r.status === 0;
    } catch {
      _has_rg = false;
    }
  }
  return _has_rg;
}




export function _search_with_rg(
  pattern, root, scope, extensions, ignore,
  context_lines, case_insensitive, max_results, whole_word, literal = false,
) {
  const t0 = performance.now();
  const cmd = [
    "--json",
    "-C", String(context_lines),
    "--max-count", String(Math.max(1, max_results * 3)),
  ];
  if (case_insensitive) cmd.push("-i");
  if (whole_word) cmd.push("-w");
  if (extensions) {
    for (const ext of extensions) cmd.push("-g", `*${ext}`);
  }

  for (const ig of ignore) cmd.push("--glob", `!${ig}`);



  cmd.push("-e", literal ? escape_regex(pattern) : pattern);

  cmd.push(scope ? path.relative(root, scope) : ".");

  let proc;
  try {
    proc = spawnSync("rg", cmd, {
      cwd: root,
      timeout: 30000,
      maxBuffer: 256 * 1024 * 1024,
      encoding: "utf8",
    });
  } catch {
    return fail_response("Search failed to start");
  }

  if (proc.error && proc.error.code === "ETIMEDOUT") {
    return fail_response("Search timed out (30s)");
  }


  const returncode = proc.status;
  if (returncode !== 0 && returncode !== 1) {
    const err_lines = (proc.stderr || "").trim().split("\n").filter(Boolean);
    const msg = err_lines.length
      ? err_lines[err_lines.length - 1]
      : `ripgrep exited with ${returncode}`;
    return fail_response(msg);
  }

  const matches = [];
  const files_searched = new Set();
  let current_file = "";
  const file_matches = [];
  const ctx_lines = new Map();





  const attachContext = () => {
    if (context_lines > 0) {
      for (const m of file_matches) {
        const before = [];
        for (let k = Math.max(1, m.line - context_lines); k < m.line; k++) {
          if (ctx_lines.has(k)) before.push(ctx_lines.get(k));
        }
        const after = [];
        for (let k = m.line + 1; k <= m.line + context_lines; k++) {
          if (ctx_lines.has(k)) after.push(ctx_lines.get(k));
        }
        m.context_before = before;
        m.context_after = after;
      }
    }
    file_matches.length = 0;
    ctx_lines.clear();
  };

  const out = proc.stdout || "";
  for (const line_text of out.split("\n")) {
    if (!line_text) continue;
    let msg;
    try {
      msg = JSON.parse(line_text);
    } catch {
      continue;
    }

    const msg_type = msg.type;
    const data = msg.data ?? {};

    if (msg_type === "begin") {

      attachContext();
      current_file = (data.path && data.path.text) || "";
      files_searched.add(current_file);

    } else if (msg_type === "match") {
      const path_text = (data.path && data.path.text) || "";
      const line_num = data.line_number ?? 0;
      const line_content = rstrip_nl((data.lines && data.lines.text) || "");
      const subs = data.submatches ?? [];

      const col = subs.length ? _byte_offset_to_col(line_content, subs[0].start) : 0;

      const rel_path = _rel_path(path_text, root);

      const m = make_match(rel_path, line_num, col, line_content);
      matches.push(m);
      file_matches.push(m);

    } else if (msg_type === "context") {

      ctx_lines.set(data.line_number ?? 0, rstrip_nl((data.lines && data.lines.text) || ""));

    } else if (msg_type === "end") {
      attachContext();
    }
  }


  attachContext();


  const truncated = matches.slice(0, max_results);

  const elapsed = performance.now() - t0;
  return {
    ok: true,
    matches: truncated,
    total: truncated.length,
    files_searched: files_searched.size,
    elapsed_ms: elapsed,
    error: "",
  };
}


function _rel_path(full, root) {



  const p = full.startsWith("./") ? full.slice(2) : full;
  try {
    if (path.isAbsolute(p)) {
      const rel = path.relative(root, p);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return rel;
      return p;
    }
    return p;
  } catch {
    return p;
  }
}


export function _resolve_scope(path_arg, root) {
  




  let p;
  try {
    p = abs_path(path_arg);
  } catch {
    return null;
  }
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return null;
  }
  if (st.isFile()) return p;
  const root_r = abs_path(root);
  if (st.isDirectory() && p !== root_r && is_relative_to(p, root_r)) return p;
  return null;
}




export function _search_with_regex(
  pattern, root, scope, extensions, ignore,
  context_lines, case_insensitive, max_results, whole_word, literal = false,
) {
  const t0 = performance.now();

  const flags = case_insensitive ? "i" : "";

  if (!whole_word && REDOS_RE.test(pattern)) {
    return fail_response(
      "Pattern may cause catastrophic backtracking (nested quantifiers); " +
      "simplify it (e.g. (a+)+ -> a+) or install ripgrep for linear-time search",
    );
  }

  let pat;
  try {





    const src = literal ? escape_regex(pattern) : pattern;
    const body = whole_word ? `(?<!\\w)${src}(?!\\w)` : src;
    pat = new RegExp(body, flags);
  } catch (e) {
    return fail_response(`Invalid regex: ${e.message}`);
  }


  let base = root;
  let prefix = "";
  let names = build_file_list(root, extensions, ignore);
  if (scope) {
    let is_file = false;
    try {
      is_file = fs.statSync(scope).isFile();
    } catch {
      is_file = false;
    }
    if (is_file) {
      base = path.dirname(scope);
      names = [path.basename(scope)];
    } else {
      base = scope;
      names = build_file_list(scope, extensions, ignore);
    }
    if (base !== root) {
      const r = path.relative(root, base);
      prefix = r === "" ? "" : r;
    }
  }

  const matches = [];
  let files_searched = 0;

  outer:
  for (const fname of names) {
    const full = path.join(base, fname);
    const fpath = prefix ? path.join(prefix, fname) : fname;
    let text;
    try {
      text = decode_buffer(fs.readFileSync(full));
    } catch {
      continue;
    }

    const lines = splitLines(text);
    files_searched += 1;

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      pat.lastIndex = 0;
      const m = pat.exec(line);
      if (m) {
        const cb = lines.slice(Math.max(0, idx - context_lines), idx);
        const ca = lines.slice(idx + 1, idx + 1 + context_lines);


        const col = Array.from(line.slice(0, m.index)).length;
        const match = make_match(fpath, idx + 1, col, line);
        match.context_before = cb;
        match.context_after = ca;
        matches.push(match);
        if (matches.length >= max_results) break outer;
      }
    }
  }

  const elapsed = performance.now() - t0;
  return {
    ok: true,
    matches,
    total: matches.length,
    files_searched,
    elapsed_ms: elapsed,
    error: "",
  };
}




export function search_text(
  pattern,
  path_arg = ".",
  extensions = null,
  context_lines = 2,
  case_insensitive = false,
  max_results = 50,
  whole_word = false,
  extra_ignore = null,
  literal = false,
) {
  const root = find_project_root(path_arg);
  const scope = _resolve_scope(path_arg, root);
  const ignore = [...DEFAULT_IGNORE, ...(extra_ignore ?? []), ...load_extra_ignore(root)];


  if (!pattern || !String(pattern).trim()) {
    return fail_response("Empty search pattern");
  }

  if (String(pattern).length > MAX_PATTERN_LEN) {
    return fail_response(
      `Search pattern too long (${String(pattern).length} chars > ${MAX_PATTERN_LEN})`,
    );
  }


  context_lines = safe_int(context_lines, 2, 0, MAX_CONTEXT_LINES);
  max_results = safe_int(max_results, 50, 1, MAX_RESULTS_CAP);

  if (has_ripgrep()) {
    return _search_with_rg(
      String(pattern), root, scope, extensions, ignore,
      context_lines, case_insensitive, max_results, whole_word, literal,
    );
  }
  return _search_with_regex(
    String(pattern), root, scope, extensions, ignore,
    context_lines, case_insensitive, max_results, whole_word, literal,
  );
}




function _resolve_scan_scope(path_arg, extra_ignore) {
  



  const root = find_project_root(path_arg);
  const scope = _resolve_scope(path_arg, root);
  const ignore = [...DEFAULT_IGNORE, ...(extra_ignore ?? []), ...load_extra_ignore(root)];
  let base = root;
  let prefix = "";
  let names = build_file_list(root, null, ignore);
  if (scope) {
    let is_file = false;
    try {
      is_file = fs.statSync(scope).isFile();
    } catch {
      is_file = false;
    }
    if (is_file) {
      base = path.dirname(scope);
      names = [path.basename(scope)];
    } else {
      base = scope;
      names = build_file_list(scope, null, ignore);
    }
    if (base !== root) {
      const r = path.relative(root, base);
      prefix = r === "" ? "" : r;
    }
  }
  return { base, names, prefix };
}


export function search_symbols(
  name,
  path_arg = ".",
  kind = null,
  max_results = 50,
  extra_ignore = null,
  partial = true,
) {
  




  const needle = partial ? name.toLowerCase() : null;
  const t0 = performance.now();
  max_results = safe_int(max_results, 50, 1, MAX_RESULTS_CAP);
  const { base, names, prefix } = _resolve_scan_scope(path_arg, extra_ignore);

  const matches = [];
  let searched = 0;

  for (const fname of names) {
    const fpath = prefix ? path.join(prefix, fname) : fname;
    const lang = detect_lang(fpath);
    if (!lang) continue;

    const full = path.join(base, fname);
    let lines;
    try {
      lines = splitLines(decode_buffer(fs.readFileSync(full)));
    } catch {
      continue;
    }

    searched += 1;
    const syms = extract_symbols(lines, lang, fpath);

    for (const s of syms) {
      const hit = partial
        ? s.name.toLowerCase().includes(needle)
        : s.name === name;
      if (!hit) continue;
      if (kind && s.kind !== kind) continue;
      const line_text = s.line <= lines.length ? lines[s.line - 1] : "";
      matches.push({ file: fpath, symbol: s, line_text: rstrip(line_text) });
      if (matches.length >= max_results) break;
    }

    if (matches.length >= max_results) break;
  }

  const elapsed = performance.now() - t0;
  return {
    ok: true,
    matches,
    total: matches.length,
    files_searched: searched,
    elapsed_ms: elapsed,
    error: "",
  };
}




export function find_definition(name, path_arg = ".", extra_ignore = null, max_results = 50, substring_fallback = true) {
  






  const priority = {
    class: 0, struct: 0, interface: 0, trait: 0,
    enum: 1, type: 1, function: 2, method: 3,
  };




  max_results = safe_int(max_results, 50, 1, MAX_RESULTS_CAP);
  const { base, names, prefix } = _resolve_scan_scope(path_arg, extra_ignore);
  const needle = name.toLowerCase();
  const t0 = performance.now();
  const exact = [];
  const sub = [];
  let searched = 0;

  for (const fname of names) {
    const fpath = prefix ? path.join(prefix, fname) : fname;
    const lang = detect_lang(fpath);
    if (!lang) continue;
    const full = path.join(base, fname);
    let lines;
    try {
      lines = splitLines(decode_buffer(fs.readFileSync(full)));
    } catch {
      continue;
    }
    searched += 1;

    for (const s of extract_symbols(lines, lang, fpath)) {
      if (s.name === name) {
        if (exact.length < max_results) {
          const line_text = s.line <= lines.length ? lines[s.line - 1] : "";
          exact.push({ file: fpath, symbol: s, line_text: rstrip(line_text) });
        }
      } else if (exact.length === 0 && sub.length < max_results && s.name.toLowerCase().includes(needle)) {



        const line_text = s.line <= lines.length ? lines[s.line - 1] : "";
        sub.push({ file: fpath, symbol: s, line_text: rstrip(line_text) });
      }
    }

    if (exact.length >= max_results) break;
  }

  const matches = exact.length || !substring_fallback ? exact : sub;
  const mode = matches === exact ? "exact" : "substring";
  const key = (m) => [
    m.symbol.name === name ? 0 : 1,
    Object.prototype.hasOwnProperty.call(priority, m.symbol.kind) ? priority[m.symbol.kind] : 99,
    m.symbol.line,
  ];
  matches.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < 3; i++) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    return 0;
  });
  return {
    ok: true,
    matches,
    total: matches.length,
    files_searched: searched,
    elapsed_ms: performance.now() - t0,
    error: "",
    match_mode: mode,
  };
}




export function find_references(name, path_arg = ".", max_results = 100, extra_ignore = null) {
  


  return search_text(
    name,
    path_arg,
    null,
    2,
    false,
    safe_int(max_results, 100, 1, MAX_RESULTS_CAP),
    true,
    extra_ignore,
    true,
  );
}




export function project_tree(path_arg = ".", depth = 3, extra_ignore = null) {
  const root = find_project_root(path_arg);
  const scope = _resolve_scope(path_arg, root);
  const ignore = [...DEFAULT_IGNORE, ...(extra_ignore ?? []), ...load_extra_ignore(root)];
  depth = safe_int(depth, 3, 0, MAX_TREE_DEPTH);


  let start = root;
  if (scope) {
    try {
      start = fs.statSync(scope).isDirectory() ? scope : path.dirname(scope);
    } catch {
      start = root;
    }
  }

  const result = {
    root: String(start),
    tree: _build_tree(root, start, depth, ignore),
  };
  if (start !== root) result.project_root = String(root);
  return result;
}


function _build_tree(root, current, depth, ignore) {
  if (depth <= 0) {
    return [{ name: "...", type: "truncated" }];
  }

  const entries = [];
  let dirents;
  try {
    dirents = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return entries;
  }


  const items = [];
  for (const d of dirents) {
    const full = path.join(current, d.name);
    let is_dir = d.isDirectory();
    if (!is_dir && d.isSymbolicLink()) {
      try {
        is_dir = fs.statSync(full).isDirectory();
      } catch {
        continue;
      }
    }
    items.push([!is_dir, d.name.toLowerCase(), d, full, is_dir]);
  }
  items.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] ? 1 : -1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });

  for (const [, , d, full, is_dir] of items) {
    const rel = path.relative(root, full);
    if (should_ignore(d.name, ignore, rel)) continue;
    if (is_dir) {
      entries.push({
        name: d.name,
        type: "dir",
        children: _build_tree(root, full, depth - 1, ignore),
      });
    } else {
      const lang = detect_lang(full);
      const entry = { name: d.name, type: "file" };
      if (lang) entry.lang = lang;
      try {
        entry.size = fs.statSync(full).size;
      } catch {

      }
      entries.push(entry);
    }
  }

  return entries;
}
