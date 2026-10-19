---
name: aisearch
name_en: aisearch - Precise Code Search
name_zh: aisearch 精确代码检索
description: Precise, token-efficient code retrieval that replaces grep -rn and LSP for navigation queries. Finds where a symbol (function, class, method, type) is defined, who references it, reads a function's full implementation, shows which function a line belongs to, and lists project structure. Returns structured JSON with only the needed fragments. Use when asked to find definitions, find references, read a specific function, locate a line's context, or get a project tree without loading whole files.
description_en: Precise, token-efficient code retrieval that replaces grep -rn and LSP for navigation queries. Finds where a symbol (function, class, method, type) is defined, who references it, reads a function's full implementation, shows which function a line belongs to, and lists project structure. Returns structured JSON with only the needed fragments. Use when asked to find definitions, find references, read a specific function, locate a line's context, or get a project tree without loading whole files.
description_zh: 精确定位与阅读代码的检索工具，替代 grep -rn 与 LSP。查出某个符号（函数、类、方法、类型）定义在哪、谁引用了它、读取函数完整实现、查看某一行所属的函数及其上下文、掌握项目目录结构。返回结构化 JSON 且只取所需片段，token 消耗比整文件读取低数倍。触发词：查定义、找引用、读这个函数、这行在哪个函数里、项目结构、省 token 的代码检索。
argument-hint: Name a symbol or paste a code location to search, or point at a project root to explore
argument-hint-en: Name a symbol or paste a code location to search, or point at a project root to explore
argument-hint-zh: 输入符号名或代码位置进行检索，或指定项目根目录进行浏览
user-invocable: true
---

# aisearch

零依赖代码检索工具，自带 Python 与 Node 两套实现（CLI 行为与 JSON 协议逐字段一致）。

> **⚠️ Agent 调用铁律：一律走 rpc —— `python "<SKILL_DIR>/scripts/aisearch_rpc.py" --root <项目根> <method> '<params>'`。**
> **禁止**用 `python -m aisearch` / `node aisearch.mjs` 这类 CLI 直调（CLI 每个请求都重付一次进程启动；rpc 单进程常驻、可批量）。
> 默认（不带 `--tool`）就是 **Python 实现**；`--tool` 切 Node 仅在无 Python 环境的机器上使用。CLI 形态仅供人类在终端手动使用。
>
> 注意：rpc 常驻省的是**进程启动**；`search` / `def` / `ref` / `symbols` 每次仍是**全量扫描**（O(语料)，无索引缓存，大项目请改用 repo-context）；`read` / `context` / `anchor` / `tree` 只碰单文件，几乎零成本。

只要机器上有 **Python >= 3.9 或 Node** 之一即可，无需安装、不监听端口。

## 脚本路径（两种安装方式）

命令里的 `<SKILL_DIR>` 指**本技能目录**，取决于安装方式：

- SkillHub / 放进 skills 目录：`~/.codebuddy/skills/aisearch`（发布版写作 `${CODEBUDDY_SKILL_DIR}`）
- 插件安装：`<插件根>/skills/aisearch`，插件根用 `${CODEBUDDY_PLUGIN_ROOT}` 取，或用 `codebuddy plugin list` 查

## 什么时候用我（触发词）

**触发词**：查定义 / 找引用 / 谁调用了它 / 读这个函数 / 这行在哪个函数里 / 项目目录结构 / grep 替代 / LSP 替代 / 省 token 的代码检索。

## 与 Grep / repo-context 的分工（大项目必读）

| 任务 | 用什么 | 为什么 |
|---|---|---|
| 纯文本 / 正则定位 | **本工具** `search`（`--format text` 省 token、`count_only` 只要行号、`offset` 翻页） | 结构化定位（`file`/`line`/`col`/符号名）比裸 grep 可复核；单进程常驻、可批量 `--stdin` |
| 符号问答：定义在哪 / **谁调用（callers）** / **影响面（impact）** / **枢纽榜（hubs）** / **按任务关键词找码（for）** / 歧义展开 | **repo-context**（持久索引） | `index` 一次秒级，之后每条查询毫秒级；callers / impact / hubs 是本工具没有的能力 |
| 读函数体 / 行归属（**含 Rust**，返回 `containing_symbol`）/ 批量精读 | **本工具** `read file#符号` / `context` | O(单文件)；输出 metadata 前置、`content` 殿后 |
| 大文件（>200k 字符） | **本工具** 行范围读取 | 有截断保护，不会把大文件全量拉进上下文 |
| 结构化符号感知搜索 | 本工具 `search` / `symbols` | 输出结构化 JSON 与符号类型；大项目首轮定位交给 repo-context 的 `for` / `hubs` |

一句话：**先定位（本工具 `search` 或 repo-context），再精读（`read file#符号` / `context`）**。若本机没有本工具（或需语义级符号导航），才退回系统 grep，并说明原因。

## 调用

`<SKILL_DIR>` 表示本 `SKILL.md` 所在目录的绝对路径；加载技能时系统会给出该技能的 Base directory，将其代入即可。

```bash
# 单次请求：内部拉起一次 rpc 会话
python "<SKILL_DIR>/scripts/aisearch_rpc.py" --root <项目根> def '{"name":"apply_discount"}'

# 批量：一次会话发多行请求（每行一个完整请求对象）
python "<SKILL_DIR>/scripts/aisearch_rpc.py" --root <项目根> --stdin < "<SKILL_DIR>/assets/requests/basic.jsonl"

# 切到 Node 实现（Windows 反斜杠路径可直接传）
python "<SKILL_DIR>/scripts/aisearch_rpc.py" --root <项目根> --tool "node <SKILL_DIR>/scripts/aisearch-js/bin/aisearch.mjs" health '{}'
```

PowerShell 没有 `<` 输入重定向，批量请求用管道：

```powershell
Get-Content "<SKILL_DIR>\assets\requests\basic.jsonl" | python "<SKILL_DIR>\scripts\aisearch_rpc.py" --root <项目根> --stdin
```

- `--pretty` 缩进输出，便于阅读；默认每行一个紧凑 JSON。
- `--format text` 纯文本渲染（默认 json）：grep 风格 `file:line:text`，免 JSON 转义，read/search 类输出 token 约省一半；Agent 输出量大时优先用它。
- 技能目录含空格时，`--tool` 中的可执行文件路径本身要再包一层引号。
- 命令探测顺序：`--tool` > 环境变量 `AISEARCH_CMD` > PATH 上的 `aisearch`（若你已 pip 装过）> 本技能自带的 Python 实现。
- 复杂 params 建议走 `--stdin`，避免各 shell 的引号规则差异。

## Token 省法（Agent 必读）

1. **能批量就批量**：一次 `--stdin` 会话发多个请求（每行一个 JSON），进程启动与 hook 往返只付一次。
2. **按行段 / 按符号读**：`file:10-50` 行段、`file#符号` 完整实现，不要整文件读。
3. **定位型查询关掉正文**：只要行号不要代码时用 `count_only:true`（search/ref/symbols/def），或 `search` 传 `context:0`（默认带 2 行上下文）。
4. **大结果集翻页**：响应带 `next_offset` 时，把它的值当 `offset` 续读，不要盲目拉大 `limit`。
5. **输出量大用 `--format text`**：免 JSON 转义膨胀（见「调用」节）。
6. **不重复读**：同一文件/行段本轮会话已读过就不再发起相同请求；重读前先确认文件是否真的变过。

## 方法

| method | params | 用途 |
|---|---|---|
| `search` | `pattern`(必), `path?, context?, limit?, ignore_case?, whole_word?, extensions?, offset?=0, count_only?` | 文本搜索（替代 grep）；`offset` 分页，池里还有剩余时响应带 `next_offset`（继续带它当 `offset` 翻页）；`count_only:true` 只回统计不回正文 |
| `symbols` | `name`(必), `path?, kind?, limit?, partial?, offset?=0, count_only?` | 符号搜索（子串匹配）；`offset` 分页，池里还有剩余时响应带 `next_offset` + `truncated:true` |
| `def` | `name`(必), `path?, limit?, substring_fallback?=true, offset?=0, count_only?` | 查找定义：exact 优先，候选全部来自定义正则（`match_mode:"exact"`）；无命中回退子串并标 `match_mode:"substring"`（候选需核对；`substring_fallback:false` 可关闭）；`offset` 分页（按扫描序翻页、排序只作用于页内），截断时带 `next_offset` + `truncated:true` |
| `ref` | `name`(必), `path?, limit?, offset?=0, count_only?` | 查找引用（全词匹配的使用位置，支持 `offset` 分页） |
| `read` | `file`(必), `path?, outline?, line_numbers?` | 读文件（整文件 / 行范围 / 按符号）；`line_numbers:true` 时正文每行带行号前缀（写入定位专用，默认关闭省 token） |
| `context` | `file`(必), `line`(必), `radius?, path?` | 某行的语义上下文（所属函数、导入等） |
| `anchor` | `file`(必), `symbol?` 或 `line?`, `path?` | 写入定位锚点：`lines{start,end}` + `sha` + `head`/`tail`；写前取一次、写后同参复核（见「写入定位」节） |
| `tree` | `path?, depth?` | 项目目录树 |
| `health` | `{}` | 版本 / 方法列表 / 生效根与边界 |

响应统一为 `{"id":N,"ok":true,"data":{...}}` 或 `{"id":N,"ok":false,"error":"..."}`；非法请求（坏 JSON、未知方法、非法参数）返回结构化错误，进程不崩溃。

## `file` 引用语法（`read` / `context` / `anchor`）

| 写法 | 含义 |
|---|---|
| `src/app.ts` | 整个文件 |
| `src/app.ts:10-50` | 行范围 |
| `src/app.ts#parseConfig` | 某个符号的完整实现（**最省 token 的读法，优先用它替代整文件读取**） |
| `src/app.ts:42` | 单行（`context` 也接受该写法） |

## 写入定位（改代码前必读）

「定位不准、写入串行」的根因是**数行号**与**锚点过期**。用本工具把定位变成可校验的三步：

1. **写前取锚点**：`anchor {"file":"src/app.ts#parseConfig"}`（也支持 `file:10-50` 与 `{"file":"…","line":42}`）
   → 返回 `lines{start,end}`、`sha`、`head`/`tail`（范围首末行）。**记下这三样。**
2. **写时按行号取正文**：`read {"file":"src/app.ts:10-50","line_numbers":true}` —— 正文每行带行号前缀，
   `old_string` 从带行号的正文里原样摘，不再靠数行（CRLF 文件注意行尾、JSON 转义注意还原）。
3. **写后复核锚点**：同参再跑一次 `anchor` ——
   `start`/`end` 与预期一致且 `sha` 按预期变化 = 落点正确；`start`/`end` 漂了 = 定位偏了，先修再继续。

**锚点刷新纪律（治「串行」）**：同一文件连续多次编辑时，**每次 Edit 之后重新取一次 anchor**，
把新的 `start`/`end` 作为下一次的基准——行号在第一次编辑后就可能已经漂了，不刷新就会叠加错位。
`anchor` 的 `sha` 与 model-switch-or-resume 的块 sha 同口径，两边可以对拍。

## `path` 的范围

`path` 可指向：项目根（默认）、单个文件（只搜该文件）、根内子目录（只搜该子树）。输出路径始终相对项目根；`rpc --root` 锁定时越界路径被拒绝（`ok:false, "... escapes project root"`）。

入口脚本会把 rpc 子进程的工作目录设为 `--root`，因此**相对 `path` 一律相对项目根解析**，与你在哪个目录敲命令无关。

## 资源上限与既定行为

- 单次返回正文上限 **200000 字符**，超出即截断并置 `truncated: true` —— 此时改用 `file:行范围` 或 `file#符号`，不要直接读整文件。
- 单次结果 ≤ 5000 条、上下文行数 ≤ 200、目录树深度 ≤ 16、搜索模式 ≤ 256 字符。
- **`def`/`symbols` 默认 `limit=50`**（可手动调大，钳制上限 5000；`ref` 默认 100）。结果被 limit 截断时响应带 `truncated:true` 与 `next_offset`——把 `next_offset` 当 `offset` 续读，或显式调大 `limit`；**`total` 是本次返回条数，不是存在总数**（`total:50` 应读作“≥50”）。
- 文本文件 > 5MB 走流式：无范围时只返回头部预览并置 `truncated: true`。
- 无 BOM 且含 NUL 的文件判为二进制，返回 `ok:false, "Binary file (...); not text"` —— **不要重试**，改用文本源文件。
- **默认不搜**：隐藏文件/目录（点开头）与 `.gitignore` 列出的路径 —— 与 rg 默认一致；结果里的 `skipped` 是被跳过的文件数。需要搜隐藏目录时直接把 `path` 指到它。
- 无 ripgrep 的回退引擎跳过 > 32MB 的文件（rg 流式无此限制），并在响应里给 `skipped`。

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
- `def`/`symbols` 只返回 50 条？→ 默认 `limit=50` 且按扫描（字典）序截断，字典序靠前的结果会挤占名额——大仓/多树语料上后段树的定义完全不可见。响应带 `truncated:true` 时把 `next_offset` 当 `offset` 续读或调大 `limit`（≤5000）；要“全局共几处”的权威计数用 grep/repo-context。
- 搜不到中文标识符？→ 搜索与读取统一按探测到的编码处理（UTF-8 / GB18030），中文标识符可正常搜到。
- 比 `grep` 省在哪？→ 只回结构化片段（`file`/`line`/`line_end`/`text`）而非全部命中行，高频词场景输出体积小一个量级。
- 需要跨机器/跨语言一致行为？→ Python 与 Node 两套实现**逐字段一致**，仅 rpc 的 `elapsed_ms` 与空白不同。
- rpc 常驻后 `search` 还是慢？→ 常驻省的只是进程启动；检索类每次都是全量扫描。大项目改用 repo-context（持久索引）。

## 参考（按需加载）

- `references/protocol.md`：完整协议、各方法返回字段、错误文本与处置、双实现已知差异。
- `references/examples.md`：真实请求/响应样例与解读。
- `assets/demo/`：配套的极小语料（Python + TypeScript）；`assets/requests/basic.jsonl`：可直接重放的示例请求。
