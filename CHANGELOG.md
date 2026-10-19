# aisearch 更新日志

## [1.1.4] - 2026-10-19 · 功能版（def/symbols 分页与截断披露）

### 新增

- `def` / `symbols` 支持 `offset` 分页（与 search/ref 同口径）：结果被 `limit` 截断时响应带 `truncated:true` 与 `next_offset`，带 `offset` 续读。此前两者截断完全静默——`total` 被 limit 截断且无任何披露字段，大仓/多树语料上字典序后段的定义不可见
- `def` 分页按扫描序翻窗、排序只作用于页内：若先全局排序再切窗，每页收集池长度不同导致窗口错位；`offset=0` 的返回集合与页内排序均与旧版一致
- `--format text` 渲染器为 def/symbols 块头输出 `next_offset` / `truncated`

### 文档

- SKILL.md / protocol.md 明示：`def`/`symbols` 默认 `limit=50`（可手动调大，钳制上限 5000；`ref` 默认 100）、`total` 是本次返回条数不是存在总数（`total:50` 读作“≥50”）、截断披露字段语义与翻页方法；FAQ 增加“只返回 50 条”条目

## [1.1.3] - 2026-10-16 · 清理版（死代码）

### 清理

- 删除零引用的错误常量 `PyTypeError` / `PyOSError` / `PyPermissionError`（`aisearch-js/src/util.mjs`）
- 删除未使用导入：`engine.py` 的 `find_containing_symbol`、`symbols.py` 的 `detect_lang`
- 删除 `Match.symbol` 残留字段（从未被赋值，响应中 `symbol` 分支不可达；Python / Node 同步）

## [1.1.2] - 2026-10-13 · 功能版（写入定位）

### 新增

- `anchor` 方法：`{"file":"x.py#符号"}` / `{"file":"x.py:10-50"}` / `{"file":"x.py","line":42}` → `lines{start,end}` + `sha` + `head`/`tail`。写前取一次记下，写后同参再取一次：`start`/`end` 一致且 `sha` 按预期变化 = 落点正确；`start`/`end` 漂移 = 定位偏了。`sha` 与 model-switch-or-resume 的块 sha 同口径，可互相对拍
- `read` 新增 `line_numbers:true`：正文每行带行号前缀（从 `lines.start` 起算），`old_string` 从带行号正文原样摘，消灭"数行号"误差源；默认关闭保持省 token
- 文本输出模式（`--format text`）支持 `anchor` 块与 `read` 的 `(带行号)` 标记

### 文档

- SKILL.md 新增「写入定位（改代码前必读）」节：取锚点 → 按行号取正文 → 写后复核锚点三步，以及**锚点刷新纪律**（同文件连续编辑时每次 Edit 后重取 anchor，治「串行」）

## [1.1.1] - 2026-10-13 · 修复版（边界 / 过滤 / 健壮性）

### 修复

- **`read` / `context` 的根锚点**：`rpc --root` 锁定时不再向上找项目标记目录。此前 `--root` 的上级目录带 `.git` 等标记时，root 内的相对路径会被解析到上层而报 `File not found`，落在「上级目录与 root 之间」的绝对路径还能绕过越权校验读到 root 外文件
- **回退引擎（无 ripgrep）无体积上限**：仓内有 GB 级文件时 `search` 直接 `MemoryError` 整个查询失败；现在跳过 >32MB 的文件并在响应里给 `skipped`
- **回退引擎把二进制当文本搜**：头部含 NUL 的文件（模型/压缩包等）此前会被读取并计入 `files_searched`，现在跳过并计入 `skipped`（rg 路径由 rg 自行跳过）

### 对齐

- 回退引擎的过滤口径与 rg 对齐：**隐藏文件/目录（点开头）默认不搜**；`.gitignore` 规则按现有语义并入（精确名 / `*.ext` / 相对路径前缀，不支持 `**` 与 `!`）。此前只认 `DEFAULT_IGNORE` + `.aisearchignore`，装不装 rg 会搜出不同集合
- SKILL.md 的「与 Grep 分工」表改为用本工具 `search` 做定位（原文指引系统 grep，与本仓库 repo-policy 硬约束冲突）；补记默认不搜的路径与 `skipped` 语义

## [1.1.0] - 2026-10-10 · 功能版（输出层 token 优化）

### 新增

- `--format text` 纯文本输出模式（`aisearch_rpc.py` 包装层，引擎 JSON 协议不变）：grep 风格 `file:line:text`（上下文行 `file:line-text`，行号按窗口推算），免 JSON 转义，read/search 类输出 token 约省一半；Node 实现经 `--tool` 同样适用
- `offset` 分页（search / ref）：结果池有剩余时响应带 `next_offset`，带它续读翻页；缺席表示本池已尽（rg 路径的池受 `--max-count` 每文件 3×limit 影响）
- `count_only`（search / ref / symbols / def）：丢弃 `matches` 只留统计字段（def 保留 match_mode），定位型查询不回正文

### 修复

- 无 ripgrep 的回退引擎推不出 `next_offset`（只收集到窗口末尾，`has_more` 恒假）：改为多收 1 条前瞻判定，双实现同步

### 文档

- SKILL.md 新增「Token 省法」节；protocol.md 补文本输出格式约定与分页游标口径
- `health.version` 由 0.1.0 对齐 1.1.0（双实现同步）

## [1.0.4] - 2026-09-22 · 文档修正

### 文档修正

- 修复文档内表述不准确和内容模糊的内容。
- FAQ「搜不到中文标识符」条目与 1.0.1 的修复相矛盾，改为如实描述 —— 搜索与读取统一按探测到的编码（UTF-8 / GB18030）处理。

## [1.0.3] - 2026-09-22 · 中等问题修复（性能与健壮性）

### 性能

- **`def` 找不到时全仓扫两遍 → 单遍**：旧实现先跑 exact 遍，无命中再跑 substring 遍（目录枚举、文件读取、符号抽取全部做两次）。改为一次遍历同时收两类候选，早停条件与原 exact 遍严格一致（exact 满即停），substring 候选仅在 **exact 仍为空** 时收集（避免命中场景白付子串判定成本）。**实测 ZCode-main（4200 文件）：`def` 未命中 13.72s → 7.41s（−46%）**；命中与 `symbols` 场景在噪声内持平（±6%）。
- **`_calc_ranges`：O(符号数 × 文件字符数) → 预计算 + 单遍**：旧实现对每个符号从起始行重扫一遍**字符**（大文件上 10^9 级比较）。改为一次预计算括号净和前缀（`depth`）与"首个含 `{` 行"（`next_open`），再用**活跃层扫描**一次行遍历闭合所有符号。语义与原实现严格等价（结束行 = 起始行之后首个使"从起始行起的净和 ≤ 0"的行且须已出现 `{`），已用边界语料 + 大仓逐字段对拍验证。

### 正确性

- **rg 多命中文件的 `context_before` 恒空 / 前文错挂**：旧实现用"消息顺序 + 布尔标志"归属 context，标志只在 `begin`/`end` 复位 → 同一文件第 2 个 match 起 `context_before` 为空，其前文被错挂到上一个 match 的 `context_after`。改为按 rg 消息自带的 `line_number` 取窗口（`[line-k, line-1]` / `[line+1, line+k]`），天然处理相邻 match 窗口重叠。

- **`col` 列号口径不统一（双实现分叉）**：`rg` 的 `submatches[].start` 是**字节**偏移、Node 回退引擎的 `m.index` 是 **UTF-16 码元**、Python 回退引擎的 `m.start()` 是**码点** —— 同一行含中文或 emoji 时三处给出不同列号（服务器语料实测：含 `🧹` 的行 Python `21` vs Node `22`）。统一为**码点**（0 基），并在 `references/protocol.md` 写明口径。三条路径（Python rg / Node rg / Node 回退）同步对齐。

### 健壮性

- **rpc 1MB 行上限后置**：旧实现（Python 文本迭代 / Node `readline`）先把整行读进内存再判上限，一行几百 MB 的无换行输入足以打爆内存。改为按块读**字节流**：累积超限且未见换行即进入丢弃模式直到下一个换行，内存上界 = 上限 + 一个块；长度口径统一为**字节**（与常量名一致）。已验证超长行报错、丢弃后会话正常复位、两侧行为一致。
- 附带清理：`rpc.mjs` 移除不再使用的 `readline` 导入；`find_definition` 与 `search_symbols` 的扫描范围解析收敛到 `_resolve_scan_scope` 一处（与 `engine.py` 同构）。

## [1.0.2] - 2026-09-22 · 缺陷修复（双实现漂移专项）

### 逻辑错误修复

- **`ref` 的符号名被当正则**：`find_references` 走 rg 路径时原样传 `-e`，符号名里的 `$ . ( [` 被当元字符（TS 符号名含 `$` 时结果直接错）；回退路径却一直有转义——"装没装 rg"结果不同。新增 `search_text(..., literal=True)`：rg 路径先 `re.escape` 再传、回退路径转义只做一次（避免与 whole_word 叠加时双重转义）。Python / Node 同步。
- **`whole_word` 回退路径对 `$` 前缀符号恒 0 命中**：`\b...\b` 对以非词字符开头的 pattern 失配（`空格$` 两侧皆非词、无边界），而 rg 的 `-w` 是"不嵌入更长单词"语义、能命中。改用 lookaround `(?<!\w)...(?!\w)` 模拟 rg `-w`。实测 `ref "$query"` 修复后命中 2 处（修复前 0）。Python / Node 同步。
- **Node 版 Rust `impl` 符号名截成单字母**：`symbols.mjs` 的 impl 正则还是 `symbols.py` 注释里点名的旧写法（靠回溯，`impl Config` 抽成 `"g"`、`impl fmt::Display for Config` 抽成 `"d"`），`sym/def` 查不到 Rust impl。同步 Python 的锚定写法后两版 outline 逐字段一致。
- **Windows 上 `.aisearchignore` 含 `/` 的规则在 Node 版静默失效**：`should_ignore` 未做反斜杠归一化、目录剪枝不传相对路径（Python 版两者都有，注释里写了根因）。实测 `search generated_fn`：Python 0 命中、Node 照样搜进被忽略目录。同步后一致（0 命中、`files_searched` 相同）。
- **Windows 盘符大小写导致 root 输出分叉**（对拍脚本发现）：`path.resolve` 不归一盘符（`--root d:\...` 时 Python 输出 `D:\`、JS 输出 `d:\`），health/tree/错误消息全受影响。JS 侧新增 `abs_path()`（resolve + 盘符大写，对齐 `Path.resolve()`）统一替换。

### 配套

- 对拍脚本落位 `D:\llm\eval\aisearch-parity-check.py`（不随技能分发）：17 条默认用例覆盖 8 个方法 + 历史踩坑点（元字符 ref / `$` 前缀 / whole_word / ignore / 子串回退 / outline / 行范围 / 符号读取），任何一版改动后重跑即可防再次漂移。

## [1.0.1] - 2026-09-20 · 缺陷修复

### 逻辑错误修复

- **`file#` 空符号名返回整个文件**：`read {"file":"foo.py#"}` 本应报错，却回退成整文件读取 —— AI 误传 `foo.py#` 会把整个文件拉进上下文，直接违背"最省 token"的设计前提。现在返回结构化错误 `Empty symbol name after '#'`。
- **CLI `ctx` 文本渲染行号错位**：窗口被文件尾截断时，起点用 `line - len(content)/2` 估算导致偏移（实测 `ctx src/orders.py:20`，真实窗口 15–21 显示成 17–23）。改用数据里本就有的 `window_start`，Python / Node 双实现同步修。
- **中文 GBK 文件"搜"出乱码**：搜索路径硬编码 `utf-8`，而读取路径会探测 `GB18030`，同一文件"读"正常、"搜"乱码。编码参数化（`_iter_lines(path, encoding)`）后统一。
- **Windows 绝对路径下 `ctx` 报 `Invalid line number`**：盘符冒号被当成行号分隔符（`C:\...`）。已加盘符特判。
- **装了 ripgrep 的机器上双实现可能分叉**：Python 走 `rg`、Node 无 rg 路径，`files_searched` 与忽略规则可能不同。已在 `references/protocol.md` 记录已知差异与规避方式（显式字符类 / 安装 rg）。
- **双实现一致性措辞过宽**：原文写"逐字段一致"易被读成字节一致。已精确为「CLI 与 JSON **逐字段**一致；rpc 为紧凑格式，除 `elapsed_ms` 外**逐字节**一致」。

### 文档修正

- `SKILL.md`、`references/examples.md`：示例用了 PowerShell 的 `<` 输入重定向，**实测无法执行**（`ParserError: "<"运算符保留供将来使用`）→ 改为 `Get-Content ... | python ... --stdin`，并注明「PowerShell 没有 `<` 输入重定向」。
- `references/protocol.md`：三处错误文本与实现对齐 —— `Missing 'pattern'`、`Search pattern too long (N chars > 256)`、`Start line N beyond end of file (M lines)`；`escapes` 错误的大小写统一为 `Path`。
- `references/examples.md`：search 示例只列 1 条 match 却标 `total: 3` → 标注省略。
- `SKILL.md`：补充 `find_project_root` 会向上找 marker 的提示（`--root` 传子目录时 root 可能被解析到更高层，导致 escapes 误判）。

### 文档改进

- `SKILL.md` 顶部新增「什么时候用我（触发词）」与最短上手命令。
- 新增「常见问题（FAQ）」，含**错误信息 → 怎么办**对照表（`Missing 'pattern'`、`escapes project root`、`Binary file; not text`、`truncated: true` 等）。

### 代码修正

- **`context` 输出字段重排**：metadata（`file` / `line` / `language` / `containing_symbol` / `imports` / `total_lines` / `window_start` / `truncated`）前置、大体积的 `content` 殿后。此前 `content` 排在 `containing_symbol` 之前，Agent 只解析 JSON 前段就误判「Rust 没有 containing_symbol」（实测报告曾误报此缺口，实际 Rust 一直正常返回）。Python / Node 双实现同步。
