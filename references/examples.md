# aisearch 样例（真实输出）

`<SKILL_DIR>` = 本技能目录（即 `SKILL.md` 所在目录，CodeBuddy 中也可写作 `${CODEBUDDY_SKILL_DIR}`）。

语料：`assets/demo/`（`src/orders.py`、`src/tool.ts`、`src/usage.ts`）。
把 `assets/demo` 复制到任意临时目录，用该目录作 `--root`，即可原样重放下面全部请求：

```powershell
Copy-Item -Recurse -Force "<SKILL_DIR>\assets\demo" "$env:TEMP\demo"
# PowerShell 没有 < 输入重定向，批量请求用管道：
Get-Content "<SKILL_DIR>\assets\requests\basic.jsonl" | python "<SKILL_DIR>\scripts\aisearch_rpc.py" --root "$env:TEMP\demo" --stdin
```

下面按请求逐条给出真实响应（Python 与 Node 双实现除 `elapsed_ms` 外逐字节一致；Windows 反斜杠路径在 JSON 中写作 `\\`，即单个 `\`）。

## 一次性会话里的 8 个请求

```json
{"id":1,"method":"health","params":{}}
{"id":2,"method":"symbols","params":{"name":"apply_discount"}}
{"id":3,"method":"def","params":{"name":"apply_discount"}}
{"id":4,"method":"ref","params":{"name":"apply_discount"}}
{"id":5,"method":"read","params":{"file":"src/orders.py#apply_discount"}}
{"id":6,"method":"context","params":{"file":"src/orders.py","line":20}}
{"id":7,"method":"search","params":{"pattern":"registry","limit":3,"extensions":[".ts"]}}
{"id":8,"method":"tree","params":{"depth":2}}
```

## 1）health —— 先确认边界

```json
{"id":1,"ok":true,"data":{"version":"0.1.0","methods":["search","symbols","def","ref","read","context","tree","health"],"root":"C:\\Users\\...\\demo","boundary":"root"}}
```

`boundary: "root"` = 传了 `--root`，越界路径会被拒绝。

## 2）symbols —— 不确定名字时先模糊查

```json
{"id":2,"ok":true,"data":{"matches":[{"kind":"function","name":"apply_discount","line":14,"line_end":16,"file":"src\\orders.py","text":"def apply_discount(order):"}],"total":1,"files_searched":3,"elapsed_ms":10.4}}
```

## 3）def —— 定义位置

```json
{"id":3,"ok":true,"data":{"matches":[{"kind":"function","name":"apply_discount","line":14,"line_end":16,"file":"src\\orders.py","text":"def apply_discount(order):"}],"total":1,"files_searched":3,"elapsed_ms":10.2,"match_mode":"exact"}}
```

拿到的 `file` + `line` 可直接喂给下面的 `read` 或 `context`。

`match_mode` 读法：`"exact"` = 候选全部是符号名完全相等的定义（放心用）；`"substring"` = 精确名无命中、已回退子串匹配（候选里可能有同名前缀的其它符号，需核对 `name` 字段）。传 `"substring_fallback": false` 可强制只做精确匹配。

## 4）ref —— 谁引用了它

```json
{"id":4,"ok":true,"data":{"matches":[{"file":"src\\orders.py","line":14,"col":4,"text":"def apply_discount(order):","context_before":["",""],"context_after":["    \"\"\"对订单总额打折，供 checkout 使用。\"\"\"","    return order.total() * (1 - DISCOUNT_RATE)"]},{"file":"src\\orders.py","line":21,"col":23,"text":"    return {\"payable\": apply_discount(order)}","context_before":["def checkout(order):","    \"\"\"结账入口：返回应付金额。\"\"\""]}],"total":2,"files_searched":3,"elapsed_ms":1.4}}
```

注意 `ref` 会连**定义行**一起返回（第 14 行），读结果时先剔除定义处，只把其余位置当"使用者"。

## 5）read `src/orders.py#apply_discount` —— 只取一个符号（最省 token）

```json
{"id":5,"ok":true,"data":{"file":"src\\orders.py","lines":{"start":14,"end":16},"total_lines":21,"content":"def apply_discount(order):\n    \"\"\"对订单总额打折，供 checkout 使用。\"\"\"\n    return order.total() * (1 - DISCOUNT_RATE)","language":"python","symbol":{"kind":"function","name":"apply_discount","line":14,"line_end":16}}}
```

## 6）context —— 某一行属于哪个函数

```json
{"id":6,"ok":true,"data":{"file":"src\\orders.py","line":20,"content":"…","language":"python","containing_symbol":{"kind":"function","name":"checkout","line":19,"line_end":21},"total_lines":21,"window_start":15}}
```

`containing_symbol` 就是"这行在哪个函数里"，比读整段文件定位更快。`window_start` 是 `content` 第一行对应的真实行号——CLI 文本渲染与调用方都按它定位，不要用"行数对半"去猜。

## 7）search —— 限定扩展名的文本搜索

```json
{"id":7,"ok":true,"data":{"matches":[{"file":"src\\tool.ts","line":19,"col":8,"text":"  const registry = new ToolRegistry();","context_before":["","export function buildDefaultRegistry(): ToolRegistry {"],"context_after":["  registry.register({ name: \"grep\", description: \"text search\" });","  return registry;"]}],"total":3,"files_searched":1,"elapsed_ms":0.6}}
```

`files_searched: 1` 说明 `extensions` 过滤生效（只搜了 ts）。此处仅展示第一条 match（后两条同构，`total: 3`）。

## 8）tree —— 项目结构

```json
{"id":8,"ok":true,"data":{"root":"C:\\Users\\...\\demo","tree":[{"name":"src","type":"dir","children":[{"name":"orders.py","type":"file","lang":"python","size":537},{"name":"tool.ts","type":"file","lang":"typescript","size":518},{"name":"usage.ts","type":"file","lang":"typescript","size":260}]}]}}
```

## 典型排障链路

```
1. symbols "名字的片段"      → 拿到候选与行号（不确定完整名字时）
2. def "确切名字"            → 定义位置
3. read "文件#符号"          → 只读该符号实现
4. ref "确切名字"            → 使用者（剔除定义行）
5. context "文件:行号"       → 某行所属函数 + 周边
```

## Node 实现的结果

同一条命令加 `--tool` 即切到 Node 版，响应字段完全一致（仅 `elapsed_ms` 数值不同）：

```powershell
python "<SKILL_DIR>\scripts\aisearch_rpc.py" --root "$env:TEMP\demo" --tool "node <SKILL_DIR>\scripts\aisearch-js\bin\aisearch.mjs" health '{}'
```

## 常见错误响应

```json
{"id": 1, "ok": false, "error": "Unknown method 'foo'; available: search, symbols, def, ref, read, context, tree, health"}
{"id": 1, "ok": false, "error": "ValueError: Path '../outside.py' escapes project root"}
{"id": 1, "ok": false, "error": "ValueError: Binary file (2048 bytes); not text"}
{"id": 1, "ok": false, "error": "ValueError: Empty symbol name after '#' in file reference: src/orders.py#"}
```

出现这些不要重试同样的请求，按 `references/protocol.md` 的处置列改参数或换目标。
