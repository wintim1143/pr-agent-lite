/**
 * M2 备选路径探针:摸清 中转站 中转站到底支持哪些协议端点 + 是否支持工具调用。
 *
 * 为什么需要:选编码执行体时,可行性完全取决于中转站支持什么。
 *   - /responses 可用  → OpenAI Agents SDK有可能直接跑
 *   - /chat/completions 支持 tools → 自造原生 agent 工具链可行
 *   - /v1/messages 可用 → 官方 Claude Agent SDK 可行(已实测 502,不可用)
 *
 * 三项各自独立探测,超时/报错都记为「不可用」,不中断其余项。
 *
 * 运行: node scripts/_relay-protocol-probe.js
 */
'use strict';
require('dotenv').config();

const base = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
const key = process.env.LLM_API_KEY || '';
const model = process.env.LLM_MODEL || 'glm-5.2';

if (!base || !key) {
  console.error('✗ 缺少 LLM_BASE_URL / LLM_API_KEY');
  process.exit(1);
}
console.log('中转站 =', base, '| 模型 =', model, '\n');

async function probe(label, url, payload, headers, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    const ms = Date.now() - t0;
    let json = null;
    try { json = JSON.parse(raw); } catch {}
    return { label, ok: res.ok, status: res.status, ms, raw, json };
  } catch (e) {
    return {
      label,
      ok: false,
      status: e?.name === 'AbortError' ? 'TIMEOUT' : 'ERROR',
      ms: Date.now() - t0,
      raw: e?.message || String(e),
      json: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function show(r, extra) {
  console.log(`--- ${r.label} ---`);
  console.log('  结果 =', r.status, `(${r.ms}ms)`);
  if (r.json) console.log('  响应(截断 400) =', JSON.stringify(r.json).slice(0, 400));
  else console.log('  响应(截断 300) =', String(r.raw).slice(0, 300));
  if (extra) console.log('  判定 =', extra(r));
  console.log('');
}

const TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file from disk.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
};

(async () => {
  // 1) OpenAI 协议 /chat/completions —— 纯文本(已知可用,作基线)
  const r1 = await probe(
    '① /chat/completions 纯文本(基线)',
    `${base}/chat/completions`,
    { model, messages: [{ role: 'user', content: '只回复两个字:收到' }], max_tokens: 32 },
    { authorization: `Bearer ${key}` },
    60_000
  );
  show(r1, r => (r.ok ? '✅ 可用(M1 已验证的协议)' : '❌ 不可用'));

  // 2) OpenAI 协议 /chat/completions —— 带 tools,看会不会发起 function_call
  const r2 = await probe(
    '② /chat/completions 带 tools(function calling)',
    `${base}/chat/completions`,
    {
      model,
      messages: [{ role: 'user', content: '请调用 read_file 工具读取 /tmp/hello.txt,不要只回文字。' }],
      tools: [TOOL],
      tool_choice: 'auto',
      max_tokens: 256,
    },
    { authorization: `Bearer ${key}` },
    90_000
  );
  show(r2, r => {
    if (!r.ok) return '❌ 带 tools 请求失败 → 自造工具链路径不通';
    const msg = r.json?.choices?.[0]?.message;
    const calls = msg?.tool_calls;
    if (calls && calls.length) return `✅ 支持 function calling(发起了 ${calls.length} 个 tool_call)→ 自造工具链可行`;
    return '⚠️ 200 但没发起 tool_call(只回文本)→ 自造工具链不可靠';
  });

  // 3) OpenAI Responses API /responses
  const r3 = await probe(
    '③ /responses(OpenAI Responses API)',
    `${base}/responses`,
    { model, input: '只回复两个字:收到', max_output_tokens: 32 },
    { authorization: `Bearer ${key}` },
    60_000
  );
  show(r3, r => (r.ok ? '✅ /responses 可用 → OpenAI Agents SDK 有戏' : '❌ /responses 不可用 → OpenAI Agents SDK 大概率跑不通'));

  console.log('=== 汇总 ===');
  const verdict = [
    `① /chat/completions 纯文本 : ${r1.ok ? '可用' : '不可用'}`,
    `② /chat/completions + tools: ${r2.ok ? (r2.json?.choices?.[0]?.message?.tool_calls?.length ? '支持 function calling' : '200 但无 tool_call') : '不可用'}`,
    `③ /responses              : ${r3.ok ? '可用' : '不可用'}`,
    `④ /v1/messages(Anthropic) : 不可用(已实测 502,见 _messages-probe.js)`,
  ];
  verdict.forEach(v => console.log('  ' + v));
})();
