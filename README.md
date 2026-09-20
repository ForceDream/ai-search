# aisearch — AI 友好的代码搜索与阅读工具

> 针对三个痛点设计：**grep 输出无结构、LSP 太重、AI 默认不用高级工具**。
> 核心思路：**零依赖安装、JSON 输出、regex 提取符号（不需要 LSP）、内置 stdio rpc 无服务模式**。

`aisearch` 是一个给 AI（以及人类）用的代码导航工具，用一行命令就能替代 `grep -rn` 和笨重的 LSP：

- 用 **正则** 提取符号（类/函数/结构体/接口…），零配置、不需要任何语言 server
- 所有结果 **结构化 JSON** 输出，AI 无需再做脆弱的文本解析
- 自动识别一段代码**所属的函数/类**，给出语义上下文
- 支持 `cat file.py#func` 这种**按符号读取**
- 内置 **rpc 无服务模式**：不监听任何端口，一次拉起、反复查询，避免每次搜索都重启进程

---

## 安装

跨平台一键安装脚本位于 [`all/`](all/)（同一套脚本适配 **macOS / Linux / Windows**）：

```bash
# macOS / Linux
bash all/install.sh              # 基础；--test 含测试依赖，--full 含可选增强

# Windows
powershell -ExecutionPolicy Bypass -File all\install.ps1
all\install.cmd                  # cmd 入口（等价）
```

手动安装（在仓库根目录执行；核心功能零依赖，仅需 Python >= 3.9）：

```bash
pip install -e .              # 基础安装
pip install -e ".[full]"      # 可选：tree-sitter 增强（更准的符号范围推断）
pip install -e ".[test]"      # 可选：测试依赖
pytest
```

> 仓库同时包含 Node.js 零依赖移植版（`aisearch-js/`），CLI 行为与 JSON 协议与 Python 版逐字段对齐。
> 通用版目录 [`all/`](all/)：跨平台安装脚本与文档；另附**可选的整库源码快照**（`SOURCE.md` 单文件 / `tar.gz` 归档，由 `python all/gen_bundle.py` 生成），供"离线通读整个仓库"或"脱离 git 整包交付"使用——**AI 读代码请优先用 `rpc`/`cat` 按需检索，比喂整库快照省 4.9–7.8x token**。
>
> 接入 **CodeBuddy / VibeCode**：`bash all/install.sh --skill`（项目级）或 `--skill-user`（用户级；Windows 用 `.\all\install.ps1 -Skill`）。它会把 `all/skill/aisearch/` 装成技能，之后 AI 在"查定义 / 找引用 / 读某个函数 / 看项目结构"时会自动走 `rpc` 检索，而不必你每次提示。

> 零依赖模式下核心功能完全可用；ripgrep 若存在则自动启用（搜索快 10x+），不存在时回退到纯 Python 正则。

---

## 命令行用法

默认输出策略：**管道调用（AI）→ JSON；交互终端 → 彩色文本**。可用 `--json` / `--text` 强制指定。

```bash
# ── 1. 文本搜索（替代 grep -rn） ────────────────
aisearch grep "def process"                     # JSON 输出
aisearch grep "TODO" -t py,js -C 3              # 过滤文件类型 + 上下文
aisearch grep "error" -i --text                 # 忽略大小写 + 人类可读格式
aisearch grep "\bfetch\b" -w -t ts              # 全词匹配

# ── 2. 符号搜索（替代 LSP 的 symbol search） ────
aisearch sym "handle_request"                    # 子串匹配所有相关符号
aisearch sym "MyClass" -k class                  # 只查类
aisearch sym "process" -k function --exact       # 仅精确匹配同名

# ── 3. 查找定义（替代 LSP 的 go-to-definition） ─
aisearch def "MyClass"                           # 优先返回 class/struct 定义
aisearch def "handle_request"

# ── 4. 查找引用（替代 LSP 的 find-references） ──
aisearch ref "process_data"                      # 所有使用位置

# ── 5. 智能读文件（替代 cat / sed） ─────────────
aisearch cat src/main.py                         # 完整文件
aisearch cat src/main.py:10-50                   # 行范围
aisearch cat src/main.py#process_data            # 读取特定函数
aisearch cat src/main.py --outline               # 只看符号大纲

# ── 6. 获取上下文 ──────────────────────────────
aisearch ctx src/main.py:42                      # 行 42 的丰富上下文

# ── 7. 项目结构 ────────────────────────────────
aisearch tree                                    # 目录树
aisearch tree -d 5                               # 5 层深度
```

---

## RPC 无服务模式（推荐 AI 集成，零端口）

不需要 `127.0.0.1`、不监听任何端口：AI 以**子进程**方式拉起 `aisearch rpc`，通过
stdin/stdout 逐行交换 JSON。进程退出即结束，天然无鉴权问题、无端口冲突、无网络暴露面。

```bash
# 方式一：以当前目录为项目根（CLI 级信任，boundary=system）
aisearch rpc

# 方式二：锁定项目根（boundary=root，仅允许读该项目内文件）
aisearch rpc --root /path/to/project
```

协议：**行分隔 JSON**（stdin 进、stdout 出，一请求一行响应，每行即时 flush）：

```
请求 → {"id": 1, "method": "search", "params": {"pattern": "def foo", "limit": 20}}
响应 ← {"id": 1, "ok": true, "data": {"matches": [...], "total": 3, ...}}
错误 ← {"id": 1, "ok": false, "error": "..."}
```

| method   | params | 说明 |
|----------|--------|------|
| `search`  | `pattern, path?, context?, limit?, ignore_case?, whole_word?, extensions?` | 文本搜索 |
| `symbols` | `name, path?, kind?, limit?, partial?` | 符号搜索 |
| `def`     | `name, path?` | 查找定义（精确名优先） |
| `ref`     | `name, path?, limit?` | 查找引用 |
| `read`    | `file, path?, outline?` | 智能读文件（支持 `file:10-50` / `file#symbol`） |
| `context` | `file, line, radius?, path?` | 行级语义上下文 |
| `tree`    | `path?, depth?` | 项目目录树 |
| `health`  | `{}` | 版本 / 方法列表 / 生效根与边界 |

非法请求（坏 JSON、未知方法、非法参数）永远返回结构化错误，进程不崩溃。

集成示例（伪代码）：

```python
proc = Popen(["aisearch", "rpc", "--root", repo], stdin=PIPE, stdout=PIPE, text=True)
proc.stdin.write(json.dumps({"id": 1, "method": "search",
                             "params": {"pattern": "def main"}}) + "\n")
proc.stdin.flush()
resp = json.loads(proc.stdout.readline())
```

所有响应均为 `{"ok": true, "data": {...}}` 或 `{"ok": false, "error": "..."}`。

---

## 为什么比 grep + LSP 好？

| 维度 | grep | LSP | aisearch |
|------|------|-----|----------|
| 安装 | 系统自带 | 需装语言 server + 配置 | `pip install` 一行 |
| 输出格式 | 纯文本，AI 需解析 | 复杂协议 | **JSON 标准格式** |
| 符号搜索 | 不支持 | 支持但配置复杂 | **正则提取，零配置** |
| 语义上下文 | 仅周围 N 行 | 有，但需 LSP 运行 | **自动识别所属函数/类** |
| 按符号读取 | 不支持 | 需要客户端 | **`cat file.py#func`** |
| 持久化 | 无 | 有但重 | **rpc 长驻子进程（零端口）** |
| AI 友好度 | 低 | 中 | **高** |

---

## 项目结构

```
aisearch/
├── pyproject.toml
├── README.md
├── LICENSE
├── aisearch/
│   ├── __init__.py
│   ├── __main__.py
│   ├── cli.py          # CLI 入口
│   ├── config.py       # 配置、语言检测、ignore、路径安全
│   ├── symbols.py      # 符号提取（regex）
│   ├── engine.py       # 核心搜索引擎（ripgrep / 纯 Python 回退）
│   ├── reader.py       # 智能文件阅读
│   └── rpc.py          # stdio 无服务模式（零端口）
└── tests/
```

---

## 设计取舍

- **正则而非 LSP**：覆盖 Python / JS / TS / Go / Rust / Java / C / C++ / PHP / Ruby / Swift / Kotlin / Scala / Shell 等主流语言，开箱即用，不依赖任何语言 server。符号范围推断是启发式（缩进 / 花括号配平）：缩进语言支持**多行函数签名**（按括号配平先定位签名结束），花括号语言按配平计数支持**嵌套成员的类/命名空间完整范围**。
- **ripgrep 优先，且始终以项目根为工作目录运行**：若系统存在 `rg`，自动启用其 JSON 模式；搜索子进程 `cwd` 固定为项目根，保证 ignore glob 与输出路径与调用方所在目录无关。否则回退到纯 Python 实现，保证零依赖也能跑。
- **无状态**：CLI / rpc 两种形态均不缓存项目状态，每次查询按需扫描，部署零心智负担。
- **忽略规则**：支持 `.aisearchignore`（语法：精确目录/文件名、`*.ext`、含 `/` 的相对路径前缀如 `src/generated`）。

## 安全边界

工具区分两种运行边界，这是刻意的安全设计：

| 场景 | boundary | 行为 |
|------|----------|------|
| 本地 CLI（`aisearch cat/ctx`）、`rpc`（默认） | `system` | 允许读取任意路径（用户显式操作自己的机器） |
| `rpc --root <dir>` | `root` | **仅允许指定项目根目录内**，拦截 `../`、绝对路径、软链穿越 |

- 路径校验在 `resolve()` 之后比对真实路径，`../` 与软链接绕过均被拦下；同时拒绝含 NUL 字节的路径。
- **资源上限**：单次结果 ≤ 5000 条、目录树深度 ≤ 16、上下文半径 ≤ 200、单文件读取 ≤ 5 MB——防止超大参数或恶意输入导致资源耗尽。
- 非法参数（非整数 / 坏 JSON / 未知方法）一律结构化错误返回或安全回退，绝不因输入崩溃。
- rpc 不监听任何端口，不存在网络暴露面。

## License

MIT
