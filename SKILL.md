---
name: aisearch
slug: aisearch
displayName: aisearch — 精确定位与阅读代码的检索工具
version: 1.0.1
description: "精确定位与阅读代码的检索工具，替代 grep -rn 与 LSP。用于：查出某个符号（函数、类、方法、类型）定义在哪，谁引用了它，读取某个函数的完整实现，查看某一行所属的函数及其上下文，快速掌握项目目录结构。返回结构化 JSON 且只取所需片段，token 消耗比 grep 或整文件读取低数倍。触发词：查定义、找引用、读这个函数、这行在哪个函数里、项目结构、grep 替代、LSP 替代、token 友好的代码检索。"
allowed-tools: Bash, Read
summary: 替代 grep -rn 与 LSP 的代码检索：查定义、找引用、按符号读函数、查某行所属函数、看目录结构；返回结构化 JSON，token 消耗比 grep 或整文件读取低数倍
tags: [code-search, grep, lsp, def, ref, token-efficient]
license: MIT
---

# aisearch

零依赖代码检索工具，本技能自带 Python 与 Node 两套实现（CLI 行为与 JSON 协议逐字段一致）。
**AI 用 `rpc`（单进程常驻，跨请求不付冷启动）；人类用 CLI。**

只要机器上有 **Python >= 3.9 或 Node** 之一即可，无需安装、不监听端口。

## 什么时候用我（触发词）

**触发词**：查定义 / 找引用 / 谁调用了它 / 读这个函数 / 这行在哪个函数里 / 项目目录结构 / grep 替代 / LSP 替代 / 省 token 的代码检索。

**最短上手**（复制即用，把 `--root` 换成目标项目根）：

```bash
python "${CODEBUDDY_SKILL_DIR}/scripts/aisearch_rpc.py" --root . def '{"name":"<符号名>"}'
```

查一个符号一次调用就够；要连续查多个，用下节的 `--stdin` 批量（一次会话多请求，不重复付进程启动）。

## 调用

`<SKILL_DIR>` 是本 `SKILL.md` 所在目录（CodeBuddy 会把 `${CODEBUDDY_SKILL_DIR}` 替换成它的绝对路径）。

```bash
# 单次请求：内部拉起一次 rpc 会话
python "${CODEBUDDY_SKILL_DIR}/scripts/aisearch_rpc.py" --root <项目根> def '{"name":"apply_discount"}'

# 批量：一次会话发多行请求（每行一个完整请求对象）
python "${CODEBUDDY_SKILL_DIR}/scripts/aisearch_rpc.py" --root <项目根> --stdin < "${CODEBUDDY_SKILL_DIR}/assets/requests/basic.jsonl"

# 切到 Node 实现（Windows 反斜杠路径可直接传）
python "${CODEBUDDY_SKILL_DIR}/scripts/aisearch_rpc.py" --root <项目根> --tool "node ${CODEBUDDY_SKILL_DIR}/scripts/aisearch-js/bin/aisearch.mjs" health '{}'
```

PowerShell 没有 `<` 输入重定向，批量请求用管道：

```powershell
Get-Content "${CODEBUDDY_SKILL_DIR}\assets\requests\basic.jsonl" | python "${CODEBUDDY_SKILL_DIR}\scripts\aisearch_rpc.py" --root <项目根> --stdin
```

- `--pretty` 缩进输出，便于阅读；默认每行一个紧凑 JSON。
- 技能目录含空格时，`--tool` 中的可执行文件路径本身要再包一层引号。
- 命令探测顺序：`--tool` > 环境变量 `AISEARCH_CMD` > PATH 上的 `aisearch`（若你已 pip 装过）> 本技能自带的 Python 实现。
- 复杂 params 建议走 `--stdin`，避免各 shell 的引号规则差异。

## 方法

| method | params | 用途 |
|---|---|---|
| `search` | `pattern`(必), `path?, context?, limit?, ignore_case?, whole_word?, extensions?` | 文本搜索（替代 grep） |
| `symbols` | `name`(必), `path?, kind?, limit?, partial?` | 符号搜索（子串匹配） |
| `def` | `name`(必), `path?, limit?, substring_fallback?=true` | 查找定义：exact 优先，候选全部来自定义正则（`match_mode:"exact"`）；无命中回退子串并标 `match_mode:"substring"`（候选需核对；`substring_fallback:false` 可关闭） |
| `ref` | `name`(必), `path?, limit?` | 查找引用（全词匹配的使用位置） |
| `read` | `file`(必), `path?, outline?` | 读文件（整文件 / 行范围 / 按符号） |
| `context` | `file`(必), `line`(必), `radius?, path?` | 某行的语义上下文（所属函数、导入等） |
| `tree` | `path?, depth?` | 项目目录树 |
| `health` | `{}` | 版本 / 方法列表 / 生效根与边界 |

响应统一为 `{"id":N,"ok":true,"data":{...}}` 或 `{"id":N,"ok":false,"error":"..."}`；非法请求（坏 JSON、未知方法、非法参数）返回结构化错误，进程不崩溃。

## `file` 引用语法（`read` / `context`）

| 写法 | 含义 |
|---|---|
| `src/app.ts` | 整个文件 |
| `src/app.ts:10-50` | 行范围 |
| `src/app.ts#parseConfig` | 某个符号的完整实现（**最省 token 的读法，优先用它替代整文件读取**） |
| `src/app.ts:42` | 单行（`context` 也接受该写法） |

## `path` 的范围

`path` 可指向：项目根（默认）、单个文件（只搜该文件）、根内子目录（只搜该子树）。输出路径始终相对项目根；`rpc --root` 锁定时越界路径被拒绝（`ok:false, "... escapes project root"`）。

入口脚本会把 rpc 子进程的工作目录设为 `--root`，因此**相对 `path` 一律相对项目根解析**，与你在哪个目录敲命令无关。

## 资源上限与既定行为

- 单次返回正文上限 **200000 字符**，超出即截断并置 `truncated: true` —— 此时改用 `file:行范围` 或 `file#符号`，不要直接读整文件。
- 单次结果 ≤ 5000 条、上下文行数 ≤ 200、目录树深度 ≤ 16、搜索模式 ≤ 256 字符。
- 文本文件 > 5MB 走流式：无范围时只返回头部预览并置 `truncated: true`。
- 无 BOM 且含 NUL 的文件判为二进制，返回 `ok:false, "Binary file (...); not text"` —— **不要重试**，改用文本源文件。

## 何时不要用

- 只需"整库出现次数"这类无结构统计 → `rg` / `grep` 更直接。
- 需要跨语言的类型级语义（真正的类型推断、重命名重构）→ 用真正的 LSP。本工具是正则级启发式，符号范围由缩进/括号配平推断。

## 常见问题（FAQ）

**出错信息对照（英文串 → 怎么办）**：

| 见到 | 含义与处置 |
|---|---|
| `Missing 'pattern'` / `Missing 'name'` / `Missing 'file'` | `params` 少了必填键，补上即可 |
| `Search pattern too long (N chars > 256)` | 正则超 256 字符上限，拆成几个更短的查询 |
| `Path '...' escapes project root` | 路径越出 `--root` 边界；改用项目内的相对路径 |
| `Start line N beyond end of file (M lines)` | 行号超界；先用 `read` 确认该文件实际行数 |
| `Binary file (...); not text` | 命中二进制（无 BOM 且含 NUL）；**不要重试**，换文本源文件 |
| `Empty symbol name after '#'` | `file#` 后必须跟符号名，如 `src/a.py#parse` |
| 结果带 `truncated: true` | 被体积上限截断；改用 `file:行范围` 或 `file#符号` 精确取 |

**其他常见疑问**：

- `def` 返回多条候选？→ 同名多定义；`match_mode` 为 `substring` 表示这是回退的模糊匹配，**必须核对**后再用。
- 搜不到中文标识符？→ 编码自动探测（UTF-8 / GB18030），正常可搜；中文乱码只出现在未走探测的老边界，属已知限制。
- 凭什么说比 `grep` 省 token？→ 只回结构化片段（`file`/`line`/`line_end`/`text`）而非全部命中行；实测高频词场景输出体积约为 `grep -rn` 的 **1/15**。
- 需要跨机器/跨语言一致行为？→ Python 与 Node 两套实现**逐字段一致**，仅 rpc 的 `elapsed_ms` 与空白不同。

## 参考（按需加载）

- `references/protocol.md`：完整协议、各方法返回字段、错误文本与处置、双实现已知差异。
- `references/examples.md`：真实请求/响应样例与解读。
- `assets/demo/`：配套的极小语料（Python + TypeScript）；`assets/requests/basic.jsonl`：可直接重放的示例请求。
