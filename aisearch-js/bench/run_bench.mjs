#!/usr/bin/env node
/**
 * aisearch 基准 runner：grep / rg / py / js 四方对比
 *
 * 出错率 = 对已知真值的准确率：
 *   T1 文本搜索 —— 真值来自独立朴素扫描器（逐行 indexOf，不依赖任何被测实现），
 *      比较各方式返回的 (file,line) 集合：假阳 fp + 假阴 fn，出错率 = (fp+fn)/|truth|
 *   T2 sym / T3 def / T4 cat#symbol / T5 ctx —— 真值来自生成器 manifest（上帝视角），
 *      同时检查 py/js 双实现 parity
 *
 * 效率 = 冷启动中位延迟（每方式预热 1 轮丢弃 + 15 轮计时，输出丢弃仅测完成时间）
 *
 * 输出：bench/results.json + bench/REPORT.md
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

// 路径相对本脚本解析 + 环境变量可覆盖 → 不绑定任何机器/本地目录。
const HERE = path.dirname(fileURLToPath(import.meta.url)); // .../aisearch-js/bench
const JS_ROOT = path.resolve(HERE, "..");                  // .../aisearch-js
const REPO_ROOT = path.resolve(JS_ROOT, "..");             // 含 aisearch/ 与 aisearch-js/
const BENCH = process.env.AISEARCH_BENCH_DIR || path.join(os.tmpdir(), "aisearch-bench");
const CORPUS = path.join(BENCH, "corpus");
const OUT_DIR = HERE;
const PY_BIN = process.env.AISEARCH_PY_BIN || (process.platform === "win32" ? "python" : "python3");

const PY_BOOT = `import sys; sys.path.insert(0, r'${REPO_ROOT}'); from aisearch.cli import main; main()`;
const JS_CLI = path.join(JS_ROOT, "bin", "aisearch.mjs");

const TOKENS = ["process_data", "validate_config", "ZetaMatrixSync", "quantum_flux", "replay_buffer", "edge_case_TOKEN"];
const ROUNDS = 15;

// ── 通用工具 ────────────────────────────────────────

function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

function p95(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    ...opts,
  });
}

function run_py_cli(args, { no_rg = false, capture = true } = {}) {
  const env = { ...process.env };
  if (no_rg) env.AISEARCH_NO_RG = "1";
  else delete env.AISEARCH_NO_RG;
  return run(PY_BIN, ["-c", PY_BOOT, ...args], {
    env,
    ...(capture ? {} : { stdio: ["ignore", "ignore", "ignore"] }),
  });
}

function run_js_cli(args, { no_rg = false, capture = true } = {}) {
  const env = { ...process.env };
  if (no_rg) env.AISEARCH_NO_RG = "1";
  else delete env.AISEARCH_NO_RG;
  return run("node", [JS_CLI, ...args], {
    env,
    ...(capture ? {} : { stdio: ["ignore", "ignore", "ignore"] }),
  });
}

// ── 真值 1：朴素文本扫描（独立于被测实现）──────────

function truth_text_scan(token) {
  const truth = new Set(); // "rel:line"
  const walk = (dir) => {
    let dirents;
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of dirents) {
      if (d.name.startsWith(".")) continue; // 隐藏（.git 等）
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { walk(full); continue; }
      if (!/\.(py|ts|go)$/.test(d.name)) continue;
      const text = fs.readFileSync(full, "utf8");
      const rel = path.relative(CORPUS, full).split(path.sep).join("/");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(token)) truth.add(rel + ":" + (i + 1));
      }
    }
  };
  walk(CORPUS);
  return truth;
}

// ── 各方式 T1 结果采集 ─────────────────────────────

function collect_grep(token) {
  const r = run("grep", ["-rnF", token, CORPUS + "/"]);
  if (r.status !== 0 && r.status !== 1) throw new Error("grep failed: " + r.stderr);
  const set = new Set();
  for (const line of (r.stdout || "").split("\n")) {
    if (!line) continue;
    const m = /^([^:]+):(\d+):/.exec(line);
    if (m) {
      const rel = m[1].replace(CORPUS + "/", "").replace(/\/\//g, "/");
      set.add(rel + ":" + m[2]);
    }
  }
  return set;
}

function collect_rg(token) {
  const r = run("rg", ["-F", "--no-heading", "-n", token, CORPUS + "/"]);
  if (r.status !== 0 && r.status !== 1) throw new Error("rg failed: " + r.stderr);
  const set = new Set();
  for (const line of (r.stdout || "").split("\n")) {
    if (!line) continue;
    const m = /^([^:]+):(\d+):/.exec(line);
    if (m) {
      const rel = m[1].replace(CORPUS + "/", "");
      set.add(rel + ":" + m[2]);
    }
  }
  return set;
}

function collect_aisearch(mode, token, { no_rg } = {}) {
  const args = ["grep", token, CORPUS, "--json", "-n", "5000", "-C", "0"];
  const r = mode === "py" ? run_py_cli(args, { no_rg }) : run_js_cli(args, { no_rg });
  let resp;
  try { resp = JSON.parse(r.stdout); } catch {
    throw new Error((mode === "py" ? "py" : "js") + " grep not JSON: " + r.stdout.slice(0, 200) + r.stderr.slice(0, 200));
  }
  if (!resp.ok) throw new Error(mode + " grep error: " + resp.error);
  const set = new Set();
  for (const m of resp.data.matches) set.add(m.file + ":" + m.line);
  return set;
}

function set_diff(tool, truth) {
  let fp = 0, fn = 0;
  for (const x of tool) if (!truth.has(x)) fp++;
  for (const x of truth) if (!tool.has(x)) fn++;
  return { fp, fn, err: fp + fn };
}

// ── manifest 真值辅助 ──────────────────────────────

const manifest = JSON.parse(fs.readFileSync(path.join(BENCH, "manifest.json"), "utf8"));
const KIND_PRIORITY = { class: 0, struct: 0, interface: 0, trait: 0, enum: 1, type: 1, function: 2, method: 3 };

// 全符号索引：[{file, kind, name, line, line_end}]
// kind 归一到工具语义（Spec 锁定的行为）：
//   Python 方法（缩进 def）→ function + parent；Go 方法（接收器 func）→ function；
//   TS/JS 类方法保持 method（JS method 简写模式）。行号/范围不参与映射。
function tool_kind(sym) {
  if (sym.kind === "method" && (sym.file.endsWith(".py") || sym.file.endsWith(".go"))) {
    return "function";
  }
  return sym.kind;
}

const ALL_SYMBOLS = [];
for (const [file, info] of Object.entries(manifest.files)) {
  for (const s of info.symbols) ALL_SYMBOLS.push({ file, kind: tool_kind({ ...s, file }), name: s.name, line: s.line, line_end: s.line_end });
}

// ── T2: sym 对比 ───────────────────────────────────

function collect_sym(mode, needle, { no_rg = false, kind = null } = {}) {
  const args = ["sym", needle, CORPUS, "--json", "-n", "5000"];
  if (kind) args.push("-k", kind);
  const r = mode === "py" ? run_py_cli(args, { no_rg }) : run_js_cli(args, { no_rg });
  const resp = JSON.parse(r.stdout);
  if (!resp.ok) throw new Error(mode + " sym error: " + resp.error);
  return resp.data.matches.map((m) => m.file + ":" + m.line + ":" + m.kind + ":" + m.name).sort();
}

function truth_sym(needle) {
  const needle_l = needle.toLowerCase();
  return ALL_SYMBOLS
    .filter((s) => s.name.toLowerCase().includes(needle_l))
    .map((s) => s.file + ":" + s.line + ":" + s.kind + ":" + s.name)
    .sort();
}

// ── T3: def top-1 ──────────────────────────────────

function truth_def_top1(name) {
  const cands = ALL_SYMBOLS.filter((s) => s.name === name);
  if (!cands.length) return null;
  cands.sort((a, b) => {
    const pa = KIND_PRIORITY[a.kind] ?? 99, pb = KIND_PRIORITY[b.kind] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.line - b.line;
  });
  const t = cands[0];
  return t.file + ":" + t.line + ":" + t.kind + ":" + t.name;
}

function collect_def_top1(mode) {
  const args = ["def", mode._name, CORPUS, "--json"];
  const r = mode._impl === "py" ? run_py_cli(args, {}) : run_js_cli(args, {});
  const resp = JSON.parse(r.stdout);
  if (!resp.ok) return "ERROR: " + resp.error;
  if (!resp.data.matches.length) return "NONE";
  const m = resp.data.matches[0];
  return m.file + ":" + m.line + ":" + m.kind + ":" + m.name;
}

// ── T4: cat#symbol 内容 ────────────────────────────

function truth_symbol_content(file, line, line_end) {
  const full = path.join(CORPUS, file);
  const lines = fs.readFileSync(full, "utf8").split("\n");
  return lines.slice(line - 1, line_end).join("\n");
}

function collect_cat_sym(mode, fileRef) {
  const args = ["cat", fileRef, CORPUS, "--json"];
  const r = mode === "py" ? run_py_cli(args, {}) : run_js_cli(args, {});
  const resp = JSON.parse(r.stdout);
  if (!resp.ok) return { error: resp.error };
  return { content: resp.data.content, start: resp.data.lines.start, end: resp.data.lines.end };
}

// ── T5: ctx containing symbol ──────────────────────

function truth_containing(file, line) {
  const cands = ALL_SYMBOLS.filter((s) => s.file === file && s.line <= line && line <= s.line_end);
  if (!cands.length) return null;
  cands.sort((a, b) => (a.line_end - a.line) - (b.line_end - b.line));
  const t = cands[0];
  return t.kind + ":" + t.name + ":" + t.line + ":" + t.line_end;
}

function collect_ctx(mode, file, line) {
  const args = ["ctx", file + ":" + line, CORPUS, "--json"];
  const r = mode === "py" ? run_py_cli(args, {}) : run_js_cli(args, {});
  const resp = JSON.parse(r.stdout);
  if (!resp.ok) return { error: resp.error };
  const s = resp.data.containing_symbol;
  return {
    sym: s ? s.kind + ":" + s.name + ":" + s.line + ":" + s.line_end : null,
    content: resp.data.content,
  };
}

// ── rpc 批量延迟 ───────────────────────────────────

function rpc_batch(impl) {
  const reqs = [];
  let id = 1;
  for (const t of TOKENS) {
    reqs.push({ id: id++, method: "search", params: { pattern: t, path: CORPUS, limit: 5000, context: 0 } });
  }
  reqs.push({ id: id++, method: "search", params: { pattern: "def ", path: CORPUS, limit: 100, context: 0 } });
  for (const t of ["process_data", "validate_config", "Sync"]) {
    reqs.push({ id: id++, method: "symbols", params: { name: t, path: CORPUS, limit: 5000 } });
  }
  reqs.push({ id: id++, method: "read", params: { file: "pysrc/gen_000_py.py", path: CORPUS } });
  // read#symbol：从 manifest 取一个确定存在的符号，避免 runner 硬编码踩空
  const go_file = "gosrc/gen_010_go.go";
  const go_sym = (manifest.files[go_file]?.symbols || [])[0];
  reqs.push({ id: id++, method: "read", params: { file: go_file + "#" + (go_sym ? go_sym.name : "nope"), path: CORPUS } });
  reqs.push({ id: id++, method: "context", params: { file: "tssrc/gen_000_ts.ts", line: 30, radius: 4, path: CORPUS } });

  return function batch_once() {
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const p = impl === "py"
        ? spawn(PY_BIN, ["-c", `import sys; sys.path.insert(0, r'${REPO_ROOT}'); from aisearch.rpc import run_rpc; run_rpc()`])
        : spawn("node", [JS_CLI, "rpc"]);
      let out = "";
      p.stdout.on("data", (d) => { out += d; });
      p.stderr.on("data", (d) => { p.kill(); reject(new Error(impl + " rpc stderr: " + d)); });
      p.on("close", () => {
        const lines = out.trim().split("\n").filter(Boolean);
        if (lines.length !== reqs.length) {
          reject(new Error(impl + " rpc got " + lines.length + " responses, want " + reqs.length));
          return;
        }
        for (const ln of lines) {
          const r = JSON.parse(ln);
          if (!r.ok) { reject(new Error(impl + " rpc req failed: " + r.error)); return; }
        }
        resolve(performance.now() - t0);
      });
      for (const r of reqs) p.stdin.write(JSON.stringify(r) + "\n");
      p.stdin.end();
    });
  };
}

async function time_rpc(impl, rounds = 5) {
  const once = rpc_batch(impl);
  await once(); // 预热
  const times = [];
  for (let i = 0; i < rounds; i++) times.push(await once());
  return { median: median(times), min: Math.min(...times), max: Math.max(...times), rounds };
}

// ── 主流程 ──────────────────────────────────────────

async function main() {
  const results = { env: {}, t1: {}, t2: {}, t3: {}, t4: {}, t5: {}, rpc: {} };
  results.env.node = process.version;
  results.env.python = run(PY_BIN, ["--version"]).stdout.trim();
  results.env.rg = run("rg", ["--version"]).stdout.split("\n")[0];
  results.env.grep = run("grep", ["--version"]).stdout.split("\n")[0];
  results.env.corpus_files = Object.keys(manifest.files).length;
  results.env.corpus_lines = Object.values(manifest.files).reduce((a, f) => a + f.total_lines, 0);

  const MODES = [
    { id: "grep", label: "grep -rnF (GNU)" },
    { id: "rg", label: "rg -F (原生参考)" },
    { id: "py-rg", label: "py aisearch grep (rg 加速)" },
    { id: "py-pure", label: "py aisearch grep (纯 Python)" },
    { id: "js-rg", label: "js aisearch grep (rg 加速)" },
    { id: "js-pure", label: "js aisearch grep (纯 Node.js)" },
  ];

  // ═══ T1: 文本搜索 ═══
  console.log("== T1 文本搜索 ==");
  for (const mode of MODES) {
    results.t1[mode.id] = { label: mode.label, tokens: {}, total_fp: 0, total_fn: 0, total_truth: 0, hard_errors: 0, latency_ms: null };
  }

  for (const token of TOKENS) {
    const truth = truth_text_scan(token);
    console.log(`  token=${token} truth=${truth.size}`);
    for (const mode of MODES) {
      const acc = results.t1[mode.id];
      acc.tokens[token] = { truth: truth.size };
      try {
        const collected = mode.id === "grep" ? collect_grep(token)
          : mode.id === "rg" ? collect_rg(token)
          : mode.id.startsWith("py") ? collect_aisearch("py", token, { no_rg: mode.id === "py-pure" })
          : collect_aisearch("js", token, { no_rg: mode.id === "js-pure" });
        const d = set_diff(collected, truth);
        acc.tokens[token].fp = d.fp;
        acc.tokens[token].fn = d.fn;
        acc.total_fp += d.fp;
        acc.total_fn += d.fn;
        acc.total_truth += truth.size;
        if (d.fp + d.fn > 0) console.log(`    ${mode.id}: fp=${d.fp} fn=${d.fn}`);
      } catch (e) {
        acc.hard_errors++;
        acc.tokens[token].error = e.message.slice(0, 200);
        acc.total_truth += truth.size;
        console.log(`    ${mode.id}: HARD ERROR ${e.message.slice(0, 120)}`);
      }
    }
  }

  // T1 延迟：预热 1 轮 + 15 轮
  console.log("  timing (1 warmup + " + ROUNDS + " rounds, 6 tokens each)...");
  for (const mode of MODES) {
    const times = [];
    const one = (token) => {
      const t0 = performance.now();
      if (mode.id === "grep") run("grep", ["-rnF", token, CORPUS + "/"], { stdio: ["ignore", "ignore", "ignore"] });
      else if (mode.id === "rg") run("rg", ["-F", "-n", token, CORPUS + "/"], { stdio: ["ignore", "ignore", "ignore"] });
      else if (mode.id.startsWith("py")) run_py_cli(["grep", token, CORPUS, "--json", "-n", "5000", "-C", "0"], { no_rg: mode.id === "py-pure", capture: false });
      else run_js_cli(["grep", token, CORPUS, "--json", "-n", "5000", "-C", "0"], { no_rg: mode.id === "js-pure", capture: false });
      return performance.now() - t0;
    };
    for (const token of TOKENS) one(token); // 预热
    for (let i = 0; i < ROUNDS; i++) {
      for (const token of TOKENS) times.push(one(token));
    }
    results.t1[mode.id].latency_ms = {
      median: Math.round(median(times) * 100) / 100,
      p95: Math.round(p95(times) * 100) / 100,
      mean: Math.round((times.reduce((a, b) => a + b, 0) / times.length) * 100) / 100,
      samples: times.length,
    };
    console.log(`    ${mode.id}: median=${results.t1[mode.id].latency_ms.median}ms p95=${results.t1[mode.id].latency_ms.p95}ms`);
  }

  // ═══ T2: sym ═══
  console.log("== T2 符号搜索 ==");
  const sym_queries = [
    { needle: "process_data", kind: null },
    { needle: "validate_config", kind: null },
    { needle: "sync", kind: "class" },
    { needle: "alpha", kind: "function" },
    { needle: "ZetaMatrixSync", kind: null },
  ];
  results.t2.queries = {};
  for (const q of sym_queries) {
    const truth = truth_sym(q.needle).filter((x) => (q.kind ? x.split(":")[2] === q.kind : true));
    const py = collect_sym("py", q.needle, { no_rg: true, kind: q.kind });
    const js = collect_sym("js", q.needle, { no_rg: true, kind: q.kind });
    const eq = JSON.stringify(py) === JSON.stringify(js);
    const tp = py.filter((x) => truth.includes(x)).length;
    const fp = py.filter((x) => !truth.includes(x)).length;
    const fn = truth.length - tp;
    results.t2.queries[q.needle + (q.kind ? "@kind=" + q.kind : "")] = {
      truth: truth.length, py: py.length, js: js.length,
      py_eq_js: eq, fp, fn,
      err_rate: truth.length ? Math.round(((fp + fn) / truth.length) * 10000) / 100 : null,
    };
    console.log(`  ${q.needle}${q.kind ? " @" + q.kind : ""}: truth=${truth.length} py=${py.length} js=${js.length} py==js=${eq} fp=${fp} fn=${fn}`);
  }
  // sym 延迟（no_rg，纯实现符号提取）
  for (const impl of ["py", "js"]) {
    const times = [];
    const one = () => {
      const t0 = performance.now();
      if (impl === "py") run_py_cli(["sym", "a", CORPUS, "--json", "-n", "5000"], { no_rg: true, capture: false });
      else run_js_cli(["sym", "a", CORPUS, "--json", "-n", "5000"], { no_rg: true, capture: false });
      return performance.now() - t0;
    };
    one(); // 预热
    for (let i = 0; i < 5; i++) times.push(one());
    results.t2[impl + "_sym_all_files_ms"] = { median: Math.round(median(times) * 100) / 100, samples: times.length };
    console.log(`  ${impl} sym(全语料 270 文件符号提取): median=${results.t2[impl + "_sym_all_files_ms"].median}ms`);
  }

  // ═══ T3: def top-1 ═══
  console.log("== T3 查找定义 top-1 ==");
  // 挑 10 个名字：重名优先（跨文件同名更有区分度）+ 若干唯一名
  const name_count = new Map();
  for (const s of ALL_SYMBOLS) name_count.set(s.name, (name_count.get(s.name) || 0) + 1);
  const dup_names = [...name_count.entries()].filter(([, c]) => c > 1).map(([n]) => n).sort();
  const uniq_names = [...name_count.entries()].filter(([, c]) => c === 1).map(([n]) => n).sort();
  const def_names = [];
  for (let i = 0; i < 7 && i < dup_names.length; i++) def_names.push(dup_names[Math.floor(i * dup_names.length / 7)]);
  for (let i = 0; i < 3 && i < uniq_names.length; i++) def_names.push(uniq_names[Math.floor(i * uniq_names.length / 3)]);

  results.t3.names = {};
  let t3_py_ok = 0, t3_js_ok = 0;
  for (const name of def_names) {
    const truth = truth_def_top1(name);
    const pyR = collect_def_top1({ _name: name, _impl: "py" });
    const jsR = collect_def_top1({ _name: name, _impl: "js" });
    const py_ok = pyR === truth, js_ok = jsR === truth;
    if (py_ok) t3_py_ok++;
    if (js_ok) t3_js_ok++;
    results.t3.names[name] = { truth, py: pyR, js: jsR, py_ok, js_ok };
    console.log(`  ${name}: truth=${truth} py_ok=${py_ok} js_ok=${js_ok}`);
  }
  results.t3.summary = { total: def_names.length, py_ok: t3_py_ok, js_ok: t3_js_ok };

  // ═══ T4: cat#symbol ═══
  console.log("== T4 按符号读取 ==");
  // 每语言挑 5 个符号：第 0 个文件的多行签名函数（行数最大的 function）+ 类 + 方法
  const t4_picks = [];
  for (const dir of ["pysrc", "tssrc", "gosrc"]) {
    const files = Object.keys(manifest.files).filter((f) => f.startsWith(dir + "/")).slice(0, 3);
    for (const file of files) {
      const syms = manifest.files[file].symbols;
      if (!syms.length) continue;
      const biggest = syms.slice().sort((a, b) => (b.line_end - b.line) - (a.line_end - a.line))[0];
      const pick = [biggest, syms[0]].find((s) => s && !t4_picks.some((p) => p.file === file && p.name === s.name));
      if (pick) t4_picks.push({ file, ...pick });
    }
  }
  // 去重 + 截断到 15
  const seen = new Set();
  const t4_final = [];
  for (const p of t4_picks) {
    const k = p.file + "#" + p.name;
    if (!seen.has(k) && t4_final.length < 15) { seen.add(k); t4_final.push(p); }
  }

  results.t4.cases = {};
  let t4_py_ok = 0, t4_js_ok = 0, t4_py_eq_js = 0;
  for (const p of t4_final) {
    const ref = p.file + "#" + p.name;
    const expect = truth_symbol_content(p.file, p.line, p.line_end);
    const pyR = collect_cat_sym("py", ref);
    const jsR = collect_cat_sym("js", ref);
    const py_ok = !pyR.error && pyR.content === expect && pyR.start === p.line && pyR.end === p.line_end;
    const js_ok = !jsR.error && jsR.content === expect && jsR.start === p.line && jsR.end === p.line_end;
    const eq = !pyR.error && !jsR.error && pyR.content === jsR.content;
    if (py_ok) t4_py_ok++;
    if (js_ok) t4_js_ok++;
    if (eq) t4_py_eq_js++;
    results.t4.cases[ref] = {
      line: p.line, line_end: p.line_end, expect_lines: p.line_end - p.line + 1,
      py_ok, js_ok, py_eq_js: eq,
      py_error: pyR.error || null, js_error: jsR.error || null,
    };
    console.log(`  ${ref} (${p.line}-${p.line_end}): py_ok=${py_ok} js_ok=${js_ok} py==js=${eq}${pyR.error ? " pyERR=" + pyR.error : ""}${jsR.error ? " jsERR=" + jsR.error : ""}`);
  }
  results.t4.summary = { total: t4_final.length, py_ok: t4_py_ok, js_ok: t4_js_ok, py_eq_js: t4_py_eq_js };

  // ═══ T5: ctx ═══
  console.log("== T5 上下文获取 ==");
  const t5_positions = [];
  const t5_files = ["pysrc/gen_000_py.py", "tssrc/gen_000_ts.ts", "gosrc/gen_000_go.go", "pysrc/gen_008_py.py", "tssrc/gen_048_ts.ts"];
  for (const file of t5_files) {
    const syms = manifest.files[file]?.symbols || [];
    if (!syms.length) continue;
    const s = syms[Math.floor(syms.length / 2)];
    t5_positions.push({ file, line: s.line + 1 }); // 符号体内部行
  }

  results.t5.cases = {};
  let t5_py_ok = 0, t5_js_ok = 0;
  for (const pos of t5_positions) {
    const expect_sym = truth_containing(pos.file, pos.line);
    const full = path.join(CORPUS, pos.file);
    const allLines = fs.readFileSync(full, "utf8").split("\n");
    const r = 5;
    const st = Math.max(0, pos.line - 1 - r), en = Math.min(allLines.length, pos.line + r);
    const expect_content = allLines.slice(st, en).join("\n");
    const pyR = collect_ctx("py", pos.file, pos.line);
    const jsR = collect_ctx("js", pos.file, pos.line);
    const py_ok = !pyR.error && pyR.sym === expect_sym && pyR.content === expect_content;
    const js_ok = !jsR.error && jsR.sym === expect_sym && jsR.content === expect_content;
    if (py_ok) t5_py_ok++;
    if (js_ok) t5_js_ok++;
    results.t5.cases[pos.file + ":" + pos.line] = {
      expect_sym, py_ok, js_ok,
      py_sym: pyR.sym ?? ("ERR:" + (pyR.error || "")), js_sym: jsR.sym ?? ("ERR:" + (jsR.error || "")),
    };
    console.log(`  ${pos.file}:${pos.line}: py_ok=${py_ok} js_ok=${js_ok}`);
  }
  results.t5.summary = { total: t5_positions.length, py_ok: t5_py_ok, js_ok: t5_js_ok };

  // ═══ rpc 批量 ═══
  console.log("== rpc 批量（20 请求/会话）==");
  for (const impl of ["py", "js"]) {
    const r = await time_rpc(impl, 5);
    results.rpc[impl] = { requests_per_session: 20, ...r };
    console.log(`  ${impl}: median=${Math.round(r.median)}ms for 20 requests`);
  }

  // ═══ 汇总 ═══
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(results, null, 1), "utf8");
  console.log("\nresults.json written");
}

main().catch((e) => { console.error(e); process.exit(1); });
