import 'dotenv/config';
import { stage } from './progress';
import {
  resolveLlmProvider,
  inspectLlmConfig,
  describeProvider,
  PROVIDERS,
  type ResolvedLlmConfig,
  type LlmConfigIssue,
} from './llm/providers';

/**
 * LLM 接入配置 —— 全部走环境变量,支持任意 OpenAI 兼容服务商。
 *
 * ## 本文件只是「装配层」
 *
 * provider 的解析、默认值、契约校验全部在 `llm/providers.ts`（唯一真相源）；
 * 本文件只把它**解析一次并复用**，再暴露配置体检与摘要供启动自检使用。
 * 真正的请求参数（baseURL / apiKey / 模型名）由 `llm/chat.ts` 直接读 `resolvedLlm`——
 * 中间**不再有**一层「组装成某个 SDK 期望形状」的转换。
 *
 * ## 为什么是 OpenAI Chat Completions 形状
 *
 * - 大部分服务商与中转站只实现 **OpenAI Chat Completions** 协议 —— 这是覆盖面最广的一种。
 * - 请求形如 `POST {baseURL}/chat/completions`，baseURL / apiKey / 模型名全部显式可控。
 * - ⚠️ **编码步不走这条路**：编码由 Claude Code CLI 承担（`ANTHROPIC_BASE_URL` +
 *   `ANTHROPIC_AUTH_TOKEN`，见 `agents/coding-agent.ts`）。本文件的 `LLM_*` 只服务于
 *   test / review / commit 三个闸门的语义判定。
 *
 * ## 环境变量
 *
 * | 变量 | 说明 |
 * |---|---|
 * | `LLM_PROVIDER` | 服务商标识,内置 `relay` / `deepseek`;决定 baseURL 默认值。默认 `relay` |
 * | `LLM_MODEL` | 模型名。留空时取 provider 默认值(如 deepseek → `deepseek-flash`) |
 * | `LLM_BASE_URL` | base URL。留空时取 provider 默认值 |
 * | `LLM_API_KEY` | 密钥,**必填** |
 *
 * ## ⚠️ baseURL 与 `/v1`(2026-09-14 修正)
 *
 * 请求固定拼 `baseURL + "/chat/completions"`。**是否让 baseURL 带 `/v1` 取决于该服务商**,
 * 不能一条规则套所有:
 * - **DeepSeek 官方不带 `/v1`** —— 官方 curl 示例就是
 *   `curl https://api.deepseek.com/chat/completions`(api-docs.deepseek.com)。
 * - 多数中转站(one-api / new-api)端点挂在 `/v1` 下,要写到 `.../v1`。
 *
 * 该事实已固化进 `PROVIDERS` 注册表的默认值。早前版本用全局 `/v1` 正则校验,
 * 会把**符合官方文档的 DeepSeek 正确配置**误报为警告,已移除。
 *
 * ## 关于「加载时不抛错」
 *
 * 本模块在进程启动时被加载，而 `npm test` 也会 import 到它。若在此处对缺失配置抛错，
 * 会拖垮测试与启动。因此这里**只构建配置对象**,真正缺失配置只会在发起请求时
 * 由 `chat.ts` 暴露清晰的鉴权/连接错误。需要提前暴露配置问题时,
 * 调用 `inspectLlmConfig()` / `missingLlmConfig()` —— 启动自检就是这么做的。
 *
 * ## 怎么切换服务商
 *
 * ```bash
 * # DeepSeek 官方
 * LLM_PROVIDER=deepseek
 * LLM_API_KEY=sk-xxx
 * # baseURL / model 可省(用 provider 默认值: https://api.deepseek.com + deepseek-flash)
 *
 * # 任意中转站
 * LLM_PROVIDER=relay
 * LLM_BASE_URL=https://your-relay.example.com/v1
 * LLM_MODEL=glm-5.2
 * LLM_API_KEY=xxx
 * ```
 */

/** 解析一次并复用(模块级单例;env 在进程启动后不变)。 */
export const resolvedLlm: ResolvedLlmConfig = resolveLlmProvider();

/**
 * 返回缺失的必填项;空数组表示四项齐全。
 * 仅收集 **error 级** 问题(缺失 / 未知 provider),不含 warn —— 保持原调用方语义不变。
 */
export function missingLlmConfig(): string[] {
  return inspectLlmConfig(resolvedLlm)
    .filter(i => i.level === 'error')
    .map(i => `${i.field}: ${i.message}`);
}

/** 完整配置体检(含 warn 级),供启动自检 / 诊断脚本使用。 */
export function checkLlmConfig(): LlmConfigIssue[] {
  return inspectLlmConfig(resolvedLlm);
}

/**
 * 打印一行配置摘要供日志使用(**不含密钥**)。
 * 在服务启动时调用一次,即可在日志里看到本次实际生效的 provider / model / baseURL。
 *
 * ## M6-1（2026-09-17）：收编裸 `console.*`
 *
 * 原实现直接 `console.log` / `console.error` —— 终端一关，「这次到底连的是哪个端点、
 * 哪几项配置缺了」就**无法从任何持久化文件里复原**。而它恰恰是排障时第一个要看的东西
 * （历史事故：中继 403 时无从判断是映射错还是 key 失效）。
 *
 * 现在统一走结构化事件 `config:check`（`stage: 'startup'`、`runId: null` ——
 * 启动期不属于任何 run，这是规范允许 `null` 的三种阶段之一）。
 */
export function logLlmConfig(prefix = '[llm]'): void {
  const issues = checkLlmConfig();
  const hasError = issues.some(x => x.level === 'error');
  stage('config:check', {
    stage: 'startup',
    runId: null,
    level: hasError ? 'error' : 'info',
    prefix,
    summary: describeProvider(resolvedLlm),
  });
  for (const i of issues) {
    stage('config:check', {
      stage: 'startup',
      runId: null,
      level: i.level,
      prefix,
      field: i.field,
      message: i.message,
    });
  }
}

/** 暴露解析后的原始值(便于日志/调试;apiKey 切勿打印到不安全的地方)。 */
export const llmEnv = {
  provider: resolvedLlm.provider,
  modelId: resolvedLlm.modelId,
  baseURL: resolvedLlm.baseURL,
  apiKey: resolvedLlm.apiKey,
};

export { PROVIDERS };
export type { ResolvedLlmConfig, LlmConfigIssue };
