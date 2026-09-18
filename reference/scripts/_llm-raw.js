'use strict';
require('dotenv').config();
const fs = require('node:fs');
const LOG = require('node:path').resolve(__dirname, '../logs/llm-raw.log');
const out = [];
const log = (...a) => { const l = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); out.push(l); console.log(l); fs.writeFileSync(LOG, out.join('\n') + '\n'); };

(async () => {
  const base = process.env.LLM_BASE_URL;
  const key = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  log('model=', model, 'base=', base);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const resp = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '只输出一个 JSON 对象:{"ok":true},不要输出其他文字' }],
        temperature: 0,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    const j = await resp.json().catch(() => null);
    log('HTTP status=', resp.status);
    log('RAW choices[0].message.content =', JSON.stringify(j?.choices?.[0]?.message?.content).slice(0, 500));
    log('RAW full (truncated) =', JSON.stringify(j).slice(0, 800));
  } catch (e) {
    clearTimeout(t);
    log('FETCH ERROR:', e.name, e.message);
  }
  process.exit(0);
})();
