/**
 * 结构化事件日志的**写 API**（M6-1/M6-2 重写）。
 *
 * 存储、轮转、读取、配对校验在 `log-store.ts`；本文件只管「事件长什么样、怎么落下去」。
 * 规范正文见 `docs/日志规范.md`。
 *
 * ## 解决什么问题
 *
 * dev-workflow 的 coding 步是**同步阻塞、静默无输出**的：一次 generate 可能跑 5~15 分钟，
 * 期间终端只有一个卡住的提示符。使用者无法区分三种状态：
 * 1. LLM 正常思考中（该等）
 * 2. 上游中继挂死（该杀）
 * 3. CLI 子进程已崩但 Promise 未 settle（该查）
 *
 * 只能事后翻 `~/.claude/projects/<repo>/*.jsonl` 考古，成本极高。
 *
 * ## 做法
 *
 * 每个阶段边界写一条 **JSON Lines** 事件到 `logs/pr-agent-lite.log`，
 * 同时打一行人类可读文本到 stdout（镜像，**只是给人看的副本**，不是真相源）。
 *
 * ## 为什么不上 OTEL（M6 定案：不做）
 *
 * 分布式追踪需要 exporter 与额外依赖，且本仓库当前**没有观测后端**；
 * 写本地文件的收益（零依赖、可直接 `tail`）更直接。M6 的判据是**可关联**（同一 run 的事件
 * 能被分组、能重建时间线），不是**可上报** —— 字段已按 span 语义命名
 * （`ts` / `durationMs` / `traceId`），将来真出现多实例分布式追踪需求时，
 * 迁移的是 **sink** 而不是数据模型。
 *
 * ---
 *
 * ## ⚠️ 2026-09-17（M6-2）：位置参数 → 对象参数，这不是风格问题
 *
 * 原签名是 `stageStart(stageName: string, runId?: string)` —— **两个形参都是 `string`**。
 * 于是 `stageStart('merge', 'rejected')` 把「语义串」塞进了 `runId` 槽，
 * **编译器一声不吭**。实测后果：701 条事件里带 `runId` 的 6 条，值全是字面量
 * `"rejected"` / `"resumed"` —— **真实 runId 覆盖率 0/701**，多 run 事件无法分组。
 *
 * 现在所有写 API 都收**一个对象**，且 `stage` 与 `runId` 都是**必填字段**：
 * 漏传 → 编译错误；传错槽位 → 类型不兼容。误用从「静默污染数据」变成「构建失败」。
 *
 * 另外 `write()` 里还留了一道运行期负向断言（`INVALID_RUN_IDS`）：
 * 万一将来有人绕过类型（`as any` / JS 调用 dist），污染值也不会被当成 runId 写进去。
 */

import { appendRecord, logFilePath, readRun, type LogRecord } from './log-store.js';

export {
  logFilePath,
  logMaxBytes,
  logKeepCount,
  readAllRecords,
  readRun,
  pairingReport,
  llmSummary,
  normalizeUsage,
  costByRepo,
} from './log-store.js';
export type { LogRecord, PairingRow, PairingReport, CostRow, TokenUsage } from './log-store.js';

/**
 * 阶段名**闭集**（规范正文：`docs/日志规范.md` §4）。
 *
 * ## 为什么必须闭集
 *
 * 阶段名会进 `traceId`（`` `${runId}:${stage}` ``），也是「按阶段算耗时 / 算 token」的分组键。
 * 一旦出现 `'merge '`（多空格）、`'push_open_pr'`（下划线）、`'Merge'`（大小写）这类拼写漂移，
 * 同一个阶段会被拆成多行，而**汇总数字看起来仍然正常** —— 静默的统计错误。
 *
 * 用联合类型把它钉死在编译期：新增阶段必须先改这里（以及文档），
 * 想「随手写个新名字」是不可能的。
 */
export const STAGE_NAMES = [
  /** 进程启动期（不属于任何 run） */
  'startup',
  /** 日志模块自身（轮转 / 写失败 / 非法 runId 等，不属于任何 run） */
  'logger',
  /** IM 入口轮询（进程级，不属于某个 run） */
  'inbound',
  /** dev-workflow 八步 */
  'checkout',
  'coding',
  'test',
  'review',
  'commit',
  'push-open-pr',
  'notify',
  'merge',
  /** 质量闸门内部的 LLM 调用（不属于八步中的任何一步，是「闸门」这一横向机制） */
  'gate',
  /** insight-workflow 四步 */
  'collect',
  'summarize',
  'confirm',
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

/** run 终态语义。 */
export type RunStatus =
  /** 跑完了该跑的（含「无 PR 可合」这类设计内终点） */
  | 'ok'
  /** 失败（闸门判负 / 外部调用失败 / 异常） */
  | 'failed'
  /** 人工明确拒绝（合法决策，不是故障 —— 见 dev-workflow merge 步注释） */
  | 'rejected'
  /** 按配置跳过（stopAfterCommit / 未配置凭据等） */
  | 'skipped';

/**
 * 事件类型闭集。
 *
 * ## 为什么拆这么细，而不是只有「一个 log 事件」
 *
 * 「能算出来」的前提是**能数**。「这一阶段花了多久」需要 `*:start` 与 `*:done` 配对；
 * 「LLM 试了几次」需要 `llm:retry` 单独可数。混成一个事件名就全丢了。
 */
export type ProgressEvent =
  /** run 级：开始 / 结束 / 挂起（M6-5） */
  | 'run:start'
  | 'run:end'
  | 'run:suspend'
  /** step 级：进入 / 成功 / 失败 */
  | 'step:start'
  | 'step:done'
  | 'step:fail'
  /** LLM 级：调用开始 / 成功（带 usage）/ 重试 */
  | 'llm:start'
  | 'llm:done'
  | 'llm:retry'
  /**
   * 围栏拦截（M3-6,2026-09-15 新增）。
   *
   * 为什么需要：guard.ts 拦下一次工具调用时只打 `console.warn`，而终端输出会随会话消失
   * —— 「红线确实生效了」这件事**事后无法从任何持久化文件证明**。
   * M3-6 的验收恰恰要求「deny 日志出现且远端未受影响」，故把拦截动作落成结构化事件。
   */
  | 'guard:deny'
  /**
   * 测试闸门的**程序侧**事实（M4-1,2026-09-15 新增）。
   *
   * 为什么需要：`test:run` 的结论（跑没跑 / exit code / 耗时 / 未执行原因）
   * 与 LLM 无关，却又是判负时最需要回溯的一手信息。只打 console 会随会话消失，
   * 落成结构化事件后可用 `grep test:run logs/pr-agent-lite.log` 直接复核。
   */
  | 'test:run'
  /**
   * agent 是否动过测试文件（M4-5,2026-09-15 新增）。
   *
   * 「跑测试」可信度取决于**测试是谁写的**。这条事件记录本次改动对测试文件的触碰情况
   * （`modified` 高危 / `added` 仅记录），是自证检测唯一的持久化证据。
   */
  | 'test:touch'
  /**
   * 本 run 的目标仓库事实（M5,2026-09-16 新增）。
   *
   * 多仓库最要命的失败模式是**串台**（在 A 的仓库上做了 B 的改动、或把 PR 开到别的仓库），
   * 而它**不报错**。把 `repoKey / baseBranch / localPath` 三者一起落成结构化事件后，
   * 「这次到底在哪个仓库、基于哪个分支、跑的是哪个本地工作树」变成事后可核对的**一条记录**。
   *
   * ⚠️ 这是本项目里**唯一**会把本机路径写进日志的位置 —— 刻意如此：
   * 串台只能靠「路径对不上」识别，不记路径就没有判据。
   * （快照里则**绝不**写路径，两者是不同性质的产物：日志是事后证据，快照是跨机器状态。）
   */
  | 'repo:target'
  /** 仓库互斥锁的获取/等待/抢占（M5b-4）。串行保证必须有可见证据，否则「看起来没串台」不可信。 */
  | 'repo:lock'
  /** 仓库锁释放（M5b-4）。 */
  | 'repo:unlock'
  /** 配置体检（M6-1 新增）：收编 `config.ts` 的裸 `console.*`，启动期事件（`runId: null`）。 */
  | 'config:check'
  /** 入口轮询的错误（M6-1 新增）：收编 `inbound-poll.ts` 的裸 `console.warn`。进程级事件。 */
  | 'inbound:error'
  /*
   * ⚠️ 这里**刻意没有** `notify:send`（2026-09-17 收口时自查删掉）。
   *
   * 收编 notify 步的裸 `console.*` 时曾声明过这个事件名，但实现走的是
   * `stageStart({stage:'notify'})` 的 `p.done({mode})` / `p.fail(msg,{mode,notifyError,raw})`
   * —— 成败都落（需求满足），只是**没有一个叫 `notify:send` 的事件**。
   *
   * 一个「在闭集里声明、却没有任何生产者」的事件名，与 M1 文档里那个从未 import 的
   * `Logger`（本卡 §2 点名要修的「文档幻觉」）是**同一类错**：它让后来人以为
   * 「查 `notify:send` 就能看到推送结果」，而那个事件永远不会出现。
   * 宁可从闭集里删掉，也不要留一个漂亮但空的钩子。
   */
  /* ---- 以下由日志模块自身产出（stage = 'logger'）---- */
  /** 发生轮转（M6-3）。 */
  | 'log:rotate'
  /** 落盘失败（M6-1）。**注意：此事件本身就写不进去**，只会镜像到 stderr —— 这是刻意的。 */
  | 'log:write-failed'
  /** runId 取值非法（M6-2 负向断言）：如 `'rejected'` / `'merge'` 这类语义串。 */
  | 'log:invalid-runid'
  /**
   * 该带 runId 的事件没有 runId（M6-2）。
   *
   * 规范允许 `runId: null` 的**只有** `startup` / `logger` / `inbound` 三个阶段；
   * 其余阶段出现 `null` 一律额外落一条本事件 —— **不静默**（AC-3 会把它数出来）。
   */
  | 'trace:missing';

/** 允许 `runId: null` 的阶段（不属于任何 run 的事件）。AC-3 的例外集合就是它。 */
export const RUNLESS_STAGES: readonly StageName[] = ['startup', 'logger', 'inbound'];

/** 绝不允许出现在 runId 槽位的值（负向断言，防 2026-09-17 之前那类污染复发）。 */
const INVALID_RUN_IDS = new Set<string>([...STAGE_NAMES, 'rejected', 'resumed', 'approved', 'true', 'false', 'undefined', 'null']);

export interface EventFields {
  /** 阶段名（闭集，见 `STAGE_NAMES`）。写入 `traceId = \`${runId}:${stage}\`` */
  stage: StageName;
  /**
   * run 标识。**必填**：取不到时写 `null`，不允许省略。
   *
   * ⚠️ 用 `null` 而不是 `undefined` 是有意的：JSON.stringify 会**丢掉** `undefined` 字段，
   * 于是「忘了传」与「显式声明不属于任何 run」在文件里长得一模一样 —— 无法区分。
   */
  runId: string | null;
  /** 本事件耗时（毫秒）；仅 `*:done` / `*:fail` 类事件有 */
  durationMs?: number;
  [key: string]: unknown;
}

/** 阶段作用域：`stageStart()` 的返回值，供 step 内部记录结束/失败。 */
export interface StageScope {
  readonly stage: StageName;
  readonly runId: string | null;
  /** 记录成功结束，返回耗时（毫秒）。 */
  done(fields?: Record<string, unknown>): number;
  /** 记录失败结束，返回耗时（毫秒）。 */
  fail(error: unknown, fields?: Record<string, unknown>): number;
}

/** 环境变量 `PRAL_PROGRESS_LOG=0` 可关闭落盘（镜像也一并关闭，避免半开状态）。 */
function enabled(): boolean {
  return process.env.PRAL_PROGRESS_LOG !== '0';
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** runId 归一化 + 负向断言（见文件头 2026-09-17 说明）。 */
function normalizeRunId(raw: unknown): { runId: string | null; invalid?: string } {
  if (raw === null || raw === undefined) return { runId: null };
  if (typeof raw !== 'string') return { runId: null, invalid: String(raw) };
  const v = raw.trim();
  if (!v) return { runId: null };
  if (INVALID_RUN_IDS.has(v)) return { runId: null, invalid: v };
  return { runId: v };
}

/** 进程内 runId → 起始时刻。跨进程 resume 时缓存为空，退化为「回读日志」。 */
const startedAt = new Map<string, number>();
/** 已落过 `run:end` 的 run —— 保证「有且仅有 1 条」（AC-8）。 */
const endedRuns = new Set<string>();

/**
 * 回读日志找该 run 的 `run:start` 时刻。
 *
 * 为什么不在内存里存一份就够：`merge` 步会 `suspend`，用户点按钮后是**另一个进程**
 * 带着同一个 runId resume 的。那个进程的内存里没有起点，只能回读 ——
 * 这也正是「日志本身是真相源」的含义。
 */
function runStartFromLog(runId: string): number | undefined {
  const rec = readRun(runId).find(r => r.event === 'run:start');
  if (!rec) return undefined;
  const t = Date.parse(rec.ts);
  return Number.isFinite(t) ? t : undefined;
}

/** 统计某 run 的 step 终态数（写成结构化字段，省得读日志的人再数一遍）。 */
function countRunSteps(runId: string): { stepsDone: number; stepsFailed: number; llmCalls: number } | undefined {
  const recs = readRun(runId);
  if (!recs.length) return undefined;
  let stepsDone = 0;
  let stepsFailed = 0;
  let llmCalls = 0;
  for (const r of recs) {
    if (r.event === 'step:done') stepsDone++;
    else if (r.event === 'step:fail') stepsFailed++;
    else if (r.event === 'llm:done' && r.heartbeat !== true) llmCalls++;
  }
  return { stepsDone, stepsFailed, llmCalls };
}

/** 判断是否该走 stderr 镜像（失败类事件）。 */
function isWarn(event: ProgressEvent, fields: Record<string, unknown>): boolean {
  if (event.endsWith(':fail') || event.endsWith(':retry') || event === 'guard:deny') return true;
  if (event.startsWith('log:') || event === 'trace:missing') return true;
  if (event === 'run:end') return fields.status !== 'ok' && fields.status !== 'skipped';
  if (event === 'inbound:error' || event === 'config:check') return fields.level !== 'info';
  return false;
}

/**
 * 写一条事件（**唯一**落盘入口）。
 *
 * @param skipTraceGuard 内部事件（`trace:missing` 等）置 true，避免递归
 */
function write(event: ProgressEvent, fields: EventFields, skipTraceGuard = false): void {
  if (!enabled()) return;

  const { runId, invalid } = normalizeRunId(fields.runId);
  // 解构掉 stage / runId，避免它们在 `...rest` 里二次出现（重复展开会让「谁赢」依赖顺序，
  // 是那种「看起来对、改一行就错」的写法的典型来源）。
  const { durationMs, stage: _s, runId: _r, ...extra0 } = fields as EventFields & Record<string, unknown>;
  const stage = fields.stage;

  const record: LogRecord = {
    ts: new Date().toISOString(),
    event,
    stage,
    // 显式 null 而不是省略：省略会被 JSON.stringify 丢掉（见 EventFields.runId 说明）
    runId,
    traceId: runId ? `${runId}:${stage}` : null,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...extra0,
  };
  const rest = extra0;
  if (invalid !== undefined) {
    // 不把污染值写进 runId 槽，但**也不静默丢弃** —— 留字段 + 单独落事件
    record.invalidRunId = invalid;
  }

  // 人类可读镜像（给人看的那一份；真相源永远是上面这条 JSON）
  const secs = durationMs !== undefined ? ` (${(durationMs / 1000).toFixed(1)}s)` : '';
  const extra = Object.entries(rest)
    .filter(([k]) => k !== 'stage' && k !== 'runId')
    .map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`)
    .join(' ');
  const line = `[${record.ts}] ${stage} ${event}${secs}${runId ? ` run=${runId.slice(0, 8)}` : ''}${extra ? ' | ' + extra : ''}`;
  if (isWarn(event, rest)) console.warn(line);
  else console.log(line);

  const res = appendRecord(record);
  if (!res.ok) {
    // 落盘失败绝不能拖垮流水线本体（与闸门 fail-closed 相反：观测是辅助，不是安全边界）。
    // 这条**只镜像不落盘** —— 文件写不进去，它自然也写不进去。
    console.warn(`[logger] 写日志失败(不影响流程): ${res.error}`);
  } else if (res.rotated) {
    console.log(`[${record.ts}] logger log:rotate | 日志超过 ${process.env.PRAL_LOG_MAX_BYTES ?? '5MiB'}，已轮转 ${logFilePath()}`);
  }

  if (invalid !== undefined) {
    write(
      'log:invalid-runid',
      { stage: 'logger', runId: null, originalEvent: event, invalidRunId: invalid, hint: 'runId 槽位收到语义串（阶段名或 rejected/resumed 之类），已按 null 处理' },
      true
    );
  } else if (runId === null && !RUNLESS_STAGES.includes(stage) && !skipTraceGuard) {
    // 规范允许 null 的只有 startup / logger / inbound。其余一律**不静默**。
    write('trace:missing', { stage, runId: null, originalEvent: event, hint: '调用点不在 step execute 上下文内，取不到 runId' }, true);
  }
}

/** 记录一个阶段的开始，返回结束/失败回调（内部计时，调用方无需自己算耗时）。 */
export function stageStart(opts: Pick<EventFields, 'stage' | 'runId'>): StageScope {
  const { stage, runId } = opts;
  const t0 = Date.now();
  write('step:start', { stage, runId });
  return {
    stage,
    runId,
    done(fields = {}) {
      const durationMs = Date.now() - t0;
      write('step:done', { stage, runId, durationMs, ...fields });
      return durationMs;
    },
    fail(error, fields = {}) {
      const durationMs = Date.now() - t0;
      write('step:fail', { stage, runId, durationMs, error: errorText(error).slice(0, 300), ...fields });
      return durationMs;
    },
  };
}

/** 单条事件（用于 step 内部，如 LLM 调用开始/结束、重试）。 */
export function stage(event: ProgressEvent, fields: EventFields): void {
  write(event, fields);
}

export const stageOk = stage;
export const stageFail = stage;

/**
 * 落一条 `run:start`（M6-5）。由 workflow 的**第一个 step** 调用。
 *
 * 为什么放在 workflow 内而不是调用方（脚本 / HTTP 入口）：调用方有多处，且其中
 * 一部分是**已归档的证据产出器**（`verify-pr-loop.js` / `verify-m4-gate.js` /
 * `verify-m5-multirepo.js`）—— 改它们会让当时那份证据失去可重现性。
 * 放在 workflow 内，则「谁起 run 都能拿到完整追踪」，且新增入口不需要记得加埋点。
 */
export function runStart(fields: EventFields): void {
  if (fields.runId) startedAt.set(fields.runId, Date.now());
  write('run:start', fields);
}

/**
 * 落一条 `run:end`（M6-5 / AC-8）。
 *
 * **幂等**：同一个 runId 在一个进程里只落一条。失败路径上多层 catch 可能都走到这里
 * （`terminateStep` + step 外层兜底），没有这道闸就会写出两条 `run:end`，
 * 而「每个 run 有且仅有 1 条终态」正是 AC-8 要断言的。
 *
 * `durationMs` 是**墙钟**（含 suspend 等待人工点按钮的那段）。逐步耗时见 `step:*` 事件，
 * 两者不要混为一谈 —— 报告里分别列出。
 */
export function runEnd(fields: EventFields & { status: RunStatus }): void {
  const runId = fields.runId;
  if (runId) {
    if (endedRuns.has(runId)) return;
    endedRuns.add(runId);
  }
  const t0 = runId ? (startedAt.get(runId) ?? runStartFromLog(runId)) : undefined;
  const counts = runId ? countRunSteps(runId) : undefined;
  const durationMs = t0 !== undefined ? Date.now() - t0 : undefined;
  write('run:end', {
    ...fields,
    ...(counts ?? {}),
    ...(durationMs !== undefined ? { durationMs } : { durationHint: '未找到 run:start，墙钟耗时不可得（不写 0）' }),
  });
}

/**
 * 落一条 `run:suspend`（M6-5）。
 *
 * ⚠️ 刻意**不是** `step:start`。原实现（`stage('step:start', { stage: 'merge', waitingFor })`）
 * 借 step:start 表达「挂起」，于是 merge 阶段凭空多出一个**没有配对的 start**，
 * 直接污染 start↔end 配对判据 —— 挂起不是「一步开始了」，它就是 run 停下来等人。
 */
export function runSuspend(fields: EventFields): void {
  write('run:suspend', fields);
}

/** 当前日志文件绝对路径（供脚本/文档展示）。 */
export function progressLogPath(): string {
  return logFilePath();
}
