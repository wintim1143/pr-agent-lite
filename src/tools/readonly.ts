/**
 * 只读工具的实现层（M2）。
 *
 * ## 为什么与 MCP 层分开
 *
 * 这三个动作（列仓库 / 看运行状态 / 看成本）有**两个消费者**：
 * 外侧网关经 MCP 调用，以及人直接打开状态页看。若把它们写进 MCP 注册代码里，
 * 状态页就得复制一份 —— 而两份实现迟早会在某个字段上分叉，
 * 于是「会话里看到的」与「页面上看到的」对不上，排障时先要判断该信哪个。
 *
 * 因此本模块是**唯一实现**，且它不认识 MCP：输入是普通对象，输出是**可直接 JSON 序列化**的普通对象。
 *
 * ## 三条不可退让的约束
 *
 * 1. **不调 LLM**（M2 的整个设计前提）。这里的失败与「LLM 端点是否可用」彻底无关 ——
 *    端点一天不解决，这一层照样能交付。
 * 2. **不编造**。没有记录就明说「没有记录」，不返回空数组让人误解成「都很干净」，
 *    也不把 `null` 填成 `0`（`0` 会被读成「确实花了 0」）。
 * 3. **不抛错**（对外的工具调用）。读不到东西是**要报告的事实**，不是异常 ——
 *    抛错会让外侧网关只看到一个「工具失败」，反而丢掉了「为什么读不到」这个更有用的信息。
 *    ⚠️ 这条只针对本模块的**对外返回值**；内部真正的程序错误仍然照抛不误。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  costByRepo,
  listRuns,
  logFilePath,
  readAllRecords,
  readRun,
  type LogRecord,
  type RunSummary,
} from '../log-store.js';
import { registryFilePath, loadRegistry, type RepoEntry } from '../adapters/repo-registry.js';

/** 每个工具返回里的统一「说明」字段 —— 空的或负面的结论也必须写出来，不能靠调用方猜。 */
export interface ToolNote {
  notes: string[];
}

/**
 * 从 `.git` 目录里读出 HEAD 指向（分支名 + 提交）。
 *
 * ## 为什么不 spawn `git`
 *
 * 这个函数服务于一个「永远不该抛错」的只读工具。`git` 子进程会带来三个额外失败面：
 * 仓库损坏、git 不在 PATH、并发时锁文件竞争 —— 而我们要的信息
 * （当前分支 + HEAD 提交）**就是 `.git/HEAD` 这一行文本**，读文件即可。
 *
 * ## 支持的三种形态
 *
 * 1. `.git` 是目录：正常仓库 → 读 `<dir>/HEAD`
 * 2. `.git` 是文件：worktree / submodule → 内容形如 `gitdir: <path>`，跟进一层
 * 3. `HEAD` 是 `ref: refs/heads/x`：从该 ref 文件读提交；读不到（已打包进 `packed-refs`）
 *    → 提交留 `null`，**不猜**
 *
 * 分支名解析不出来（detached HEAD）时 `branch` 为 `null` 而 `sha` 有值 ——
 * 这比反过来（编一个分支名）诚实得多。
 */
function readGitHead(repoPath: string, depth = 0): { branch: string | null; sha: string | null; gitDir: string | null } {
  const empty = { branch: null, sha: null, gitDir: null };
  if (depth > 3) return empty;

  const dotGit = path.join(repoPath, '.git');
  let gitDir = dotGit;

  try {
    const st = fs.statSync(dotGit);
    if (st.isFile()) {
      // worktree / submodule：内容是一行 `gitdir: <路径>`（相对路径以仓库根为基准）
      const line = fs.readFileSync(dotGit, 'utf8').trim();
      const m = /^gitdir:\s*(.+)$/.exec(line);
      if (!m) return empty;
      gitDir = path.isAbsolute(m[1]) ? m[1] : path.resolve(repoPath, m[1]);
    }
  } catch {
    return empty;
  }

  let head: string;
  try {
    head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
  } catch {
    return empty;
  }

  const refMatch = /^ref:\s*(.+)$/.exec(head);
  if (!refMatch) {
    // detached HEAD：HEAD 里直接就是提交号
    return { branch: null, sha: /^[0-9a-f]{7,40}$/i.test(head) ? head : null, gitDir };
  }

  const ref = refMatch[1].trim();
  const isBranch = ref.startsWith('refs/heads/');
  let sha: string | null = null;
  try {
    sha = fs.readFileSync(path.join(gitDir, ref), 'utf8').trim() || null;
  } catch {
    // 已打包进 packed-refs：只做一次文本查找，不解析整个文件
    try {
      const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
      const hit = packed.split('\n').find(l => l.endsWith(` ${ref}`));
      sha = hit ? hit.split(' ')[0] : null;
    } catch {
      sha = null;
    }
  }
  return { branch: isBranch ? ref.slice('refs/heads/'.length) : ref, sha, gitDir };
}

/** 注册表里的一项 + 它在**本机**的真实形态。 */
export interface RepoListEntry {
  /** 逻辑标识 `owner/repo` —— 与机器无关，是调用方应该用的那个 key */
  key: string;
  /** 本机 clone 路径。⚠️ 这是「这台机器的事实」，只在本机工具里出现，不进日志 */
  localPath: string;
  /** 该仓库的 base 分支（注册表声明值，缺省 `main`） */
  baseBranch: string;
  /** localPath 是否真实存在 */
  exists: boolean;
  /** 是否是一个 git 仓库（`.git` 存在） */
  isGitRepo: boolean;
  /** 当前分支；detached HEAD 时为 null */
  currentBranch: string | null;
  /** HEAD 提交（短）；取不到为 null */
  headCommit: string | null;
}

export interface RepoListResult {
  /** 注册表文件路径（**来自配置**，不是写死的） */
  registryPath: string;
  /** 注册表文件是否存在。false 时 `repos` 必为空 —— 这是「未配置」，不是「没有仓库」 */
  registryExists: boolean;
  repos: RepoListEntry[];
  notes: string[];
}

/**
 * 列出被接入的仓库 —— 返回**本机真实路径与当前分支**（M2 验收 1）。
 *
 * 若注册表未配置 / 读不出内容，返回 `registryExists:false` + 说明，**不抛错**：
 * "还没配" 与 "工具坏了" 是两件事，调用方需要能分辨。
 */
export function repoList(): RepoListResult {
  const registryPath = registryFilePath();
  const notes: string[] = [];

  if (!fs.existsSync(registryPath)) {
    return {
      registryPath,
      registryExists: false,
      repos: [],
      notes: [
        `尚未配置仓库注册表（${registryPath} 不存在）。`,
        '这是**未配置**，不是「没有仓库」—— 请按部署说明放置注册表文件（或设 REPO_REGISTRY_PATH）。',
      ],
    };
  }

  let entries: Record<string, RepoEntry>;
  try {
    entries = loadRegistry();
  } catch (e) {
    return {
      registryPath,
      registryExists: true,
      repos: [],
      notes: [`仓库注册表存在但读不出内容：${e instanceof Error ? e.message : String(e)}`],
    };
  }

  const repos: RepoListEntry[] = Object.keys(entries)
    .sort()
    .map(key => {
      const entry = entries[key];
      const localPath = entry.localPath;
      const exists = fs.existsSync(localPath);
      const head = exists ? readGitHead(localPath) : { branch: null, sha: null, gitDir: null };
      return {
        key,
        localPath,
        baseBranch: entry.baseBranch ?? 'main',
        exists,
        isGitRepo: head.gitDir !== null,
        currentBranch: head.branch,
        headCommit: head.sha ? head.sha.slice(0, 12) : null,
      };
    });

  for (const r of repos) {
    if (!r.exists) notes.push(`${r.key}: localPath 指向的目录不存在 —— 需要先把仓库 clone 到该位置。`);
    else if (!r.isGitRepo) notes.push(`${r.key}: 目录存在但不是 git 仓库（找不到 .git）。`);
  }

  return { registryPath, registryExists: true, repos, notes };
}

export interface RunStatusResult {
  /** 查单个 run 时为该 runId；查列表时为 null */
  runId: string | null;
  /** 单 run 模式的摘要 */
  run: RunSummary | null;
  /** 列表模式的 runs（按最后事件时间倒序） */
  runs: RunSummary[];
  /** 单 run 模式下的时间线（原始事件，已截断到尾部若干条） */
  timeline: LogRecord[];
  /** 单 run 模式下的步骤配对统计 */
  pairing: { stage: string; starts: number; done: number; fail: number; delta: number; balanced: boolean }[];
  log: { path: string; files: number; badLines: number; records: number };
  notes: string[];
}

export interface RunStatusInput {
  /** 指定则返回该 run 的详情 + 时间线；省略则返回 run 列表 */
  runId?: string;
  /** 列表模式的条数上限，默认 10 */
  limit?: number;
  /** 时间线最多返回多少条**尾部**事件，默认 40 */
  timelineLimit?: number;
}

/**
 * 看运行状态 —— 没有记录时**明确说「没有」**（M2 验收 2）。
 *
 * 注意这里刻意区分了三种「空」：
 * - 日志文件还不存在 → 进程从没落过事件
 * - 日志存在但没有带 runId 的事件 → 有进程级事件，但从没跑过 run
 * - 指定了 runId 但查不到 → 可能是 runId 写错，也可能已被轮转出保留窗口（**不替它猜**）
 */
export function runStatus(input: RunStatusInput = {}): RunStatusResult {
  const read = readAllRecords();
  const notes: string[] = [];
  const log = {
    // 路径真相源只有 `log-store.ts` 的 logFilePath() 一处 —— 这里只转发，不另写解析
    path: logFilePath(),
    files: read.files.length,
    badLines: read.badLines,
    records: read.records.length,
  };

  if (read.badLines > 0) {
    notes.push(`日志里有 ${read.badLines} 行无法解析（正常应为 0）—— 读取结果可能不完整。`);
  }

  const runId = input.runId?.trim();
  if (runId) {
    const records = readRun(runId);
    if (records.length === 0) {
      notes.push(
        `没有 runId = ${runId} 的运行记录。可能是 runId 写错，` +
          `也可能它已随日志轮转移出保留窗口（当前只保留最近 ${read.files.length} 个日志文件）。` +
          `**这里不做任何猜测** —— 调用方应先确认 runId。`
      );
      return { runId, run: null, runs: [], timeline: [], pairing: [], log, notes };
    }

    const summary = listRuns(records, 1)[0] ?? null;
    const byStage = new Map<string, { stage: string; starts: number; done: number; fail: number; delta: number; balanced: boolean }>();
    for (const r of records) {
      if (r.event !== 'step:start' && r.event !== 'step:done' && r.event !== 'step:fail') continue;
      const stage = String(r.stage ?? '(无 stage)');
      let row = byStage.get(stage);
      if (!row) {
        row = { stage, starts: 0, done: 0, fail: 0, delta: 0, balanced: true };
        byStage.set(stage, row);
      }
      if (r.event === 'step:start') row.starts++;
      else if (r.event === 'step:done') row.done++;
      else row.fail++;
    }
    const pairing = [...byStage.values()];
    for (const row of pairing) {
      row.delta = row.starts - (row.done + row.fail);
      row.balanced = row.delta === 0;
    }

    const limit = input.timelineLimit ?? 40;
    const timeline = limit > 0 ? records.slice(-limit) : [];

    if (summary && summary.endedAt === null) {
      notes.push('该 run 没有 `run:end` 事件 —— 它可能仍在运行，也可能进程中途退出。**未结束不等于成功。**');
    }

    return { runId, run: summary, runs: [], timeline, pairing, log, notes };
  }

  const runs = listRuns(read.records, input.limit ?? 10);
  if (runs.length === 0) {
    notes.push(
      read.records.length === 0
        ? '没有任何运行记录（日志里一条事件都没有）。'
        : `日志里有 ${read.records.length} 条事件，但**没有一条属于任何 run** —— 至今没有跑过一次开发流程。`
    );
    notes.push('**没有运行记录**是一个确定的事实，不是工具出错。');
  }
  return { runId: null, run: null, runs, timeline: [], pairing: [], log, notes };
}

export interface RunCostResult {
  runId: string | null;
  rows: ReturnType<typeof costByRepo>;
  totals: {
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** 拿不到 usage 的调用数 —— 见下方 notes，**这个数不为 0 时 token 数是下界，不是总额** */
    unknownUsage: number;
  };
  log: { path: string; records: number };
  notes: string[];
}

/**
 * 看 token 成本。
 *
 * ## ⚠️ 这里最容易被误读的一点
 *
 * `totalTokens` 为 0 **不等于**「没花 token」。上游（编码执行器 / 中继）不回传 `usage` 时，
 * 落盘的 usage 是 `null`，而 `null` 是**设计内的正确值**（不把「取不到」伪装成 0）。
 * 这类调用只计入 `unknownUsage`。因此：**`unknownUsage > 0` 时，token 数是下界**。
 * 这句话会随结果一起返回 —— 让读报表的人不必先读源码才知道。
 */
export function runCost(input: { runId?: string } = {}): RunCostResult {
  const read = readAllRecords();
  const runId = input.runId?.trim() || null;
  const records = runId ? readRun(runId) : read.records;
  const rows = costByRepo(records);

  const totals = rows.reduce(
    (acc, r) => ({
      llmCalls: acc.llmCalls + r.llmCalls,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      totalTokens: acc.totalTokens + r.totalTokens,
      unknownUsage: acc.unknownUsage + r.unknownUsage,
    }),
    { llmCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, unknownUsage: 0 }
  );

  const notes: string[] = [];
  if (runId && records.length === 0) {
    notes.push(`没有 runId = ${runId} 的记录，成本无法归集（**不返回 0，因为 0 会被读成「确实没花钱」**）。`);
  } else if (totals.llmCalls === 0) {
    notes.push('没有任何 LLM 调用记录 —— 这表示还没跑过流程，不是「本次没花钱」。');
  }
  if (totals.unknownUsage > 0) {
    notes.push(
      `有 ${totals.unknownUsage} 次调用**没回传 usage**（落盘为 null，这是设计内的正确值，不是 0）。` +
        `因此上面的 token 数是**下界**，不是总额。`
    );
  }

  return { runId, rows, totals, log: { path: logFilePath(), records: records.length }, notes };
}
