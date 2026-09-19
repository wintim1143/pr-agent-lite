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
import { z } from 'zod';
import { logStartupSelfCheck } from './startup.js';
import { repoList, runCost, runStatus } from './tools/readonly.js';

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
            `没有找到 runId = ${r.runId} 的运行记录。`
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
