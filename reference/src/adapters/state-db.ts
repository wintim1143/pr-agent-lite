/**
 * 入口态存储的数据库连接与建表（M5a-1）。
 *
 * ## 为什么复用 `mastra.db` 库文件，而不是新建 `state.db`（M5 卡 §0 拍板项 1 的定案）
 *
 * 去重状态（「这个事件被认领过了吗」）与 workflow 运行态（快照 / suspend / resume）**生命周期不同**，
 * 因此**不复用 Mastra Storage 的表**；但为了让运维只需照看一个文件、备份即完整状态，
 * 二者**共用同一个库文件**。
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
 * 1. ⚠️ **库文件路径与 `src/index.ts` 同源**：同一个 `APP_DB_PATH`、
 *    同一套 `resolve(process.cwd(), 'mastra.db')` 解析规则。任何一边单独改动都会造成
 *    「Mastra 写 A 库、去重写 B 库」的静默分裂 —— 两边的 run 都对，却互相看不见。
 * 2. ⚠️ **自有表统一加 `pr_agent_` 前缀**，避免与 LibSQLStore 的内部表（`mastra_*`）撞名。
 */
import { resolve } from 'node:path';
import { createClient, type Client } from '@libsql/client';

/** 与 `src/index.ts` 的 `mastraDbPath` 逐字同源（同一个 env + 同一套解析）。 */
export function stateDbPath(): string {
  return process.env.APP_DB_PATH ?? resolve(process.cwd(), 'mastra.db');
}

/** `file:` URL 形式的库地址（与 LibSQLStore 的写法一致）。 */
export function stateDbUrl(): string {
  return `file:${stateDbPath()}`;
}

/**
 * 解析数值型 env，非法值回落默认。**导出供 `repo-lock.ts` 等处复用**。
 *
 * ## 为什么必须共享同一个实现（而不是各处抄一份）
 *
 * 本次缺陷（`busy_timeout` 漏设）的根因就是**同一个语义在不同地方处理不一致**
 * —— `@mastra/libsql` 的两处连接设了，我们这处没设，于是只有我们会崩。
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
 * ## 取值为什么是 5000（对齐 `@mastra/libsql`，而不是随便拍的）
 *
 * ⚠️ **`@mastra/libsql` 自己早就给它的连接设了 `busy_timeout`**（一手来源，
 * `node_modules/@mastra/libsql/dist/index.js:410` → `LibSQLStore` = `5000`；
 * 同文件 `12991` 行 → LibSQL Workflows = `10000`）。**因为二者与本模块写同一个库文件。**
 *
 * 本项目原先**只有本模块漏设** → 于是「Mastra 写 + 我们写」并发时**只有我们会崩**，
 * 这就是它一直潜伏到 M6 才炸的原因。
 *
 * 取 5000 与 `LibSQLStore` 一致：**它们是同一个库的两个主要写入方，谁都不该比对方先放弃。**
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
 * 与 `@mastra/libsql` 的 `isBusyError` 同款策略（一手来源 `dist/index.cjs:1047`）：
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
