# aisearch 通用版（`all/`）

本目录 = **跨平台通用分发**：同一套脚本与文档同时适配 **macOS / Linux / Windows**。
仓库根始终是唯一源码真源；本目录只放通用安装入口、跨平台文档，以及可复现的源码全集与归档。

---

## 环境要求

| 组件 | 要求 | 说明 |
|---|---|---|
| Python | >= 3.9 | 核心功能零依赖 |
| Node.js | >= 18 | 可选，用于零依赖移植版 `aisearch-js` |
| ripgrep | 可选 | 存在则自动加速（不存在回退纯实现） |

---

## 安装

### macOS

```bash
bash all/install.sh              # 基础安装
bash all/install.sh --test       # 附加测试依赖（pytest）
VENV=1 bash all/install.sh       # 先建 .venv 再安装
```

> 若提示找不到 `python3`：`brew install python`，或安装 Xcode Command Line Tools（`xcode-select --install`）。

### Linux

```bash
bash all/install.sh
bash all/install.sh --full       # 附加 tree-sitter 可选增强

# 发行版若缺 pip：
#   Debian/Ubuntu : sudo apt install python3 python3-pip python3-venv
#   Fedora        : sudo dnf install python3 python3-pip
#   Arch          : sudo pacman -S python python-pip
```

### Windows

```powershell
# PowerShell
powershell -ExecutionPolicy Bypass -File all\install.ps1
powershell -ExecutionPolicy Bypass -File all\install.ps1 -Test      # 含测试依赖
powershell -ExecutionPolicy Bypass -File all\install.ps1 -Full -NoJs

# 先建虚拟环境再安装
$env:VENV="1"; powershell -ExecutionPolicy Bypass -File all\install.ps1
```

```bat
:: cmd 入口（等价转发到 install.ps1）
all\install.cmd
all\install.cmd -Test
```

---

## 安装后自检

```bash
aisearch --version                 # CLI 就绪
aisearch tree . -d 2               # 目录树（终端彩色 / 管道 JSON）
aisearch rpc                       # 交互式 stdio；粘贴 {"id":1,"method":"health","params":{}} 回车
python -m pytest tests -q          # 回归测试（需 --test / -Test 安装依赖）
node aisearch-js/tests/parity_smoke.mjs    # py/js 一致性（需 Node）
```

---

## 使用

默认输出策略：**管道（AI）→ JSON；交互终端 → 彩色文本**；可用 `--json` / `--text` 强制指定。

### 命令一览

| 命令 | 用途 | 示例 |
|---|---|---|
| `grep` | 文本搜索（替代 `grep -rn`） | `aisearch grep "def process"` |
| `sym`  | 符号搜索（函数/类/结构体/接口…） | `aisearch sym "handle_request" -k function` |
| `def`  | 查找定义（精确名优先） | `aisearch def "MyClass"` |
| `ref`  | 查找引用 | `aisearch ref "process_data"` |
| `cat`  | 智能读文件（整文件 / 行范围 / 按符号） | `aisearch cat src/main.py#process_data` |
| `ctx`  | 某行的丰富上下文（所属符号 / imports / 大纲） | `aisearch ctx src/main.py:42` |
| `tree` | 项目目录树 | `aisearch tree -d 3` |

常用参数：`-n/--limit` 结果上限、`-C/--context` 上下文行数、`-t/--type` 扩展名过滤、
`-i` 忽略大小写、`-w` 全词匹配、`--json` / `--text` 强制输出格式。

```bash
aisearch grep "TODO" -t py,pyi -C 3        # 限文件类型 + 上下文
aisearch sym process -k function --exact   # 仅精确同名函数
aisearch cat src/main.py:10-50             # 按行范围读
aisearch cat src/main.py --outline         # 只看符号大纲
aisearch tree -d 5                         # 5 层目录树
```

### 给 AI 用：`aisearch rpc`（推荐，零端口）

AI 以**子进程**方式拉起，stdin/stdout 逐行交换 JSON；进程常驻复用，避免每次搜索重启进程的开销。

```bash
aisearch rpc                       # 以当前目录为项目根（boundary=system）
aisearch rpc --root /path/to/proj  # 锁定项目根（boundary=root，拦截 ../ 与绝对路径越权）
```

```
请求 → {"id":1,"method":"search","params":{"pattern":"def foo","limit":20}}
响应 ← {"id":1,"ok":true,"data":{"matches":[...],"total":3}}
错误 ← {"id":1,"ok":false,"error":"..."}
```

方法：`search / symbols / def / ref / read / context / tree / health`。
非法请求（坏 JSON、未知方法、非法参数）一律返回结构化错误，进程不崩溃。

### 给人用：CLI

直接运行命令即可——交互终端自动彩色文本（符号大纲、框线），重定向/管道时自动 JSON，便于脚本消费。

> 两种用法互不打扰：**AI 走 `rpc`（精简 JSON、常驻快）**，**人走 CLI（渲染丰富）**；
> CLI 的 `--json` 同样是精简形态（不含人类专属的大纲渲染），可直接给脚本/CI 用。

---

## 接入 CodeBuddy / SkillHub（Skill 形态）

技能形态**不在本分支维护**，改由本仓库的 **`skill` 分支**承载（避免同一份代码维护两处副本而产生分叉）：

```bash
git checkout skill        # 技能分支布局：
                          # SKILL.md + scripts/{aisearch_rpc.py, aisearch/, aisearch-js/}
                          #           + references/ + assets/
```

把该分支内容放进 Agent 的技能目录（CodeBuddy 为 `~/.codebuddy/skills/aisearch/`，**目录名即技能名**），或从 SkillHub 安装 slug `aisearch`。

技能触发后，AI 通过 `scripts/aisearch_rpc.py` 调 `rpc`（单进程常驻）。同一份 `SKILL.md` **同时满足两个平台的字段要求**：CodeBuddy 认 `name` / `description` / `allowed-tools`，SkillHub 认 `slug` / `version` / `displayName`。

---

## 本目录内容

### 安装入口（日常使用看这里）

| 文件 | 平台 | 说明 |
|---|---|---|
| `install.sh` | macOS / Linux | 安装脚本（bash 3.2+ 兼容、POSIX 友好） |
| `install.ps1` | Windows | 安装脚本（PowerShell 5.1+） |
| `install.cmd` | Windows | cmd 入口，等价转发到 `install.ps1` |

### 整库快照（可选，按需使用）

| 文件 | 说明 |
|---|---|
| `gen_bundle.py` | 生成下列两个快照 |
| `SOURCE.md` | 把全仓源码拼成**单文件**（含文件清单 + 行数 + 内容） |
| `aisearch-source.tar.gz` | 同一文件集合的 tar 归档 |

**快照产物不入库**（`.gitignore` 已排除 `all/*.tar.gz` 与 `all/SOURCE.md`），需要时本地生成。

**这两个快照是"整库可读 / 可交付"的便捷产物，不是运行必需品**：仓库本身（或 `pip install -e .`）才是权威来源，快照只是它的**副本**。适用场景只有两类：

1. 需要**一次性把握整库**——离线审阅，或交给人工通读；
2. 需要**脱离 git 的整包交付**——一个 `tar.gz` 带走全部源码。

> **给 AI 读代码不建议用它**：把 `SOURCE.md` 全量喂模型是**十万级 token**；而 `aisearch rpc` / `cat <file>#<sym>` 是**按需检索**，实测省 4.9–7.8x。
> 另外快照是源码副本，**改完代码需重跑生成**，否则会陈旧（这正是仓库早期旧 `source.md` 失效的原因）。

### 重新生成快照

```bash
python all/gen_bundle.py
```

生成前会扫描"机器/项目专有"禁用串（本地绝对路径、服务器地址等），**命中即拒绝生成**并列出位置，保证产物可直接分发。

---

## 卸载

```bash
pip uninstall aisearch        # Python 包
# Node 版零 npm 依赖，删除目录即可
```

---

## 设计说明

- 三个安装脚本**只做安装**：`pip install -e <仓库根>`（+ 可选 extras）→ 检查 node 可用性 → 打印后续命令。
- 脚本内**不含任何机器/路径硬编码**：仓库根一律由"脚本自身位置"推导（`$(dirname "$0")/..` / `Split-Path -Parent`）。
- `--test`/`-Test` 安装 pytest；`--full`/`-Full` 安装 tree-sitter 可选增强；`--no-js`/`-NoJs` 跳过 Node 检查。
- `install.ps1` 全 ASCII，规避 PowerShell 5.1 读取无 BOM UTF-8 时的解析问题。
