/**
 * M5a 单测：入口层幂等（原子认领 + 游标 + 轮询编排）。
 *
 * 覆盖的验收项：
 * - AC-1  同一 messageId 连续投递 3 次 → 只起 1 个 run，且跳过有**可见证据**
 * - AC-2  去重具备原子性（并发两路认领同一 key 只有一路成功）
 * - AC-3  重启（换连接）后仍不重放
 *
 * ## 为什么「原子性」这条不能靠「跑两次看看」来验
 *
 * 顺序执行两次必然一次成功一次失败 —— 那证明的是**幂等**，不是**原子**。
 * 原子性要守的是「两个并发 poll 同时判断 key 不存在，然后都去起 run」这个窗口。
 * 所以这里用 `Promise.all` 让两个认领**在同一个 tick 内并发发起**。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  claimEvent,
  attachRunId,
  getCursor,
  advanceCursor,
  listSeenEvents,
  countSeenEvents,
  resetEventState,
} from '../src/adapters/dedup-store';
import { pollInboundOnce, type InboundMessage } from '../src/adapters/inbound-poll';
import { resetStateDb, stateDbPath } from '../src/adapters/state-db';

const SOURCE = 'feishu:test-chat';

let tmpDir: string;
let savedDbPath: string | undefined;
let dbSeq = 0;

function msg(id: string, text: string, createTime: number): InboundMessage {
  return { messageId: id, text, createTime };
}

/** 记录「起了哪些 run」的假 startRun，使「有没有重复起 run」变成可数的事实。 */
function fakeStarter() {
  const started: Array<{ text: string; id: string }> = [];
  return {
    started,
    startRun: async (text: string, m: InboundMessage) => {
      started.push({ text, id: m.messageId });
      return `run-${started.length}`;
    },
  };
}

/**
 * 每个用例用一个**全新的库文件**，且用例之间**不删除**它。
 *
 * 为什么不复用同一个文件再清空：Windows 上 libsql 释放文件句柄不是瞬时的，
 * `rmSync` 会间歇性抛 EBUSY，把「断言失败」和「清理失败」混成同一类红。
 * 每个用例独立文件后，用例之间的隔离由文件名保证，清理只需在 afterAll 做一次尽力而为。
 */
beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa5-dedup-'));
});

beforeEach(async () => {
  await resetStateDb();
  savedDbPath = process.env.APP_DB_PATH;
  process.env.APP_DB_PATH = path.join(tmpDir, `state-${++dbSeq}.db`);
});

afterAll(async () => {
  await resetStateDb();
  if (savedDbPath === undefined) delete process.env.APP_DB_PATH;
  else process.env.APP_DB_PATH = savedDbPath;
  // 尽力而为：libsql 在 Windows 上 close() 后句柄不立即释放，rmSync 会 EBUSY（见 repo-lock.test.ts 同名注释）
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[test] 临时目录未能删除（libsql 句柄未释放，非测试失败）：${(e as Error).message}`);
  }
});

describe('state-db', () => {
  it('库路径与 Mastra 同源：读 APP_DB_PATH', () => {
    expect(stateDbPath()).toBe(process.env.APP_DB_PATH);
    expect(stateDbPath().endsWith('.db')).toBe(true);
  });
});

describe('AC-2：原子认领', () => {
  it('首次认领成功，再次认领判定为 duplicate', async () => {
    await expect(claimEvent('m1', SOURCE)).resolves.toEqual({ claimed: true, reason: 'new' });
    await expect(claimEvent('m1', SOURCE)).resolves.toEqual({ claimed: false, reason: 'duplicate' });
  });

  it('并发认领同一 key：恰好只有一路成功（原子性）', async () => {
    const results = await Promise.all([
      claimEvent('race', SOURCE),
      claimEvent('race', SOURCE),
      claimEvent('race', SOURCE),
      claimEvent('race', SOURCE),
    ]);
    expect(results.filter(r => r.claimed)).toHaveLength(1);
    expect(results.filter(r => !r.claimed)).toHaveLength(3);
  });

  it('空 key 直接拒绝（没有幂等键等于没有去重）', async () => {
    await expect(claimEvent('   ', SOURCE)).rejects.toThrow(/key 不能为空/);
  });

  it('账本可按来源过滤与计数', async () => {
    await claimEvent('a', SOURCE);
    await claimEvent('b', SOURCE);
    await claimEvent('c', 'feishu:other');
    expect(await countSeenEvents(SOURCE)).toBe(2);
    expect(await countSeenEvents()).toBe(3);
    const rows = await listSeenEvents({ source: SOURCE });
    expect(rows.map(r => r.key).sort()).toEqual(['a', 'b']);
    expect(rows[0].runId).toBeNull();
  });

  it('runId 可回填（账本升级成「事件 → run」索引）', async () => {
    await claimEvent('m9', SOURCE);
    await attachRunId('m9', 'run-xyz');
    expect((await listSeenEvents({ source: SOURCE })).find(r => r.key === 'm9')?.runId).toBe('run-xyz');
  });
});

describe('AC-3：游标只前进不后退', () => {
  it('未写过 → null；写过 → 读回；给更小的值不会把它拖回去', async () => {
    expect(await getCursor(SOURCE)).toBeNull();
    expect(await advanceCursor(SOURCE, 1000)).toBe(1000);
    expect(await getCursor(SOURCE)).toBe(1000);
    expect(await advanceCursor(SOURCE, 500)).toBe(1000); // MAX 语义
    expect(await advanceCursor(SOURCE, 2000)).toBe(2000);
  });

  it('resetEventState 同时清认领账本与游标', async () => {
    await claimEvent('x', SOURCE);
    await advanceCursor(SOURCE, 123);
    expect(await resetEventState(SOURCE)).toBe(1);
    expect(await countSeenEvents(SOURCE)).toBe(0);
    expect(await getCursor(SOURCE)).toBeNull();
  });
});

describe('AC-1：同一 messageId 连续投递 3 次只起 1 个 run', () => {
  it('同一批次里投 3 条同 id 消息 → 1 个 run + 2 条 duplicate 证据', async () => {
    const { started, startRun } = fakeStarter();
    const batch = [msg('dup-1', '加个功能', 1000), msg('dup-1', '加个功能', 1000), msg('dup-1', '加个功能', 1000)];
    const res = await pollInboundOnce({
      source: SOURCE,
      sinceTs: 900,
      fetchMessages: async () => batch,
      startRun,
    });
    expect(res.success).toBe(true);
    expect(res.polled).toBe(3);
    expect(res.triggered).toHaveLength(1);
    expect(started).toHaveLength(1);
    expect(res.skipped).toEqual([
      { messageId: 'dup-1', reason: 'duplicate' },
      { messageId: 'dup-1', reason: 'duplicate' },
    ]);
    // 跳过必须留在账本里，而不是只出现在返回值里
    expect(await countSeenEvents(SOURCE)).toBe(1);
  });

  it('三轮轮询反复投同一条消息 → 只有第一轮起 run（窗口重叠也挡得住）', async () => {
    const { started, startRun } = fakeStarter();
    const one = [msg('dup-2', '改文案', 2000)];
    const rounds = [];
    for (let i = 0; i < 3; i++) {
      rounds.push(await pollInboundOnce({ source: SOURCE, fetchMessages: async () => one, startRun }));
    }
    expect(rounds.map(r => r.triggered.length)).toEqual([1, 0, 0]);
    expect(started).toHaveLength(1);
    // 第二、三轮用的是游标窗口（而非 now-3600），且确实扫到了那条消息（否则不是"挡住"而是"没扫到"）
    expect(rounds[1].windowSource).toBe('cursor');
    expect(rounds[1].polled).toBe(1);
  });

  it('AC-3 重启模拟：换一个数据库连接后仍然判 duplicate（证明落了盘）', async () => {
    const one = [msg('dup-3', '跨进程', 3000)];
    const first = fakeStarter();
    await pollInboundOnce({ source: SOURCE, fetchMessages: async () => one, startRun: first.startRun });
    expect(first.started).toHaveLength(1);

    await resetStateDb(); // 丢掉进程内连接 = 模拟重启
    const second = fakeStarter();
    const res = await pollInboundOnce({ source: SOURCE, fetchMessages: async () => one, startRun: second.startRun });
    expect(second.started).toHaveLength(0);
    expect(res.skipped).toEqual([{ messageId: 'dup-3', reason: 'duplicate' }]);
  });
});

describe('窗口选择与空消息', () => {
  it('显式 sinceTs > 游标 > 默认回溯', async () => {
    const { startRun } = fakeStarter();
    const r1 = await pollInboundOnce({ source: SOURCE, sinceTs: 111, fetchMessages: async () => [], startRun });
    expect(r1.windowSource).toBe('explicit');
    expect(r1.sinceTs).toBe(111);

    await advanceCursor(SOURCE, 222);
    const r2 = await pollInboundOnce({ source: SOURCE, fetchMessages: async () => [], startRun });
    expect(r2.windowSource).toBe('cursor');
    expect(r2.sinceTs).toBe(222);

    await resetEventState(SOURCE);
    const r3 = await pollInboundOnce({ source: SOURCE, fetchMessages: async () => [], startRun });
    expect(r3.windowSource).toBe('default');
    expect(Math.abs(Date.now() / 1000 - 3600 - r3.sinceTs)).toBeLessThan(5);
  });

  it('空消息跳过且不认领，但游标照常前进（否则全空的一轮会把游标卡死）', async () => {
    const { started, startRun } = fakeStarter();
    const res = await pollInboundOnce({
      source: SOURCE,
      sinceTs: 500,
      fetchMessages: async () => [msg('e1', '   ', 700), msg('e2', '', 800)],
      startRun,
    });
    expect(started).toHaveLength(0);
    expect(res.skipped.map(s => s.reason)).toEqual(['empty', 'empty']);
    expect(await countSeenEvents(SOURCE)).toBe(0);
    expect(await getCursor(SOURCE)).toBe(800);
  });

  it('游标推进到本轮消息的最大 createTime', async () => {
    const { startRun } = fakeStarter();
    await pollInboundOnce({
      source: SOURCE,
      sinceTs: 100,
      fetchMessages: async () => [msg('a', 'x', 150), msg('b', 'y', 400), msg('c', 'z', 250)],
      startRun,
    });
    expect(await getCursor(SOURCE)).toBe(400);
  });

  it('拉消息失败 → success:false 且不起任何 run', async () => {
    const { started, startRun } = fakeStarter();
    const res = await pollInboundOnce({
      source: SOURCE,
      fetchMessages: async () => {
        throw new Error('飞书 500');
      },
      startRun,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/拉取消息失败[\s\S]*飞书 500/);
    expect(started).toHaveLength(0);
  });
});

describe('fail-closed：去重存储不可写时拒绝起 run', () => {
  it('库打不开 → 整轮失败、零 run（不降级为「去重坏了但继续跑」）', async () => {
    await resetStateDb();
    // 指向一个不存在的目录：SQLite 不会替我们创建父目录
    process.env.APP_DB_PATH = path.join(tmpDir, 'no-such-subdir', 'state.db');
    await resetStateDb();

    const { started, startRun } = fakeStarter();
    const res = await pollInboundOnce({
      source: SOURCE,
      fetchMessages: async () => [msg('m1', '任务', 100)],
      startRun,
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/fail-closed/);
    expect(started).toHaveLength(0);
    expect(res.triggered).toHaveLength(0);
  });
});
