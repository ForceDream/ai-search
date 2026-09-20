#!/usr/bin/env node
// parity 冒烟测试：py 版与 js 版逐命令 JSON 深比较（剥离 elapsed_ms）
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 路径全部相对本脚本解析，并可用环境变量覆盖 → 不绑定任何机器/本地目录。
const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../aisearch-js/tests
const JS_ROOT = path.resolve(HERE, "..");                  // .../aisearch-js
const JS_CLI = path.join(JS_ROOT, "bin", "aisearch.mjs");
const PY_ROOT = process.env.AISEARCH_PY_ROOT || path.resolve(JS_ROOT, ".."); // 同级 Python 仓库根
const PY_BIN = process.env.AISEARCH_PY_BIN || (process.platform === "win32" ? "python" : "python3");
const TARGET = process.argv[2] || PY_ROOT;                 // 被搜索的项目

function run_py(args) {
  const r = spawnSync(PY_BIN, ["-c",
    `import sys; sys.path.insert(0, r'${PY_ROOT}'); from aisearch.cli import main; main()`,
    ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PYTHONPATH: PY_ROOT } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function run_js(args) {
  const r = spawnSync("node", [JS_CLI, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function strip_elapsed(x) {
  if (Array.isArray(x)) return x.map(strip_elapsed);
  if (x && typeof x === "object") {
    const o = {};
    for (const [k, v] of Object.entries(x)) {
      if (k === "elapsed_ms") continue;
      o[k] = strip_elapsed(v);
    }
    return o;
  }
  return x;
}

// rg 多线程遍历顺序非确定 → matches 按 (file,line,col,text) 排序后比较；
// files_searched 受遍历顺序影响仅当截断时不同 → 大 limit 下一致
function normalize(x) {
  x = strip_elapsed(x);
  if (x && typeof x === "object" && x.ok && x.data && Array.isArray(x.data.matches)) {
    x.data.matches.sort((a, b) =>
      (a.file + ":" + a.line + ":" + a.col + ":" + a.text).localeCompare(
        b.file + ":" + b.line + ":" + b.col + ":" + b.text));
  }
  if (x && typeof x === "object" && x.ok === false) {
    // 错误消息文本是给人看的（两语言正则引擎措辞不同），只比较结构
    return { ok: false, error: "<message>" };
  }
  return x;
}

function deep_equal(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deep_equal(a[i], b[i])) return false;
    return true;
  }
  if (a && b && typeof a === "object") {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!deep_equal(a[k], b[k])) return false;
    return true;
  }
  return false;
}

// 命令集：成功流 + 错误流（-n 大 limit 避免截断顺序差异）
const CASES = [
  { name: "grep-rg", args: ["grep", "safe_resolve", TARGET, "-n", "5000", "--json"] },
  { name: "grep-norg", args: ["grep", "safe_resolve", TARGET, "-n", "5000", "--json"], no_rg: true },
  { name: "grep-ci", args: ["grep", "SYMBOL", TARGET, "-i", "-n", "5000", "--json"] },
  // 显式 ASCII 字符类：纯 JS 回退的 \w 为 ASCII 语义，而 py/rg 为 Unicode 语义
  // （详见 README「与 Python 版的差异」），此处避免用 \w 混淆协议一致性判定。
  { name: "grep-regex", args: ["grep", "def [A-Za-z0-9_]+_[A-Za-z0-9_]+", TARGET, "-n", "5000", "--json"] },
  { name: "grep-word", args: ["grep", "cat", TARGET, "-w", "-n", "5000", "--json"] },
  { name: "grep-type", args: ["grep", "def", TARGET, "-t", "py", "-n", "5000", "--json"] },
  { name: "grep-empty-result", args: ["grep", "zzz_no_such_token_zzz", TARGET, "--json"] },
  { name: "grep-bad-regex", args: ["grep", "(unclosed", TARGET, "--json"], no_rg: true },
  { name: "sym", args: ["sym", "symbol", TARGET, "-n", "5000", "--json"], no_rg: true },
  { name: "sym-exact", args: ["sym", "extract_symbols", TARGET, "-x", "--json"], no_rg: true },
  { name: "sym-kind", args: ["sym", "search", TARGET, "-k", "function", "-n", "5000", "--json"], no_rg: true },
  { name: "def", args: ["def", "search_text", TARGET, "--json"], no_rg: true },
  { name: "def-class", args: ["def", "Symbol", TARGET, "--json"], no_rg: true },
  { name: "ref", args: ["ref", "extract_symbols", TARGET, "-n", "5000", "--json"] },
  { name: "cat", args: ["cat", "aisearch/config.py", TARGET, "--json"] },
  { name: "cat-sym", args: ["cat", "aisearch/engine.py#search_text", TARGET, "--json"] },
  { name: "cat-sym-multiline", args: ["cat", "aisearch/engine.py#_search_with_rg", TARGET, "--json"] },
  { name: "cat-range", args: ["cat", "aisearch/config.py:10-30", TARGET, "--json"] },
  { name: "cat-outline", args: ["cat", "aisearch/symbols.py", TARGET, "--outline", "--json"] },
  { name: "cat-missing", args: ["cat", "no_such_file.py", TARGET, "--json"] },
  { name: "cat-missing-sym", args: ["cat", "aisearch/config.py#zzz_none", TARGET, "--json"] },
  { name: "ctx", args: ["ctx", "aisearch/engine.py:120", TARGET, "--json"] },
  { name: "ctx-out-of-range", args: ["ctx", "aisearch/config.py:99999", TARGET, "--json"] },
  { name: "tree", args: ["tree", TARGET, "-d", "3", "--json"] },
];

let pass = 0, fail = 0;
for (const c of CASES) {
  const env_save = process.env.AISEARCH_NO_RG;
  if (c.no_rg) process.env.AISEARCH_NO_RG = "1";
  else delete process.env.AISEARCH_NO_RG;
  const p = run_py(c.args);
  const j = run_js(c.args);
  if (c.no_rg) delete process.env.AISEARCH_NO_RG;
  else if (env_save) process.env.AISEARCH_NO_RG = env_save;

  let pj = null, jj = null, perr = null;
  try { pj = JSON.parse(p.out); } catch { perr = `py stdout not JSON (exit ${p.code}): ${p.out.slice(0, 200)} | err: ${p.err.slice(0, 200)}`; }
  try { jj = JSON.parse(j.out); } catch { if (!perr) perr = `js stdout not JSON (exit ${j.code}): ${j.out.slice(0, 200)} | err: ${j.err.slice(0, 200)}`; }

  if (perr) { fail++; console.log(`FAIL ${c.name}: ${perr}`); continue; }

  if (deep_equal(normalize(pj), normalize(jj))) {
    pass++;
    console.log(`PASS ${c.name}`);
  } else {
    fail++;
    console.log(`FAIL ${c.name}`);
    console.log("  py:", JSON.stringify(normalize(pj)).slice(0, 600));
    console.log("  js:", JSON.stringify(normalize(jj)).slice(0, 600));
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
