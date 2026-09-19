/**
 * 状态页（M2）—— node 内置 `http`，**零依赖**；按 runId 读日志重建时间线，**不另存状态**。
 *
 * ## 为什么不是「另建一张表把状态存起来」
 *
 * 存一份就是造第二个真相源：日志说失败、表说成功时，没有任何依据能判断该信哪个。
 * 本项目的做法是**日志即状态**（`log-store.ts` 文件头已声明这条契约）——
 * 页面只是它的一种渲染。
 *
 * ## ⚠️ SSE 是「推送」而不是「轮询」
 *
 * `GET /events` 是一个 **SSE 长连接**：页面打开后由服务端主动推。
 * 这个端点只服务于人打开浏览器看，**不是给外侧网关用的长推送通道** ——
 * 网关侧的长推送由它自己负责（本项目不持有任何 IM 凭据、不发任何出站消息）。
 *
 * ## 三条实现约束
 *
 * 1. **空态必须正常**：一台还没跑过任何流程的机器打开页面，要看到「暂无运行记录」，
 *    而不是空白页或 500。空态是最常见的状态（部署完第一次打开就是它）。
 * 2. **不编造**：没结束的 run 显示「进行中/未结束」，不显示成功。
 * 3. **只读**：本页面不提供任何写操作，也没有触发流程的入口 —— 触发器在外侧网关。
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { listRuns, readAllRecords, type LogRecord, type RunSummary } from './log-store.js';
import { repoList, runCost, runStatus } from './tools/readonly.js';

/** SSE 推送间隔（毫秒）。够新，又不会把日志读爆。 */
const PUSH_INTERVAL_MS = Number(process.env.STATUS_PUSH_MS ?? 3_000);
/** 单次推送最多带多少条事件。 */
const TAIL_LIMIT = Number(process.env.STATUS_TAIL_LIMIT ?? 200);

function htmlEscape(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** 一个 run 的「人话」状态。**未结束不等于成功**，这里刻意分成第三种。 */
function stateOf(s: RunSummary): { label: string; tone: 'ok' | 'bad' | 'running' | 'unknown' } {
  if (s.status === 'ok') return { label: '成功', tone: 'ok' };
  if (s.status === 'skipped') return { label: '已跳过', tone: 'unknown' };
  if (s.status) return { label: s.status, tone: 'bad' };
  return s.endedAt ? { label: '(未知)', tone: 'unknown' } : { label: '进行中 / 未结束', tone: 'running' };
}

function renderRunsTable(runs: RunSummary[]): string {
  if (runs.length === 0) {
    return (
      `<p class="empty">暂无运行记录。</p>` +
      `<p class="hint">这是正常空态 —— 还没有任何一次开发流程落过日志。` +
      `页面本身工作正常，不是出错。</p>`
    );
  }
  const rows = runs
    .map(s => {
      const st = stateOf(s);
      return (
        `<tr>` +
        `<td><code>${htmlEscape(s.runId)}</code></td>` +
        `<td><span class="state ${st.tone}">${htmlEscape(st.label)}</span></td>` +
        `<td>${htmlEscape(s.startedAt ?? '（无起点记录）')}</td>` +
        `<td>${htmlEscape(s.lastStage ?? '—')}</td>` +
        `<td class="num">${s.stepsDone} / ${s.stepsFailed}</td>` +
        `<td class="num">${s.llmCalls}${s.unknownUsage ? ` <span class="dim">(${s.unknownUsage} 未知)</span>` : ''}</td>` +
        `</tr>`
      );
    })
    .join('');
  return (
    `<table><thead><tr>` +
    `<th>runId</th><th>状态</th><th>开始时间</th><th>最后阶段</th><th>步骤 成功/失败</th><th>LLM 调用</th>` +
    `</tr></thead><tbody>${rows}</tbody></table>`
  );
}

function renderEvents(records: LogRecord[]): string {
  if (records.length === 0) return `<p class="hint">（还没有任何事件）</p>`;
  return (
    `<ul class="events">` +
    records
      .map(r => {
        const tone = r.event.endsWith(':fail') || r.event === 'guard:deny' ? 'bad' : '';
        const dur = typeof r.durationMs === 'number' ? ` <span class="dim">${(r.durationMs / 1000).toFixed(1)}s</span>` : '';
        const extra = Object.entries(r)
          .filter(([k]) => !['ts', 'event', 'stage', 'runId', 'traceId', 'durationMs'].includes(k))
          .map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`)
          .join(' ');
        return (
          `<li class="${tone}"><span class="ts">${htmlEscape(r.ts.slice(11, 19))}</span> ` +
          `<span class="stage">${htmlEscape(r.stage ?? '—')}</span> ` +
          `<span class="ev">${htmlEscape(r.event)}</span>${dur}` +
          (extra ? ` <span class="dim">${htmlEscape(extra).slice(0, 300)}</span>` : '') +
          `</li>`
        );
      })
      .join('') +
    `</ul>`
  );
}

function renderPage(): string {
  const { records, badLines, files } = readAllRecords();
  const runs = listRuns(records, 25);
  const repos = repoList();
  const cost = runCost();

  const repoBlock = repos.repos.length
    ? repos.repos
        .map(
          x =>
            `<li><code>${htmlEscape(x.key)}</code> → <code>${htmlEscape(x.localPath)}</code>` +
            ` <span class="dim">base=${htmlEscape(x.baseBranch)} 当前=${htmlEscape(x.currentBranch ?? '(detached)')}</span>` +
            (x.exists ? '' : ' <span class="state bad">路径不存在</span>') +
            `</li>`
        )
        .join('')
    : `<li class="hint">未配置仓库注册表（${htmlEscape(repos.registryPath)}）—— 这是「未配置」，不是「没有仓库」。</li>`;

  const costBlock = cost.rows.length
    ? `<table><thead><tr><th>仓库</th><th>调用</th><th>输入</th><th>输出</th><th>合计</th><th>未知用量</th></tr></thead><tbody>` +
      cost.rows
        .map(
          r =>
            `<tr><td><code>${htmlEscape(r.repoKey)}</code></td><td class="num">${r.llmCalls}</td>` +
            `<td class="num">${r.inputTokens}</td><td class="num">${r.outputTokens}</td>` +
            `<td class="num">${r.totalTokens}</td><td class="num">${r.unknownUsage || '—'}</td></tr>`
        )
        .join('') +
      `</tbody></table>` +
      (cost.totals.unknownUsage
        ? `<p class="hint">⚠️ 有 ${cost.totals.unknownUsage} 次调用未回传用量（落盘为 <code>null</code>，是设计内的正确值，**不是 0**），因此上面的 token 数是<strong>下界</strong>。</p>`
        : '')
    : `<p class="hint">还没有 LLM 调用记录。</p>`;

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>pr-agent-lite 状态</title>
<style>
 :root { color-scheme: light; }
 body { margin:0; padding:24px; font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Hiragino Sans GB",sans-serif; background:#f6f7f9; color:#1c2024; }
 h1 { font-size:18px; margin:0 0 4px; } h2 { font-size:15px; margin:28px 0 8px; }
 .sub { color:#6b7280; font-size:12px; margin-bottom:16px; }
 .card { background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:14px 16px; margin-bottom:8px; }
 table { width:100%; border-collapse:collapse; background:#fff; border:1px solid #e5e7eb; border-radius:8px; overflow:hidden; }
 th,td { text-align:left; padding:7px 10px; border-bottom:1px solid #f0f1f3; font-size:13px; vertical-align:top; }
 th { background:#fafbfc; font-weight:600; color:#4b5563; }
 tr:last-child td { border-bottom:none; }
 td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
 code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
 ul { margin:6px 0; padding-left:18px; } li { margin:2px 0; }
 .state { display:inline-block; padding:1px 7px; border-radius:10px; font-size:12px; }
 .state.ok { background:#e8f5ec; color:#1a7f37; } .state.bad { background:#fdeaea; color:#b42318; }
 .state.running { background:#eef2ff; color:#3538cd; } .state.unknown { background:#f1f2f4; color:#4b5563; }
 .dim { color:#6b7280; font-size:12px; } .hint { color:#6b7280; font-size:12px; }
 .empty { font-size:15px; margin:4px 0; }
 .events { list-style:none; padding-left:0; max-height:420px; overflow:auto; }
 .events li { font-family:ui-monospace,Menlo,monospace; font-size:12px; padding:1px 0; }
 .events li.bad { color:#b42318; } .events .ts { color:#9ca3af; } .events .ev { font-weight:600; }
 .events .stage { color:#3538cd; }
</style></head><body>
<h1>pr-agent-lite 状态</h1>
<div class="sub">日志 ${files} 个文件 · ${records.length} 条事件 · 无法解析 ${badLines} 行 · 推送间隔 ${PUSH_INTERVAL_MS / 1000}s</div>

<h2>运行记录</h2>
<div class="card" id="runs">${renderRunsTable(runs)}</div>

<h2>已接入的仓库</h2>
<div class="card"><ul>${repoBlock}</ul></div>

<h2>Token 成本</h2>
<div class="card">${costBlock}</div>

<h2>实时事件</h2>
<div class="card"><ul class="events" id="events">${renderEvents(records.slice(-TAIL_LIMIT))}</ul></div>

<script>
// 只做一件事：把服务端推来的**已渲染好的**文本块换上去。
// 刻意不在前端做数据→视图的转换 —— 那会让「页面显示什么」有两处逻辑。
const es = new EventSource('/events');
es.addEventListener('runs', e => { document.getElementById('runs').innerHTML = e.data; });
es.addEventListener('events', e => { document.getElementById('events').innerHTML = e.data; });
es.addEventListener('error', () => { /* 断线由浏览器自动重连，页面保持最后一次内容 */ });
</script>
</body></html>`;
}

/**
 * SSE 长连接：定期把**已渲染好的片段**推给页面。
 *
 * 为什么推片段而不是推原始数据：渲染逻辑只有一份（在本文件），
 * 页面只负责替换 DOM。若前端拿到原始数据自己渲染，同一份状态就有了两种呈现实现，
 * 它们迟早会分叉 —— 而「页面和会话里看到的不一致」是最难查的一类问题。
 */
function handleEvents(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // 反向代理（若有）不缓冲，否则推送会被攒着不发
    'x-accel-buffering': 'no',
  });

  const push = (): void => {
    // 客户端已断开时 write 会抛 —— 静默即可，它是正常生命周期的一部分
    try {
      const { records } = readAllRecords();
      res.write(`event: runs\ndata: ${JSON.stringify(renderRunsTable(listRuns(records, 25)))}\n\n`);
      res.write(`event: events\ndata: ${JSON.stringify(renderEvents(records.slice(-TAIL_LIMIT)))}\n\n`);
    } catch {
      /* 推不出去就等下一轮；连接关闭由 close 事件收尾 */
    }
  };

  push();
  const timer = setInterval(push, PUSH_INTERVAL_MS);
  req.on('close', () => clearInterval(timer));
}

/** 建立状态页服务。**不自动监听** —— 由调用方决定端口与生命周期（便于单测）。 */
export function createStatusServer() {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    try {
      if (url.pathname === '/events') return handleEvents(req, res);

      if (url.pathname === '/api/runs') return json(res, runStatus({ limit: 25 }));
      if (url.pathname === '/api/repos') return json(res, repoList());
      if (url.pathname === '/api/cost') return json(res, runCost());
      if (url.pathname.startsWith('/api/run/')) {
        const runId = decodeURIComponent(url.pathname.slice('/api/run/'.length));
        return json(res, runStatus({ runId }));
      }
      if (url.pathname === '/healthz') return json(res, { ok: true });
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(renderPage());
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 —— 可用路径：/（页面）、/events（SSE）、/api/runs、/api/repos、/api/cost、/api/run/<runId>、/healthz');
    } catch (e) {
      // 页面是给人看的：出错也要**说清是什么错**，而不是给一个空白页
      json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });
}

/**
 * 独立启动状态页（`npm run status`）。
 *
 * 默认只监听回环地址：状态页含本机真实路径，**不该默认对整个网络开放**。
 * 需要别处访问时显式设 `STATUS_HOST`（部署时按网络边界决定，不在代码里假设）。
 */
export function startStatusServer(): Promise<{ host: string; port: number }> {
  const host = process.env.STATUS_HOST?.trim() || '127.0.0.1';
  const port = Number(process.env.STATUS_PORT ?? 8787);
  const server = createStatusServer();
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolvePromise({ host, port }));
  });
}

// 直接 `node dist/status-page.js` 时启动
if (require.main === module) {
  startStatusServer()
    .then(({ host, port }) => {
      // 走 stderr：这个进程和 MCP 进程一样，stdout 保持干净（便于被别的进程托管）
      console.error(`[status] 状态页: http://${host}:${port}/`);
    })
    .catch((e: unknown) => {
      console.error(`[status] 启动失败: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
