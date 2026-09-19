/**
 * jest 全局前置（M6-1 新增）。
 *
 * ## 为什么需要它：测试会往**生产日志**里写事件
 *
 * `progress.ts` 的落盘路径由 `PRAL_PROGRESS_FILE` 决定，缺省是
 * `<cwd>/logs/pr-agent-lite.log`。而单测里凡是要走 `runGate()` / `guard` hook /
 * 入口轮询的用例，都会顺带写出真实的结构化事件 ——
 * 于是「日志」这份**证据**里混进了测试数据。
 *
 * 在 M6 之前这只是噪音；M6 之后它是**判据污染**：AC-3 要在
 * `logs/pr-agent-lite.log` 上断言「除启动期事件外所有事件带非空 runId」，
 * 而单测调用 `runGate` 时没有 runId（它不在 step 的 execute 上下文里），
 * 会落下一堆 `trace:missing` —— 判据会被这些与本里程碑无关的事件打红。
 *
 * ## 做法：把落盘路径挪到临时目录
 *
 * 只改路径，不改开关（`PRAL_PROGRESS_LOG` 仍保持开启）——
 * 这样单测依然能断言「事件确实被写出来了」，只是写在别处。
 *
 * ⚠️ 不要在这里设 `PRAL_PROGRESS_LOG=0`：那会让所有与日志相关的断言变成
 * 「因为根本没写所以也没报错」的假绿。
 */
import * as os from 'node:os';
import * as path from 'node:path';

process.env.PRAL_PROGRESS_FILE = path.join(os.tmpdir(), `pr-agent-lite-jest-${process.pid}.log`);
