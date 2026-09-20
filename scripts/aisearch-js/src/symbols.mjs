/**
 * 正则驱动的符号提取 —— 对齐 Python 版 symbols.py。
 * 不需要 LSP，开箱即用。
 */

import { count_char, lstrip, rstrip } from "./util.mjs";
import { detect_lang } from "./config.mjs";

// ── 数据结构 ────────────────────────────────────────

export function make_symbol(kind, name, line, indent = 0) {
  return {
    kind,          // class / function / method / struct / trait / import ...
    name,
    line,          // 1-based
    line_end: 0,   // 1-based, 0 = 未知
    col: 0,
    indent,
    parent: "",    // 所属类/命名空间
  };
}

export function symbol_to_dict(s) {
  const d = { kind: s.kind, name: s.name, line: s.line };
  if (s.line_end) d.line_end = s.line_end;
  if (s.parent) d.parent = s.parent;
  return d;
}


// ── 每种语言的符号正则 ──────────────────────────────
// 每项: [kind, regex, want_group]
// Python re.match 隐式锚定开头 → JS 用带 ^ 的正则 exec。

// 关键字黑名单，避免把 if (x) {}、for (...) {} 等误判为方法
const _JS_KW = "get|set|if|for|while|switch|catch|return|typeof|new|do|else|await|class|function|with|try|finally|throw|delete|yield|using|lock";

const PYTHON_PATTERNS = [
  ["class", /^(\s*)class\s+(\w+)/, 2],
  ["function", /^(\s*)(?:async\s+)?def\s+(\w+)/, 2],
];

const JAVASCRIPT_PATTERNS = [
  ["class", /^(\s*)(?:export\s+(?:default\s+)?)?class\s+(\w+)/, 2],
  ["function", /^(\s*)(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)/, 2],
  ["function", /^(\s*)(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/, 2],
  ["function", /^(\s*)(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>/, 2],
  // 类方法简写：handle_request() { ... }；关键字加 \b 避免误伤 forEach 等
  ["method", new RegExp(
    "^(\\s*)(?:async\\s+)?(?!(?:" + _JS_KW + ")\\b)(\\w+)\\s*\\([^)]*\\)\\s*[\\{:]"
  ), 2],
];

const TYPESCRIPT_EXTRA = [
  ["interface", /^(\s*)(?:export\s+)?interface\s+(\w+)/, 2],
  // type 别名后面必然跟 `=` / 泛型 `<` / 对象字面量 `{`；
  // 不加这个锚定会把多行 `import type {\n  type Tool,}` 块里的列表项当成定义
  ["type", /^(\s*)(?:export\s+)?type\s+(\w+)\s*[=<{]/, 2],
  ["enum", /^(\s*)(?:export\s+)?(?:const\s+)?enum\s+(\w+)/, 2],
];

const GO_PATTERNS = [
  ["function", /^(\s*)func\s+(?:\([^)]+\)\s+)?(\w+)/, 2],
  ["struct", /^(\s*)type\s+(\w+)\s+struct/, 2],
  ["interface", /^(\s*)type\s+(\w+)\s+interface/, 2],
  ["type", /^(\s*)type\s+(\w+)/, 2],
];

const RUST_PATTERNS = [
  ["function", /^(\s*)(?:pub\s+)?(?:async\s+)?(?:const\s+)?fn\s+(\w+)/, 2],
  ["struct", /^(\s*)(?:pub\s+)?struct\s+(\w+)/, 2],
  ["enum", /^(\s*)(?:pub\s+)?enum\s+(\w+)/, 2],
  ["trait", /^(\s*)(?:pub\s+)?trait\s+(\w+)/, 2],
  ["impl", /^(\s*)impl(?:\s*<[^>]*>)?\s+(?:\w+)?(?:\s+for\s+)?(\w+)/, 2],
  ["type", /^(\s*)(?:pub\s+)?type\s+(\w+)/, 2],
  ["macro", /^(\s*)(?:pub\s+)?macro_rules!\s+(\w+)/, 2],
];

const JAVA_PATTERNS = [
  ["class", /^\s*(?:public\s+)?(?:abstract\s+)?(?:final\s+)?class\s+(\w+)/, 1],
  ["interface", /^\s*(?:public\s+)?interface\s+(\w+)/, 1],
  ["enum", /^\s*(?:public\s+)?enum\s+(\w+)/, 1],
  ["method", /^\s*(?:public|private|protected)\s+(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?[\w<>\[\],\s]+\s+(\w+)\s*\(/, 1],
];

const CPP_EXTRA = [
  ["class", /^\s*(?:class|struct)\s+(\w+)/, 1],
  ["function", /^\s*[\w~:*&]+\s+(?:[\w:*&]+\s+)*(\w+)\s*\([^)]*\)\s*(?:const\s*)?(?:override\s*)?\{/, 1],
  ["namespace", /^\s*namespace\s+(\w+)/, 1],
];

const RUBY_PATTERNS = [
  ["class", /^\s*class\s+(\w+)/, 1],
  ["module", /^\s*module\s+(\w+)/, 1],
  ["method", /^\s*def\s+(\w+)/, 1],
];

const PHP_PATTERNS = [
  ["class", /^\s*(?:abstract\s+)?class\s+(\w+)/, 1],
  ["interface", /^\s*interface\s+(\w+)/, 1],
  ["trait", /^\s*trait\s+(\w+)/, 1],
  ["function", /^\s*(?:public|protected|private)\s+(?:static\s+)?function\s+(\w+)/, 1],
];

const C_PATTERNS = [
  ["struct", /^\s*struct\s+(\w+)/, 1],
  ["function", /^\s*[\w\*]+\s+[\w\*]+\s+(\w+)\s*\([^)]*\)\s*\{/, 1],
];

const SHELL_PATTERNS = [
  ["function", /^(?:function\s+)?(\w+)\s*\(\s*\)/, 1],
];

export const LANG_PATTERNS = {
  python: PYTHON_PATTERNS,
  javascript: JAVASCRIPT_PATTERNS,
  typescript: JAVASCRIPT_PATTERNS.concat(TYPESCRIPT_EXTRA),
  go: GO_PATTERNS,
  rust: RUST_PATTERNS,
  java: JAVA_PATTERNS,
  ruby: RUBY_PATTERNS,
  php: PHP_PATTERNS,
  c: C_PATTERNS,
  cpp: CPP_EXTRA,
  csharp: JAVA_PATTERNS,  // C# 与 Java 模式接近
  shell: SHELL_PATTERNS,
  lua: [["function", /^(\s*)(?:local\s+)?function\s+(\w+)/, 2]],
  swift: [
    ["class", /^\s*(?:public\s+)?class\s+(\w+)/, 1],
    ["struct", /^\s*(?:public\s+)?struct\s+(\w+)/, 1],
    ["protocol", /^\s*(?:public\s+)?protocol\s+(\w+)/, 1],
    ["function", /^\s*(?:public\s+)?(?:static\s+)?func\s+(\w+)/, 1],
  ],
  kotlin: JAVA_PATTERNS.concat([
    ["function", /^\s*(?:suspend\s+)?fun\s+(\w+)/, 1],
  ]),
  scala: [
    ["class", /^\s*(?:case\s+)?class\s+(\w+)/, 1],
    ["object", /^\s*object\s+(\w+)/, 1],
    ["trait", /^\s*trait\s+(\w+)/, 1],
    ["function", /^\s*def\s+(\w+)/, 1],
  ],
};

const CLASS_KINDS = new Set([
  "class", "struct", "interface", "trait", "enum", "module", "namespace", "object",
]);

// ── 编译缓存 ────────────────────────────────────────

const _compiled_cache = new Map();

function _get_compiled(lang) {
  if (_compiled_cache.has(lang)) return _compiled_cache.get(lang);
  const patterns = LANG_PATTERNS[lang] ?? [];
  const compiled = patterns.map(([kind, regex, group]) => ({ kind, regex, group }));
  _compiled_cache.set(lang, compiled);
  return compiled;
}


// ── 公开 API ────────────────────────────────────────

// 单文件符号数上限：防御病态文件（如一行一个 def）导致
// extract_symbols O(S) 与 _calc_ranges O(S×N) 的组合爆炸
export const MAX_SYMBOLS_PER_FILE = 5000;

export function extract_symbols(lines, lang, file_path = "") {
  /** 从源代码行列表中提取所有符号。 */
  const compiled = _get_compiled(lang);
  if (!compiled.length) return [];

  const symbols = [];
  let current_class = "";

  for (let idx = 0; idx < lines.length; idx++) {
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) break; // 符号数超限：截断（防 DoS）
    const line = lines[idx];
    const lineno = idx + 1;
    const stripped = rstrip(line);
    if (!stripped) continue;
    const ls = lstrip(stripped);
    // 跳过注释行（按语言粗略判断）
    if (ls.startsWith("#") || ls.startsWith("//") || ls.startsWith("--")) continue;

    const indent = line.length - lstrip(line).length;

    for (const cp of compiled) {
      const m = cp.regex.exec(stripped);
      if (m) {
        const name = cp.group ? m[cp.group] : cp.kind;
        if (!name) continue;

        const sym = make_symbol(cp.kind, name, lineno, indent);

        // 更新 parent 上下文
        if (CLASS_KINDS.has(cp.kind)) {
          current_class = name;
        } else if (indent > 0 && current_class) {
          sym.parent = current_class;
        }

        symbols.push(sym);
        break; // 一行只匹配一个符号
      }
    }
  }

  // 计算每个符号的范围（行结束位置）
  _calc_ranges(symbols, lines, lang);
  return symbols;
}


export function iter_symbol_decls(lineIter, lang) {
  /**
   * 流式扫描符号声明（line_end 置 0，不计算范围），用于大文件避免整文件载入。
   * lineIter 产出 [lineno, line] 二元组。
   */
  const compiled = _get_compiled(lang);
  if (!compiled.length) return [];
  const symbols = [];
  let current_class = "";
  for (const pair of lineIter) {
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) break;
    const lineno = pair[0];
    const line = pair[1];
    const stripped = rstrip(line);
    if (!stripped) continue;
    const ls = lstrip(stripped);
    if (ls.startsWith("#") || ls.startsWith("//") || ls.startsWith("--")) continue;
    const indent = line.length - lstrip(line).length;
    for (const cp of compiled) {
      const m = cp.regex.exec(stripped);
      if (m) {
        const name = cp.group ? m[cp.group] : cp.kind;
        if (!name) continue;
        const sym = make_symbol(cp.kind, name, lineno, indent);
        if (CLASS_KINDS.has(cp.kind)) {
          current_class = name;
        } else if (indent > 0 && current_class) {
          sym.parent = current_class;
        }
        symbols.push(sym);
        break;
      }
    }
  }
  return symbols;
}


export function compute_symbol_end_from_chunk(chunk, lang, sym) {
  /**
   * 在从 sym.line 起头的行块上复用 _calc_ranges 推算结束行，并映射回原文行号。
   */
  const temp = make_symbol(sym.kind, sym.name, 1, sym.indent);
  _calc_ranges([temp], chunk, lang);
  return sym.line - 1 + temp.line_end;
}


export function _calc_ranges(symbols, lines, lang) {
  /** 推算每个符号的结束行：花括号语言按配平计数，缩进语言按缩进扫描。 */
  if (!symbols.length) return;

  const brace_langs = new Set([
    "javascript", "typescript", "java", "go", "rust", "c", "cpp",
    "csharp", "swift", "kotlin", "scala", "php", "ruby",
  ]);
  const n = lines.length;

  for (const sym of symbols) {
    if (brace_langs.has(lang)) {
      // 花括号计数：必须扫到配平或文件尾。
      // 不能用"下一个符号行号"截断扫描窗口——类/命名空间的结束括号
      // 远在其首个嵌套成员之后，截断会把类范围错算成声明行。
      let brace_count = 0;
      let started = false;
      let end = sym.line - 1;
      let closed = false; // 模拟 Python for-else
      for (let j = sym.line - 1; j < n; j++) {
        for (const ch of lines[j]) {
          if (ch === "{") {
            brace_count += 1;
            started = true;
          } else if (ch === "}") {
            brace_count -= 1;
          }
        }
        if (started && brace_count <= 0) {
          end = j + 1;
          closed = true;
          break;
        }
      }
      if (!closed && started) end = n; // 未配平（畸形文件）：保守取到文件尾
      sym.line_end = Math.max(end, sym.line);
    } else {
      // 缩进语言（Python 等）：先跳过多行签名——
      // 签名收尾行 `) -> X:` 的缩进等于 base，会提前终止缩进扫描，
      // 因此从头按括号配平找到 "行尾冒号" 才算签名结束。
      const base_indent = sym.indent;
      const j0 = sym.line - 1;
      let header_end = j0;
      let header_done = false;
      let bal = 0;
      for (let j = j0; j < n; j++) {
        const stripped = rstrip(lines[j]);
        bal += count_char(stripped, "(") - count_char(stripped, ")");
        header_end = j;
        if (bal <= 0 && stripped.endsWith(":")) {
          header_done = true;
          break;
        }
      }
      const body_start = header_done ? header_end + 1 : sym.line;

      let end = sym.line;
      for (let j = body_start; j < n; j++) {
        const l = lines[j];
        if (l.trim() === "") {
          end = j + 1;
          continue;
        }
        const cur_indent = l.length - lstrip(l).length;
        if (cur_indent > base_indent) {
          end = j + 1;
        } else {
          break;
        }
      }
      // 去掉尾部空行，避免 #symbol 读取带出多余空行
      while (end > sym.line && lines[end - 1].trim() === "") end -= 1;
      sym.line_end = Math.max(end, sym.line);
    }
  }
}


export function find_symbol_by_name(lines, lang, name, partial = false) {
  /** 查找特定名称的符号（partial=True 时支持子串匹配）。 */
  const syms = extract_symbols(lines, lang);
  for (const s of syms) {
    if (partial) {
      // Python: name.lower() in s.name.lower()（name 是 needle）
      if (s.name.toLowerCase().includes(name.toLowerCase())) {
        return s;
      }
    } else if (s.name === name) {
      return s;
    }
  }
  return null;
}


export function find_containing_symbol(lines, lang, target_line) {
  /** 查找包含 target_line 的最小范围符号。 */
  const syms = extract_symbols(lines, lang);
  let best = null;
  let best_size = Infinity;

  for (const s of syms) {
    if (s.line <= target_line && target_line <= s.line_end) {
      const size = s.line_end - s.line;
      if (size < best_size) {
        best = s;
        best_size = size;
      }
    }
  }
  return best;
}


export function extract_imports(lines, lang) {
  /** 提取 import 语句。 */
  const imports = [];

  // Go 的标准 import 块是多行的，需要专门处理
  if (lang === "go") {
    let in_block = false;
    for (const line of lines) {
      const s = line.trim();
      if (in_block) {
        if (s.startsWith(")")) {
          in_block = false;
        } else {
          const m = /^(?:(\w+)\s+)?"([^"]+)"/.exec(s);
          if (m) {
            imports.push(m[1] ? m[1] + " " + m[2] : m[2]);
          }
        }
        continue;
      }
      let m = /^import\s+\($/.exec(s);
      if (m) {
        in_block = true;
        continue;
      }
      m = /^import\s+"([^"]+)"/.exec(s);
      if (m) {
        imports.push(m[1]);
      }
    }
    return imports;
  }

  const patterns = {
    python: /^\s*(?:from\s+\S+\s+)?import\s+(.+)/,
    javascript: /^\s*import\s+.*from\s+['"](.+)['"]/,
    typescript: /^\s*import\s+.*from\s+['"](.+)['"]/,
    rust: /^\s*use\s+(.+)/,
    java: /^\s*import\s+([\w.]+)/,
  };
  const pat = patterns[lang];
  if (!pat) return imports;
  for (const line of lines) {
    const m = pat.exec(rstrip(line));
    if (m) {
      const raw = m[1] ? m[1].trim() : line.trim();
      imports.push(raw);
    }
  }
  return imports;
}
