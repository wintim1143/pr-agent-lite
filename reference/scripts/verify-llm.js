'use strict';
/*
 * LLM 配置验证脚本(结构 + 可用)。
 * - 结构校验:resolveModelConfig 能否把 env 驱动的 OpenAICompatibleConfig 解析成合法模型实例
 *   (证明中转站 wiring 正确,不依赖真实 key,随时可跑)。
 * - 真实 ping:三项(env)齐全时,用 dev-agent 向中转站发一条最小请求,验证 key/URL/model 真能用。
 *
 * 用法:
 *   node scripts/verify-llm.js            # 结构校验(无需 key)
 *   cp .env.example .env && 填好三项 && node scripts/verify-llm.js   # 含真实 ping
 */
require('dotenv/config');

async function main() {
  const { llmModelConfig, missingLlmConfig, llmEnv } = require('../dist/config.js');
  const { resolveModelConfig } = require('@mastra/core/llm');

  console.log('=== 解析后的配置(密钥已脱敏) ===');
  console.log({
    id: llmModelConfig.id,
    url: llmModelConfig.url || '(空)',
    apiKey: llmModelConfig.apiKey ? `${llmModelConfig.apiKey.slice(0, 4)}***(已隐藏)` : '(空)',
    provider: llmEnv.provider,
    modelId: llmEnv.modelId || '(空)',
  });

  console.log('\n=== 结构校验:resolveModelConfig ===');
  const resolved = await resolveModelConfig(llmModelConfig);
  console.log('resolved instance type :', resolved?.constructor?.name);
  console.log('has doGenerate         :', typeof resolved?.doGenerate === 'function');
  console.log('has doStream           :', typeof resolved?.doStream === 'function');
  if (typeof resolved?.doGenerate !== 'function') {
    console.error('[FAIL] 未解析出合法 LanguageModel 实例,OpenAICompatibleConfig wiring 有误。');
    process.exitCode = 1;
    return;
  }
  console.log('[OK] OpenAICompatibleConfig 已正确解析为 Chat Completions 兼容模型实例。');

  const missing = missingLlmConfig();
  if (missing.length) {
    console.log(`\n[跳过真实 ping] 缺失环境变量: ${missing.join(', ')}`);
    console.log('请 `cp .env.example .env` 并填好这三项,再重跑本脚本做真实调用验证。');
    return;
  }

  console.log('\n=== 真实 ping:用 dev-agent 向中转站发一条最小请求 ===');
  const { devAgent } = require('../dist/agents/dev-agent.js');
  try {
    const res = await devAgent.generate([{ role: 'user', content: 'Reply with the single word: pong' }]);
    const text = typeof res?.text === 'string' ? res.text : JSON.stringify(res).slice(0, 200);
    console.log('[OK] ping 成功,模型回复:', text.slice(0, 200));
  } catch (err) {
    console.error('[FAIL] ping 失败:', err?.message || err);
    process.exitCode = 2;
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
