/**
 * 入口层幂等：事件认领 + 轮询游标（M5a-1 / M5a-2）。
 *
 * ## 为什么入口层缺口是真问题（M5 卡 §1）
 *
 * 上游轮询入口 原先只过滤空消息，`sinceTs` 默认取 `now - 3600`（一小时窗口）。
 * 一旦把轮询挂上定时器（每分钟一轮），**同一条消息在一小时内会被重复触发几十次**
 * → 几十个 run → 几十个分支 → 几十个 PR。
 *
 * 产物层（`openPrForBranch` 复用既有 PR、`githubCheckout` 复用既有分支）M3 已做，
 * 所以「不重复开 PR」并不需要本模块 —— 本模块解决的是另一半：
 * **重复消耗 LLM 调用**（coding + review 真金白银）与**多个 run 争抢同一本地 clone**（M5b-4 的并发风险）。
 *
 * ## 判据分层（别把两件事混为一谈）
 *
 * | 层次 | 幂等键 | 归谁 |
 * |---|---|---|
 * | 入口层 | 事件 ID（飞书 `messageId`） | 本模块 |
 * | 产物层 | 分支名 / PR head | M3 的 `github.ts`（本模块不动） |
 *
 * ## 失败策略：fail-closed
 *
 * 写库失败（磁盘只读、库被独占等）**一律抛错**，不降级为「去重失效但继续跑」——
 * 后者正是本模块要防的重复消耗（M5 卡 §10 异常表）。
 */
import { ensureStateSchema, getStateDb } from './state-db.js';

/** 认领结果。`duplicate` 表示**别的轮次/进程已认领**，调用方应跳过并留下可见证据。 */
export interface ClaimResult {
  claimed: boolean;
  reason: 'new' | 'duplicate';
}

/** 已认领事件的行形态（只读查询用）。 */
export interface SeenEvent {
  key: string;
  source: string;
  seenAt: string;
  runId: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * **原子认领**一个事件。
 *
 * 实现要点：`INSERT OR IGNORE` + 唯一主键 `key`。
 * - `rowsAffected === 1` → 本次插入成功 = **本调用方认领成功**（且是唯一成功的那一个）；
 * - `rowsAffected === 0` → 冲突 = 已有记录 = 别的轮次已处理。
 *
 * ⚠️ **不要用「先 SELECT 再 INSERT」**：那之间存在竞态窗口，两个并发 poll 会同时看到「不存在」
 * 然后都去跑 run —— 正是本函数存在的理由。
 *
 * @param key    幂等键。同一语义的事件必须是同一个 key（飞书场景直接用 `messageId`）。
 * @param source 来源标识（如 `上游:<渠道ID>`），用于分来源统计与清理。
 */
export async function claimEvent(key: string, source: string): Promise<ClaimResult> {
  if (!key?.trim()) throw new Error('claimEvent: key 不能为空（无幂等键等于没有去重）');
  await ensureStateSchema();
  const rs = await getStateDb().execute({
    sql: `INSERT OR IGNORE INTO pr_agent_seen_events (key, source, seen_at, run_id) VALUES (?, ?, ?, NULL)`,
    args: [key, source, nowIso()],
  });
  const claimed = rs.rowsAffected === 1;
  return { claimed, reason: claimed ? 'new' : 'duplicate' };
}

/**
 * 把认领成功后真正起起来的 runId 回填到认领记录上。
 *
 * 为什么需要：认领发生在起 run **之前**（否则去重就没有意义），
 * 所以 runId 只能在 run 创建后补写。回填后这张表就从「幂等账本」升级成
 * 「事件 → run」的索引，排障时可直接反查「这条消息当时起了哪个 run」。
 */
export async function attachRunId(key: string, runId: string): Promise<void> {
  await ensureStateSchema();
  await getStateDb().execute({
    sql: `UPDATE pr_agent_seen_events SET run_id = ? WHERE key = ?`,
    args: [runId, key],
  });
}

/** 读取某来源的轮询游标（已处理到的最大时间戳，秒）。从未写过则返回 null。 */
export async function getCursor(source: string): Promise<number | null> {
  await ensureStateSchema();
  const rs = await getStateDb().execute({
    sql: `SELECT cursor FROM pr_agent_cursors WHERE source = ?`,
    args: [source],
  });
  const row = rs.rows[0];
  if (!row) return null;
  const v = Number(row.cursor);
  return Number.isFinite(v) ? v : null;
}

/**
 * 推进游标。**只前进不后退**（`MAX` 语义）——
 * 否则手动传入一个更早的 `sinceTs` 会把游标拖回去，让历史窗口被重新扫一遍。
 */
export async function advanceCursor(source: string, cursor: number): Promise<number> {
  await ensureStateSchema();
  await getStateDb().execute({
    sql: `INSERT INTO pr_agent_cursors (source, cursor, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(source) DO UPDATE SET
            cursor = MAX(pr_agent_cursors.cursor, excluded.cursor),
            updated_at = excluded.updated_at`,
    args: [source, Math.floor(cursor), nowIso()],
  });
  return (await getCursor(source)) ?? cursor;
}

/** 列出已认领事件（倒序），用于验证脚本提供「跳过有可见证据」的证据链。 */
export async function listSeenEvents(opts?: { source?: string; limit?: number }): Promise<SeenEvent[]> {
  await ensureStateSchema();
  const limit = opts?.limit ?? 50;
  const rs = opts?.source
    ? await getStateDb().execute({
        sql: `SELECT key, source, seen_at, run_id FROM pr_agent_seen_events WHERE source = ? ORDER BY seen_at DESC LIMIT ?`,
        args: [opts.source, limit],
      })
    : await getStateDb().execute({
        sql: `SELECT key, source, seen_at, run_id FROM pr_agent_seen_events ORDER BY seen_at DESC LIMIT ?`,
        args: [limit],
      });
  return rs.rows.map(r => ({
    key: String(r.key),
    source: String(r.source),
    seenAt: String(r.seen_at),
    runId: r.run_id === null || r.run_id === undefined ? null : String(r.run_id),
  }));
}

/** 统计已认领事件数（可选按来源过滤）。验证脚本用它把「跳过」变成可数的事实。 */
export async function countSeenEvents(source?: string): Promise<number> {
  await ensureStateSchema();
  const rs = source
    ? await getStateDb().execute({ sql: `SELECT COUNT(*) AS n FROM pr_agent_seen_events WHERE source = ?`, args: [source] })
    : await getStateDb().execute({ sql: `SELECT COUNT(*) AS n FROM pr_agent_seen_events` });
  return Number(rs.rows[0]?.n ?? 0);
}

/**
 * 清空认领账本与游标（可只清某来源）。
 *
 * 仅供验证脚本与运维复位使用 —— 生产代码调用等于**主动放弃幂等**。
 * @returns 被删除的行数
 */
export async function resetEventState(source?: string): Promise<number> {
  await ensureStateSchema();
  const db = getStateDb();
  const a = source
    ? await db.execute({ sql: `DELETE FROM pr_agent_seen_events WHERE source = ?`, args: [source] })
    : await db.execute(`DELETE FROM pr_agent_seen_events`);
  if (source) {
    await db.execute({ sql: `DELETE FROM pr_agent_cursors WHERE source = ?`, args: [source] });
  } else {
    await db.execute(`DELETE FROM pr_agent_cursors`);
  }
  return a.rowsAffected;
}
