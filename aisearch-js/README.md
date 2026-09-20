# aisearch-js

`aisearch` 的 Node.js 移植版 —— AI 友好的代码搜索与阅读工具。**零 npm 依赖**，与 [Python 版](../aisearch) 协议逐字段对齐。

## 特性

- 7 个 CLI 命令：`grep` / `sym` / `def` / `ref` / `cat` / `ctx` / `tree`
- `rpc`：stdio 行分隔 JSON 协议，**不监听任何端口**，由 AI harness 以子进程拉起
- 正则符号提取（不需要 LSP），支持 Python/TS/JS/Go/Rust/Java 等 20+ 语言
- 检测到 ripgrep 时自动加速（`AISEARCH_NO_RG=1` 强制纯 JS 实现）
- 安全边界：`rpc --root` 强制项目根内路径，拒绝路径穿越

## 使用

```bash
node bin/aisearch.mjs grep "process_data" /path/to/project --json -n 100
node bin/aisearch.mjs sym "Engine" /path/to/project -k class
node bin/aisearch.mjs cat src/main.py#handle_request /path/to/project
node bin/aisearch.mjs ctx src/main.py:42 /path/to/project
node bin/aisearch.mjs tree /path/to/project -d 3
node bin/aisearch.mjs rpc --root /path/to/project
```

非 TTY（管道）输出自动切换为 JSON；交互终端输出彩色文本。

## rpc 协议

行分隔 JSON，请求 `{"id":1,"method":"search","params":{"pattern":"foo","limit":50}}`，
响应 `{"id":1,"ok":true,"data":{...}}`。方法：`search / symbols / def / ref / read / context / tree / health`。

## 基准

见 [`bench/REPORT.md`](bench/REPORT.md)：grep / rg / py / js 四方对比（出错率全部 0%；js 相对 py 在冷启动快 42%、符号提取快 1.8x、rpc 会话快 1.6x）。

## 测试

```bash
# py ↔ js CLI parity（默认自动定位同级 Python 仓库，可用 AISEARCH_PY_ROOT 覆盖）
node tests/parity_smoke.mjs [path-to-python-aisearch]

# 完整基准（语料生成在临时工作目录，可用 AISEARCH_BENCH_DIR 覆盖）
node bench/gen_corpus.mjs && node bench/run_bench.mjs
```

## 与 Python 版的差异

- 行为与 JSON 输出逐字段一致（`elapsed_ms` 等耗时字段除外）；正则错误消息文本因引擎而异（协议只含字符串）。
- **`\w` / `\b` 的 Unicode 语义差异**：纯 JS 回退引擎的 `\w` 为 ASCII 语义，而 Python `re` 与 `rg` 为 Unicode 语义。因此含中文标识符的模式（如 `def \w+_\w+` 命中 `def 函数_gbk`）在**未安装 ripgrep** 时两版结果可能不同；安装 `rg` 后两版一致。需要跨版本严格一致时，请使用显式字符类（如 `[A-Za-z0-9_]+`）或安装 `rg`。
- JS 侧 `Number` 陷阱（`Number(null)=0` 等）已通过 Python `int()` 语义模拟层（`src/util.mjs`）规避。
