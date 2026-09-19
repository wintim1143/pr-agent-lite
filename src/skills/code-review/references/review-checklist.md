# Review Checklist — 代码审核风格核对清单

`code-review` skill 第 2 步「核对仓库风格」的参照明细。审核时逐条过，命中即记意见。

## A. 编排约束（本项目硬规则）

- [ ] 步骤一律用 `createStep({ id, description, inputSchema, outputSchema, execute })`（`runner.ts`）；**禁止**绕开它自造步骤对象。
- [ ] `outputSchema` 必填：顺序执行器在**每步返回后**跑一次 `safeParse`，不通过即判该步失败 —— 这是 fail-closed 的，别改成「只警告」。
- [ ] 链式串联一律 `.then(step)`（含第一个步骤），末尾 `.commit()`。
- [ ] 人工关卡用 execute 上下文里的 `suspend()`（抛 `WorkflowSuspended`），恢复走 `run(input, { resumeAt, resumeData })`。
      ⚠️ **上下文快照由调用方持有**（落在状态库），执行器**不做**自动快照 —— 恢复时传的必须是挂起那一刻的上下文，不是原始输入。
- [ ] `guard.ts` 的围栏判定必须是**纯函数**（无 IO、不读 env）—— 由测试守住。破坏纯度会同时破坏可测性。
- [ ] 判据归属：**程序只产事实，不做决策**。`passed = llm.requirementMet` 这类合成在程序侧；
      不做「取不到就当 0」的兜底 —— 那是把「未知」伪装成「确定值」。

## B. 服务边界（不得越界）

- [ ] **不写 IM 代码、不持 IM 凭据**：出入站、卡片渲染、按钮去重全归外侧网关。
      本项目的完成态只落**结构化事件**（`step:done`），由网关决定推给谁、以什么形态渲染。
- [ ] 依赖清单里不得出现任何 IM 平台 SDK。
- [ ] 路径一律来自配置 / 环境变量：代码、默认值、注释、示例里都不出现机器绝对路径。

## C. 正确性 / 边界 / 隐患

- [ ] 异步路径是否全部 `await`；悬挂 Promise、未捕获 reject。
- [ ] 资源释放：状态库连接、文件句柄、定时器在失败 / 异常分支也要释放。
- [ ] 并发 / 竞争：多实例共享状态库、人工关卡回调并发 resume 是否安全。
- [ ] 不吞异常、不静默失败（尤其 `try/catch` 后空 body）。
- [ ] 外部副作用（建分支、开 PR、推远端）是否幂等、是否需人工 approve 闸门拦截。
- [ ] **会静默失败的三处**：基线未更新（分支从过期 base 建出）、`usage` 形状退化（成本报表恒「无量」）、
      模型名静默回落（看着在跑但模型不对）。改了相关代码要显式覆盖。

## D. 提交规范（红线）

- [ ] 分支模型 trunk-based + 短期 `feat/<issue>-<slug>`，合并即删。
- [ ] Conventional Commits + 末尾 `Closes #<issue>`。
- [ ] 不提交构建产物、依赖安装目录、`.env`（已 gitignore）。
- [ ] 不提交凭据 / 内部 endpoint。

## E. 漂移风险

- [ ] 注意：`src/skills/*/SKILL.md` 与 `references/*.md` 是**给人读的存档**，
      运行期生效的闸门文本在 `src/llm/prompts.ts`（随编译产物发布，不做运行期路径解析）。
      若两者对不上，以 `prompts.ts` 为准，并**同步补档** —— 改语义时两边都要改。
