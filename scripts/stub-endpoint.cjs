#!/usr/bin/env node
/**
 * 确定性假端点 —— 同时说两种协议，只为验证「整条链真的会写文件并落 commit」。
 *
 * ## 为什么需要它
 *
 * 编码链（Anthropic 协议 / CLI 用）与闸门链（OpenAI Chat Completions / 直连用）
 * 都可能因为**凭据或区域封锁**而不可用。那是环境问题，不是链路问题 —— 但两者
 * 的症状一样（跑不通），没法区分。本脚本把环境变量换成受控的假上游，
 * 于是「链路本身通不通」变成一个可以独立断言的事实。
 *
 * ## 行为（脚本化，不依赖任何模型能力）
 *
 *   POST /v1/messages        Anthropic 协议 —— 编码链
 *     首个带 tools 的用户回合 → 回一个 Write 的 tool_use（写进目标仓库）
 *     之后任何回合             → 回一句 end_turn 文本
 *   POST /chat/completions   OpenAI 协议 —— 闸门链
 *     按 prompt 里的输出契约判别串回对应的 JSON：
 *       requirementMet → {"requirementMet":true,"report":"..."}
 *       request-changes → {"decision":"approve","comments":[]}
 *       Conventional Commits → {"message":"..."}
 *
 * ## 它验证什么 / 不验证什么
 *
 * 验证：env 注入是否盖过 ~/.claude/settings.json → CLI 是否照 baseURL 走
 *       → 工具是否真执行 → 文件是否真落盘 → 闸门是否放行 → commit 是否真产生。
 * 不验证：模型质量、真实上游的兼容性、成本。
 *
 * ## 用法
 *
 *   # 写文件（验「CLI 真的把文件写进目标仓库」）
 *   node scripts/stub-endpoint.cjs --port 15999 --file <目标仓库内绝对路径>
 *
 *   # 下发一条命令（验「围栏 hook 真的挂上了」——命令要选 guard.ts 明令禁止的）
 *   node scripts/stub-endpoint.cjs --port 15999 --tool Bash --command 'git push origin main'
 *
 *   然后 CODING_ANTHROPIC_BASE_URL / LLM_BASE_URL 都指向 http://127.0.0.1:15999
 */

const http = require('http');
const path = require('path');

function parseArgs(argv) {
  const out = {
    port: 15999,
    file: '',
    content: 'hello from stub\n',
    commitMessage: '',
    tool: 'Write',
    command: '',
    quiet: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--file') out.file = argv[++i];
    else if (a === '--content') out.content = argv[++i];
    else if (a === '--commit-message') out.commitMessage = argv[++i];
    else if (a === '--tool') out.tool = argv[++i];
    else if (a === '--command') out.command = argv[++i];
    else if (a === '--quiet') out.quiet = true;
  }
  return out;
}

const cfg = parseArgs(process.argv);
if (cfg.tool !== 'Bash' && !cfg.file) {
  process.stderr.write('需要 --file <绝对路径>（必须落在目标仓库内，否则会被围栏拒绝）\n');
  process.exit(2);
}
if (cfg.tool === 'Bash' && !cfg.command) {
  process.stderr.write('--tool Bash 时还需要 --command <要执行的命令>\n');
  process.exit(2);
}
if (cfg.tool !== 'Bash' && !path.isAbsolute(cfg.file)) {
  process.stderr.write('--file 必须是绝对路径\n');
  process.exit(2);
}

function log(...a) {
  if (!cfg.quiet) process.stderr.write('[stub] ' + a.join(' ') + '\n');
}

/* ── Anthropic 协议 ─────────────────────────────────────────────────────── */

function hasToolResult(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) if (b && b.type === 'tool_result') return true;
  }
  return false;
}

function anthropicText(model) {
  return {
    id: 'msg_stub_' + Date.now(),
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: '已完成。' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 7 },
  };
}

function anthropicToolUse(model) {
  // `--tool Bash` 时下发一条命令而不是写文件 —— 用来验证**围栏 hook 真的挂上了**：
  // 命令刻意选一条 guard.ts 里明令禁止的（如推送受保护分支），期望在日志里看到 guard:deny。
  const input =
    cfg.tool === 'Bash' ? { command: cfg.command } : { file_path: cfg.file, content: cfg.content };
  return {
    id: 'msg_stub_' + Date.now(),
    type: 'message',
    role: 'assistant',
    model,
    content: [
      { type: 'text', text: cfg.tool === 'Bash' ? '我来执行这条命令。' : '我来创建这个文件。' },
      {
        type: 'tool_use',
        id: 'toolu_stub_1',
        name: cfg.tool,
        input,
      },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 12, output_tokens: 34 },
  };
}

function writeSSE(res, msg) {
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('message_start', {
    type: 'message_start',
    message: { ...msg, content: [], stop_reason: null, usage: { ...msg.usage, output_tokens: 0 } },
  });
  msg.content.forEach((block, i) => {
    if (block.type === 'text') {
      send('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text } });
    } else {
      send('content_block_start', { type: 'content_block_start', index: i, content_block: { ...block, input: {} } });
      send('content_block_delta', {
        type: 'content_block_delta',
        index: i,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      });
    }
    send('content_block_stop', { type: 'content_block_stop', index: i });
  });
  send('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: msg.stop_reason, stop_sequence: null },
    usage: { output_tokens: msg.usage.output_tokens },
  });
  send('message_stop', { type: 'message_stop' });
  res.end();
}

/* ── OpenAI 协议（闸门链）────────────────────────────────────────────────── */

/**
 * 按 prompt 里的输出契约判别串选回哪个 JSON。
 *
 * ⚠️ 顺序有讲究：test 闸门的 prompt 里也出现过 "message" 这样的普通词，
 * 先判最独特的 `requirementMet`，再判 `request-changes`，最后才是提交信息。
 */
function gateReply(prompt) {
  if (prompt.includes('requirementMet')) {
    return { requirementMet: true, report: '假端点：改动已按需求落盘，见目标仓库新增文件。' };
  }
  if (prompt.includes('request-changes')) {
    return { decision: 'approve', comments: [] };
  }
  if (prompt.includes('Conventional Commits')) {
    return { message: cfg.commitMessage || 'feat(demo): add stub-written file\n\nCloses #1' };
  }
  return { message: cfg.commitMessage || 'chore(demo): stub reply' };
}

function chatCompletion(prompt, model) {
  return {
    id: 'chatcmpl_stub_' + Date.now(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify(gateReply(prompt)) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
  };
}

/* ── 路由 ──────────────────────────────────────────────────────────────── */

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => (raw += c));
  req.on('end', () => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      /* 非 JSON 一律当空对象 */
    }
    const model = body.model || 'stub-model';
    const url = req.url || '';

    if (url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 1 }));
    }

    // ── 闸门链 ──
    if (url.includes('/chat/completions')) {
      const prompt = String(body.messages?.[0]?.content ?? '');
      const payload = chatCompletion(prompt, model);
      const kind = prompt.includes('requirementMet') ? 'test' : prompt.includes('request-changes') ? 'review' : 'commit';
      log(`POST ${url} model=${model} -> gate=${kind} ${JSON.stringify(payload.choices[0].message.content).slice(0, 90)}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(payload));
    }

    // ── 编码链 ──
    const isToolTurn = Array.isArray(body.tools) && body.tools.length > 0 && !hasToolResult(body);
    const tiny = typeof body.max_tokens === 'number' && body.max_tokens <= 128;
    const msg = isToolTurn && !tiny ? anthropicToolUse(model) : anthropicText(model);
    log(`POST ${url} model=${model} tools=${body.tools ? body.tools.length : 0} stream=${!!body.stream} -> ${msg.stop_reason}`);

    res.writeHead(200, {
      'content-type': body.stream ? 'text/event-stream' : 'application/json',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    if (body.stream) writeSSE(res, msg);
    else res.end(JSON.stringify(msg));
  });
});

server.listen(cfg.port, '127.0.0.1', () => {
  log(
    `listening http://127.0.0.1:${cfg.port}  tool=${cfg.tool} ` +
      (cfg.tool === 'Bash' ? `command=${JSON.stringify(cfg.command)}` : `writes=${cfg.file}`)
  );
});
