/**
 * M2 只读工具的单测。
 *
 * 这里钉住的是**三条容易悄悄退化成谎话**的性质：
 *
 * 1. **「没有记录」必须说成「没有记录」**，不能返回空数组让人读成「一切正常」——
 *    空数组与「确实没有」在人眼里是两回事，而在 JSON 里长得一模一样。
 * 2. **未结束 ≠ 成功**。`status` 为 `null` 时任何把 `null` 当 falsy 处理的地方都会显示成失败或成功，
 *    两种都是编造。
 * 3. **拿不到 usage 的调用不能被算进 token 总数**（那会把「未知」写成 0），
 *    且必须在 `unknownUsage` 里报出来 —— 否则成本报表永远显示「很便宜」。
 *
 * 全部用**临时日志文件**驱动：`log-store` 每次调用都重读 env（见其文件头），
 * 所以不需要 mock 模块，也不会碰到生产日志。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { listRuns, readAllRecords } from '../src/log-store';
import { repoList, runCost, runStatus } from '../src/tools/readonly';

let dir: string;
let logFile: string;
let registryFile: string;
/** 上一个文件的日志路径（jest.setup.ts 设的）—— 用后必须还回去。 */
let savedLogFile: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pral-readonly-'));
  logFile = path.join(dir, 'test.log');
  registryFile = path.join(dir, 'repos.registry.json');
  savedLogFile = process.env.PRAL_PROGRESS_FILE;
  process.env.PRAL_PROGRESS_FILE = logFile;
  process.env.REPO_REGISTRY_PATH = registryFile;
});

afterEach(() => {
  // ⚠️ 必须还原：jest 的同一个 worker 会**顺序跑多个测试文件**，
  // 本文件把路径改成临时目录后不还回去，后面的文件就会往一个已删除的目录里写日志。
  // 而 `appendRecord` 是 fail-open 的（写不进去只 warn）—— 症状是「别的文件的断言莫名其妙失败」。
  if (savedLogFile === undefined) delete process.env.PRAL_PROGRESS_FILE;
  else process.env.PRAL_PROGRESS_FILE = savedLogFile;
  delete process.env.REPO_REGISTRY_PATH;
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeLog(records: unknown[]): void {
  fs.writeFileSync(logFile, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

/** 造一条最小事件；只写测试真正要断言的字段。 */
function rec(event: string, runId: string | null, extra: Record<string, unknown> = {}): unknown {
  return { ts: extra.ts ?? '2026-09-19T00:00:00.000Z', event, stage: extra.stage ?? 'coding', runId, ...extra };
}

describe('listRuns —— 从日志重建 run 列表', () => {
  it('未结束的 run：status 与 endedAt 都是 null（**不等于成功**）', () => {
    writeLog([
      rec('run:start', 'r1', { ts: '2026-09-19T00:00:00.000Z', stage: 'startup' }),
      rec('step:start', 'r1', { ts: '2026-09-19T00:00:01.000Z', stage: 'coding' }),
    ]);
    const [run] = listRuns(readAllRecords().records);
    expect(run.runId).toBe('r1');
    expect(run.status).toBeNull();
    expect(run.endedAt).toBeNull();
    expect(run.startedAt).toBe('2026-09-19T00:00:00.000Z');
    expect(run.lastStage).toBe('coding');
  });

  it('只认「事件带了这个 runId」，不要求存在 run:start（缺起点时 startedAt 为 null）', () => {
    writeLog([rec('step:done', 'r9', { ts: '2026-09-19T00:00:05.000Z', stage: 'test' })]);
    const r = runStatus({ runId: 'r9' });
    expect(r.run?.runId).toBe('r9');
    expect(r.run?.startedAt).toBeNull();
    expect(r.run?.stepsDone).toBe(1);
  });

  it('心跳不计入 llmCalls（否则 coding 步会被算成几十次调用）', () => {
    writeLog([
      rec('llm:done', 'r2', { heartbeat: true, usage: null }),
      rec('llm:done', 'r2', { usage: null }),
    ]);
    const r = runStatus({ runId: 'r2' });
    expect(r.run?.llmCalls).toBe(1);
    expect(r.run?.unknownUsage).toBe(1);
  });

  it('按最后一条事件时间倒序，且遵守 limit', () => {
    writeLog([
      rec('run:start', 'old', { ts: '2026-09-19T00:00:00.000Z' }),
      rec('run:start', 'new', { ts: '2026-09-19T02:00:00.000Z' }),
      rec('step:done', 'mid', { ts: '2026-09-19T01:00:00.000Z' }),
    ]);
    const r = runStatus({ limit: 2 });
    expect(r.runs.map(x => x.runId)).toEqual(['new', 'mid']);
  });

  it('没有任何记录时，runs 为空**且**给出「没有运行记录」的明确说法', () => {
    writeLog([]);
    const r = runStatus();
    expect(r.runs).toEqual([]);
    expect(r.notes.join(' ')).toContain('没有运行记录');
    // 空数组本身不足以说明问题 —— 必须同时有说明文字，这条断言就是钉这个
    expect(r.notes.join(' ')).toContain('不是工具出错');
  });
});

describe('runStatus —— 单 run 详情', () => {
  it('runId 查不到：明说查不到，并指出「不猜测」与两个可能原因', () => {
    writeLog([rec('run:start', 'exists')]);
    const r = runStatus({ runId: 'typo' });
    expect(r.run).toBeNull();
    expect(r.timeline).toEqual([]);
    const text = r.notes.join(' ');
    expect(text).toContain('typo');
    expect(text).toContain('不做任何猜测');
  });

  it('步骤配对：有 start 无终态时 delta 非 0 且 balanced=false', () => {
    writeLog([
      rec('step:start', 'r3', { stage: 'test' }),
      rec('step:done', 'r3', { stage: 'test' }),
      rec('step:start', 'r3', { stage: 'review' }),
    ]);
    const r = runStatus({ runId: 'r3' });
    const test = r.pairing.find(p => p.stage === 'test');
    const review = r.pairing.find(p => p.stage === 'review');
    expect(test).toMatchObject({ starts: 1, done: 1, delta: 0, balanced: true });
    expect(review).toMatchObject({ starts: 1, done: 0, delta: 1, balanced: false });
  });

  it('未结束的 run 会附带提醒：未结束不等于成功', () => {
    writeLog([rec('run:start', 'r4'), rec('step:start', 'r4')]);
    const r = runStatus({ runId: 'r4' });
    expect(r.notes.join(' ')).toContain('未结束不等于成功');
  });

  it('时间线只取尾部 timelineLimit 条', () => {
    writeLog([
      rec('step:start', 'r5', { stage: 'a' }),
      rec('step:done', 'r5', { stage: 'a' }),
      rec('step:start', 'r5', { stage: 'b' }),
    ]);
    const r = runStatus({ runId: 'r5', timelineLimit: 2 });
    expect(r.timeline).toHaveLength(2);
    expect(r.timeline.map(t => t.stage)).toEqual(['a', 'b']);
  });
});

describe('runCost —— 不把「未知」写成 0', () => {
  it('未回传 usage 的调用只进 unknownUsage，不进 token 数，并显式声明是下界', () => {
    writeLog([
      rec('repo:target', 'r6', { repoKey: 'o/r' }),
      rec('llm:done', 'r6', { usage: null }),
      rec('llm:done', 'r6', { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
    ]);
    const r = runCost();
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ repoKey: 'o/r', llmCalls: 2, totalTokens: 15, unknownUsage: 1 });
    expect(r.totals.totalTokens).toBe(15);
    expect(r.notes.join(' ')).toContain('下界');
    expect(r.notes.join(' ')).toContain('不是 0');
  });

  it('指定 runId 但无记录：报空并说明不返回 0 的理由', () => {
    writeLog([rec('llm:done', 'other', { usage: null })]);
    const r = runCost({ runId: 'nope' });
    expect(r.rows).toEqual([]);
    expect(r.notes.join(' ')).toContain('不返回 0');
  });

  it('完全没有 LLM 调用：说明「还没跑过流程」而不是「本次没花钱」', () => {
    writeLog([rec('run:start', 'r7')]);
    const r = runCost();
    expect(r.rows).toEqual([]);
    expect(r.notes.join(' ')).toContain('不是「本次没花钱」');
  });
});

describe('repoList —— 未配置与「没有仓库」必须分开', () => {
  it('注册表不存在 → registryExists=false 且明说是「未配置」', () => {
    const r = repoList();
    expect(r.registryExists).toBe(false);
    expect(r.repos).toEqual([]);
    expect(r.notes.join(' ')).toContain('未配置');
    expect(r.notes.join(' ')).toContain('不是「没有仓库」');
  });

  it('注册表存在但 JSON 非法 → registryExists=true + 说明读不出的原因（不抛错）', () => {
    fs.writeFileSync(registryFile, '{ not json', 'utf8');
    const r = repoList();
    expect(r.registryExists).toBe(true);
    expect(r.repos).toEqual([]);
    expect(r.notes.join(' ')).toContain('读不出内容');
  });

  it('读出本机真实分支与 HEAD 提交', () => {
    // 手搓一个最小 git 仓库：只要 .git/HEAD + refs/heads/<branch>
    const repoDir = path.join(dir, 'sample');
    fs.mkdirSync(path.join(repoDir, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.git', 'HEAD'), 'ref: refs/heads/feat/x\n', 'utf8');
    fs.mkdirSync(path.join(repoDir, '.git', 'refs', 'heads', 'feat'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, '.git', 'refs', 'heads', 'feat', 'x'),
      'abcdef1234567890abcdef1234567890abcdef12\n',
      'utf8'
    );
    fs.writeFileSync(
      registryFile,
      JSON.stringify({ repos: { 'o/r': { localPath: repoDir, baseBranch: 'develop' } } }),
      'utf8'
    );

    const r = repoList();
    expect(r.registryExists).toBe(true);
    expect(r.repos).toHaveLength(1);
    expect(r.repos[0]).toMatchObject({
      key: 'o/r',
      localPath: repoDir,
      baseBranch: 'develop',
      exists: true,
      isGitRepo: true,
      currentBranch: 'feat/x',
      headCommit: 'abcdef123456',
    });
  });

  it('localPath 不存在 → exists=false 且给出可执行说明（不是静默跳过）', () => {
    fs.writeFileSync(
      registryFile,
      JSON.stringify({ repos: { 'o/gone': { localPath: path.join(dir, 'nope') } } }),
      'utf8'
    );
    const r = repoList();
    expect(r.repos[0]).toMatchObject({ exists: false, isGitRepo: false });
    expect(r.notes.join(' ')).toContain('clone');
  });
});
