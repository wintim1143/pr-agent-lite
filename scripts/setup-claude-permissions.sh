#!/usr/bin/env bash
# 给 Claude Code 配置「免权限提示」运行环境。
#
#   bash setup-claude-permissions.sh              # 两个层级都配（用户级 + 项目级）
#   bash setup-claude-permissions.sh --user-only  # 只配用户级
#   bash setup-claude-permissions.sh --proj <dir> # 指定项目目录（默认当前目录）
#
# 幂等：重复执行只做合并与备份，不清空既有键（尤其不会碰 env 段里的凭据）。
#
# 为什么是两层（实测结论，别只配一层）：
#   permissions.defaultMode 的 auto / bypassPermissions **从项目级 / 本地级设置不生效**
#   （Claude Code v2.1.257 起的变更），会话会回落到 Manual 模式。
#   ⇒ 项目级只能做到「allow 列一堆裸工具名」；真正的硬放行必须在**用户级**设置。
set -euo pipefail

PROJ_DIR=""
USER_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --user-only) USER_ONLY=1; shift ;;
    --proj) PROJ_DIR="${2:?--proj 需要一个目录参数}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PROJ_DIR" ] || PROJ_DIR="$PWD"

TS="$(date +%Y%m%d-%H%M%S)"
say() { printf '%s\n' "$*"; }

command -v python3 >/dev/null 2>&1 || { echo "[x] 需要 python3" >&2; exit 1; }

# ---------- 用户级：真正的 bypassPermissions ----------
USER_SETTINGS="$HOME/.claude/settings.json"
mkdir -p "$HOME/.claude"

if [ -f "$USER_SETTINGS" ]; then
  cp -a "$USER_SETTINGS" "$USER_SETTINGS.bak-$TS"
  say "[*] 已备份用户级配置 → $USER_SETTINGS.bak-$TS"
else
  say "[*] 用户级配置不存在，将新建"
fi

python3 - "$USER_SETTINGS" <<'PY'
import json, os, sys
p = sys.argv[1]
try:
    d = json.load(open(p)) if os.path.exists(p) else {}
except json.JSONDecodeError as e:
    sys.exit(f"[x] 现有配置不是合法 JSON，拒绝覆写: {e}")
if not isinstance(d, dict):
    sys.exit("[x] 配置根节点不是对象，拒绝覆写")
d.setdefault("permissions", {})["defaultMode"] = "bypassPermissions"
# 否则每次进入 bypass 模式都会弹「危险模式」确认框，脚本场景会卡住
d["skipDangerousModePermissionPrompt"] = True
with open(p, "w") as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
    f.write("\n")
os.chmod(p, 0o600)
print("[+] 用户级已写入 permissions.defaultMode = bypassPermissions")
PY
say "    权限: $(stat -c '%a' "$USER_SETTINGS" 2>/dev/null || stat -f '%Lp' "$USER_SETTINGS")  (应为 600)"

if [ "$USER_ONLY" = "1" ]; then
  say "[✓] 完成（仅用户级）"
  exit 0
fi

# ---------- 项目级：allow 列裸工具名（可随仓库版本化） ----------
if [ ! -d "$PROJ_DIR" ]; then
  echo "[x] 项目目录不存在: $PROJ_DIR" >&2; exit 1
fi
PROJ_SETTINGS="$PROJ_DIR/.claude/settings.json"
mkdir -p "$PROJ_DIR/.claude"
[ -f "$PROJ_SETTINGS" ] && { cp -a "$PROJ_SETTINGS" "$PROJ_SETTINGS.bak-$TS"; say "[*] 已备份项目级配置"; }

python3 - "$PROJ_SETTINGS" <<'PY'
import json, os, sys
p = sys.argv[1]
try:
    d = json.load(open(p)) if os.path.exists(p) else {}
except json.JSONDecodeError as e:
    sys.exit(f"[x] 现有配置不是合法 JSON，拒绝覆写: {e}")
d.setdefault("$schema", "https://json.schemastore.org/claude-code-settings.json")
perm = d.setdefault("permissions", {})
# 项目级能用 acceptEdits（auto / bypassPermissions 在此层级无效）
perm["defaultMode"] = "acceptEdits"
# 裸工具名 ≡ Tool(*)；allow 不接受 "*" / "mcp__*" 这类未锚定通配（会被跳过并给启动警告）
allow = perm.setdefault("allow", [])
for t in ("Bash", "Read", "Edit", "Write", "NotebookEdit", "Glob", "Grep",
          "WebFetch", "WebSearch", "Agent", "TaskStop", "Monitor"):
    if t not in allow:
        allow.append(t)
perm.setdefault("deny", [])
perm.setdefault("ask", [])
with open(p, "w") as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"[+] 项目级已写入: {p}")
PY
say "[✓] 完成"

# ---------- 自检 ----------
say ""
say "自检（应无提示直接通过；把 <cli> <dir> 换成实际值）："
cat <<'EOF'
  cd <项目目录> && <claude 绝对路径> -p "Run: echo OK > /tmp/perm_selfcheck.txt" < /dev/null
  cat /tmp/perm_selfcheck.txt   # 应输出 OK
EOF
say ""
say "注意："
say "  · WebFetch 在受限出口的机器上可能不可用（它要先向 claude.ai 做域名安全校验），与权限无关，改用 Bash + curl。"
say "  · 「沙箱」与「权限」是两条轴：未信任目录的文件系统沙箱会另行拦写，且不受本配置影响。"
