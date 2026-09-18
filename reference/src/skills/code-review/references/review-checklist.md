# Review Checklist — 代码审核风格核对清单

`code-review` skill 第 2 步「核对仓库风格」的参照明细。审核时逐条过，命中即记意见。

## A. Mastra / 工作流约束（本项目硬规则）

- [ ] 创建步骤一律用 `createStep({ id, description, inputSchema, outputSchema, execute })`；**禁止**用 `Step` 类（运行期 `undefined`）。
- [ ] `Workflow` 构造必须带 `outputSchema`；链式串联用 `.then(step)`（含第一个步骤），末尾 `.commit()`。
- [ ] `merge` 闸门依赖 `suspend()` / `resume()`，**强依赖持久化 storage**（见 `test/mastra/storage.test.ts`）。审核「去掉 storage / 改 in-memory」类改动时直接拒。
- [ ] `Agent.skills` 优先内联 `createSkill(...)` 实例；若用 `'./skills/<name>'` 路径，确认运行期 cwd 解析正确（构建后基准不确定，慎用）。
- [ ] `src/index.ts` 必须导出名为 `mastra` 的 `Mastra` 实例（否则 `npx mastra dev` 报 `No index.ts and no file-based primitives found`）。

## B. Midway 集成约束

- [ ] `registerMastra` 里 `MastraServer` 的 `app` 桥接 `as any` **只允许出现这一处**（`@mastra/koa` 期望标准 Koa 实例类型，Midway 注入的是 `koa.Application` 子类，运行期兼容、编译期对不上）。
- [ ] 改 `src/**` 后必须能 `npm run build`（`mwtsc --cleanOutDir`）。**禁止把编译产物残留进 dist**——Midway 全目录扫描 dist，孤儿 `.js` 会被照常加载（幽灵路由/旧逻辑）。`cleanOutDir` 不可去掉。

## C. 正确性 / 边界 / 隐患

- [ ] 异步路径是否全部 `await`；悬挂 Promise、未捕获 reject。
- [ ] 资源释放：LibSQLStore 连接、文件句柄、定时器在失败/异常分支也要释放（参考 `storage.test.ts` 的 `afterAll` 先 `close()` 再删文件）。
- [ ] 并发 / 竞争：多实例共享 storage、卡片回调并发 resume 是否安全。
- [ ] 不吞异常、不静默失败（尤其 `try/catch` 后空 body）。
- [ ] 外部副作用（开 PR、发 IM）是否幂等、是否需人工 approve 闸门拦截。

## D. 提交规范（红线）

- [ ] 分支模型 trunk-based + 短期 `feat/<issue>-<slug>`，合并即删。
- [ ] Conventional Commits + 过 `commitlint`；末尾 `Closes #<issue>`。
- [ ] 不提交 `dist/`、`node_modules/`、`.env`（已 gitignore）。
- [ ] 不提交凭据 / 内部 endpoint。

## E. 漂移风险

- [ ] 注意：`src/skills/*/SKILL.md` 是**存档**，代码实际加载 `dev-agent.ts` 内联的 `createSkill`。若两者对不上，以内联为准，并补 `scripts/sync-mastra-skill.mjs`（见未合并分支 `chore-mastra-official-skill`）防漂移。
