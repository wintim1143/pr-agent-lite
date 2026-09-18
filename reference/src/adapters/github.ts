/**
 * GitHub adapter —— K6(原 GitHub 桩)的落地实现。
 *
 * 设计取舍(先读环境再动手,非猜):
 * - `checkout`(建分支) 走本地 `git`(纯本地操作,不需要 GitHub 鉴权)。
 * - `push-open-pr` 走两件事:
 *   1. `git push` —— 用显式 `GITHUB_TOKEN` 内嵌 HTTPS URL 推分支(CI 标准做法,不依赖 SSH/gh);
 *   2. 开 PR / merge —— **全部走 GitHub REST API**(`fetch`),**不依赖 `gh` CLI**(K5 决策:macOS 无
 *      Homebrew、不引入外部二进制,统一 REST 保证跨平台行为一致)。
 * - owner/repo 优先读 `GITHUB_OWNER`/`GITHUB_REPO`,留空则从**目标仓库**(`repoRoot()`)的
 *   `git remote get-url origin` 解析 —— 注意是 repoRoot 而非进程 cwd(见 `parseOwnerRepo` 注释)。
 * - `GITHUB_TOKEN` 是唯一鉴权来源(fine-grained PAT,需 Contents + Pull requests 写权限)。
 *
 * 重要:本模块**加载时不抛错**(否则拖垮 `npm test` 与 `GET /api/agents` 仅列元数据的场景),
 * 所有校验/报错都延迟到调用 `githubCheckout` / `githubPushAndOpenPR` / `githubMergePR` 时才暴露。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import {
  resolveRepoEntry,
  repoKeyOf,
  assertLogicalTarget,
  type RepoEntry,
  type RepoTarget,
} from './repo-registry.js';

/** 统一 REST 调用:失败(<2xx)抛 `GithubApiError`(含 status + 响应体),供调用方判读。 */
export async function githubRequest<T>(
  cfg: { owner: string; repo: string; token: string },
  path: string,
  init?: { method?: string; body?: unknown }
): Promise<T> {
  const resp = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const raw = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
  if (!resp.ok) {
    const msg = (raw && (raw.message || raw.errors)) || `HTTP ${resp.status}`;
    throw new Error(`GitHub API ${init?.method ?? 'GET'} ${path} → ${resp.status}: ${JSON.stringify(msg)}`);
  }
  return raw as T;
}

export interface GithubConfig {
  token: string;
  owner: string;
  repo: string;
  baseBranch: string;
}

/**
 * 校验一个目录确实是 git 工作树的根，否则显式抛错。
 *
 * ⚠️ 刻意**不提供**「目录不存在就回退到 cwd」的降级 —— 那等于在错误的仓库上动手且不报错
 * （M2 已确立此行为，M5 沿用）。
 */
function assertRepoDir(dir: string, who: string): string {
  if (!existsSync(dir)) {
    throw new Error(`${who} 指向的目录不存在: ${dir}`);
  }
  if (!existsSync(join(dir, '.git'))) {
    throw new Error(`${who} 指向的不是 git 仓库(缺 .git): ${dir}`);
  }
  return dir;
}

/** 路径等价判定（Windows 大小写不敏感、忽略尾部分隔符）。 */
function samePath(a: string, b: string): boolean {
  const na = resolve(a).replace(/[\\/]+$/, '');
  const nb = resolve(b).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/**
 * 旧「单仓库」配置在当前进程里指的是哪个仓库（用于冲突检测）。
 *
 * 取值顺序与 `getGithubConfig()` 一致：显式 `GITHUB_OWNER`/`GITHUB_REPO` 优先，
 * 否则从 `CODING_REPO_ROOT` 的 origin remote 反推。取不到返回 null（= 未配置单仓库模式）。
 */
function resolveEnvRepoKey(): string | null {
  const owner = process.env.GITHUB_OWNER?.trim();
  const repo = process.env.GITHUB_REPO?.trim();
  if (owner && repo) return `${owner}/${repo}`;
  const legacyRoot = process.env.CODING_REPO_ROOT?.trim();
  if (legacyRoot) {
    const p = parseOwnerRepo(legacyRoot);
    return p ? repoKeyOf(p) : null;
  }
  return null;
}

/**
 * 检测「旧 env」与「仓库注册表」对**同一个仓库**给出的配置是否矛盾（M5 卡 §10）。
 *
 * ⚠️ 只在两者说的**是同一个 repoKey** 时比对 —— 否则多仓库模式下必然误报：
 * `.env` 里那套单仓库配置说的永远是靶场 A，跑 target B 时与本 target 无关。
 *
 * 矛盾时**显式报错**而不是「target 优先」：静默取其一正是 M3「base 改名导致红线失效」
 * 那类问题的成因（两处配置各说各话，谁生效取决于读的顺序）。
 */
function assertNoEnvConflict(target: RepoTarget, entry: RepoEntry): void {
  if (resolveEnvRepoKey() !== repoKeyOf(target)) return;

  const legacyRoot = process.env.CODING_REPO_ROOT?.trim();
  if (legacyRoot && !samePath(legacyRoot, entry.localPath)) {
    throw new Error(
      `仓库配置矛盾：target ${repoKeyOf(target)} 的注册表 localPath 是 ${entry.localPath}，` +
        `而 CODING_REPO_ROOT 指向 ${legacyRoot}。两者说的是同一个仓库，必须一致（此处刻意不静默取其一）。`
    );
  }
  const envBases = (process.env.GITHUB_BASE_BRANCH ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (envBases.length > 0 && !envBases.includes(target.baseBranch)) {
    throw new Error(
      `仓库配置矛盾：target ${repoKeyOf(target)} 的 baseBranch 是 ${target.baseBranch}，` +
        `而 GITHUB_BASE_BRANCH 是 ${envBases.join(',')}。两者说的是同一个仓库，必须一致。`
    );
  }
}

/**
 * 仓库根目录(git 工作树顶层)。
 *
 * ## 为什么需要 `CODING_REPO_ROOT`(2026-09-07)
 * 原实现只取「父进程 cwd 的 git 顶层」:在 sample-app 目录下跑 workflow 时,checkout/commit
 * 会**静默打在 sample-app 自己身上** —— 与「M2 在隔离沙箱仓库里写」的意图相反,且不看代码
 * 根本发现不了打错了仓库。
 *
 * 现在:**显式配置优先**;未配置时回退原自举行为(不破坏既有调用方)。
 * 目录不存在 / 不是 git 仓库 → 显式抛错,而不是悄悄回退到 cwd 打错地方。
 *
 * 与 `agents/coding-agent.ts` 的 `getRepoRoot()` 读同一个 env,
 * 保证 checkout / coding / commit 落在同一个仓库。
 *
 * ## M5 扩展:可选 `target`（多仓库）
 *
 * 传了 `target` 就**完全走仓库注册表**（本机路径由注册表解析），并顺带做一次
 * 「旧 env 与注册表是否矛盾」的显式检测（`assertNoEnvConflict`）。
 * **不传 target 时行为与 M4 逐字一致** —— 这是 M5「增量推进而非大爆炸」的关键：
 * M1–M4 的验证脚本与单仓库模式零改动继续可用。
 *
 * @param target 逻辑仓库标识（owner/repo/baseBranch）。省略 → 沿用 `CODING_REPO_ROOT` 单仓库模式。
 */
export function repoRoot(target?: RepoTarget): string {
  if (target) {
    const entry = resolveRepoEntry(target);
    assertNoEnvConflict(target, entry);
    return assertRepoDir(entry.localPath, `${repoKeyOf(target)} 的注册表 localPath`);
  }
  const configured = process.env.CODING_REPO_ROOT?.trim();
  if (configured) return assertRepoDir(configured, 'CODING_REPO_ROOT');
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * 从 git remote 解析 owner/repo(支持 SSH 与 HTTPS 两种 remote URL)。
 *
 * ## 为什么必须显式指定 cwd(2026-09-15 修 · M3-2)
 * 原实现执行 `git remote get-url origin` **未指定 cwd** → git 落在**进程工作目录**上,
 * 而本进程的 cwd 是 sample-app 自身 → 恒解析出 `example-org/sample-app`。
 * 后果是「push 走 `repoRoot()`(指向靶场)、PR 却开到 sample-app 身上」这种错位:
 * push 与 owner/repo 来自**两个不同的仓库**,且不看代码根本发现不了。
 * M2 零远端时无感,但 M3 起会真写远端,这个错位不可接受。
 *
 * 现在与 `repoRoot()` **同源**:cwd 显式指定为目标仓库,消除隐式依赖。
 * 未配置 `CODING_REPO_ROOT` 时 `repoRoot()` 回退到「进程 cwd 的 git 顶层」,
 * 与原行为等价(向后兼容既有调用方)。
 *
 * @param cwd 解析用的工作目录;省略时取 `repoRoot()`
 * @returns 解析出的 owner/repo;无 remote、非 git 仓库或 `repoRoot()` 抛错时返回 null
 */
export function parseOwnerRepo(cwd?: string): { owner: string; repo: string } | null {
  try {
    // `repoRoot()` 可能抛错(CODING_REPO_ROOT 目录不存在 / 不是 git 仓库),
    // 故必须在 try 内调用 —— 否则异常会逃逸出本函数,
    // 把「解析不出 owner/repo」这种可降级情况放大成「整条流程崩」。
    const root = cwd ?? repoRoot();
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const m = url.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (m) return { owner: m[1], repo: m[2] };
  } catch {
    /* 无 remote / 非 git 仓库 / repoRoot() 抛错时返回 null */
  }
  return null;
}

/** issue 标题转分支 slug */
function slug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'task';
}

/** 读取 GitHub 配置;缺少 token 或无法解析 owner/repo 时返回 null */
export function getGithubConfig(target?: RepoTarget): GithubConfig | null {
  const token = process.env.GITHUB_TOKEN;
  // M5:显式 target 直接给出 owner/repo/baseBranch —— **不再从 env / git remote 猜**。
  // 这条是「在错误的仓库上开 PR」的结构性防线:猜的成本不对称（猜错就在别人的仓库动手）。
  if (target) {
    assertLogicalTarget(target);
    if (!token) return null;
    return { token, owner: target.owner, repo: target.repo, baseBranch: target.baseBranch };
  }

  let owner = process.env.GITHUB_OWNER;
  let repo = process.env.GITHUB_REPO;
  if (!owner || !repo) {
    const parsed = parseOwnerRepo();
    owner = owner || parsed?.owner;
    repo = repo || parsed?.repo;
  }
  if (!owner || !repo || !token) return null;

  const baseBranch = process.env.GITHUB_BASE_BRANCH || 'main';
  return { token, owner, repo, baseBranch };
}

/** 返回缺失的配置项(用于验证脚本提示用户去哪补) */
export function missingGithubConfig(target?: RepoTarget): string[] {
  const miss: string[] = [];
  if (!process.env.GITHUB_TOKEN) {
    miss.push('GITHUB_TOKEN(fine-grained PAT,需 Contents + Pull requests 写权限)');
  }
  // 显式 target 时 owner/repo/baseBranch 全部来自 target，不存在「缺哪个 env」的情况
  if (target) return miss;
  let owner = process.env.GITHUB_OWNER;
  let repo = process.env.GITHUB_REPO;
  if (!owner || !repo) {
    const p = parseOwnerRepo();
    owner = owner || p?.owner;
    repo = repo || p?.repo;
  }
  if (!owner) miss.push('GITHUB_OWNER(或留空,从目标仓库 CODING_REPO_ROOT 的 origin remote 解析)');
  if (!repo) miss.push('GITHUB_REPO(或留空,从目标仓库 CODING_REPO_ROOT 的 origin remote 解析)');
  return miss;
}

/** 工作树是否脏(有已暂存或未暂存改动) */
function isDirty(root: string): boolean {
  try {
    execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: root, stdio: 'pipe' });
  } catch {
    return true; // 有已暂存改动
  }
  try {
    execFileSync('git', ['diff', '--quiet'], { cwd: root, stdio: 'pipe' });
  } catch {
    return true; // 有未暂存改动
  }
  return false;
}

/** 分支是否存在 */
function branchExists(root: string, branch: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', branch], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/** 实际 git 目录(worktree 场景下是 `.git/worktrees/<name>` 而非 `.git`)。`--git-dir` 返回相对 cwd 的路径,需 join。 */
function gitDir(root: string): string {
  const dir = execFileSync('git', ['rev-parse', '--git-dir'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  return join(root, dir);
}

/** 当前分支名;HEAD 处于 detached 时返回 null */
function currentBranch(root: string): string | null {
  try {
    return execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * 确保 `refs/heads/<当前分支>` 的 ref 文件**真的落盘**。
 *
 * ## 为什么需要这一层
 *
 * 本环境(PortableGit + 沙箱)存在间歇性缺陷:**部分写 ref 的 git 操作会假成功** ——
 * exit 0、输出正常,但 `.git/refs/heads/<branch>` 没被写入。已实测到的两种:
 *
 * 1. `git checkout -b <branch> <base>`(2026-09-03 踩中):写了 `.git/HEAD` 却没写 ref,
 *    仓库进入 unborn 状态;后续 `git add -A && git commit` 把**整个工作树**当成新文件
 *    提交成孤儿 commit(实测 66 files / 23647 insertions),历史全丢。
 * 2. `git commit`:偶发不更新 ref 文件。
 *
 * 拆解后经实测可靠的命令:
 * - `git checkout <branch>`      —— 切到**已存在**的 ref ✅(只写 HEAD,不动 ref)
 * - 直接写 ref 文件 ✅(但**必须先 mkdir 父目录**:分支名含斜杠时 ref 路径是
 *   `refs/heads/<dir>/<name>`,PortableGit 的 `git branch`/`git update-ref` 在创建含斜杠分支时
 *   会假成功——退出 0 却连 `refs/heads/<dir>/` 目录都没建,导致后续 `git commit` 把整棵工作树
 *   当新文件提交成孤儿 commit。所以建分支一律走 `createBranchVerified` 的 fs 兜底。)
 *
 * ## 为什么先校验再写,而不是无条件写
 *
 * 无条件覆盖有风险(detached HEAD / 并发提交)。所以先比对 `git rev-parse HEAD`,
 * 只有不一致时才补写;写完再校验一次,仍不通过则抛错 ——
 * **宁可显式失败,也不要静默把提交丢进孤儿对象**。
 */
function ensureRefFlushed(root: string, expectedSha: string): void {
  const readHead = (): string | null => {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return null;
    }
  };

  if (readHead() === expectedSha) return;

  const branch = currentBranch(root);
  if (!branch) {
    throw new Error(`ref 未落盘且 HEAD 处于 detached 状态,无法自动修复(期望 ${expectedSha})`);
  }
  const refPath = join(gitDir(root), 'refs', 'heads', branch);
  // 分支名可能含斜杠(如 feat/123-xxx)→ ref 落盘路径需先在 refs/heads/ 下建子目录。
  // 本环境 PortableGit 对"含斜杠分支的 ref 写入"会假成功(目录未建却 exit 0),故这里显式 mkdir 兜底。
  mkdirSync(dirname(refPath), { recursive: true });
  writeFileSync(refPath, `${expectedSha}\n`);

  if (readHead() !== expectedSha) {
    const actual = existsSync(refPath) ? readFileSync(refPath, 'utf8').trim() : '<文件不存在>';
    throw new Error(
      `ref 落盘校验失败:已写 ${refPath} = ${expectedSha},但 git 读到 ${actual}。` +
        '这是本环境已知的 PortableGit ref-not-flushed 缺陷,需人工介入。'
    );
  }
}

/**
 * 创建分支并校验 ref 落盘。
 *
 * **不能用 `git checkout -b <branch> <base>`** —— 见 `ensureRefFlushed` 的说明,
 * 它在本环境会假成功并让仓库进入 unborn 状态。拆成 `git branch` + `git checkout` 两步。
 */
function createBranchVerified(root: string, branch: string, base: string): void {
  execFileSync('git', ['branch', branch, base], { cwd: root, stdio: 'pipe' });
  if (!branchExists(root, branch)) {
    // 兜底:直接写 ref 文件(本环境实测可靠的落盘手段)。
    // 注意:分支名含斜杠(如 feat/123-xxx)时,ref 路径需先在 refs/heads/ 下建子目录,
    // 否则 writeFileSync 会因目录不存在而 ENOENT。PortableGit 的 git branch/update-ref
    // 对此会假成功(目录未建却 exit 0),故这里显式 mkdir 兜底。
    const sha = execFileSync('git', ['rev-parse', base], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const refPath = join(gitDir(root), 'refs', 'heads', branch);
    mkdirSync(dirname(refPath), { recursive: true });
    writeFileSync(refPath, `${sha}\n`);
  }
  if (!branchExists(root, branch)) {
    throw new Error(`创建分支 ${branch} 失败:ref 未落盘(PortableGit ref-not-flushed 缺陷)`);
  }
}

/** 从 `git commit` 输出中提取新提交 SHA,如 `[main abc1234] feat: x` / `[b (root-commit) abc1234] x` */
function parseCommitSha(output: string): string | null {
  const m = output.match(/\[[^\]]*?([0-9a-f]{7,40})\]/);
  return m ? m[1] : null;
}

/** 计算 branch 领先 base 的提交数 */
function countAhead(root: string, base: string, branch: string): number {
  try {
    const out = execFileSync('git', ['rev-list', '--count', `${base}..${branch}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * 取当前工作树相对 base 分支的改动 diff(含未提交改动),供 commit-message 闸门使用。
 *
 * ## 为什么需要(2026-09-14)
 *
 * `commit-message/SKILL.md` 明写「输入改动 diff + issue 号」,但 dev-workflow 的
 * commit 步**从来只传了 issue 号、没传 diff** —— 闸门拿不到改动内容,只能靠猜,
 * 于是产出 `chore(#1): no changes provided...` 这类劣质文案(M2 §M2-6 质量观察 #1)。
 * 切到 DeepSeek 后更严重:模型直接返回空 message,`git commit -m ""` 报
 * `Aborting commit due to empty commit message`。
 *
 * ## 为什么要「工作树 ∪ 已提交」两段
 *
 * commit 步运行在 coding 之后、commit 之前,此时 coding 的改动**还在工作树里未提交**;
 * 但若上游步骤(或重跑)已经提交过,则要取已提交差异。两者取并集,与
 * `verify-local-write.js` 的 AC-2 判据保持一致。
 *
 * @param base 对比基准分支(默认 main;M5 起可由 `target.baseBranch` 提供)
 * @param maxChars 截断上限,防止超大 diff 撑爆 prompt(默认 8000)
 * @param root 目标仓库根目录;省略时按 `target` 解析,再省略则回退 `repoRoot()`
 * @param target M5:逻辑仓库标识,使本函数仓库无关
 */
export function gitDiffForCommit(
  base?: string,
  maxChars = Number(process.env.COMMIT_DIFF_MAX_CHARS ?? 8000),
  root?: string,
  target?: RepoTarget
): { stat: string; diff: string; truncated: boolean } {
  const r = root ?? repoRoot(target);
  const b = base ?? target?.baseBranch ?? 'main';
  const run = (args: string[]): string => {
    try {
      return execFileSync('git', args, { cwd: r, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      return '';
    }
  };
  // 已提交差异(工作树 HEAD vs base)
  const committed = run(['diff', `${b}...HEAD`]);
  // 未提交改动(工作树 vs HEAD),含新增文件
  const uncommitted = run(['diff', 'HEAD']);
  const untracked = run(['ls-files', '--others', '--exclude-standard']);
  const diff = [committed, uncommitted].filter(Boolean).join('\n');
  const stat = run(['diff', '--stat', `${b}...HEAD`]) || run(['diff', '--stat', 'HEAD']);

  const full = untracked ? `${diff}\n\n[未跟踪的新文件]\n${untracked}` : diff;
  const truncated = full.length > maxChars;
  return { stat, diff: truncated ? full.slice(0, maxChars) + `\n...(diff 已截断,原始长度 ${full.length} 字符)` : full, truncated };
}

/**
 * 本次改动涉及的**文件路径**清单（相对仓库根，去重排序）。
 *
 * ## 为什么要单独一个函数（M4-5）
 *
 * `gitDiffForCommit` 返回的是 diff **文本**，而 `agentModifiedTests` 需要的是**路径集合**
 * ——从 diff 文本里正则抠路径既脆又易被文件名里的空格/引号扰乱。
 *
 * 数据源与 `gitDiffForCommit` **完全一致**（已提交差异 ∪ 未提交改动 ∪ 未跟踪新文件），
 * 这样保证「闸门看到的改动」=「自证检测所依据的改动」=「验收脚本看到的改动」三者同源。
 * 若哪天 gitDiffForCommit 改了取法，这里必须同步改 —— 否则会出现
 * 「diff 里有测试文件、检测却说没有」这种静默不一致。
 */
export function gitChangedFiles(base?: string, root?: string, target?: RepoTarget): string[] {
  const r = root ?? repoRoot(target);
  const b = base ?? target?.baseBranch ?? 'main';
  const run = (args: string[]): string => {
    try {
      return execFileSync('git', args, { cwd: r, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      return '';
    }
  };
  const rows = [
    run(['diff', '--name-only', `${b}...HEAD`]),
    run(['diff', '--name-only', 'HEAD']),
    run(['ls-files', '--others', '--exclude-standard']),
  ]
    .join('\n')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  return Array.from(new Set(rows)).sort();
}

/**
 * 同 `gitChangedFiles`，但带 git 变更状态（`A` 新增 / `M` 修改 / `D` 删除 / `R` 重命名）。
 *
 * ## 为什么 M4 需要区分「新增」与「修改」（2026-09-15）
 *
 * `agentModifiedTests` 要拦的是**自证循环**：agent 把既有断言改松、让它自己通过。
 * 但「agent **新增**一个测试文件」是另一回事 —— 它不可能削弱既有断言，
 * 顶多是加了个没有信息量的测试，危害等级完全不同。
 * 若不区分，一个「顺手给新函数补个测试」的良性 agent 会被误拦，
 * 而这恰恰是 M4 靶场路径 A 的真实风险（模型很可能觉得补测试是好习惯）。
 *
 * 未跟踪文件一律记为 `A`（在 git 眼里就是新增）。
 */
export function gitChangedFilesWithStatus(
  base?: string,
  root?: string,
  target?: RepoTarget
): Array<{ path: string; status: string }> {
  const r = root ?? repoRoot(target);
  const b = base ?? target?.baseBranch ?? 'main';
  const run = (args: string[]): string => {
    try {
      return execFileSync('git', args, { cwd: r, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      return '';
    }
  };
  const out: Array<{ path: string; status: string }> = [];
  const parse = (raw: string): void => {
    for (const line of raw.split('\n')) {
      // 格式：`M\tpath` 或 `R100\told\tnew`（重命名三列，取最后一列为新路径）
      const parts = line.split('\t').map(s => s.trim()).filter(Boolean);
      if (parts.length < 2) continue;
      out.push({ path: parts[parts.length - 1], status: parts[0][0] });
    }
  };
  parse(run(['diff', '--name-status', `${b}...HEAD`]));
  parse(run(['diff', '--name-status', 'HEAD']));
  for (const f of run(['ls-files', '--others', '--exclude-standard']).split('\n')) {
    const p = f.trim();
    if (p) out.push({ path: p, status: 'A' });
  }
  // 同一路径可能同时出现在「已提交」与「未提交」两段里：以「非 A」优先（保守取更严重者）
  const merged = new Map<string, string>();
  for (const { path: p, status } of out) {
    const prev = merged.get(p);
    if (prev === undefined || (prev === 'A' && status !== 'A')) merged.set(p, status);
  }
  return Array.from(merged, ([path, status]) => ({ path, status })).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 真正执行一次 git 提交(供 commit 步与 push-open-pr 兜底使用)。
 * - 先 `git add -A`(仅暂跟踪内文件;`.env` 等 gitignore 项不会被加入)
 * - 若没有任何改动可提交,返回 { committed:false, error:'nothing-to-commit' }
 */
export function gitCommit(
  message: string,
  root?: string,
  target?: RepoTarget
): {
  committed: boolean;
  error?: string;
} {
  const r = root ?? repoRoot(target);
  try {
    execFileSync('git', ['add', '-A'], { cwd: r, stdio: 'pipe' });
    const out = execFileSync('git', ['commit', '-m', message], {
      cwd: r,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // commit 在本环境同样可能假成功(exit 0 但 ref 未更新)→ 显式校验并兜底补写
    const shortSha = parseCommitSha(out);
    if (shortSha) {
      const full = execFileSync('git', ['rev-parse', shortSha], {
        cwd: r,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      ensureRefFlushed(r, full);
    }
    return { committed: true };
  } catch (e) {
    const msg =
      e instanceof Error
        ? (e as NodeJS.ErrnoException & { stderr?: Buffer | string }).stderr?.toString() || e.message
        : String(e);
    if (/nothing to commit/i.test(msg)) return { committed: false, error: 'nothing-to-commit' };
    return { committed: false, error: msg };
  }
}

/**
 * checkout 步:基于 issue 创建并切到 feature 分支 `feat/<n>-<slug>`。
 * 不抛错——失败时由调用方降级为占位分支名,后续 push-open-pr 会再次暴露错误。
 */
export async function githubCheckout(
  issueNumber: number,
  issueTitle: string,
  target?: RepoTarget
): Promise<string> {
  const root = repoRoot(target);
  const branch = `feat/${issueNumber}-${slug(issueTitle)}`;
  const base = getGithubConfig(target)?.baseBranch || target?.baseBranch || 'main';
  // 红线:绝不允许在 base 分支上直接开发。同名说明 issue 标题 slug 退化成了 base 名。
  if (branch === base) {
    throw new Error(`拒绝 checkout:目标分支 ${branch} 与 base 分支 ${base} 同名(不得在 base 分支上直接开发)`);
  }
  if (!branchExists(root, branch)) {
    createBranchVerified(root, branch, base);
  }
  execFileSync('git', ['checkout', branch], { cwd: root, stdio: 'pipe' });
  return branch;
}

export interface PushPrResult {
  prNumber: number;
  prUrl: string | null;
  skipped?: boolean;
  error?: string;
}

/**
 * push-open-pr 步:把当前分支推到 origin 并开 PR。
 * - 未配置 GitHub(token 缺失或无法解析 owner/repo)→ 返回 `{ prNumber:0, skipped:true }`
 * - **工作树脏 → 返回 `{ error:'dirty-worktree' }`,不再兜底补提交**(2026-09-15 · M3-3 变更)
 * - 没有任何领先 base 的提交 → 返回 `{ prNumber:0, error:'no-commits-to-push' }`(PR 会是空的)
 * - 失败(推送/开 PR 异常)→ 返回 `{ prNumber:0, error:<原因> }`,**本函数不抛**
 *   —— 「返回结构化结果」与「是否阻断流程」是两件事:adapter 只如实报告,
 *   由编排层(`dev-workflow` 的 push-open-pr 步)决定要不要 throw。
 *   这样 adapter 可被非编排场景复用(比如只查询状态),不会因为设计成「必抛」而失去复用性。
 */
export async function githubPushAndOpenPR(opts: {
  branch: string;
  title: string;
  body: string;
  baseBranch?: string;
  /** M5：多仓库目标。给出后 owner/repo/baseBranch 全部来自它，不再从 env / git remote 猜。 */
  target?: RepoTarget;
}): Promise<PushPrResult> {
  const cfg = getGithubConfig(opts.target);
  if (!cfg) {
    return { prNumber: 0, prUrl: null, skipped: true };
  }
  const root = repoRoot(opts.target);
  const branch = opts.branch;
  const base = opts.baseBranch || cfg.baseBranch;

  try {
    // 1) 工作树必须干净 —— 脏 = commit 步可能已失败。M3 起**不再兜底补提交**。
    //
    // ## 为什么移除兜底(2026-09-15 · M3-3)
    // M2 的兜底是为了「保证 PR 非空」:工作树脏就自动补一个提交,让 PR 有内容可发。
    // 但那会**静默掩盖 commit 闸门的失败**:commit 步挂掉 → 工作树自然是脏的 →
    // 兜底自动补一个 `chore: auto-dev <branch>` 提交 → PR 照开,
    // 闸门给的 `request-changes`/判负被吞掉,人工看到的却是一条「看起来正常」的 PR。
    // M3 会真写远端,推上去的提交无法撤回 —— 宁可显式失败,也不替模型兜底。
    // (M3 卡 §10 异常表:影响远端的失败必须显式阻断,不得降级为「跳过继续」)
    if (isDirty(root)) {
      return {
        prNumber: 0,
        prUrl: null,
        error:
          'dirty-worktree: 工作树有未提交改动,commit 步可能已失败。' +
          'M3 起不再兜底补提交(兜底会掩盖闸门判负),请先排查 commit 步。',
      };
    }
    // 2) 是否有领先 base 的提交
    const ahead = countAhead(root, base, branch);
    if (ahead === 0) {
      return { prNumber: 0, prUrl: null, error: 'no-commits-to-push' };
    }
    // 3) 推送(用 token 内嵌 HTTPS URL,不依赖 SSH / credential helper / gh)
    //
    //    ⚠️ 代理只在**调用点**注入:`git -c http.proxy=<GIT_PROXY>`(见 M3 卡 §7 M3-3)。
    //    - **为什么要代理**:本机直连 `github.com`(clone/push 的实际端点)不通,
    //      而 `api.github.com` 直连通 → 造成「REST 一直好用、git 一直不好用」的分裂现象。
    //      并非所有环境都需要,所以由 `GIT_PROXY` 开关控制,不配就不加参数。
    //    - **为什么 adapter 不给缺省值**:代理是**某台机器在某段时间的网络现状**,
    //      不是项目的属性。缺省值由调用方(验证脚本)提供,adapter 只负责「配了就走」。
    //    - **为什么用 -c 配置而非环境变量**:git 的 `http.proxy` **配置优先级高于**
    //      `http_proxy`/`HTTPS_PROXY`(`http.c` 中 config 命中后不再读 env),
    //      所以调用点注入能覆盖 shell 里挂着的坏代理;而写进 `.git/config` 属持久化,故不做。
    const tokenUrl = `https://x-access-token:${cfg.token}@github.com/${cfg.owner}/${cfg.repo}.git`;
    const pushArgs = ['push', tokenUrl, `HEAD:refs/heads/${branch}`];
    const proxy = process.env.GIT_PROXY?.trim();
    if (proxy) {
      pushArgs.unshift('-c', `http.proxy=${proxy}`);
    }
    execFileSync('git', pushArgs, {
      cwd: root,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: 'pipe',
    });
    // 4) 开 PR(走 REST;若该分支已有 open PR 则复用,避免 422 重复建)
    try {
      const created = await openPrForBranch(cfg, branch, base, opts.title, opts.body);
      return { prNumber: created.number, prUrl: created.url };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { prNumber: 0, prUrl: null, error: msg };
    }
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: Buffer | string };
    const msg = err.stderr?.toString() || err.message || String(e);
    return { prNumber: 0, prUrl: null, error: msg };
  }
}

/**
 * 为某分支开 PR(先查已 open 的,存在则复用)。走 REST,不依赖 gh。
 * 开不了(权限不足 / 无领先提交等)抛错,由调用方 catch 判读。
 */
async function openPrForBranch(
  cfg: GithubConfig,
  branch: string,
  base: string,
  title: string,
  body: string
): Promise<{ number: number; url: string }> {
  // a) 该 head 分支已存在 open PR?复用之
  const existing = await githubRequest<Array<{ number: number; html_url: string }>>(
    cfg,
    `/pulls?state=open&head=${encodeURIComponent(`${cfg.owner}:${branch}`)}`
  );
  if (existing.length > 0) {
    return { number: existing[0].number, url: existing[0].html_url };
  }
  // b) 没有则新建
  const pr = await githubRequest<{ number: number; html_url: string }>(cfg, '/pulls', {
    method: 'POST',
    body: { title, head: branch, base, body },
  });
  return { number: pr.number, url: pr.html_url };
}

/**
 * merge 步:把已开的 PR 以 squash 方式合入 base 分支(走 REST `PUT /pulls/{n}/merge`)。
 * 合完返回合并状态;不成功(冲突 / 权限不足 / 已被保护规则拦截)抛错由调用方判读。
 */
export async function githubMergePR(
  prNumber: number,
  opts: { baseBranch?: string; target?: RepoTarget } = {}
): Promise<{
  merged: boolean;
  message: string | null;
  sha: string | null;
}> {
  const cfg = getGithubConfig(opts.target);
  if (!cfg) {
    throw new Error('GitHub 未配置:缺少 GITHUB_TOKEN(需 Contents + Pull requests 写权限)');
  }
  try {
    const res = await githubRequest<{
      merged: boolean;
      message: string | null;
      sha: string | null;
    }>(cfg, `/pulls/${prNumber}/merge`, {
      method: 'PUT',
      body: {
        commit_title: `Merge pull request #${prNumber}`,
        merge_method: 'squash',
        base: opts.baseBranch || cfg.baseBranch,
      },
    });
    return res;
  } catch (e) {
    // 保留 cause:原始异常里带 GitHub 的状态码与响应体(如 405「PR 不可合并」、409 冲突),
    // 只保留 message 会让上层无法判断失败类型,排查时只能看到一句拼装后的中文。
    // 注意:项目 target 是 ES2021,`new Error(msg, { cause })` 的第二个参数是 ES2022 才有的,
    // 直接写会 TS2554,所以手动挂载 —— eslint 的 preserve-caught-error 认这种写法。
    const wrapped = new Error(`合并 PR #${prNumber} 失败: ${e instanceof Error ? e.message : String(e)}`);
    (wrapped as Error & { cause?: unknown }).cause = e;
    throw wrapped;
  }
}
