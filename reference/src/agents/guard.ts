import path from 'node:path';

/**
 * 编码执行体的权限围栏 —— 判定「某次工具调用该不该放行」。
 *
 * ## 为什么必须有这一层
 *
 * `coding` 步跑的是 `ClaudeSDKAgent`（Claude Code CLI），它真能读写文件、执行 shell。
 * 若不加约束，一次失控的编码就可能改写 workflow 本体、改掉本文件的拦截规则，
 * 或把 `.env` 里的凭据带走。围栏是「先关笼子再放 agent」的那一层笼子。
 *
 * ## 为什么用 PreToolUse hook，而不是 canUseTool
 *
 * claude-agent-sdk 源码（`sdk.mjs`，函数 `zKe`）里有一句官方警告，原文：
 *
 * > `canUseTool will not be invoked: permissionMode 'bypassPermissions' auto-approves
 * > every tool call (except explicit deny rules) before the callback is consulted.
 * > To gate every tool call, use a PreToolUse hook instead.`
 *
 * 即：在 `bypassPermissions` 下 `canUseTool` 回调**根本不会被调用**。
 * 唯一能拦住每一次工具调用的是 PreToolUse hook —— 本模块就是它的判定内核。
 * 因此即便将来把 permissionMode 调回 `bypassPermissions`，本拦截依然生效。
 *
 * ## 设计边界
 *
 * 本模块是**纯函数**：输入 (工具名, 工具入参)，输出放行/拒绝。不 import 任何 SDK、
 * 不做 IO、不读 env，因此可以在 jest 里直接单测，也是唯一能被信任的拦截点。
 */

/**
 * 受保护路径 —— 自举期间 agent 不得写入（依据 `12-自动开发Agent任务列表与验收标准.md` §83）。
 *
 * 为什么是这些：它们定义了「流水线自身的行为」，一旦可被 agent 改写，
 * 所有闸门与红线都失去意义（agent 可以直接把校验逻辑删掉）。
 *
 * 匹配规则：
 * - `exact` 家族：与相对路径**精确相等**，或以该前缀 + `/` 开头（目录语义）。
 *   适用于目录（`.github`、`src/...`）与单体文件（`agent.md`）。
 * - `family` 家族：与相对路径**精确相等**，或以该前缀 + `.` 开头（点号同族语义）。
 *   适用于会把配置拆成多个同族文件的情形（`.env` → `.env.local` / `.env.production`）。
 */
export interface ProtectedPathRule {
  path: string;
  /** 前缀语义。'exact' = 精确 / 目录前缀；'family' = 精确 / 点号同族前缀。 */
  match: 'exact' | 'family';
}
export const PROTECTED_PATHS: readonly ProtectedPathRule[] = [
  { path: 'agent.md', match: 'exact' },
  { path: '.github', match: 'exact' },
  { path: '.env', match: 'family' },
  { path: 'src/workflows', match: 'exact' },
  { path: 'src/agents', match: 'exact' },
];
/** 兼容旧签名：仅返回受保护路径字符串（供测试/日志快速引用）。 */
export const PROTECTED_PATH_STRINGS: readonly string[] = PROTECTED_PATHS.map(p => p.path);

/** 会写入文件的工具，及其入参里承载路径的字段名。 */
const WRITE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
};

/**
 * 默认受保护分支 —— 禁止 agent 直接 push 到这些分支(`agent.md` git 红线第 2 条)。
 *
 * ## 为什么是可注入的,而不是写死在正则里(M3-6,2026-09-15)
 *
 * 原实现把分支名硬编码成 `(?:main|master)`,但本项目的 base 分支由
 * `GITHUB_BASE_BRANCH` 决定(靶场仓库可用任意名)。只要它不叫 main/master,
 * 「禁直推 base」这条拦截就**静默失效** —— 不报错、不告警,只是不再拦。
 * 围栏的失效必须是显式的,所以改为可注入:调用方把实际 base 分支传进来。
 *
 * ⚠️ **传入项只增不减**:`resolveProtectedBranches()` 取并集,不可能靠传参
 * 把 main/master 移出保护名单 —— 防止「配置写错 → 保护范围缩水」这类
 * 「看起来配了、其实裸奔」的失败形态。
 */
export const DEFAULT_PROTECTED_BRANCHES: readonly string[] = ['main', 'master'];

/** 合并调用方传入的分支与默认值(并集、去重、剔除空白项)。 */
export function resolveProtectedBranches(extra?: readonly string[]): string[] {
  const set = new Set<string>(DEFAULT_PROTECTED_BRANCHES);
  for (const b of extra ?? []) {
    const t = typeof b === 'string' ? b.trim() : '';
    if (t) set.add(t);
  }
  return [...set];
}

/** 转义分支名里的正则元字符(如 `release/1.0` 的 `.`、`hotfix+v2` 的 `+`)。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 危险 shell 命令模式。
 *
 * 每条都对应 `agent.md` 的一条红线或一类不可逆损害。分两个维度:
 *
 * ### 本地维度(原有)
 * - force push / 直推 main:git 红线第 2 条
 * - reset --hard / clean -fd:丢弃未提交工作,不可逆
 * - rm -rf:不可逆删除
 * - 写 .git/ 内部:绕过所有 git 层保护
 *
 * ### 远端维度(M3-6 新增,2026-09-15)
 *
 * 动因:M2 之前流程只写本地,「不可逆」的边界就在本机。M3 起会真 push、真开 PR,
 * 于是**远端不可逆操作**成了新的风险面 —— 而原危险命令表只覆盖了 force push 与
 * 直推 main 两条,以下全部漏网:
 * - `--mirror` / `--all` / `--tags`:把本地全部 ref 同步到远端(或反向删远端 ref)
 * - `--prune`:删除远端有而本地没有的分支 —— 一次命令清掉别人的分支
 * - `-d` / `--delete` / 空 refspec(`git push origin :branch`):删远端分支
 * - `git remote set-url|rename|remove|set-head`:篡改远端指向或默认分支
 * - `gh repo edit|delete`:改远端仓库设置(含默认分支)
 *
 * @param protectedBranches 受保护分支名(通常来自 `GITHUB_BASE_BRANCH` 与默认值的并集)
 */
function buildDangerousCommands(
  protectedBranches: readonly string[]
): ReadonlyArray<{ pattern: RegExp; reason: string }> {
  const branchAlt = protectedBranches.map(escapeRegExp).join('|');
  /**
   * 直推受保护分支的检测。
   *
   * 只认**出现在 refspec 位置**的分支名,不做全文子串匹配。
   * 反例(原实现的真实缺陷):`git push origin feat/add-main-section` —— 分支名里
   * 嵌了 `main`,`-` 是词边界,于是 `\bmain\b` 命中,**正常推自己的分支被误拦**。
   *
   * 本正则要求 base 名满足:
   *   - 前面是空白(token 起点),之前至多允许一个 `+`(force refspec)与 `src:`(src:dst 形态)
   *   - 允许 `refs/heads/` 前缀(`HEAD:refs/heads/main` 形态)
   *   - 后面是空白或行尾(`main-x` / `main.py` 不算)
   *
   * 因此 `feat/add-main-section`(前缀是 `-`)、`feature/main`(前缀是 `/`)都不命中。
   */
  const pushProtected = new RegExp(
    `\\bgit\\s+push\\b[^\\n]*?\\s\\+?(?:[^\\s:]+:)?(?:refs/heads/)?(?:${branchAlt})(?=\\s|$)`
  );

  return [
    // ---------- 远端维度(M3-6) ----------
    {
      // `-f` / `-fu` / `-uf` 这类短选项组合也要覆盖:原正则 `\s(?:-f|--force)\b`
      // 只认孤立的 `-f`,漏掉了 `git push -uf origin x`。
      // `--force` 同时覆盖 `--force-with-lease`(无人值守下同样不得改写远端历史)。
      pattern: /\bgit\s+push\b[^\n]*?(?:\s-[a-zA-Z]*f[a-zA-Z]*(?=\s|$)|--force)/,
      reason: '禁止 force push(含 -f 短选项组合与 --force-with-lease):无人值守下不得改写远端历史',
    },
    {
      pattern: /\bgit\s+push\b[^\n]*?--(?:mirror|prune|all|tags)\b/,
      reason:
        '禁止 git push --mirror/--all/--tags/--prune:会把本地全部 ref 同步到远端、或删除远端 ref,影响范围不可控',
    },
    {
      pattern: /\bgit\s+push\b[^\n]*?(?:\s-d(?=\s|$)|--delete\b)/,
      reason: '禁止删除远端分支(git push -d / --delete)',
    },
    {
      // 空 source refspec = 删除远端同名分支,如 `git push origin :feat/x`。
      // 要求 `:` 紧跟在空白(or `+`)之后,故 `HEAD:refs/heads/x` 不误报。
      pattern: /\bgit\s+push\b[^\n]*?\s\+?:/,
      reason: '禁止用空 refspec 删除远端分支(如 `git push origin :branch`)',
    },
    {
      pattern: /\bgit\s+remote\s+(?:remove|rm|rename|set-url|set-head|set-branches)\b/,
      reason: '禁止篡改 remote 配置(可改远端指向或默认分支)',
    },
    {
      pattern: /\bgh\s+repo\s+(?:edit|delete|rename|archive)\b/,
      reason: '禁止改动远端仓库设置(含默认分支)',
    },
    {
      pattern: pushProtected,
      reason: `禁止直推受保护分支(${protectedBranches.join(' / ')}):改动必须经人工关卡合入`,
    },
    // ---------- 本地维度(原有) ----------
    { pattern: /\bgit\s+reset\s+--hard\b/, reason: 'git reset --hard 会丢弃未提交改动,不可逆' },
    { pattern: /\bgit\s+clean\s+-[a-z]*f/, reason: 'git clean -f 会删除未跟踪文件,不可逆' },
    { pattern: /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/, reason: 'rm -rf 不可逆删除' },
    { pattern: /\bgit\s+checkout\s+(?:-B\s+)?(?:main|master)\b/, reason: '禁止切换到 main/master 分支' },
    { pattern: /\bgit\s+branch\s+-[a-zA-Z]*D\b/, reason: '禁止强制删除分支' },
    { pattern: />\s*\.git\//, reason: '禁止直接写 .git/ 内部(绕过 git 层保护)' },
    { pattern: /\b(?:gh|git)\s+auth\b/, reason: '禁止操作凭据(gh/git auth)' },
    { pattern: /\bgh\s+pr\s+(?:merge|close)\b/, reason: '合并/关闭 PR 由人工关卡负责,agent 不得越权' },
    { pattern: /\bsudo\b/, reason: '禁止提权' },
    { pattern: /\bcurl\b[^\n]*?(?:\|\s*(?:ba)?sh|\s-o\s)/, reason: '禁止下载即执行 / 下载落盘' },
  ];
}

/** shell 里「把内容写进文件」的写法 —— 命中后需再检查目标是否受保护。 */
const REDIRECT_WRITE = /(?:(?:^|[;&|]\s*)[\w./-]+\s*)?(?:>>?|tee(?:\s+-a)?)\s*([^\s;|&>]+)/g;

/**
 * 无人值守编码体禁用的工具(整工具级 deny,2026-09-07 新增)。
 *
 * - `Task` / `Agent`(新旧两版 CLI 对「派生子 agent」工具的命名):实测(2026-09-07,run
 *   fa70e07b)编码模型会在完成主任务后**自作主张派子 agent 做自我审查** —— 嵌套会话
 *   再走一遍慢速上游,直接把 CODING_TIMEOUT_MS(600s)烧完,整条流水线被守卫误杀。
 *   子 agent 也脱离了本围栏的视野(PreToolUse hook 是否对孙级会话生效无契约保证),禁止最稳。
 * - `WebFetch` / `WebSearch`:断网红线,与 coding-agent 的 disallowedTools 互为纵深
 *   (bypassPermissions 下 disallowedTools 不保证生效,hook 是唯一可靠层)。
 */
const DENY_TOOLS: Readonly<Record<string, string>> = {
  Task: '无人值守编码禁止派生子 agent(会绕过围栏视野且曾把编码超时预算烧完)',
  Agent: '无人值守编码禁止派生子 agent(会绕过围栏视野且曾把编码超时预算烧完)',
  WebFetch: '编码执行体禁止联网(防数据外泄)',
  WebSearch: '编码执行体禁止联网(防数据外泄)',
};

export type GuardDecision = { decision: 'allow' } | { decision: 'deny'; reason: string };

/**
 * 把工具入参里的路径归一化成「相对仓库根、POSIX 分隔符」的形态。
 *
 * @returns 相对路径；若落在仓库根之外则返回 `null`（调用方视作越界，应拒绝）。
 *
 * Claude Code 传来的 `file_path` 绝大多数是绝对路径，但也可能相对 `cwd`，
 * 统一先按 `repoRoot` 解析再取相对值，两种情况都能覆盖。
 */
export function normalizeRepoPath(targetPath: unknown, repoRoot: string): string | null {
  if (typeof targetPath !== 'string' || targetPath === '') return null;
  const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(repoRoot, targetPath);
  const rel = path.relative(path.resolve(repoRoot), abs);
  // 逃出仓库根（含 Windows 下跨盘符导致的绝对路径）
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** 判断归一化后的相对路径是否命中受保护清单。 */
export function isProtectedPath(relPath: string | null): boolean {
  if (!relPath) return false;
  return PROTECTED_PATHS.some(({ path: p, match }) => {
    if (relPath === p) return true;
    return match === 'exact' ? relPath.startsWith(p + '/') : relPath.startsWith(p + '.');
  });
}

/** 扫描 shell 命令里被重定向写入的目标，返回命中的受保护路径（没有则 null）。 */
function findRedirectTargetInProtected(command: string, repoRoot: string): string | null {
  REDIRECT_WRITE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REDIRECT_WRITE.exec(command)) !== null) {
    const target = m[1];
    if (!target || /^[-|]/.test(target)) continue;
    // `2>&1` 之类的 fd 重定向、以及管道右侧不是文件的情形会被上面的 [-|] 过滤掉
    const rel = normalizeRepoPath(target.replace(/^["']|["']$/g, ''), repoRoot);
    if (isProtectedPath(rel)) return rel;
  }
  return null;
}

/**
 * 判定一次工具调用是否放行 —— 围栏的唯一入口。
 *
 * @param toolName          Claude Code 工具名，如 `Write` / `Edit` / `Bash`
 * @param input            该工具调用的入参（`PreToolUseHookInput.tool_input`）
 * @param repoRoot          目标仓库根绝对路径，用于把路径归一化
 * @param protectedBranches 受保护分支（会与 `DEFAULT_PROTECTED_BRANCHES` 取并集，
 *                          见 `resolveProtectedBranches`）。缺省只用默认值。
 *                          调用方应传入实际 base 分支（如 `GITHUB_BASE_BRANCH`），
 *                          否则 base 不叫 main/master 时「禁直推 base」会静默失效。
 */
export function guardToolCall(
  toolName: string,
  input: Record<string, unknown>,
  repoRoot: string,
  protectedBranches: readonly string[] = DEFAULT_PROTECTED_BRANCHES,
): GuardDecision {
  // 0) 整工具级禁用(子 agent / 联网):与入参无关,直接拒
  const denyReason = DENY_TOOLS[toolName];
  if (denyReason) return { decision: 'deny', reason: denyReason };

  // 1) 写文件类工具：检查目标路径
  const pathFields = WRITE_TOOLS[toolName];
  if (pathFields) {
    for (const field of pathFields) {
      const rel = normalizeRepoPath(input[field], repoRoot);
      if (rel === null) {
        return { decision: 'deny', reason: `目标路径落在仓库之外，越界写入被拒（${toolName}.${field}）` };
      }
      if (isProtectedPath(rel)) {
        return { decision: 'deny', reason: `受保护路径禁止写入：${rel}（自举期 agent 不得改动流水线自身）` };
      }
    }
    return { decision: 'allow' };
  }

  // 2) Bash：先查危险命令，再查重定向写入受保护路径
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (!command) return { decision: 'allow' };

    // 惰性构建:危险命令表依赖受保护分支名,只在真正跑 Bash 时编译一次
    for (const { pattern, reason } of buildDangerousCommands(resolveProtectedBranches(protectedBranches))) {
      if (pattern.test(command)) {
        return { decision: 'deny', reason: `${reason}｜命令：${command.slice(0, 120)}` };
      }
    }

    const redirectHit = findRedirectTargetInProtected(command, repoRoot);
    if (redirectHit) {
      return { decision: 'deny', reason: `禁止通过 shell 重定向写入受保护路径：${redirectHit}` };
    }
    return { decision: 'allow' };
  }

  // 3) 其余工具(Read / Glob / Grep / TodoWrite 等只读或无害工具)放行
  return { decision: 'allow' };
}
