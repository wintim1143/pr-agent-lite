/**
 * 仓库注册表与 RepoTarget（M5b-1）。
 *
 * ## 本模块划的那条线（M5b 的灵魂，M5 卡 §1）
 *
 * | 字段 | 存进 `ContextSchema`？ | 归属 |
 * |---|---|---|
 * | `owner` / `repo` | ✅ | **逻辑标识**：跨机器稳定，是业务语义 |
 * | `baseBranch` | ✅ | 业务语义；且**红线依赖它**（读错红线会静默失效，M3 已踩过 base 改名） |
 * | `localPath` | ❌ **绝不** | **本机事实**：`ContextSchema` 会被序列化进状态库的 run 快照，而 M3-5 已实证跨进程 resume 靠快照恢复上下文 —— 把本机绝对路径写进快照，换台机器 resume 就会指向不存在的目录 |
 *
 * 所以：**target 只描述「哪个仓库」，注册表才回答「它在本机哪里」**。
 * 前者进快照，后者运行时解析。
 *
 * ## 为什么未知 repoKey 必须显式报错，绝不回退到「当前仓库」
 *
 * 回退的后果是**在错误的仓库上开 PR** —— 与 M3 的 `parseOwnerRepo(cwd?)` bug 同构
 * （未指定 cwd 导致恒解析出 `example-org/sample-app`，「push 到靶场、PR 开到主仓」且**零报错**）。
 * 同理，注册表文件缺失 / JSON 非法时也**不降级为空注册表** —— 空表会让所有多仓库场景
 * 静默退化成单仓库（M5 卡 §10 异常表）。
 *
 * ## 为什么注册表不含任何密钥
 *
 * 它只描述「仓库在本机哪里、基线是什么」。凭据仍只来自 `GITHUB_TOKEN`（与 M3/M4 一致）——
 * 配置文件一旦含 token 就必须同时进 `.gitignore` 与所有备份/同步策略，风险面显著变大。
 * 注册表**不含密钥**，所以它进 `.gitignore` 的理由只与「本机路径」有关。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 逻辑仓库标识 —— 进 `ContextSchema` 的那一半。**不含任何本机信息**。 */
export interface RepoTarget {
  owner: string;
  repo: string;
  baseBranch: string;
}

/** 本机接入信息 —— 只存在于注册表文件与本进程内存中，**不进快照、不进日志**。 */
export interface RepoEntry {
  /** 本机 clone 绝对路径 */
  localPath: string;
  /**
   * 该仓库的基线分支。**可选**：省略时以 `RepoTarget.baseBranch` 为准。
   * 两者都给出且不一致 → 显式报错（见 `resolveRepoEntry`），不静默取其一。
   */
  baseBranch?: string;
}

interface RegistryFile {
  repos?: Record<string, RepoEntry>;
}

/** 本项目自带的默认基线分支名（保持与 M3/M4 的 `'main'` 缺省一致）。 */
export const DEFAULT_BASE_BRANCH = 'main';

/** `owner/repo` → 幂等键格式（注册表键、锁键、日志维度都用它）。 */
export function repoKeyOf(t: { owner: string; repo: string }): string {
  return `${t.owner}/${t.repo}`;
}

/** `owner/repo` → RepoTarget；`baseBranch` 省略时用默认基线。 */
export function parseRepoTarget(key: string, baseBranch: string = DEFAULT_BASE_BRANCH): RepoTarget {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(key.trim());
  if (!m) {
    throw new Error(`非法 repoKey：${JSON.stringify(key)}（要求形如 "owner/repo"，且不含空格）`);
  }
  return { owner: m[1], repo: m[2], baseBranch };
}

export function isRepoTarget(v: unknown): v is RepoTarget {
  if (!v || typeof v !== 'object') return false;
  const t = v as Record<string, unknown>;
  return typeof t.owner === 'string' && typeof t.repo === 'string' && typeof t.baseBranch === 'string';
}

/**
 * 解析 repoKey，**调用方未显式给出基线时以注册表为准**（2026-09-26 实测补）。
 *
 * ## 为什么必须有这个函数，而不是直接用 `parseRepoTarget`
 *
 * `parseRepoTarget` 的默认参数把两种情况压成了同一个值：
 * 「调用方**没说要哪个**基线」与「调用方**明确要 `main`**」 —— 两者都得到 `main`。
 * 而注册表是允许声明 `baseBranch` 的，于是一旦注册表写的是 `master` 之类，
 * 就会撞上 `resolveRepoEntry` 的「两处配置矛盾」告警（那条规则本身是对的，不能松）。
 *
 * 实测症状（服务器首次真跑）：`dev_start` 返回「已开始」，状态页与 `run_status`
 * 里却**一条记录都没有** —— 因为冲突发生在**被 detached 拉起的子进程**里，
 * 调用方拿到的只是一句「已开始」。**假成功比直接报错贵得多。**
 *
 * ## 优先级
 *
 * **显式入参 > 注册表 `entry.baseBranch` > `DEFAULT_BASE_BRANCH`**
 *
 * ⚠️ 显式入参仍然优先，且注册表若与它不同，`resolveRepoEntry` 照旧报错 ——
 * 本条只解决「没指定」的归属，不动「指定了就不许含糊」这条安全规则。
 *
 * @throws 注册表缺失 / JSON 非法 / 结构不符（`loadRegistry` 一律抛错，不降级为空表）
 */
export function resolveRepoTarget(key: string, explicitBaseBranch?: string): RepoTarget {
  const bare = parseRepoTarget(key);
  const explicit = explicitBaseBranch?.trim();
  if (explicit) return { ...bare, baseBranch: explicit };

  const entry = loadRegistry()[repoKeyOf(bare)];
  const fromRegistry = entry?.baseBranch?.trim();
  // 注册表存在但没声明 baseBranch、或 key 根本不在表里 → 退回默认基线；
  // 「key 不在表里」由 `resolveRepoEntry` 显式报错（未知 repoKey），不在这里吞掉。
  return { ...bare, baseBranch: fromRegistry || DEFAULT_BASE_BRANCH };
}

/**
 * 判定一个字符串是否像**本机路径**（而不是逻辑标识）。
 *
 * 用于两条防线：
 * 1. `ContextSchema.target` 的运行时 refine —— 把「不小心把 localPath 塞进快照」变成
 *    **立即可见的报错**，而不是换台机器 resume 时才发现的怪现象；
 * 2. `repoKeyOf` 的输入校验 —— 注册表键必须是逻辑标识。
 */
export function looksLikeLocalPath(v: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(v)) return true; // Windows 盘符
  if (/^\\\\/.test(v)) return true; // UNC
  if (v.startsWith('/')) return true; // POSIX 绝对路径
  if (v.includes('\\')) return true; // 含反斜杠（逻辑标识不可能含）
  return false;
}

/**
 * 断言「target 里没有混进本机路径」。
 * 违反时的报错文案刻意写清**为什么**，避免后人为了「跑通」把校验删掉。
 */
export function assertLogicalTarget(t: RepoTarget): void {
  for (const [k, v] of Object.entries(t)) {
    if (looksLikeLocalPath(v)) {
      throw new Error(
        `RepoTarget.${k} 含本机路径（${v}）。target 必须只含逻辑标识（owner/repo/baseBranch）：` +
          `它会被序列化进 workflow 快照，写路径会让 run 绑定到某台机器的文件系统（破坏 M3-5 的跨进程 resume）。` +
          `本机路径请放进仓库注册表。`
      );
    }
  }
}

/** 注册表文件路径：`REPO_REGISTRY_PATH` 优先，否则取进程 cwd 下的 `repos.registry.json`。 */
export function registryFilePath(): string {
  const p = process.env.REPO_REGISTRY_PATH?.trim();
  return p || resolve(process.cwd(), 'repos.registry.json');
}

/**
 * 读取注册表。
 * ⚠️ 文件缺失 / 非法 JSON / 结构不符 → **一律抛错**（不返回空表，见文件头）。
 */
export function loadRegistry(): Record<string, RepoEntry> {
  const path = registryFilePath();
  if (!existsSync(path)) {
    throw new Error(
      `仓库注册表不存在：${path}（多仓库模式下必须显式配置；` +
        `设 REPO_REGISTRY_PATH 或在该位置放 repos.registry.json）。` +
        `⚠️ 这里刻意不降级为空注册表 —— 空表会让多仓库场景静默退化成单仓库。`
    );
  }
  let parsed: RegistryFile;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as RegistryFile;
  } catch (e) {
    throw new Error(`仓库注册表 JSON 解析失败：${path} → ${e instanceof Error ? e.message : String(e)}`);
  }
  const repos = parsed?.repos;
  if (!repos || typeof repos !== 'object' || Array.isArray(repos)) {
    throw new Error(`仓库注册表结构不符：${path} 期望 {"repos": { "<owner>/<repo>": { "localPath": "..." } }}`);
  }
  for (const [key, entry] of Object.entries(repos)) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`仓库注册表条目非法：${key} → ${JSON.stringify(entry)}`);
    }
    if (typeof entry.localPath !== 'string' || !entry.localPath.trim()) {
      throw new Error(`仓库注册表条目缺少 localPath：${key}`);
    }
    if (looksLikeLocalPath(key)) {
      throw new Error(`仓库注册表键必须是逻辑标识 owner/repo，但得到本机路径：${key}`);
    }
  }
  return repos;
}

/**
 * 解析 target → 本机接入信息。
 *
 * @throws 注册表缺失/非法（`loadRegistry`）、key 未知、或 baseBranch 两处配置互相矛盾
 */
export function resolveRepoEntry(target: RepoTarget): RepoEntry {
  assertLogicalTarget(target);
  const key = repoKeyOf(target);
  const repos = loadRegistry();
  const entry = repos[key];
  if (!entry) {
    throw new Error(
      `未知 repoKey：${key}。已知：${Object.keys(repos).sort().join(', ') || '(空)'}。` +
        `⚠️ 刻意不回退到「当前仓库」或任一默认仓库 —— 静默回退会在错误的仓库上开 PR。`
    );
  }
  if (entry.baseBranch && entry.baseBranch !== target.baseBranch) {
    throw new Error(
      `baseBranch 配置矛盾：target 说 ${target.baseBranch}，注册表 ${key} 说 ${entry.baseBranch}。` +
        `两者描述的是同一个仓库，必须一致；此处刻意不静默取其一（取错会让红线静默失效）。`
    );
  }
  return entry;
}

/** 注册表里已登记的 repoKey（排序）。 */
export function listRepoKeys(): string[] {
  return Object.keys(loadRegistry()).sort();
}

/**
 * 注册表摘要，**刻意不含 localPath**。
 *
 * 供日志与错误提示使用：本机路径属于「某台机器的事实」，
 * 打进日志会让日志在不同机器上无法比对，也容易泄漏目录结构。
 */
export function registrySummary(): { path: string; exists: boolean; keys: string[] } {
  const path = registryFilePath();
  if (!existsSync(path)) return { path, exists: false, keys: [] };
  return { path, exists: true, keys: listRepoKeys() };
}
