# AGENTS.md — pr-agent-lite

> **给在本仓库工作的 AI agent 的上下文入口。先读本文件，再按 §2 文档地图取细节。**
> 最后更新：2026-09-18

---

## 1. 这个项目是什么（一句话）

从 `D:\code\pr-agent` **借鉴代码**，新建一个**独立项目**，**部署到远程服务器**，由 Hermes 在飞书侧调用 —— **与 pr-agent 零关联**。

**三条定性**（任何与此冲突的旧描述都已作废）：

| # | 定性 | 后果 |
|---|---|---|
| **D1** | 不是「迁移运行中的系统」，是「**借鉴代码 + 新建**」 | 不存在「搬」，也没有存量状态要处理 |
| **D2** | **pr-agent 不改造、不部署、不收口** —— 它退出管理 | 全部「改造 pr-agent」的动作清单作废 |
| **D3** | 靶子仓库是**远程仓库**（**提前 clone 到服务器**的常驻副本），不是本机 clone | `repo-registry.ts` 的 `localPath` 语义要重写 |

**形态**：MCP server + 编码执行器。飞书 ↔ Hermes 的链路由 **Hermes 持有**，只有特定逻辑才走本项目的编码程序。

---

## 2. 文档地图（只有这 3 份，旧文档已于 2026-09-18 删除）

| 文件 | 管什么 | 何时读 |
|---|---|---|
| `需求定位-v2.md` | 需求定性 + 裁决 A1–A5 + 继承清单 / 作废清单 | 想知道「**为什么这么定**」 |
| `需求里程碑规划-v1.md` | M0 / G / M1–M4 排期、出口验收、未决项归属、**附录 A（Hermes 环境维护模型）/ 附录 B（可见性盲点）** | 想知道「**下一步做什么**」 |
| `模块盘点-去Mastra后.md` | 逐文件改造清单、13 处渗透点、**附录 A（代码锚点速查）/ 附录 B（证据与置信）** | **动手搬代码前必读** |

> ⚠️ 已删除：`迁移方案与决策记录.md` / `Hermes迁移-里程碑排期草案.md` / `需求分析评审-R1.md`（框架层作废）。
> 其中**仍有效**的内容已归并：Hermes 环境维护模型 → 里程碑规划附录 A；可见性盲点清单 → 附录 B；代码锚点与证据表 → 模块盘点附录 A/B。
> 需要原文时用 git 恢复（`3860fc8` 是 init commit）：`git show 3860fc8:"迁移方案与决策记录.md"`

---

## 3. 硬性注意事项（踩坑清单）

### 🔴 定性红线

| # | 事项 |
|---|---|
| 1 | **不碰 pr-agent**：不改造、不提 PR、不收口 M7/M8。它的工作树是干净的（HEAD `d872712 docs(M7-M8)`，全部已提交）。 |
| 2 | **不写飞书代码、不持飞书凭据**：出入站、卡片、渲染、按钮去重**全部归 Hermes**。依赖清单里**不应出现飞书 SDK**；`adapters/feishu.ts`(313) **整块不搬**。 |
| 3 | **靶子仓库运行时不需要 clone，但 `git fetch` 是必须的**。`githubCheckout → createBranchVerified`（`github.ts:375-394`）执行 `git branch <branch> <base>` 用的是**本地 base ref**，全程无 fetch ⇒ 常驻 clone 上若不 fetch，分支会从**过期基线**建出、**PR 带着旧基线且不报错**（静默）。`countAhead`（`:403`）同源隐患。 |

### 🔴 会静默失败的（验收必须显式覆盖）

| # | 事项 |
|---|---|
| 4 | **`usage` 形状**：换掉 `ClaudeSDKAgent` 后必须自己产 V3 形状 `{inputTokens:{total,noCache,cacheRead,cacheWrite}, outputTokens:{total,text}}`。退化后会落 `null`，而 **`null` 是设计内正确值**（`dev-workflow.ts:240-241` 明确不把「取不到」伪装成 0）⇒ **不报错**，成本报表永远「无量」。验收必须**人工比对 SDK 原始 `result` 消息里的 usage 与落盘值**。见 `模块盘点` §9.5。 |
| 5 | **模型名幻觉**：失败形态是「**看着在跑但模型不对**」。启动自检必须打印**实际生效**的 provider / baseURL / model，**即使端点不通也要打印出来**。 |
| 6 | **不要把 `progress.ts:73-95` 当埋点位置** —— 那是 `STAGE_NAMES` 阶段名闭集。正确锚点：`progress.ts:355`（`stageStart`）/ `:406`（`runEnd`），6 步链调用在 `dev-workflow.ts:655/707/796/977/1034/1102`。完整修正表见 `模块盘点` 附录 A。 |

### 🟡 设计约束（改代码时必须遵守）

| # | 约束 |
|---|---|
| 7 | **`guard.ts` 必须保持纯函数**（无 IO、不读 env）—— 由测试守住。它是围栏判定的唯一实现，破坏纯度会同时破坏可测性。 |
| 8 | **判据归属：程序只产事实，不做决策。** `passed = llm.requirementMet`。不做「取不到就当 0」的兜底 —— 那是把「未知」伪装成「确定值」。 |
| 9 | **阻断策略**：test 判负 → **保留阻断**；review 判负 → **不阻断**，结论随链上报。 |
| 10 | **三级闸门**：`readOnlyHint: true`（免批准）/ `elicitation`（程序决定问不问）/ `trust: untrusted`（必须人工点头）。**动作准入绝不给 LLM。** |
| 11 | **`coding-agent.ts` 里 325 行的主体是安全设计，不是 Mastra 代码**：`makeGuardHook`（fail-closed 围栏 `:192-260`）、`buildCodingEnv`、`missingCodingCredentials`、`resolveProtectedBranchNames`、bypass + disallowedTools 防御纵深 —— **整块保留，勿重写**。 |

### 🟡 环境顺序（做错要返工）

| # | 事项 |
|---|---|
| 12 | **Hermes 升级会同步 bundled skills 到所有 profile** ⇒ 顺序必须是「**先核实服务器版本 → 要升就升 → 再建 `hermes-env` 软链**」。反了，第一次漂移检查必爆红。 |
| 13 | **不要假定能复用 Hermes 的 LLM 凭据**给编码侧 —— 编码侧要 `ANTHROPIC_*`，与 Hermes 自己的 provider 未必同源。 |
| 14 | **本机没装 Hermes**（`command -v hermes` 为空、无 `~/.hermes/`）⇒ 环境改动**只能直改服务器，无法本地预演**，风险高于直觉。 |

### 🟢 工程习惯

| # | 事项 |
|---|---|
| 15 | 全仓 `@mastra/` 与 `@midwayjs/` 必须 **0 命中**（M1 出口验收）。 |
| 16 | **测试去向**：留 189（10 文件）/ 改造 13（guard-hook 3 + dev-gate-contract 10）/ 部分留 ~6（`entry-idempotency`）/ 删 4。基线是 **16 文件 / 222 条声明**（不是 213）。 |
| 17 | **M1 的出口验收必须在服务器上跑，不是本机** —— `github.ts` 与 `test-runner.ts` 都有平台分支（Windows vs Linux），本机绿不代表服务器绿。 |
| 18 | 本仓库工作日志在 `.workbuddy/memory/YYYY-MM-DD.md`（append-only），长期结论在 `.workbuddy/memory/MEMORY.md`。**文档改动后同步更新**。 |

---

## 4. 环境事实

| 项 | 值 |
|---|---|
| **本仓库** | `D:\code\pr-agent-lite`，git，branch `main`，remote `git@github.com:wintim1143/pr-agent-lite.git` |
| **代码来源仓库** | `D:\code\pr-agent`，HEAD `d872712 docs(M7-M8)`，工作树干净 |
| **服务器** | `ssh tencent` → HostName `49.234.190.37` / User `ubuntu` / IdentityFile `tencent_cloud` |
| **本机 Hermes** | ❌ **未安装**（无 `hermes` 命令、无 `~/.hermes/`）；服务器是否已装、版本多少 —— **未核实** |
| **靶子仓库** | 待定（用户："后面再讨论"），**第一版只需 1 个** |
| **飞书入口** | Hermes gateway（服务器侧）。飞书 app **复用 pr-agent 的**（`FEISHU_APP_ID`/`SECRET`/`RECEIVE_ID` 三项），但**只被 Hermes 消费** |
| **运行时** | node 22.22.2（managed）/ python 3.13.12（managed） |
| **关键依赖** | `@anthropic-ai/claude-agent-sdk`（**已在 dependencies 里**，换 SDK 不用新增）、`@libsql/client`（**不是 Mastra 的**，要留）、`zod`、`dotenv` |

---

## 5. 工作约定

- **排查 / 分析 / 检查类请求默认只读**，不自动改代码、不 commit。要动手时明确说。
- **结论先行**，要点 + 表格，代码层结论必须附 `file:line`。
- **事实与推断必须分开标注**。本项目大量结论依赖核实（且已发现多处旧文档失实），混淆会直接误导决策。
- **一手来源优先**：官方文档 / 源码 > 二手转述。`模块盘点` 附录 B 已标注每条结论的来源与置信度，**引用前先看置信栏**。
- **复杂需求**在规划期与交付前各做一次自我反思（最没把握的是什么、最大遗漏是什么）。
- 破坏性操作（删除、`git reset`）前先给清单与影响，不要直接执行。

---

## 6. 当前未决项

| # | 项 | 卡哪 |
|---|---|---|
| **Q-D** | 第一版使用者范围（只有你 / 群里有别人）—— 决定「谁能触发编码」的闸门做到什么程度 | **M3** |
| **Q-G** | 要不要真实工期（需投入假设：每周多少小时），否则只给顺序与 S/M/L 相对规模 | 全文 |
| **Q-H** | 服务器 Hermes 的 LLM 凭据能否与编码侧共用 | **G 门禁** |
| **Q-I** | 靶子仓库具体是哪些（第一版只需 1 个） | T3 |

**已结清**：~~Q-E~~（飞书 app 复用 pr-agent 的，且整块移出本项目）· ~~Q-F~~（`@mastra/claude` 极薄封装，改造约 50–80 行）

**下一步最该做的两件事**（占日历时间、不占工时）：**飞书 app 侧的权限/长连接配置**、**靶子仓库 clone + PAT 演练**。

---

## 7. 里程碑一句话

```
M0 前置收口 → M1 项目自立 → M2 只读接线 → G 门禁 → M3 编码贯通 → M4 决策收口
（M0 无本项目代码；M3 是唯一不可压缩段；M2 刻意零 LLM 依赖，与第一号风险解耦）
```

详见 `需求里程碑规划-v1.md`。
