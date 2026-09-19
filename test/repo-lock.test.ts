/**
 * M5b-4 单测：每仓库串行锁（跨进程可见）。
 *
 * 覆盖 AC-8（同仓库并发串行）。
 *
 * ## 这组测试里最重要的是那条「无锁对照组」
 *
 * 只断言「加了锁之后不交叠」是**没有说服力的** —— 如果那两个临界区本来就错不开，
 * 断言在任何实现下都会通过。所以本文件同时跑一遍**不加锁**的同构场景，
 * 断言它**确实会交叠**。两组放在一起，「锁真的在起作用」才是被证明的，
 * 而不是被假设的。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  acquireRepoLock,
  releaseRepoLock,
  peekRepoLock,
  listRepoLocks,
  releaseAllRepoLocks,
} from '../src/adapters/repo-lock';
import { resetStateDb } from '../src/adapters/state-db';

const KEY = 'example-org/sample-target';
const OTHER = 'local/repo-b';

let tmpDir: string;
let savedDbPath: string | undefined;
let dbSeq = 0;

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

/** 每个用例一个独立库文件（理由见 entry-idempotency.test.ts 的同名注释）。 */
beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa5-lock-'));
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
  // ⚠️ 清理是**尽力而为**：本机实测 `client.close()` 之后返回 `closed:true`，
  // 但 Windows 上文件句柄不是立刻释放，`rmSync` 会抛 EBUSY（连 maxRetries 都压不住）。
  // 这是 libsql 原生绑定 + Windows 的行为，不是本项目代码的问题；
  // 为了不让「清理失败」把测试染红，这里吞掉异常（临时目录交给系统清理）。
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[test] 临时目录未能删除（libsql 句柄未释放，非测试失败）：${(e as Error).message}`);
  }
});

describe('基本获取与释放', () => {
  it('空位直接拿到，无需等待', async () => {
    const res = await acquireRepoLock(KEY, 'run-1');
    expect(res.acquired).toBe(true);
    // 不写 toBe(0)：一次 DB 往返本身要几毫秒。关键是「没有因等待而消耗时间预算」，
    // 所以判据是「远小于任何有意义的等待」，而不是「恰好为 0」。
    expect(res.waitedMs).toBeLessThan(50);
    expect(res.holder).toMatchObject({ repoKey: KEY, holder: 'run-1' });
    // holder 必须能被只读观察到（串行保证的可见证据）
    expect(await peekRepoLock(KEY)).toMatchObject({ holder: 'run-1' });
  });

  it('释放后别人才拿得到', async () => {
    await acquireRepoLock(KEY, 'run-1');
    expect(await releaseRepoLock(KEY, 'run-1')).toBe(true);
    expect(await peekRepoLock(KEY)).toBeNull();
    expect((await acquireRepoLock(KEY, 'run-2')).acquired).toBe(true);
  });

  it('holder 不匹配时拒绝释放（防止崩溃后误删别人的锁）', async () => {
    await acquireRepoLock(KEY, 'run-1');
    expect(await releaseRepoLock(KEY, 'run-2')).toBe(false);
    // 锁必须还在，且持有者没有被改掉
    expect(await peekRepoLock(KEY)).toMatchObject({ holder: 'run-1' });
  });

  it('同一 holder 可重入（自己不该等自己），且只续期不阻塞', async () => {
    await acquireRepoLock(KEY, 'run-1', { ttlMs: 1000 });
    const before = (await peekRepoLock(KEY))!.expiresAt;
    await sleep(5);
    const res = await acquireRepoLock(KEY, 'run-1', { ttlMs: 60_000 });
    expect(res.acquired).toBe(true);
    expect(res.waitedMs).toBe(0);
    expect((await peekRepoLock(KEY))!.expiresAt).toBeGreaterThan(before);
  });
});

describe('等待上限与超时', () => {
  it('锁被人占着且 waitMs=0 → 立刻超时，并报出占用者', async () => {
    await acquireRepoLock(KEY, 'holder-A');
    const res = await acquireRepoLock(KEY, 'holder-B', { waitMs: 0 });
    expect(res.acquired).toBe(false);
    expect(res.error).toBe('lock-timeout');
    expect(res.holder).toMatchObject({ holder: 'holder-A' });
  });

  it('短暂占用 → 等到，且 waitedMs 反映真实等待（可作串行证据）', async () => {
    await acquireRepoLock(KEY, 'holder-A');
    setTimeout(() => void releaseRepoLock(KEY, 'holder-A'), 40);
    const res = await acquireRepoLock(KEY, 'holder-B', { waitMs: 3000, pollMs: 5 });
    expect(res.acquired).toBe(true);
    expect(res.waitedMs).toBeGreaterThanOrEqual(30);
  });
});

describe('TTL：崩溃后锁不会永久泄漏', () => {
  it('超过 TTL 的锁可被抢占', async () => {
    await acquireRepoLock(KEY, 'crashed-run', { ttlMs: 20 });
    await sleep(40);
    const res = await acquireRepoLock(KEY, 'next-run', { waitMs: 1000, pollMs: 5 });
    expect(res.acquired).toBe(true);
    expect((await peekRepoLock(KEY))!.holder).toBe('next-run');
  });

  it('未过期时不可抢占（否则 TTL 就成了摆设）', async () => {
    await acquireRepoLock(KEY, 'alive-run', { ttlMs: 60_000 });
    const res = await acquireRepoLock(KEY, 'next-run', { waitMs: 0 });
    expect(res.acquired).toBe(false);
    expect((await peekRepoLock(KEY))!.holder).toBe('alive-run');
  });
});

describe('不同仓库互不阻塞', () => {
  it('两个 repoKey 各有各的锁', async () => {
    expect((await acquireRepoLock(KEY, 'run-1', { waitMs: 0 })).acquired).toBe(true);
    expect((await acquireRepoLock(OTHER, 'run-2', { waitMs: 0 })).acquired).toBe(true);
    expect((await listRepoLocks()).map(l => l.repoKey).sort()).toEqual([KEY, OTHER].sort());
    expect(await releaseAllRepoLocks()).toBe(2);
    expect(await listRepoLocks()).toEqual([]);
  });
});

describe('AC-8：同仓库并发必须串行（含无锁对照组）', () => {
  /**
   * 跑两个临界区，把 enter/exit 时序记进数组。
   * @param locked 是否使用仓库锁。false = 无锁对照组。
   */
  async function runPair(locked: boolean, holdMsA: number, holdMsB: number): Promise<string[]> {
    const events: string[] = [];
    const criticalSection = async (holder: string, label: string, holdMs: number): Promise<void> => {
      if (locked) {
        const res = await acquireRepoLock(KEY, holder, { waitMs: 10_000, pollMs: 5, ttlMs: 60_000 });
        if (!res.acquired) {
          events.push(`${label}:timeout`);
          return;
        }
      }
      events.push(`${label}:enter`);
      await sleep(holdMs);
      events.push(`${label}:exit`);
      if (locked) await releaseRepoLock(KEY, holder);
    };
    await Promise.all([criticalSection('h-A', 'A', holdMsA), criticalSection('h-B', 'B', holdMsB)]);
    return events;
  }

  it('对照组（不加锁）确实会交叠 —— 证明下面那条断言不是空转', async () => {
    const events = await runPair(false, 60, 10);
    // 关键性质不是「谁先退出」，而是**第二个 enter 发生在第一个 exit 之前**：
    // 那一刻两个 run 同时处在「已切到自己的分支、还没提交」的窗口里，
    // 后提交的那个会把改动落到前一个的分支上（静默的数据损坏）。
    expect(events).toHaveLength(4);
    expect(events[0]).toMatch(/:enter$/);
    expect(events[1]).toMatch(/:enter$/); // ← 交叠的证据
    expect(events[0][0]).not.toBe(events[1][0]);
  });

  it('加锁后两个临界区严格串行，enter/exit 成对相邻且不交叠', async () => {
    const events = await runPair(true, 60, 10);
    expect(events).toHaveLength(4);
    // 第一对相邻
    expect(events[0]).toMatch(/:enter$/);
    expect(events[1]).toBe(events[0].replace(':enter', ':exit'));
    // 第二对相邻
    expect(events[2]).toMatch(/:enter$/);
    expect(events[3]).toBe(events[2].replace(':enter', ':exit'));
    // 两个临界区属于不同持有者（否则"串行"是自说自话）
    expect(events[0][0]).not.toBe(events[2][0]);
    // 没有任何一次超时
    expect(events.join(',')).not.toContain('timeout');
  });

  it('串行不引入死锁：三路并发依次完成', async () => {
    const order: string[] = [];
    await Promise.all(
      ['h1', 'h2', 'h3'].map(async (h, i) => {
        const res = await acquireRepoLock(KEY, h, { waitMs: 10_000, pollMs: 5, ttlMs: 60_000 });
        expect(res.acquired).toBe(true);
        order.push(h);
        await sleep(5 + i);
        await releaseRepoLock(KEY, h);
      })
    );
    expect(order.sort()).toEqual(['h1', 'h2', 'h3']);
    expect(await peekRepoLock(KEY)).toBeNull();
  });
});

describe('锁参数可由 env 覆盖（验证脚本用秒级超时快速判负）', () => {
  it('REPO_LOCK_WAIT_MS 生效', async () => {
    await acquireRepoLock(KEY, 'holder-A', { ttlMs: 60_000 });
    process.env.REPO_LOCK_WAIT_MS = '0';
    try {
      const res = await acquireRepoLock(KEY, 'holder-B');
      expect(res.acquired).toBe(false);
    } finally {
      delete process.env.REPO_LOCK_WAIT_MS;
    }
  });
});
