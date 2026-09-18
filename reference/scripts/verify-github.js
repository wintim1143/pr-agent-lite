/**
 * verify-github.js —— 校验 GitHub adapter 的配置与鉴权(非破坏性,不开真实 PR)。
 *
 * 用法:
 *   node scripts/verify-github.js
 *
 * 行为:
 *   1. 结构校验:读 GITHUB_TOKEN / owner / repo 是否齐全(owner/repo 留空会从 git remote 解析)
 *   2. 缺失 → 打印去哪获取(默认从 .env 读取,需先 `cp .env.example .env` 并填值)
 *   3. 齐全 → 用 **GitHub REST API** 做只读探测(GET /user + GET /repos + GET branches/<base>),
 *      确认 token 真能用、目标仓库可达、base 分支存在。
 *
 * ## 为什么不再用 `gh auth status`(K5 决策落地)
 *
 * 主链路(adapter)已经是**零 `gh` 依赖**:`git push` 走 token 内嵌 HTTPS URL,
 * 开 PR 走 `POST /repos/{o}/{r}/pulls`,merge 走 `PUT /repos/{o}/{r}/pulls/{n}/merge`。
 * 此时还让验证脚本去跑 `gh auth status`,等于**验了一条根本不会被用到的链路**:
 * 没装 gh 的机器上会误报失败,装了 gh 也不代表 adapter 的 REST 路径可用。
 * 所以本脚本改为 REST 直连 —— 验的就是真正会跑的那条链路。
 *
 * ## 为什么不探测「写权限」
 *
 * GitHub **没有无损探测写权限的办法**(13 号文档 K7 已记录):空 body 的 422 发生在鉴权之前,
 * 会假阳性;格式合法的 body 则会**真的创建资源**。所以本脚本只做只读探测,
 * 写权限(Contents / Pull requests)留给第一次端到端跑真实 PR 时自然验证。
 *
 * ## 前置条件
 *
 * 脚本 require 的是 `dist/`(dist 在 .gitignore 里、不随 src 自动更新)。
 * **改完 `src/adapters/github.ts` 后必须先 `npm run build`**,
 * 否则会加载到陈旧模块,报出与真实配置无关的错。
 */
'use strict';
const { execFileSync } = require('node:child_process');
require('dotenv/config');

const github = require('../dist/adapters/github.js');

const API_ROOT = 'https://api.github.com';

function mask(v, head = 4) {
  if (!v) return '<empty>';
  if (v.length <= head * 2) return '***';
  return v.slice(0, head) + '***' + v.slice(-head);
}

/** 统一 REST 只读调用;失败时返回 { ok:false, status, message } 而不抛。 */
async function probeRequest(token, path) {
  const resp = await fetch(`${API_ROOT}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const body = await resp.json().catch(() => null);
  const rateLeft = resp.headers.get('x-ratelimit-remaining');
  return {
    ok: resp.ok,
    status: resp.status,
    rateLeft,
    body,
    message: (body && (body.message || body.errors)) || (resp.ok ? '' : `HTTP ${resp.status}`),
  };
}

console.log('=== GitHub adapter 验证 ===');

async function main() {
  const cfg = github.getGithubConfig();
  if (!cfg) {
    const miss = github.missingGithubConfig();
    console.log('[缺失] 以下配置项未设置:');
    for (const m of miss) console.log('  - ' + m);
    console.log('');
    console.log('去哪获取:');
    console.log('  GitHub → 右上角头像 → Settings → 左侧栏最底部 Developer settings →');
    console.log('  Personal access tokens → Fine-grained tokens → Generate new token');
    console.log('    - Repository access: Only select repositories → 只选目标仓库');
    console.log('    - Repository permissions: Contents = Read and write、Pull requests = Read and write');
    console.log('  把生成的 token(前缀 github_pat_)填到 .env 的 GITHUB_TOKEN。');
    console.log('');
    console.log('  GITHUB_OWNER / GITHUB_REPO: 留空会自动从 `git remote get-url origin` 解析。');
    try {
      const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      console.log('    当前 remote origin:', url);
    } catch {
      console.log('    当前未配置 remote origin。');
    }
    console.log('\n填好后重跑本脚本即可。未配置时 workflow 的 checkout/push-open-pr 会跳过,不阻断流程。');
    process.exit(0);
  }

  console.log('[配置] 已解析到:');
  console.log('  authMode : GITHUB_TOKEN(REST 直连,不依赖 gh CLI)');
  console.log('  token    :', mask(cfg.token));
  console.log('  owner    :', cfg.owner);
  console.log('  repo     :', cfg.repo);
  console.log('  base     :', cfg.baseBranch);

  console.log('\n=== 校验 token(REST 只读探测,不创建任何资源) ===');

  let failed = 0;

  // 1) token 本身是否有效
  const me = await probeRequest(cfg.token, '/user');
  if (me.ok) {
    console.log(`[OK] GET /user → ${me.body.login}(type=${me.body.type})`);
  } else {
    failed++;
    console.log(`[FAIL] GET /user → ${me.status}: ${JSON.stringify(me.message)}`);
    console.log('       token 无效 / 已过期 / 已被撤销。');
  }

  // 2) 目标仓库是否可达
  const repo = await probeRequest(cfg.token, `/repos/${cfg.owner}/${cfg.repo}`);
  if (repo.ok) {
    console.log(
      `[OK] GET /repos/${cfg.owner}/${cfg.repo} → private=${repo.body.private}, default_branch=${repo.body.default_branch}`
    );
  } else {
    failed++;
    console.log(`[FAIL] GET /repos/${cfg.owner}/${cfg.repo} → ${repo.status}: ${JSON.stringify(repo.message)}`);
    console.log('       token 的 Repository access 没有包含该仓库,或 owner/repo 解析错了。');
  }

  // 3) base 分支是否存在(顺便提示保护状态,不作为失败项)
  if (repo.ok) {
    const br = await probeRequest(
      cfg.token,
      `/repos/${cfg.owner}/${cfg.repo}/branches/${encodeURIComponent(cfg.baseBranch)}`
    );
    if (br.ok) {
      const protectedFlag = br.body.protected ? 'true' : 'false';
      console.log(`[OK] GET branches/${cfg.baseBranch} → 存在(protected=${protectedFlag})`);
      if (!br.body.protected) {
        console.log('     [提示] base 分支未开启保护。建议 Settings → Branches → Add ruleset:');
        console.log('            Restrict deletions + Require a pull request before merging + Block force pushes。');
      }
    } else {
      failed++;
      console.log(`[FAIL] GET branches/${cfg.baseBranch} → ${br.status}: ${JSON.stringify(br.message)}`);
    }
  }

  const rateLeft = me.rateLeft ?? repo.rateLeft ?? '?';
  console.log(`\n[速率] 剩余 ${rateLeft} 次/小时`);

  if (failed > 0) {
    console.log(`\n[FAIL] ${failed} 项探测未通过 —— 修完上面的问题再重跑。`);
    process.exit(1);
  }

  console.log('\n[OK] 鉴权与仓库可达性正常 → checkout / push / 开 PR 链路具备条件。');
  console.log('     注意:Contents 与 Pull requests 的**写权限无法无损探测**(空 body 的 422 发生在');
  console.log('     鉴权之前会假阳性,合法 body 会真的创建资源),将在首次端到端跑真实 PR 时验证。');
  console.log('     触发方式:POST /api/workflows/dev-workflow/start-async。');
}

main().catch(e => {
  console.error('[ERROR] 验证脚本异常:', e);
  process.exit(1);
});
