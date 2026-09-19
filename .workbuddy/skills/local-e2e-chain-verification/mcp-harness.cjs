/**
 * MCP 层端到端 harness —— 触发 + 观测，一个文件。
 *
 * 用法（在仓库根跑，需先 `npm run build`）：
 *
 *   REPO_REGISTRY_PATH=<注册表> PRAL_PROGRESS_FILE=<日志> \
 *   LLM_PROVIDER=... LLM_BASE_URL=... LLM_MODEL=... LLM_API_KEY=... \
 *   CODING_CLI_PATH=<claude 绝对路径> \
 *   NODE_PATH=$PWD/node_modules \
 *   node .workbuddy/skills/local-e2e-chain-verification/mcp-harness.cjs \
 *        <owner/repo> "<需求标题>" ["<需求正文>"]
 *
 * 只观测已有 run（不触发）：末尾加 `--observe <runId>`。
 *
 * ⚠️ `NODE_PATH` 必须有 —— 脚本不在仓库内，node 按**脚本所在目录**解析依赖，
 *    不设它就会报 MODULE_NOT_FOUND（`@modelcontextprotocol/sdk`）。
 * ⚠️ 不要 `JSON.parse(content[0].text)`：MCP 工具的 `text` 是**给人读的文本**，
 *    结构化数据在 `structuredContent` 里。早期版本就是这么挂的。
 */
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const PROJ = process.env.PRAL_PROJECT_DIR || process.cwd();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(PROJ, 'dist/mcp-server.js')],
    env: { ...process.env }, // 子进程继承 —— dev_start 拉起的 detached 进程也靠这条
  });
  const client = new Client({ name: 'harness', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

async function main() {
  const argv = process.argv.slice(2);
  const observeIdx = argv.indexOf('--observe');
  const client = await connect();

  const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
  const show = async (title, name, args) => {
    console.log(`\n=== ${title} ===`);
    console.log(await call(name, args));
  };

  if (observeIdx >= 0) {
    const runId = argv[observeIdx + 1];
    await show('repo_list', 'repo_list', {});
    if (runId) {
      await show(`run_status(${runId})`, 'run_status', { runId });
      await show(`run_cost(${runId})`, 'run_cost', { runId });
    }
    await show('run_status 列表', 'run_status', { limit: 5 });
    await client.close();
    return;
  }

  const [target, title, body] = argv;
  if (!target || !title) throw new Error('用法: <owner/repo> "<标题>" ["<正文>"] [--observe <runId>]');

  const t0 = Date.now();
  const text = await call('dev_start', { target, title, body, issueNumber: 1 });
  console.log(`✅ dev_start 返回耗时 ${Date.now() - t0}ms（铁律：必须立即返回）`);
  console.log('  ', text.split('\n')[0]);

  const runId = (text.match(/run-[0-9a-z-]+/i) || [])[0];
  if (!runId) throw new Error('返回值里没有 runId');
  console.log('   runId =', runId);

  // 刚启动时「查不到」是正常的（子进程还没落第一条记录）—— 重试而不是当错误
  let first;
  for (let i = 0; i < 10; i++) {
    first = await call('run_status', { runId });
    if (!/没有找到/.test(first)) break;
    await sleep(1500);
  }
  console.log('✅ 步骤记录已落盘:', !/没有找到/.test(first));

  const deadline = Date.now() + 20 * 60 * 1000;
  let last = '';
  while (Date.now() < deadline) {
    await sleep(8000);
    const s = await call('run_status', { runId });
    const m = s.match(/状态：(\S+)/);
    const st = m ? m[1] : 'running';
    const steps = (s.match(/成功 (\d+) \/ 失败 (\d+)/) || []).slice(1).join('/');
    const line = `${st} steps=${steps}`;
    if (line !== last) { console.log('  ...', line); last = line; }
    const done = /步骤：成功 \d+ \/ 失败 \d+/.test(s) && !s.includes('未结束');
    if (done) break;
  }

  await show('run_status 终态', 'run_status', { runId });
  await show('run_cost', 'run_cost', { runId });
  await client.close();
}

main().catch(e => { console.error('❌ ' + ((e && e.stack) || e)); process.exit(1); });
