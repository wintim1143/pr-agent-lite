/**
 * M2 前置探针:验证「中转站 中转站 的 Anthropic Messages 端点」能否驱动 Claude Code CLI 的 tool_use 多轮。
 *
 * 为什么需要这个探针:
 * - M1 只验证了 中转站 的 **OpenAI 协议** `/chat/completions`(insight 汇总)。
 * - 编码 agent 走的是 **Anthropic Messages 协议** `/v1/messages`,且必须支持 tool_use 多轮(Read→Write)。
 * - 两者在中转站上是否等价、glm-5.3 能否驱动 tool_use,完全未验证。不验就建 M2 卡,卡上只能写假设。
 *
 * 安全设计:
 * - 在 OS 临时目录下建一次性 git 仓库,cwd 指向它,**完全不碰 sample-app 工作树**。
 * - 不 import dev-workflow、不写任何源码、不 commit。
 * - 直接调 getCodingAgent(cwd),绕过 dev-workflow 里 missingClaudeKey() 的父进程检查(那是另一个独立问题)。
 *
 * 运行: node scripts/_coding-probe.js
 */
'use strict';
require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execSync } = require('node:child_process');

const LOG = path.resolve(__dirname, '../logs/coding-probe.log');
const lines = [];
function log(...a) {
  const line = a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
  lines.push(line);
  console.log(line);
  try { fs.writeFileSync(LOG, lines.join('\n') + '\n'); } catch {}
}

function withGuard(promise, ms, label) {
  let timer;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(`GUARD_TIMEOUT@${label}: 超过 ${ms}ms 未返回`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

(async () => {
  const t0 = Date.now();
  log('== M2 编码后端连通性探针开始 ==');

  // --- 环境事实 ---
  log('[env] LLM_BASE_URL  =', process.env.LLM_BASE_URL || '(空)');
  log('[env] LLM_MODEL     =', process.env.LLM_MODEL || '(空)');
  log('[env] LLM_API_KEY   =', process.env.LLM_API_KEY ? `已设置(len=${process.env.LLM_API_KEY.length})` : '(空)');
  log('[env] 父进程 ANTHROPIC_API_KEY =', process.env.ANTHROPIC_API_KEY ? '已设置' : '(空 = 正常,凭据由 CLI 自读 settings.json)');

  // --- 一次性靶场 ---
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sample-app-coding-probe-'));
  log('[靶场] 临时仓库 =', tmp);
  fs.writeFileSync(path.join(tmp, 'hello.txt'), 'hello from sample-app probe\nsecond line\n');
  try {
    execSync('git init -q && git config user.email probe@local && git config user.name probe', { cwd: tmp, stdio: 'ignore' });
    log('[靶场] git init 完成');
  } catch (e) {
    log('[靶场] git init 失败(不影响探针):', e.message);
  }

  // --- 起编码 agent ---
  const dist = path.resolve(__dirname, '../dist/agents/coding-agent.js');
  if (!fs.existsSync(dist)) {
    log('✗ 找不到 dist/agents/coding-agent.js,请先 npm run build');
    process.exit(1);
  }
  const { getCodingAgent } = require(dist);

  log('→ getCodingAgent(tmpDir) ...');
  const agent = await getCodingAgent(tmp);
  log('✓ agent 构造完成(继承父进程 env;Claude CLI 自读 ~/.claude/settings.json 取端点)');

  const prompt =
    '这是一个连通性测试。请严格按两步做,不要做别的:\n' +
    '1) 用 Read 工具读取当前目录下的 hello.txt。\n' +
    '2) 用 Write 工具创建 hello.upper.txt,内容是 hello.txt 的全部字母转为大写。\n' +
    '完成后只回一句话:已创建 hello.upper.txt。';

  log('→ generate() 开始(内部守卫 240s)...');
  let res;
  try {
    res = await withGuard(agent.generate(prompt), 240_000, 'coding-generate');
  } catch (e) {
    log('✗ generate 失败:', e?.message || e);
    log('  耗时', Date.now() - t0, 'ms');
    log('\n结论:编码后端【不可用】。M2 建卡前需先解决后端(换真 Anthropic key 或另找支持 tool_use 的端点)。');
    process.exit(1);
  }

  const text = typeof res?.text === 'string' ? res.text : JSON.stringify(res?.text ?? res ?? null);
  log('✓ generate 返回,耗时', Date.now() - t0, 'ms');
  log('[返回文本]', text.slice(0, 500));

  // --- 判据:tool_use 是否真的落了文件 ---
  const target = path.join(tmp, 'hello.upper.txt');
  const exists = fs.existsSync(target);
  log('\n=== 判定 ===');
  log('hello.upper.txt 是否存在 =', exists);
  if (exists) {
    log('内容 =', JSON.stringify(fs.readFileSync(target, 'utf8')));
    log('\n✅ 编码后端【可用】:中转站 /v1/messages 成功驱动了 Claude Code CLI 的 tool_use 多轮(Read→Write)。');
    log('   M2 可以按 中转站 映射方案建卡;靶场在临时目录,sample-app 工作树未被触碰。');
  } else {
    log('目录内文件 =', fs.readdirSync(tmp).join(', '));
    log('\n⚠️ 编码后端【存疑】:generate 返回了,但文件没落盘 —— 模型可能没发起 tool_use(只回了文本)。');
    log('   M2 需要换后端,或改用不依赖 tool_use 的方案。');
  }
  log('靶场路径(可自行清理):', tmp);
  process.exit(exists ? 0 : 2);
})().catch(e => {
  log('✗ PROBE ERROR:', e?.message || e);
  if (e?.stack) log(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
