/**
 * 核心搜索引擎 —— 对齐 Python 版 engine.py。
 * 文本搜索优先使用 ripgrep（速度快 10x+），不可用时回退到纯 JS 正则。
 */

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
import { escape_regex, rstrip, rstrip_nl, round1, safe_int, splitLines } from "./util.mjs";

// ── 数据结构 ────────────────────────────────────────

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

// ── 参数归一化 / 防护 ──────────────────────────────

export const MAX_RESULTS_CAP = 5000; // 单次查询结果上限，防止 DoS
export const MAX_TREE_DEPTH = 16;    // 目录树深度上限
export const MAX_CONTEXT_LINES = 200; // 上下文行数上限
export const MAX_PATTERN_LEN = 256;   // 搜索模式长度上限：缓解 ReDoS 回溯爆炸

// 嵌套量词在回溯引擎上指数级爆炸；仅在纯 JS 回退路径拒绝（rg 为线性引擎）。
const REDOS_RE = /\([^()]*[*+][^()]*\)\s*(?:[*+]|\{\d+,\})/;


// ── ripgrep 检测 ────────────────────────────────────

let _has_rg = null;

export function has_ripgrep() {
  if (_has_rg === null) {
    // AISEARCH_NO_RG=1 强制走纯实现（基准测试 / 调试用）
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


// ── ripgrep JSON 解析 ───────────────────────────────

export function _search_with_rg(
  pattern, root, scope, extensions, ignore,
  context_lines, case_insensitive, max_results, whole_word,
) {
  const t0 = performance.now();
  const cmd = [
    "--json",
    "-C", String(context_lines),
    "--max-count", String(Math.max(1, max_results * 3)), // 多取一些，后面截断
  ];
  if (case_insensitive) cmd.push("-i");
  if (whole_word) cmd.push("-w");
  if (extensions) {
    for (const ext of extensions) cmd.push("-g", `*${ext}`);
  }
  // 添加 ignore 目录
  for (const ig of ignore) cmd.push("--glob", `!${ig}`);
  // -e 显式传模式：防止以 "-" 开头的 pattern 被解析为 rg flag（参数注入）
  cmd.push("-e", pattern);
  // 搜索范围：scope（文件/子目录）以 root 为基准传入；否则整个 root（"."）
  cmd.push(scope ? path.relative(root, scope) : ".");

  let proc;
  try {
    proc = spawnSync("rg", cmd, {
      cwd: root, // 关键：在 root 内搜索，glob 与输出路径都以 root 为基准
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

  // ripgrep 非 0 退出通常表示正则无效或严重错误
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
  let context_buf = [];
  let in_context_before = true;

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
      current_file = (data.path && data.path.text) || "";
      files_searched.add(current_file);
      context_buf = [];
      in_context_before = true;

    } else if (msg_type === "match") {
      const path_text = (data.path && data.path.text) || "";
      const line_num = data.line_number ?? 0;
      const line_content = rstrip_nl((data.lines && data.lines.text) || "");
      const subs = data.submatches ?? [];
      const col = subs.length ? subs[0].start : 0;

      const rel_path = _rel_path(path_text, root);

      const m = make_match(rel_path, line_num, col, line_content);
      m.context_before = context_buf.slice();
      matches.push(m);
      context_buf = [];
      in_context_before = false;

    } else if (msg_type === "context") {
      const ctx_line = rstrip_nl((data.lines && data.lines.text) || "");
      if (in_context_before) {
        context_buf.push(ctx_line);
        if (context_buf.length > context_lines) context_buf.shift();
      } else {
        if (matches.length && matches[matches.length - 1].context_after.length < context_lines) {
          matches[matches.length - 1].context_after.push(ctx_line);
        }
      }

    } else if (msg_type === "end") {
      in_context_before = true;
      context_buf = [];
    }
  }

  // 截断
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
  // cwd=root 模式下 rg 返回相对路径，去掉可能存在的 "./" 前缀。
  // 对齐 Python：Path(p).relative_to(root) 对相对路径 p 必然失败 → 返回 p 本身；
  // 绝对路径才真正做 relative 换算。
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
  /**
   * 把 path 解析为"搜索范围"，使 path 能限定到单文件或子目录。
   *   文件 → 只搜该文件；root 内目录 → 只搜该子树；其它 → null（整个 root）
   * 安全：仅接受 root 内的目录，避免 path="." 位于项目之上时把整盘当范围。
   */
  let p;
  try {
    p = path.resolve(path_arg);
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
  const root_r = path.resolve(root);
  if (st.isDirectory() && p !== root_r && is_relative_to(p, root_r)) return p;
  return null;
}


// ── 纯 JS 正则回退 ─────────────────────────────────

export function _search_with_regex(
  pattern, root, scope, extensions, ignore,
  context_lines, case_insensitive, max_results, whole_word,
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
    const body = whole_word ? `\\b${escape_regex(pattern)}\\b` : pattern;
    pat = new RegExp(body, flags);
  } catch (e) {
    return fail_response(`Invalid regex: ${e.message}`);
  }

  // 搜索范围：scope 为文件 → 只搜该文件；为目录 → 只搜该子树；否则整个 root
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
        const match = make_match(fpath, idx + 1, m.index, line);
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


// ── 公开 API：文本搜索 ─────────────────────────────

export function search_text(
  pattern,
  path_arg = ".",
  extensions = null,
  context_lines = 2,
  case_insensitive = false,
  max_results = 50,
  whole_word = false,
  extra_ignore = null,
) {
  const root = find_project_root(path_arg);
  const scope = _resolve_scope(path_arg, root);
  const ignore = [...DEFAULT_IGNORE, ...(extra_ignore ?? []), ...load_extra_ignore(root)];

  // 空 pattern 会让 rg 匹配每一行，属于误用，直接拒绝
  if (!pattern || !String(pattern).trim()) {
    return fail_response("Empty search pattern");
  }

  if (String(pattern).length > MAX_PATTERN_LEN) {
    return fail_response(
      `Search pattern too long (${String(pattern).length} chars > ${MAX_PATTERN_LEN})`,
    );
  }

  // 参数归一化，防止负数 / 非法值 / DoS
  context_lines = safe_int(context_lines, 2, 0, MAX_CONTEXT_LINES);
  max_results = safe_int(max_results, 50, 1, MAX_RESULTS_CAP);

  if (has_ripgrep()) {
    return _search_with_rg(
      String(pattern), root, scope, extensions, ignore,
      context_lines, case_insensitive, max_results, whole_word,
    );
  }
  return _search_with_regex(
    String(pattern), root, scope, extensions, ignore,
    context_lines, case_insensitive, max_results, whole_word,
  );
}


// ── 公开 API：符号搜索 ─────────────────────────────

export function search_symbols(
  name,
  path_arg = ".",
  kind = null,
  max_results = 50,
  extra_ignore = null,
  partial = true,
) {
  /**
   * 搜索代码符号（函数、类、结构体等）。
   * partial=true 时按子串（大小写不敏感）匹配，更适合 AI 模糊查找；
   * partial=false 时仅精确匹配同名符号。
   */
  const needle = partial ? name.toLowerCase() : null;
  const t0 = performance.now();
  const root = find_project_root(path_arg);
  const scope = _resolve_scope(path_arg, root);
  const ignore = [...DEFAULT_IGNORE, ...(extra_ignore ?? []), ...load_extra_ignore(root)];
  max_results = safe_int(max_results, 50, 1, MAX_RESULTS_CAP);

  // 搜索范围：scope 为文件 → 只搜该文件；为目录 → 只搜该子树；否则整个 root
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


// ── 公开 API：查找定义 ─────────────────────────────

export function find_definition(name, path_arg = ".", extra_ignore = null, max_results = 50, substring_fallback = true) {
  /**
   * 查找符号定义，两级匹配（与 Python 版逐字段一致）：
   * 1) exact：只接受符号名与请求完全相等的候选（全部来自定义正则），
   *    杜绝子串命中稀释与使用/导入位置被当定义；
   * 2) substring_fallback：exact 无命中时回退子串匹配，响应 match_mode="substring" 披露。
   * 排序不变：精确名 > class/struct/interface/trait > enum/type > function > method > 行号。
   */
  const priority = {
    class: 0, struct: 0, interface: 0, trait: 0,
    enum: 1, type: 1, function: 2, method: 3,
  };
  let resp = search_symbols(name, path_arg, null, max_results, extra_ignore, false);
  let mode = "exact";
  if (resp.matches.length === 0 && substring_fallback) {
    resp = search_symbols(name, path_arg, null, max_results, extra_ignore, true);
    mode = "substring";
  }
  const key = (m) => [
    m.symbol.name === name ? 0 : 1,
    Object.prototype.hasOwnProperty.call(priority, m.symbol.kind) ? priority[m.symbol.kind] : 99,
    m.symbol.line,
  ];
  resp.matches.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < 3; i++) {
      if (ka[i] !== kb[i]) return ka[i] - kb[i];
    }
    return 0;
  });
  resp.match_mode = mode;
  return resp;
}


// ── 公开 API：查找引用 ─────────────────────────────

export function find_references(name, path_arg = ".", max_results = 100, extra_ignore = null) {
  /** 查找符号的所有引用（使用文本搜索）。 */
  return search_text(
    name,
    path_arg,
    null,
    2,
    false,
    safe_int(max_results, 100, 1, MAX_RESULTS_CAP),
    true,
    extra_ignore,
  );
}


// ── 公开 API：项目树 ───────────────────────────────

export function project_tree(path_arg = ".", depth = 3, extra_ignore = null) {
  const root = find_project_root(path_arg);
  const scope = _resolve_scope(path_arg, root);
  const ignore = [...DEFAULT_IGNORE, ...(extra_ignore ?? []), ...load_extra_ignore(root)];
  depth = safe_int(depth, 3, 0, MAX_TREE_DEPTH);

  // 传入子目录时以它为显示起点；传文件则取其父目录（ignore 相对路径仍以项目根为基准）
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

  // 排序 key 对齐 Python: (not is_dir, name.lower())
  const items = [];
  for (const d of dirents) {
    const full = path.join(current, d.name);
    let is_dir = d.isDirectory();
    if (!is_dir && d.isSymbolicLink()) {
      try {
        is_dir = fs.statSync(full).isDirectory();
      } catch {
        continue; // 断链符号链接跳过（对齐 Python stat 失败跳过）
      }
    }
    items.push([!is_dir, d.name.toLowerCase(), d, full, is_dir]);
  }
  items.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] ? 1 : -1; // 目录在前
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
        // stat 失败不带 size（对齐 Python）
      }
      entries.push(entry);
    }
  }

  return entries;
}
