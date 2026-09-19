#!/usr/bin/env bash
# =============================================================================
# setup-claude-deepseek.sh
#
# 把 Claude Code CLI 指向 DeepSeek 的 Anthropic 兼容端点。
#
# 为什么需要它：Anthropic 官方端点在该服务器上被区域封锁（api.anthropic.com
#   返回 403 "Request not allowed"，属 edge 层拦截，配合法 key 也无效）。
#   DeepSeek 的 Anthropic 兼容端点实测可达 —— 这是绕开封锁的路径。
#
# 用法（两步）：
#   ① 改下面「只需改这一行」处的 key
#   ② bash setup-claude-deepseek.sh
#
#   不想改文件也行：DEEPSEEK_API_KEY=sk-xxx bash setup-claude-deepseek.sh
#
# 幂等：可反复执行；每次自动备份既有配置。
# 退出码：0 = 配置写入且探测通过；1 = 探测失败；2 = 前置条件不满足
# =============================================================================

set -euo pipefail

# ┌───────────────────────────────────────────────────────────────────────┐
# │  只需改这一行：把下面换成你的 DeepSeek API Key（形如 sk-xxxxxxxx）      │
# └───────────────────────────────────────────────────────────────────────┘
DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-sk-在这里粘贴你的DeepSeekAPIKey}"

# --- 固定配置（一般不用动）---------------------------------------------------
BASE_URL="https://api.deepseek.com/anthropic"   # ⚠️ 结尾不要加 /v1
MODEL="${DEEPSEEK_MODEL:-deepseek-flash}"       # 所有档位统一用这一个模型
SETTINGS_DIR="${HOME}/.claude"
SETTINGS_FILE="${SETTINGS_DIR}/settings.json"
PROBE_TIMEOUT="${DEEPSEEK_PROBE_TIMEOUT:-30}"

KEY="${DEEPSEEK_API_KEY}"
PLACEHOLDER="sk-在这里粘贴你的DeepSeekAPIKey"

say() { printf '%s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 2; }

say "=============================================="
say " Claude Code  →  DeepSeek"
say "=============================================="
say ""

# --- 0. 前置检查 ---------------------------------------------------------------
command -v curl >/dev/null 2>&1 || die "curl 不可用，无法做连通性探测"

if [ -z "${KEY}" ] || [ "${KEY}" = "${PLACEHOLDER}" ]; then
  die "还没填 API Key。二选一：
       ① 编辑本脚本，改「只需改这一行」处，再执行；
       ② 不改文件，直接执行：DEEPSEEK_API_KEY=sk-xxx bash $0"
fi

# 只允许安全字符，防止拼进 JSON 时注入
case "${KEY}" in
  *[!A-Za-z0-9_.-]*) die "key 含意外字符，拒绝写入（防 JSON 注入）" ;;
esac
say "key    : 已读取（${#KEY} 字符，前缀 ${KEY:0:3}...）"

# --- 1. 定位 claude -------------------------------------------------------------
CLAUDE_BIN=""
if command -v claude >/dev/null 2>&1; then
  CLAUDE_BIN="$(command -v claude)"
elif [ -x "${HOME}/.local/bin/claude" ]; then
  CLAUDE_BIN="${HOME}/.local/bin/claude"
fi
if [ -n "${CLAUDE_BIN}" ]; then
  say "claude : ${CLAUDE_BIN}"
  say "version: $("${CLAUDE_BIN}" --version 2>&1 | head -1)"
else
  say "claude : 未找到（配置照样写入，但请先安装 CLI）"
fi
say "model  : ${MODEL}"
say ""

# --- 2. 写 ~/.claude/settings.json ---------------------------------------------
mkdir -p "${SETTINGS_DIR}"
chmod 700 "${SETTINGS_DIR}"

if [ -f "${SETTINGS_FILE}" ]; then
  BAK="${SETTINGS_FILE}.bak.$(date +%Y%m%d%H%M%S)"
  cp -p "${SETTINGS_FILE}" "${BAK}"
  say "旧配置 : 已备份 → ${BAK}"
fi

# umask 077 —— 文件落盘即 600，不存在「先宽后窄」的窗口
(
  umask 077
  cat > "${SETTINGS_FILE}" <<JSON
{
  "\$schema": "https://json.schemastore.org/claude-code-settings.json",
  "env": {
    "ANTHROPIC_BASE_URL": "${BASE_URL}",
    "ANTHROPIC_AUTH_TOKEN": "${KEY}",
    "ANTHROPIC_MODEL": "${MODEL}",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "${MODEL}",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "${MODEL}",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "${MODEL}",
    "CLAUDE_CODE_SUBAGENT_MODEL": "${MODEL}",
    "CLAUDE_CODE_EFFORT_LEVEL": "max"
  }
}
JSON
)
chmod 600 "${SETTINGS_FILE}"
say "新配置 : 已写入 ${SETTINGS_FILE} (mode 600)"
say ""

# --- 3. 连通性 + 模型名探测（最关键的一步）---------------------------------------
# 不探测的话，「key 无效」和「模型名不存在」在 claude 里都只表现为一句模糊报错，
# 甚至可能静默退化。这里直接发一次真实请求，把服务端原话打出来。
say "--- 连通性探测（真实请求，消耗极少量 token）---"
say "endpoint: ${BASE_URL}/v1/messages"

probe_body="$(mktemp)"
code="$(curl -sS -o "${probe_body}" -w '%{http_code}' --max-time "${PROBE_TIMEOUT}" \
  -X POST "${BASE_URL}/v1/messages" \
  -H "x-api-key: ${KEY}" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d "{\"model\":\"${MODEL}\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" \
  2>/dev/null || echo "000")"

served="$(grep -o '"model":"[^"]*"' "${probe_body}" 2>/dev/null | head -1 | cut -d'"' -f4 || true)"

PROBE_OK=1
if [ "${code}" = "200" ]; then
  say "  [ OK ] HTTP 200"
  say "         请求的模型 : ${MODEL}"
  say "         实际生效   : ${served:-<服务端未回带 model 字段>}"
else
  PROBE_OK=0
  say "  [FAIL] HTTP ${code}"
  if [ -s "${probe_body}" ]; then
    head -c 400 "${probe_body}" | tr -d '\n' | sed 's/^/         /'
    say ""
  fi
  say ""
  say "  排查参考："
  say "   · 401 authentication_error → key 不对或已失效"
  say "   · 400 / model 相关报错     → 模型名不被接受，可试 deepseek-v4-pro："
  say "        DEEPSEEK_MODEL=deepseek-v4-pro bash $0"
  say "   · 000（无响应）            → 网络不通"
fi
rm -f "${probe_body}"
say ""

# --- 4. 打印实际生效配置（读回落盘值，验「落盘 = 预期」）--------------------------
say "--- 实际生效的配置 ---"
if command -v python3 >/dev/null 2>&1; then
  python3 - "${SETTINGS_FILE}" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
env = d.get("env", {})
if "ANTHROPIC_AUTH_TOKEN" in env:
    env["ANTHROPIC_AUTH_TOKEN"] = "<已隐藏>"
print(json.dumps({"env": env}, indent=2, ensure_ascii=False))
PY
else
  sed 's/\("ANTHROPIC_AUTH_TOKEN": "\)[^"]*/\1<已隐藏>/' "${SETTINGS_FILE}"
fi
say ""

# --- 5. 收尾提示 ----------------------------------------------------------------
say "探测结果: $([ "${PROBE_OK}" = "1" ] && echo '✅ 通过' || echo '❌ 失败（见上）')"
say ""
say "验证方式："
say "  claude --version && claude -p 'say hi in one word'"
say ""

if [ -z "${CLAUDE_BIN}" ]; then
  say "注意: 还没装 Claude Code CLI，请先安装再重跑本脚本。"
elif [ ! -e /usr/bin/claude ]; then
  say "注意: claude 目前只在交互式 shell 的 PATH 里。"
  say "      若要让非交互调用（ssh 'claude ...'、被其他进程当子进程拉起）也能找到，"
  say "      需要建系统软链（要 sudo）："
  say "        sudo ln -sf ${CLAUDE_BIN} /usr/bin/claude"
fi
say "注意: 本脚本已包含你的 key，建议 chmod 600 $0，且不要提交进 git。"
say ""

[ "${PROBE_OK}" = "1" ] && exit 0 || exit 1
