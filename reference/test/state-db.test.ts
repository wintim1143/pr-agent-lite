/**
 * M6 补测：`state-db` 的连接级 PRAGMA（`busy_timeout`）与数值 env 解析。
 *
 * ## 这个文件补的是一个「症状与根因隔三层」的真实缺陷（2026-09-17 实测）
 *
 * 现象：M6 的并发回归里 `--dedup` / `--serial` 两模式判负，报的是
 * 「两个独立进程并发认领 → 成功 1 个 / 判 duplicate **0** 个」与
 * 「临界区严格串行 → **只看到 holder-X**」。**判负信息里一个字都没提数据库。**
 *
 * 根因：`@libsql/client` 的默认 `busy_timeout` 是 `0`（不等待），
 * 而 WAL **只解决读写互斥、不解决写写互斥** → 两个进程同时写同一个库文件时，
 * 后者**立刻**拿到 `SQLITE_BUSY`，无人捕获 → **子进程整个崩掉、一条记录都不写**。
 * 上层看到的是「第二个 run 的记录整段消失」，而不是「数据库报错」。
 *
 * 补充事实（决定了修法）：`@mastra/libsql` **自己早就设了**（`LibSQLStore` 5000ms /
 * LibSQL Workflows 10000ms，一手来源 `dist/index.js:410` 与 `dist/index.cjs:12991`），
 * 因为它们与本模块写同一个库文件 —— **全项目只有本模块漏设**，
 * 所以「Mastra 写 + 我们写」并发时只有我们会崩。
 *
 * ## 判据分层：这里**不**重复验「跨进程并发不崩」
 *
 * 跨进程并发是**真并发**，用 `Promise.all` 在同一进程里是**模拟不出来的**
 * （JS 单线程 + libsql 本地调用会阻塞，同一 tick 的两个 `execute` 并不会真的同时持锁）——
 * 若在这里写一个「并发写两次都成功」的用例，它在修复前也会**通过**，零信息量。
 * 那条判据由**真的起两个进程**的 `verify-m5-multirepo.js --dedup/--serial` 持有。
 *
 * 本文件只钉住两件**在这里可确定验证**的事：
 * 1. 连接上**真的**生效了预期的 `busy_timeout`（不是「代码里写了」而是「SQLite 认了」）；
 * 2. 数值 env 的边界解析（尤其**空字符串**不得静默变成 `0`）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  busyTimeoutMs,
  ensureStateSchema,
  getStateDb,
  isBusyError,
  parseEnvNumber,
  resetStateDb,
} from '../src/adapters/state-db';

let tmpDir: string;
let savedDbPath: string | undefined;
let savedTimeout: string | undefined;
let dbSeq = 0;

/**
 * 读回连接上**真正生效**的 `busy_timeout`。
 *
 * ⚠️ 返回列名是 SQLite 约定的 `timeout`，**不是** `busy_timeout`
 * （实测 `PRAGMA busy_timeout` → `{"timeout":5000}` / `columns:["timeout"]`）。
 * 写成 `busy_timeout` 会拿到 `NaN`，而 `expect(NaN).toBe(5000)` 的红会指向错误的排查方向。
 */
async function effectiveBusyTimeout(): Promise<number> {
  const rs = await getStateDb().execute('PRAGMA busy_timeout');
  return Number((rs.rows[0] as Record<string, unknown>).timeout);
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa6-statedb-'));
});

beforeEach(async () => {
  await resetStateDb();
  savedDbPath = process.env.APP_DB_PATH;
  savedTimeout = process.env.SQLITE_BUSY_TIMEOUT_MS;
  process.env.APP_DB_PATH = path.join(tmpDir, `state-${++dbSeq}.db`);
  delete process.env.SQLITE_BUSY_TIMEOUT_MS;
});

afterEach(() => {
  if (savedDbPath === undefined) delete process.env.APP_DB_PATH;
  else process.env.APP_DB_PATH = savedDbPath;
  if (savedTimeout === undefined) delete process.env.SQLITE_BUSY_TIMEOUT_MS;
  else process.env.SQLITE_BUSY_TIMEOUT_MS = savedTimeout;
});

afterAll(async () => {
  await resetStateDb();
  // 尽力而为：libsql 在 Windows 上 close() 后句柄不立即释放，rmSync 会 EBUSY
  // （与 entry-idempotency.test.ts / repo-lock.test.ts 同名注释）
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[test] 临时目录未能删除（libsql 句柄未释放，非测试失败）：${(e as Error).message}`);
  }
});

describe('parseEnvNumber：数值 env 的边界（空值不得静默变 0）', () => {
  it('未设置 / 空字符串 / 纯空白 → 回落默认', () => {
    expect(parseEnvNumber(undefined, 5000)).toBe(5000);
    // ⚠️ 这三条是本次缺陷同源的陷阱：`Number('') === 0`，
    // 若不特判，`.env` 里一行留空的 `SQLITE_BUSY_TIMEOUT_MS=` 就静默变成「不等待」
    expect(parseEnvNumber('', 5000)).toBe(5000);
    expect(parseEnvNumber('   ', 5000)).toBe(5000);
  });

  it('非数字 / 负数 → 回落默认', () => {
    expect(parseEnvNumber('abc', 5000)).toBe(5000);
    expect(parseEnvNumber('-1', 5000)).toBe(5000);
  });

  it('合法值被采纳，且 `0` 是合法值（显式写 0 与「空着」必须区分开）', () => {
    expect(parseEnvNumber('1500', 5000)).toBe(1500);
    expect(parseEnvNumber('0', 5000)).toBe(0);
  });
});

describe('busyTimeoutMs：取值与 @mastra/libsql 对齐', () => {
  it('默认 5000（与 LibSQLStore 同值 —— 同库的两个写入方谁都不该先放弃）', () => {
    expect(busyTimeoutMs()).toBe(5000);
  });

  it('env 可覆盖', () => {
    process.env.SQLITE_BUSY_TIMEOUT_MS = '1500';
    expect(busyTimeoutMs()).toBe(1500);
  });
});

describe('AC：PRAGMA 真的落到连接上（不是「代码里写了」）', () => {
  it('ensureStateSchema 之后，连接上生效的 busy_timeout = 5000', async () => {
    await ensureStateSchema();
    expect(await effectiveBusyTimeout()).toBe(5000);
  });

  it('env 覆盖后，新连接读到新值（resetStateDb 会一并丢弃 PRAGMA 缓存）', async () => {
    await ensureStateSchema();
    expect(await effectiveBusyTimeout()).toBe(5000);

    process.env.SQLITE_BUSY_TIMEOUT_MS = '1234';
    await resetStateDb(); // 关键：不清 pragmaPromise 的话，新 env 会被旧缓存吞掉
    await ensureStateSchema();

    expect(await effectiveBusyTimeout()).toBe(1234);
  });

  it('显式配 0 也在连接上如实生效（「配了 0」与「没配」是两回事）', async () => {
    process.env.SQLITE_BUSY_TIMEOUT_MS = '0';
    await ensureStateSchema();
    expect(await effectiveBusyTimeout()).toBe(0);
  });
});

describe('isBusyError：写竞争的判定（同一个错误码，两种正确处置）', () => {
  it('认 libsql 实际抛出的形态（code + message 两者都有）', () => {
    const e = Object.assign(new Error('SQLITE_BUSY: database is locked'), { code: 'SQLITE_BUSY' });
    expect(isBusyError(e)).toBe(true);
  });

  it('只给 message、不给 code 时也能认出（不同版本/code 路径可能只给一个）', () => {
    expect(isBusyError(new Error('SQLITE_BUSY: database is locked'))).toBe(true);
    expect(isBusyError(new Error('database table is locked'))).toBe(true);
    expect(isBusyError(new Error('table is locked'))).toBe(true);
  });

  it('认 SQLITE_LOCKED 家族', () => {
    expect(isBusyError(Object.assign(new Error('x'), { code: 'SQLITE_LOCKED' }))).toBe(true);
    expect(isBusyError(Object.assign(new Error('x'), { code: 'SQLITE_LOCKED_SHAREDCACHE' }))).toBe(true);
  });

  it('非竞争类错误必须**不**被吞掉（否则真故障会被当成「没抢到」而无声重试）', () => {
    expect(isBusyError(new Error('no such table: pr_agent_repo_locks'))).toBe(false);
    expect(isBusyError(Object.assign(new Error('constraint failed'), { code: 'SQLITE_CONSTRAINT' }))).toBe(false);
    expect(isBusyError(null)).toBe(false);
    expect(isBusyError(undefined)).toBe(false);
    expect(isBusyError('some string')).toBe(false);
  });
});
