# pr-agent-lite · 项目长期记忆

## 项目定性（2026-09-18 用户明确纠正，优先级最高）

**从 pr-agent 借鉴代码，在与 pr-agent 完全无关联的新项目里重建，部署到远程服务器；以飞书为交互入口 —— 先打通飞书，再通过飞书对接编码程序。被操作的代码仓库不是本地的，具体范围后续再定。**

三个不可省的定语：
- **借鉴，不是迁移** —— 抄代码，不搬运行中的系统、不兼容存量状态。可自由重组目录、删不要的部分。⚠️ **但测试基线要继承**（裁决 A6）：逐条判后留 206 条 / 删 16 条，不是「从零建」。
- **零关联** —— 不复用 pr-agent 的 git 历史、部署、运行链路、配置。**pr-agent 侧零动作**（不部署、不改造、不收口里程碑卡）。
- **部署到远程服务器** —— 交付形态从一开始就是服务器服务，不是本机工具。**没有「本机先跑通再搬」的退路。**

> ⚠️ 若看到「迁移」「pr-agent 收缩为执行器」「下线 pr-agent 飞书入口」「收口 M7/M8」这类表述，那是已被推翻的旧框架（见 `需求定位-v2.md` 的作废清单）。

## 环境

- 靶子服务器：`ssh tencent` 已配好（`49.234.190.37` / `ubuntu` / key `tencent_cloud`）。改动前先确认，勿擅自连。
- 本机**没装 Hermes**（`command -v hermes` 空、无 `~/.hermes/`）→ 环境侧改动无法本地预演。
- 本机代理只放通 `api.github.com` / 克隆 `github.com`；`raw.githubusercontent.com` = 502。

## 文档地图

| 文件 | 状态 |
|---|---|
| `AGENTS.md` | ✅ **上下文入口（2026-09-18 新建）**。含项目定性、文档地图、**硬性注意事项 18 条**、环境事实、工作约定、未决项 |
| `需求定位-v2.md` | ✅ **当前有效**，需求定性 + 裁决 A1–A5 + 继承/作废清单 |
| `需求里程碑规划-v1.md` | ✅ **当前有效**，M0/M1/M2/G/M3/M4 + 门禁 + 并行轨道 + 未决项归属；**附录 A = Hermes 环境维护模型**、**附录 B = 可见性盲点清单** |
| `模块盘点-去Mastra后.md` | ✅ **当前有效**，模块级分账 + 13 处渗透点 + 净新增；**附录 A = 代码锚点速查（修正版）**、**附录 B = 证据与置信表** |
| ~~`迁移方案与决策记录.md`~~ | ❌ **已于 2026-09-18 删除**（框架层作废）；仍有效内容已归并（§5→里程碑规划附录 A、§6.7→附录 B、§9+附录→模块盘点附录 A/B） |
| ~~`Hermes迁移-里程碑排期草案.md`~~ | ❌ **已删除**（基于「迁移运行中的 pr-agent」，与定性冲突） |
| ~~`需求分析评审-R1.md`~~ | ❌ **已删除**（前提已变）；事实层已并入模块盘点 §7/§8 |

> **恢复方式**：`git show 81223f4:"<文件名>"`（存档 commit，删除前）或 `git show 3860fc8:"<文件名>"`（init）。

## 里程碑（2026-09-18 重规划，见 `需求里程碑规划-v1.md`）

`M0 前置与收口(S) → M1 项目自立(L) → M2 只读接线+上服务器(M) → G 门禁(S) → M3 编码贯通(L) → M4 决策收口(S)`

- **M0 无本项目代码**：飞书↔Hermes 由 Hermes 持有 ⇒ 旧 P1「飞书贯通」**降级为环境前置**，本项目在飞书打通阶段几乎不写代码。**「先飞书」不再提供早期信心**，早期可见成果转移到 M2。
- **M1 出口验收必须在服务器上跑**（`github.ts`/`test-runner.ts` 有平台分支，本机绿≠服务器绿）。
- **M2 刻意零 LLM 依赖** ⇒ 与第一号风险（claude 端点）彻底解耦，可在端点未解决时交付。
- **G 不做成里程碑**：只有过/不过，无交付物；含服务器 claude 端点 + 程序侧 LLM 端点分别打印实际生效值 + 实跑一次。
- **M3 是唯一不可压缩段**，全部未核实项堆在其上游。
- **新决策 T1「推送通道三选一」**（M3 开工前必定，决定 `feishu.ts` 出站怎么写）：① 自持飞书 app 发卡 ② 复用 Hermes 的 app 凭据 ③ 走 MCP 进度通知 + 状态页链接。与 **Q-E** 是同一个决策。
- 并行轨道：T1 推送通道选型 / T2 Hermes cron 巡检 / T3 第二批靶子仓库。

## 已裁决（2026-09-18）

1. **Hermes 在服务器**，飞书 ↔ Hermes 交互，**只有触发特定逻辑才走我们的编码程序** ⇒ 新项目 = **MCP server + 编码执行器**；不需要飞书长连接、不需要对话/意图识别；`inbound-poll` / `insight-workflow` / `insight-agent` 直接删除。
2. **claude 端点验证推后**，等文档完全确认后再做 ⇒ 是 **P2b 开工前的最后一道门**，不并行。因回旋空间小，打印实际端点与模型要做成**常驻启动自检**。
3. **Mastra 完全不需要** ⇒ 渗透点仅 **13 处**、散在 9 个文件。分账：删 1,337 / 改造 2,267 / 原样借鉴 **3,187**（原 3,500，A5 减去 feishu 313）/ 净新增 600–900 行。详见 `模块盘点-去Mastra后.md`。
4. **靶子仓库需提前 clone 到服务器** ⇒ 工作区策略 = **常驻 clone**；运行时 clone 不需要。
5. **飞书 app 复用 pr-agent 的；本项目零飞书代码**（2026-09-18 16:53 追加裁决 A5）⇒ **`adapters/feishu.ts`(313) 整块不搬**（原样借鉴 3,500→**3,187 行 / 9 文件**）；**推送通道选型 T1 取消**；**Q-E 不再是本项目未决项**；我们**不持飞书凭据**、依赖清单不含飞书 SDK。

## ⚠️ 责任边界（硬规则，别再搞错）

**飞书的一切都是 Hermes 的：出入站、凭据、权限、长连接、卡片渲染、按钮去重。**
- Hermes 原生能力（一手来源 `hermes-agent.nousresearch.com/docs`）：15+ IM 平台单一 gateway（`hermes gateway`）、飞书 **WS 模式** + webhook 模式、出站 文本/Markdown→post/图片/文件、**卡片交互内建（按钮→`/card button` 命令，15 分钟去重）**、MCP client 内建、cron、skills、hooks、记忆。
- **我们只暴露事实**：MCP 工具返回值 + `log-store` + SSE 状态页。**不写飞书代码、不碰飞书凭据**。
- `run:start` 由 `dev_start` 返回值天然覆盖；异常 / `run:end` 由 **Hermes 侧 cron 轮询** `run_status` / 读 SSE 消费。
- 不能用 MCP progress notification 做长调用推送：`dev_start` 有「**必须立即返回**」铁律（跑几分钟会超时，`pr-agent` 09-17 记忆 :258）。

> 此条曾被我在 2026-09-18 16:50 写错（把飞书凭据/长连接/权限拉回本项目），用户 16:53 纠正。pr-agent 侧 09-17:346 / 09-18:35,39 早已裁过同样的结论 —— **推算责任划分前先确认对方平台能力边界**。

## 去 Mastra 的关键事实

- **可原样借鉴（零 Mastra 依赖，实测）**：`github.ts`(777) `log-store.ts`(441) `progress.ts`(436) `test-runner.ts`(430) `guard.ts`(311，**纯函数勿破坏**) `repo-lock.ts`(229) `state-db.ts`(222) `dedup-store.ts`(162) `skills/`(179) = **9 文件 / 3,187 行**。`feishu.ts`(313) **已划出**（飞书整块归 Hermes）。后两者原在 `src/mastra/` 下，**属误放**。
- **`state-db.ts` 不是 Mastra 组件** —— 那 5 处 `@mastra/libsql` 字样**全是注释**，真实依赖是 `@libsql/client`（Turso 官方驱动）。
- **`@anthropic-ai/claude-agent-sdk` 已在 dependencies 里**，换 SDK 不需新增依赖；`sdkOptions` 各项都是 SDK 原生字段。
- **删掉 `LibSQLStore` 的根据**：`index.ts:31-41` 自证它唯一用途是「跨进程 resume 等人工点合并」；merge 出范围 → suspend/resume 消失 → storage 消失。
- **`providers.ts` 只需删 `toMastraModelConfig`（:238-245）**，其余 240 行原样。`config.ts:107-127` 的 `logLlmConfig()` 即「打印实际生效端点与模型」的现成实现。

## 关键已知事实（借鉴代码时直接用）

- **pr-agent 无 clone 远程仓库能力**：全仓 grep `git clone|cloneUrl|gitUrl|cloneRepo` = 0 处实现。`dev-workflow.ts:52`「checkout 用本地 git 建分支」；`repo-registry.ts:12`「target 只描述哪个仓库，注册表才回答它在本机哪里」。
- 🔴 **常驻 clone 下 `git fetch` 是真正的净新增**：`createBranchVerified`（`github.ts:375-394`）执行 `git branch <branch> <base>`，**用本地 base ref、全程无 fetch** ⇒ 分支易从**过期基线**建出，PR 带旧基线且**不报错**。`countAhead`（`:403`）同源隐患。`gitDir()`（`:286-294`）已处理 `.git/worktrees/<name>`，worktree 策略有部分基础。
- **`adapters/feishu.ts` 只走 REST**（`tenant_access_token`，`:206`/`:247`），全文件无 WS、无 `createLarkChannel` → 新项目**只留出站发卡**。
- **飞书 app 配置可移植（pr-agent `.env` 实测）**：`FEISHU_APP_ID=cli_...`(20) / `FEISHU_APP_SECRET`(32) / `FEISHU_RECEIVE_ID=oc_...`(35，群 chat_id)。**出站零申请**（只需 `auth/v3/tenant_access_token/internal` + `im/v1/messages` + `im:message` 权限，已实测推送成功）；**入站不是现成** —— pr-agent 走**轮询** `GET /open-apis/im/v1/messages?container_id_type=chat`（`integrations/feishu.ts:32,40`），非事件订阅，且 `im:message.group_msg` 权限**实测缺失**（`pr-agent/.workbuddy/memory/2026-09-17.md:36`）→ Hermes 要长连接收消息仍需首次配置事件订阅 + 补权限。凭据是**租户级资产**，可复用（但属定性边界，需用户确认）。
- **飞书长连接是集群模式、不广播**（官方原文）：同一 app 多客户端时只有随机一个收到 ⇒ 同一 app 不能有两个 WS 消费者。pr-agent **从未用过 WS**、`feishu-poll` **是轮询不是 WS 消费者**（旧文档 §2.1 的「重复响应风险」说法失实）。
- **两条 LLM 链**：程序侧 `llm/providers.ts` 纯 env（🟢 零障碍上服务器）；编码侧 `coding-agent.ts` spawn `claude` CLI，凭据靠 cc-switch 代理（Windows 桌面程序）→ 🔴 **服务器 Linux 无此代理**。失败形态是「看着在跑但模型不对」，**验收必须打印实际生效端点与模型**。
- **`@mastra/claude` 已核查：极薄封装**（源码级，`node_modules/@mastra/claude@0.3.0/dist/index.js` 1,158 行未压缩）。`ClaudeSDKOptions = ClaudeQueryOptions`（类型别名，零扩展）；`runClaude()`（`:937-957`）把 `sdkOptions` **原样透传**给 SDK `query()`，只额外塞 `outputFormat` 与 `abortController`；**`supportsMemory()=>false`，无多轮**（`promptToText` 只把入参拍成字符串）；`resumeGenerate/resumeStream`（`:780-787`）只是把 `resume`/`continue` 折进 sdkOptions 的**糖**，续跑是 SDK 原生能力。1,158 行里约 1,000 行是 Mastra 适配（telemetry + ChunkType 流 + usage 形状），去掉 Mastra 后全不需要。⇒ `coding-agent.ts` 改造量 = **改约 50–80 行**（3 处：类型导入 / `createCodingAgent` 返回 sdkOptions 对象 / `dev-workflow.ts:764` 换 `query()`），**不是重写**。
- ⚠️ **`coding-agent.ts` 325 行的主体是安全设计不是 Mastra 代码**：`makeGuardHook`（fail-closed 围栏 `:192-260`）、`buildCodingEnv`、`missingCodingCredentials`、`resolveProtectedBranchNames`、bypass + disallowedTools 防御纵深 —— **整块保留，勿重写**。
- ⚠️ **换 SDK 的唯一静默风险 = usage 形状**：判据链 `dev-workflow.ts:775 → usageOf = r.usage ?? r.totalUsage (:243-247) → 拿不到写 null`。必须自己重建 V3 形状 `{inputTokens:{total,noCache,cacheRead,cacheWrite}, outputTokens:{total,text}}`；因为 `null` 是**设计内正确值**（`:240-241` 不把「取不到」当 0，`:769` 自陈中继常不回传），**退化后静默无报错**。
- **心跳已存在**：`dev-workflow.ts:745-760` 独立 `setInterval`（30s，`PR_AGENT_HEARTBEAT_MS` 可调）。缺口只是「抽成可复用 + 覆盖 test 步 + payload 扩到 jsonl 工具调用计数」。
- **可直接继承的设计决策**：判据归属（程序只产事实，`passed = llm.requirementMet`）、test 阻断保留 / review 不阻断、运行态判定表（有 `run:end` / 心跳新鲜 / 心跳陈旧）、SSE 状态页 + 三档推送、三级闸门（`readOnlyHint` / `elicitation` / `trust:untrusted`）、日志即真相源。`runGate` 的重试 + 失败原因回灌（`dev-workflow.ts:297-366`）是高价值资产。
- **测试基线（逐条判完，2026-09-18）**：pr-agent 是 **16 文件 / 222 声明 / 243 执行**（9 处 `it.each` 展开多出 21 条 —— **断言要用「执行数」口径**）。新项目 **13 文件 + `jest.setup.ts` / 206 声明 / 227 执行**，只删 16 条。⚠️ **「砍 Mastra 就能删掉大部分测试」不成立** —— 被删的 1,337 行源码只对应约 12 条测试，保留的 3,187 行对应约 189 条。核对工具：`audit-test-baseline.py`（`--diff` 对比）· 基线快照 `test-baseline-pr-agent.json`。
- **测试三个存量陷阱**：① `state-db.ts:30` 读 `MASTRA_DB_PATH`（去 Mastra 后必须改 env 名）② `jest.setup.ts` 重定向 `PR_AGENT_PROGRESS_FILE` 防单测污染生产日志，**文件必须保留** ③ 被测试直接 import 的导出名（`runGate`/`ContextSchema`/`resolveProtectedBranchNames`）改路径时要逐个确认没变。

## 仍未决

- Q-D 第一版使用者范围；Q-G 真实工期（需投入假设）；Q-H 服务器 Hermes 凭据能否与编码侧 `ANTHROPIC_*` 共用（**不要假定可复用**）；Q-I 靶子仓库具体是哪些（第一版只 1 个）。
- ✅ 已结清：Q-E 飞书 app（**复用 pr-agent 的，且本项目零飞书代码**，裁决 A5）· Q-F `ClaudeSDKAgent`（**极薄封装，改造约 50–80 行**，2026-09-18 源码级核查）· 测试基线（裁决 A6）。

