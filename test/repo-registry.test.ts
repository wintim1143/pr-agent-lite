/**
 * M5b 单测：仓库注册表 / RepoTarget 解析 / per-target 红线。
 *
 * 覆盖的验收项：
 * - AC-5  target 里不得出现本机路径（快照要跨机器）
 * - AC-6  不传 target 时行为与 M4 逐字一致（向后兼容）
 * - AC-7  红线 per-target —— base 改名后不得静默失效
 * - AC-10 未知 repoKey **显式报错**，绝不静默落到「当前仓库」
 *
 * ## 为什么这一组必须用真实临时目录
 *
 * 「两个 target 解析出两个不同的 root」这件事，用 mock 是证明不了的 ——
 * mock 会把 `resolveRepoEntry → assertRepoDir` 这条真实链路替换掉，
 * 而那正是「在错误的仓库上动手」唯一可能发生的地方。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  repoKeyOf,
  parseRepoTarget,
  isRepoTarget,
  looksLikeLocalPath,
  assertLogicalTarget,
  loadRegistry,
  resolveRepoEntry,
  resolveRepoTarget,
  listRepoKeys,
  registrySummary,
  registryFilePath,
  type RepoTarget,
} from '../src/adapters/repo-registry';
import { repoRoot, getGithubConfig } from '../src/adapters/github';
import { resolveProtectedBranchNames } from '../src/agents/coding-agent';

const ENV_KEYS = ['REPO_REGISTRY_PATH', 'CODING_REPO_ROOT', 'GITHUB_OWNER', 'GITHUB_REPO', 'GITHUB_BASE_BRANCH'] as const;

let saved: Record<string, string | undefined>;
let tmpDir: string;
let rootA: string;
let rootB: string;

/** 造一个「至少看起来是 git 工作树」的目录（repoRoot 只校验 .git 存在）。 */
function makeFakeClone(name: string): string {
  const p = path.join(tmpDir, name);
  fs.mkdirSync(path.join(p, '.git'), { recursive: true });
  return p;
}

function writeRegistry(repos: Record<string, unknown>): string {
  const p = path.join(tmpDir, 'repos.registry.json');
  fs.writeFileSync(p, JSON.stringify({ repos }, null, 2), 'utf8');
  process.env.REPO_REGISTRY_PATH = p;
  return p;
}

const targetB: RepoTarget = { owner: 'local', repo: 'repo-b', baseBranch: 'trunk' };

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa5-registry-'));
  rootA = makeFakeClone('clone-a');
  rootB = makeFakeClone('clone-b');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('repoKey 与 RepoTarget 的形状', () => {
  it('repoKeyOf 用 owner/repo', () => {
    expect(repoKeyOf({ owner: 'a', repo: 'b' })).toBe('a/b');
  });

  it('parseRepoTarget 解析 owner/repo，可指定基线', () => {
    expect(parseRepoTarget('example-org/sample-target')).toEqual({
      owner: 'example-org',
      repo: 'sample-target',
      baseBranch: 'main',
    });
    expect(parseRepoTarget('o/r', 'trunk').baseBranch).toBe('trunk');
  });

  it('parseRepoTarget 拒绝非 owner/repo 形状', () => {
    for (const bad of ['', 'a', 'a/b/c', 'a b/c']) {
      expect(() => parseRepoTarget(bad)).toThrow(/非法 repoKey/);
    }
  });

  it('isRepoTarget 只认三字段齐备的对象', () => {
    expect(isRepoTarget({ owner: 'a', repo: 'b', baseBranch: 'main' })).toBe(true);
    expect(isRepoTarget({ owner: 'a', repo: 'b' })).toBe(false);
    expect(isRepoTarget(null)).toBe(false);
  });
});

describe('AC-5：target 里不得混进本机路径', () => {
  it('looksLikeLocalPath 覆盖 盘符 / UNC / POSIX 绝对 / 含反斜杠', () => {
    expect(looksLikeLocalPath('D:/code/x')).toBe(true);
    expect(looksLikeLocalPath('D:\\code\\x')).toBe(true);
    expect(looksLikeLocalPath('\\\\server\\share')).toBe(true);
    expect(looksLikeLocalPath('/home/user/x')).toBe(true);
    // 逻辑标识不得被误判
    expect(looksLikeLocalPath('example-org/sample-target')).toBe(false);
    expect(looksLikeLocalPath('main')).toBe(false);
  });

  it('assertLogicalTarget 对含路径的任一字段抛错，且说明为什么', () => {
    expect(() => assertLogicalTarget({ owner: 'D:/code/x', repo: 'r', baseBranch: 'main' })).toThrow(
      /含本机路径[\s\S]*快照[\s\S]*跨进程 resume/
    );
    expect(() => assertLogicalTarget({ owner: 'o', repo: 'r', baseBranch: 'C:\\code\\x' })).toThrow(/含本机路径/);
    // 合法 target 不抛
    expect(() => assertLogicalTarget({ owner: 'o', repo: 'r', baseBranch: 'main' })).not.toThrow();
  });

  it('注册表的键也必须是逻辑标识（不允许用路径当键）', () => {
    writeRegistry({ 'D:/code/clone-a': { localPath: rootA } });
    expect(() => loadRegistry()).toThrow(/必须是逻辑标识/);
  });
});

describe('注册表读取：缺失/非法一律显式报错（不降级为空表）', () => {
  it('文件不存在 → 抛错并提示配置方式', () => {
    process.env.REPO_REGISTRY_PATH = path.join(tmpDir, 'not-there.json');
    expect(() => loadRegistry()).toThrow(/仓库注册表不存在/);
  });

  it('JSON 非法 → 抛错', () => {
    const p = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(p, '{ this is not json', 'utf8');
    process.env.REPO_REGISTRY_PATH = p;
    expect(() => loadRegistry()).toThrow(/JSON 解析失败/);
  });

  it('结构不符（没有 repos 对象）→ 抛错并写出期望结构', () => {
    const p = path.join(tmpDir, 'wrong.json');
    fs.writeFileSync(p, JSON.stringify({ repositories: {} }), 'utf8');
    process.env.REPO_REGISTRY_PATH = p;
    expect(() => loadRegistry()).toThrow(/期望 \{"repos"/);
  });

  it('条目缺 localPath → 抛错', () => {
    writeRegistry({ 'o/r': { baseBranch: 'main' } });
    expect(() => loadRegistry()).toThrow(/缺少 localPath/);
  });

  it('registryFilePath 默认取 cwd 下的 repos.registry.json，可被 env 覆盖', () => {
    expect(registryFilePath()).toBe(path.resolve(process.cwd(), 'repos.registry.json'));
    process.env.REPO_REGISTRY_PATH = 'X:/custom/reg.json';
    expect(registryFilePath()).toBe('X:/custom/reg.json');
  });

  it('registrySummary 刻意不含 localPath（本机路径不进日志）', () => {
    writeRegistry({ 'a/b': { localPath: rootA } });
    const s = registrySummary();
    expect(s.exists).toBe(true);
    expect(s.keys).toEqual(['a/b']);
    expect(JSON.stringify(s)).not.toContain(rootA);
  });
});

describe('AC-10：未知 repoKey 显式失败，绝不静默回退', () => {
  it('resolveRepoEntry 报出未知 key 与已知候选', () => {
    writeRegistry({ 'example-org/sample-target': { localPath: rootA } });
    expect(() => resolveRepoEntry(targetB)).toThrow(/未知 repoKey：local\/repo-b[\s\S]*example-org\/sample-target/);
    expect(() => resolveRepoEntry(targetB)).toThrow(/刻意不回退/);
  });

  it('即便旧 env 配得完完整整，未知 target 也不会被 env 顶替', () => {
    process.env.CODING_REPO_ROOT = rootA;
    process.env.GITHUB_OWNER = 'example-org';
    process.env.GITHUB_REPO = 'sample-target';
    writeRegistry({ 'example-org/sample-target': { localPath: rootA } });
    // target 指向的仓库没登记 → 必须报错，不能"顺手"用 env 里那个仓库
    expect(() => repoRoot(targetB)).toThrow(/未知 repoKey/);
  });

  it('listRepoKeys 排序返回', () => {
    writeRegistry({ 'z/z': { localPath: rootA }, 'a/a': { localPath: rootB } });
    expect(listRepoKeys()).toEqual(['a/a', 'z/z']);
  });
});

describe('两个 target 各自解析出各自的 root / 配置（AC-4 的解析面）', () => {
  beforeEach(() => {
    writeRegistry({
      'example-org/sample-target': { localPath: rootA },
      'local/repo-b': { localPath: rootB, baseBranch: 'trunk' },
    });
  });

  it('repoRoot(target) 指向各自的本地 clone', () => {
    expect(repoRoot({ owner: 'example-org', repo: 'sample-target', baseBranch: 'main' })).toBe(rootA);
    expect(repoRoot(targetB)).toBe(rootB);
    expect(repoRoot(targetB)).not.toBe(repoRoot({ owner: 'example-org', repo: 'sample-target', baseBranch: 'main' }));
  });

  it('getGithubConfig(target) 的 owner/repo/baseBranch 全部来自 target（不再从 env/git remote 猜）', () => {
    process.env.GITHUB_TOKEN = 'test-token';
    const a = getGithubConfig({ owner: 'example-org', repo: 'sample-target', baseBranch: 'main' });
    const b = getGithubConfig(targetB);
    expect(a).toMatchObject({ owner: 'example-org', repo: 'sample-target', baseBranch: 'main' });
    expect(b).toMatchObject({ owner: 'local', repo: 'repo-b', baseBranch: 'trunk' });
    expect(a!.owner).not.toBe(b!.owner);
    expect(a!.baseBranch).not.toBe(b!.baseBranch);
  });

  it('注册表 localPath 指向不存在的目录 → 显式报错（不悄悄回退）', () => {
    writeRegistry({ 'local/repo-b': { localPath: path.join(tmpDir, 'gone'), baseBranch: 'trunk' } });
    expect(() => repoRoot(targetB)).toThrow(/目录不存在/);
  });

  it('注册表 localPath 不是 git 仓库 → 显式报错', () => {
    const notRepo = path.join(tmpDir, 'not-a-repo');
    fs.mkdirSync(notRepo, { recursive: true });
    writeRegistry({ 'local/repo-b': { localPath: notRepo, baseBranch: 'trunk' } });
    expect(() => repoRoot(targetB)).toThrow(/不是 git 仓库/);
  });

  it('baseBranch 两处配置矛盾 → 显式报错，不静默取其一', () => {
    expect(() => resolveRepoEntry({ owner: 'local', repo: 'repo-b', baseBranch: 'main' })).toThrow(
      /baseBranch 配置矛盾[\s\S]*不静默取其一/
    );
  });
});

describe('resolveRepoTarget —— 「没指定基线」由注册表回答', () => {
  // 这一组的由来：2026-09-26 服务器首次真跑，`dev_start` 回了「已开始」，
  // 状态页与 run_status 里却一条记录都没有 —— parseRepoTarget 的默认参数把
  // 「调用方没说」压成了「调用方要 main」，与注册表声明的 trunk/master 冲突，
  // 而冲突发生在被 detached 拉起的子进程里。**假成功比直接报错贵得多。**
  beforeEach(() => {
    writeRegistry({ 'local/repo-b': { localPath: rootB, baseBranch: 'trunk' } });
  });

  it('调用方没给基线 → 取注册表声明的那个，而不是默认的 main', () => {
    expect(resolveRepoTarget('local/repo-b')).toEqual({
      owner: 'local',
      repo: 'repo-b',
      baseBranch: 'trunk',
    });
  });

  it('解析结果可直接过 resolveRepoEntry —— 不再撞「两处配置矛盾」（回归判据）', () => {
    expect(() => resolveRepoEntry(resolveRepoTarget('local/repo-b'))).not.toThrow();
  });

  it('调用方显式给的基线优先；注册表若与它不同，仍照旧报错（安全规则不动）', () => {
    const t = resolveRepoTarget('local/repo-b', 'release');
    expect(t.baseBranch).toBe('release');
    expect(() => resolveRepoEntry(t)).toThrow(/baseBranch 配置矛盾/);
  });

  it('注册表存在但未声明 baseBranch → 退回默认基线', () => {
    writeRegistry({ 'local/repo-b': { localPath: rootB } });
    expect(resolveRepoTarget('local/repo-b').baseBranch).toBe('main');
  });

  it('key 不在表里 → 解析层不吞掉，交给 resolveRepoEntry 报「未知 repoKey」', () => {
    const t = resolveRepoTarget('ghost/repo');
    expect(t.baseBranch).toBe('main');
    expect(() => resolveRepoEntry(t)).toThrow(/未知 repoKey/);
  });

  it('注册表文件缺失 → 显式抛错（不降级为空表）', () => {
    fs.rmSync(registryFilePath(), { force: true });
    expect(() => resolveRepoTarget('local/repo-b')).toThrow(/注册表不存在/);
  });
});

describe('旧 env 与注册表冲突检测（只在「同一个仓库」时比对）', () => {
  const targetA: RepoTarget = { owner: 'example-org', repo: 'sample-target', baseBranch: 'main' };

  it('env 指向同一仓库但路径不同 → 报错（两处各说各话是红线失效的成因）', () => {
    process.env.CODING_REPO_ROOT = rootB; // 故意指到 B 的 clone
    process.env.GITHUB_OWNER = 'example-org';
    process.env.GITHUB_REPO = 'sample-target';
    writeRegistry({ 'example-org/sample-target': { localPath: rootA } });
    expect(() => repoRoot(targetA)).toThrow(/仓库配置矛盾/);
  });

  it('env 指向同一仓库但 base 不含 target 的基线 → 报错', () => {
    process.env.CODING_REPO_ROOT = rootA;
    process.env.GITHUB_OWNER = 'example-org';
    process.env.GITHUB_REPO = 'sample-target';
    process.env.GITHUB_BASE_BRANCH = 'main,release';
    writeRegistry({ 'example-org/sample-target': { localPath: rootA, baseBranch: 'trunk' } });
    expect(() => repoRoot({ owner: 'example-org', repo: 'sample-target', baseBranch: 'trunk' })).toThrow(
      /baseBranch 是 trunk/
    );
  });

  it('env 指的是**别的**仓库 → 不比对（否则多仓库下必然误报）', () => {
    process.env.CODING_REPO_ROOT = rootA;
    process.env.GITHUB_OWNER = 'example-org';
    process.env.GITHUB_REPO = 'sample-target';
    process.env.GITHUB_BASE_BRANCH = 'main';
    writeRegistry({ 'local/repo-b': { localPath: rootB, baseBranch: 'trunk' } });
    // targetB 与 env 说的不是同一个仓库 → 不该因 base 不同（main vs trunk）而报错
    expect(repoRoot(targetB)).toBe(rootB);
  });
});

describe('AC-7：红线必须 per-target（base 改名的仓库上不得静默失效）', () => {
  it('target.baseBranch 进入受保护分支集合', () => {
    expect(resolveProtectedBranchNames(targetB)).toContain('trunk');
  });

  it('不传 target 时只有 env（= M4 行为），不会凭空多出 trunk', () => {
    process.env.GITHUB_BASE_BRANCH = 'main';
    expect(resolveProtectedBranchNames()).toEqual(['main']);
    expect(resolveProtectedBranchNames()).not.toContain('trunk');
  });

  it('取并集：env 与 target 都给时两边都在（保护范围只增不减）', () => {
    process.env.GITHUB_BASE_BRANCH = 'main,release';
    expect(resolveProtectedBranchNames(targetB).sort()).toEqual(['main', 'release', 'trunk']);
  });

  it('env 留空 + target 存在 → 仍然保护 target.baseBranch', () => {
    expect(resolveProtectedBranchNames(targetB)).toEqual(['trunk']);
  });

  it('target.baseBranch 与 env 重复时去重', () => {
    process.env.GITHUB_BASE_BRANCH = 'trunk';
    expect(resolveProtectedBranchNames(targetB)).toEqual(['trunk']);
  });
});

describe('AC-6：不传 target 时行为与 M4 逐字一致', () => {
  it('repoRoot() 取 CODING_REPO_ROOT', () => {
    process.env.CODING_REPO_ROOT = rootA;
    expect(repoRoot()).toBe(rootA);
  });

  it('CODING_REPO_ROOT 不存在 → 沿用 M2 的显式报错', () => {
    process.env.CODING_REPO_ROOT = path.join(tmpDir, 'nope');
    expect(() => repoRoot()).toThrow(/CODING_REPO_ROOT 指向的目录不存在/);
  });

  it('getGithubConfig() 仍然优先 env 的 owner/repo', () => {
    process.env.GITHUB_TOKEN = 't';
    process.env.GITHUB_OWNER = 'env-owner';
    process.env.GITHUB_REPO = 'env-repo';
    process.env.GITHUB_BASE_BRANCH = 'release';
    expect(getGithubConfig()).toMatchObject({
      owner: 'env-owner',
      repo: 'env-repo',
      baseBranch: 'release',
    });
  });

  it('不传 target 时**完全不读注册表**（注册表坏掉也不影响单仓库模式）', () => {
    process.env.CODING_REPO_ROOT = rootA;
    process.env.REPO_REGISTRY_PATH = path.join(tmpDir, 'broken.json'); // 不存在
    expect(repoRoot()).toBe(rootA); // 不该抛错
    expect(getGithubConfig()).toBeNull(); // 无 token；同样没读注册表
  });
});
