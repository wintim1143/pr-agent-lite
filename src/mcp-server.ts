#!/usr/bin/env node
/**
 * MCP server 入口（M2）—— 本项目对外的**唯一**接口面。
 *
 * ## 先 stdio，后 HTTP
 *
 * 里程碑把「先 stdio 跑通最小工具」定成第一个动作，理由是一条未核实项：
 * 外侧网关注册 MCP server 的方式与兼容性**没有验证过**。stdio 是最小、最没有争议的传输
 * （网关直接 spawn 本进程），用它先把「注册 → 调用 → 拿到正确事实」这条链走通；
 * 传输方式的替换是后面的事，不该和「工具本身对不对」纠缠在一起。
 *
 * ## 三个约束
 *
 * 1. **只读**：三个工具全部是数据读，**不调 LLM**（M2 的整个设计前提）。
 *    端点未解决也能交付，正是因为它不依赖端点。
 * 2. **`readOnlyHint: true`**：三级闸门里的第一级 —— **只读免批准**。
 *    这是给外侧网关的机器可读声明，不是给人看的注释：网关据此决定要不要弹人工确认。
 * 3. **不出站**：本进程不发起任何 IM 调用、不持有任何 IM 凭据。
 *    「谁收到、以什么形态渲染」全在外侧网关，这里只负责把事实交出去。
 *
 * ## stdout 是协议通道
 *
 * stdio 传输下 stdout 只允许出现 MCP 协议消息。任何 `console.log` 都会破坏协议 ——
 * 因此人类可读的行必须走 stderr。本文件里所有日志都由 `progress.ts` 直接写 stderr
 * （事件镜像走 `console.warn`/`console.error`，见其 isWarn 实现），不会污染协议。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { logStartupSelfCheck } from './startup.js';
import { repoList, runCost, runStatus } from './tools/readonly.js';
import { resolveRepoTarget } from './adapters/repo-registry.js';
import { progressLogPath } from './progress.js';

/**
 * `dev_start` 拉起子进程后的**存活探测窗口**（毫秒）。
 *
 * 子进程若在这个窗口内就退出，必须**当场**返回 `isError` —— 否则调用方拿到的是
 * 「已开始」，而实际上什么都没有发生（详见 dev_start 里的 3b 段）。
 * 窗口取 400ms：足够覆盖「参数非法 / 注册表读不出 / 入口缺失」这类启动即死，
 * 又远小于一次真实编码（分钟级）与外侧网关的一句话延迟（二十秒级）。
 */
const DEV_RUNNER_LIVENESS_MS = 400;

/** 把任意结果包成 MCP 工具返回值：结构化数据给机器，可读文本给人。 */
function asToolResult(structured: Record<string, unknown>, humanText: string) {
  return {
    content: [{ type: 'text' as const, text: humanText }],
    structuredContent: structured,
  };
}

/** 从结构化结果里取出约定的 `notes`（本项目的工具统一用它承载「空结果 / 未配置」的解释）。 */
function notesOf(structured: unknown): string[] {
  const n = (structured as { notes?: unknown })?.notes;
  return Array.isArray(n) ? n.map(String) : [];
}

function withNotes(structured: Record<string, unknown>, humanText: string) {
  const notes = notesOf(structured);
  const text = notes.length ? `${humanText}\n\n注意：\n- ${notes.join('\n- ')}` : humanText;
  return asToolResult(structured, text);
}

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'pr-agent-lite', version: '0.1.0' });

  // ── 1. 有哪些仓库 ───────────────────────────────────────────────
  // M2 验收 1：返回被测仓的**真实路径与分支**（可对照服务器实际值）。
  server.registerTool(
    'repo_list',
    {
      title: '列出已接入的仓库',
      description:
        '列出被接入的代码仓库：逻辑标识、本机 clone 路径、base 分支、当前分支与 HEAD 提交。' +
        '未配置注册表时会明确说明「未配置」，而不是回一个空列表。只读，不调 LLM。',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const r = repoList();
      const human = r.repos.length
        ? r.repos
            .map(
              x =>
                `- ${x.key} → ${x.localPath}（base=${x.baseBranch}，当前=${x.currentBranch ?? '(detached)'}` +
                `，HEAD=${x.headCommit ?? '未知'}${x.exists ? '' : '，⚠️ 路径不存在'}）`
            )
            .join('\n')
        : '（没有已接入的仓库）';
      return withNotes(
        r as unknown as Record<string, unknown>,
        `注册表：${r.registryPath}（${r.registryExists ? '存在' : '不存在'}）\n已接入 ${r.repos.length} 个仓库：\n${human}`
      );
    }
  );

  // ── 2. 上次跑得怎么样 ───────────────────────────────────────────
  // M2 验收 2：没有 run 时**明确回「没有运行记录」**，不编造。
  server.registerTool(
    'run_status',
    {
      title: '查看运行状态',
      description:
        '不带 runId 时列出最近的运行记录（时间、状态、跑到哪一步）；带 runId 时返回该次的详情与时间线。' +
        '没有任何记录时明确回答「没有运行记录」。只读，不调 LLM。',
      inputSchema: {
        runId: z.string().optional().describe('要查看的运行标识；省略则列出最近的运行'),
        limit: z.number().int().positive().max(100).optional().describe('列表模式的条数上限，默认 10'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId, limit }) => {
      const r = runStatus({ runId, limit });

      if (r.runId) {
        if (!r.run) {
          return withNotes(
            r as unknown as Record<string, unknown>,
            `没有找到 runId = ${r.runId} 的运行记录。` +
              `若这个 runId 刚由 dev_start 返回，可能只是第一条记录还没落盘（子进程启动需要时间）—— ` +
              `隔几秒重试即可；**持续查不到**才是真的不存在。`
          );
        }
        const s = r.run;
        const human =
          `runId：${s.runId}\n` +
          `开始：${s.startedAt ?? '(无 run:start 记录)'}\n` +
          `结束：${s.endedAt ?? '(未结束)'}\n` +
          `状态：${s.status ?? '(尚未结束 —— **未结束不等于成功**)'}\n` +
          `最后事件：${s.lastEventAt ?? '未知'}（阶段 ${s.lastStage ?? '未知'}）\n` +
          `步骤：成功 ${s.stepsDone} / 失败 ${s.stepsFailed}；LLM 调用 ${s.llmCalls}（其中 ${s.unknownUsage} 次未回传用量）\n` +
          `仓库：${s.repoKey ?? '(未指定)'}\n` +
          `时间线（末段 ${r.timeline.length} 条）已放在结构化结果里。`;
        return withNotes(r as unknown as Record<string, unknown>, human);
      }

      if (r.runs.length === 0) {
        return withNotes(r as unknown as Record<string, unknown>, '**没有运行记录** —— 至今没有跑过任何开发流程。');
      }
      const human = r.runs
        .map(s => {
          const state = s.status ?? (s.endedAt ? '(未知)' : '进行中/中断');
          return (
            `- ${s.runId}　${s.startedAt ?? '(无起点记录)'}　状态=${state}` +
            `　阶段=${s.lastStage ?? '未知'}　步骤 成功${s.stepsDone}/失败${s.stepsFailed}`
          );
        })
        .join('\n');
      return withNotes(r as unknown as Record<string, unknown>, `最近的 ${r.runs.length} 次运行：\n${human}`);
    }
  );

  // ── 3. 花了多少 ─────────────────────────────────────────────────
  server.registerTool(
    'run_cost',
    {
      title: '查看 token 成本',
      description:
        '按仓库聚合 token 用量。⚠️ 有调用未回传 usage 时 token 数是**下界**（不会把「取不到」写成 0）。' +
        '只读，不调 LLM。',
      inputSchema: {
        runId: z.string().optional().describe('只统计某一次运行；省略则统计全部'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ runId }) => {
      const r = runCost({ runId });
      if (r.rows.length === 0) {
        return withNotes(
          r as unknown as Record<string, unknown>,
          runId ? `runId = ${runId} 没有任何成本记录。` : '**没有任何 LLM 调用记录** —— 还没跑过流程。'
        );
      }
      const human = r.rows
        .map(
          x =>
            `- ${x.repoKey}：调用 ${x.llmCalls} 次，输入 ${x.inputTokens} / 输出 ${x.outputTokens} / 合计 ${x.totalTokens}` +
            (x.unknownUsage ? `（另有 ${x.unknownUsage} 次未回传用量）` : '')
        )
        .join('\n');
      const t = r.totals;
      return withNotes(
        r as unknown as Record<string, unknown>,
        `合计：调用 ${t.llmCalls} 次，输入 ${t.inputTokens} / 输出 ${t.outputTokens} / 合计 ${t.totalTokens}` +
          `（未回传用量 ${t.unknownUsage} 次）\n按仓库：\n${human}`
      );
    }
  );

  // ── 4. 触发一次编码（唯一有写入副作用的工具）─────────────────────
  server.registerTool(
    'dev_start',
    {
      title: '开始一次编码',
      description:
        '按需求标题在目标仓库上建 feature 分支并让编码执行体真正改文件，随后依次过测试/审核/commit 闸门。' +
        '⚠️ **立即返回**：只给出 runId，真正的工作在独立进程里跑 —— 用 run_status 或状态页看进度。' +
        '默认不接触远端（不 push、不开 PR）。',
      inputSchema: {
        target: z.string().describe('目标仓库的逻辑标识 `owner/repo`；本机路径由仓库注册表解析'),
        title: z.string().min(1).describe('需求标题（决定分支名与 commit 语义）'),
        body: z.string().optional().describe('需求正文'),
        issueNumber: z.number().int().nonnegative().optional().describe('编号；不传则按启动时刻生成'),
        baseBranch: z.string().optional().describe('覆盖注册表里的 base 分支'),
        allowRemote: z.boolean().optional().describe('是否允许推送并开 PR（默认否）'),
      },
      // 这个工具**不是只读的**（会在目标仓建分支、改文件）。标注如实给出，
      // 批不批准由外侧网关按其策略决定 —— 本项目不替它做准入判断，也不把判断交给模型。
      // 传 `allowRemote: true` 会真的推远端。默认关闭，忘了传就是「不做事」而不是「悄悄推上去」。
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ target, title, body, issueNumber, baseBranch, allowRemote }) => {
      // 1) 入参校验在**本进程**做：不合法的入参应当立刻回给调用方，
      //    而不是起一个注定失败的进程、让人去日志里找原因。
      //
      // ⚠️ 用 `resolveRepoTarget` 而不是 `parseRepoTarget`（2026-09-26 实测补）：
      //    后者的默认参数会在调用方**没给** baseBranch 时填上 `main`，把「没指定」
      //    与「指定了 main」压成同一个值 —— 于是注册表声明 `master` 之类时，
      //    必然在子进程里撞上「baseBranch 配置矛盾」。**而那条冲突发生在被
      //    detached 拉起的子进程里**：调用方拿到的是一句「已开始」，状态页与
      //    `run_status` 里却一条记录都没有。假成功比直接报错贵得多。
      let parsedTarget;
      try {
        parsedTarget = resolveRepoTarget(target, baseBranch);
      } catch (e) {
        const msg = `target 无法解析（期望 owner/repo，且仓库注册表可读）：${e instanceof Error ? e.message : String(e)}`;
        return { content: [{ type: 'text' as const, text: msg }], isError: true };
      }
      /** 基线是调用方显式给的，还是由注册表决定的 —— 只有前者才下发 `--base-branch`。 */
      const baseBranchFromCaller = Boolean(baseBranch?.trim());

      // 2) 触发体必须存在。缺它时若只回一个 runId，调用方会以为「已经开始了」——
      //    而实际上什么都没发生，且日志里也不会有任何记录（进程都没起来）。
      //    这类「假成功」比直接报错贵得多。
      const runnerPath = join(__dirname, 'dev-runner.js');
      if (!existsSync(runnerPath)) {
        const msg =
          `找不到运行时入口 ${runnerPath}。这通常意味着还没构建 —— 先跑 \`npm run build\`，` +
          `再用 \`npm run mcp\` 启动服务。`;
        return { content: [{ type: 'text' as const, text: msg }], isError: true };
      }

      const runId = `run-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${randomUUID().slice(0, 4)}`;
      const args = [
        runnerPath,
        `--run-id=${runId}`,
        `--target=${parsedTarget.owner}/${parsedTarget.repo}`,
        `--title=${title}`,
        // 只在调用方**显式**给了基线时才下发；否则让子进程按注册表决定
        // （它自己会 `resolveRepoTarget`）。下发一个默认值等于替注册表做了决定。
        ...(baseBranchFromCaller ? [`--base-branch=${baseBranch}`] : []),
        ...(body ? [`--body=${body}`] : []),
        ...(issueNumber !== undefined ? [`--issue-number=${issueNumber}`] : []),
        ...(allowRemote ? ['--allow-remote'] : []),
      ];

      // 3) **脱离父进程**起子进程：`detached` + `unref` 让这次 run 不会随 MCP 会话结束而消失，
      //    也不能继承父进程的 stdio —— 父进程的 stdout 是 MCP 协议通道，泄漏一行出去就会冲掉协议。
      const child = spawn(process.execPath, args, {
        detached: true,
        stdio: 'ignore',
        cwd: process.cwd(),
        env: process.env,
      });
      child.unref();

      // 3b) **存活探测**（2026-09-26 实测补）：子进程若在百毫秒级就退出，
      //     说明这次 run 根本没跑起来（参数非法、注册表读不出、入口缺失…）。
      //     原先直接回「已开始」，调用方只能通过「过一会儿问 run_status 查不到」
      //     来间接发现 —— 而那时人已经在等一次根本不存在的编码。
      //     ⚠️ 这一步给「必须立即返回」加了有界的几百毫秒；相对一次分钟级编码
      //     与外侧网关二十秒级的一句话延迟，这个代价换的是**失败当场可见**。
      const earlyExit = await new Promise<number | null>(resolve => {
        const timer = setTimeout(() => {
          child.off('exit', onExit);
          resolve(null);
        }, DEV_RUNNER_LIVENESS_MS);
        function onExit(code: number | null): void {
          clearTimeout(timer);
          resolve(code ?? -1);
        }
        child.once('exit', onExit);
      });
      if (earlyExit !== null) {
        const structured = {
          started: false,
          runId,
          pid: child.pid ?? null,
          exitCode: earlyExit,
          target: `${parsedTarget.owner}/${parsedTarget.repo}`,
          logFile: progressLogPath(),
          notes: [
            `子进程在 ${DEV_RUNNER_LIVENESS_MS}ms 内就退出了（exit=${earlyExit}）—— **这次 run 没有跑起来**。`,
            `原因写在日志里（日志是唯一真相源）：${progressLogPath()}`,
          ],
        };
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `启动失败：runId=${runId} 的子进程在 ${DEV_RUNNER_LIVENESS_MS}ms 内退出（exit=${earlyExit}）。\n` +
                `这次 run **没有跑起来**，不要当作「正在跑」——原因见日志 ${progressLogPath()}。`,
            },
          ],
          structuredContent: structured,
          isError: true,
        };
      }

      const host = process.env.STATUS_HOST?.trim() || '127.0.0.1';
      const port = Number(process.env.STATUS_PORT ?? 8787);
      const structured = {
        started: true,
        runId,
        pid: child.pid ?? null,
        target: `${parsedTarget.owner}/${parsedTarget.repo}`,
        baseBranch: parsedTarget.baseBranch,
        baseBranchSource: baseBranchFromCaller ? 'caller' : 'registry',
        issueNumber: issueNumber ?? null,
        // 编号由子进程生成（按启动时刻）；调用方想知道确切值时以 run_status 为准
        issueNumberDerivedByRunner: issueNumber === undefined,
        stopAfterCommit: !allowRemote,
        statusUrl: `http://${host}:${port}/`,
        notes: [
          '本次调用**已经返回**，编码仍在独立进程里进行 —— 用 run_status(runId) 或状态页看进度。',
          baseBranchFromCaller
            ? `基线由调用方指定：${parsedTarget.baseBranch}`
            : `基线由仓库注册表决定：${parsedTarget.baseBranch}`,
          allowRemote
            ? '已允许接触远端（会 push 并尝试开 PR）。'
            : '默认不接触远端：跑完 commit 即止，不 push、不开 PR。',
        ],
      };
      return withNotes(structured, `已开始：runId = ${runId}（进程 ${child.pid ?? '?'}）`);
    }
  );

  return server;
}

async function main(): Promise<void> {
  // ⚠️ **必须在做任何事之前**把 `console.log` 改道到 stderr。
  //
  // stdio 传输下 stdout 是**协议通道**，只允许出现 JSON-RPC 消息。而 `progress.ts`
  // 的事件镜像是「失败类走 stderr、其余走 stdout」—— 也就是说**最正常的那一行
  // （`startup config:check`）恰好会写进 stdout**，直接把协议冲掉。
  // 症状不是报错，而是外侧网关收到一行无法解析的文本后连接静默失效 —— 归因成本极高。
  //
  // 这里改的是 console 对象上的方法（而非包一层日志模块），因为 `progress.ts`
  // 在**调用时**才取 `console.log`，改道即时生效，且不需要动那份借鉴来的代码。
  console.log = console.error;
  // 自检在改道之后跑：所有事件都会走 stderr，stdout 保持干净。
  logStartupSelfCheck();

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 连接期间不能退出；stdio 关闭时 node 会自然结束进程。
}

main().catch((e: unknown) => {
  console.error(`[mcp] 启动失败: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
