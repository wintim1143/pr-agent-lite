/**
 * `log-store.ts` 单测（M6-3 / M6-4 / M6-5）。
 *
 * ## 为什么这些断言必须是**确定性**的
 *
 * M6 的失败模式是「日志在，但关联不起来」—— 不报错、不缺行，只是无法回答
 * 「这是哪个 run 的哪一步」。这类缺陷**不会让任何东西变红**，所以判据只能是
 * 「可数 + 可分组」的事实。这里用临时目录造出精确的字节/事件序列，
 * 把「轮转后仍能取全一个 run」「双 run 交错时不串台」变成秒级可判定的断言。
 *
 * 所有用例都在 `os.tmpdir()` 下自建目录，**不碰** `logs/` 下的真实历史
 * （那是 M1–M5 的证据载体，写坏了不可复原）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendRecord,
  costByRepo,
  llmSummary,
  logFilePath,
  logKeepCount,
  logMaxBytes,
  normalizeUsage,
  pairingReport,
  readAllRecords,
  readOrder,
  readRun,
  rotate,
  rotatedPath,
  type LogRecord,
} from '../src/log-store';

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-app-logstore-'));
  env = { APP_PROGRESS_FILE: path.join(dir, 'dev-workflow.log') } as NodeJS.ProcessEnv;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function rec(partial: Partial<LogRecord> & { event: string; ts: string }): LogRecord {
  return { runId: null, stage: 'checkout', ...partial } as LogRecord;
}

describe('log-store · 基础追加与读取', () => {
  it('追加一行后能原样读回（含 runId / traceId / durationMs）', () => {
    const r = rec({ event: 'step:done', ts: '2026-09-17T00:00:00.000Z', runId: 'R1', traceId: 'R1:checkout', durationMs: 12, branch: 'feat/1-x' });
    expect(appendRecord(r, env).ok).toBe(true);

    const { records, badLines, files } = readAllRecords(env);
    expect(badLines).toBe(0);
    expect(files).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: 'step:done', runId: 'R1', traceId: 'R1:checkout', durationMs: 12, branch: 'feat/1-x' });
  });

  it('多条追加保持写入顺序（读取不做 ts 排序 —— 同毫秒事件不能被重排）', () => {
    const ts = '2026-09-17T00:00:00.000Z';
    for (const e of ['step:start', 'llm:start', 'llm:done', 'step:done']) appendRecord(rec({ event: e, ts, runId: 'R1' }), env);
    expect(readAllRecords(env).records.map(r => r.event)).toEqual(['step:start', 'llm:start', 'llm:done', 'step:done']);
  });

  it('损坏行不抛错，只计入 badLines（历史日志实测为 0，非 0 即异常信号）', () => {
    fs.writeFileSync(logFilePath(env), '{"event":"ok","ts":"t"}\nNOT_JSON\n\n', 'utf8');
    const res = readAllRecords(env);
    expect(res.badLines).toBe(1);
    expect(res.records).toHaveLength(1);
  });

  it('文件不存在时返回空集合而不是抛错', () => {
    expect(readAllRecords(env)).toEqual({ records: [], files: [], badLines: 0 });
  });
});

describe('log-store · 轮转（AC-10）', () => {
  it('超过阈值触发轮转，且**当前 run 的事件仍完整可查**（前提：落在保留窗口内）', () => {
    // 契约要读准：轮转是「旧的滚出去、新的留下来」。
    // 所以「一个 run 的事件无缺」在有界保留下只对**不超过 keep 份文件**的 run 成立
    // —— 本用例把事件量控制在这个预算内（真实的 run 只有几百条事件、且默认 keep=5 × 5MiB）。
    const env2 = { ...env, APP_LOG_MAX_BYTES: '300', APP_LOG_KEEP: '5' } as NodeJS.ProcessEnv;
    const events: string[] = [];
    for (let i = 0; i < 12; i++) {
      const e = `e${String(i).padStart(2, '0')}`;
      events.push(e);
      appendRecord(rec({ event: e, ts: `2026-09-17T00:00:${String(i).padStart(2, '0')}.000Z`, runId: 'R-ROTATE' }), env2);
    }

    // 1) 确实发生了轮转（不止一个文件）
    const all = readAllRecords(env2);
    expect(all.files.length).toBeGreaterThan(1);

    // 2) 全部且仅属于 R-ROTATE 的事件都在，且顺序正确
    const got = readRun('R-ROTATE', env2).map(r => r.event);
    expect(got).toEqual(events);

    // 3) 读取顺序契约：最旧的轮转文件在前，当前文件最后
    expect(readOrder(logFilePath(env2), logKeepCount(env2)).at(-1)).toBe(logFilePath(env2));
  });

  it('超出 keep 的最旧轮转文件会被丢弃 —— 有意的有界保留，不是 bug', () => {
    // 这条把「丢弃」显式断言下来：将来有人调小 keep 或写超长事件时，
    // 会先看到这条测试，而不是在生产上发现「某个 run 的前半段不见了」。
    const env2 = { ...env, APP_LOG_MAX_BYTES: '150', APP_LOG_KEEP: '2' } as NodeJS.ProcessEnv;
    for (let i = 0; i < 30; i++) {
      appendRecord(rec({ event: `e${String(i).padStart(2, '0')}`, ts: `t${i}`, runId: 'R-OLD', pad: 'y'.repeat(40) }), env2);
    }
    expect(fs.existsSync(rotatedPath(logFilePath(env2), 1))).toBe(true);
    expect(fs.existsSync(rotatedPath(logFilePath(env2), 2))).toBe(true);
    expect(fs.existsSync(rotatedPath(logFilePath(env2), 3))).toBe(false);
    // 事件总量必然少于写入量（旧文件被丢了），但**保留窗口内是连续的**
    const kept = readRun('R-OLD', env2).map(r => r.event);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(30);
    expect(kept.at(-1)).toBe('e29'); // 最新的一条一定在
  });

  it('APP_LOG_MAX_BYTES=0 表示永不轮转', () => {
    const env2 = { ...env, APP_LOG_MAX_BYTES: '0' } as NodeJS.ProcessEnv;
    expect(logMaxBytes(env2)).toBe(0);
    for (let i = 0; i < 50; i++) appendRecord(rec({ event: 'x', ts: `t${i}`, runId: 'R' }), env2);
    expect(readAllRecords(env2).files).toHaveLength(1);
  });

  it('rotate() 在没有任何文件时安全返回 0', () => {
    expect(rotate(path.join(dir, 'nope.log'), 3)).toBe(0);
  });
});

describe('log-store · run 分离与配对（AC-4 / AC-6）', () => {
  it('双 run 交错写入后，按 runId 过滤**全部且仅属于**该 run（不串台、不漏）', () => {
    const seq: Array<[string, string]> = [
      ['A', 'step:start'],
      ['B', 'step:start'],
      ['A', 'step:done'],
      ['B', 'step:done'],
      ['A', 'llm:start'],
      ['A', 'llm:done'],
    ];
    seq.forEach(([runId, event], i) => appendRecord(rec({ event, ts: `2026-09-17T00:00:0${i}.000Z`, runId }), env));

    const a = readRun('A', env);
    const b = readRun('B', env);
    expect(a.map(r => r.event)).toEqual(['step:start', 'step:done', 'llm:start', 'llm:done']);
    expect(b.map(r => r.event)).toEqual(['step:start', 'step:done']);
    // 严格相等（不是前缀匹配）—— runId 前缀撞车是**静默**的，必须防
    expect(a.every(r => r.runId === 'A')).toBe(true);
    expect(b.every(r => r.runId === 'B')).toBe(true);
  });

  it('前缀相似的 runId 不会互相串入（A1 vs A11）', () => {
    appendRecord(rec({ event: 'step:start', ts: 't1', runId: 'A1' }), env);
    appendRecord(rec({ event: 'step:start', ts: 't2', runId: 'A11' }), env);
    expect(readRun('A1', env)).toHaveLength(1);
    expect(readRun('A11', env)).toHaveLength(1);
  });

  it('配对报告能指出「哪个 run 的哪一步」不平衡，并把历史遗留单独成桶', () => {
    appendRecord(rec({ event: 'step:start', ts: 't1', runId: 'R1', stage: 'test' }), env);
    appendRecord(rec({ event: 'step:fail', ts: 't2', runId: 'R1', stage: 'test' }), env);
    // R2 的 commit 只有 end 没有 start（历史日志里就是这么不对称的）
    appendRecord(rec({ event: 'step:done', ts: 't3', runId: 'R2', stage: 'commit' }), env);
    // 历史遗留：没有 runId
    appendRecord(rec({ event: 'step:done', ts: 't4', runId: undefined, stage: 'review' }), env);

    const rep = pairingReport(readAllRecords(env).records);
    expect(rep.unbalanced).toHaveLength(1);
    expect(rep.unbalanced[0]).toMatchObject({ runId: 'R2', stage: 'commit', starts: 0, ends: 1, delta: -1 });
    expect(rep.legacyUnbalanced).toHaveLength(1);
    expect(rep.legacyUnbalanced[0]).toMatchObject({ runId: null, stage: 'review' });
    expect(rep.totals).toMatchObject({ events: 4, attributed: 3, unattributed: 1, runs: 2 });
    expect(rep.totals.byEvent).toMatchObject({ 'step:start': 1, 'step:done': 2, 'step:fail': 1 });
  });

  it('配对平衡时 unbalanced 为空', () => {
    appendRecord(rec({ event: 'step:start', ts: 't1', runId: 'R', stage: 'coding' }), env);
    appendRecord(rec({ event: 'step:done', ts: 't2', runId: 'R', stage: 'coding' }), env);
    expect(pairingReport(readAllRecords(env).records).unbalanced).toEqual([]);
  });

  it('llmSummary 把心跳从 llm:done 里剔除（否则 coding 会被算成几十次调用）', () => {
    appendRecord(rec({ event: 'llm:start', ts: 't1', runId: 'R', stage: 'coding' }), env);
    appendRecord(rec({ event: 'llm:done', ts: 't2', runId: 'R', stage: 'coding', heartbeat: true }), env);
    appendRecord(rec({ event: 'llm:done', ts: 't3', runId: 'R', stage: 'coding', heartbeat: true }), env);
    appendRecord(rec({ event: 'llm:done', ts: 't4', runId: 'R', stage: 'coding' }), env);
    const s = llmSummary(readAllRecords(env).records);
    expect(s.coding).toEqual({ starts: 1, done: 1, retry: 0, heartbeats: 2 });
  });
});

describe('log-store · 成本归口（AC-7）', () => {
  it('normalizeUsage：拿不到就是 null，**绝不等价于 0**', () => {
    expect(normalizeUsage(undefined)).toBeNull();
    expect(normalizeUsage(null)).toBeNull();
    expect(normalizeUsage({})).toBeNull();
    expect(normalizeUsage('187')).toBeNull();
    // 真实的 0 与「不知道」必须区分得开
    expect(normalizeUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it('normalizeUsage 兼容 AI SDK v5（input/output）与 v4（prompt/completion）两套命名', () => {
    expect(normalizeUsage({ inputTokens: 10, outputTokens: 5 })).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(normalizeUsage({ promptTokens: 7, completionTokens: 3, totalTokens: 10 })).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  });

  it('costByRepo 按 repoKey 聚合 token 与调用次数，并单列「拿不到 usage」的次数', () => {
    appendRecord(rec({ event: 'repo:target', ts: 't1', runId: 'R1', stage: 'checkout', repoKey: 'example-org/sample-target' }), env);
    appendRecord(rec({ event: 'repo:target', ts: 't2', runId: 'R2', stage: 'checkout', repoKey: 'local/b' }), env);
    appendRecord(rec({ event: 'llm:done', ts: 't3', runId: 'R1', stage: 'test', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }), env);
    appendRecord(rec({ event: 'llm:done', ts: 't4', runId: 'R1', stage: 'review', usage: null }), env);
    appendRecord(rec({ event: 'llm:done', ts: 't5', runId: 'R2', stage: 'test', usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 } }), env);
    // 心跳不算一次 LLM 调用
    appendRecord(rec({ event: 'llm:done', ts: 't6', runId: 'R2', stage: 'coding', heartbeat: true, usage: null }), env);

    const rows = costByRepo(readAllRecords(env).records);
    const a = rows.find(r => r.repoKey === 'example-org/sample-target')!;
    expect(a).toMatchObject({ llmCalls: 2, totalTokens: 120, unknownUsage: 1 });
    const b = rows.find(r => r.repoKey === 'local/b')!;
    expect(b).toMatchObject({ llmCalls: 1, totalTokens: 10, unknownUsage: 0 });
  });

  it('没有 repo:target 的单仓库 run 归入「(未指定仓库)」而不是猜 cwd', () => {
    appendRecord(rec({ event: 'llm:done', ts: 't1', runId: 'R', stage: 'test', usage: { totalTokens: 3 } }), env);
    expect(costByRepo(readAllRecords(env).records)[0].repoKey).toBe('(未指定仓库)');
  });
});

describe('log-store · fail-open（AC-9 的存储层）', () => {
  it('目标是目录（append 必失败）时返回 ok:false 且不抛错', () => {
    const badEnv = { APP_PROGRESS_FILE: dir } as NodeJS.ProcessEnv; // dir 本身是目录
    const res = appendRecord(rec({ event: 'step:start', ts: 't', runId: 'R' }), badEnv);
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it('父路径是文件（mkdir 必失败）时同样不抛错', () => {
    const f = path.join(dir, 'afile');
    fs.writeFileSync(f, 'x');
    const badEnv = { APP_PROGRESS_FILE: path.join(f, 'nested', 'a.log') } as NodeJS.ProcessEnv;
    expect(appendRecord(rec({ event: 'step:start', ts: 't', runId: 'R' }), badEnv).ok).toBe(false);
  });
});
