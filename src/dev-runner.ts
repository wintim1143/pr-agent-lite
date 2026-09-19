#!/usr/bin/env node
/**
 * 编码触发器 —— **一次运行一个独立进程**（M3）。
 *
 * ## 为什么是独立进程，而不是在 MCP server 里 `await`
 *
 * 触发器有一条铁律：**必须立即返回**。外侧网关收到人一句话后要马上给回应
 * （「已开始，runId 是 …」），而一次编码可能跑十几分钟 —— 若在同一个调用里 await，
 * 网关侧就是一个长时间不返回的工具调用，最终以两侧超时收场，
 * 而且**没有第二次机会**：链路的中间状态全在内存里，进程一断就没了。
 *
 * 拆成独立进程之后：
 * - 触发调用只做三件事：校验入参、起进程、返回 runId（毫秒级）；
 * - 真实进度全部落在**结构化日志**里（那是唯一真相源，见 `log-store.ts`）；
 * - 网关侧用 cron 消费 `run:end`，人用状态页或 `run_status` 看中间态；
 * - MCP server 重启 / 会话结束都不影响正在跑的这一次。
 *
 * ## 退出码的含义
 *
 * `0` = 流程正常走完（含「审核判负」这类**业务终态**，它写进 `run:end.status`，
 * 不是崩溃）；`非 0` = 这个进程自己出了问题（参数非法、起不来）。
 * 两者的区别很重要：把业务判负记成进程崩溃，会让「哪些 run 真的坏了」这个判断失效。
 */
import { randomUUID } from 'node:crypto';
import { resolveRepoEntry, parseRepoTarget, type RepoTarget } from './adapters/repo-registry.js';
import { gateHost } from './llm/chat.js';
import { devWorkflow } from './workflows/dev-workflow.js';
import { logStartupSelfCheck } from './startup.js';
import { stage } from './progress.js';

export interface RunnerArgs {
  runId: string;
  target: RepoTarget;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  /** 为真时末尾三步（push-open-pr / notify / merge）不产生任何远端副作用 */
  stopAfterCommit: boolean;
}

const USAGE = `用法: node dev-runner.js --target=<owner/repo> --title=<需求标题> [选项]

  --target=<owner/repo>   目标仓库（**逻辑标识**，本机路径由仓库注册表解析）
  --title=<文本>          需求标题（决定分支名与 commit 语义）
  --body=<文本>           需求正文（可选）
  --issue-number=<整数>    编号；不传时按启动时刻自动生成（v1 没有 issue 跟踪器）
  --base-branch=<名>      覆盖注册表里的 base 分支（可选）
  --run-id=<标识>         由调用方指定（便于把日志与触发请求对上）；不传则自动生成
  --allow-remote          允许末尾三步接触远端（默认禁止 —— 第一版不含开 PR）`;

/** 解析 `--k=v` 形式的参数。**纯函数**，便于单独测。 */
export function parseArgs(argv: string[]): { args: RunnerArgs } | { error: string } {
  const kv = new Map<string, string>();
  const flags = new Set<string>();
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const body = a.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) flags.add(body);
    else kv.set(body.slice(0, eq), body.slice(eq + 1));
  }

  const key = kv.get('target')?.trim();
  const title = kv.get('title')?.trim();
  if (!key) return { error: `缺少 --target。\n${USAGE}` };
  if (!title) return { error: `缺少 --title。\n${USAGE}` };

  const baseBranch = kv.get('base-branch')?.trim();
  let target: RepoTarget;
  try {
    target = parseRepoTarget(key, baseBranch);
  } catch (e) {
    return { error: `--target 格式非法（期望 owner/repo）：${e instanceof Error ? e.message : String(e)}` };
  }

  // 编号：v1 没有 issue 跟踪器，`feat/<n>-<slug>` 与 commit 里的 `Closes #<n>` 需要一个编号。
  // 默认取「启动时刻的秒数」—— 它单调、唯一性足够，且**调用方能在返回值里看到它**，
  // 不是一个藏在用例里的魔法值。显式传值时原样采用。
  const raw = kv.get('issue-number');
  let issueNumber: number;
  if (raw === undefined) {
    issueNumber = Math.floor(Date.now() / 1000);
  } else {
    issueNumber = Number(raw);
    if (!Number.isInteger(issueNumber) || issueNumber < 0) {
      return { error: `--issue-number 必须是非负整数，收到 "${raw}"` };
    }
  }

  return {
    args: {
      runId: kv.get('run-id')?.trim() || `run-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 4)}`,
      target,
      issueNumber,
      issueTitle: title,
      issueBody: kv.get('body') ?? '',
      // 默认**不进远端**：第一版不含 `git push` 与开 PR（服务器侧也没有 git 凭据）。
      // 默认值必须是最保守的那个 —— 忘记传参时不做事，而不是悄悄推上去。
      stopAfterCommit: !flags.has('allow-remote'),
    },
  };
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    console.error(`[dev-runner] ${parsed.error}`);
    return 2;
  }
  const { runId, target, issueNumber, issueTitle, issueBody, stopAfterCommit } = parsed.args;

  // 每次运行都记一次「本次实际生效的配置」—— 这是**运行期**事实，与进程启动时的自检互补：
  // 同一个服务可能被换了 env 之后重启，日志里两条时间戳能对上「哪一次用的是哪套配置」。
  logStartupSelfCheck();
  stage('config:check', {
    stage: 'startup',
    runId: null,
    level: 'info',
    field: 'run',
    message: `本次运行 runId=${runId} target=${target.owner}/${target.repo} base=${target.baseBranch} issue=#${issueNumber} stopAfterCommit=${stopAfterCommit}`,
  });

  // 注册表解析放在最前面：它读不出内容时**没有任何安全降级路径**
  // （退回「当前仓库」会在错误的仓库上建分支、改文件），所以必须显式失败。
  // ⚠️ 日志里刻意只记「解析成功」，不记本机路径 —— 路径属于「某台机器的事实」，
  // 打进日志会让日志在不同机器上无法比对（与 `registrySummary` 同一理由）。
  try {
    resolveRepoEntry(target);
    stage('config:check', {
      stage: 'startup',
      runId: null,
      level: 'info',
      field: 'repo',
      message: `目标仓库 ${target.owner}/${target.repo} 已在注册表中解析成功`,
    });
  } catch (e) {
    stage('config:check', {
      stage: 'startup',
      runId: null,
      level: 'error',
      field: 'repo',
      message: `目标仓库无法解析：${e instanceof Error ? e.message : String(e)}`,
    });
    return 3;
  }

  const outcome = await devWorkflow.run(
    { issueNumber, issueTitle, issueBody, target, stopAfterCommit },
    { runId, llmHost: gateHost }
  );

  // 只有「进程级事故」才返回非 0；业务终态（含闸门判负）已经落进 run:end，返回 0。
  // 这个区分让外侧网关能分辨「流程跑完了，结果是坏消息」与「流程根本没跑起来」。
  if (outcome.status === 'ok') return 0;
  if (outcome.status === 'suspended') {
    console.error(`[dev-runner] run=${runId} 挂起，等待人工确认（步骤 ${outcome.atStep}）`);
    return 0;
  }
  console.error(`[dev-runner] run=${runId} 失败于步骤 ${outcome.failedStep}：${outcome.error.message}`);
  return 0;
}

if (require.main === module) {
  main()
    .then(code => process.exit(code))
    .catch((e: unknown) => {
      console.error(`[dev-runner] 未捕获异常: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      process.exit(1);
    });
}
