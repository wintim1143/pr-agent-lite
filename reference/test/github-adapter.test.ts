import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getGithubConfig,
  githubMergePR,
  githubPushAndOpenPR,
  parseOwnerRepo,
} from '../src/adapters/github';

/** mock 全局 fetch:返回指定响应;记录最后一次调用以便断言请求参数 */
function mockFetchOnce(status: number, body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const orig = global.fetch;
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as Response;
  }) as typeof fetch;
  return { calls, restore: () => (global.fetch = orig) };
}

/**
 * 临时 git 仓库工厂 —— 供 `parseOwnerRepo` 与 `githubPushAndOpenPR` 的用例共用。
 *
 * ## 为什么真造仓库而不是 mock execFileSync
 * 这两处的 bug 都出在「git 命令落在**哪个 cwd**」这种**环境语义**上。
 * mock 掉 git 等于把被测行为一起 mock 了 —— 测试会永远绿，且绿得毫无意义。
 * 真仓库的成本只是 `git init`（毫秒级），换来的是真能复现一次 cwd 错位。
 */
const TMP_REPOS: string[] = [];

/** 造一个临时 git 仓库；remoteUrl 非空时给它加 origin */
function makeRepo(remoteUrl?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sample-app-owner-'));
  TMP_REPOS.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
  if (remoteUrl) {
    execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd: dir, stdio: 'pipe' });
  }
  return dir;
}

afterEach(() => {
  while (TMP_REPOS.length) {
    try {
      rmSync(TMP_REPOS.pop()!, { recursive: true, force: true });
    } catch {
      /* Windows 偶发文件锁,忽略 —— 是临时目录,不影响判定 */
    }
  }
});

const BASE_ENV: Record<string, string | undefined> = {};
beforeAll(() => {
  // 记录并在每例后恢复,避免污染其他测试(不残留 GITHUB_TOKEN)
  const keys: Array<keyof NodeJS.ProcessEnv> = [
    'GITHUB_TOKEN',
    'GITHUB_OWNER',
    'GITHUB_REPO',
    'GITHUB_BASE_BRANCH',
    // 2026-09-15 补: parseOwnerRepo 现在按 repoRoot() 解析,而 repoRoot() 读这个 env,
    // 不纳入恢复会让本文件的用例互相污染(并可能影响其他测试文件)。
    'CODING_REPO_ROOT',
  ];
  for (const k of keys) BASE_ENV[k] = process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(BASE_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('getGithubConfig', () => {
  it('token/owner/repo 齐全时返回配置,baseBranch 默认 main', () => {
    process.env.GITHUB_TOKEN = 'github_pat_test';
    process.env.GITHUB_OWNER = 'example-org';
    process.env.GITHUB_REPO = 'sample-app';
    delete process.env.GITHUB_BASE_BRANCH;
    const cfg = getGithubConfig();
    expect(cfg).toEqual({ token: 'github_pat_test', owner: 'example-org', repo: 'sample-app', baseBranch: 'main' });
  });

  it('缺 token → null(即使 owner/repo 有)', () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GITHUB_OWNER = 'example-org';
    process.env.GITHUB_REPO = 'sample-app';
    expect(getGithubConfig()).toBeNull();
  });

  it('支持自定义 baseBranch', () => {
    process.env.GITHUB_TOKEN = 't';
    process.env.GITHUB_OWNER = 'o';
    process.env.GITHUB_REPO = 'r';
    process.env.GITHUB_BASE_BRANCH = 'develop';
    expect(getGithubConfig()?.baseBranch).toBe('develop');
  });
});

describe('githubMergePR', () => {
  it('发 PUT /pulls/{n}/merge 且 merge_method=squash', async () => {
    process.env.GITHUB_TOKEN = 'github_pat_test';
    process.env.GITHUB_OWNER = 'example-org';
    process.env.GITHUB_REPO = 'sample-app';
    const m = mockFetchOnce(200, {
      merged: true,
      message: 'Pull Request successfully merged',
      sha: 'abc123',
    });
    try {
      const res = await githubMergePR(7);
      expect(res.merged).toBe(true);
      expect(res.sha).toBe('abc123');
      expect(m.calls).toHaveLength(1);
      const call = m.calls[0];
      expect(call.url).toBe('https://api.github.com/repos/example-org/sample-app/pulls/7/merge');
      expect(call.init?.method).toBe('PUT');
      const body = JSON.parse(String(call.init?.body));
      expect(body.merge_method).toBe('squash');
      expect((call.init?.headers as Record<string, string>).Authorization).toContain('github_pat_test');
    } finally {
      m.restore();
    }
  });

  it('未配置 token → 抛错(不触发网络)', async () => {
    delete process.env.GITHUB_TOKEN;
    process.env.GITHUB_OWNER = 'o';
    process.env.GITHUB_REPO = 'r';
    await expect(githubMergePR(1)).rejects.toThrow(/未配置/);
  });

  it('HTTP 失败(如分支保护 403)→ 抛 merge 失败错误', async () => {
    process.env.GITHUB_TOKEN = 't';
    process.env.GITHUB_OWNER = 'o';
    process.env.GITHUB_REPO = 'r';
    const m = mockFetchOnce(403, { message: 'Branch protection rules do not allow merges' });
    try {
      await expect(githubMergePR(9)).rejects.toThrow(/合并 PR #9 失败.*403/s);
    } finally {
      m.restore();
    }
  });
});

/**
 * `parseOwnerRepo` 的 cwd 语义 —— M3-2 的**回归测试**。
 *
 * ## 为什么这些用例必须存在（这是一条静默 bug，不是理论风险）
 * 原实现执行 `git remote get-url origin` 时**未指定 cwd** → git 落在**进程工作目录**上。
 * 跑 workflow 时进程 cwd 是 sample-app 自己 → 恒解析出 `example-org/sample-app`。
 * 后果：`push` 走 `repoRoot()`（= CODING_REPO_ROOT，靶场），而 owner/repo 来自进程 cwd（sample-app）
 * → **分支推到靶场、PR 开到 sample-app 身上**。全程不报错、不崩溃，只是把 PR 开在错的仓库上。
 *
 * 下面「【回归】」那一条就是这条 bug 的锁：它必须解析出 `CODING_REPO_ROOT` 指向的仓库，
 * 而**不是**进程 cwd 的仓库。这一条挂了就说明 bug 复现了。
 */
describe('parseOwnerRepo（cwd 语义 · M3-2 回归）', () => {
  it('HTTPS remote(带 .git 后缀)→ 正确解析且剥掉后缀', () => {
    const dir = makeRepo('https://github.com/example-org/sample-target.git');
    expect(parseOwnerRepo(dir)).toEqual({ owner: 'example-org', repo: 'sample-target' });
  });

  it('SSH remote(git@host:owner/repo.git)→ 正确解析', () => {
    const dir = makeRepo('git@github.com:example-org/sample-target.git');
    expect(parseOwnerRepo(dir)).toEqual({ owner: 'example-org', repo: 'sample-target' });
  });

  it('无 origin remote → null(不抛错)', () => {
    expect(parseOwnerRepo(makeRepo())).toBeNull();
  });

  it('cwd 指向不存在的目录 → null(不抛错)', () => {
    const ghost = join(tmpdir(), `sample-app-ghost-${Date.now()}`);
    expect(() => parseOwnerRepo(ghost)).not.toThrow();
    expect(parseOwnerRepo(ghost)).toBeNull();
  });

  // ⬇️ 回归锁：这一条挂了就说明「PR 开到 sample-app 身上」的 bug 复现了
  it('【回归】不传 cwd 时按 CODING_REPO_ROOT 解析,绝不能落到进程 cwd(sample-app)', () => {
    process.env.CODING_REPO_ROOT = makeRepo('https://github.com/example-org/sample-target.git');

    const r = parseOwnerRepo();
    expect(r).toEqual({ owner: 'example-org', repo: 'sample-target' });
    // 显式负向断言：修复前这里会是 sample-app（进程 cwd 的 remote）
    expect(r?.repo).not.toBe('sample-app');
  });

  it('CODING_REPO_ROOT 指向不存在目录 → null(repoRoot() 的抛错不逃逸出本函数)', () => {
    process.env.CODING_REPO_ROOT = join(tmpdir(), `sample-app-nope-${Date.now()}`);
    expect(() => parseOwnerRepo()).not.toThrow();
    expect(parseOwnerRepo()).toBeNull();
  });

  it('显式 env 优先于 remote 解析', () => {
    process.env.CODING_REPO_ROOT = makeRepo('https://github.com/example-org/sample-target.git');
    process.env.GITHUB_TOKEN = 't';
    process.env.GITHUB_OWNER = 'someone-else';
    process.env.GITHUB_REPO = 'other-repo';
    expect(getGithubConfig()).toMatchObject({ owner: 'someone-else', repo: 'other-repo' });
  });
});

/** 数一个仓库的提交总数；空仓库（0 commit）时 git 会报错，语义上即 0 */
function commitCount(dir: string): number {
  try {
    return Number(
      execFileSync('git', ['rev-list', '--count', '--all'], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim()
    );
  } catch {
    return 0;
  }
}

/**
 * `githubPushAndOpenPR` 的「工作树脏」行为 —— M3-3 的**行为变更锁**。
 *
 * ## 锁的是什么
 * M2 的实现会在工作树脏时**兜底补一个提交**（`chore: auto-dev <branch>`），
 * 目的是「保证 PR 非空」。副作用是**静默掩盖 commit 闸门的失败**：
 * commit 步挂掉 → 工作树自然是脏的 → 兜底自动补提交 → PR 照开，
 * 闸门给的 `request-changes`/判负被吞掉，人工看到的却是一条「看起来正常」的 PR。
 *
 * M3 起改成**显式报错**。下面两条把新行为钉死，其中第 1 条的第二个断言是关键：
 * **必须证明没有产生兜底提交** —— 只断言「返回了 error」是不够的，
 * 「返回错误、但顺手补了一个提交」同样会污染远端。
 *
 * 注：`isDirty()` 查的是 `git diff --cached --quiet`（暂存区）与 `git diff --quiet`（工作区），
 * **未跟踪文件不算脏** —— 所以造脏工作树必须 `git add`，只写文件是不行的。
 */
describe('githubPushAndOpenPR（工作树脏 → 显式失败 · M3-3）', () => {
  /** 造一个「有暂存改动」的仓库 */
  function makeDirtyRepo(): string {
    const dir = makeRepo('https://github.com/example-org/sample-target.git');
    writeFileSync(join(dir, 'dirty.txt'), 'hello\n');
    execFileSync('git', ['add', 'dirty.txt'], { cwd: dir, stdio: 'pipe' });
    return dir;
  }

  it('工作树脏 → 返回 dirty-worktree，且**不产生任何兜底提交**', async () => {
    const dir = makeDirtyRepo();
    process.env.CODING_REPO_ROOT = dir;
    process.env.GITHUB_TOKEN = 't';
    process.env.GITHUB_OWNER = 'example-org';
    process.env.GITHUB_REPO = 'sample-target';

    const res = await githubPushAndOpenPR({ branch: 'feat/1-x', title: 'x', body: 'y' });

    expect(res.prNumber).toBe(0);
    expect(res.error).toMatch(/dirty-worktree/);
    // 关键：不只看返回值 —— 还要证明没有悄悄补提交（否则远端照样被污染）
    expect(commitCount(dir)).toBe(0);
  });

  it('未配置 token → skipped（不触发任何 git 操作，也不因脏工作树报错）', async () => {
    delete process.env.GITHUB_TOKEN;
    process.env.CODING_REPO_ROOT = makeDirtyRepo();
    process.env.GITHUB_OWNER = 'example-org';
    process.env.GITHUB_REPO = 'sample-target';

    const res = await githubPushAndOpenPR({ branch: 'feat/1-x', title: 'x', body: 'y' });
    expect(res.skipped).toBe(true);
    expect(res.error).toBeUndefined();
  });
});
