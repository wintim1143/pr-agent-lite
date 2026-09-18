/**
 * 每仓库互斥锁（M5b-4）。
 *
 * ## 为什么必须存在这把锁（M5 卡 §3 显式声明的风险）
 *
 * `git checkout` 改变的是**整个工作树**的分支，是**仓库级全局状态**。
 * 同一个本地 clone 上有两个 run 并发执行时：
 *
 * ```
 * run-A: git checkout feat/1-*      ← 切到 A 的分支
 * run-B: git checkout feat/2-*      ← 把工作树切走了
 * run-A: git add -A && git commit   ← ⚠️ 提交落到了 B 的分支上
 * ```
 *
 * 这是**静默的数据损坏**，不是报错 —— 没有任何一步会失败，事后只能靠翻 ref 才发现。
 * M4 的 `--path-a/b/c` 是**串行**跑的，所以从未暴露这个问题；多仓库后并发是常态。
 *
 * M5 的处置是**每仓库串行**（同一 `repoKey` 同时只允许一个 run 走 checkout→commit→push 段），
 * 不同仓库互不阻塞。`git worktree` 级隔离（每 run 一个工作树）能力更强但成本高得多，
 * **明确留给后续里程碑**（M5 卡 §3 不做项）。
 *
 * ## 为什么锁要放在数据库里而不是进程内变量
 *
 * 验证脚本与 HTTP 服务、以及「两个并发 run」都是**不同进程**。
 * 进程内变量（`Map` / `Set`）跨进程完全无效，会给出「看起来串行了」的假安全感。
 * 放在 `mastra.db` 里则所有参与者共享同一个真相源。
 *
 * ## TTL 与「泄漏」这条已知取舍
 *
 * 锁带 `expires_at`，超过 TTL 可被后来者抢占。这是为了**防止 run 中途崩溃后锁永久泄漏**
 * （把整条流水线卡死）。代价是：若某个 run 的运行时长超过 TTL，锁会在它还在跑时被抢走。
 * 因此默认 TTL（30 分钟）必须显著大于编码步的超时预算（`CODING_TIMEOUT_MS` 默认 10 分钟）。
 *
 * ## 为什么释放要校验 holder
 *
 * 「A 崩溃后 TTL 过期、B 抢到锁、此时 A 的收尾代码执行到释放」——若无脑按 `repo_key` 删除，
 * A 会**误删 B 的锁**，串行保证当场失效。故释放语句必须带 `AND holder = ?`。
 */
import { ensureStateSchema, getStateDb, isBusyError, parseEnvNumber } from './state-db.js';

export interface LockInfo {
  repoKey: string;
  holder: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface AcquireResult {
  acquired: boolean;
  waitedMs: number;
  /** 未获得时给出可执行的判定理由（目前只有 `lock-timeout`），供上层显式失败。 */
  error?: 'lock-timeout';
  /** 当前锁的持有点（获得时为自己；未获得且因超时退出时为**占用者**，便于排障）。 */
  holder: LockInfo | null;
}

export interface LockConfig {
  waitMs: number;
  ttlMs: number;
  pollMs: number;
}

/**
 * 锁参数（可由 env 覆盖，便于验证脚本用秒级超时快速判负）。
 * - `REPO_LOCK_WAIT_MS` 默认 600000（10 分钟）：等待上限
 * - `REPO_LOCK_TTL_MS`  默认 1800000（30 分钟）：必须 > 编码步超时预算
 * - `REPO_LOCK_POLL_MS` 默认 1000
 *
 * ⚠️ 解析走 `state-db.ts` 的 `parseEnvNumber`（**共享实现，不要在本文件另抄一份**）：
 * 该函数把「空字符串」当未设置 —— 否则 `.env` 里留空的 `REPO_LOCK_WAIT_MS=`
 * 会因 `Number('') === 0` 静默变成「等待上限 0ms」，即**锁永远抢不到、每次都判 lock-timeout**。
 */
export function repoLockConfig(): LockConfig {
  return {
    waitMs: parseEnvNumber(process.env.REPO_LOCK_WAIT_MS, 600_000),
    ttlMs: parseEnvNumber(process.env.REPO_LOCK_TTL_MS, 1_800_000),
    pollMs: parseEnvNumber(process.env.REPO_LOCK_POLL_MS, 1_000),
  };
}

function toLockInfo(repoKey: string, row: Record<string, unknown>): LockInfo {
  return {
    repoKey,
    holder: String(row.holder),
    acquiredAt: Number(row.acquired_at),
    expiresAt: Number(row.expires_at),
  };
}

async function readLock(repoKey: string): Promise<LockInfo | null> {
  const rs = await getStateDb().execute({
    sql: `SELECT repo_key, holder, acquired_at, expires_at FROM pr_agent_repo_locks WHERE repo_key = ?`,
    args: [repoKey],
  });
  const row = rs.rows[0];
  return row ? toLockInfo(repoKey, row as unknown as Record<string, unknown>) : null;
}

/** 只读观察锁状态（不获取）。排障与验证脚本用。 */
export async function peekRepoLock(repoKey: string): Promise<LockInfo | null> {
  await ensureStateSchema();
  return readLock(repoKey);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * 获取某仓库的互斥锁；同一 holder **可重入**（重复获取只是续期，不阻塞自己）。
 *
 * @param repoKey 逻辑仓库标识（`owner/repo`）
 * @param holder  持有者标识。编排层用 **runId**：它天然唯一、且与日志/快照可交叉引用
 * @returns `acquired:false` 只在**等待超上限**时出现，且附带 `error:'lock-timeout'`。
 *          ⚠️ 调用方必须把 `acquired:false` 当**显式失败**处理（M5 卡 §10：不得降级为「没锁也继续」）
 */
export async function acquireRepoLock(
  repoKey: string,
  holder: string,
  overrides?: Partial<LockConfig>
): Promise<AcquireResult> {
  const cfg = { ...repoLockConfig(), ...overrides };
  const db = getStateDb();
  // ⚠️ 建表必须在**计时之前**：`ensureStateSchema` 首次要跑三次 CREATE TABLE（本机实测 ~26ms），
  // 若把它算进 `waitedMs`，「没有等待」这件事就会被报成一个几十毫秒的假等待，
  // 而 `waitedMs > 0` 恰恰是串行保证的判据之一 —— 假等待会让那条判据失效。
  await ensureStateSchema();
  const started = Date.now();
  const deadline = started + cfg.waitMs;

  for (;;) {
    const now = Date.now();

    // ⚠️ 整个循环体被「写竞争兜底」包住，理由见下方 `catch`。
    // 关键点：本函数是**轮询语义** —— `SQLITE_BUSY` 在这里等价于「这一轮没抢到」，不是故障。
    try {
      // 1) 空位 → 直接认领（唯一主键保证并发下只有一个人拿到）
      const ins = await db.execute({
        sql: `INSERT OR IGNORE INTO pr_agent_repo_locks (repo_key, holder, acquired_at, expires_at) VALUES (?, ?, ?, ?)`,
        args: [repoKey, holder, now, now + cfg.ttlMs],
      });
      if (ins.rowsAffected === 1) {
        return { acquired: true, waitedMs: now - started, holder: await readLock(repoKey) };
      }

      // 2) 已有人持有 → 区分三种情况
      const cur = await readLock(repoKey);
      if (cur) {
        if (cur.holder === holder) {
          // 2a) 自己已经持有 → 续期后直接返回（可重入，避免自己等自己）
          await db.execute({
            sql: `UPDATE pr_agent_repo_locks SET expires_at = ? WHERE repo_key = ? AND holder = ?`,
            args: [now + cfg.ttlMs, repoKey, holder],
          });
          return { acquired: true, waitedMs: now - started, holder: await readLock(repoKey) };
        }
        if (cur.expiresAt <= now) {
          // 2b) 持有者已超 TTL（多半崩了）→ 抢占
          const steal = await db.execute({
            sql: `UPDATE pr_agent_repo_locks SET holder = ?, acquired_at = ?, expires_at = ? WHERE repo_key = ? AND expires_at <= ?`,
            args: [holder, now, now + cfg.ttlMs, repoKey, now],
          });
          if (steal.rowsAffected === 1) {
            return { acquired: true, waitedMs: now - started, holder: await readLock(repoKey) };
          }
          // 抢占失败 = 别人同时抢到了 → 落到下面继续等
        }
      }
    } catch (e) {
      // ⚠️ **写竞争不等于失败**：`SQLITE_BUSY` 的语义是「此刻写锁被别人拿着」，
      // 而本函数本来就是轮询等待 —— 于是它应当与「2) 已有人持有」走**同一条出路**：继续等。
      //
      // 【为什么这层兜底不可省 —— 2026-09-17 实测】
      // `PRAGMA busy_timeout`（见 `state-db.ts`）只覆盖「写锁能在超时窗口内释放」的情形。
      // 一旦有别的连接持有**长写事务**，`SQLITE_BUSY` 仍会抛出。
      // 而**抛出 = 崩溃**：这是一个裸的 `LibsqlError`，`repo-lock` 的调用链上没有捕获它的人
      // —— 实测表现就是「**子进程整个崩掉、一条记录都不写**」，
      // 上层看到的现象是「第二个 run 的事件整段消失」，与根因隔了三层（见 M6 卡 §11）。
      // 结论：**锁的竞争必须由本函数吸收，不能冒泡** —— 它连「失败」都不算，只是「还没轮到」。
      if (!isBusyError(e)) throw e;
    }

    // 3) 等待（有上限）
    if (now >= deadline) {
      // ⚠️ 此处 `readLock` 只用于填「占用者是谁」这一**排障字段**，拿不到不该让整个调用失败
      // —— 判负的结论（`lock-timeout`）与它无关。
      let occupied: LockInfo | null = null;
      try {
        occupied = await readLock(repoKey);
      } catch {
        /* 排障信息缺失不影响判负，刻意吞掉 */
      }
      return { acquired: false, waitedMs: now - started, error: 'lock-timeout', holder: occupied };
    }
    await sleep(Math.max(1, Math.min(cfg.pollMs, deadline - now)));
  }
}

/**
 * 释放锁。**必须匹配 holder**（见文件头「为什么释放要校验 holder」）。
 * @returns 是否真的删掉了一行（`false` = 锁已被 TTL 抢走或本就无锁，属正常情况）
 */
export async function releaseRepoLock(repoKey: string, holder: string): Promise<boolean> {
  await ensureStateSchema();
  const rs = await getStateDb().execute({
    sql: `DELETE FROM pr_agent_repo_locks WHERE repo_key = ? AND holder = ?`,
    args: [repoKey, holder],
  });
  return rs.rowsAffected === 1;
}

/** 列出全部锁（排障用）。 */
export async function listRepoLocks(): Promise<LockInfo[]> {
  await ensureStateSchema();
  const rs = await getStateDb().execute(`SELECT repo_key, holder, acquired_at, expires_at FROM pr_agent_repo_locks`);
  return rs.rows.map(r => toLockInfo(String(r.repo_key), r as unknown as Record<string, unknown>));
}

/**
 * 清空全部锁。
 *
 * 仅供验证脚本复位与「崩溃后锁泄漏」的人工恢复使用。
 * 生产代码调用等于**主动放弃串行保证**。
 */
export async function releaseAllRepoLocks(): Promise<number> {
  await ensureStateSchema();
  const rs = await getStateDb().execute(`DELETE FROM pr_agent_repo_locks`);
  return rs.rowsAffected;
}
