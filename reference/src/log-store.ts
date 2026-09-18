/**
 * 结构化日志的**存储层**（M6-3 新增）。
 *
 * ## 为什么把「写」和「存」拆开
 *
 * M6 之前只有一个 `progress.ts`：事件类型、写 API、文件追加全挤在一个文件里，
 * 于是「给定一个 runId 取回它的事件」这件事**根本没有实现** ——
 * 只能靠人去 `mastra.db` 反查 runId，再在混杂日志里手工切分
 * （这条手工手法记在 `.workbuddy/memory/ref-ops.md`，M6 的使命就是把它消掉）。
 *
 * 本模块只做三件事，且都是**纯 I/O、可单独单测**的：
 * 1. **路径解析**：每次调用都读 env，不用模块级常量 —— 常量会让单测无法切换路径
 *    （jest 的模块缓存让「改 env 再 import」成为陷阱）。
 * 2. **轮转**：`dev-workflow.log` → `.1` → `.2` …，只保留 N 份。
 * 3. **读取**：`readAllRecords()` 跨轮转文件按**时间顺序**拼回一整条流；
 *    `readRun(runId)` 从中过滤出某个 run。
 *
 * ## 关键设计：轮转不得截断进行中的 run
 *
 * 一个 run 可能跑几分钟，其间日志随时可能触发轮转（阈值是按字节算的）。
 * 若轮转时把旧文件删掉，**当前 run 的前半段就没了** ——
 * 而「按 run 重建时间线」恰恰要求跨文件的完整性。
 *
 * 所以读取器的契约是：**先读最旧的轮转文件，最后读当前文件**，
 * 这样拼出来的顺序天然是时间顺序（每个文件内部本来就是顺序追加）。
 * 不按 ts 排序是有意的：同一毫秒内的多条事件，按 ts 排序会打乱真实发生顺序。
 *
 * ## 环境变量
 *
 * | 变量 | 缺省 | 含义 |
 * |---|---|---|
 * | `APP_PROGRESS_FILE` | `<cwd>/logs/dev-workflow.log` | 日志文件绝对路径 |
 * | `APP_PROGRESS_LOG` | 未设（=开启） | 设 `0` 完全关闭落盘与镜像 |
 * | `APP_LOG_MAX_BYTES` | 5242880（5 MiB） | 单文件超过即轮转；`0` = 永不轮转 |
 * | `APP_LOG_KEEP` | 5 | 保留的轮转份数（不含当前文件） |
 *
 * ⚠️ 文件名**不允许**出现任何拼接标识（`:` 是 Windows 文件名保留字符，见
 * `M8-飞书双向控制.md` §11 2026-09-17）。本模块只用固定文件名 + 数字后缀。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 结构化日志记录形态（JSON Lines 的一行）。 */
export interface LogRecord {
  /** ISO 8601 时间戳 */
  ts: string;
  /** 事件名（闭集，定义在 `progress.ts`，规范见 `docs/日志规范.md`） */
  event: string;
  /** 阶段名 */
  stage?: string;
  /**
   * run 标识。
   * - `string`：属于该 run
   * - `null`：**显式声明「不属于任何 run」**（启动期 / 进程级事件）
   * - `undefined`（字段缺失）：M6 之前的历史遗留记录
   */
  runId?: string | null;
  /** span 级标识 = `` `${runId}:${stage}` ``（按 OTEL span 语义命名，便于将来换 sink 而非换模型） */
  traceId?: string | null;
  /** 本事件耗时（毫秒）；仅 `*:done` / `*:fail` 类事件有 */
  durationMs?: number;
  [key: string]: unknown;
}

export interface AppendResult {
  ok: boolean;
  /** 失败原因（`ok:false` 时才有）；调用方**不得**因此中断业务流程（fail-open） */
  error?: string;
  /** 本次追加前是否发生了轮转 */
  rotated: boolean;
}

export interface ReadResult {
  /** 按时间顺序（最旧的轮转文件 → 当前文件）拼好的记录流 */
  records: LogRecord[];
  /** 实际读到的文件（最旧在前） */
  files: string[];
  /** 无法解析为 JSON 的行数（历史日志实测为 0，非 0 即为异常信号） */
  badLines: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 5;

/** 每次调用都重新读 env —— 见文件头「路径解析」的说明。 */
export function logFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.APP_PROGRESS_FILE || path.join(process.cwd(), 'logs/dev-workflow.log'));
}

/** 单文件字节上限；`<= 0` 表示不轮转。 */
export function logMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.APP_LOG_MAX_BYTES;
  if (raw === undefined || raw === '') return DEFAULT_MAX_BYTES;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_MAX_BYTES;
}

/** 保留的轮转份数；至少 1。 */
export function logKeepCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.APP_LOG_KEEP;
  if (raw === undefined || raw === '') return DEFAULT_KEEP;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_KEEP;
}

/** 轮转文件路径：`base.1` 是**较旧**的一份，编号越大越旧。 */
export function rotatedPath(base: string, index: number): string {
  return `${base}.${index}`;
}

/** 读取顺序（最旧 → 最新）：`base.keep` … `base.1`, `base`。 */
export function readOrder(base: string, keep: number): string[] {
  const out: string[] = [];
  for (let i = keep; i >= 1; i--) out.push(rotatedPath(base, i));
  out.push(base);
  return out;
}

function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1; // 不存在或无权限 —— 都按 0 处理（追加时自然会报错并 fail-open）
  }
}

/**
 * 轮转：`base.(keep-1)` → `base.keep`，…，`base` → `base.1`，并丢弃最旧一份。
 *
 * 用 `rename` 而非「读出来重写」：后者会在大文件上产生一次完整拷贝，
 * 且中途失败会留下半个文件（日志是证据，不允许被写坏）。
 *
 * @returns 实际发生的 rename 条数（0 = 没有文件可轮转）
 */
export function rotate(base: string, keep: number): number {
  let moved = 0;
  const oldest = rotatedPath(base, keep);
  try {
    if (fs.existsSync(oldest)) {
      fs.rmSync(oldest);
      moved++;
    }
  } catch {
    /* 删不掉最旧一份不阻断轮转本身 —— 后面 rename 会失败并 fail-open */
  }
  for (let i = keep - 1; i >= 1; i--) {
    const src = rotatedPath(base, i);
    if (fs.existsSync(src)) {
      fs.renameSync(src, rotatedPath(base, i + 1));
      moved++;
    }
  }
  if (fs.existsSync(base)) {
    fs.renameSync(base, rotatedPath(base, 1));
    moved++;
  }
  return moved;
}

/**
 * 追加一条记录（必要时先轮转）。
 *
 * ⚠️ **绝不抛错** —— 观测是辅助能力，不是安全边界（与质量闸门的 fail-closed 刻意相反）。
 * 失败时返回 `{ok:false, error}`，由调用方决定是否镜像到 stderr。
 */
export function appendRecord(record: LogRecord, env: NodeJS.ProcessEnv = process.env): AppendResult {
  const base = logFilePath(env);
  const line = JSON.stringify(record) + '\n';
  const bytes = Buffer.byteLength(line, 'utf8');
  const max = logMaxBytes(env);
  let rotated = false;
  try {
    fs.mkdirSync(path.dirname(base), { recursive: true });
    // 轮转判定用「追加后是否超限」，避免刚好卡在阈值上反复轮转出空文件
    if (max > 0 && fileSize(base) > 0 && fileSize(base) + bytes > max) {
      rotate(base, logKeepCount(env));
      rotated = true;
    }
    fs.appendFileSync(base, line, 'utf8');
    return { ok: true, rotated };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), rotated };
  }
}

/**
 * 读回全部记录（跨轮转文件，按时间顺序）。
 *
 * 不抛错：日志目录不存在 / 权限不足 / 文件被独占，一律当作「读不到」处理，
 * 返回空集合并把原因留在 `badLines` 之外的调用方诊断里（读取器只用于诊断与验收，
 * 不应把「读不到」升级成异常）。
 */
export function readAllRecords(env: NodeJS.ProcessEnv = process.env): ReadResult {
  const base = logFilePath(env);
  const files = readOrder(base, logKeepCount(env));
  const records: LogRecord[] = [];
  const seen: string[] = [];
  let badLines = 0;
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue; // 文件不存在是正常情况（尚未轮转过）
    }
    seen.push(f);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as LogRecord);
      } catch {
        badLines++;
      }
    }
  }
  return { records, files: seen, badLines };
}

/**
 * 取回某个 run 的全部事件（顺序与写入一致）。
 *
 * AC-6 的判据就落在这里：**返回的事件必须全部且仅属于该 run**。
 * 双 run 交错写入时，「仅属于」靠严格相等比较保证（不使用 startsWith 之类的前缀匹配
 * —— runId 前缀可能撞车，而撞车是**静默**的）。
 */
export function readRun(runId: string, env: NodeJS.ProcessEnv = process.env): LogRecord[] {
  return readAllRecords(env).records.filter(r => r.runId === runId);
}

/** 单个 (runId, stage) 的配对计数。 */
export interface PairingRow {
  runId: string | null;
  stage: string;
  starts: number;
  done: number;
  fail: number;
  /** `done + fail` */
  ends: number;
  /** `starts - ends`；0 即为配对 */
  delta: number;
  balanced: boolean;
}

export interface PairingReport {
  rows: PairingRow[];
  /**
   * **新格式**（runId 非空）且不配对的行 —— 这是真正的判据来源（M6 之后的数据）。
   */
  unbalanced: PairingRow[];
  /**
   * 历史遗留（runId 缺失或为 null）且不配对的行。
   * M6 之前的日志无法归因到 run，**只报告、不作判据**（抹平它等于伪造历史）。
   */
  legacyUnbalanced: PairingRow[];
  totals: {
    events: number;
    byEvent: Record<string, number>;
    /** 有 runId 的事件数 */
    attributed: number;
    /** 归不到 run 的事件数（含历史遗留） */
    unattributed: number;
    runs: number;
  };
}

const PAIR_EVENTS = new Set(['step:start', 'step:done', 'step:fail']);

/**
 * 按 `(runId, stage)` 做 `step:start` ↔ `step:done|step:fail` 配对校验（AC-4）。
 *
 * ## 为什么必须按 runId 分组，而不能只统计总数
 *
 * M6 侦察时算出的总数是：`step:start` 141 vs `step:done+step:fail` 146 → 「多 5 个 end」。
 * 这个数字**只能说明存在不对称，不能说明是哪一次 run 的哪一步** ——
 * 而排障要的恰恰是后者。分组后才能给出「run X 的 test 步有 start 无 end」这种可执行结论。
 *
 * ## 为什么历史遗留不参与断言
 *
 * 历史记录没有 runId（真实覆盖率 0/701），任何「按 run 归因」都是编造。
 * 故它们单独成桶（`legacyUnbalanced`），报告出来供对照，但不作为通过条件。
 */
export function pairingReport(records: LogRecord[]): PairingReport {
  const rows = new Map<string, PairingRow>();
  const byEvent: Record<string, number> = {};
  let attributed = 0;
  const runs = new Set<string>();

  for (const r of records) {
    byEvent[r.event] = (byEvent[r.event] ?? 0) + 1;
    if (typeof r.runId === 'string' && r.runId) {
      attributed++;
      runs.add(r.runId);
    }
    if (!PAIR_EVENTS.has(r.event)) continue;
    const runId = typeof r.runId === 'string' && r.runId ? r.runId : null;
    const stage = String(r.stage ?? '(无 stage)');
    const key = `${runId ?? '(无 runId)'}\u0000${stage}`;
    let row = rows.get(key);
    if (!row) {
      row = { runId, stage, starts: 0, done: 0, fail: 0, ends: 0, delta: 0, balanced: true };
      rows.set(key, row);
    }
    if (r.event === 'step:start') row.starts++;
    else if (r.event === 'step:done') row.done++;
    else row.fail++;
  }

  const all = [...rows.values()];
  for (const row of all) {
    row.ends = row.done + row.fail;
    row.delta = row.starts - row.ends;
    row.balanced = row.delta === 0;
  }

  return {
    rows: all,
    unbalanced: all.filter(r => !r.balanced && r.runId !== null),
    legacyUnbalanced: all.filter(r => !r.balanced && r.runId === null),
    totals: {
      events: records.length,
      byEvent,
      attributed,
      unattributed: records.length - attributed,
      runs: runs.size,
    },
  };
}

/**
 * LLM 调用的配对统计（**参考项，不是判据**）。
 *
 * 为什么只是参考：`llm:start` 每次尝试各落一条，而失败尝试落 `llm:retry`、
 * **最后一次失败不落任何终态事件**（随后是 `step:fail`）。所以
 * `starts > done + retry` 是**重试耗尽**的正常表现，不能当不平衡报错。
 *
 * 另外 `coding` 步的心跳会把 `llm:done` 当心跳用（`heartbeat: true`），
 * 必须排除，否则「coding 的 LLM 调用」会被算成几十次。
 */
export function llmSummary(records: LogRecord[]): Record<string, { starts: number; done: number; retry: number; heartbeats: number }> {
  const out: Record<string, { starts: number; done: number; retry: number; heartbeats: number }> = {};
  for (const r of records) {
    if (!r.event.startsWith('llm:')) continue;
    const stage = String(r.stage ?? '(无 stage)');
    out[stage] ??= { starts: 0, done: 0, retry: 0, heartbeats: 0 };
    if (r.event === 'llm:start') out[stage].starts++;
    else if (r.event === 'llm:done') {
      if (r.heartbeat === true) out[stage].heartbeats++;
      else out[stage].done++;
    } else if (r.event === 'llm:retry') out[stage].retry++;
  }
  return out;
}

/** token 用量形态（AI SDK v5 的 `usage` 字段；兼容 v4 的 prompt/completion 命名）。 */
export interface TokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * 把 Mastra / AI SDK 的 usage 归一化成固定三字段。
 *
 * ⚠️ **拿不到就是 `null`，绝不等价于 0** —— 与 M4 的 `testsPassed = null ≠ true` 同构。
 * 中继不返回 usage 与「这一轮真的花了 0 token」是两件事，把后者写成 0 会让成本报表变假。
 */
export function normalizeUsage(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const input = num(u.inputTokens ?? u.promptTokens);
  const output = num(u.outputTokens ?? u.completionTokens);
  const total = num(u.totalTokens);
  if (input === null && output === null && total === null) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total ?? (input !== null && output !== null ? input + output : null),
  };
}

/** 按仓库（`repoKey`）聚合的成本行。 */
export interface CostRow {
  repoKey: string;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 有多少次调用**拿不到** usage（`null`）—— 报表明细必须带上这个数，否则会被读成 0 */
  unknownUsage: number;
}

/**
 * 按 `repoKey` 聚合 token 花费（AC-7）。
 *
 * ## 归口维度为什么是 repoKey 而不是 runId
 *
 * runId 只有一个 run（该 run 的成本），而「哪个仓库最烧钱」是跨 run 的问题。
 * `repo:target` 事件已经把 `repoKey` 落成结构化字段（M5b），
 * 这里只需把同一 run 的 `llm:done` 归到该 run 的 repoKey 上。
 *
 * 单仓库模式（无 target）没有 `repo:target` 事件 → 归入 `(未指定仓库)`，
 * **不猜、不回退到 cwd**（M5 的教训：隐式回退会静默给出错误答案）。
 */
export function costByRepo(records: LogRecord[]): CostRow[] {
  const runToRepo = new Map<string, string>();
  for (const r of records) {
    if (r.event !== 'repo:target') continue;
    if (typeof r.runId === 'string' && r.runId && typeof r.repoKey === 'string' && r.repoKey) {
      runToRepo.set(r.runId, r.repoKey);
    }
  }
  const rows = new Map<string, CostRow>();
  const bump = (repoKey: string): CostRow => {
    let row = rows.get(repoKey);
    if (!row) {
      row = { repoKey, llmCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, unknownUsage: 0 };
      rows.set(repoKey, row);
    }
    return row;
  };
  for (const r of records) {
    if (r.event !== 'llm:done' || r.heartbeat === true) continue;
    const repoKey =
      typeof r.runId === 'string' && r.runId ? (runToRepo.get(r.runId) ?? '(未指定仓库)') : '(历史遗留/无 runId)';
    const row = bump(repoKey);
    row.llmCalls++;
    const usage = normalizeUsage(r.usage);
    if (!usage) {
      row.unknownUsage++;
      continue;
    }
    row.inputTokens += usage.inputTokens ?? 0;
    row.outputTokens += usage.outputTokens ?? 0;
    row.totalTokens += usage.totalTokens ?? 0;
  }
  return [...rows.values()].sort((a, b) => b.totalTokens - a.totalTokens || b.llmCalls - a.llmCalls);
}
