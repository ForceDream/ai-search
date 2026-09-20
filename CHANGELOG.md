# aisearch 更新日志

## [1.0.1] - 2026-09-20 · 缺陷修复

缺陷修复版：修掉 6 个实测确认的逻辑错误 + 4 处文档不一致，未新增功能。

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

### 文档改进（已入库，随下次发版生效）

- `SKILL.md` 顶部新增「什么时候用我（触发词）」与最短上手命令。
- 新增「常见问题（FAQ）」，含**错误信息 → 怎么办**对照表（`Missing 'pattern'`、`escapes project root`、`Binary file; not text`、`truncated: true` 等）。
