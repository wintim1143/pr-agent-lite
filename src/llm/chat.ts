/**
 * 闸门 LLM 的直连客户端（零框架）。
 *
 * ## 职责边界
 *
 * 只服务一件事：test / review / commit 三个**语义闸门**的判定调用。
 * **编码步不走这里** —— 编码由 Claude Code CLI 承担（见 `agents/claude-cli.ts`）。
 * 两条通道的凭据、端点、模型都可以不同，不得互相假定。
 *
 * ## 为什么是 OpenAI Chat Completions 形状
 *
 * 覆盖面最广：官方 API 与各类中转站都实现它。请求形如
 * `POST {baseURL}/chat/completions`，baseURL / apiKey / 模型名全部显式可控
 * （baseURL 是否带 `/v1` 由 `providers.ts` 的注册表按各服务商官方文档给出）。
 *
 * ## 三条不可退让的约束
 *
 * 1. **不做「取不到就当 0」** —— 响应里没有 `usage` 就返回 `undefined`，
 *    上游 `normalizeUsage()` 会落 `null`。把「没回传」写成 0 会让成本报表变假
 *    （与 `testsPassed = null ≠ true` 同构）。
 * 2. **不静默换模型** —— HTTP 非 2xx、响应缺 `choices[0].message.content`
 *    一律抛错，不降级、不返回空串。闸门宁可不通过，不能假通过。
 * 3. **实际生效的端点与模型必须可见** —— 见 `describeActiveLlm()`；启动自检
 *    **无条件**落一次（端点不通也落），这是「看着在跑但模型不对」唯一的低成本防线。
 *
 * ## ⚠️ 回包 model 与请求 model 不一致时要显式告警
 *
 * 部分服务商对**未知模型名静默回落**到默认模型（本项目已实测过一次）：
 * 请求成功、HTTP 200，但实际跑的不是你要的模型。因此每次响应都比对
 * `data.model` 与请求的 `modelId`，不一致就落一条 `config:check`（warn 级）。
 * 只在日志里记，不抛错 —— 回包 model 缺失或不带版本后缀都属正常，据此阻断会误伤。
 */
import type { GateAgent, StepHost } from '../runner.js';
import { resolvedLlm } from '../config.js';
import { stage } from '../progress.js';

/** 一次 chat 调用的结果。`usage` 缺失即 `undefined`，**不是 0**。 */
export interface ChatResult {
  text: string;
  usage?: unknown;
}

/**
 * OpenAI 兼容响应的 `usage` 整形。
 *
 * 输出 camelCase 三字段，供 `log-store.normalizeUsage()` 读取
 * （它认 `inputTokens` / `outputTokens` / `totalTokens`）。
 * 原始 `usage` 缺席时返回 `undefined` —— 不做任何编造。
 */
function shapeUsage(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const pick = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  // DeepSeek / OpenAI 官方用 prompt_tokens / completion_tokens；
  // 少数中转站沿用 AI SDK v5 风格的 inputTokens / outputTokens。
  const inputTokens = pick(u.prompt_tokens ?? u.promptTokens ?? u.inputTokens);
  const outputTokens = pick(u.completion_tokens ?? u.completionTokens ?? u.outputTokens);
  const totalTokens = pick(u.total_tokens ?? u.totalTokens);

  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return { inputTokens, outputTokens, totalTokens };
}

/** 从非 2xx 响应体里尽量挖出可读原因（各家错误形状不一）。 */
function describeErrorBody(body: string): string {
  const t = body.trim();
  if (!t) return '(空响应体)';
  try {
    const j = JSON.parse(t) as { error?: { message?: string } | string; message?: string };
    const e = j.error;
    if (typeof e === 'string') return e;
    if (e && typeof e.message === 'string') return e.message;
    if (typeof j.message === 'string') return j.message;
  } catch {
    /* 不是 JSON，退回原文 */
  }
  return t.slice(0, 300);
}

/** 回包 model 与请求 model 不一致时落一条告警（不抛错）。 */
function warnOnModelMismatch(requested: string, responded: unknown): void {
  if (typeof responded !== 'string' || !responded || responded === requested) return;
  stage('config:check', {
    stage: 'startup',
    runId: null,
    level: 'warn',
    field: 'LLM_MODEL',
    message:
      `闸门回包里的 model 是 "${responded}"，与请求的 "${requested}" 不一致。` +
      `该服务商可能对未知模型名**静默回落**到了别的模型 —— 请求成功不等于跑的是你要的模型。`,
  });
}

/**
 * 发起一次 chat 调用。
 *
 * @param prompt 完整提示词（含输出契约段）
 * @param label  调用来源标签，只进日志，用于区分 test / review / commit 三处
 */
export async function chat(prompt: string, label = 'gate'): Promise<ChatResult> {
  const { baseURL, apiKey, modelId } = resolvedLlm;
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 120_000);

  // 缺失配置在这里显式失败，而不是拼出一个必然 404 的 URL。
  if (!baseURL) throw new Error('LLM_BASE_URL 未设置：无法发起闸门调用（见 providers.ts 的 provider 注册表）');
  if (!modelId) throw new Error('LLM_MODEL 未设置：无法发起闸门调用');
  if (!apiKey) throw new Error('LLM_API_KEY 未设置：无法发起闸门调用');

  const url = `${baseURL}/chat/completions`;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        // 闸门要的是可解析的 JSON，不是创意。温度钉死可减少格式抖动。
        temperature: 0,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `LLM_HTTP_${res.status}: ${describeErrorBody(body)}（POST ${url}，model=${modelId}）`
      );
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: unknown;
      model?: string;
    };

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error(
        `LLM_EMPTY_RESPONSE: 响应里没有 choices[0].message.content` +
          `（POST ${url}，model=${modelId}，label=${label}，耗时 ${Date.now() - started}ms）`
      );
    }

    warnOnModelMismatch(modelId, data.model);
    return { text: content, usage: shapeUsage(data.usage) };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(`LLM_TIMEOUT: 超过 ${timeoutMs}ms 未返回（POST ${url}，model=${modelId}）`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 闸门 LLM 宿主 —— 步骤通过它拿到 `dev-agent`。
 *
 * `getAgent()` 是同步的（步骤里直接调用），因此这里不做任何网络动作；
 * 真正的调用发生在 `generate()`。
 */
export const gateHost: StepHost = {
  getAgent(name: string): GateAgent {
    return {
      generate: (prompt: string) => chat(prompt, name),
    };
  },
};

/**
 * 本次实际生效的 LLM 目标（一行，不含密钥）。
 *
 * ⚠️ 启动自检必须**无条件**调用它并落日志 —— **即使端点不通**。
 * 端点通不通是运行期事实，而「连的是哪个端点、哪个模型」是配置期事实，
 * 后者不能因为前者失败就无从得知。
 */
export function describeActiveLlm(): string {
  return (
    `${resolvedLlm.providerLabel}(${resolvedLlm.provider}) | ` +
    `model=${resolvedLlm.modelId || '(未设)'} | ` +
    `baseURL=${resolvedLlm.baseURL || '(未设)'} | ` +
    `apiKey=${resolvedLlm.apiKey ? '已设置' : '(未设)'}`
  );
}
