# reference/ — 参考代码副本

> **性质**：**搬运原料，不是项目结构**。这里只保留新项目需要借鉴的代码 + 测试 + 配置（对照表见 `../借鉴清单.md`）。
>
> **可整个删除**：搬运完成后本目录不再有用。
>
> **不要做的事**：不要在这里开发、不要把它当成新项目起点、不要直接运行它的测试当作新项目的验收。

---

## 1. 这份副本的状态

| 项 | 说明 |
|---|---|
| **范围** | **只保留要用的**。既有实现里与新项目无关的部分（企业级 HTTP 框架样板、归他方持有的能力、里程碑专属验收脚本）已整块移出，不在本目录 |
| **身份信息** | 已中性化。组织名 / 仓库名 / 项目名前缀 / 本机代理端口 / 中转站名 / 环境变量前缀全部换成中性值 |
| **行号对齐** | 脱敏与路径修正**只做行内替换**，未增删任何一行 ⇒ **行号与源实现逐行对齐**，项目文档里的 `文件:行号` 锚点（如 `github.ts:375-394`、`progress.ts:355`）在这份副本里全部有效（已逐文件校验） |
| **目录层级** | 源实现里包着一层以编排框架命名的目录。本副本已**拍平**，`src/` 直接就是代码根 —— 文档里的锚点用拍平后的文件名即可 |
| **不含** | 凭据、依赖目录、构建产物、规则文件、里程碑文档 |
| **文件数 / 体积** | **51 个文件 / 约 516 KB** |

### 一个容易被误读的点

代码里出现的 `agent.md`（如在围栏的受保护路径清单、沙箱探针的检查项中）是**「受保护文件名」这一语义角色**，不是对某份外部文档的引用。改名会同时破坏围栏契约与对应测试。

---

## 2. 目录

```
reference/
├── src/                       ← 核心借鉴（15 个文件）
│   ├── adapters/              github · test-runner · repo-lock · state-db · dedup-store · repo-registry
│   ├── agents/                guard · coding-agent · dev-agent*
│   ├── workflows/             dev-workflow
│   ├── llm/                   providers
│   ├── integrations/          github-readonly*
│   ├── skills/                5 份编码规范（需求解析 / 编码 / 测试 / 审核 / commit message）
│   ├── config.ts              配置与启动自检
│   ├── log-store.ts           结构化日志（真相源）
│   └── progress.ts            阶段埋点
├── test/                      13 个测试文件 + jest.setup.ts
├── scripts/                   4 个探针 + 2 个验证脚本
├── package.json               依赖清单（**已按「删什么留什么」裁剪过**）
├── tsconfig.json              NodeNext + 严格项（装饰器相关选项是旧框架遗留，可去）
├── jest.config.js             已去掉为旧框架而设的 ESM 转译段
├── .prettierrc.js             `endOfLine: auto` + printWidth 120
├── .editorconfig
├── .env.example               ⭐ 环境变量全集（含各项用途说明，**值得逐条读**）
└── repos.registry.example.json
```

`*` = 只有一部分可用，见 §5。

---

## 3. 保留清单（每一项为什么留）

### 3.1 直接借鉴（近乎原样，对框架的 import 计数为 0）

| 能力 | 文件 | 作用 |
|---|---|---|
| GitHub 出站 | `src/adapters/github.ts` | 建分支 / commit / push / REST 开 PR。⚠️ 见 `借鉴清单.md` §2 的 fetch 缺口 |
| 结构化日志 | `src/log-store.ts` | 状态页按 runId 读它重建时间线，不另存一份状态 |
| stage 埋点 | `src/progress.ts` | `stageStart()` / `runEnd()` |
| 测试执行 | `src/adapters/test-runner.ts` | 真跑测试并产出事实（含平台分支） |
| 围栏判定 | `src/agents/guard.ts` | 判定哪些动作被禁止。**刻意是纯函数**，搬运不得破坏该性质 |
| 并发锁 | `src/adapters/repo-lock.ts` | 临界区 = 同步 → push |
| 状态库 | `src/adapters/state-db.ts` | SQLite 连接 + `INSERT OR IGNORE` 原子认领原语 |
| 幂等账本 | `src/adapters/dedup-store.ts` | 事件 → run 索引，新项目改作触发幂等 |
| 编码规范存档 | `src/skills/` | 5 份（**不含 merge-pr**，范围到 PR 为止） |

### 3.2 借鉴后改造（只改入口点，内部保留）

| 能力 | 文件 | 改动量小的原因 |
|---|---|---|
| 编排主链 | `src/workflows/dev-workflow.ts` | 框架只碰了步骤定义，没碰判定 / 闸门 / 埋点 / 心跳 |
| 编码执行器 | `src/agents/coding-agent.ts` | 325 行的主体是**安全设计**（fail-closed 围栏 hook、环境注入、凭据检测、受保护分支解析），整块保留 |
| LLM provider 注册表 | `src/llm/providers.ts` | 删掉「转框架配置」那几行即可，其余是纯数据与校验 |
| 仓库注册表 | `src/adapters/repo-registry.ts` | 增加 fetch 挂钩 |
| 配置与启动自检 | `src/config.ts` | 删掉框架配置装配；`logLlmConfig()` 是「启动打印实际生效端点」的实现 |

### 3.3 测试（13 文件 + `jest.setup.ts`）

被测代码几乎全在 3.1 / 3.2 的模块上。`jest.setup.ts` **必须保留**（把日志落盘路径重定向到临时目录，防单测污染生产日志）。

### 3.4 脚本（6 个）

| 文件 | 为什么留 |
|---|---|
| `scripts/_coding-probe.js` | 验证「中转站的 Anthropic Messages 端点能否驱动编码 CLI 的 tool_use 多轮」 |
| `scripts/_messages-probe.js` | 上一层的 HTTP 版，把「CLI 起不来」与「端点不支持工具调用」两种故障分开 |
| `scripts/_relay-protocol-probe.js` | 摸清中转站支持哪些协议端点 + 是否支持工具调用 |
| `scripts/_llm-raw.js` | 裸 `/chat/completions` 调用并打印**原始响应**（看 usage 真实形状的最小手段） |
| `scripts/verify-github.js` | GitHub 配置与连通性验证（只读探测，不开真实 PR） |
| `scripts/verify-github-read.js` | 只读工具面的验证 |

> 前四个是**端点验证类**探针 —— 部署到服务器后「LLM 端点到底通不通、模型名对不对」只能靠它们，且它们的失败形态都是显式的。

### 3.5 工程配置

`package.json`（依赖裁剪后：编码 SDK + 状态库驱动 + `zod` + `dotenv`）、`tsconfig.json`、`jest.config.js`、`.prettierrc.js`、`.editorconfig`、`.env.example`、`repos.registry.example.json`。

---

## 4. 已移出清单（每一项为什么移出）

**移出 ≠ 删除能力**，多数是「新项目不实现这些能力」，因此没有回归风险。

### 4.1 旧 HTTP 框架样板（整块移出）

`src/configuration.ts`、`src/controller/`、`src/filter/`、`src/middleware/`、`src/service/`、`src/config/config.*.ts`、`src/interface.ts`，及其测试 `test/controller/`。
→ 企业级 HTTP 框架的脚手架。工具面走 MCP，不需要。依赖清单里也已去掉该框架。

### 4.2 归他方持有的能力（整块移出）

`src/adapters/feishu.ts`、`src/integrations/feishu.ts`、`src/adapters/inbound-poll.ts`、`src/workflows/insight-workflow.ts`、`src/agents/insight-agent.ts`、`src/skills/merge-pr/`，及全部飞书相关脚本。
→ 出入站、卡片、渲染、按钮去重**全部归 Hermes**；合并已出范围（止于 PR）。

### 4.3 零业务逻辑的装配层（整块移出）

`src/index.ts`、`src/server.ts`、`src/README.md`（通篇围绕旧框架的装配写法）。
→ 装配方式在新项目里要重写，留着只会诱导照搬。

### 4.4 里程碑专属验收脚本（整块移出）

`verify-m4-*` / `verify-m5-*` / `verify-m6-*` / `verify-pr-loop.js` / `verify-local-write.js` / `verify-insight-loop.js` / `verify-feishu*.js`。
→ 验的是既有实现的里程碑，与新项目无对应关系。**真正有参考价值的是 §3.4 的探针。**

### 4.5 依赖旧框架工具链的配置

`eslint.config.js`（继承旧框架的 lint 预设）、`test/mastra/storage.test.ts`（测的是被去掉的框架存储能力，被删的源码未随副本提供）。

---

## 5. 两个「只有一部分有用」的文件

| 文件 | 有用的部分 | 其余部分 |
|---|---|---|
| `src/agents/dev-agent.ts` | **6 段 skill 的 `instructions` 文本**（需求解析 / 编码 / 测试 / 审核 / commit message 的判据，含「不要声称跑过实际未执行的测试」这类关键约束）→ 搬进新项目的 `llm/prompts.ts` | 顶部的框架 import 与底部的 agent 装配（`new Agent({...})`）作废；`merge-pr` 那段也超范围 |
| `src/integrations/github-readonly.ts` | **zod schema** → 直接复用于 MCP 工具注册（`repo_list` / `run_status` / `run_cost`）；内部的只读 client 逻辑 | 外层是框架的 `createTool` / `Integration` 包装，作废 |

---

## 6. 副本里仍会看到旧框架名称的地方（及处置）

**这不是没删干净，是刻意保留的对账依据。** 分三类，处置方式不同：

| 类型 | 位置 | 处置 |
|---|---|---|
| **`@mastra/*` 的 import / 类型引用** | 9 个文件（`coding-agent.ts:5,282`、`config.ts:2,77`、`dev-agent.ts:1,2`、`github-readonly.ts:3,4`、`providers.ts`、`state-db.ts` 等） | **原样保留**。这些正是「框架渗透点」，是改造时的定位点 —— 删掉它们，`借鉴清单.md` 里「渗漏只在入口」的结论就失去了可核对的对象 |
| **`mastra.db` 文件名 / `mastra_*` 表名 / `*DbPath` 变量名** | `state-db.ts:20-31`、`repo-lock.ts:26`、`repo-registry.ts:10` | **原样保留**，因为它们是「搬运前必改清单」的第 1、4 项 —— 改了就看不出哪里要改 |
| **注释里解释「为什么这么设计」的历史背景** | `state-db.ts:4-23`（为什么复用同一个库文件、为什么要避开框架内部表名）、`coding-agent.ts:15-16`（为什么不用框架原生 agent）、`config.ts:22-49`（为什么用 Chat Completions 协议而不是 Responses API） | **原样保留**。这些是踩过的坑，删了就等于把结论留下、把理由丢掉 |

**判断口径**：凡是**路径类**的旧引用（指向已不存在的目录）都已改成拍平后的路径；凡是**保留下来**的都是「为什么这样设计」的事实与框架渗透点。

---

## 7. 搬运前必改清单

这些是「原封不动照搬会带进旧痕迹」的点，**逐项都要动**：

| # | 项 | 位置 | 改成 |
|---|---|---|---|
| 1 | 状态库默认文件名 | `src/adapters/state-db.ts` 的默认值 | 本项目自己的命名（`.env.example` 已同步标注） |
| 2 | 日志落盘路径 | `progress.ts` / `log-store.ts` 的默认路径 | 本项目自己的命名 |
| 3 | 围栏受保护路径 | `src/agents/guard.ts` 的 `PROTECTED_PATHS` | **按新项目结构重列**（副本里已随目录拍平，但新项目目录未必同名） |
| 4 | 里程碑前缀的环境变量 | 如 `M1_*`、`M5_*` | 去掉里程碑编号 |
| 5 | 依赖裁剪 | `package.json` | **已裁好**：删了编排框架与 HTTP 框架，留编码 SDK、状态库驱动、`zod`、`dotenv` |
| 6 | 框架入口改造 | `coding-agent.ts`、`config.ts`、`dev-agent.ts`、`github-readonly.ts`、`providers.ts`、`state-db.ts` | 逐处替换 `@mastra/*` 的 import（见 §6） |
| 7 | `jest.config.js` 的 ESM 转译配置 | — | **已去掉**（原是为旧框架的 ESM 依赖而设） |

> 环境变量前缀已在中性化时统一处理（`APP_` 系列），搬运时按新项目命名再收口一次即可。

---

## 8. 已知的悬空引用

副本是**抽取片段**，不是完整仓库。下面这些引用指向的内容**不在这份副本里**，读到时可忽略或按说明处理：

| 位置 | 引用了 | 处置 |
|---|---|---|
| `src/workflows/dev-workflow.ts:4` | `../adapters/feishu`（`getFeishuConfig` / `feishuNotify` / `buildDevCompleteCard`） | **预期悬空**：notify 步整段不实现（通知归 Hermes）。移植时删掉该 import 与 notify 步 |
| `test/entry-idempotency.test.ts:27` | `../src/adapters/inbound-poll` | **预期悬空**：轮询入口不实现。该测试的「原子认领 5 条 + fail-closed 1 条」要留下（见 `借鉴清单.md` §7.2），其余删 |
| `src/config.ts:53`、`src/adapters/state-db.ts:28` | 源码入口模块（装配层，已移出） | 注释里的历史说明，不影响搬运 |
| `scripts/verify-*.js` | `../dist/**`（构建产物） | 脚本 require 的是 `dist/`，改完源码要先 `npm run build` |
| `scripts/verify-llm.js:16` | `@mastra/core/llm` 的 `resolveModelConfig` | 改造点：改调新项目自己的配置自检（`config.ts` 的 `checkLlmConfig()`） |

---

## 9. 建议的阅读顺序

`借鉴清单.md`（要搬什么、哪些必须新写）→ `src/log-store.ts` + `src/progress.ts`（真相源与埋点，状态页的地基）→ `src/agents/guard.ts`（纯函数围栏）→ `src/agents/coding-agent.ts`（安全设计的主体）→ `src/workflows/dev-workflow.ts`（主链）→ 其余按需。
