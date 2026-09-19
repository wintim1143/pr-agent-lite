/**
 * 入口层幂等的**原子认领**单测。
 *
 * ## 本文件为什么比参考实现短
 *
 * 参考实现里这里还有「轮询状态机」那一半：游标只前进不后退、按 messageId 的三次投递、
 * 窗口选择、`pollInboundOnce` 的编排。**轮询入口不在本项目** —— 触发源（IM 出入站、
 * 长连接、定时拉取）全部归外侧网关，本项目只暴露「认领一个事件」这个原语。
 *
 * 于是保留的判据收敛为两条，都是在**本项目真正拥有的边界**上：
 * - AC-2 原子认领：同一幂等键并发认领，恰好只有一路成功
 * - fail-closed：去重存储不可写时认领必须抛错，绝不静默放行
 *
 * ## 为什么「原子性」不能靠「跑两次看看」来验
 *
 * 顺序执行两次必然一次成功一次失败 —— 那证明的是**幂等**，不是**原子**。
 * 原子性要守的是「两个并发认领同时判断 key 不存在，然后都去起 run」这个窗口。
 * 所以下面用 `Promise.all` 让多路认领**在同一个 tick 内并发发起**。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  claimEvent,
  attachRunId,
  listSeenEvents,
  countSeenEvents,
} from '../src/adapters/dedup-store';
import { resetStateDb } from '../src/adapters/state-db';

const SOURCE = 'feishu:test-chat';

let tmpDir: string;
let savedDbPath: string | undefined;
let dbSeq = 0;

/**
 * 每个用例用一个**全新的库文件**，且用例之间**不删除**它。
 *
 * 为什么不复用同一个文件再清空：部分平台上 libsql 释放文件句柄不是瞬时的，
 * `rmSync` 会间歇性抛 EBUSY，把「断言失败」和「清理失败」混成同一类红。
 * 每个用例独立文件后，用例之间的隔离由文件名保证，清理只需在 afterAll 做一次尽力而为。
 */
beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pral-dedup-'));
});

beforeEach(async () => {
  await resetStateDb();
  savedDbPath = process.env.PRAL_DB_PATH;
  process.env.PRAL_DB_PATH = path.join(tmpDir, `state-${++dbSeq}.db`);
});

afterAll(async () => {
  await resetStateDb();
  if (savedDbPath === undefined) delete process.env.PRAL_DB_PATH;
  else process.env.PRAL_DB_PATH = savedDbPath;
  // 尽力而为：libsql 句柄可能未立即释放，rmSync 会报 EBUSY（见 repo-lock.test.ts 同名注释）
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[test] 临时目录未能删除（libsql 句柄未释放，非测试失败）：${(e as Error).message}`);
  }
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

/**
 * fail-closed：**去重坏了就拒绝起 run**，不降级为「去重失效但继续跑」。
 *
 * ## 判据为什么落在「认领是否抛错」上
 *
 * 参考实现的这一条是断言 `pollInboundOnce` 返回 `success:false` 且零 run ——
 * 因为那个函数同时承担了「认领」与「起 run」两件事。
 * 本项目里「起 run」的调用方在**外侧网关**（轮询入口归它），
 * 所以本项目能保证的、也是唯一该被钉住的一环是：
 *
 * > 库不可写时 `claimEvent` **抛错**，绝不返回 `claimed: true`。
 *
 * 只要它抛错，调用方就没有「已认领」可依据 —— 起 run 这件事在结构上无法发生。
 * 若这里退化成静默返回 `true`，去重就静默失效了，而**失败不报错**正是本用例要防的形态。
 */
describe('fail-closed：去重存储不可写时不得被判为已认领', () => {
  it('库打不开 → 认领抛错（而非静默判为 new）', async () => {
    await resetStateDb();
    // 指向一个不存在的目录：SQLite 不会替我们创建父目录
    process.env.PRAL_DB_PATH = path.join(tmpDir, 'no-such-subdir', 'state.db');
    await resetStateDb();

    await expect(claimEvent('m1', SOURCE)).rejects.toThrow();
  });
});
