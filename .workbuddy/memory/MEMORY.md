# 项目长期记忆

## 项目定性

**借鉴既有实现，新建一个独立项目，部署到远程服务器；由 Hermes 在飞书侧调用。参考代码副本随仓库提供（`reference/`），本仓库自成一体、无外部依赖。**

- **参考代码副本** = `reference/`，从既有实现抽取的完整代码 + 测试 + 配置，**只读**，是搬运原料、**不是项目结构**。搬运完成后整个可删。
- 三个定语：**借鉴不是迁移**（不搬运行状态，目录可自由重组）/ **自成一体的仓库**（clone 下来即可开工，无外部依赖）/ **交付形态就是服务器服务**（没有「本机先跑通再搬」的退路）。
- **被测代码** = **服务器上本地维护的 git 仓**（第一版为自建示例 / 最小仓，**无上游远端**）⇒ `git fetch` 在第一版**不触发**；接真仓库时恢复。
- **本项目代码经 scp 投递到服务器**（D7）；服务器不持代码平台凭据、不直连代码平台。
- **第一版不产出 PR**（D8）：链到「本地提交 + 测试通过」为止，不含 push / 开 PR / 合并。

## 第一版形态（2026-09-19 用户澄清后确定）

```
开发机 ──scp──→ 服务器：pr-agent-lite 部署代码
服务器（本地闭环）：
  └─ 演练仓（自建 git 仓，无上游）
        └─ 建分支 → 编码 → 测试 → 审核 → 提交（本地）
```

- 链路终点 = **本地提交 + 测试事实落盘**。
- 第一版实际实现 **五步**。参考实现的阶段闭集是**八步**（`progress.ts:73-95`）：`checkout / coding / test / review / commit / push-open-pr / notify / merge`。
  ⇒ `push-open-pr` **照搬不接线**，`notify` 归 Hermes，`merge` 整段不实现。
- **取舍**：`github.ts` 里 push / 开 PR 的代码**照搬但不接线**（不删）—— 整文件搬运才保得住测试基线（13 文件 / 206 声明 / 227 执行）与文档行号锚点，将来接 PR 零成本。

## 文档（当前有效，共 4 份 + 1 份副本）

| 文件 | 管什么 |
|---|---|
| `AGENTS.md` | 上下文入口：定性、文档地图、**硬性注意事项 22 条**（编号固定，新增内容勿打乱编号）、环境事实、工作约定、待定项 |
| `需求说明.md` | 需求、形态与边界、已确认决策 **D1–D8**、继承的设计决策、**路径约定**、已知设计缺口 |
| `里程碑规划.md` | M0/G/M1–M4 排期与出口验收、顺序论证、**附录 A 环境前置约束** |
| `借鉴清单.md` | 逐项能力从哪来、依赖、**测试去向（§7）**、**usage 形状风险（§9）** |
| `reference/` | **参考代码副本**（搬运原料）：86 文件 / 836 KB。**身份已脱敏、行号与原始实现逐行对齐**，项目文档里的 `文件:行号` 锚点全部指向它。读法见 `reference/README.md` |

辅助：`audit-test-baseline.py`（只读审计，`--repo` 必填、无内置路径）· `test-baseline.json`（基线快照）· `check-docs.py`（文档体检）

> 2026-09-18 已删除 `需求定位-v2.md` / `需求里程碑规划-v1.md` / `模块盘点-去Mastra后.md`，内容重写为上述 4 份。
> 需要旧版本时：`git show e1015c5:"<文件名>"`（重写前的存档点）。

## 文档写法约定（用户 2026-09-18 明确要求）

1. **不写具体路径** —— 本机绝对路径、部署目录、服务器地址与连接方式都不进文档；运行期路径一律来自配置；环境变量名不得带废弃框架 / 遗留命名的前缀。
   > 理由：交付形态是远程服务器上的服务，写死的机器路径在部署时必然变成错误。
2. **不写对比描述** —— 「作废了什么」「取代了谁」「上一轮判断错了」这类过程产物不进项目文档。这是个全新项目。
3. **不指向仓库之外** —— 所有代码引用都指向仓库内的 `reference/`，写法为 `相对 reference/src/mastra/ 的路径:行号`（如 `workflows/dev-workflow.ts:775`）。换机器就找不到的引用一律不留。
4. 文档保持 4 份；新内容归入现有文档，不新开文件。
5. **改完文档跑 `python check-docs.py`** —— 它已把「不指向仓库外」做成默认禁止词，退出码非 0 即有问题。

## 责任边界：飞书全归 Hermes（硬规则）

**飞书的一切都是 Hermes 的** —— 出入站、凭据、权限、长连接、卡片渲染、按钮去重。
- Hermes 原生能力（一手来源 `hermes-agent.nousresearch.com/docs`）：15+ IM 平台单一 gateway、飞书 **WS 模式**、出站 post/图片/文件、**卡片交互内建（15 分钟按钮去重）**、MCP client、cron、skills、hooks。
- **本项目只暴露事实**：MCP 工具返回值 + 日志 + SSE 状态页。**不写飞书代码、不碰凭据、依赖清单不含飞书 SDK。**
- `run:start` 由 `dev_start` 返回值天然覆盖；异常 / `run:end` 由 Hermes 侧 cron 消费。
- 不能用 MCP progress notification 做长推送：`dev_start` 有「**必须立即返回**」铁律。

> 此条曾被我在 2026-09-18 写错（把飞书凭据/长连接拉回本项目）。**推算责任划分前先确认对方平台的能力边界。**

## 能力来源（详见 `借鉴清单.md`）

- ✅ **直接借鉴 3,187 行 / 9 文件**：`adapters/github`(777) `log-store`(441) `progress`(436) `adapters/test-runner`(430) `agents/guard`(311，**纯函数勿破坏**) `adapters/repo-lock`(229) `adapters/state-db`(222) `adapters/dedup-store`(162) `skills/`(179)。零框架依赖，实测。
- 🔧 **改造 2,267 行 / 5 文件**：`workflows/dev-workflow`(1368) `agents/coding-agent`(325) `llm/providers`(245) `adapters/repo-registry`(191) `config`(138)。
- ❌ **不借鉴 1,337 行 / 11 文件**：洞察闭环 / 消息轮询 / 工具包装 / 需求解析 agent / HTTP 框架样板 / 装配层。
- 🆕 **必须新写 ~520–820 行**：顺序执行器 / `chat()` 直连 / MCP 工具面 / SSE 状态页 / 启动自检。**同步挂钩第一版不需要**（无上游），接真仓库时回来（~80 行）。
- **框架渗透点仅 13 处**，散在 9 个文件，其中 4 个是零业务逻辑的装配层。

## 会静默失败的点（最重要）

1. **`git fetch` 缺失**（**前提：常驻副本有上游远端**）→ 分支从**过期基线**建出、**不报错**（`github.ts:375-394` 用本地 base ref；`countAhead` `:403` 同源）。**第一版不触发；接真仓库立刻生效。**
2. **usage 形状退化** → 必须自建 V3 形状 `{inputTokens:{total,noCache,cacheRead,cacheWrite}, outputTokens:{total,text}}`；退化为 `null` 而 `null` 是设计内正确值 ⇒ **不报错**，成本报表永远「无量」。验证要**人工比对 SDK 原始 `result` 消息与落盘值**。
3. **模型名幻觉** → 「看着在跑但模型不对」。启动自检必须打印实际生效的 provider / baseURL / model，**即使端点不通也打印**。
4. **编码链显式覆盖被 settings 层压掉**（2026-09-19 实测定位 + 已修）→ `CODING_ANTHROPIC_*` **只注入子进程 env 时完全不生效**：CLI 读 `~/.claude/settings.json` 的 `env` 块，而**那一层压进程环境**。症状同 #3（看着在跑但打到别的端点），且**无报错指向配置层**。修法：**同时**给 `Options.settings`（flag 层，"highest priority among user-controlled settings"）；且**未显式配置时不得下发 settings**（空 `{env:{}}` 会盖掉用户配好的端点）。单测 `test/coding-env.test.ts`。见 AGENTS.md #23。
5. **未跟踪新文件的内容从不进 diff**（2026-09-19 真端点首跑暴露 + 已修）→ `git diff` 对未跟踪文件无从表达，而 `git add -A` 在**闸门之后**。症状 = **闸门恒判负**（需求「新增 X 文件」永远过不去 —— 正是核心用例）。修法：`renderUntrackedDiff` 渲染内容 + **保底预算**（不被大 diff 挤掉）。单测 `test/diff-untracked.test.ts`。见 AGENTS.md #24。
6. **编码步零改动照样 `step:done`**（同上 + 已修）→ 模型反问不动手时，闸门才说「需求未实现」，把「模型没动手」伪装成「实现不合格」——**归因错位**。修法：`codingChangeFailure` 纯函数**当场**判负 + 提示词写明无人值守/不要反问。单测 `test/coding-no-change.test.ts`。见 AGENTS.md #25。
7. **编码步上限从未被披露**（同上 + 已修）→ 被 `Reached maximum budget ($2)` 在 249s 掐断，自检却没提过；且该值是 CLI 算的**名义成本**，接中转站时**与实付无关**。修法：`codingLimits()` 单一来源，自检 / SDK 装配 / 步骤超时**三处同读**并打印。见 AGENTS.md #26。

> **七项的实测状态（2026-09-19）**：②usage 未退化（真端点一轮 4 次调用 / 1,649,667 in / 8,146 out，`run_cost` 与日志逐条相加一致、`unknownUsage=0`）；③启动自检无条件打印已实现；④⑤⑥⑦ 已修且有单测守住，且**都在真端点首跑中被实际撞到过**；① 仍待接真仓库时验。
>
> **结论**：「会静默失败」的清单**只会变长** —— 前四项是照搬/改造期预判出来的，后三项全是**真跑一次才暴露**的。**每跑一次真链路，就去清单里加一条。**

## 其他关键事实

- `@anthropic-ai/claude-agent-sdk` **已在依赖里**；`@libsql/client` 是 Turso 官方驱动（**不是框架组件**）；`state-db.ts` 那 5 处 `@mastra/libsql` **全是注释**。
- ⚠️ **`coding-agent.ts` 325 行的主体是安全设计**（fail-closed 围栏 `:192-260`、环境注入、凭据检测、受保护分支解析、bypass + 工具黑名单）—— **整块保留，勿重写**。
- **心跳已存在**（`dev-workflow.ts:745-760`，30s，环境变量可调，0 = 关闭）；缺口只是抽成可复用 + 覆盖测试步 + 扩 payload。
- 🧪 **`scripts/stub-endpoint.cjs` —— 确定性双协议假端点**（Anthropic `/v1/messages` 走编码链、OpenAI `/chat/completions` 走闸门链）。**这是把「管道通不通」与「端点通不通」拆开的关键杠杆**：真端点不可用（区域封锁 / 订阅失效）时仍能完整验链路。也能下发一条该被拦的命令来**验证围栏真的挂上了**（`--tool Bash --command 'rm -rf <哨兵>'` → 看 `guard:deny` + 哨兵存活）。
- ✅ **围栏 hook 在官方 SDK 下确认有效**（2026-09-19 实测）：`PreToolUse` hook 拦截生效、`guard:deny` 事件归属到 run。这条原本列在「已知风险」里，现已关闭。
- ✅ **M1+M2+M3 代码已完成并提交**（`f63d6ed` / `744e658` / `0f9e0b9` / `c4dc1ed` / `a47341b`）。口径：**18 套件 / 278 声明 / 347 执行**，全绿。
- ✅ **真端点整链已验通（2026-09-19）**：编码链走用户本机 Claude Code CLI 自己的配置，闸门链走 OpenAI 兼容直连。逐项：建分支 → CLI **真写文件** → test `passed=true` → review `approve` → **真产生提交**；base 分支未被改动。经 MCP `dev_start`（2ms 返回）触发同样全绿（`stepsDone=6/stepsFailed=0`）。**唯一入口已验。**
- ⚠️ **两条链的端点可以不同，且必须分别配**：闸门链**不能用本机 cc-switch 代理端口** —— 它只答 Anthropic 形状（`/v1/messages`），`/v1/chat/completions` 回「未配置供应商」（`{"error":{"message":"未配置供应商","type":"proxy_error"}}`）。闸门链要用服务商**官方 OpenAI 兼容端点**（DeepSeek 官方 baseURL **不带 `/v1`**）。
- ⚠️ **编码 CLI 会加载用户自己的 `~/.claude/settings.json`**：`enabledPlugins` / `hooks` 都在生效范围内（实测 agent 额外产出一份 `docs/superpowers/plans/…md`）。只覆盖 `env` 层不够 —— 完全隔离要用 `settingSources: []`，但那会一并关掉用户凭据通路。**待定项 Q-L。**
- ⚠️ **模型行为差异是真实的**：同一句需求，有的后端**反问**而不是动手（`num_turns=9`、0 次写文件），有的 138s 干完、有的要 376s。**提示词里的「无人值守、不要反问」是必需项**，不是客套。编码步超时与预算上限要按**最慢的后端**留余量。
- **测试基线**：参考副本 16 文件 / **222 声明 / 291 执行**（断言必须用「执行数」口径，`it.each` 展开多出 69 条）；副本里留 13 文件 + `jest.setup.ts` = **218 / 287**；新项目 **18 文件 + `jest.setup.ts` / 278 / 347**（相对副本基线 +60），删 16 条、新增 72 条。⚠️ **「去掉框架就能删掉大部分测试」不成立** —— 不借鉴的 1,337 行只对应约 12 条测试。第一版**不删 PR 相关测试**（代码照搬不接线）。
- **测试三个陷阱**：① 状态库路径的环境变量名原带框架前缀（**副本里已中性化为 `APP_DB_PATH`**，新项目按自己命名再收口一次）② `jest.setup.ts` **必须保留**（防单测污染生产日志）③ 被测试直接 import 的导出名要逐个确认没变（`runGate` / `ContextSchema` / `resolveProtectedBranchNames`）。
- **stage 埋点真位置** `progress.ts:355`（`stageStart`）/ `:406`（`runEnd`）；`:73-95` 是阶段名**闭集**（八步），照它找埋点会看错整段。
- **`repo-registry` 的 `localPath` 语义不变** —— 服务器上的固定 clone 目录就是它；但「target 里不得含机器路径」这条约束更强，必须保留。
- **`reference/` 脱敏的铁律**：只做**行内替换**、绝不增删行 —— 否则项目文档里的行号锚点会全部失效。将来若再动副本，必须沿用这条。

## 里程碑

`M0 前置就位(S) → M1 项目自立(L) → M2 只读接线(M) → G 门禁(S) → M3 编码贯通(L) → M4 决策收口(S)`

- **M0 无本项目代码**（飞书由 Hermes 打通）⇒「先飞书」**不提供早期信心**，早期可见成果在 M2。
- **M0 现在只要**：scp 通道可用 + **服务器本地演练仓就位**（第一版不需要真靶子仓库，Q-I 移出 M0）。
  - ✅ **验收 1 / 2 已过（2026-09-19 实测）**：scp 通道可用；服务器用户目录下已建**本地演练仓**（自建 git 仓、无上游），建分支 → claude 写代码 → 拓扑层提交 → `countAhead` 返回 1，全绿。仓库级 git 身份显式配置。
  - ⏳ **仍缺（2026-09-19 12:00 逐项实测核对）**：① **飞书通道**（验收 3）—— 三重证据确认**零凭据**：`~/.hermes/.env` 里 grep feishu|lark **无输出**、`channel_directory.platforms.feishu = 0`（只有 `weixin: 1`）、`config.yaml` 无 feishu 段；**唯一带外部审核等待的项，仍未动**。② **环境仓库软链**（验收 4）—— `~/.hermes/skills/` 下 `find -type l` 计数 **0**，全是实体目录，**方案未定**。③ **项目部署目录未定** —— M1 出口验收 1 要在服务器 `npm ci`，得先有落点；⚠️ **`~/code` 是被测仓，本项目代码不能混进去**。④ **本项目进程守护方式未定** —— 但有现成参照 `systemctl --user` 的 `hermes-gateway.service`（含 `.d/` 覆盖目录）。⑤ **Q-D / Q-H 收口**（Q-H 见下，实际已被 Q-J 绕过）。
- **M2 刻意零 LLM 依赖** ⇒ 与端点风险彻底解耦，端点未解决也能交付。**第一版 M2 无同步挂钩**。
- **G 是门禁不是里程碑**（只有过 / 不过，无交付物）。
- **M3 是唯一不可压缩段**；第一版终点是「本地提交 + 测试事实」，**不产出 PR**。
- 并行轨道：T1 定时巡检 / T2 第二批靶子仓库（= 接真仓库，第二版）。
- **M1 出口验收必须在服务器上跑** —— 适配器与测试执行器有平台分支，本机绿 ≠ 服务器绿。

## 环境（仅本地参考，不写进文档）

- **部署目标**：一台远程服务器，与 Hermes 同机。**连接方式见本地 SSH 配置，不入库。**
- 本机**没装 Hermes** ⇒ 环境侧改动无法本地预演。
- 本机代理只放通 `api.github.com` 与 `git clone github.com`；`raw.githubusercontent.com` = 502。
- 🔴 **服务器出口实测（2026-09-19）**：npm registry ✅ / **Anthropic 官方端点被区域封锁** ❌ —— `api.anthropic.com` 返回 403 `{"type":"forbidden","message":"Request not allowed"}`（Cloudflare edge），换浏览器 UA 仍 403 ⇒ **是 edge 层拦截、与 key 无关，配了合法 key 也照样 403**；`claude.ai/install.sh` 同为 "App unavailable in region"。
- 🔴 **GitHub 必须走 SSH，不能走 HTTPS**：TCP 全通但 `github.com` / `codeload` 的 **HTTPS 被 SNI 阻断**（同域名族的 `api.github.com`、`raw.githubusercontent.com` 反而通）；`ssh -T git@github.com` 返回 `Permission denied (publickey)` ⇒ **协议层通、仅缺 key**。已生成服务器 key（`~/.ssh/id_ed25519`）+ 配好 `~/.ssh/config`，并移除失效的 `ghproxy.com` insteadOf 重写。**所有第三方 git 镜像均失效**。第一版这些都用不上（D8 不碰远端）。
- Claude Code CLI **已装在该服务器**（用户级 `~/.local/bin/claude`，2.1.276）。对 Anthropic 官方端点直连不可用（见下），**改走 DeepSeek 兼容端点后已可用**。⚠️ `~/.local/bin` 只进交互式 shell，`ssh tencent 'claude ...'` 找不到 —— 但**实测用绝对路径（`/home/ubuntu/.local/bin/claude -p ...`）在非交互 shell 里完全可用**（返回 `SUBPROC`、exit 0）⇒ **M3 不需要 sudo 建 `/usr/bin` 软链，只要路径来自配置**（也正好符合硬性注意 #3：运行期路径来自配置）。
- ✅ **Q-J 已结清（2026-09-19）：走 DeepSeek 的 Anthropic 兼容端点** —— `https://api.deepseek.com/anthropic`（**不带 `/v1`**），一手来源 DeepSeek 官方文档。服务器实测该端点返回 **401 `authentication_error`**（请求抵达其认证逻辑），**与 Anthropic 官方 403 `forbidden`（edge 层区域拦截）性质完全不同** ⇒ **无区域封锁，不需中转 / 代理 / 换 SDK**。
  - **模型（用户 2026-09-19 指定）：全部统一为 `deepseek-flash`** —— opus / sonnet / haiku / 子 agent 四档用同一个名字（`ANTHROPIC_MODEL` + 三个 `ANTHROPIC_DEFAULT_*_MODEL` + `CLAUDE_CODE_SUBAGENT_MODEL` 全设它；可用 `DEEPSEEK_MODEL` 覆盖）。**`/models` 实测只有 `deepseek-flash` 与 `deepseek-v4-pro`**（`deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 弃用）。
  - 配置脚本：本仓库 `scripts/setup-claude-deepseek.sh`，服务器 `~/setup-claude-deepseek.sh`（已部署）。形态 = **改脚本顶部一行 key → `bash ~/setup-claude-deepseek.sh`**（也可 `DEEPSEEK_API_KEY=sk-xxx bash ...` 不改文件）。写 `~/.claude/settings.json` 的 `env` 段（mode 600、自动备份、幂等、`umask 077` 无宽权限窗口）；key 字符白名单防 JSON 注入；**未填 key 时 exit 2 明确拦截**；自带真实探测并打印服务端回带的 `model` 字段（覆盖「模型名幻觉」）。
  - ✅ **真 key 已验通（2026-09-19）**：`POST …/anthropic/v1/messages` → **HTTP 200**，服务端回带 `"model":"deepseek-flash"`（**模型名幻觉排除**）；`claude -p` 端到端返回 `PONG`、exit 0。
  - ⚠️ **`/models` 端点实测只有两个模型**：`deepseek-flash` / `deepseek-v4-pro` —— 官方文档里的 `deepseek-v4-flash` **不存在**（脚本的候选名提示已因此修正）。
  - ⚠️ **遗留**：Claude Code 报 `[claude-code:unrecognized_model]`（它不认识这个模型名，按 200k 上下文管理 auto-compact）—— 解法是模型名加 `[1m]` 后缀或设 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`，**功能不受影响**。**已不再是遗留**：非交互 shell 调 `claude` 的问题 —— 绝对路径可用（见上）。
- 🆕 **`~/code` 项目级 Claude 配置已就位（2026-09-19）**：`~/code/.claude/settings.json`（仓库副本 `scripts/claude-project-settings.json`）= `defaultMode: acceptEdits` + `allow` 列 12 个工具**裸名**（Bash / Read / Edit / Write / NotebookEdit / Glob / Grep / WebFetch / WebSearch / Agent / TaskStop / Monitor）。**实测无参数直接通过 Bash + Write + rm -rf + git、无提示**。
  - ✅ **用户 2026-09-19 决定并已落地：用户级也开 `bypassPermissions`** —— `~/.claude/settings.json` 加了 `permissions.defaultMode: "bypassPermissions"` + `skipDangerousModePermissionPrompt: true`（原文件备份 `settings.json.bak-20260919-115349` 保留）。**作用域 = 该服务器 ubuntu 用户的所有项目**。
  - 🔴 **两层都必要，别只配一层**：`auto` / `bypassPermissions` **从项目级 / 本地级设置不生效**（v2.1.257 起），会话回落 Manual。**决定性对照**：同一个 Write 提示词、同一个已信任目录 —— 项目级写它 → `被权限拒绝`；用户级写它 → 成功。
  - 规则语法：**裸工具名 ≡ `Tool(*)`**；`allow` **不接受** `"*"` / `"mcp__*"` 这类未锚定通配（会被跳过 + 启动警告）。优先级 **deny > ask > allow**，跨级 deny 不可被 allow 覆盖。
  - 🔴 **沙箱 ≠ 权限**（踩过一次）：`~/code` 在 `~/.claude.json` 里 `hasTrustDialogAccepted: true`；**未信任目录沙箱更严**，会以「只能写会话允许的工作目录」拦掉重定向。做权限对照实验前必须确认**只有一个变量在变**，且读准报错措辞——沙箱拒绝与权限拒绝是两条轴。
  - 🔴 **`WebFetch` 在本服务器不可用，与权限无关**：报 `Unable to verify if domain <X> is safe to fetch … blocking claude.ai` —— 它对**每个**域名都要先向 **claude.ai** 做安全校验，而 claude.ai 被区域封锁（与 `install.sh` 同源）。目标站点本身可达（`curl api.github.com` = 200）也照样失败。替代：走 **`Bash` + `curl`**（Bash 已放行）。`WebSearch` 同源，**很可能同样不可用 —— 未实测**。
  - 可复现脚本：`scripts/setup-claude-permissions.sh`（仓库 + 服务器 `~/setup-claude-permissions.sh`）—— 两层一次配齐、**幂等**、改前备份、现有 JSON 非法则拒绝覆写。
- 🆕 **服务器编码工作目录已就位（2026-09-19）**：服务器用户目录下的 `~/code`，**自建本地演练仓**（`git init`、无上游、仓库级身份 `pr-agent-lite <pr-agent-lite@example.invalid>`）。已在其中跑通 M0 验收 2：建分支 → `claude -p` 写 `calc.js` → 编排层提交 → `countAhead` = 1，全绿。⚠️ 此路径**不进项目文档**（硬性注意 #3），仅作本地操作记录。
- 🔴 **用户 2026-09-19 决定：服务器侧暂不配 GitHub 密钥**、**第一版不产出 PR**。服务器侧整条 git 通道（clone / fetch / push）归零 ⇒ 靶子侧相应改为**服务器本地仓**，不再需要投递。
- ✅ **bundle 投递通道已实测**（本机 `bundle create --all` → scp → 服务器 `git fetch <bundle> 'refs/heads/*:refs/remotes/origin/*'`，**两侧 SHA 一致**；本机 git 2.39.5 ↔ 服务器 2.43.0；建分支 / `countAhead` / commit 全通）。**第一版用不上，第二版接真仓库时启用** —— 已沉淀为 skill `.workbuddy/skills/server-git-bundle-delivery/`（含「用 bundle 不用 rsync 整目录」的理由与四个坑）。
- 🟡 **服务器默认无 git 提交身份**（`user.name` / `user.email` 皆空 —— `.gitconfig` 只有 `safe.directory` + `http.*`），而 `github.ts:557-590` 的 `gitCommit` **裸调** `git commit`。⚠️ **2026-09-19 实测推翻早先结论**：git 2.43.0 此时**不会报错**，会自动推导 `Ubuntu <ubuntu@localhost.localdomain>` 并**提交成功（exit 0，仅打警告）**；只有 `user.useConfigOnly=true` 或主机名不可解析时才 `exit 128 Author identity unknown`。⇒ **风险从「必失败」改成「静默写错身份」** —— 比报错更难发现。解法不变：**配置驱动显式带身份（推荐）** / 仓库级 / 环境注入。已更正 `AGENTS.md` §4、`借鉴清单.md`、`里程碑规划.md` 三处口径。

- ✅ **M1 在服务器上的安装路径已实测畅通（2026-09-19）** —— 这是 M1 出口验收 1（「服务器上 `npm ci && typecheck && test` 全绿」）此前的最大未知，因为参考副本依赖里有 **`@libsql/client`（Turso 驱动、带原生二进制）**，从没在服务器上装过。
  - `npm install`：**383 包 / 39s / exit 0**；`npm ci`（先生成 lockfile 再删 node_modules）：**384 包 / 8s / exit 0**。
  - 原生模块 **`node_modules/@libsql/linux-x64-gnu/index.node` 与 `linux-x64-musl/index.node` 均落地且能 load**；`@anthropic-ai/claude-agent-sdk@0.3.278` `require` 正常、导出齐全。
  - 落定版本：zod 4.6.5 · dotenv 17.4.2 · typescript 5.9.3 · jest 29.7.0 · ts-jest 29.4.12 · @types/node 20.19.43 · `@libsql/client` 0.17.4。
  - node_modules = **577M**；磁盘 **40G / 已用 13G / 余 26G（33%）**。服务器实测版本：node **v22.22.3** / npm **10.9.8** / git **2.43.0** / python **3.12.3**（⚠️ 文档写 python 3.13，与服务器不符；项目是 node，影响低）。
  - ⚠️ 探针在 `/tmp` 一次性目录里做的，**残留已清理**；`~/code` 未受影响。

- 🆕 **本机 Claude Code 通道已恢复（2026-09-19）**：早前 403「An active OpenCode Go subscription is required」的根因是 cc-switch 选中的 provider 订阅失效；用户换配置后本机 `claude -p` 正常（`is_error:false`）。**编码链由 CLI 自己读 `~/.claude/settings.json`**（→ cc-switch 本机代理 `127.0.0.1:15721` → 服务商），项目侧**不设** `CODING_ANTHROPIC_*` 即是生产路径。
- ⚠️ **本机 cc-switch 代理只答 Anthropic 形状**：`15721/v1/chat/completions` 回 `{"error":{"message":"未配置供应商","type":"proxy_error"}}`，`/v1/models` 回 `{"models":[]}`；**闸门链（OpenAI 形状）必须另找端点**。
- ⚠️ **provider 名单可读**：`~/.cc-switch/cc-switch.db`（sqlite，`providers` 表 `settings_config` = JSON，含 `env` 块）。**只读查询、脱敏打印** —— 是本机凭据现状最快的真相源。

## 仍未决

Q-D 第一版使用者范围（卡 M3）· Q-G 真实工期（需投入假设，否则只给 S/M/L）。
**Q-H 「服务器 Hermes 凭据能否与编码侧共用」实际已被 Q-J 绕过 —— 编码侧走 DeepSeek 独立 key，与 Hermes 的 provider 无关 ⇒ 答案 = 不共用、也不需要。可从「卡 G」降为已结清（四份文档里还挂着，待改）。**
**Q-I 接真靶子仓库是哪些** · **Q-K 代码平台写通道的落点**（服务端 REST Git Data API（**不需 key**）/ 开发机代提交）—— **两者都移出第一版，第二版再定**。
**Q-L 编码 CLI 要不要与用户 `~/.claude/settings.json` 隔离**（卡 M3 收口）：实测 `enabledPlugins` / `hooks` 都在生效范围内（agent 会额外产出计划文档、也会跑用户自己的 PreToolUse hook）。当前只覆盖 `env` 层；完全隔离要传 `settingSources: []`，但那会一并关掉用户凭据通路 —— 得先定凭据从哪来。

**待办（本机）**：✅ 早前那 8 项未提交已随 M1/M2/M3 提交清空；当前工作树干净（最新 `a47341b`）。**下一步是服务器侧**：部署 + M1 出口验收（必须在服务器上跑）+ Hermes 侧注册 MCP 工具。

**已结清（2026-09-19）**：① 代码与靶子仓库怎么进服务器 —— **本项目 scp 投递；靶子侧用服务器自建本地仓**（D3/D7）；② fetch 相关文档口径 —— 4 份文档已改完，`check-docs.py` 退出 0；③ 第一版产出边界 —— **不产出 PR**（D8）；④ **Q-J 服务器到 LLM 端点的出口** —— DeepSeek 的 Anthropic 兼容端点，真 key 实测调通（HTTP 200 + `claude -p` 返回 PONG）。
