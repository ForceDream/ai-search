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

### 文本输出模式（`aisearch_rpc.py --format text`）

包装层渲染（引擎 JSON 协议不变，Node 实现经 `--tool` 同样适用）：grep 风格纯文本，
免 JSON 转义（`\d` 不再变 `\\d`、换行不再变 `\n`），read/search 类输出约省一半 token。

约定：`file:line:text` 命中行、`file:line-text` 上下文行、块间空行分隔、
错误为 `[id] METHOD ERROR: 消息`；`next_offset` / `match_mode` / `truncated` 在块头。

## 2. 方法表

| method | params | data 关键字段 |
|---|---|---|
| `search` | `pattern`(必), `path`, `context`=2, `limit`=50, `ignore_case`, `whole_word`, `extensions`=[], `offset`=0, `count_only` | `matches[{file,line,col,text,symbol?,context_before,context_after}]`, `total`, `files_searched`, `elapsed_ms`, `next_offset?`, `skipped?`；`col` 为行内匹配起点的**码点**偏移（0 基，非字节、非 UTF-16 码元）；`offset` 分页，池里有剩余时回 `next_offset`（缺席 = 本池已尽）；`count_only:true` 只回统计字段 |
| `symbols` | `name`(必), `path`, `kind`, `limit`=50, `partial`=true, `count_only` | `matches[{file,kind,name,line,line_end,parent?,text}]`, `total`, `files_searched`, `skipped?` |
| `def` | `name`(必), `path`, `limit`?=50, `substring_fallback`?=true, `count_only` | **两级匹配**：exact 优先——候选全部来自定义正则且符号名完全相等（`match_mode:"exact"`），杜绝子串命中稀释与 import/使用行混入；exact 无命中时回退子串匹配并标 `match_mode:"substring"`（候选需核对）。`substring_fallback:false` 关闭回退。排序：精确名 > class/struct/interface/trait > enum/type > function > method > 行号 |
| `ref` | `name`(必), `path`, `limit`=100, `offset`=0, `count_only` | 同 `search`（全词匹配的引用位置，含 `offset` 分页与 `next_offset`） |
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
| **回退引擎单文件上限** | **32 MB**：无 rg 时跳过更大的文件并计入 `skipped`（rg 路径流式读取，无此上限） |
| **二进制文件（搜索）** | 头部含 NUL → 回退引擎跳过并计入 `skipped`；rg 路径由 rg 自行跳过 |
| **隐藏路径** | 点开头的文件/目录默认不搜（与 rg 默认一致）；把 `path` 直接指到该目录仍可搜 |
| **`.gitignore`** | rg 路径由 rg 尊重；回退路径按同名近似规则跳过（精确名 / `*.ext` / 相对路径前缀，不支持 `**` 与 `!` 否定） |
| **`read`/`context` 的根** | `rpc --root` 锁定时以该 root 为锚点（相对引用与越权校验都按它算，不再向上找项目标记目录）；CLI（boundary=system）保持原语义 |
| 单文件读取策略 | ≤5MB 整读；>5MB 流式（无范围时只返回头部预览并置 `truncated:true`） |
| 二进制文件 | 无 BOM 且头部含 NUL → `ok:false, "Binary file (N bytes); not text"`（UTF-16 BOM 视为文本） |
| 病态正则 | 嵌套量词（如 `(a+)+`）在无 ripgrep 的回退引擎上返回 `ok:false, "... catastrophic backtracking ..."` |
| 进程管理 | rpc 进程退出即结束；调用方提前关管道属正常结束 |
| 默认忽略 | `.git`、`node_modules`、`dist`/`build`、`target`/`out`、`__pycache__`、虚拟环境、IDE 目录、`.repoctx`（索引产物，避免污染检索）；项目可用 `.aisearchignore` 追加（精确名、`*.ext`、含 `/` 的相对路径前缀） |

## 6. 双实现一致性

Python（`<SKILL_DIR>/scripts/aisearch/`）与 Node（`<SKILL_DIR>/scripts/aisearch-js/`）CLI 与 JSON 输出逐字段一致；rpc 的响应为同一紧凑格式（无空格），除 `elapsed_ms` 等耗时字段外**逐字节一致**。

已知差异仅一处：纯 JS 回退引擎的 `\w` / `\b` 为 **ASCII 语义**，而 Python `re` 与 `rg` 为 **Unicode 语义**；因此含中文标识符的模式（如 `def \w+_\w+` 命中 `def 函数_gbk`）在**未安装 ripgrep** 时两版结果可能不同。需要严格一致时用显式字符类（如 `[A-Za-z0-9_]+`）或安装 `rg`。

非字段级差异：坏正则的错误文案来自各自正则引擎的原生消息（`ok:false` 形态一致）；分页游标在装 rg 时基于 rg 全量池、未装 rg 时基于窗口 + 1 条前瞻，`next_offset` 的出现与否可能不同（装 rg 时更准）；`skipped` 只在回退引擎出现（rg 自己处理二进制与体积）。

装/不装 ripgrep 的**结果集**口径已对齐：隐藏路径与 `.gitignore` 规则在两条路径下都生效（回退路径按近似语义实现，见 §5）。

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
