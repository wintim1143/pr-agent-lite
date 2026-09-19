---
name: server-coding-chain-smoke-test
description: 在远程服务器上验证「编码链」的最小闭环是否真的通 —— CLI 能否被非交互调用、能否写码、git 建分支 / 提交 / countAhead 是否正常、提交身份的默认行为是什么。当出现以下情况时使用：要确认服务器上的编码环境可用（M0 验收 2）、改完环境要回归、怀疑「看着能跑其实没跑」、要判断 git 提交会不会因缺身份而失败、要为编码链配 git 身份。
agent_created: true
---

# 服务器编码链冒烟测试

一次 ssh 往返验证四件事：**CLI 可调用 → 能写码 → git 链路可用 → 提交身份行为已知**。

背景：第一版被测代码是**服务器上自建的本地仓**（无上游远端）。
见 `AGENTS.md` §4「编码 CLI 调用」「本地演练仓」，`里程碑规划.md` M0 出口验收 1 / 2。

## 关键前提（先读，否则会误判）

| 事实 | 说明 |
|---|---|
| **PATH 里没有 CLI** | 用户级 bin 目录**只进交互式 shell**。非交互执行直接写命令名 → NOT_FOUND。**用绝对路径调用即可正常工作**，不需要系统级软链，也不需要 sudo |
| **路径来自配置** | 不要把任何绝对路径写进项目代码 / 默认值（硬性注意 #3）。可执行文件路径、工作目录都应是配置项 |
| **提交身份默认为空** | 但**裸调 `git commit` 不会失败**（见下）——不要按「会报错」来设计 |

## 步骤

```bash
# 0) 取路径（不要硬编码；此处仅为示例形态）
CLI=<用户级 bin 目录下的 claude 绝对路径>
WORK=<服务器上的编码工作目录>

# 1) CLI 可调用性（非交互 shell + 绝对路径）
cd "$WORK" && "$CLI" -p "Reply with exactly one word: SUBPROC" < /dev/null
#    期望：SUBPROC，exit 0

# 2) 能写码（不进 git，验证工具权限够）
"$CLI" -p "Create a file named hello.txt containing exactly: PONG. Reply only DONE." \
       --allowedTools "Write" < /dev/null
#    期望：DONE，且 hello.txt 内容为 PONG

# 3) git 链路：建分支 → 写码 → 提交 → countAhead
cd "$WORK"
git init -q .
git config user.name "<身份名>"            # 仓库级，别用 --global
git config user.email "<身份邮箱>"
printf "# drill\n" > README.md
git add -A && git commit -q -m "chore: init drill repo"
BASE=$(git rev-parse HEAD)
git checkout -q -b feature/drill
"$CLI" -p "Create calc.js exporting add(a,b)=a+b (CommonJS). Reply only DONE." \
       --allowedTools "Write" < /dev/null
git add -A && git commit -q -m "feat: add calc.js"
echo "ahead=$(git rev-list --count $BASE..HEAD)"   # 期望 1（等价 countAhead :403）
```

**分工必须与真实链路一致**：CLI **只写码**，**提交归编排层**（`github.ts:557-590` 的 `gitCommit`）。
不要让 CLI 自己 commit —— 那会掩盖编排层的提交路径没被测到。

## 提交身份的默认行为（实测结论，别按直觉写）

git **2.43.0**，`user.name` / `user.email` 皆空、无 `/etc/gitconfig`、无 `GIT_AUTHOR_*` 环境变量：

| 条件 | 结果 |
|---|---|
| 默认（全无身份） | **exit 0** —— 自动推导 `Committer: Ubuntu <ubuntu@localhost.localdomain>`，**仅打警告** |
| `user.useConfigOnly=true` | exit 128 `Author identity unknown` |
| 主机名不可解析 | 同样 exit 128 |

⇒ **失败模式不是「报错」，而是「静默写出无意义身份」** —— 后者更难发现。
所以：**仍须由配置显式提供身份**（配置驱动 `-c user.name=… -c user.email=…` 优先级最高，或仓库级配置）。

## 验收判据

- [ ] CLI 绝对路径调用返回预期文本、exit 0
- [ ] CLI 能实际落盘文件（不只是回话）
- [ ] `git checkout -b` 成功，`feature/drill` 指向正确 commit
- [ ] `git rev-list --count <BASE>..HEAD` 返回 1（不是报错，也不是 0）
- [ ] 提交身份是**预期值**，而不是 `Ubuntu <…@localhost.localdomain>`
- [ ] 临时产物已清理；若留在共享目录，明确告知可 `rm -rf` 回退

## 权限：项目级到底能做到哪一步（实测，别再试错）

要在项目目录里「免提示跑一切」，配置 `.claude/settings.json`：

```json
{
  "permissions": {
    "defaultMode": "acceptEdits",
    "allow": ["Bash", "Read", "Edit", "Write", "NotebookEdit",
              "Glob", "Grep", "WebFetch", "WebSearch", "Agent",
              "TaskStop", "Monitor"],
    "deny": [], "ask": []
  }
}
```

**实测（v2.1.276）**：不带任何命令行参数，Bash 写文件 + Write 建文件**全部通过、无提示**，启动无非法工具名警告。

### 但项目级**做不到** `bypassPermissions`

- `permissions.defaultMode` 的 **`auto` 与 `bypassPermissions` 从项目级 / 本地级设置不生效**（v2.1.257 起的变更），会话**回落到 Manual**。
- **实测双证**：项目级只放 `{"permissions":{"defaultMode":"bypassPermissions"}}` → `Write` 调用**被权限拒绝**。
- 要真放行只能：**用户级 `~/.claude/settings.json`**（注意作用域 = 该用户的**所有**项目）/ `--settings <file|json>` / `--permission-mode bypassPermissions` / `--dangerously-skip-permissions` / 托管设置。
- 进 bypass 会弹「危险模式」确认框；跳过它需要 `skipDangerousModePermissionPrompt`，其作用域**不含项目级**（User / local / managed）。

### 规则语法要点

- **裸工具名 ≡ `Tool(*)`** —— `"Bash"` 即放行全部 Bash 命令。不必写 `Bash(*)`。
- `allow` **不接受**未锚定通配（`"*"`、`"mcp__*"`）—— 会被**跳过并给启动警告**，不批准任何内容。MCP 需逐个写 `mcp__<server>__*`。
- 优先级 **deny > ask > allow**；裸名 deny 会把工具从上下文里彻底移除；**跨级 deny 不能被 allow 覆盖**。

## 坑

1. **退出码被 `| head` 吃掉** —— `git commit ... | head` 的 `$?` 是 `head` 的。要判成败就重定向到文件再读、或别接管道。
2. **别用 `--global` 配身份** —— 会污染服务器上其它仓库（含 Hermes）；用仓库级或提交时 `-c`。
3. **`claude -p` 会等 stdin** —— 非交互场景显式 `< /dev/null`，否则出现 `Warning: no stdin data received in 3s` 白等。
4. **模型名告警不代表失败** —— 自定义模型名会打 `[claude-code:unrecognized_model]`（按 200k 管 auto-compact），**功能不受影响**。
5. **导出名 / 工具名要真实探测** —— 别假设 `--allowedTools` 的写法；先跑一次最小写文件验证。
6. **🔴 做权限对照实验前，先确认只有一个变量在变** —— **沙箱 ≠ 权限**，是两条独立的轴。
   - 现象：在**未信任**目录里跑，会报「输出重定向被阻止，只能写会话允许的工作目录」——这是**文件系统沙箱**，不是权限模式。
   - 判据：`~/.claude.json` 的 `projects.<path>.hasTrustDialogAccepted`。**已信任**目录沙箱宽松，**新目录**更严。
   - 我踩过：在 `/tmp/<新目录>` 里做 bypass 对照，把沙箱拒绝误读成「bypass 未生效」。**读报错措辞**，别只看「失败」这个结论。
