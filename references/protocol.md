# aisearch 协议与参考（按需加载）

## 1. rpc 协议

行分隔 JSON：stdin 进、stdout 出，一请求一行响应，逐行 flush。进程可由调用方以子进程拉起，**不监听任何端口**。

```
请求 → {"id":1,"method":"search","params":{"pattern":"def foo","limit":20}}
响应 ← {"id":1,"ok":true,"data":{"matches":[...],"total":3,"files_searched":12,"elapsed_ms":8.4}}
错误 ← {"id":1,"ok":false,"error":"Invalid regex: ..."}
```

- 空行不产生响应。
- 单行请求上限 1 MB，超出返回结构化错误。
- 坏 JSON / 未知方法 / 非法参数一律结构化错误，进程不崩溃。

```bash
aisearch rpc                       # 以 cwd 为项目根（boundary=system）
aisearch rpc --root /path/to/proj  # 锁定项目根（boundary=root，拦截 ../ 与绝对路径）
```

## 2. 方法表

| method | params | data 关键字段 |
|---|---|---|
| `search` | `pattern`(必), `path`, `context`=2, `limit`=50, `ignore_case`, `whole_word`, `extensions`=[] | `matches[{file,line,col,text,symbol?,context_before,context_after}]`, `total`, `files_searched`, `elapsed_ms` |
| `symbols` | `name`(必), `path`, `kind`, `limit`=50, `partial`=true | `matches[{file,kind,name,line,line_end,parent?,text}]`, `total`, `files_searched` |
| `def` | `name`(必), `path`, `limit`?=50, `substring_fallback`?=true | **两级匹配**：exact 优先——候选全部来自定义正则且符号名完全相等（`match_mode:"exact"`），杜绝子串命中稀释与 import/使用行混入；exact 无命中时回退子串匹配并标 `match_mode:"substring"`（候选需核对）。`substring_fallback:false` 关闭回退。排序：精确名 > class/struct/interface/trait > enum/type > function > method > 行号 |
| `ref` | `name`(必), `path`, `limit`=100 | 同 `search`（全词匹配的引用位置） |
| `read` | `file`(必), `path`, `outline`=false | `file`, `lines{start,end}`, `total_lines`, `content`, `language?`, `symbol?`, `symbols?`(human/大纲时), `truncated?` |
| `context` | `file`(必), `line`(必), `radius`=5, `path` | **metadata 前置、`content` 殿后**：`file`, `line`, `language?`, `containing_symbol?`, `imports?`, `total_lines?`, `window_start?`, `truncated?`, `content`（含 Rust 在内的各语言均返回 `containing_symbol`） |
| `tree` | `path`, `depth`=3 | `root`, `tree[{name,type:"dir"｜"file",children?,lang?,size?}]`, `project_root?` |
| `health` | `{}` | `version`, `methods`, `root`, `boundary` |

## 3. `file` 引用语法（`read` / `context`）

| 写法 | 含义 |
|---|---|
| `src/app.ts` | 整个文件 |
| `src/app.ts:10-50` | 行范围（`read`） |
| `src/app.ts:42` | 单行（`context`；`read` 也接受） |
| `src/app.ts#parseConfig` | 某符号的完整实现（**优先用它替代整文件读取**） |
| `src/app.ts#` | 空符号名 → 结构化错误 |

文件名本身含 `#` 或 `:` 时，若整体路径存在则按普通路径处理。

## 4. `path` 的范围

- 指向**项目根**（默认）：全项目检索。
- 指向**单个文件**：只搜该文件（`files_searched=1`）。
- 指向**root 内的子目录**：只搜该子树。
- 输出中的 `file` 始终相对项目根；越界目录不会被当作范围（防误扫整盘）。
- `rpc --root` 下，`path` 逃出项目根 → `ok:false, "Path '...' escapes project root"`。

## 5. 资源上限与既定行为

| 项 | 上限 / 行为 |
|---|---|
| 单次结果数 | 5000（`limit` 会被钳制到该值） |
| 上下文行数 | 200 |
| 目录树深度 | 16 |
| 搜索模式长度 | 256 字符 |
| **单次返回正文** | **200000 字符**；超出即截断并置 `truncated:true` |
| 单文件读取策略 | ≤5MB 整读；>5MB 流式（无范围时只返回头部预览并置 `truncated:true`） |
| 二进制文件 | 无 BOM 且头部含 NUL → `ok:false, "Binary file (N bytes); not text"`（UTF-16 BOM 视为文本） |
| 病态正则 | 嵌套量词（如 `(a+)+`）在无 ripgrep 的回退引擎上返回 `ok:false, "... catastrophic backtracking ..."` |
| 进程管理 | rpc 进程退出即结束；调用方提前关管道属正常结束 |
| 默认忽略 | `.git`、`node_modules`、`dist`/`build`、`target`/`out`、`__pycache__`、虚拟环境、IDE 目录、`.repoctx`（索引产物，避免污染检索）；项目可用 `.aisearchignore` 追加（精确名、`*.ext`、含 `/` 的相对路径前缀） |

## 6. 双实现一致性

Python（`<SKILL_DIR>/scripts/aisearch/`）与 Node（`<SKILL_DIR>/scripts/aisearch-js/`）CLI 与 JSON 输出逐字段一致；rpc 的响应为同一紧凑格式（无空格），除 `elapsed_ms` 等耗时字段外**逐字节一致**。

已知差异仅一处：纯 JS 回退引擎的 `\w` / `\b` 为 **ASCII 语义**，而 Python `re` 与 `rg` 为 **Unicode 语义**；因此含中文标识符的模式（如 `def \w+_\w+` 命中 `def 函数_gbk`）在**未安装 ripgrep** 时两版结果可能不同。需要严格一致时用显式字符类（如 `[A-Za-z0-9_]+`）或安装 `rg`。

编码行为：`read`/`context` 自动探测 BOM/UTF-8/GB18030/UTF-16；`search`/`symbols` 的**正则回退路径**同样探测（GB18030 文件里的中文可搜）。装了 ripgrep 时两边都走 rg——rg 按 UTF-8 处理，非 UTF-8 文件里的中文模式可能搜不到（此为 rg 限制，两版一致）。

## 7. 错误形态与处置

| 错误文本 | 处置 |
|---|---|
| `Binary file (N bytes); not text` | 换文本源文件，勿重试 |
| `Path '...' escapes project root` | 用项目根内路径 |
| `catastrophic backtracking` | 简化量词（`(a+)+` → `a+`）或安装 ripgrep |
| `Search pattern too long (N chars > 256)` | 精简模式（≤256 字符） |
| `Missing 'pattern'`（rpc 层）/ `Empty search pattern`（引擎层） | pattern 不可为空/纯空白 |
| `Missing 'file' and 'line'` / `Missing 'name'` / `Missing 'file'` | 补齐必填参数 |
| `Empty symbol name after '#' in file reference: ...` | 用完整的 `file#符号` 写法，`#` 后不能为空 |
| `Symbol '...' is ambiguous (...)` | 用完全限定名，或先 `symbols` 看候选 |
| `Symbol '...' not found` | 先 `symbols` 模糊查，再 `read` |
| `Invalid line range: A > B` / `Start line N beyond end of file (M lines)` | 校正行号 |
