



import fs from "node:fs";
import path from "node:path";

import { PyValueError, abs_path } from "./util.mjs";

export const VERSION = "0.1.0";


export const DEFAULT_IGNORE = [
  ".git", ".svn", ".hg",
  "node_modules", "__pycache__", ".pytest_cache",
  ".mypy_cache", ".tox", ".eggs", ".ruff_cache",
  "dist", "build", "target", "out", ".repoctx",
  ".venv", "venv", "env", ".env",
  ".idea", ".vscode", ".vs",
  ".DS_Store", "Thumbs.db",
  "vendor", "Pods", ".next", ".nuxt",
];


export const EXT_LANG = {
  ".py": "python", ".pyi": "python",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
  ".ts": "typescript", ".tsx": "typescript",
  ".java": "java", ".kt": "kotlin", ".kts": "kotlin",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c", ".h": "c",
  ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".hpp": "cpp", ".hh": "cpp",
  ".cs": "csharp",
  ".swift": "swift",
  ".scala": "scala", ".sc": "scala",
  ".sh": "shell", ".bash": "shell", ".zsh": "shell",
  ".lua": "lua",
  ".r": "r", ".R": "r",
  ".ex": "elixir", ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".dart": "dart",
  ".zig": "zig",
  ".nim": "nim",
  ".vue": "vue",
  ".svelte": "svelte",
  ".html": "html", ".htm": "html",
  ".css": "css", ".scss": "scss", ".less": "less",
  ".json": "json",
  ".yaml": "yaml", ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".md": "markdown", ".mdx": "markdown",
  ".sql": "sql",
  ".proto": "protobuf",
  ".graphql": "graphql", ".gql": "graphql",
  ".tf": "terraform",
  ".dockerfile": "dockerfile",
};



export function detect_lang(p) {
  const s = String(p);
  const name = path.basename(s).toLowerCase();
  if (["dockerfile", "makefile", "rakefile", "gemfile"].includes(name)) {
    return name;
  }
  if (name.endsWith(".dockerfile")) {
    return "dockerfile";
  }
  return EXT_LANG[path.extname(s).toLowerCase()] ?? null;
}


export function should_ignore(name, ignore_list, rel_path = "") {


  const rel_norm = rel_path ? rel_path.replace(/\\/g, "/") : "";
  for (const pat of ignore_list) {
    const pat_norm = pat.replace(/\\/g, "/");
    if (pat.startsWith("*.")) {
      if (name.endsWith(pat.slice(1)) || name === pat.slice(2)) return true;
    } else if (pat_norm.includes("/")) {
      if (rel_norm && (rel_norm === pat_norm || rel_norm.startsWith(pat_norm + "/"))) return true;
    } else if (pat === name) {
      return true;
    }
  }
  return false;
}


const ROOT_MARKERS = [
  ".git", "pyproject.toml", "setup.py", "setup.cfg",
  "package.json", "Cargo.toml", "go.mod", "pom.xml",
  "build.gradle", "build.gradle.kts", "Makefile",
  ".aisearch.json",
];

export function find_project_root(start = ".") {
  let cur = abs_path(start);
  for (;;) {
    for (const m of ROOT_MARKERS) {
      try {
        if (fs.existsSync(path.join(cur, m))) return cur;
      } catch {

      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return abs_path(start);
    cur = parent;
  }
}


export function load_extra_ignore(root) {
  const ignore_file = path.join(root, ".aisearchignore");
  if (!fs.existsSync(ignore_file)) return [];
  let text;
  try {
    text = fs.readFileSync(ignore_file, "utf8");
  } catch {
    return [];
  }
  const patterns = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (line && !line.startsWith("#")) {
      patterns.push(line.replace(/\/+$/, ""));
    }
  }
  return patterns;
}


export function is_output_tty() {
  return Boolean(process.stdout.isTTY);
}


export function is_relative_to(p, other) {
  let rel;
  try {
    rel = path.relative(other, p);
  } catch {
    return false;
  }
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}


export function safe_resolve(ref, root, boundary = "root") {
  





  const ref_str = String(ref);
  if (ref_str.includes("\x00")) {
    throw new PyValueError("Path contains NUL byte");
  }
  const full = path.isAbsolute(ref_str)
    ? abs_path(ref_str)
    : abs_path(root, ref_str);

  if (boundary === "root") {
    const root_resolved = abs_path(root);
    if (!is_relative_to(full, root_resolved)) {
      throw new PyValueError(`Path '${ref_str}' escapes project root`);
    }
  }
  return full;
}


export function detect_encoding(buf) {

  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return "utf-8";
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return "utf-16le";
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return "utf-16be";
  const u8 = new TextDecoder("utf-8", { fatal: true });
  try {
    u8.decode(buf);
    return "utf-8";
  } catch {

  }
  const gbk = new TextDecoder("gb18030", { fatal: true });
  try {
    gbk.decode(buf);
    return "gb18030";
  } catch {

  }
  return "utf-8";
}

export function decode_buffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    const t = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return new TextDecoder("utf-16le", { fatal: false }).decode(buf);
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return new TextDecoder("utf-16be", { fatal: false }).decode(buf);
  }
  const u8 = new TextDecoder("utf-8", { fatal: true });
  try {
    return u8.decode(buf);
  } catch {

  }
  const gbk = new TextDecoder("gb18030", { fatal: true });
  try {
    return gbk.decode(buf);
  } catch {

  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

export function detect_encoding_path(p, chunk = 65536) {
  let fd;
  try {
    fd = fs.openSync(p, "r");
  } catch {
    return "utf-8";
  }
  try {
    const buf = Buffer.alloc(chunk);
    const n = fs.readSync(fd, buf, 0, chunk, 0);
    return detect_encoding(buf.subarray(0, n));
  } catch {
    return "utf-8";
  } finally {
    try {
      fs.closeSync(fd);
    } catch {

    }
  }
}


export function build_file_list(root, extensions = null, ignore = null) {
  

  if (!ignore) ignore = DEFAULT_IGNORE;
  const root_abs = abs_path(root);
  const files = [];

  const walk_dir = (dir, dir_rel) => {
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirnames = [];
    const filenames = [];
    for (const d of dirents) {




      if (d.isDirectory()) dirnames.push(d.name);
      else filenames.push(d.name);
    }



    const kept_dirs = dirnames
      .filter((dn) => {
        const drel = dir_rel ? `${dir_rel}/${dn}` : dn;
        return !should_ignore(dn, ignore, drel);
      })
      .sort();
    const sorted_files = filenames.slice().sort();

    for (const fn of sorted_files) {
      const fp = path.join(dir, fn);
      let rel;
      try {
        rel = path.relative(root_abs, fp);
      } catch {
        rel = fp;
      }
      if (should_ignore(fn, ignore, rel)) continue;
      if (extensions && !extensions.has(path.extname(fp).toLowerCase())) continue;
      files.push(rel);
    }

    for (const dn of kept_dirs) {
      walk_dir(path.join(dir, dn), dir_rel ? `${dir_rel}/${dn}` : dn);
    }
  };

  walk_dir(root_abs, "");
  return files;
}
