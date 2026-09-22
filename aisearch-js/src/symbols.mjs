




import { count_char, lstrip, rstrip } from "./util.mjs";
import { detect_lang } from "./config.mjs";



export function make_symbol(kind, name, line, indent = 0) {
  return {
    kind,
    name,
    line,
    line_end: 0,
    col: 0,
    indent,
    parent: "",
  };
}

export function symbol_to_dict(s) {
  const d = { kind: s.kind, name: s.name, line: s.line };
  if (s.line_end) d.line_end = s.line_end;
  if (s.parent) d.parent = s.parent;
  return d;
}







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

  ["method", new RegExp(
    "^(\\s*)(?:async\\s+)?(?!(?:" + _JS_KW + ")\\b)(\\w+)\\s*\\([^)]*\\)\\s*[\\{:]"
  ), 2],
];

const TYPESCRIPT_EXTRA = [
  ["interface", /^(\s*)(?:export\s+)?interface\s+(\w+)/, 2],


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


  ["impl", /^(\s*)impl(?:\s*<[^>]*>)?\s+(?:.*?\sfor\s+)?(\w+)\s*(?:<[^>]*>)?\s*(?:\{|where|$)/, 2],
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
  csharp: JAVA_PATTERNS,
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



const _compiled_cache = new Map();

function _get_compiled(lang) {
  if (_compiled_cache.has(lang)) return _compiled_cache.get(lang);
  const patterns = LANG_PATTERNS[lang] ?? [];
  const compiled = patterns.map(([kind, regex, group]) => ({ kind, regex, group }));
  _compiled_cache.set(lang, compiled);
  return compiled;
}






export const MAX_SYMBOLS_PER_FILE = 5000;

export function extract_symbols(lines, lang, file_path = "") {
  
  const compiled = _get_compiled(lang);
  if (!compiled.length) return [];

  const symbols = [];
  let current_class = "";

  for (let idx = 0; idx < lines.length; idx++) {
    if (symbols.length >= MAX_SYMBOLS_PER_FILE) break;
    const line = lines[idx];
    const lineno = idx + 1;
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


  _calc_ranges(symbols, lines, lang);
  return symbols;
}


export function iter_symbol_decls(lineIter, lang) {
  



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
  


  const temp = make_symbol(sym.kind, sym.name, 1, sym.indent);
  _calc_ranges([temp], chunk, lang);
  return sym.line - 1 + temp.line_end;
}


export function _calc_ranges(symbols, lines, lang) {
  
  if (!symbols.length) return;

  const brace_langs = new Set([
    "javascript", "typescript", "java", "go", "rust", "c", "cpp",
    "csharp", "swift", "kotlin", "scala", "php", "ruby",
  ]);
  const n = lines.length;

  if (brace_langs.has(lang)) {



    const delta = new Array(n).fill(0);
    const opens = new Array(n).fill(false);
    for (let j = 0; j < n; j++) {
      let d = 0;
      let has = false;
      for (const ch of lines[j]) {
        if (ch === "{") { d += 1; has = true; }
        else if (ch === "}") d -= 1;
      }
      delta[j] = d;
      opens[j] = has;
    }
    const depth = new Array(n + 1).fill(0);
    for (let j = 0; j < n; j++) depth[j + 1] = depth[j] + delta[j];
    const next_open = new Array(n + 1).fill(n);
    for (let j = n - 1; j >= 0; j--) next_open[j] = opens[j] ? j : next_open[j + 1];

    const activate_at = new Map();
    const activated = new Set();
    symbols.forEach((sym, idx) => {
      const start0 = sym.line - 1;
      const act = next_open[start0];
      if (act < n) {
        if (!activate_at.has(act)) activate_at.set(act, []);


        activate_at.get(act).push([idx, depth[start0]]);
        activated.add(idx);
      }
    });

    const end_of = new Map();
    const active = new Map();
    let max_base = null;
    for (let j = 0; j < n; j++) {
      const starts = activate_at.get(j);
      if (starts) {
        for (const [idx, b] of starts) {
          if (!active.has(b)) active.set(b, []);
          active.get(b).push(idx);
          if (max_base === null || b > max_base) max_base = b;
        }
      }
      const d_after = depth[j + 1];

      while (max_base !== null && max_base >= d_after) {
        for (const idx of active.get(max_base) ?? []) end_of.set(idx, j + 1);
        active.delete(max_base);
        max_base = active.size ? Math.max(...active.keys()) : null;
      }
    }
    symbols.forEach((sym, idx) => {
      let e;
      if (end_of.has(idx)) e = end_of.get(idx);
      else if (activated.has(idx)) e = n;
      else e = sym.line - 1;
      sym.line_end = Math.max(e, sym.line);
    });
  }

  for (const sym of symbols) {
    if (brace_langs.has(lang)) {
      continue;
    } else {



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

      while (end > sym.line && lines[end - 1].trim() === "") end -= 1;
      sym.line_end = Math.max(end, sym.line);
    }
  }
}


export function find_symbol_by_name(lines, lang, name, partial = false) {
  
  const syms = extract_symbols(lines, lang);
  for (const s of syms) {
    if (partial) {

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
  
  const imports = [];


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
