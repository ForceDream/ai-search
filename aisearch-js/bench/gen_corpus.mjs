#!/usr/bin/env node
/**
 * 基准语料生成器（确定性，固定种子）：
 *   <BENCH_DIR>/corpus/  下生成 120 .py + 90 .ts + 60 .go
 *   <BENCH_DIR>/manifest.json  记录每个文件的全部符号（kind/name/line/line_end）
 *
 * 语料特点：
 *   - 全 ASCII、确定性内容（mulberry32 固定种子）
 *   - 含多行签名函数（测试符号范围算法）
 *   - 含嵌套类 / Go 方法接收器 / TS interface+enum
 *   - 种植 6 个查询 token（定义 + 调用混合），行级命中数可预算
 *
 * manifest 是"上帝视角"真值：由生成结构直接写入，不经过任何符号提取器。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 基准工作目录：默认系统临时目录，可用 AISEARCH_BENCH_DIR 覆盖。
const BENCH_ROOT = process.env.AISEARCH_BENCH_DIR || path.join(os.tmpdir(), "aisearch-bench");
const CORPUS = path.join(BENCH_ROOT, "corpus");

// ── 确定性 PRNG ─────────────────────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 词表（确定性组合）───────────────────────────────
const VERBS = ["compute", "validate", "load", "flush", "merge", "parse", "render", "sync", "fetch", "pack", "scale", "route", "trace", "batch", "cache"];
const NOUNS = ["alpha", "delta", "gamma", "vector", "matrix", "buffer", "stream", "packet", "signal", "ledger", "session", "channel", "segment", "payload", "cursor"];
const CLASS_WORDS = ["Engine", "Worker", "Store", "Gateway", "Bridge", "Factory", "Router", "Keeper", "Handler", "Tracker"];

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

function snake(rng) { return pick(rng, VERBS) + "_" + pick(rng, NOUNS) + (rng() < 0.3 ? "_" + Math.floor(rng() * 90 + 10) : ""); }
function camel(rng) { const s = snake(rng); return s.replace(/_(\w)/g, (_, c) => c.toUpperCase()); }
function pascal(rng) { const c = camel(rng); return c[0].toUpperCase() + c.slice(1); }

// ── 种植 token（查询词）─────────────────────────────
// 命中行数预算见 README 注释；真值由逐行 indexOf 独立扫描得出
const TOKENS = ["process_data", "validate_config", "ZetaMatrixSync", "quantum_flux", "replay_buffer", "edge_case_TOKEN"];

// ── 生成辅助：行缓冲 + 符号登记 ─────────────────────
function make_file() {
  const lines = [];
  const symbols = [];
  return {
    lines,
    symbols,
    at() { return lines.length + 1; },
    push(s) { lines.push(s); },
    // 记录一个符号（在 push 内容之后调用：start 是符号声明行，end 是当前最后一行）
    record(kind, name, startLine, parent = "") {
      symbols.push({ kind, name, line: startLine, line_end: lines.length });
    },
  };
}

// ── Python 文件 ─────────────────────────────────────
function gen_py(idx, rng) {
  const f = make_file();
  const mod = snake(rng);

  f.push("# module " + mod + " (generated, index " + idx + ")");
  f.push('"""Auto-generated corpus file. Do not edit."""');
  f.push("");
  f.push("import os");
  f.push("import sys");
  f.push("");

  // 顶层常量
  const const_name = snake(rng).toUpperCase();
  f.push(const_name + " = " + Math.floor(rng() * 900 + 100));
  f.push("");

  // 种植：低频 token 常量
  if (idx % 23 === 0) {
    f.push('QUANTUM_FLUX_TAG = "quantum_flux"');
    f.push("");
  }

  // 1-2 个模块级函数（其中部分多行签名）
  const n_funcs = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < n_funcs; i++) {
    const fname = snake(rng);
    const multiline = rng() < 0.35;
    const start = f.at();
    if (multiline) {
      f.push("def " + fname + "(");
      f.push("    payload,");
      f.push('    mode="fast",');
      f.push("    retries=3,");
      f.push(") -> dict:");
      f.push('    """Handle ' + fname + '."""');
      f.push("    result = {}");
      // 种植调用行
      if (idx % 2 === 0 && i === 0) {
        f.push("    process_data(payload, mode)");
      }
      if (idx % 7 === 0) {
        f.push("    validate_config(result)");
      }
      f.push("    return result");
    } else {
      f.push("def " + fname + "(payload, mode=" + '"fast"' + "):");
      f.push('    """Handle ' + fname + '."""');
      if (idx % 2 === 0 && i === 0) {
        f.push("    return process_data(payload, mode)");
      } else if (idx % 7 === 0) {
        f.push("    return validate_config(payload)");
      } else {
        f.push("    return {'ok': payload is not None}");
      }
    }
    f.record("function", fname, start);
    f.push("");
  }

  // 1 个类（含 2-3 个方法，部分多行签名）
  const cname = pascal(rng);
  const cstart = f.at();
  f.push("class " + cname + ":");
  f.push('    """' + cname + " holds generated state." + '"""');
  f.push("");
  f.push("    def __init__(self, name):");
  f.push("        self.name = name");
  f.push("        self.items = []");
  f.record("method", "__init__", f.at() - 3, cname);
  const n_methods = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < n_methods; i++) {
    if (i > 0) f.push(""); // 方法间空行（class record 前不留尾空行）
    const mname = camel(rng);
    const start = f.at();
    const multiline = rng() < 0.3;
    if (multiline) {
      f.push("    def " + mname + "(");
      f.push("        self,");
      f.push("        item,");
      f.push("        force=False,");
      f.push("    ):");
      f.push("        if force:");
      f.push("            self.items.append(item)");
      f.push("            return True");
      f.push("        return False");
    } else {
      f.push("    def " + mname + "(self, item):");
      f.push("        self.items.append(item)");
      if (idx % 3 === 0) {
        f.push("        process_data(self.items, " + '"scan"' + ")");
      }
      f.push("        return len(self.items)");
    }
    f.record("method", mname, start, cname);
  }
  f.record("class", cname, cstart);

  // 种植：类名 token（中频）
  if (idx % 8 === 0) {
    f.push("");
    const zstart = f.at();
    f.push("class ZetaMatrixSync" + idx + ":");
    f.push('    """Planted class for token query."""');
    f.push("");
    f.push("    def ping(self):");
    f.push("        return ZetaMatrixSync" + idx + "");
    f.record("class", "ZetaMatrixSync" + idx, zstart);
  }

  // 尾注释（不含 token，避免干扰行计数）
  f.push("");
  f.push("# end of " + mod);
  return { ext: ".py", file: f };
}

// ── TypeScript 文件 ─────────────────────────────────
function gen_ts(idx, rng) {
  const f = make_file();
  const mod = camel(rng);

  f.push("// module " + mod + " (generated, index " + idx + ")");
  f.push('import { EventEmitter } from "events";');
  f.push("");

  // interface
  const iname = "I" + pascal(rng);
  let start = f.at();
  f.push("export interface " + iname + " {");
  f.push("  id: number;");
  f.push("  name: string;");
  f.push("  ready: boolean;");
  f.push("}");
  f.record("interface", iname, start);

  // enum
  const ename = pascal(rng) + "Mode";
  start = f.at();
  f.push("export enum " + ename + " {");
  f.push("  Fast = 1,");
  f.push("  Slow = 2,");
  f.push("}");
  f.record("enum", ename, start);

  // type
  const tname = pascal(rng) + "Map";
  start = f.at();
  f.push("export type " + tname + " = Record<string, number>;");
  f.record("type", tname, start);
  f.push("");

  // 箭头函数 / const 函数
  const afname = camel(rng);
  start = f.at();
  f.push("export const " + afname + " = async (input: string): Promise<number> => {");
  f.push("  return input.length;");
  f.push("};");
  f.record("function", afname, start);
  f.push("");

  // class（含方法简写 + 多行签名方法）
  const cname = pascal(rng);
  const cstart = f.at();
  f.push("export class " + cname + " extends EventEmitter {");
  f.push("  private items: string[] = [];");
  f.push("");
  f.push("  constructor(public name: string) {");
  f.push("    super();");
  f.push("  }");
  f.record("method", "constructor", f.at() - 3, cname);
  f.push("");

  const n_methods = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < n_methods; i++) {
    const mname = camel(rng);
    const mstart = f.at();
    if (rng() < 0.3) {
      f.push("  async " + mname + "(");
      f.push("    item: string,");
      f.push("    force: boolean,");
      f.push("  ): Promise<boolean> {");
      f.push("    if (force) {");
      f.push("      this.items.push(item);");
      f.push("      return true;");
      f.push("    }");
      f.push("    return false;");
      f.push("  }");
    } else {
      f.push("  " + mname + "(item: string): number {");
      if (idx % 3 === 0) {
        f.push('    return process_data(this.items, item).length;');
      } else if (idx % 7 === 0) {
        f.push('    return validate_config(item) ? 1 : 0;');
      } else {
        f.push("    this.items.push(item);");
        f.push("    return this.items.length;");
      }
      f.push("  }");
    }
    f.record("method", mname, mstart, cname);
    f.push("");
  }
  f.push("}");
  f.record("class", cname, cstart);

  // 种植类名
  if (idx % 8 === 0) {
    f.push("");
    f.push("export class ZetaMatrixSync" + idx + " {");
    f.push("  ping(): ZetaMatrixSync" + idx + " {");
    f.push("    return new ZetaMatrixSync" + idx + "();");
    f.push("  }");
    f.push("}");
    f.record("class", "ZetaMatrixSync" + idx, f.at() - 5);
  }

  // 稀疏 token
  if (idx % 17 === 0) {
    f.push("");
    f.push("export const replay_buffer = " + idx + ";");
  }

  f.push("");
  f.push("// end of " + mod);
  return { ext: ".ts", file: f };
}

// ── Go 文件 ─────────────────────────────────────────
function gen_go(idx, rng) {
  const f = make_file();
  const pkg = snake(rng).replace(/_/g, "");

  f.push("package " + pkg);
  f.push("");
  f.push("import (");
  f.push('	"fmt"');
  f.push('	x "os"');
  f.push(")");
  f.push("");

  // struct
  const sname = pascal(rng);
  let start = f.at();
  f.push("type " + sname + " struct {");
  f.push("	Name string");
  f.push("	Items []string");
  f.push("}");
  f.record("struct", sname, start);

  // interface
  const iname = "I" + pascal(rng);
  start = f.at();
  f.push("type " + iname + " interface {");
  f.push("	Load(key string) (string, error)");
  f.push("}");
  f.record("interface", iname, start);
  f.push("");

  // 方法（接收器）
  const n_methods = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < n_methods; i++) {
    const mname = pascal(rng);
    const mstart = f.at();
    f.push("func (s *" + sname + ") " + mname + "(key string) error {");
    if (idx % 3 === 0) {
      f.push('	process_data(s.Items, key)');
    } else {
      f.push('	fmt.Println(key)');
    }
    f.push("	return nil");
    f.push("}");
    f.record("method", mname, mstart, sname);
    f.push("");
  }

  // 函数（部分多行签名）
  const n_funcs = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < n_funcs; i++) {
    const fname = pascal(rng);
    const fstart = f.at();
    if (rng() < 0.3) {
      f.push("func " + fname + "(");
      f.push("	payload string,");
      f.push("	force bool,");
      f.push(") (string, error) {");
      f.push('	if force {');
      f.push('		return payload, nil');
      f.push('	}');
      if (idx % 7 === 0) {
        f.push('	validate_config(payload)');
      }
      f.push('	return payload + ":ok", nil');
      f.push("}");
    } else {
      f.push("func " + fname + "(payload string) string {");
      if (idx % 2 === 0 && i === 0) {
        f.push('	return process_data([]string{payload}, "go")');
      } else {
        f.push('	return payload');
      }
      f.push("}");
    }
    f.record("function", fname, fstart);
    f.push("");
  }

  // 种植类名
  if (idx % 8 === 0) {
    start = f.at();
    f.push("type ZetaMatrixSync" + idx + " struct {");
    f.push("	Tag string");
    f.push("}");
    f.record("struct", "ZetaMatrixSync" + idx, start);
  }

  f.push("");
  f.push("// end of " + pkg);
  return { ext: ".go", file: f };
}

// ── 主流程 ──────────────────────────────────────────
function main() {
  fs.rmSync(BENCH_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(CORPUS, ".git"), { recursive: true }); // 项目根 marker（rg/aisearch 识别）

  const rng = mulberry32(20260917);
  const manifest = { seed: 20260917, files: {}, tokens: TOKENS };
  const counts = { ".py": 120, ".ts": 90, ".go": 60 };
  const gens = { ".py": gen_py, ".ts": gen_ts, ".go": gen_go };
  const dirs = { ".py": "pysrc", ".ts": "tssrc", ".go": "gosrc" };

  let total_lines = 0;
  let total_syms = 0;

  for (const [ext, n] of Object.entries(counts)) {
    const sub = path.join(CORPUS, dirs[ext]);
    fs.mkdirSync(sub, { recursive: true });
    for (let i = 0; i < n; i++) {
      const { file: f } = gens[ext](i, rng);
      const name = "gen_" + String(i).padStart(3, "0") + "_" + ext.slice(1) + ext;
      fs.writeFileSync(path.join(sub, name), f.lines.join("\n") + "\n", "utf8");
      const rel = dirs[ext] + "/" + name;
      manifest.files[rel] = {
        total_lines: f.lines.length,
        symbols: f.symbols,
      };
      total_lines += f.lines.length;
      total_syms += f.symbols.length;
    }
  }

  // edge_case_TOKEN：只在 2 个文件、固定行种植（低频边界查询）
  const edgeTargets = ["pysrc/gen_003_py.py", "tssrc/gen_041_ts.ts"];
  for (const rel of edgeTargets) {
    const full = path.join(CORPUS, rel);
    const text = fs.readFileSync(full, "utf8");
    fs.writeFileSync(full, text + "const_edge = edge_case_TOKEN // planted\n", "utf8");
    manifest.files[rel].total_lines += 1;
    manifest.files[rel].edge = true;
  }

  fs.writeFileSync(path.join(BENCH_ROOT, "manifest.json"), JSON.stringify(manifest, null, 1), "utf8");
  console.log("corpus generated at " + CORPUS);
  console.log("files: " + Object.keys(manifest.files).length + ", total lines: " + total_lines + ", symbols: " + total_syms);
}

main();
