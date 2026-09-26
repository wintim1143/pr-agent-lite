#!/usr/bin/env bash
#
# MCP server 启动器（stdio）—— 供外侧网关（Hermes）注册时使用。
#
# ## 为什么需要这一层
#
# `config.ts` 用 `dotenv/config` 从**进程工作目录**读 `.env`。
# 而 `hermes mcp add` 只接受 `--command` / `--args` / `--env`，**没有 `--cwd`** ——
# 直接注册 `node dist/mcp-server.js` 会让 cwd 落在网关自己的启动目录上，
# 结果是**配置静默为空**：进程照常起来、握手也能成功，但两个端点都没配、
# 注册表读不到，直到第一次调用才以别的形态暴露。
#
# 所以这里把 cwd 钉死在本脚本所在的仓库根目录，让 `.env` 成为**唯一配置来源**
# ——不把凭据再抄一份进网关的配置文件（抄一份就是造第二个真相源，且两份会漂移）。
#
# ## 用法
#
#   hermes mcp add pr-agent-lite --command <仓库根>/scripts/mcp-launch.sh
#
# ⚠️ `dist/` 必须已构建（`npm run build`）；缺 `dist/mcp-server.js` 时本脚本显式失败，
#    不静默启动一个空壳。
set -euo pipefail

# 解析本脚本所在目录的父目录（= 仓库根），与调用方 cwd 无关。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${ROOT_DIR}"

if [ ! -f "${ROOT_DIR}/dist/mcp-server.js" ]; then
  echo "[mcp-launch] 找不到 ${ROOT_DIR}/dist/mcp-server.js —— 先跑 npm run build" >&2
  exit 1
fi

if [ ! -f "${ROOT_DIR}/.env" ]; then
  echo "[mcp-launch] 警告：${ROOT_DIR}/.env 不存在，将使用内置默认值（端点大概率不可用）" >&2
fi

# stdio 传输：stdout 是协议通道，本脚本不得向 stdout 写任何东西。
exec node "${ROOT_DIR}/dist/mcp-server.js"
