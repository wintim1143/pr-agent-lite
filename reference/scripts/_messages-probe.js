/**
 * M2 前置探针(第二层):直接在 HTTP 层验证 中转站 的 **Anthropic Messages 端点** 是否支持 tool_use。
 *
 * 为什么要这一层:
 * 第一层探针(scripts/_coding-probe.js)走 Claude Code CLI 子进程,240s 超时且伴随沙箱报
 * "reg.exe 被 Program Blacklist 拦截" —— 故障可能是「CLI 起不来」,也可能是「中转站不支持 tool_use」。
 * 本脚本绕开 CLI,只打 HTTP,把两种故障分开。
 *
 * 判据:
 * - HTTP 200 + 返回体里有 content block 的 type === 'tool_use' → 中转站支持 tool_use,M2 的阻塞在 CLI/沙箱侧。
 * - HTTP 200 但只有 text → 模型不会调工具,M2 必须换后端。
 * - 非 200 / 超时 → 端点本身不可用。
 *
 * 运行: node scripts/_messages-probe.js
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

const url = `${base}/messages`;
console.log('目标端点 =', url);
console.log('模型     =', model);

const body = {
  model,
  max_tokens: 512,
  tools: [
    {
      name: 'Read',
      description: 'Read a file from the filesystem.',
      input_schema: {
        type: 'object',
        properties: { file_path: { type: 'string', description: 'The absolute path to the file to read' } },
        required: ['file_path'],
      },
    },
  ],
  messages: [
    {
      role: 'user',
      content: '这是一个连通性测试。请调用 Read 工具读取 /tmp/hello.txt,不要只回文字。',
    },
  ],
};

/** 发起一次 /v1/messages 请求,返回 { ok, status, ms, raw, json } */
async function call(payload, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let json = null;
    try { json = JSON.parse(raw); } catch {}
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, raw, json };
  } catch (e) {
    return {
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

(async () => {
  // --- 步骤 1:对照请求(不带 tools),确认端点本身是否可用 ---
  const plain = {
    model,
    max_tokens: 64,
    messages: [{ role: 'user', content: '只回复两个字:收到' }],
  };
  console.log('\n--- 步骤 1:不带 tools 的对照请求 ---');
  const r1 = await call(plain, 60_000);
  console.log('结果 =', r1.status, `(${r1.ms}ms)`);
  if (r1.json) console.log('content =', String(JSON.stringify(r1.json.content) ?? '(无 content 字段)').slice(0, 300));
  else console.log('响应(截断 400) =', String(r1.raw).slice(0, 400));

  if (!r1.ok) {
    console.log('\n❌ 端点本身不可用(连纯文本对话都失败)。');
    console.log('   → 结论:中转站 的 Anthropic Messages 端点(/v1/messages)整体不通,');
    console.log('     与 tools 无关。M2 不能用它驱动 Claude Code CLI。');
    process.exit(1);
  }
  console.log('✓ 端点可用(纯文本对话 OK)');

  // --- 步骤 2:带 tools 的请求 ---
  console.log('\n--- 步骤 2:带 tools 的请求 ---');
  const r2 = await call(body, 90_000);
  console.log('结果 =', r2.status, `(${r2.ms}ms)`);

  if (!r2.ok || !r2.json) {
    console.log('响应(截断 800) =', String(r2.raw).slice(0, 800));
    console.log('\n⚠️ 带 tools 的请求失败,但纯文本请求成功。');
    console.log('   → 结论:该端点/模型【不支持 tool_use】。Claude Code CLI 依赖 tool_use,故 M2 编码路径不可用。');
    process.exit(1);
  }

  const blocks = r2.json.content ?? [];
  console.log('stop_reason =', r2.json.stop_reason);
  console.log('content blocks =', JSON.stringify(blocks).slice(0, 900));

  const hasToolUse = blocks.some(b => b && b.type === 'tool_use');
  console.log('\n=== 判定 ===');
  if (hasToolUse) {
    console.log('✅ 中转站【支持 tool_use】:返回了 tool_use content block。');
    console.log('   → M2 的阻塞不在中转站,而在 Claude Code CLI 子进程(沙箱 reg.exe 拦截)。');
  } else {
    console.log('⚠️ 中转站【未发起 tool_use】:只回了文本/其他 block。');
    console.log('   → 该模型在该端点上不会调工具,M2 编码路径不可用,需换模型或换后端。');
  }
  process.exit(hasToolUse ? 0 : 2);
})();
