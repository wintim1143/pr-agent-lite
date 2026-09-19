/**
 * 入口态存储的数据库连接与建表（M5a-1）。
 *
 * ## 为什么只用一个库文件，而不是按用途各开一个
 *
 * 去重状态（「这个事件被认领过了吗」）与仓库互斥锁（`repo-lock`）**生命周期不同**，
 * 但都服务于同一批 run。为了让运维只需照看一个文件、备份即完整状态，
 * 二者**共用同一个库文件**（各占各的表，互不干扰）。
 *
 * ## 为什么必须是 SQLite 而不是 JSON 文件 / 内存 Map（这一段是本模块存在的唯一理由）
 *
 * 去重需要**原子性**：两个并发 poll 不能都认领同一条消息。
 * SQLite 的 `INSERT OR IGNORE` + 唯一主键提供了**免费且正确**的原子认领原语
 * —— 插入即认领，冲突即「别人已抢先」，由数据库保证二者不会同时发生。
 * JSON 文件与内存 Map 都**没有跨进程原子性**，做同样的事要自己发明锁文件 + 重试，
 * 且在高并发下会出现「双跑」窗口（正是 M5a 要防的那件事）。
 *
 * ## 两条必须遵守的约束
 *
 * 1. ⚠️ **库文件路径只有 `stateDbPath()` 一个真相源**：同一个 `PRAL_DB_PATH`、
 *    同一套 `resolve(process.cwd(), 'pr-agent-lite.db')` 解析规则。
 *    任何地方另写一份解析都会造成「A 写这个库、B 写那个库」的静默分裂 —— 两边都对，却互相看不见。
 * 2. ⚠️ **自有表统一加 `pr_agent_` 前缀**：开销为零的命名约定，
 *    将来若并入其它组件或换存储驱动，也不会与外来表撞名。
 */
import { resolve } from 'node:path';
import { createClient, type Client } from '@libsql/client';

/** 库文件路径的唯一真相源：同一个 env + 同一套解析规则。 */
export function stateDbPath(): string {
  return process.env.PRAL_DB_PATH ?? resolve(process.cwd(), 'pr-agent-lite.db');
}

/** `file:` URL 形式的库地址（libsql 客户端要求的写法）。 */
export function stateDbUrl(): string {
  return `file:${stateDbPath()}`;
}

/**
 * 解析数值型 env，非法值回落默认。**导出供 `repo-lock.ts` 等处复用**。
 *
 * ## 为什么必须共享同一个实现（而不是各处抄一份）
 *
 * 本次缺陷（`busy_timeout` 漏设）的根因就是**同一个语义在不同地方处理不一致**
 * —— 别的连接设了，这一处没设，于是只有这一处会崩。
 * 数值型 env 的解析同理：一旦各处抄各自的版本，就会出现「A 处修了、B 处没修」。
 * **共享实现的成本是一行 import，收益是这类不一致在结构上不可能发生。**
 *
 * ⚠️ **空字符串必须视作「未设置」**：`Number('') === 0`，若不特判，
 * `.env` 里写一行留空的 `SQLITE_BUSY_TIMEOUT_MS=`（很常见的「先占位」写法）
 * 会**静默降级为 `0`** —— 而 `0` 正是本函数要修的那个「不等待、立刻 BUSY」的原始缺陷。
 * 这类「以为配了、其实配成了最坏值」的失败必须挡在解析层。
 */
export function parseEnvNumber(v: string | undefined, dflt: number): number {
  if (v === undefined || v.trim() === '') return dflt;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/**
 * SQLite 写竞争的等待上限（毫秒）。默认 **5000**，可由 `SQLITE_BUSY_TIMEOUT_MS` 覆盖。
 *
 * ## 为什么必须显式设置（2026-09-17 补上的一个真实缺陷）
 *
 * `@libsql/client` 的**默认 `busy_timeout` 是 `0`** —— 语义是「**不等待，立刻失败**」。
 * 而 WAL 模式（本项目 `journal_mode` 实测为 `wal`）只解决「读写互不阻塞」，
 * **不解决「写写互斥」**：两个连接同时写同一库文件时，后者**立即**拿到 `SQLITE_BUSY`。
 *
 * 实测后果（M6 验收的并发回归暴露，`--dedup` / `--serial` 两模式判负）：
 * `repo-lock.ts` 的 `INSERT OR IGNORE` 在并发认领时抛
 * `LibsqlError: SQLITE_BUSY: database is locked`，**无人捕获 → 子进程直接崩掉**，
 * 一条记录都不写。于是上层看到的**不是**「数据库报错」，而是
 * 「**第二个 run 的记录整段消失**」—— 症状与根因隔了三层，极难定位。
 *
 * ## 取值为什么是 5000
 *
 * ⚠️ 5000 不是随手拍的数字：本项目的**互斥锁与去重共用这同一个库文件**
 * （见 `repo-lock.ts`、`dedup-store.ts`），而它们存在的意义就是**跨进程**互斥 ——
 * 也就是说「多个进程同时写同一个库」是**设计内的常态，不是异常**。
 *
 * 因此这个值必须与「临界区的最长正常耗时」相称：太短会让正常的并发立刻失败，
 * 太长会把真正的死锁掩盖成慢。5000 是沿用下来的取值，跨进程认领场景下实测够用。
 *
 * 这个缺陷一直潜伏到很晚才炸，是因为它**只在互斥锁真正起作用时才出现** ——
 * 单进程 / 串行跑时，谁都不会触发写写互斥。
 *
 * ## 两条实现约束
 *
 * 1. ⚠️ `busy_timeout` 是**连接级**参数（**不是**数据库级、不会持久化进库文件），
 *    因此必须在**每一个连接**上设置 —— 这正是它放在本模块（连接的唯一创建点）的原因。
 * 2. ⚠️ **无法通过 URL 传参设置**：`file:x.db?busy_timeout=5000` 会被 `@libsql/core` 直接拒绝
 *    （实测 `LibsqlError: URL_PARAM_NOT_SUPPORTED: Unsupported URL query parameter "busy_timeout"`），
 *    只能显式执行 `PRAGMA`。
 */
export function busyTimeoutMs(): number {
  return parseEnvNumber(process.env.SQLITE_BUSY_TIMEOUT_MS, 5_000);
}

/**
 * 判断一个错误是否为 SQLite 的**写竞争**错误（`SQLITE_BUSY` / `SQLITE_LOCKED` 家族）。
 *
 * ## 为什么需要把这个判断单独抽出来
 *
 * `SQLITE_BUSY` **不是故障，是竞争** —— 语义是「**此刻**写锁被别人拿着」。
 * 因此在**轮询语义**的调用点（如 `acquireRepoLock` 的等待循环）里，它等价于
 * 「这一轮没抢到」，**应当继续等待**；而在**一次性写**的调用点（如 `claimEvent`）
 * 里，它才是真的失败。**同一个错误码，两种正确处置** —— 所以判定必须可复用、可显式。
 *
 * ## 为什么同时看 `code` 与 message 文本
 *
 * 与 libsql 上游同款策略（同时看错误码与 message 文本）：
 * 不同 libsql 版本/code 路径下可能只给出其中一个 —— 只认 `code` 会在某些版本下**漏判**
 * （实测抛出的形态是 `LibsqlError: SQLITE_BUSY: database is locked`，
 * `code` 与 message 两者都有，但不应假设总是如此）。
 */
export function isBusyError(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown } | null | undefined;
  const code = typeof err?.code === 'string' ? err.code : '';
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || code === 'SQLITE_LOCKED_SHAREDCACHE') {
    return true;
  }
  const msg = typeof err?.message === 'string' ? err.message.toLowerCase() : '';
  return (
    msg.includes('database is locked') ||
    msg.includes('database table is locked') ||
    msg.includes('table is locked')
  );
}

let cachedClient: Client | undefined;
let schemaPromise: Promise<void> | undefined;
let pragmaPromise: Promise<void> | undefined;

/** 取（惰性创建的）单例连接。模块加载时**不做任何 IO**，沿用本项目「加载不抛错」的约定。 */
export function getStateDb(): Client {
  if (!cachedClient) {
    cachedClient = createClient({ url: stateDbUrl() });
  }
  return cachedClient;
}

/**
 * 设置连接级 PRAGMA（幂等，每个连接一次）。当前只有 `busy_timeout`（理由见 `busyTimeoutMs`）。
 *
 * ⚠️ **必须早于任何业务 SQL**：`getStateDb()` 是**同步**的，而 `PRAGMA` 只能**异步**执行，
 * 因此存在「连接已建、PRAGMA 未生效」的窗口。所有公开 API 都以 `ensureStateSchema()`
 * 为前置动作（它内部先 `await` 本函数），所以这个窗口在调用方视角下不存在。
 * **不要直接调用 `getStateDb()` 绕过 `ensureStateSchema()` 做写操作。**
 */
function ensurePragmas(): Promise<void> {
  if (!pragmaPromise) {
    pragmaPromise = (async () => {
      await getStateDb().execute(`PRAGMA busy_timeout = ${busyTimeoutMs()}`);
    })();
    // 失败时清空，让下一次调用重试 —— 否则一次偶发失败会被永久缓存成「没设过」。
    pragmaPromise.catch(() => {
      pragmaPromise = undefined;
    });
  }
  return pragmaPromise;
}

/**
 * 建表（幂等）。所有公开 API 的前置动作。
 *
 * 三张表的职责：
 * - `pr_agent_seen_events`：入口层幂等键账本。**主键即认领原语**。
 * - `pr_agent_cursors`：轮询游标。重启进程后 `sinceTs` 从游标续读，不重放。
 * - `pr_agent_repo_locks`：每仓库互斥锁（M5b-4）。跨进程可见 —— 验证脚本与 HTTP 是不同进程。
 */
export function ensureStateSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const db = getStateDb();
      // ⚠️ 顺序不可换：PRAGMA（连接级）必须先于建表本身 —— 建表也是写操作，
      // 若在未设 busy_timeout 时并发建表，同样会拿到 SQLITE_BUSY。
      await ensurePragmas();
      await db.execute(
        `CREATE TABLE IF NOT EXISTS pr_agent_seen_events (
           key       TEXT PRIMARY KEY,
           source    TEXT NOT NULL,
           seen_at   TEXT NOT NULL,
           run_id    TEXT
         )`
      );
      await db.execute(
        `CREATE TABLE IF NOT EXISTS pr_agent_cursors (
           source     TEXT PRIMARY KEY,
           cursor     INTEGER NOT NULL,
           updated_at TEXT NOT NULL
         )`
      );
      await db.execute(
        `CREATE TABLE IF NOT EXISTS pr_agent_repo_locks (
           repo_key    TEXT PRIMARY KEY,
           holder      TEXT NOT NULL,
           acquired_at INTEGER NOT NULL,
           expires_at  INTEGER NOT NULL
         )`
      );
    })();
  }
  return schemaPromise;
}

/**
 * 丢弃缓存的连接与建表 Promise，使下一次调用按**当前** env 重新解析库路径。
 *
 * 仅供单测 / 验证脚本在进程内切换库文件使用（生产代码不应调用 —— 切换运行中的库
 * 会让已写入的游标与去重记录「消失」）。
 */
export async function resetStateDb(): Promise<void> {
  const c = cachedClient;
  cachedClient = undefined;
  schemaPromise = undefined;
  pragmaPromise = undefined;
  if (c) {
    try {
      c.close();
    } catch {
      /* 关闭失败不影响后续新建连接；此处不抛，避免清理动作本身变成故障源 */
    }
  }
}
