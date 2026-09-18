import { execSync } from 'child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ClaudeSDKAgent } from '@mastra/claude';
import type { HookCallback, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { guardToolCall } from './guard.js';
import { repoRoot } from '../adapters/github.js';
import type { RepoTarget } from '../adapters/repo-registry.js';
import { stage } from '../progress.js';

/**
 * 真正写文件的编码执行体(封装 Claude Code CLI)。
 *
 * 为什么不用 Mastra 原生 agent 自造文件工具链:
 * Phase 0 `coding` 步要"真正读写文件",若用 Mastra 原生 agent,必须自己用 `createTool`
 * 实现 read/write/edit/bash/glob/grep 一整套,还要处理流式输出、权限确认、错误恢复、沙箱边界——
 * 每个边界都是漏洞点。而 `ClaudeSDKAgent` 直接复用 Claude Code CLI 原生全套工具 + `sdkOptions`,
 * 天然支持 `cwd`(目标仓库) / `allowedTools`(工具白名单) / `permissionMode`(无人值守) / `mcpServers`
 * / `resume`·`continue`(会话续跑),对接"改别的仓库 + 无人值守流水线"明显更简单。
 *
 * 代价:引入第二套 key——Claude 编码体走 Anthropic(读 `ANTHROPIC_API_KEY` 或 Claude Code 登录态),
 * 与闸门用的中转站模型(glm-5.2 等)是两家供应商。详见 `13-卡点` K4。
 *
 * ## 权限模型(三层,见下方 `getCodingAgent`)
 *
 * 1. `permissionMode: 'bypassPermissions'` —— 无人值守全放行(含 Bash),配 `allowDangerouslySkipPermissions`。
 * 2. `allowedTools` / `disallowedTools` —— 工具级白/黑名单(bypass 下不具约束力,作防御纵深)。
 * 3. **PreToolUse hook → `guard.ts`** —— 唯一能拦住每一次工具调用的硬拦截
 *    (受保护路径 + 危险命令),且与 permissionMode 无关。
 */

/**
 * 解析目标仓库根目录(编码 agent 的 cwd)。
 *
 * ## 为什么需要 `CODING_REPO_ROOT`(2026-09-07)
 * 原实现取「父进程 cwd 的 git 顶层」= 自举场景(改 sample-app 自己)。但 M2 要在**隔离的沙箱
 * 仓库**里写,否则编码 agent 会直接在 sample-app 上建分支、改文件、commit —— 静默且危险。
 *
 * 现在:**显式配置优先**;未配置时保持原自举行为。
 * 目录不存在 / 不是 git 仓库 → 显式抛错,而不是回退到 cwd 悄悄打错仓库。
 *
 * 与 `adapters/github.ts` 的 `repoRoot()` 读同一个 env,
 * 保证 checkout / coding / commit 落在同一个仓库。
 *
 * ## M5 扩展:可选 `target`（多仓库）
 *
 * 传了 `target` 就**完全交给 `adapters/github.ts` 的 `repoRoot(target)`** ——
 * 由仓库注册表解析本机 clone 路径，并顺带做「旧 env 与注册表矛盾」的显式检测。
 * 两条路径必须委托而不是各写一份，否则会出现
 * 「checkout 用注册表的路径、coding 用 env 的路径」这类静默错位（正是 M3 `parseOwnerRepo` 的坑）。
 */
export function getRepoRoot(target?: RepoTarget): string {
  if (target) return repoRoot(target);
  const configured = process.env.CODING_REPO_ROOT?.trim();
  if (configured) {
    if (!fs.existsSync(configured)) {
      throw new Error(`CODING_REPO_ROOT 指向的目录不存在: ${configured}`);
    }
    if (!fs.existsSync(path.join(configured, '.git'))) {
      throw new Error(`CODING_REPO_ROOT 指向的不是 git 仓库(缺 .git): ${configured}`);
    }
    return configured;
  }
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
  } catch {
    return process.cwd();
  }
}

/**
 * 是否缺少 Claude 编码所需的凭证。
 *
 * ## 历史坑(2026-09-04 修复)
 *
 * 旧实现只有一行:`!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_API_KEY`。
 * 但**正常路径下父进程本来就没有这个变量** —— 凭据来自 Claude Code CLI 启动时自行读取的
 * `~/.claude/settings.json`(本机是本地代理:`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`
 * + `ANTHROPIC_AUTH_TOKEN`,代理再注入真 key;本机 `~/.claude.json` 与 `.credentials.json`
 * 均**无** Claude 账号 OAuth 登录态)。
 *
 * 于是该判断恒为 `true`,coding 步永远走占位降级分支,只打一行 warn —— M2 因此
 * 一直跑不出真实改动,且从结果上无法区分「agent 没跑」和「跑了但没改东西」。
 *
 * ## 优先级事实(官方 `code.claude.com/docs/en/settings`)
 *
 * > Environment variables aren't a level in this stack... `ANTHROPIC_MODEL` exported in your
 * > shell applies over the `model` key from any file.
 *
 * 即**真实进程环境变量优先于 settings.json 的 env 块**。这也解释了为什么往子进程注入
 * `ANTHROPIC_*` 会盖掉用户配好的代理端点(见 `buildCodingEnv`)。
 *
 * ## 现在的判定(命中任一即视为可用)
 *
 * 1. 进程环境里有显式 key:`ANTHROPIC_API_KEY` / `CLAUDE_API_KEY`
 * 2. 用户显式覆盖编码后端:`CODING_ANTHROPIC_API_KEY` / `CODING_ANTHROPIC_BASE_URL`
 * 3. `~/.claude/settings.json` 的 `env` 块提供了端点或凭据(CLI 启动时自己应用)
 *
 * ⚠️ 这是**启发式**判断 —— 真正的可用性只有 CLI 跑起来才知道。因此调用方在编码失败时
 * 必须**显式报错**,不能静默降级成占位符。
 */
export function missingCodingCredentials(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY) return false;
  if (process.env.CODING_ANTHROPIC_API_KEY || process.env.CODING_ANTHROPIC_BASE_URL) return false;
  return !hasClaudeSettingsCredential();
}

/** 从 `~/.claude/settings.json` 的 env 块里找端点/凭据信号。只读、任何异常都视为「没有」。 */
function hasClaudeSettingsCredential(): boolean {
  try {
    const file = path.join(os.homedir(), '.claude', 'settings.json');
    if (!fs.existsSync(file)) return false;
    const env = JSON.parse(fs.readFileSync(file, 'utf8'))?.env ?? {};
    return Boolean(env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  } catch {
    return false;
  }
}

/**
 * 构造传给 Claude Code CLI 子进程的 env。
 *
 * ## 为什么默认【不覆盖】ANTHROPIC_*(2026-09-04 修复)
 *
 * 官方 `@mastra/claude` 示例根本不传 key —— 因为凭据该由 CLI 自己解析。本机链路:
 * `~/.claude/settings.json` env 块 → `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`(本地代理)
 * → 代理注入真 key。旧实现把 `ANTHROPIC_BASE_URL` 硬改成 `LLM_BASE_URL`(中转站 直连),
 * 直接盖掉了这条可用通路 —— 这是 M2 编码超时的根因之一。
 *
 * 现在:**默认原样继承父进程环境**,只有用户显式设置 `CODING_ANTHROPIC_*` 时才覆盖。
 *
 * ⚠️ `sdk.d.ts` 明确:env 一旦设置会**整个替换**子进程环境、不自动合并 `process.env`。
 * 所以必须展开 `...process.env`,否则子进程会因缺 PATH/HOME 直接炸掉。
 *
 * ## 为什么注入 `API_TIMEOUT_MS`(2026-09-07 新增)
 *
 * 实测(见 logs/m2-verify.log + ~/.claude/projects/<项目路径编码>/*.jsonl):
 * 编码 CLI 在 Edit 成功后要再发一次收尾请求,该请求对 代理上游
 * **无限挂起 4 分钟无响应** —— 代理日志在最后一次成功请求后再无新条目,CLI 也没有
 * 任何请求级超时,只能等 workflow 的 CODING_TIMEOUT_MS(600s)整段杀掉。
 * Claude Code CLI 支持 `API_TIMEOUT_MS`(单请求超时,毫秒);超时后 SDK 自动重试,
 * 把「上游偶发挂死」从致命变成可恢复。可用 `CODING_API_TIMEOUT_MS` 覆盖,设 `0` 关闭注入。
 */
function buildCodingEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  const override: Record<string, string | undefined> = {
    ANTHROPIC_BASE_URL: process.env.CODING_ANTHROPIC_BASE_URL,
    ANTHROPIC_API_KEY: process.env.CODING_ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN: process.env.CODING_ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_MODEL: process.env.CODING_ANTHROPIC_MODEL,
  };
  const apiTimeoutMs = process.env.CODING_API_TIMEOUT_MS ?? '180000';
  if (apiTimeoutMs !== '0') override.API_TIMEOUT_MS = apiTimeoutMs;
  for (const [key, value] of Object.entries(override)) {
    if (value) env[key] = value;
  }
  return env;
}

/**
 * 从环境读取「应当额外受保护的分支名」(通常是流水线的 base 分支)。
 *
 * 为什么不让 guard.ts 自己读 env:该模块刻意做成**纯函数**(不 IO、不读 env),
 * 因此可被 jest 直接单测,也是唯一可被信任的拦截点。env 读取留在本层。
 *
 * 支持逗号分隔多值;空白项剔除。取不到时返回空数组 —— guard.ts 会退回默认值
 * (`main`/`master`),即**最坏情况是退到原有保护范围,不会退到无保护**。
 *
 * ## M5:可选 `target`，取**并集**而不是替换
 *
 * 多仓库下每个 target 有自己的 `baseBranch`，红线必须跟着 target 走 ——
 * 否则「base 改成非 main」的仓库上，`git push origin HEAD:main` 之类的红线会**静默失效**
 * （M3 已踩过 base 改名导致红线失效）。
 *
 * ⚠️ 这里刻意**并入** `GITHUB_BASE_BRANCH` 而不是「有 target 就忽略 env」：
 * 保护范围只增不减，最坏情况是多保护一个分支（可见的失败），
 * 而不是少保护一个（静默的越权）。
 *
 * @param target 逻辑仓库标识；省略时行为与 M4 逐字一致
 */
export function resolveProtectedBranchNames(target?: RepoTarget): string[] {
  const names = (process.env.GITHUB_BASE_BRANCH ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (target?.baseBranch) names.push(target.baseBranch);
  return Array.from(new Set(names));
}

/**
 * 构造围栏用的 PreToolUse hook。
 *
 * 为什么必须走 hook 而不是 `canUseTool`:claude-agent-sdk 源码明确说明,
 * `bypassPermissions` 会在回调被咨询**之前**就自动放行所有工具调用,
 * 因此 `canUseTool` 在该模式下不会被调用;PreToolUse hook 是唯一可靠的拦截点。
 *
 * 失败策略:**fail-closed** —— hook 自身异常时一律拒绝。
 * 理由:误拒会让流水线明显报错(可观测),误放行则是静默绕过(不可观测)。
 *
 * @param protectedBranches 额外受保护的分支(实际 base 分支)。与 guard 内部默认值取并集。
 * @param runId M6-2：本 hook 由哪个 run 的 coding 步装配。用于让 `guard:deny` 归得到 run
 *   —— 红线生效的证据若归不到 run,多 run 交错时就无法回答「哪一次被拦了」。
 *   省略时落 `runId: null`（`trace:missing` 会把它暴露出来，不静默）。
 */
export function makeGuardHook(
  repoRoot: string,
  protectedBranches?: readonly string[],
  runId: string | null = null
): HookCallback {
  return async input => {
    const deny = (reason: string): SyncHookJSONOutput => ({
      // 新版判定字段(SDK 推荐)
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
      // 旧版字段同时给上,兼容不同 CLI 版本
      decision: 'block',
      reason,
      continue: true,
      systemMessage: `[permission-guard] 已拦截: ${reason}`,
    });

    try {
      const hookInput = input as { hook_event_name?: string; tool_name?: string; tool_input?: unknown };
      if (hookInput.hook_event_name !== 'PreToolUse') return {};

      const toolName = String(hookInput.tool_name ?? '');
      const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>;

      const verdict = guardToolCall(toolName, toolInput, repoRoot, protectedBranches);
      if (verdict.decision === 'deny') {
        // 埋点(M3-6):红线生效必须留下**可追溯**证据。
        // 只记工具名与原因摘要 —— 入参可能含凭据(`.env`、token),不进日志。
        // M6-1/M6-2:原先还多打一行 `console.warn`。那是**纯重复** ——
        // 事件本身就会镜像到终端（失败类事件走 stderr),再打一遍只会让日志双份。
        stage('guard:deny', {
          stage: 'coding',
          runId,
          tool: toolName,
          reason: verdict.reason.slice(0, 200),
        });
        return deny(verdict.reason);
      }
      return {};
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return deny(`围栏自身异常,fail-closed 拒绝本次调用: ${msg}`);
    }
  };
}

/**
 * 构建真正写文件的编码 agent。
 *
 * @param cwd 目标仓库绝对路径(checkout 步建分支所在仓库;自举即当前仓库根)。缺省取 git 仓库根。
 *
 * ## 权限三层(对应 `13-卡点` K7-B)
 *
 * - `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`:
 *   无人值守下全放行(含 Bash,保证 npm test/build/git 能跑,不因缺 TTY 卡死)。
 *   ⚠️ 此模式会让 `allowedTools` / `canUseTool` 失效(sdk 源码明确说明)——所以真正的
 *   安全边界不在这两层,而在下一层 hook。
 * - `allowedTools` 白名单 + `disallowedTools` 黑名单:断掉联网工具(防数据外泄)。
 *   注意:bypass 下 allowedTools 不具约束力,此名单主要供将来切回非 bypass 模式时生效,
 *   且作为**防御纵深**(若 SDK 版本行为变化仍能兜底)。
 * - **PreToolUse hook → `guard.ts`**:唯一可靠、且与 permissionMode 无关的硬拦截点。
 *   sdk 源码警告原文:"bypassPermissions auto-approves every tool call (except explicit
 *   deny rules) before the callback is consulted. To gate every tool call, use a
 *   PreToolUse hook." → 受保护路径 + 危险命令在此硬拦,见 `makeGuardHook`。
 * - `maxTurns` / `maxBudgetUsd`:无人值守的成本与失控上限。
 */
export async function getCodingAgent(
  cwd?: string,
  target?: RepoTarget,
  runId: string | null = null
): Promise<ClaudeSDKAgent> {
  // 执行期懒加载 @mastra/claude:其 ESM 依赖(@anthropic-ai/claude-agent-sdk/sdk.mjs)在 jest 等非 ESM
  // 运行时会被解析失败,故不能顶层静态 import,必须推迟到真正跑 coding 步时才加载。
  const { ClaudeSDKAgent: Agent } = await import('@mastra/claude');
  const repoRoot = cwd || getRepoRoot(target);
  return new Agent({
    id: 'coding-agent',
    name: 'Coding Agent',
    description: '使用 Claude Code CLI 在目标仓库真正读写文件,完成 issue 对应的编码',
    sdkOptions: {
      cwd: repoRoot,
      // 默认原样继承父进程环境,不覆盖 ANTHROPIC_* —— 让 Claude Code CLI 自行读取
      // `~/.claude/settings.json` 里配好的代理端点(本机为本地代理)。
      // 需要显式换后端时,设置 CODING_ANTHROPIC_BASE_URL / _API_KEY / _AUTH_TOKEN / _MODEL。
      // 细节与历史坑见 buildCodingEnv 的注释。
      env: buildCodingEnv(),
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      allowedTools: [
        'Read',
        'Edit',
        'Write',
        'Bash',
        'Glob',
        'Grep',
        'TodoWrite',
        'TaskCreate',
        'TaskUpdate',
        'TaskList',
      ],
      // 断网 + 禁子 agent:禁止联网工具(防数据外泄)、禁止派生子 agent(2026-09-07 实测
      // 编码模型会自派子 agent 做自我审查,嵌套会话把 CODING_TIMEOUT_MS 烧完;guard.ts
      // 的 DENY_TOOLS 是 bypass 模式下的可靠拦截层,此处为防御纵深)。
      disallowedTools: ['WebFetch', 'WebSearch', 'Task', 'Agent'],
      hooks: {
        // 不设 matcher:按 SDK 官方示例,默认对全部工具生效
        // 第二个参数传「实际 base 分支」:围栏的「禁直推 base」不能写死 main/master,
        // 否则 base 改名(如 M3 靶场用别的分支名)后这条红线会静默失效。详见 guard.ts。
        // guard.ts 内部会与默认值取并集,传参只增不减。
        PreToolUse: [{ hooks: [makeGuardHook(repoRoot, resolveProtectedBranchNames(target), runId)] }],
      },
      // 无人值守的成本与失控上限(可被 env 覆盖)
      maxTurns: Number(process.env.CODING_MAX_TURNS ?? 30),
      maxBudgetUsd: Number(process.env.CODING_MAX_BUDGET_USD ?? 2),
    },
  });
}
