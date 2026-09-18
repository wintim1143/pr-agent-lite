# 模块盘点：去掉 Mastra 之后剩下什么

> **回答**：2026-09-18 用户第 3 问「新开的项目是否完全不需要 mastra，那剩下哪些部分」
> **同时落实**：裁决 1（Hermes 在服务器）、裁决 2（claude 验证推后）、裁决 4（项目提前 clone 到服务器）
> **方法**：逐文件提取 import + 逐调用点定位 Mastra API，全部基于 `pr-agent` HEAD `d872712` 实测，非推断
> **2026-09-18 16:53 修正**：`adapters/feishu.ts`(313) **从借鉴清单划掉** —— 飞书出入站/卡片/渲染/去重全部是 Hermes 的（Hermes 有原生飞书 gateway），我方零飞书代码。原样借鉴 3,500 → **3,187 行 / 9 文件**。

---

## 0. 结论

**Mastra 可以完全去掉，而且影响面比预想小得多。**

Mastra 的渗透点只有 **13 处调用点、散落在 9 个文件**；其中 4 个文件是「零业务逻辑的装配层」（删了不影响任何能力）。真正的业务资产（围栏、判据、埋点、日志、并发锁、Git 操作、测试执行）**一行 Mastra 都不依赖**。

去掉后剩下的东西分四类，行数**精确配平**（总计 7,104 行 = `src/` 全部 TS/MD 行数 − README 523 行）：

| 类别 | 行数 | 文件数 |
|---|---|---|
| ❌ **直接删除**（Mastra / Midway 装配层 + 超出范围的功能） | **1,337** | 11 |
| 🔧 **改造后借鉴**（改 4 处入口点，内部逻辑保留） | **2,267** | 5 |
| ✅ **原样借鉴**（零 Mastra 依赖，实测） | **3,187** | 9 |
| 🆕 **净新增**（pr-agent 里不存在，必须新写） | 约 **600–900** | 6 类 |

---

## 1. 依赖层

| 动作 | 包 | 说明 |
|---|---|---|
| ❌ 删 | `mastra` | CLI，只为 `mastra dev` / Studio |
| ❌ 删 | `@mastra/core` | `Agent` / `createStep` / `createSkill` / `Integration` / `createTool` / `Workflow` |
| ❌ 删 | `@mastra/claude` | `ClaudeSDKAgent` —— 薄封装，见 §2.2 |
| ❌ 删 | `@mastra/libsql` | `LibSQLStore`，只为跨进程 resume |
| ❌ 删 | `@mastra/koa` | `MastraServer`，挂自动路由 |
| ❌ 删 | `@midwayjs/bootstrap` `core` `info` `koa` `logger` `validation` `validation-joi` | 企业级 HTTP 框架，对单个服务过重；工具面走 MCP 不需要它 |
| ✅ **留** | `@anthropic-ai/claude-agent-sdk` ^0.3.258 | **已经在 dependencies 里了** —— 换 SDK 不需要新增依赖，只换入口函数 |
| ✅ 留 | `@libsql/client` | **不是 Mastra 的**，是 Turso 官方驱动，`state-db.ts` 直接用（见 §3） |
| ✅ 留 | `zod` `dotenv` `joi`(可去) | zod 是契约层，核心资产 |
| 🆕 新增 | MCP SDK（`@modelcontextprotocol/sdk`）或 node 内置 `http` | 工具面 + SSE 状态页 |

---

## 2. 文件层三分

### 2.1 ❌ 直接删除 —— 1,337 行 / 11 个文件

| 文件 | 行数 | 为什么删 |
|---|---|---|
| `workflows/insight-workflow.ts` | 307 | 洞察闭环 → **交给 Hermes 对话**（裁决 1 的直接结论） |
| `adapters/inbound-poll.ts` | 224 | 飞书轮询入口 → **Hermes 独占飞书**（裁决 1） |
| `integrations/github-readonly.ts` | 209 | Mastra `Integration` + `createTool` 包装。**内部 client 逻辑要抢救，见 §3** |
| `agents/dev-agent.ts` | 106 | Mastra `Agent` + `createSkill`。**6 段 skill instructions 是资产，见 §3** |
| `configuration.ts` | 38 | Midway 装配（含 `registerMastra()` 调用） |
| `mastra/index.ts` | 56 | `new Mastra({storage, agents, workflows})` 装配 |
| `mastra/server.ts` | 24 | 把 Mastra 自动路由挂到 Midway Koa |
| `mastra/agents/insight-agent.ts` | 24 | 洞察 agent（同 insight-workflow） |
| `middleware/report.middleware.ts` | 23 | Midway |
| `config/config.default.ts` | 15 | Midway 配置装配 |
| `service/user.service.ts` | 14 | Midway 示例服务 |
| `filter/default.filter.ts` | 12 | Midway |
| `filter/notfound.filter.ts` | 10 | Midway |
| `controller/home.controller.ts` | 9 | Midway 示例路由 |
| `controller/api.controller.ts` | 98 | Midway 路由（含要退役的 `/insights/feishu-poll`） |
| `config/config.unittest.ts` | 7 | Midway |
| `interface.ts` | 6 | Midway 类型占位 |
| `skills/merge-pr/SKILL.md` | 20 | merge 已移出范围（到 PR 为止） |

> 注：controller/filter/middleware/service/config/interface 这一组（共 232 行）整体是 Midway HTTP 样板。

### 2.2 🔧 改造后借鉴 —— 2,267 行 / 5 个文件

**改动量极小，因为「Mastra 只碰了入口，没碰内部」。**

| 文件 | 行数 | 只改这一处 | 保留的部分 |
|---|---|---|---|
| `workflows/dev-workflow.ts` | 1368 | `createStep({...})` × 8 → 普通 `async function`；`new Workflow().then()×8.commit()`（`:1354-1368`）→ 顺序执行器；`merge` 步（`:1252-1344`）整段删除（含 `suspend()`/`resumeData`） | **判定逻辑、`runGate` 重试与失败回灌、`StepFailError` 单出口语义、并发锁、埋点、终止语义 —— 全部保留** |
| `agents/coding-agent.ts` | 325 | `:282` `await import('@mastra/claude')` 的 `ClaudeSDKAgent` → `@anthropic-ai/claude-agent-sdk` 的 `query()`。**`sdkOptions` 里每一项（`cwd`/`env`/`permissionMode`/`allowedTools`/`disallowedTools`/`hooks`/`maxTurns`/`maxBudgetUsd`）都是 SDK 原生字段**，且 `HookCallback`/`SyncHookJSONOutput` 类型已从 SDK 导入（`:6`） | `getRepoRoot`、`missingCodingCredentials`（cc-switch 代理那条历史坑）、`buildCodingEnv`（`API_TIMEOUT_MS` 注入）、`resolveProtectedBranchNames`、`makeGuardHook`（fail-closed） |
| `llm/providers.ts` | 245 | **只删 `toMastraModelConfig()`（`:238-245`）+ `:1` 的 type import** | 其余 **240 行**：provider 注册表、解析、校验、「模型名静默回落」警告、「是否带 `/v1`」的 provider 级事实 |
| `adapters/repo-registry.ts` | 191 | `localPath` 语义（见 §6.3）；`repoRoot()` 新增 fetch 挂钩 | `owner`/`repo`/`baseBranch` 的「逻辑标识 vs 本机事实」分层、**未知 repoKey 显式报错不降级**、空注册表不静默退化 |
| `mastra/config.ts` | 138 | 删 `llmModelConfig = toMastraModelConfig(...)`（`:77`） | **`logLlmConfig()`（`:107-127`）要抢救** —— 它正是裁决 2 需要的「启动时打印实际生效 provider/model/baseURL」（M6-1 已实现） |

### 2.3 ✅ 原样借鉴 —— **3,187 行 / 9 个文件**

> 原为「3,500 行 / 10 个文件」，**减去 `adapters/feishu.ts`(313)** —— 飞书整块归 Hermes（裁决 A5），本项目零飞书代码。

**实测 `@mastra` import 计数为 0。**

| 文件 | 行数 | 作用 | 注意 |
|---|---|---|---|
| `adapters/github.ts` | 777 | Git 分支创建 / commit / push / PR 创建 | ⚠️ `createBranchVerified`（`:375`）用**本地** `base` ref，**无 fetch** —— 见 §6.3 |
| `core/log-store.ts` | 441 | 结构化日志真相源（状态页读它重建时间线） | 原路径 `src/mastra/log-store.ts`，**误放在 mastra/ 下，实为零依赖** |
| `core/progress.ts` | 436 | stage 埋点（`stageStart` :355 / `runEnd` :406） | 同上，误放 |
| `adapters/test-runner.ts` | 430 | 真跑测试（产事实），含平台分支 | |
| `agents/guard.ts` | 311 | 围栏判定 | ⚠️ **刻意是纯函数**（不 IO、不读 env），搬运不得破坏 |
| `adapters/repo-lock.ts` | 229 | 并发锁（临界区 = checkout → push） | 依赖 `state-db`；常驻 clone 下**升级为必需品**，见 §6.3 |
| `adapters/state-db.ts` | 222 | SQLite 连接 + `INSERT OR IGNORE` 原子认领原语 | **不是 Mastra 组件**（用 Turso `@libsql/client`），只是恰好与 Mastra 共用库文件 —— 那个理由现在消失，它变成「项目自己的库」 |
| `adapters/dedup-store.ts` | 162 | 幂等账本（事件 → run 索引） | 原用途是飞书消息去重；**改为 dev_start 触发幂等** |
| `skills/`（6 个 SKILL.md + 2 个 references） | 179 | 需求解析 / 编码 / 测试 / 审核 / commit message 的规范存档 | 与 `dev-agent.ts` 内联的 `createSkill` 是**同一份内容的两处副本** —— 整合成一处 |

---

## 3. Mastra API 渗透点全清单（13 处）

**这就是「去 Mastra」的全部工作量。**

| # | Mastra API | 位置 | 替代 |
|---|---|---|---|
| 1 | `new Mastra({storage, agents, workflows})` | `index.ts:43` | 删除（无对应物） |
| 2 | `new LibSQLStore({...})` | `index.ts:44` | 删除 —— 它存在的唯一理由是「跨进程 resume 等人工点合并」（`:31-41` 自证）。**merge 移出 → suspend/resume 消失 → storage 消失** |
| 3 | `import type { Mastra }` | `dev-workflow.ts:3` | 删除 |
| 4 | `mastra.getAgent('dev-agent')` | `dev-workflow.ts:303` | 🆕 `chat(systemPrompt, prompt)` 函数 |
| 5 | `agent.generate(prompt)` → `res.text` | `dev-workflow.ts:334` | 🆕 `fetch(baseURL + '/chat/completions')` |
| 6 | `res.usage ?? res.totalUsage` | `dev-workflow.ts:243-247` | OpenAI 响应的 `usage` 字段（形状几乎相同） |
| 7 | `createStep({id, inputSchema, outputSchema, execute})` | `dev-workflow.ts` × 8 | 🆕 `async function(ctx): Promise<Ctx>` |
| 8 | `new Workflow({...}).then()×8.commit()` | `dev-workflow.ts:1354-1368` | 🆕 30 行 `for` 循环 |
| 9 | `suspend()` / `resumeData` | `dev-workflow.ts:1252-1344`（merge 步） | 删除（随 merge 出范围） |
| 10 | `new Agent({...})` + `createSkill({...})` × 6 | `dev-agent.ts:18-106` | 删除装配；**instructions 文本搬进 `llm/prompts.ts`** |
| 11 | `Integration` 基类 + `createTool({...})` × 6 | `integrations/*.ts` | 删除 wrapper；**zod schema 直接复用于 MCP 工具注册** |
| 12 | `MastraServer` | `server.ts:18` | 删除 |
| 13 | `OpenAICompatibleConfig` / `ClaudeSDKAgent` | `providers.ts:238`、`coding-agent.ts:282` | 前者删除（直接拼 fetch body）；后者换 SDK `query()` |

**顺带说明两个「看着像 Mastra、其实不是」的误判点：**

- `adapters/state-db.ts` 有 5 处 `@mastra/libsql` 字样 —— 全是**注释**（解释为什么共用库文件），真实 import 是 `@libsql/client`。**它不是 Mastra 组件。**
- `llm/providers.ts` 的注释里反复提 Mastra 的 `/chat/completions` 拼接行为 —— 那是在**引用 Mastra 的行为作为事实依据**（provider 是否该带 `/v1`），代码本身只有 1 处 type import。

---

## 4. 🆕 净新增（pr-agent 里不存在，必须新写）

| 类别 | 规模 | 说明 |
|---|---|---|
| **顺序执行器** | ~30 行 | 替代 `createStep`/`.then()` 链 |
| **`chat()` 直连 LLM** | ~60 行 | 替代 `agent.generate()`；含结构化输出（prompt 强制 JSON + 抽取 + zod 校验，这套逻辑 `dev-workflow.ts` 已有可搬） |
| **MCP 工具面** | ~200 行 | `repo_list` / `run_status` / `run_cost` / `dev_start`（+ `dev_decide` 若入范围）；zod → JSON Schema |
| **SSE 状态页** | ~150 行 | node 内置 `http`，零依赖；读 `log-store` 重建时间线 |
| **clone/fetch 引导** | ~80 行 | 见 §6.3，比上一轮判断**小得多** |
| **启动自检** | ~20 行 | 打印实际生效的 LLM 端点与模型（`logLlmConfig` 基础上扩展） |

---

## 5. 新项目结构

```
pr-agent-lite/
├── src/
│   ├── adapters/            ← 借鉴：github / test-runner / repo-lock / state-db / dedup-store
│   │   ├── repo-registry.ts ← 借鉴 + 改 localPath 语义
│   │   └── workspace.ts     ← 🆕 常驻 clone 的 fetch/校验/引导
│   ├── core/                ← 原 src/mastra/ 下被误放的零依赖模块
│   │   ├── guard.ts         ← 借鉴（保持纯函数）
│   │   ├── progress.ts      ← 借鉴
│   │   └── log-store.ts     ← 借鉴
│   ├── llm/
│   │   ├── providers.ts     ← 借鉴 − toMastraModelConfig
│   │   ├── chat.ts          ← 🆕 直连 /chat/completions
│   │   └── prompts.ts       ← 🆕 从 dev-agent.ts 抢救的 6 段 instructions
│   ├── coding/claude.ts     ← 借鉴 coding-agent.ts，换 SDK 入口
│   ├── steps/               ← 6 步：sync → coding → test → review → commit → push-open-pr
│   ├── runner.ts            ← 🆕 顺序执行器
│   ├── skills/              ← 借鉴 5 个 SKILL.md（merge-pr 去掉）
│   ├── tools/               ← 🆕 MCP 工具面
│   └── status-server.ts     ← 🆕 SSE 状态页
├── test/                    ← 借鉴 13 个测试文件 + jest.setup.ts（206 声明 / 227 执行，见 §7）
└── .env.example
```

> `sync` 替代原 `checkout`：常驻 clone 下语义是「fetch + 建分支」，不是「clone」。

---

## 6. 落实三条裁决

### 6.1 裁决 1 —— Hermes 在服务器，飞书 ↔ Hermes，只有特定逻辑才走编码程序

**这直接确定了三件事，全部简化：**

| 影响 | 结论 |
|---|---|
| 新项目**不需要飞书长连接** | Hermes 持 WS + 出站 + 卡片交互（全部内建）。**`adapters/feishu.ts` 整块不搬**（2026-09-18 修正：出站也归 Hermes，我们只暴露事实 —— 见 `需求里程碑规划-v1.md` §3.7） |
| 新项目**不需要对话/意图识别** | Hermes 的 LLM 决定调哪个工具；新项目只暴露工具面 + 执行 |
| `inbound-poll.ts` + `insight-workflow.ts` + `insight-agent.ts` **确定删除** | 共 555 行，不需要「交给 Hermes」的过渡，直接不写 |
| 新项目**是 MCP server**，形态确定 | 这是 M12 那个「MCP 实现选型 spike」的答案前提 —— 但选型本身仍未核实（`@mastra/mcp` 已不需要，因为 Mastra 整体去掉 → **MCP 实现选型自动收敛为官方 SDK**，原来两个选项变成一个） |

### 6.2 裁决 2 —— claude 验证推后

**落实**：从「与 P1 并行」改为「**文档确认完全后再做**」。这意味着：

- 风险性质变化：不再是「P2b 前必须验完」，而是**整个第二阶段开工前的最后一道门**。
- 因为推后，**「验收必须打印实际生效端点与模型」这条反而更重要** —— 验证动作被推迟到开工前一刻，一旦有问题，回旋空间比并行验证小。建议把这个打印做成**启动自检的常驻能力**（`logLlmConfig` 已实现大半），而不是一次性脚本。
- 与裁决 1 交互：Hermes 在服务器 ⇒ 服务器上是否已有其他 LLM 凭据（Hermes 自己的）需要留意，**不要假定可复用** —— 编码侧要的是 `ANTHROPIC_*`，与 Hermes 用的 provider 未必同源。

### 6.3 裁决 4 —— 项目提前 clone 到服务器 ⇒ **上一轮的判断要收窄**

**上一轮我说「clone 能力是净新增、零继承」，在「提前 clone」前提下这个判断过宽，需要修正：**

| 项 | 修正后的判断 |
|---|---|
| 运行时 clone 能力 | ❌ **不需要**（用户已裁决提前 clone）→ 上一轮判的「净新增」**大部分撤销** |
| 目录校验 | ✅ **已有**：`getRepoRoot()`（`coding-agent.ts:53-70`）已会抛「目录不存在」/「不是 git 仓库(缺 .git)」 |
| 🔴 **`git fetch`** | ✅ **这才是真正的净新增，且必须做**。`githubCheckout` → `createBranchVerified`（`github.ts:375-394`）执行的是 `git branch <branch> <base>` —— **用的是本地 `base` ref，全程没有 fetch**。在常驻 clone 上，`base` 是**上次 fetch 时的样子** ⇒ 分支从**过期基线**建出 ⇒ **PR 带着旧基线、不报错**。同类隐患在 `countAhead(root, base, branch)`（`:403`）—— 基线旧了，领先提交数也算错 |
| 并发 | ✅ **设计已适配**：`dev-workflow.ts:657-659` 的锁在**建分支之前**拿，临界区覆盖 checkout→push。常驻 clone 意味着多 run 共享同一工作树，这个锁从「好设计」升级为**必需品** |
| worktree 支持 | ✅ **已有痕迹**：`gitDir()`（`:286-294`）显式处理 `.git/worktrees/<name>` —— 若将来要「每 run 一个 worktree」的隔离策略，部分基础已在 |

**结论**：裁决 4 把「工作区策略」从三选一**收敛为常驻 clone**，净新增只剩 **fetch 挂钩 + 部署期 clone 引导**（约 80 行），比上一轮估计的小一个量级。

---

## 7. 测试的去向（逐条判完，2026-09-18 复核）

> **复核工具**：`audit-test-baseline.py`（只读）。`python audit-test-baseline.py` 出全表；
> `--json` 存基线；`--diff test-baseline-pr-agent.json` 与基线对比。
> 基线快照已存为 `test-baseline-pr-agent.json`（17 条记录）。**M1 搬完后用它核对条数** ——
> 少搬一个文件也可能「测试全绿」。

### 7.0 先纠正基线口径：声明数 ≠ 执行数

上一轮说的「222 条」是**声明行数**，不是实际执行数。实测两套口径：

| 口径 | 数值 | 说明 |
|---|---|---|
| 声明 | **222** | 源码里 `it(` / `it.each(` 的出现次数 |
| **实际执行** | **243** | `it.each` 按数据组展开（9 处共多出 **21** 条：guard.test.ts 8 处 → +12，test-runner.test.ts 1 处 → +9） |

> 之前「213 vs 222，差值 9 = `it.each` 处数」这个说法**不准确**：差值是处数没错，但正确结论是「222 声明 → 243 执行」，差值 21 条。**新项目的基线断言应当用「执行数」口径**，否则 CI 里跑出来的数字对不上。

### 7.1 结论：只能删 16 条（约 6.5%），不是「大部分」

**净结果：16 文件 → 13 个测试文件 + `jest.setup.ts`；222 → 206 条声明（243 → 227 条执行）。**

| 去向 | 文件（条数=声明） | 条数 | 判断依据 |
|---|---|---|---|
| ❌ **整删** | `storage.test.ts`(2) `api.test.ts`(1) `home.test.ts`(1) | **4** | 前者直接 `import { Mastra } from '@mastra/core'` 测 storage/suspend；后两个只 import `@midwayjs/*`，而 Midway 样板整块删 |
| ✂️ **部分删** | `entry-idempotency.test.ts`(16 → 留 6) | **10** | 逐条拆见 7.2 |
| 🔧 **需改逻辑** | `llm-providers.test.ts`(20 → 18) `guard-hook.test.ts`(3) `state-db.test.ts`(12) | **2 删 + 15 改** | 见 7.3 |
| ✅ **零逻辑改动** | `guard`(34) `repo-registry`(33) `log-store`(19) `test-runner`(19) `progress`(17) `github-adapter`(15) `repo-lock`(13) `dev-gate-contract`(10) `m5-target-contract`(7) | **167** | 只改 import 路径，断言与用例标题全部照用 |

### 7.2 `entry-idempotency.test.ts` 逐条拆（16 条）

| describe / 位置 | 条数 | 去向 | 理由 |
|---|---|---|---|
| `state-db`（:81）「库路径与 Mastra 同源：读 `MASTRA_DB_PATH`」 | 1 | ❌ 删 | 去掉 Mastra 后这个 env 名必须改（`state-db.ts:30` 实测读 `MASTRA_DB_PATH`），断言前提消失 |
| `AC-2：原子认领`（:88）首次/并发/空 key/按来源过滤/runId 回填 | 5 | ✅ **全留** | `dedup-store.ts` 原样借鉴，原子性是 M3 验收第 5 条（同需求发两次只起一个 run）的直接支撑 |
| `AC-3：游标只前进不后退`（:127） | 2 | ❌ 删 | 游标是**轮询**状态机，随 `inbound-poll` 删除 |
| `AC-1：同一 messageId 连续投递 3 次只起 1 个 run`（:145） | 3 | ❌ 删 | 三条都调 `pollInboundOnce`（`inbound-poll.ts:27` 导入） |
| `窗口选择与空消息`（:195） | 4 | ❌ 删 | 窗口回溯 / 空消息推游标 / 拉取失败，全是轮询概念 |
| `fail-closed：去重存储不可写时拒绝起 run`（:253） | 1 | ✅ **留** | 「去重坏了不降级为继续跑」在新项目同样成立，且更靠前（触发方变成 Hermes） |

### 7.3 需要改逻辑的三处

| 文件 | 改动 | 备注 |
|---|---|---|
| `llm-providers.test.ts` | 删 `describe('toMastraModelConfig')` 2 条（`:129`/`:136`） | 该函数本身就是 §6 里唯一要删的导出；其余 18 条全留。⚠️ `:51` 那条标题里写着「与 Mastra 内部 `withoutTrailingSlash` 对齐」，**断言有效**（去尾部斜杠是通用需求），只改标题措辞 |
| `guard-hook.test.ts`(3) | 断言形态可能要调 | 测 `makeGuardHook` 返回的 hook 对象；`runClaude()` 换裸 `query()` 后 hook 的**包装壳**变了，但 `makeGuardHook` 函数本体与 3 条断言逻辑（deny 行为）应原样能用 |
| `state-db.test.ts`(12) | 其中涉及 `stateDbPath()` 的改 env 名 | `state-db.ts:30` = `process.env.MASTRA_DB_PATH ?? cwd()/mastra.db` → 新项目须改名（如 `LITE_STATE_DB`） |

### 7.4 一条全局机械改动（14 个存活文件全中，不属「逻辑改动」）

`src/mastra/` 与新 `test/mastra/` 的目录名在新项目里都不存在了，因此：

- 每个文件的 `from '../../src/mastra/...'` 要批量重写
- `jest.setup.ts` 的 `PR_AGENT_PROGRESS_FILE` env 前缀要改（**文件本身必须保留** —— 它防的是「单测往生产日志写事件导致判据污染」，`log-store` 是真相源这个前提下这条在新项目同样致命）
- ⚠️ 这是**纯机械 sed 可做**的，但**必须逐个文件确认导出名没变**（`dev-workflow` 的 `runGate`/`ContextSchema`、`coding-agent` 的 `resolveProtectedBranchNames` 等被测试直接 import 的符号）

### 7.5 为什么删不动 —— 值得记住的结构性事实

被删的源码与测试完全不匹配，方向**和直觉相反**：

| 分组 | 源码行数 | 对应测试条数 | 覆盖密度 |
|---|---|---|---|
| ❌ 删除的文件 | **1,337**（11 文件） | 约 **12**（`entry-idempotency` 的 10 + `storage` 的 2） | 极低 —— `insight-workflow`(307) / `insight-agent`(24) / `integrations/github-readonly`(209) / `dev-agent`(106) / `index`(56) **测试数为 0** |
| ✅ 原样借鉴的文件 | **3,187**（9 文件） | 约 **189** | 高 —— `guard` 46 条守 311 行、`repo-registry` 33 条守 191 行 |

⇒ **要删的代码恰恰是测试覆盖最薄的部分；测试资产几乎全压在要保留的代码上。** 这是「借鉴时白得一套回归网」的好消息，也是「删不动」的根本原因 —— 不是测试冗余，是**被砍的功能本来就没测过**。

### 7.6 `repo-registry.test.ts`(33) 的一个判后修正

33 条里有 **7 条**（`AC-6：不传 target 时行为与 M4 逐字一致` 4 条 + `旧 env 与注册表冲突检测` 3 条）表面是「向后兼容 pr-agent 的旧 env」，容易被判成可删。**逐条看过后结论是「留、但要改措辞」**：

- `:257`「env 指的是**别的**仓库 → 不比对（否则多仓库下必然误报）」是**多仓库正确性**，不是兼容性
- `:238`/`:246` env 与注册表**双源冲突报错**：新项目同样会有 env 配置，双源冲突检测仍然必要
- `:294-:317` 的 4 条实质是「**单仓库模式不回归**」—— 新项目第一版只服务 1 个靶子仓库，单仓库是**主路径**，这 4 条反而更关键；只需把「与 M4 逐字一致」这个表述基准换掉

> 另：`repo-registry` 的 `localPath` 语义**不必重写**（修正 §6 的旧判断）—— 「靶子仓库提前 clone 到服务器」意味着服务器上的固定 clone 目录就是 `localPath`，语义不变，只是取值变成服务器路径。AC-5「target 里不得含本机路径（快照要跨机器）」在新项目里约束更强，**必须保留**。

### 7.7 净变化不是「只减」

新增方向的缺口（M1 出口验收第 5 条已列）：**`usage` 形状收敛函数的三情形单测**（有 usage / 缺字段 / 无 usage）—— 这是唯一一处「去掉 Mastra 后必须补测」的地方，因为失败形态是静默的。

---

## 8. 需要修正的上一轮结论（诚实清单）

| # | 上一轮我说的 | 修正 |
|---|---|---|
| 1 | 「clone 能力是净新增、零继承」 | **过宽**。裁决 4 下只需 `git fetch` + 部署期引导（~80 行） |
| 2 | 「MCP 实现选型两个方案都未核实」（§7-11） | **自动收敛**：Mastra 整体去掉后，只剩官方 MCP SDK 一个选项 |
| 3 | 「`state-db.ts` 有 5 处 `@mastra/libsql` 引用，须复核耦合」 | 复核完成：**全是注释**，真实依赖是 `@libsql/client`。它不是 Mastra 组件，可原样借鉴 |
| 4 | 「`adapters/` 零 Mastra 依赖不成立」 | 复核完成：**结论要分开说** —— `state-db.ts` 零 Mastra 依赖成立（libsql ≠ mastra），`integrations/` 才是真有 Mastra |

---

## 9. 核查结清：`@mastra/claude` 的封装厚度（原低置信项，2026-09-18 已查）

> **结论：薄封装，且比预期更薄。`coding-agent.ts` 的改造量 = 改约 50–80 行 + 一处 usage 形状适配。**
> 「改 10 行」偏乐观，「重写 325 行」完全不成立。
>
> **证据等级：源码级**。实读 `pr-agent/node_modules/@mastra/claude@0.3.0/dist/`（`index.js` 1,158 行未压缩 / `index.d.ts` 71 行 / `utils.d.ts` 146 行）+ `coding-agent.ts` 消费侧。**非推断**。
> 包在本地、未压缩，核查是一次只读、零网络、几分钟的动作 —— 这正是它该在 M0 就做掉的理由。

### 9.1 当初怀疑的三项，逐条有答案

| 怀疑 | 裁决 | 证据 |
|---|---|---|
| **memory** | ❌ **没有** | `supportsMemory() { return false; }` —— `index.js:703-705` |
| **多轮对话** | ❌ **没有** | `generate()` 里 `promptToText(messages)`（`:707`）只把入参拍成**一个字符串**，无历史管理 |
| **session 续跑** | ⚠️ **有，但只是糖，不是封装** | `resumeGenerate`/`resumeStream`（`:780-787`）把 `resumeData` 折进 `sdkOptions` 的 `resume`/`continue` 字段，再调 `this.generate()`。**真正的续跑是 SDK 原生能力**，包装层只做类型友好的路由 |

### 9.2 为什么说「比预期更薄」

| 证据 | 位置 | 含义 |
|---|---|---|
| `export type ClaudeSDKOptions = ClaudeQueryOptions` | `index.d.ts:8` | **类型别名**，就是 SDK 的 `Options`，零扩展 |
| `import { query } from '@anthropic-ai/claude-agent-sdk'` | `index.js:3` | 直接依赖 SDK，不是自研 run loop |
| `runClaude()` 核心只有 4 行 | `index.js:937-957` | `{...sdkOptions, ...runOptions?.sdkOptions}` → 只额外塞 `outputFormat`（有结构化输出时）与 `abortController` → `query({prompt, options})`。**零字段转换** |

### 9.3 1,158 行的真实构成 → 约 1,000 行是 Mastra 适配，去掉后全不需要

| 构成 | 位置 | 去 Mastra 后 |
|---|---|---|
| `createSDKAgentTelemetry`（Mastra observability span） | `:126-364`（约 240 行） | ❌ 不需要 |
| ChunkType 流包装（`toFullOutput` / `createMastraOutput` / `enqueueStart·TextDelta·FinishChunks` / `wrapStreamForAgentSpan`） | `:29-125`、`:381-570` | ❌ 不需要 |
| usage 形状转换（`usageFromClaudeMessage` → `toV3Usage` / `getCostContext`） | `:411-425`、`:1069-1110` | ⚠️ **要借鉴**（见 9.5） |
| **真正的 agent 逻辑** | `:830-957` | ✅ 少量，可被 30–50 行取代 |

### 9.4 精确改造落点：`coding-agent.ts` 只动 3 处

| # | 位置 | 现在 | 改成 |
|---|---|---|---|
| 1 | `:5` | `import type { ClaudeSDKAgent } from '@mastra/claude'` | SDK 的 `Options` 类型 |
| 2 | `:279-325` `createCodingAgent()` | `await import('@mastra/claude')` + `new Agent({id, name, description, sdkOptions})` | **函数体几乎不用改** —— 直接返回那个 `sdkOptions` 对象即可。因为里面每一项（`cwd`/`env`/`permissionMode`/`allowDangerouslySkipPermissions`/`allowedTools`/`disallowedTools`/`hooks.PreToolUse`/`maxTurns`/`maxBudgetUsd`）**都是 SDK 原生字段** |
| 3 | `dev-workflow.ts:764` | `withCodingGuard(agent.generate([{role:'user',content:prompt}]), timeoutMs)` | `query({prompt, options})` + 自己消费 async iterator |

**要新写的只有 1 个函数**（约 30–50 行）：把 SDK 的消息流收敛成 `{ text, usage }` —— 等价于 `runClaudeGenerate`（`index.js:830-865`）的精简版。

> ⚠️ **但 `coding-agent.ts` 里 325 行的主体不是 Mastra 代码，是安全设计**：`makeGuardHook`（fail-closed 围栏，`:192-260`）、`buildCodingEnv`、`missingCodingCredentials`、`resolveProtectedBranchNames`、`allowDangerouslySkipPermissions` + `disallowedTools` 的防御纵深。**这些一行 Mastra 都不依赖，必须整块保留** —— 重写等于重新踩一遍已踩过的坑（子 agent 烧超时、断网工具、base 分支改名导致红线静默失效等）。

### 9.5 唯一有真实设计成本的点：`usage` 形状（牵动判据链）

现状链路（**这是核查的真实价值所在**）：

```
coding-agent 返回 Mastra FullOutput
  → dev-workflow.ts:775  usage: normalizeUsage(usageOf(res))
  → usageOf(r) = r.usage ?? r.totalUsage        (:243-247)
  → normalizeUsage() 拿不到就写 null
```

换成裸 `query()` 后，`res` 不再是 `FullOutput`，**必须自己重建 V3 形状**：

```ts
{ inputTokens: { total, noCache, cacheRead, cacheWrite },
  outputTokens: { total, text } }
```

否则 `usageOf` 恒返回 `undefined` → 落 `null`。而 `null` 是**设计内的正确值**（`dev-workflow.ts:240-241` 明确不把「取不到」伪装成 0），所以**失败是静默的**——成本报表会永远显示「无量」，且不报错。原注释（`:769`）已自陈「coding 走 Claude Code CLI，中继未必回传 usage」，说明**这条链在实践中本就经常拿不到值**，更难分辨是「真拿不到」还是「我改坏了」。

→ 验证点分两层：**单测层**在 M1（`ClaudeSDKAgent` 的替代收敛函数离线覆盖「有 usage / 缺字段 / 完全无 usage」三情形）；**实跑层**在 G 门禁 —— 但 ⚠️ **拿到 `null` 无法判定通过或失败**：`null` 是**设计内的正确值**（`:240-241` 明确不把「取不到」伪装成 0，`:769` 自陈中继常不回传 usage）。必须**人工比对 SDK 原始 `result` 消息里的 usage 与落盘值**，才能区分「中继真没回传」与「我改坏了」。

### 9.6 对排期的影响

| 项 | 变化 |
|---|---|
| **Q-F** | ✅ **结清，不再是未决项** |
| M0 的「桌面核查」 | ✅ **已完成**（本核查），M0 少一项 |
| M3 改造量级 | 从「10 行 ~ 重写 325 行」的不确定区间，收敛为 **改约 50–80 行** |
| 新增风险 | 由「不知道要改多少」变为「**usage 形状可能静默退化**」—— 可验证、有明确验收动作 |

---

## 10. 仍不确定的（未核实，动手前必查）

| 项 | 状态 |
|---|---|
| `runGate` 的 `usageOf(res)` 在直连 fetch 后的形状 | 推断可平替（都是 `usage` 字段），但**未实测**。与 §9.5 同源，建议合并成一次验证 |
| 服务器 Hermes 版本 / 是否与编码侧共用 LLM 凭据 | 未核实（原定验证动作已按裁决 2 推后） |

---

## 附录 A：pr-agent 代码锚点速查（**已修正版**）

> **用途**：动手搬代码时定位用。
> ⚠️ **本表已修正原 `迁移方案与决策记录.md` 附录里 3 处失实锚点**（该文件已于 2026-09-18 删除；核对过程见 §8）—— **照旧表去读会看错整段代码**。

| 用途 | 文件:行 | 状态 |
|---|---|---|
| 判据合成 `passed = testsPassed !== false && llm.requirementMet` | `dev-workflow.ts:892` | 准确 |
| test 阻断 `if(!passed)` | `dev-workflow.ts:951` | 准确 |
| review 不阻断（去掉） | `dev-workflow.ts:1010` | 准确 |
| `runGate` 调用点（3 处） | `dev-workflow.ts:867` / `:990` / `:1043` | 准确 |
| **stage 埋点** | `progress.ts:355`（`stageStart`，写 `step:start` 于 `:358`）、`:406`（`runEnd`）；6 步链调用在 `dev-workflow.ts:655/707/796/977/1034/1102` | 🔧 **原表写 `progress.ts:73-95` 是错的** —— 那是 `STAGE_NAMES` 阶段名闭集 |
| 心跳字段 | `log-store.ts:336-337` | 准确 |
| **心跳实现** | `dev-workflow.ts:745-760`（30s `setInterval`，`PR_AGENT_HEARTBEAT_MS` 可调，0=关闭） | ✅ **原表漏列** —— 这是「心跳不用新建」的关键证据 |
| 编码侧 LLM 链（Claude Agent SDK） | `coding-agent.ts:79-86,126-127`；包装层入口 `:282` | 准确 |
| 程序侧 LLM 链（纯 env） | `llm/providers.ts:135-143` | 准确 |
| storage 唯一用途 = resume | `mastra/index.ts:31-41` | 准确 |
| `state-db` 不存 workflow 状态 | `state-db.ts:6` | 准确 |
| `localPath` 本机事实不进 ContextSchema | `repo-registry.ts:10` | 准确 |
| **`usage` 采集链** | `dev-workflow.ts:775`（coding）/ `:349`（gate）→ `usageOf` `:243-247` → `:240-241` 不把「取不到」当 0 | ✅ **新增**，见 §9.5 |
| ~~单测基线 `213 = 196 + 4 + 13`~~ | — | ❌ **错**：实测 16 文件 / **222** 条声明，见 §7 |
| ~~卡片内容设计（抢救资产）`adapters/feishu.ts:135-173`~~ | — | ❌ **作废**：飞书整块归 Hermes（裁决 A5），`feishu.ts` 整块不搬 |

---

## 附录 B：证据来源与置信（关键结论）

> **来源**：原 `迁移方案与决策记录.md` §9（**该文件已于 2026-09-18 删除**），本表已更新 —— `ClaudeSDKAgent` 那一行由「低，待核实」升级为「高，已实读源码」。

| 结论 | 来源 | 置信 |
|---|---|---|
| Hermes 有原生飞书 gateway（WS 模式，出站 post/图片/文件，卡片交互内建 + 15 分钟按钮去重） | 官方 `hermes-agent.nousresearch.com/docs` | 高 |
| Hermes 有 Kanban 持久板 + block/unblock 恢复 | 官方 `user-guide/features/kanban` | 高 |
| Hermes 内建 MCP client（stdio + HTTP，自动发现工具） | 官方 `reference/tools-reference` | 高 |
| `readOnlyHint` / `trust:untrusted`(fail-closed) / `elicitation` | 官方 `reference/mcp-config-reference` | 高 |
| `/reload-mcp` 改 MCP 不需重启；skill → `/reset` | 官方 `user-guide/features/mcp` | 高 |
| 飞书长连接集群模式、单 app 单 WS 消费者 | `open.feishu.cn` 官方 | 高 |
| Profile 不做沙箱 / `cwd:"."` = 启动目录 / `hermes update` 同步 skills | 官方 `user-guide/profiles` | 高 |
| **`@mastra/claude` 是极薄封装**（无 memory / 无多轮 / `sdkOptions` 原样透传） | **实读** `node_modules/@mastra/claude@0.3.0/dist/` | **高（源码级）** |
| `guard` / `log-store` / `progress` / `repo-lock` / `dedup-store` / `github` / `test-runner` 零 Mastra 依赖 | 逐文件 grep `@mastra` | 高（实测） |
| `state-db.ts` 的 `@mastra/libsql` 仅注释引用，真实依赖是 `@libsql/client` | 行级复核 | 高 |
| 心跳已实现（非待新建） | 本仓库代码直读 `dev-workflow.ts:745-760` | 高 |
| 6 步链 stage 已埋点 | 本仓库代码直读（**锚点已修正**） | 高 |
| `hermes --safe-mode` / `profile export` / `config check` 等 CLI 面 | 三处转载一致，形似官方 | **中高 —— 服务器装好后 `hermes --help` 核实** |
| 部分 `hermes update` 同步行为、`approvals` denylist | 二手社区指南 | **低 —— 未官方核实** |
