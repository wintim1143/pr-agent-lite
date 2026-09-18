/**
 * `progress.ts` 写 API 单测（M6-1 / M6-2 / M6-5）。
 *
 * ## 本文件最重要的两组断言
 *
 * 1. **`runId` 不会被污染**（2026-09-17 之前的真实事故）：701 条事件里带 runId 的 6 条，
 *    值全是字面量 `"rejected"` / `"resumed"` —— 因为旧签名 `stageStart(stageName: string, runId?: string)`
 *    两个形参都是 string，`stageStart('merge', 'rejected')` **编译器不报错**。
 *    类型层面现在改成对象参数（漏传即编译失败），这里再补运行期负向断言。
 * 2. **`run:end` 有且仅有 1 条**（AC-8）：失败路径上多层 catch 都会走到终态收口，
 *    没有幂等闸就会写出两条。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendRecord, readAllRecords, readRun } from '../src/log-store';
import { runEnd, runStart, runSuspend, stage, stageFail, stageOk, stageStart } from '../src/progress';

let dir: string;
let logFile: string;
const saved = { file: process.env.APP_PROGRESS_FILE, enabled: process.env.APP_PROGRESS_LOG };
let logs: string[] = [];
let warns: string[] = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-app-progress-'));
  logFile = path.join(dir, 'dev-workflow.log');
  process.env.APP_PROGRESS_FILE = logFile;
  delete process.env.APP_PROGRESS_LOG;
  // 镜像输出会淹没测试输出；顺便把它捕获下来，用于断言「终端镜像确实存在」
  logs = [];
  warns = [];
  jest.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
  jest.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void warns.push(a.join(' ')));
});

afterEach(() => {
  jest.restoreAllMocks();
  if (saved.file === undefined) delete process.env.APP_PROGRESS_FILE;
  else process.env.APP_PROGRESS_FILE = saved.file;
  if (saved.enabled === undefined) delete process.env.APP_PROGRESS_LOG;
  else process.env.APP_PROGRESS_LOG = saved.enabled;
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = (runId: string) => readRun(runId, { APP_PROGRESS_FILE: logFile } as NodeJS.ProcessEnv);

describe('progress · 对象参数与 traceId（M6-2）', () => {
  it('stageStart 落一对 step:start / step:done，且 traceId = `${runId}:${stage}`', () => {
    const p = stageStart({ stage: 'checkout', runId: 'R1' });
    const ms = p.done({ branch: 'feat/1-x' });

    const [s, d] = read('R1');
    expect(s).toMatchObject({ event: 'step:start', stage: 'checkout', runId: 'R1', traceId: 'R1:checkout' });
    expect(d).toMatchObject({ event: 'step:done', stage: 'checkout', runId: 'R1', traceId: 'R1:checkout', branch: 'feat/1-x' });
    expect(typeof ms).toBe('number');
    expect(d.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('fail 把任意错误（含字符串、反直觉对象）统一成可读 message', () => {
    const p = stageStart({ stage: 'test', runId: 'R2' });
    p.fail(new Error('GATE_REJECTED@test: 判负'));
    p.fail('裸字符串错误');
    p.fail({ weird: true });
    const fails = read('R2').filter(r => r.event === 'step:fail');
    expect(fails.map(f => String(f.error))).toEqual([
      'GATE_REJECTED@test: 判负',
      '裸字符串错误',
      '[object Object]',
    ]);
  });

  it('stage / stageOk / stageFail 落同一条事件（别名不改变语义）', () => {
    stage('llm:start', { stage: 'gate', runId: 'R3', attempt: 1 });
    stageOk('llm:done', { stage: 'gate', runId: 'R3', attempt: 1, usage: null });
    stageFail('llm:retry', { stage: 'gate', runId: 'R3', attempt: 1, error: 'x' });
    expect(read('R3').map(r => r.event)).toEqual(['llm:start', 'llm:done', 'llm:retry']);
  });

  it('拿不到 runId 的普通阶段会额外落 trace:missing —— 绝不静默', () => {
    stage('repo:lock', { stage: 'checkout', runId: null, repoKey: 'a/b' });
    const evs = readAllRecords({ APP_PROGRESS_FILE: logFile } as NodeJS.ProcessEnv).records;
    expect(evs.map(e => e.event)).toEqual(['repo:lock', 'trace:missing']);
    expect(evs[0].runId).toBeNull();
    expect(evs[1]).toMatchObject({ stage: 'checkout', runId: null, originalEvent: 'repo:lock' });
  });

  it('规范允许 runId:null 的三个阶段（startup / logger / inbound）不落 trace:missing', () => {
    stage('config:check', { stage: 'startup', runId: null, level: 'info', summary: 'x' });
    stage('inbound:error', { stage: 'inbound', runId: null, kind: 'k' });
    expect(readAllRecords({ APP_PROGRESS_FILE: logFile } as NodeJS.ProcessEnv).records.map(e => e.event)).toEqual([
      'config:check',
      'inbound:error',
    ]);
  });

  it('runId 槽位收到语义串（阶段名 / rejected / resumed）时按 null 处理并单独落 log:invalid-runid', () => {
    // 这些正是 2026-09-17 之前在历史日志里污染 runId 的取值
    stage('step:done', { stage: 'merge', runId: 'rejected' as unknown as string, merged: false });
    stage('step:done', { stage: 'merge', runId: 'resumed' as unknown as string, merged: true });
    stage('step:done', { stage: 'checkout', runId: 'checkout' as unknown as string });

    const evs = readAllRecords({ APP_PROGRESS_FILE: logFile } as NodeJS.ProcessEnv).records;
    // 六条：三条业务事件 + 三条 log:invalid-runid
    expect(evs.filter(e => e.event === 'log:invalid-runid')).toHaveLength(3);
    // 关键：污染值**没有**进 runId 槽
    for (const e of evs.filter(e => e.event === 'step:done')) expect(e.runId).toBeNull();
    const bad = read('rejected');
    expect(bad).toEqual([]); // 用污染值反查不到任何东西
    expect(evs[1]).toMatchObject({ event: 'log:invalid-runid', invalidRunId: 'rejected', originalEvent: 'step:done' });
  });

  it('runId 前后空白被规整，空串视为 null', () => {
    stage('step:start', { stage: 'coding', runId: '  R4 \n' });
    stage('step:start', { stage: 'coding', runId: '   ' });
    expect(read('R4')).toHaveLength(1);
  });
});

describe('progress · run 终态（M6-5 / AC-8）', () => {
  it('runEnd 幂等：同一 runId 调多次只落一条（失败路径上多层 catch 都会走到这里）', () => {
    runStart({ stage: 'checkout', runId: 'R10' });
    runEnd({ stage: 'test', runId: 'R10', status: 'failed', failedStage: 'test', reason: 'x' });
    runEnd({ stage: 'test', runId: 'R10', status: 'failed', failedStage: 'test', reason: 'x' });
    expect(read('R10').filter(e => e.event === 'run:end')).toHaveLength(1);
  });

  it('run:end 带 status / 墙钟耗时 / step 计数（计数是程序数出来的，不是人写的）', async () => {
    runStart({ stage: 'checkout', runId: 'R11' });
    stageStart({ stage: 'checkout', runId: 'R11' }).done();
    stageStart({ stage: 'coding', runId: 'R11' }).done();
    stageStart({ stage: 'test', runId: 'R11' }).fail(new Error('判负'));
    stage('llm:done', { stage: 'coding', runId: 'R11', usage: { totalTokens: 9 } });
    stage('llm:done', { stage: 'coding', runId: 'R11', heartbeat: true });
    await new Promise(r => setTimeout(r, 5));
    runEnd({ stage: 'test', runId: 'R11', status: 'failed', failedStage: 'test', reason: '判负' });

    const end = read('R11').find(e => e.event === 'run:end')!;
    expect(end).toMatchObject({ status: 'failed', failedStage: 'test', stepsDone: 2, stepsFailed: 1, llmCalls: 1 });
    expect(end.durationMs).toBeGreaterThanOrEqual(5);
  });

  it('跨进程语义：内存里没有起始时刻时，从日志回读 run:start 算耗时（不写 0）', () => {
    // 模拟「merge 步 suspend 后由另一个进程 resume」：run:start 只存在于文件里
    appendRecord(
      { ts: new Date(Date.now() - 3000).toISOString(), event: 'run:start', stage: 'checkout', runId: 'R12', traceId: 'R12:checkout' },
      { APP_PROGRESS_FILE: logFile } as NodeJS.ProcessEnv
    );
    runEnd({ stage: 'merge', runId: 'R12', status: 'ok', reason: 'merge-ok' });

    const end = read('R12').find(e => e.event === 'run:end')!;
    expect(end.durationMs).toBeGreaterThanOrEqual(2900);
  });

  it('找不到 run:start 时**不写 0**，而是给出显式提示（未知 ≠ 零）', () => {
    runEnd({ stage: 'merge', runId: 'R13', status: 'ok' });
    const end = read('R13').find(e => e.event === 'run:end')!;
    expect(end.durationMs).toBeUndefined();
    expect(String(end.durationHint)).toContain('不可得');
  });

  it('run:suspend 独立成事件 —— 不再借 step:start 表达挂起（配对判据的干净性）', () => {
    runStart({ stage: 'merge', runId: 'R14' });
    runSuspend({ stage: 'merge', runId: 'R14', waitingFor: 'merge-approval', issueNumber: 5 });

    const evs = read('R14');
    expect(evs.map(e => e.event)).toEqual(['run:start', 'run:suspend']);
    // 挂起不该产生任何 step 事件，否则 step:start 会凭空多一个无配对的 start
    expect(evs.filter(e => e.event.startsWith('step:'))).toHaveLength(0);
  });

  it('run:end 的 status 是**业务终态**，与 Mastra 自己的 success/failed 解耦', () => {
    runStart({ stage: 'checkout', runId: 'R15' });
    runEnd({ stage: 'merge', runId: 'R15', status: 'rejected', reason: '人工拒绝' });
    expect(read('R15').find(e => e.event === 'run:end')!.status).toBe('rejected');
  });
});

describe('progress · 落盘与镜像（AC-9 fail-open）', () => {
  it('写日志失败时**不抛错**，只在 stderr 留一行告警（观测是辅助，不是安全边界）', () => {
    process.env.APP_PROGRESS_FILE = dir; // 指向目录 → append 必失败
    expect(() => stageStart({ stage: 'checkout', runId: 'R20' }).done()).not.toThrow();
    expect(() => runEnd({ stage: 'checkout', runId: 'R20', status: 'ok' })).not.toThrow();
    expect(warns.some(w => w.includes('写日志失败'))).toBe(true);
  });

  it('APP_PROGRESS_LOG=0 完全静默（落盘与镜像一起关，不留半开状态）', () => {
    process.env.APP_PROGRESS_LOG = '0';
    stageStart({ stage: 'checkout', runId: 'R21' }).done();
    runEnd({ stage: 'checkout', runId: 'R21', status: 'ok' });
    expect(fs.existsSync(logFile)).toBe(false);
    expect(logs).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });

  it('人看的镜像行里能直接看到 run 短标识（排障时不必先解析 JSON）', () => {
    stageStart({ stage: 'coding', runId: 'abcdef1234567890' }).done({ note: 'ok' });
    expect(logs.some(l => l.includes('coding') && l.includes('run=abcdef12'))).toBe(true);
  });

  it('失败类事件走 stderr 镜像（不然 tail 时会把错误淹在正常输出里）', () => {
    stageStart({ stage: 'test', runId: 'R22' }).fail(new Error('boom'));
    expect(warns.some(w => w.includes('step:fail'))).toBe(true);
  });
});
