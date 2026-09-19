/**
 * Claude Code CLI 的最小封装（零框架）。
 *
 * ## 为什么需要这一层
 *
 * 官方 SDK 暴露的是 `query({ prompt, options })` → `AsyncIterable<SDKMessage>`，
 * 即一条**消息流**。而编排侧要的是一个动作：「送一段提示词，拿回一段文本 + token 用量」。
 * 两者之间的翻译 —— 遍历消息流、取最后一条 `result`、判成败、透传 usage ——
 * 就是本模块的全部内容。
 *
 * ## 三个刻意的选择
 *
 * 1. **不吞错误**：非 `success` 子类型一律抛错，不返回空文本。
 *    编码失败必须显式 —— 否则 test / review / commit 会基于「空改动」继续跑完，
 *    表面上全绿，实际上什么都没做（这是本项目最贵的一类假绿）。
 * 2. **不编造 usage**：`result` 消息里没有 usage 就返回 `undefined`，上游落 `null`。
 *    `null` 是**设计内正确值**（「没回传」与「真的花了 0 token」是两件事）。
 * 3. **usage 原样透传，不改字段名**：收敛成 V3 形状是 `log-store.toV3Usage()` 的职责，
 *    它同时认 snake_case 与 camelCase。放在本层猜字段名，一旦猜错就会退化成
 *    一个**静默的空 usage**（成本报表永远显示「无量」而不报错）。
 */
import { query, type Options, type SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';

/** agent 配置。字段与「一个具名 agent」的语义对齐，便于日志里区分。 */
export interface ClaudeCliConfig {
  id: string;
  name?: string;
  description?: string;
  /** 直接透传给官方 SDK 的选项（cwd / env / 权限 / 工具白黑名单 / hooks / 上限）。 */
  sdkOptions: Options;
}

export interface ClaudeCliResult {
  text: string;
  /** 原始 usage（SDK `result` 消息的 `usage`，**仅主循环**）。缺失即 `undefined`。 */
  usage?: unknown;
  /** 全部 model 的合计用量（`modelUsage`），供成本报表交叉核对。 */
  totalUsage?: unknown;
  numTurns: number;
  durationMs: number;
  costUsd: number;
}

export class ClaudeCliAgent {
  constructor(readonly config: ClaudeCliConfig) {}

  /**
   * 送一段提示词，等 CLI 跑完，返回收尾文本。
   *
   * ⚠️ 本方法**不做超时**：编码步可能合法地跑十几分钟，超时预算属于编排层
   * （见 `dev-workflow.ts` 的 `withCodingGuard`），由它对整个子进程统一收口。
   */
  async generate(messages: Array<{ role: string; content: string }>): Promise<ClaudeCliResult> {
    const prompt = messages.map(m => m.content).join('\n\n');
    if (!prompt.trim()) throw new Error('ClaudeCliAgent.generate: 提示词为空');

    const started = Date.now();
    let last: SDKResultMessage | undefined;
    for await (const msg of query({ prompt, options: this.config.sdkOptions })) {
      if (msg.type === 'result') last = msg;
    }

    if (!last) {
      throw new Error('CODING_NO_RESULT: CLI 未返回 result 消息（子进程可能被提前终止）');
    }
    if (last.subtype !== 'success') {
      // 错误子类型的形状与 success 不同，这里只取可读的那部分，不做结构性假设。
      const detail = (last as unknown as { errors?: unknown }).errors;
      const why = Array.isArray(detail) ? detail.join('; ') : String(detail ?? '(无详情)');
      throw new Error(`CODING_FAILED(${last.subtype}): ${why.slice(0, 500)}`);
    }

    return {
      text: last.result,
      usage: last.usage,
      totalUsage: last.modelUsage,
      numTurns: last.num_turns,
      durationMs: Date.now() - started,
      costUsd: last.total_cost_usd,
    };
  }
}
