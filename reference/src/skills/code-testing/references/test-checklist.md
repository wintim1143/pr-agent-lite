# Test Checklist — 测试闸门核对清单

`code-testing` skill 「详见」的参照明细。改动必须过此清单才能放行进入 `code-review`。

## A. 跑测试（红线）

- [ ] `npm test`（jest）全绿。任一用例失败 → 标红打回，**不可放行**。
- [ ] 新增行为必须配测试，尤其是：
  - storage / `suspend()`-`resume()` 跨请求恢复链路（守护用例见 `test/mastra/storage.test.ts`）；
  - 任何「不配 storage 也能跑」的假设变更（实测必失败，见该测试注释）。

## B. 测试写法规约（本项目踩过的坑）

- [ ] 触碰 LibSQLStore 的测试，**必须在 `afterAll` 先 `await storage.close()` 再删文件**：
  - Windows 下 LibSQL 持有 `-wal`/`-shm` 文件锁，紧跟的 `rmSync` 会报 `EBUSY: resource busy or locked`；
  - 未释放会**每次跑泄漏一个 `%TEMP%/mastra-storage-test-*.db`**。
  - 若 `instanceA`/`instanceB` 各自 `new Mastra({ storage })`，需逐个 `close()`（未必复用同一连接）。
  - 删文件用「遇 EBUSY 退避重试」封装（见 `storage.test.ts` 的 `removeWithRetry`），兼容 libsql 异步释放锁。
- [ ] 测试**不得污染开发库**：用 `APP_DB_PATH` 环境变量把 storage 指向临时库，且必须在 `require('../../src/mastra')` **之前**设置（该模块加载即读环境变量定 db 路径）。
- [ ] 不写依赖外部网络 / 凭据的测试（本环境 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 未配置、`gh` 未装）。端到端调用应 mock 或留 TODO 桩。

## C. 回归保护

- [ ] 改动未破坏既有用例（`npm test` 全量跑，不只跑单文件）。
- [ ] 若改了 build / lint 配置，确认 `npm run build` 仍通过、`npm run lint` 仍可执行（本环境 `mwts check` 冷启动偶发卡顿，需给足超时）。

## D. 覆盖度建议

- [ ] 边界值、空输入、异常分支有对应用例或显式标注「已知未覆盖」。
- [ ] 关键架构约束（storage 持久化、闸门不通过不继续）有回归测试守护，误删配置即失败。
