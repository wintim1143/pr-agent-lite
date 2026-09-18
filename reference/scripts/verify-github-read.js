/**
 * M1-2 验证脚本:真实调一次 GitHub REST,打印 issue / commit 条数 + 样例。
 *
 * 独立 Node 脚本(不需要先 build),复用与 adapters/github.ts 一致的:
 * - owner/repo 自动从 `git remote get-url origin` 解析(支持 SSH/HTTPS)
 * - GITHUB_TOKEN 走环境变量(用 dotenv 从 .env 加载)
 *
 * 运行: node scripts/verify-github-read.js
 * 验收判据(M1-2):issue 数 ≥1 且 commit 数 ≥1,且样例 issue 标题能在 GitHub 页面对上。
 */
'use strict';
require('dotenv').config();
const { execFileSync } = require('node:child_process');

function parseOwnerRepo() {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    const m = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    return m ? { owner: m[1], repo: m[2] } : null;
  } catch {
    return null;
  }
}

async function githubGet(path, token) {
  const resp = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  const raw = await resp.json().catch(() => null);
  if (!resp.ok) {
    const msg = (raw && (raw.message || raw.errors)) || `HTTP ${resp.status}`;
    throw new Error(`GET ${path} → ${resp.status}: ${JSON.stringify(msg)}`);
  }
  return raw;
}

(async () => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('✗ 缺失 GITHUB_TOKEN(在 .env 中配置 fine-grained PAT,需 Contents 读权限)');
    process.exit(1);
  }
  let owner = process.env.GITHUB_OWNER;
  let repo = process.env.GITHUB_REPO;
  if (!owner || !repo) {
    const p = parseOwnerRepo();
    owner = owner || p?.owner;
    repo = repo || p?.repo;
  }
  if (!owner || !repo) {
    console.error('✗ 无法解析 owner/repo:请设置 GITHUB_OWNER/GITHUB_REPO,或确保 git remote origin 已配置');
    process.exit(1);
  }
  console.log(`→ 目标仓库: ${owner}/${repo}`);

  const issues = await githubGet(`/repos/${owner}/${repo}/issues?per_page=10&state=all`, token);
  const realIssues = issues.filter(i => !i.pull_request);
  console.log(`✓ issue 数(近 10 条过滤 PR 后): ${realIssues.length}`);
  if (realIssues[0]) console.log(`  样例 issue #${realIssues[0].number}: ${realIssues[0].title}`);

  const commits = await githubGet(`/repos/${owner}/${repo}/commits?per_page=10`, token);
  console.log(`✓ commit 数(近 10 条): ${commits.length}`);
  if (commits[0]) console.log(`  样例 commit ${commits[0].sha.slice(0, 7)}: ${commits[0].commit.message.split('\n')[0]}`);

  const ok = realIssues.length >= 1 && commits.length >= 1;
  console.log(ok ? '\n✅ M1-2 验收通过:GitHub 只读数据真实可拉取' : '\n⚠️ M1-2 未达标:issue/commit 不足');
  process.exit(ok ? 0 : 1);
})().catch(e => {
  console.error('✗ 验证失败:', e.message);
  process.exit(1);
});
