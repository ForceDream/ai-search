#!/usr/bin/env node
/**
 * CLI 入口 —— 7 个命令覆盖 AI 90% 的代码导航需求。对齐 Python 版 cli.py。
 *
 * 默认输出策略：
 *   - 显式 --text / --json 优先
 *   - 否则：管道（非 TTY，AI 读取）→ JSON；交互终端 → 人类可读彩色文本
 */

import { VERSION, is_output_tty } from "../src/config.mjs";
import {
  search_text,
  search_symbols,
  find_definition,
  find_references,
  project_tree,
  search_response_to_dict,
  symbol_response_to_dict,
} from "../src/engine.mjs";
import { read_file, get_context, read_result_to_dict, context_result_to_dict } from "../src/reader.mjs";
import { run_rpc } from "../src/rpc.mjs";
import { py_int } from "../src/util.mjs";

// ── 极简参数解析（对齐 argparse 常用行为）──────────

class UsageError extends Error {}

function build_flag_map(spec) {
  const map = new Map();
  for (const def of spec) {
    if (def.short) map.set(def.short, def);
    map.set(def.name, def);
  }
  return map;
}

function parse_int_arg(flag, value) {
  const n = py_int(value);
  if (n === null) {
    throw new UsageError(`argument ${flag}: invalid int value: '${value}'`);
  }
  return n;
}

function parse_args(argv, positional_names, flag_specs) {
  /** 返回 { values: {...defaults}, positional: [...] } */
  const values = {};
  const positional = [];
  const flag_map = build_flag_map(flag_specs);

  for (const def of flag_specs) {
    if (def.default !== undefined) values[def.key] = def.default;
  }

  let i = 0;
  let only_positional = false;
  while (i < argv.length) {
    const a = argv[i];
    if (!only_positional && a === "--") {
      only_positional = true;
      i += 1;
      continue;
    }
    if (!only_positional && a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq >= 0 ? a.slice(0, eq) : a;
      const def = flag_map.get(name);
      if (!def) throw new UsageError(`unrecognized arguments: ${a}`);
      let value;
      if (def.action === "store_true") {
        if (eq >= 0) throw new UsageError(`argument ${name}: ignored explicit argument`);
        value = true;
      } else {
        if (eq >= 0) value = a.slice(eq + 1);
        else {
          i += 1;
          if (i >= argv.length) throw new UsageError(`argument ${name}: expected one argument`);
          value = argv[i];
        }
        if (def.type === "int") value = parse_int_arg(name, value);
      }
      values[def.key] = value;
      i += 1;
      continue;
    }
    if (!only_positional && a.startsWith("-") && a.length > 1) {
      const eq = a.indexOf("=");
      const name = eq >= 0 ? a.slice(0, eq) : a;
      const def = flag_map.get(name);
      if (!def) throw new UsageError(`unrecognized arguments: ${a}`);
      let value;
      if (def.action === "store_true") {
        if (eq >= 0) throw new UsageError(`argument ${name}: ignored explicit argument`);
        value = true;
      } else {
        if (eq >= 0) value = a.slice(eq + 1);
        else {
          i += 1;
          if (i >= argv.length) throw new UsageError(`argument ${name}: expected one argument`);
          value = argv[i];
        }
        if (def.type === "int") value = parse_int_arg(name, value);
      }
      values[def.key] = value;
      i += 1;
      continue;
    }
    positional.push(a);
    i += 1;
  }

  if (positional.length > positional_names.length) {
    throw new UsageError(
      `unrecognized arguments: ${positional.slice(positional_names.length).join(" ")}`
    );
  }
  for (let k = 0; k < positional_names.length; k++) {
    values[positional_names[k]] = positional[k];
  }
  return values;
}

function usage_text() {
  return `usage: aisearch [-h] [--version] {grep,sym,def,ref,cat,ctx,tree,rpc} ...

AI-optimized code search and navigation tool

positional arguments:
  {grep,sym,def,ref,cat,ctx,tree,rpc}
    grep      文本搜索 (grep 替代)
    sym       符号搜索 (函数/类/结构体)
    def       查找符号定义
    ref       查找符号引用
    cat       智能读取文件
    ctx       获取某行的丰富上下文
    tree      项目目录树
    rpc       stdio JSON 模式：不监听端口，AI 以子进程拉起，stdin/stdout 通信

options:
  -h, --help  show this help message and exit
  --version   show program's version number and exit`;
}

const HELP = usage_text();

const JSON_FLAG = [
  { name: "--json", key: "json", action: "store_true" },
  { name: "--text", key: "text", action: "store_true" },
];

const COMMON_END_FLAGS = [
  { name: "--json", key: "json", action: "store_true" },
  { name: "--text", key: "text", action: "store_true" },
];

// ── 主入口 ──────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("--version")) {
    console.log(`aisearch ${VERSION}`);
    process.exit(0);
  }
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    console.log(HELP);
    if (argv.length === 0) process.exit(1);
    process.exit(0);
  }

  const command = argv[0];
  const rest = argv.slice(1);

  const COMMANDS = new Set(["grep", "sym", "def", "ref", "cat", "ctx", "tree", "rpc"]);
  if (!COMMANDS.has(command)) {
    process.stderr.write(`usage: aisearch [-h] [--version] {grep,sym,def,ref,cat,ctx,tree,rpc} ...\naisearch: error: argument command: invalid choice: '${command}' (choose from 'grep', 'sym', 'def', 'ref', 'cat', 'ctx', 'tree', 'rpc')\n`);
    process.exit(2);
  }

  try {
    if (command === "grep") return cmd_grep(rest);
    if (command === "sym") return cmd_sym(rest);
    if (command === "def") return cmd_def(rest);
    if (command === "ref") return cmd_ref(rest);
    if (command === "cat") return cmd_cat(rest);
    if (command === "ctx") return cmd_ctx(rest);
    if (command === "tree") return cmd_tree(rest);
    if (command === "rpc") return cmd_rpc(rest);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${HELP.split("\n")[0]}\naisearch: error: ${e.message}\n`);
      process.exit(2);
    }
    // 未预期异常：转为结构化输出（对齐 Python 版 CLI 全局兜底），
    // 绝不让 stack trace 污染 AI 读取的 stdout
    const use_json = !rest.includes("--text") &&
      (rest.includes("--json") || !process.stdout.isTTY);
    if (use_json) {
      process.stdout.write(JSON.stringify({ ok: false, error: `${e.name}: ${e.message}` }) + "\n");
    } else {
      process.stderr.write(`aisearch: error: ${e.name}: ${e.message}\n`);
    }
    process.exit(1);
  }
}

function choose_output(args) {
  /** 返回 true 表示 JSON 输出。 */
  if (args.text) return false;
  if (args.json) return true;
  // 默认：管道（非 TTY，通常是 AI 调用）→ JSON；交互终端 → 文本
  return !is_output_tty();
}

function require_arg(args, key, cmd) {
  if (args[key] === undefined) {
    throw new UsageError(`the following arguments are required: ${key} (see: aisearch ${cmd} -h)`);
  }
}

// ── 命令实现 ────────────────────────────────────────

function cmd_grep(rest) {
  const args = parse_args(
    rest,
    ["pattern", "path"],
    [
      { name: "--type", short: "-t", key: "type" },
      { name: "--context", short: "-C", key: "context", type: "int", default: 2 },
      { name: "--ignore-case", short: "-i", key: "ignore_case", action: "store_true" },
      { name: "--whole-word", short: "-w", key: "whole_word", action: "store_true" },
      { name: "--limit", short: "-n", key: "limit", type: "int", default: 50 },
      ...COMMON_END_FLAGS,
    ],
  );
  require_arg(args, "pattern", "grep");
  const use_json = choose_output(args);

  let exts = null;
  if (args.type) {
    exts = new Set(
      args.type.split(",").map((t) => (t.startsWith(".") ? t.toLowerCase() : `.${t.toLowerCase()}`))
    );
  }

  const resp = search_text(
    args.pattern,
    args.path ?? ".",
    exts,
    args.context ?? 2,
    Boolean(args.ignore_case),
    args.limit ?? 50,
    Boolean(args.whole_word),
  );

  if (use_json) print_json(search_response_to_dict(resp));
  else print_grep_text(search_response_to_dict(resp));
}

function cmd_sym(rest) {
  const args = parse_args(
    rest,
    ["name", "path"],
    [
      { name: "--kind", short: "-k", key: "kind" },
      { name: "--exact", short: "-x", key: "exact", action: "store_true" },
      { name: "--limit", short: "-n", key: "limit", type: "int", default: 50 },
      ...COMMON_END_FLAGS,
    ],
  );
  require_arg(args, "name", "sym");
  const use_json = choose_output(args);

  const resp = search_symbols(
    args.name,
    args.path ?? ".",
    args.kind ?? null,
    args.limit ?? 50,
    null,
    !args.exact,
  );

  if (use_json) print_json(symbol_response_to_dict(resp));
  else print_sym_text(symbol_response_to_dict(resp));
}

function cmd_def(rest) {
  const args = parse_args(rest, ["name", "path"], JSON_FLAG);
  require_arg(args, "name", "def");
  const use_json = choose_output(args);

  const resp = find_definition(args.name, args.path ?? ".");
  if (use_json) print_json(symbol_response_to_dict(resp));
  else print_sym_text(symbol_response_to_dict(resp));
}

function cmd_ref(rest) {
  const args = parse_args(
    rest,
    ["name", "path"],
    [
      { name: "--limit", short: "-n", key: "limit", type: "int", default: 100 },
      ...COMMON_END_FLAGS,
    ],
  );
  require_arg(args, "name", "ref");
  const use_json = choose_output(args);

  const resp = find_references(args.name, args.path ?? ".", args.limit ?? 100);
  if (use_json) print_json(search_response_to_dict(resp));
  else print_grep_text(search_response_to_dict(resp));
}

function cmd_cat(rest) {
  const args = parse_args(rest, ["file", "path"], [
    { name: "--outline", key: "outline", action: "store_true" },
    ...JSON_FLAG,
  ]);
  require_arg(args, "file", "cat");
  const use_json = choose_output(args);

  // 本地 CLI 显式读取时允许系统路径（CLI 与用户同级信任）
  const result = read_file(args.file, args.path ?? ".", Boolean(args.outline), "system", !use_json);
  if (use_json) print_json(read_result_to_dict(result));
  else print_cat_text(read_result_to_dict(result));
}

function cmd_ctx(rest) {
  const args = parse_args(rest, ["location", "path"], [
    { name: "--radius", short: "-r", key: "radius", type: "int", default: 5 },
    ...JSON_FLAG,
  ]);
  require_arg(args, "location", "ctx");
  const use_json = choose_output(args);

  const loc = args.location;
  if (!loc.includes(":")) {
    print_json({ ok: false, error: "Location format: file.py:line" });
    process.exit(1);
  }

  const i = loc.lastIndexOf(":");
  const file_ref = loc.slice(0, i);
  const line_str = loc.slice(i + 1);
  const line = py_int(line_str);
  if (line === null) {
    print_json({ ok: false, error: `Invalid line number: ${line_str}` });
    process.exit(1);
  }

  // 本地 CLI 显式读取时允许系统路径
  const result = get_context(file_ref, line, args.path ?? ".", args.radius ?? 5, "system", !use_json);
  if (use_json) print_json(context_result_to_dict(result));
  else print_ctx_text(context_result_to_dict(result));
}

function cmd_tree(rest) {
  const args = parse_args(rest, ["path"], [
    { name: "--depth", short: "-d", key: "depth", type: "int", default: 3 },
    ...JSON_FLAG,
  ]);
  const use_json = choose_output(args);

  const result = project_tree(args.path ?? ".", args.depth ?? 3);
  if (use_json) print_json({ ok: true, data: result });
  else print_tree_text(result);
}

function cmd_rpc(rest) {
  const args = parse_args(rest, [], [
    { name: "--root", key: "root", default: null },
  ]);
  run_rpc(args.root ?? null);
}


// ── 输出函数 ────────────────────────────────────────

function print_json(data) {
  console.log(JSON.stringify(data, null, 2));
}

function print_grep_text(resp) {
  /** 以类似 ripgrep 的格式输出文本。 */
  if (!resp.ok) {
    process.stderr.write(`Error: ${resp.error}\n`);
    return;
  }

  const matches = resp.data.matches;
  const stats = resp.data;

  for (const m of matches) {
    const f = m.file;
    const ln = m.line;
    const text = m.text;
    const sym = m.symbol;

    let header = `\x1b[35m${f}\x1b[0m:\x1b[32m${ln}\x1b[0m`;
    if (sym) {
      header += ` \x1b[36m[${sym.kind ?? ""} ${sym.name ?? ""}]\x1b[0m`;
    }
    console.log(header);

    for (const cb of m.context_before ?? []) {
      console.log(`  \x1b[90m│\x1b[0m ${cb}`);
    }

    console.log(`  \x1b[90m│\x1b[0m \x1b[1;33m${text}\x1b[0m`);

    for (const ca of m.context_after ?? []) {
      console.log(`  \x1b[90m│\x1b[0m ${ca}`);
    }

    console.log("");
  }

  console.log(`\x1b[90m── ${stats.total} matches in ${stats.files_searched} files (${stats.elapsed_ms}ms)\x1b[0m`);
}

function print_sym_text(resp) {
  if (!resp.ok) {
    process.stderr.write(`Error: ${resp.error}\n`);
    return;
  }

  const matches = resp.data.matches;
  for (const m of matches) {
    const kind = m.kind ?? "?";
    const name = m.name ?? "?";
    const f = m.file ?? "?";
    const ln = m.line ?? 0;
    const parent = m.parent ?? "";
    const text = (m.text ?? "").trim();

    const scope = parent ? `\x1b[36m${parent}.\x1b[0m` : "";
    const kind_color = {
      class: "\x1b[33m", struct: "\x1b[33m",
      interface: "\x1b[35m", trait: "\x1b[35m",
      function: "\x1b[32m", method: "\x1b[32m",
      type: "\x1b[34m", enum: "\x1b[34m",
    }[kind] ?? "\x1b[0m";

    console.log(`\x1b[35m${f}\x1b[0m:\x1b[32m${ln}\x1b[0m  ${kind_color}${kind}\x1b[0m ${scope}\x1b[1m${name}\x1b[0m  \x1b[90m${text}\x1b[0m`);
  }

  const stats = resp.data;
  console.log(`\x1b[90m── ${stats.total} results (${stats.elapsed_ms}ms)\x1b[0m`);
}

function print_cat_text(result) {
  if (!result.ok) {
    process.stderr.write(`Error: ${result.error}\n`);
    return;
  }

  const d = result.data;
  const f = d.file;
  const lang = d.language ?? "";
  const lines_range = d.lines;
  const total = d.total_lines;

  const lang_tag = lang ? ` \x1b[90m(${lang})\x1b[0m` : "";
  console.log(`\x1b[1;35m── ${f}\x1b[0m${lang_tag}  \x1b[90mlines ${lines_range.start}-${lines_range.end}/${total}\x1b[0m`);

  const symbols = d.symbols ?? [];
  if (symbols.length) {
    console.log(`\x1b[90m┌─ symbols:\x1b[0m`);
    for (const s of symbols) {
      const kind = s.kind ?? "?";
      const name = s.name ?? "?";
      const ln = s.line ?? 0;
      const end = s.line_end ?? 0;
      const parent = s.parent ?? "";
      const prefix = parent ? `  ${parent}.` : "  ";
      const rng = end ? ` (${ln}-${end})` : "";
      console.log(`\x1b[90m│\x1b[0m${prefix}\x1b[36m${kind}\x1b[0m \x1b[1m${name}\x1b[0m\x1b[90m${rng}\x1b[0m`);
    }
    console.log(`\x1b[90m└─\x1b[0m`);
  }

  const content = d.content ?? "";
  if (content) {
    const start = lines_range.start;
    console.log("");
    const content_lines = content.split("\n");
    for (let i = 0; i < content_lines.length; i++) {
      const lineno = start + i;
      console.log(`\x1b[90m${String(lineno).padStart(5)} │\x1b[0m ${content_lines[i]}`);
    }
    console.log("");
  }
}

function print_ctx_text(result) {
  if (!result.ok) {
    process.stderr.write(`Error: ${result.error}\n`);
    return;
  }

  const d = result.data;
  const f = d.file;
  const line = d.line;
  const lang = d.language ?? "";

  console.log(`\x1b[1;35m── ${f}\x1b[0m:\x1b[32m${line}\x1b[0m  \x1b[90m(${lang})\x1b[0m`);

  const sym = d.containing_symbol;
  if (sym) {
    console.log(`\x1b[90m  in:\x1b[0m \x1b[36m${sym.kind}\x1b[0m \x1b[1m${sym.name}\x1b[0m \x1b[90m(lines ${sym.line}-${sym.line_end ?? "?"})\x1b[0m`);
  }

  const imports = d.imports ?? [];
  if (imports.length) {
    console.log(`\x1b[90m  imports (${imports.length}):\x1b[0m`, imports.slice(0, 10).join(", "));
  }

  const content = d.content ?? "";
  if (content) {
    const content_lines = content.split("\n");
    // 内容窗口起点：优先用数据里给的真实起点（窗口被文件头/尾截断时估算必错位）
    const start_line = d.window_start || Math.max(1, line - Math.floor(content_lines.length / 2));
    console.log("");
    for (let i = 0; i < content_lines.length; i++) {
      const estimated_line = start_line + i;
      const marker = estimated_line === line ? " \x1b[1;31m<<\x1b[0m" : "";
      console.log(`\x1b[90m${String(estimated_line).padStart(5)} │\x1b[0m ${content_lines[i]}${marker}`);
    }
    console.log("");
  }

  const outline = d.file_outline ?? [];
  if (outline.length) {
    console.log(`\x1b[90m  file symbols (${outline.length}):\x1b[0m`);
    for (const s of outline.slice(0, 30)) {
      const parent = s.parent ? `${s.parent}.` : "";
      console.log(`    \x1b[36m${s.kind}\x1b[0m ${parent}\x1b[1m${s.name}\x1b[0m \x1b[90m:${s.line}\x1b[0m`);
    }
    if (outline.length > 30) {
      console.log(`    \x1b[90m... and ${outline.length - 30} more\x1b[0m`);
    }
  }
}

function print_tree_text(tree_data) {
  /** 以 tree 命令的格式输出目录树。 */
  const root = tree_data.root ?? ".";
  const entries = tree_data.tree ?? [];
  console.log(`\x1b[1;35m${root}\x1b[0m`);
  print_tree_entries(entries, "");
}

function print_tree_entries(entries, prefix) {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const is_last = i === entries.length - 1;
    const connector = is_last ? "└── " : "├── ";

    if (entry.type === "dir") {
      console.log(`${prefix}${connector}\x1b[1;34m${entry.name}/\x1b[0m`);
      const child_prefix = prefix + (is_last ? "    " : "│   ");
      print_tree_entries(entry.children ?? [], child_prefix);
    } else if (entry.type === "file") {
      const lang = entry.lang ?? "";
      const size = entry.size ?? 0;
      const lang_tag = lang ? ` \x1b[90m(${lang})\x1b[0m` : "";
      const size_tag = size ? ` \x1b[90m[${format_size(size)}]\x1b[0m` : "";
      console.log(`${prefix}${connector}${entry.name}${lang_tag}${size_tag}`);
    } else if (entry.type === "truncated") {
      console.log(`${prefix}${connector}\x1b[90m...\x1b[0m`);
    }
  }
}

function format_size(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / (1024 * 1024)).toFixed(1)}M`;
}

main();
