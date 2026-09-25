# 项目长期记忆

> 设计/编排细节以 4 份项目文档为准（`AGENTS.md` / `需求说明.md` / `里程碑规划.md` / `借鉴清单.md`）。
> **本文件只记三类东西**：① 文档里没有的**环境实况**；② 会过期的**进度状态**；③ 跨会话必须记住的**操作约定**。
> 最后更新：2026-09-25。

---

## 1. 进度快照（2026-09-25 实测）

| 项 | 状态 |
|---|---|
| 本机仓库 | `main` @ `09c7706`，工作树干净。`npx jest` **18 套件 / 349 全绿**（47.7s）；`typecheck` exit 0 |
| 硬性注意 #16 框架依赖 | ✅ 全仓 grep = 0 命中 |
| 硬性注意 #3 绝对路径 | ✅ `src/` 无开发机路径（仅 `test/` 用 `127.0.0.1` 假端点、`scripts/stub-endpoint.cjs` 注释） |
| **M0** | 1/2/3 ✅（scp 通道 · 服务器本地演练仓 `~/code` · **飞书通道已打通**）；4 ⏳ **环境仓库软链方案仍未定** |
| **M1** | ✅ 本地 + **服务器**双绿：`npm ci` 384 包/8s → typecheck → jest 18/349 → build。服务器口径与本机**逐字一致**（平台分支未产生差异） |
| **M2** | 代码完成 ✅（MCP stdio + 只读工具 ×3 + SSE 状态页 + `log-store.listRuns()`）；**未部署、未在 Hermes 注册** |
| **G 门禁** | 实质已过 —— 服务器走 **DeepSeek 的 Anthropic 兼容端点**（真 key → HTTP 200 + `claude -p` = PONG） |
| **M3** | 代码完成并提交 ✅（`f63d6ed`/`744e658`/`0f9e0b9`/`c4dc1ed`/`a47341b`/`9cba708`）；**本机**真端点整链全绿。**服务器侧 + Hermes 侧未跑** |
| **M4** | 未开工（可延后） |

**M3 本机实测口径**（假端点 + 真端点各一轮，均全绿）：`dev_start` **2ms** 返回 → detached 进程存活 → `checkout` 建分支 → 编码 CLI **真写文件** → 测试 `passed=true` → 审核 `approve` → **真产生提交** → base 分支未被改动 → `stepsDone=6/stepsFailed=0`。围栏 `guard:deny` 归属到 run 且哨兵存活（**PreToolUse hook 在官方 SDK 下确认有效**）。

## 2. 服务器现状（2026-09-20 投递后）

| 项 | 值 |
|---|---|
| 项目代码 | ✅ 用户目录下独立 `pr-agent-lite`（2.3M + `node_modules`），与演练仓 `code` **物理隔开** |
| 构建产物 | ✅ `dist/` 已产出 |
| 服务器 `.env` | ❌ **未配**（只有 `.env.example`） |
| MCP 注册 | ❌ **未注册**（`hermes mcp list` → `No MCP servers configured`） |
| 演练仓 | ✅ `~/code`（自建 git 仓、无上游、仓库级身份），分支 `feature/drill` |
| 运行时 | node v22.22.3 / npm 10.9.8 / git 2.43.0 / python 3.12.3 |
| 投递方式 | `tar` 管道经 ssh，排除 `node_modules`/`.git`/`dist`/`logs`/`.workbuddy`；⚠️ **macOS tar 带 `._*` AppleDouble，必须 `find . -name "._*" -delete`**（或 `COPYFILE_DISABLE=1`） |

## 3. 下一步（按顺序，全在服务器侧）

1. 服务器 **`.env`** —— **两条链分别配**（闸门链 = OpenAI 兼容；编码链 = Anthropic 兼容），服务器已有 DeepSeek key 可派生
2. 服务器**启动自检**实跑（验硬性注意 #6：即使端点不通也要打印实际生效 provider / baseURL / model）
3. **Hermes 注册 MCP**（`hermes mcp add`）—— 不确定性最高，**当第一个动作做最小工具**，别留到最后联调
4. **端到端验收**：飞书一句话 → run 落状态页 → 本地提交 + 测试事实
5. 收口 **M0 验收 4**（环境仓库软链）+ **Q-D**（第一版使用者范围）+ **Q-L**（编码 CLI 是否与用户 `~/.claude/settings.json` 隔离）

## 4. 「会静默失败」清单的状态（最重要的一节）

> **结论：这份清单只会变长。前四项是照搬/改造期预判的，后三项全是真跑一次才暴露的。每跑一次真链路，就回来加一条。**

| # | 事项 | 状态 |
|---|---|---|
| 1 | `git fetch` 缺失 → 从**过期基线**建分支且不报错（`github.ts:375-394`、`countAhead` `:403`） | ⏳ 第一版被测仓**无上游** ⇒ 不触发；接真仓库立刻生效 |
| 2 | usage 形状退化为 `null`（而 `null` 是设计内正确值）⇒ 成本报表永远「无量」 | ✅ 未退化（真端点 4 次调用 / 1,649,667 in / 8,146 out，`run_cost` 与日志逐条相加一致、`unknownUsage=0`） |
| 3 | 模型名幻觉（看着在跑但模型不对） | ✅ 启动自检无条件打印已实现（服务器侧待实跑） |
| 4 | 编码链显式覆盖被 `~/.claude/settings.json` 的 `env` 块压掉 | ✅ 已修（`buildCodingSettings` 走 `Options.settings`；**未显式配置时不下发 settings**）· 单测 `test/coding-env.test.ts` · AGENTS #23 |
| 5 | 未跟踪新文件的内容从不进 diff ⇒ 闸门**恒判负** | ✅ 已修（`renderUntrackedDiff` + 保底预算）· 单测 `test/diff-untracked.test.ts` · AGENTS #24 |
| 6 | 编码步零改动照样 `step:done` ⇒ 把「模型没动手」伪装成「实现不合格」 | ✅ 已修（`codingChangeFailure` 纯函数当场判负）· 单测 `test/coding-no-change.test.ts` · AGENTS #25 |
| 7 | 编码步上限从未被披露（`Reached maximum budget ($2)`）；且该值是 **CLI 算的名义成本**，接中转站时与实付无关 | ✅ 已修（`codingLimits()` 单一来源，三处同读；默认 `2 → 50`；`0`/负 = 关闭且**不下发**；落盘 `llm:done.costUsd`）· AGENTS #26 |

## 5. 环境实况（不写进项目文档，仅本地）

- **部署目标**：一台远程服务器，与 Hermes 同机。**连接方式见本地 SSH 配置，不入库**（别写 IP 进文档）。
- 本机**没装 Hermes** ⇒ 环境侧改动**只能直改服务器、无法本地预演**。
- **Hermes**：v0.15.2，gateway `systemctl --user`（`hermes-gateway.service`，含 `.d/` 覆盖目录）；已连通 `lightclawbot` + `weixin` + `feishu`。venv 在 `~/.hermes/hermes-agent/venv/bin/python3`（**不是 `.venv`**）。
- **飞书**：`CONNECTION_MODE=websocket` 已连（`✓ feishu connected` + `wss://msg-frontier.feishu.cn/ws/v2`）；白名单 = 发起注册那个账号的 open_id。⚠️ **设备码流程只扫码不够** —— 要在页面上再点一次「确认/同意」，600s 过期即作废。
  - **链路延迟基线 ≈ 23s**（一句话往返）⇒ Hermes 侧必须「立刻回执 + 后台推进」（`dev_start` 2ms 返回正是为此）。
  - Hermes 侧 LLM = 第三方聚合端点（`apihub.agnes-ai.com` / `agnes-2.0-flash`），**与编码侧 DeepSeek 完全无关** ⇒ Q-H = **不共用、也不需要**。⚠️ 免费额度会 429，主调用撞限流时飞书侧**静默无响应**。
- **服务器出口**：npm ✅；**Anthropic 官方端点被 edge 层区域封锁**（403，换 UA 无效）；`claude.ai/install.sh` 同样不可用 ⇒ 走 DeepSeek 兼容端点绕开，无需中转/换 SDK。
- **服务器 GitHub**：`api.github.com` 可达（只需 PAT），但 `github.com` / `codeload` 的 **HTTPS 被 SNI 阻断** ⇒ 要走 SSH（协议通、缺 key）。**第一版不碰远端（D8），全用不上。**
- **Claude Code CLI**：服务器用户级 `~/.local/bin/claude` 2.1.276。`~/.local/bin` 不进非交互 shell 的 PATH，但**用绝对路径完全可用** ⇒ 不需要 sudo 建 `/usr/bin` 软链（也正好符合「运行期路径来自配置」）。
  - **编码 CLI 会加载用户自己的 `~/.claude/settings.json`**（`enabledPlugins` / `hooks` 全在生效范围，实测会额外产出一份 `docs/superpowers/plans/…md`）。完全隔离要 `settingSources: []`，但那会关掉用户凭据通路 ⇒ **Q-L**。
  - 服务器权限：项目级 + 用户级**两层都要配**（`auto` / `bypassPermissions` 从项目级不生效）；`WebFetch` 在该服务器**因 claude.ai 被封锁而不可用**（与权限无关），替代是 `Bash` + `curl`。
- **本机 cc-switch 代理只答 Anthropic 形状**（`/v1/messages`）⇒ **闸门链（OpenAI 形状）必须另找官方兼容端点**（DeepSeek 官方 baseURL **不带 `/v1`**）。
- 本机代理只放通 `api.github.com` 与 `git clone github.com`。
- **测试基线口径**：看**执行数**不是声明数（`it.each` 展开多出 69 条）。参考副本 16 文件 / 222 声明 / 291 执行；副本保留 13 + `jest.setup.ts` = 218 / 287；**新项目 18 + `jest.setup.ts` / 280 / 349**。⚠️「去掉框架就能删掉大部分测试」**不成立**。

## 6. 未决项

**Q-D** 第一版使用者范围（卡 M3 收口）· **Q-G** 是否要真实工期（需投入假设，否则只给 S/M/L）· **Q-L** 编码 CLI 与用户 settings 的隔离（卡 M3 收口）。
**已结清**：Q-H（不共用/不需要）· Q-J（DeepSeek Anthropic 兼容端点）· Q-I / Q-K（移出第一版，第二版再定）。

> ⚠️ **文档口径滞后（2026-09-25 复核，待改）**：① `里程碑规划.md:31` M3 一句话仍是「PR 链接回到会话」，与 **D8（第一版不产出 PR）** 矛盾（§2 正文已改对）；② `需求说明.md:141` / `里程碑规划.md:283` / `AGENTS.md:133` 三处 **Q-H 仍标「卡 G」**，已结清；③ `里程碑规划.md:74/102` 的测试口径是**当时的预测值**，实际 M1 出口已是 18/280/349；④ `里程碑规划.md:272` 把「飞书长连接支持」列为**中置信未核实**，实际已跑通。

## 7. 操作约定

- **项目文档 4 份，不新开文件**；文档不写机器路径 / 服务器地址 / 连接方式，不写「取代了谁」这类过程产物；代码引用一律指向 `reference/`（`相对 reference/src/mastra/ 的路径:行号`）。**改完文档跑 `python check-docs.py`**（退出码非 0 即有问题）。
- **`reference/` 是只读搬运原料**，不是项目结构；**脱敏只做行内替换、绝不增删行**（否则文档行号锚点集体失效）。搬运完成后整块可删。
- **换行恒定 LF**（`.gitattributes` 强制），别删那条声明 —— 锚点是「文件名 + 行号」。
- 测试三个陷阱：状态库路径环境变量名（副本已中性化为 `APP_DB_PATH`）· `jest.setup.ts` **必须保留**（防单测污染生产日志）· 被测试直接 import 的导出名逐个确认没变（`runGate` / `ContextSchema` / `resolveProtectedBranchNames`）。
- 工作日志 `.workbuddy/memory/YYYY-MM-DD.md`（append-only，写入前先看当天文件是否存在）。
