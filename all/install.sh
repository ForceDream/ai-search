#!/usr/bin/env bash
# aisearch 通用安装脚本 —— macOS / Linux
#
# 安装仓库根目录下的 Python 包（editable），并检查 Node 版可用性。
#
# 用法:
#   bash all/install.sh              # 基础安装
#   bash all/install.sh --test       # 附加测试依赖（pytest）
#   bash all/install.sh --full       # 附加可选增强（tree-sitter）
#   bash all/install.sh --no-js      # 跳过 Node 检查
#   bash all/install.sh --skill      # 另装 CodeBuddy Skill 到 ./.codebuddy/skills
#   bash all/install.sh --skill-user # 另装 Skill 到 ~/.codebuddy/skills
#
# 环境变量:
#   PYTHON=python3.12 bash all/install.sh     # 指定解释器
#   VENV=1 bash all/install.sh                # 先在 .venv 建虚拟环境再安装
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

# ── 解释器探测（macOS/Linux 通用）──────────────────
PY="${PYTHON:-}"
if [ -z "$PY" ]; then
  if command -v python3 >/dev/null 2>&1; then PY=python3
  elif command -v python  >/dev/null 2>&1; then PY=python
  else
    echo "错误：未找到 python3/python，请先安装 Python >= 3.9" >&2
    echo "  macOS : brew install python   （或安装 Xcode Command Line Tools）" >&2
    echo "  Linux : sudo apt install python3 python3-pip   （或发行版对应命令）" >&2
    exit 1
  fi
fi

# ── 可选：虚拟环境 ────────────────────────────────
if [ "${VENV:-0}" = "1" ] && [ ! -d "$REPO/.venv" ]; then
  echo "== 创建虚拟环境 .venv =="
  "$PY" -m venv "$REPO/.venv"
  # shellcheck disable=SC1091
  . "$REPO/.venv/bin/activate"
  PY="$REPO/.venv/bin/python"
fi

OS="$(uname -s 2>/dev/null || echo unknown)"
case "$OS" in
  Darwin) PLAT_OS="macOS" ;;
  Linux)  PLAT_OS="Linux" ;;
  *)      PLAT_OS="$OS" ;;
esac
echo "== 平台: $PLAT_OS | Python: $("$PY" --version 2>&1) =="

EXTRAS=""
DO_JS=1
SKILL_DEST=""
for a in "$@"; do
  case "$a" in
    --test)   EXTRAS="${EXTRAS:+$EXTRAS,}test" ;;
    --full)   EXTRAS="${EXTRAS:+$EXTRAS,}full" ;;
    --no-js)  DO_JS=0 ;;
    --skill)      SKILL_DEST="$PWD/.codebuddy/skills" ;;
    --skill-user) SKILL_DEST="${HOME}/.codebuddy/skills" ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数: $a（可用: --test --full --no-js --skill --skill-user）" >&2; exit 2 ;;
  esac
done

echo "== 安装 aisearch (Python) =="
if [ -n "$EXTRAS" ]; then
  "$PY" -m pip install -e "$REPO[$EXTRAS]"
else
  "$PY" -m pip install -e "$REPO"
fi

if [ "$DO_JS" -eq 1 ]; then
  echo "== 检查 Node 版 =="
  if command -v node >/dev/null 2>&1; then
    echo "node $(node --version) 已就绪（aisearch-js 零 npm 依赖）。"
    echo "如需全局命令: (cd \"$REPO/aisearch-js\" && npm link)"
  else
    echo "未检测到 node —— 可跳过；Node 版需 Node >= 18。"
    echo "  macOS : brew install node"
    echo "  Linux : 见 https://nodejs.org 或发行版包管理器"
  fi
fi

if [ -n "$SKILL_DEST" ]; then
  echo "== 安装 CodeBuddy Skill =="
  mkdir -p "$SKILL_DEST"
  rm -rf "$SKILL_DEST/aisearch"
  cp -R "$REPO/all/skill/aisearch" "$SKILL_DEST/aisearch"
  chmod +x "$SKILL_DEST/aisearch/scripts/aisearch_rpc.py" 2>/dev/null || true
  echo "  -> $SKILL_DEST/aisearch"
fi

echo
echo "安装完成。"
echo "  aisearch --version                                 # Python CLI"
echo "  aisearch rpc                                       # AI harness 用的 stdio 模式"
echo "  node \"$REPO/aisearch-js/bin/aisearch.mjs\" --help  # Node CLI（未 npm link 时）"
echo "  需要接入 CodeBuddy/VibeCode 技能时：bash all/install.sh --skill（或 --skill-user）"
