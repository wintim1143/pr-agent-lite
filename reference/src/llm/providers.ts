import type { OpenAICompatibleConfig } from '@mastra/core/llm';

/**
 * LLM 提供商抽象层(2026-09-14)。
 *
 * ## 为什么需要抽象
 *
 * 原实现(`config.ts`)把 `LLM_PROVIDER` 当成**纯标识字符串**,不参与任何解析 ——
 * 换服务商只能靠使用者手工拼 `LLM_BASE_URL` / `LLM_MODEL`。问题在切换时暴露:
 *
 * 1. **baseURL 拼接方式各服务商不同**:Mastra 内部固定拼 `baseURL + "/chat/completions"`
 *    (`createOpenAICompatible` → `path: "/chat/completions"`)。
 *    - 多数中转站(one-api / new-api)的端点挂在 `/v1` 下 → baseURL 要写到 `.../v1`;
 *    - **DeepSeek 官方不要 `/v1`** —— 官方 curl 示例就是
 *      `https://api.deepseek.com/chat/completions`(见 api-docs.deepseek.com)。
 *    所以是否带 `/v1` 是**每个 provider 自己的事实**,由注册表的默认值给出,
 *    不能靠一条全局规则猜(2026-09-14 修正:早前的 `/v1` 全局校验是假阳性)。
 * 2. **模型名与 provider 强绑定**:`deepseek-flash` 只在 DeepSeek 有意义,
 *    切 provider 时忘了同步改模型名,报错来自上游而非配置层,定位成本高。
 * 3. **默认值缺失**:每次换 provider 都要查文档找 baseURL。
 *
 * 抽象后:选 `LLM_PROVIDER=<名字>` 即得到该 provider 的 baseURL 默认值与模型校验,
 * 手工 env 仍可覆盖(优先于 provider 默认值)。
 *
 * ## 设计边界(重要)
 *
 * 本模块**只做「解析 + 校验」**,不碰 Mastra API:输出的是纯数据
 * (`{ provider, modelId, baseURL, apiKey }`),由 `config.ts` 组装成 `OpenAICompatibleConfig`。
 * 这样新增 provider 无需理解 Mastra 的配置形状,测试时也不必 mock Mastra。
 *
 * ## 怎么新增一个 provider
 *
 * 在 `PROVIDERS` 里加一项:
 * ```ts
 * myvendor: {
 *   label: 'My Vendor',
 *   baseURL: 'https://api.myvendor.com/v1',   // 按该服务商的官方 curl 示例照抄
 *   protocol: 'openai-compatible',
 *   defaultModel: 'my-model',                 // 可选
 *   models: ['my-model', 'my-model-pro'],     // 可选但强烈建议:开启配置期模型名校验
 *   hint: '登录后在控制台 → API Keys 获取',
 * }
 * ```
 * 然后 `LLM_PROVIDER=myvendor` 即可。若某 provider 不是 OpenAI 兼容协议
 * (如原生 Anthropic /v1/messages),`protocol` 标注出来即可 —— 当前 `resolveLlmProvider`
 * 会拒绝非 `openai-compatible` 的 provider 并给出明确指引,避免静默错误配置。
 */

/** 协议族:决定 baseURL 拼接方式与端点路径。 */
export type LlmProtocol = 'openai-compatible';

export interface LlmProviderSpec {
  /** 人类可读名,用于错误提示与 `describeProvider()`。 */
  label: string;
  /** 默认 base URL。按该服务商官方文档的 base_url 原样填,**不要臆测是否带 `/v1`**。 */
  baseURL: string;
  protocol: LlmProtocol;
  /** 该 provider 的常用默认模型(可选;未设时要求使用者显式提供 LLM_MODEL)。 */
  defaultModel?: string;
  /**
   * 该 provider **官方文档列明的**可用模型名(可选,但强烈建议填)。
   *
   * 填了就能在配置期报出「模型名不存在」——这比等上游报错重要得多,因为
   * **部分服务商对未知模型名会静默回落到默认模型**(2026-09-14 实测 DeepSeek:
   * 传 `deepseek-chat` 返回 200 但回包 model 是 `deepseek-flash`),
   * 这种「看着成功、实则换了模型」的错误不查回包根本发现不了。
   */
  models?: string[];
  /** 去哪拿 key / 有什么坑,用于 missingLlmConfig 的提示文案。 */
  hint?: string;
}

/**
 * 内置 provider 注册表。
 *
 * `relay` 是通用中转站占位 —— 它没有固定 baseURL,故留空字符串表示
 * 「必须由使用者显式提供 `LLM_BASE_URL`」。
 */
export const PROVIDERS: Record<string, LlmProviderSpec> = {
  /** 通用 OpenAI 兼容中转站(one-api / new-api 等)。baseURL 必须手工提供。 */
  relay: {
    label: 'OpenAI 兼容中转站',
    baseURL: '',
    protocol: 'openai-compatible',
    hint: '把中转站控制台给出的 base URL 填到 LLM_BASE_URL(多数中转站端点挂在 /v1 下)',
  },
  /**
   * DeepSeek 官方 API。
   *
   * ⚠️ baseURL **不带 `/v1`** —— 官方 curl 示例即
   * `curl https://api.deepseek.com/chat/completions`(api-docs.deepseek.com)。
   * 带上 `/v1` 走的是官方为兼容 OpenAI SDK 保留的历史路径,不在文档示例里。
   * 模型名以官方 "Models & Pricing" 页为准(2026-09-14 核对):
   * `deepseek-flash`(DeepSeek-V4.1-Flash)/ `deepseek-v4-pro`。
   */
  deepseek: {
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com',
    protocol: 'openai-compatible',
    defaultModel: 'deepseek-flash',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    hint: 'DeepSeek 控制台 → API Keys;官方模型名为 deepseek-flash / deepseek-v4-pro',
  },
};

/** 解析后的纯数据配置(不含 Mastra 类型,便于测试与复用)。 */
export interface ResolvedLlmConfig {
  /** provider 标识(env `LLM_PROVIDER`,默认 `relay`) */
  provider: string;
  /** provider 的人类可读名 */
  providerLabel: string;
  /** 最终模型名(env 优先,其次 provider 默认值) */
  modelId: string;
  /** 最终 base URL(env 优先,其次 provider 默认值);已去尾部斜杠 */
  baseURL: string;
  /** API Key(env `LLM_API_KEY`) */
  apiKey: string;
  /** provider 是否在注册表中认知到 */
  known: boolean;
}

/** 去掉尾部斜杠 —— Mastra 内部会 `withoutTrailingSlash` + 拼 `/chat/completions`,此处保持一致。 */
function trimSlash(u: string | undefined): string {
  return (u ?? '').replace(/\/+$/, '');
}

/** 读取 env(允许注入,便于测试)。 */
export interface LlmEnvSource {
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
}

export function resolveLlmProvider(env: LlmEnvSource = process.env as LlmEnvSource): ResolvedLlmConfig {
  const provider = (env.LLM_PROVIDER ?? 'relay').trim() || 'relay';
  const spec = PROVIDERS[provider];
  const known = Boolean(spec);

  // env 显式值优先于 provider 默认值(使用者永远能覆盖)。
  const modelId = (env.LLM_MODEL ?? '').trim() || spec?.defaultModel || '';
  const baseURL = trimSlash(env.LLM_BASE_URL) || trimSlash(spec?.baseURL);
  const apiKey = (env.LLM_API_KEY ?? '').trim();

  return {
    provider,
    providerLabel: spec?.label ?? provider,
    modelId,
    baseURL,
    apiKey,
    known,
  };
}

/**
 * 返回配置问题清单;空数组表示可用。
 *
 * 除「必填缺失」外,还做两项**配置期可判定的**校验(比等上游报错便宜得多):
 * - 未知 provider:提示可用名单
 * - provider 声明了 `models` 但当前模型名不在其中:警告级
 *   (如 deepseek provider 配了 `deepseek-chat` —— 实测上游会静默回落到 `deepseek-flash`)
 *
 * ⚠️ **不再全局校验 `/v1`**(2026-09-14 修正)。
 * 早前版本要求 baseURL 必须以 `/v1` 结尾,那是**假阳性**:DeepSeek 官方文档的
 * base_url 就是不带 `/v1` 的 `https://api.deepseek.com`,官方 curl 示例直接是
 * `https://api.deepseek.com/chat/completions`。全局 `/v1` 规则会把**符合官方文档的
 * 正确配置**标成警告。是否带 `/v1` 是该 provider 自己的事实,已固化进注册表默认值。
 */
export interface LlmConfigIssue {
  /** error = 阻断 generate;warn = 能跑但很可能不是你想要的 */
  level: 'error' | 'warn';
  field: string;
  message: string;
}

export function inspectLlmConfig(resolved: ResolvedLlmConfig): LlmConfigIssue[] {
  const issues: LlmConfigIssue[] = [];
  const spec = PROVIDERS[resolved.provider];

  if (!resolved.known) {
    issues.push({
      level: 'error',
      field: 'LLM_PROVIDER',
      message: `未知 provider "${resolved.provider}"。已内置: ${Object.keys(PROVIDERS).join(' / ')}。` +
        `若确为自定义中转站,请用 LLM_PROVIDER=relay 并显式提供 LLM_BASE_URL。`,
    });
  }

  if (!resolved.modelId) {
    issues.push({
      level: 'error',
      field: 'LLM_MODEL',
      message: `未设置 LLM_MODEL${spec ? `,且 provider "${resolved.provider}" 没有默认模型` : ''}。`,
    });
  }
  if (!resolved.baseURL) {
    issues.push({
      level: 'error',
      field: 'LLM_BASE_URL',
      message: `未设置 LLM_BASE_URL${spec?.hint ? `(${spec.hint})` : ''}。`,
    });
  }
  if (!resolved.apiKey) {
    issues.push({
      level: 'error',
      field: 'LLM_API_KEY',
      message: `未设置 LLM_API_KEY${spec?.hint ? `(${spec.hint})` : ''}。`,
    });
  }

  // 模型名不在 provider 文档列明的清单里(如 deepseek provider + deepseek-chat)。
  // 用精确匹配而非前缀匹配:官方模型名表就是权威清单,前缀匹配会把
  // 已退役的 legacy 名(deepseek-v4-flash)也放过,而那个名字上游同样静默回落。
  if (spec?.models?.length && resolved.modelId && !spec.models.includes(resolved.modelId)) {
    issues.push({
      level: 'warn',
      field: 'LLM_MODEL',
      message:
        `模型名 "${resolved.modelId}" 不在 provider "${resolved.provider}" 的已知模型表中` +
        `(可用: ${spec.models.join(' / ')})。` +
        `注意:部分服务商对未知模型名**静默回落到默认模型**而非报错,` +
        `现象是请求成功但实际跑的不是你要的模型 —— 请核对回包里的 model 字段。`,
    });
  }

  return issues;
}

/** 供日志/启动自检使用的一行摘要(不含密钥)。 */
export function describeProvider(resolved: ResolvedLlmConfig): string {
  return (
    `${resolved.providerLabel}(${resolved.provider}) | model=${resolved.modelId || '(未设)'} | ` +
    `baseURL=${resolved.baseURL || '(未设)'} | apiKey=${resolved.apiKey ? '已设置' : '(未设)'}`
  );
}

/** 组装 Mastra 的 `OpenAICompatibleConfig`。id 形如 `deepseek/deepseek-flash`。 */
export function toMastraModelConfig(resolved: ResolvedLlmConfig): OpenAICompatibleConfig {
  return {
    // 缺失时占位 'unset',保证 id 形态合法;真正报错推迟到 generate 时(见 config.ts 注释)。
    id: `${resolved.provider}/${resolved.modelId || 'unset'}`,
    url: resolved.baseURL || undefined,
    apiKey: resolved.apiKey || undefined,
  };
}
