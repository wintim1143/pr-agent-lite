/**
 * 单测：编码链的「显式覆盖」解析 —— 两个**静默失败**面。
 *
 * ## 为什么这一组存在（2026-09-19 实测定位）
 *
 * 编码链要换端点时，`CODING_ANTHROPIC_*` 原本只被注入**子进程环境变量**
 * （`buildCodingEnv`）。但 Claude Code CLI 启动时会读 `~/.claude/settings.json`
 * 的 `env` 块并应用 —— **settings 层压进程环境**。后果：
 *
 *   `CODING_ANTHROPIC_BASE_URL` 完全不生效，**且没有任何报错指向配置层**。
 *   表现是「跑起来了、但打到了另一个端点」——正是 AGENTS.md #6 说的那种
 *   「看着在跑但端点不对」，也是本项目最贵的一类假绿。
 *
 * 实测复现（本机）：进程 env 指本地假端点、`~/.claude/settings.json` 指真实代理，
 * 结果是**假端点收不到任何请求**，报错来自那个代理。改用 flag 层
 * （`Options.settings` / `--settings`）后假端点立刻收到请求。
 *
 * ## 因此本文件守两条契约
 *
 * 1. **未显式配置时不得下发 settings**（`undefined`）—— 保住「凭据由 CLI 自己解析」
 *    这条通路（2026-09-04 那次修复的灵魂）。下发一个空 `{env:{}}` 就会把用户
 *    配好的代理端点一起盖掉。
 * 2. **显式配置时必须产出一个能进 flag 层的 env** —— 这是本次修复的产物本身。
 *
 * ⚠️ 「`settings` 真的接到了 `sdkOptions` 上」无法在此单测：`getCodingAgent` 会
 * 动态加载 `claude-cli.ts`，后者静态 import 官方 SDK 的 ESM 入口，在 jest 下解析失败
 * （见 `coding-agent.ts` 的懒加载注释）。该装配由端到端实测覆盖，不在此处假装覆盖。
 *
 * ## 与「本机既有配置」的隔离
 *
 * `missingCodingCredentials()` / `describeCodingBackend()` 会读真实的
 * `~/.claude/settings.json`。所以这里**只断言由 env 驱动的方向**，不断言
 * 「机器上没配时会怎样」—— 那取决于跑测试的机器，断言它等于把环境事实写进测试。
 */
import {
  buildCodingSettings,
  buildCodingEnv,
  describeCodingBackend,
  describeCodingLimits,
  codingLimits,
  missingCodingCredentials,
} from '../src/agents/coding-agent';

const ENV_KEYS = [
  'CODING_ANTHROPIC_BASE_URL',
  'CODING_ANTHROPIC_API_KEY',
  'CODING_ANTHROPIC_AUTH_TOKEN',
  'CODING_ANTHROPIC_MODEL',
  'CODING_API_TIMEOUT_MS',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'API_TIMEOUT_MS',
  'CLAUDE_API_KEY',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('buildCodingSettings —— 显式覆盖必须走 flag 层', () => {
  it('一个 CODING_ANTHROPIC_* 都没设时返回 undefined（默认不碰用户配置）', () => {
    expect(buildCodingSettings()).toBeUndefined();
  });

  it('未显式配置时不产出一个空 env 对象（空对象会连用户端点一起盖掉）', () => {
    const r = buildCodingSettings();
    expect(r).not.toEqual({ env: {} });
  });

  it('只设 baseURL 时只含这一项', () => {
    process.env.CODING_ANTHROPIC_BASE_URL = 'http://127.0.0.1:15999';
    expect(buildCodingSettings()).toEqual({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:15999' },
    });
  });

  it('四项齐全时逐项映射为 ANTHROPIC_* 键名', () => {
    process.env.CODING_ANTHROPIC_BASE_URL = 'http://127.0.0.1:15999';
    process.env.CODING_ANTHROPIC_API_KEY = 'k-api';
    process.env.CODING_ANTHROPIC_AUTH_TOKEN = 'k-token';
    process.env.CODING_ANTHROPIC_MODEL = 'stub-model';
    expect(buildCodingSettings()).toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:15999',
        ANTHROPIC_API_KEY: 'k-api',
        ANTHROPIC_AUTH_TOKEN: 'k-token',
        ANTHROPIC_MODEL: 'stub-model',
      },
    });
  });

  it('空串视同未配置（导出的是「没设」，不是「设成了空」）', () => {
    process.env.CODING_ANTHROPIC_BASE_URL = '';
    process.env.CODING_ANTHROPIC_MODEL = '';
    expect(buildCodingSettings()).toBeUndefined();
  });

  it('只有 API_KEY 时也产出覆盖（不必依赖 baseURL 一起给）', () => {
    process.env.CODING_ANTHROPIC_API_KEY = 'k-api';
    expect(buildCodingSettings()).toEqual({ env: { ANTHROPIC_API_KEY: 'k-api' } });
  });

  it('不把 CODING_* 前缀本身泄进 settings（CLI 只认 ANTHROPIC_*）', () => {
    process.env.CODING_ANTHROPIC_BASE_URL = 'http://x';
    const keys = Object.keys(buildCodingSettings()!.env);
    expect(keys.some(k => k.startsWith('CODING_'))).toBe(false);
  });
});

describe('buildCodingEnv —— 子进程环境（仍要保留，是防御纵深）', () => {
  it('展开父进程环境（缺 PATH/HOME 子进程会直接炸）', () => {
    const env = buildCodingEnv();
    expect(typeof env.PATH).toBe('string');
    expect(env.PATH).not.toBe('');
  });

  it('默认注入 API_TIMEOUT_MS=180000', () => {
    expect(buildCodingEnv().API_TIMEOUT_MS).toBe('180000');
  });

  it('CODING_API_TIMEOUT_MS=0 时不注入（用于关闭该注入）', () => {
    process.env.CODING_API_TIMEOUT_MS = '0';
    expect(buildCodingEnv().API_TIMEOUT_MS).toBeUndefined();
  });

  it('CODING_API_TIMEOUT_MS 可覆盖默认值', () => {
    process.env.CODING_API_TIMEOUT_MS = '5000';
    expect(buildCodingEnv().API_TIMEOUT_MS).toBe('5000');
  });

  it('显式 baseURL 覆盖进程里的 ANTHROPIC_BASE_URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://old';
    process.env.CODING_ANTHROPIC_BASE_URL = 'http://new';
    expect(buildCodingEnv().ANTHROPIC_BASE_URL).toBe('http://new');
  });

  it('未显式配置时原样继承进程里的 ANTHROPIC_BASE_URL（不越俎代庖）', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://inherited';
    expect(buildCodingEnv().ANTHROPIC_BASE_URL).toBe('http://inherited');
  });
});

describe('describeCodingBackend —— 自检必须报出真正生效的那一个', () => {
  it('显式 CODING_ANTHROPIC_* 优先于进程 ANTHROPIC_*', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://from-process';
    process.env.CODING_ANTHROPIC_BASE_URL = 'http://from-coding';
    process.env.CODING_ANTHROPIC_MODEL = 'coding-model';
    const line = describeCodingBackend();
    expect(line).toContain('baseURL=http://from-coding');
    expect(line).toContain('model=coding-model');
    expect(line).not.toContain('http://from-process');
  });

  it('没有任何显式配置时回落到进程 ANTHROPIC_BASE_URL', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://only-process';
    expect(describeCodingBackend()).toContain('baseURL=http://only-process');
  });

  it('显式配置存在时凭据判为「已设置」', () => {
    process.env.CODING_ANTHROPIC_BASE_URL = 'http://x';
    expect(describeCodingBackend()).toContain('凭据=已设置');
  });
});

describe('missingCodingCredentials —— 显式覆盖必须能解掉「缺凭据」判定', () => {
  it('进程里有 ANTHROPIC_API_KEY 即视为可用', () => {
    process.env.ANTHROPIC_API_KEY = 'k';
    expect(missingCodingCredentials()).toBe(false);
  });

  it('只有 CODING_ANTHROPIC_BASE_URL 也算可用（不该再去读用户 settings）', () => {
    process.env.CODING_ANTHROPIC_BASE_URL = 'http://x';
    expect(missingCodingCredentials()).toBe(false);
  });

  it('只有 CODING_ANTHROPIC_API_KEY 也算可用', () => {
    process.env.CODING_ANTHROPIC_API_KEY = 'k';
    expect(missingCodingCredentials()).toBe(false);
  });
});

/**
 * 编码步上限（2026-09-19）。
 *
 * 起因：一次真实运行被 `Reached maximum budget ($2)` 掐断，而启动自检**没提过**
 * 有这么一个上限 —— 事后只能靠翻失败理由才知道它存在。而且这个 `$2` 是 CLI 用
 * 自带价目表算的**名义成本**，接中转站时与实际计费无关，照样能拦腰截断一次正常编码。
 *
 * 上限保留（无人值守要有失控保护），但必须**可见且同源**：自检打印它，
 * SDK 装配 / 步骤超时读的是同一个函数 —— 否则「自检说 30 轮、实际跑 20 轮」
 * 又会变成一条要翻失败理由才知道的消息。
 *
 * 这里用**注入的 env** 而不是改 `process.env`：纯函数可测，且不污染同批次的其它文件。
 */
describe('编码步上限 —— 可配置、可打印、单一来源', () => {
  it('默认值就是实测会被撞到的那三个，不藏着', () => {
    expect(codingLimits({})).toEqual({ maxTurns: 30, maxBudgetUsd: 2, timeoutMs: 600_000 });
  });

  it('三个上限都能被 env 覆盖', () => {
    const l = codingLimits({
      CODING_MAX_TURNS: '8',
      CODING_MAX_BUDGET_USD: '12.5',
      CODING_TIMEOUT_MS: '300000',
    } as NodeJS.ProcessEnv);
    expect(l).toEqual({ maxTurns: 8, maxBudgetUsd: 12.5, timeoutMs: 300_000 });
  });

  it('自检摘要里三个上限都在，且明说成本是名义值', () => {
    const line = describeCodingLimits({
      CODING_MAX_TURNS: '30',
      CODING_MAX_BUDGET_USD: '2',
      CODING_TIMEOUT_MS: '600000',
    } as NodeJS.ProcessEnv);
    expect(line).toContain('maxTurns=30');
    expect(line).toContain('maxBudgetUsd=$2');
    expect(line).toContain('timeoutMs=600000'.replace('timeoutMs=', ''));
    // 这句不能少：否则使用者会以为 $2 是账单，而去调一个无关的数字
    expect(line).toContain('与实际计费无关');
  });
});
