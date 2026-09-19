import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitDiffForCommit, renderUntrackedDiff } from '../src/adapters/github';

/**
 * 未跟踪新文件的「内容」必须进 diff。
 *
 * ## 为什么这个文件存在（2026-09-19，真跑暴露的静默失效）
 *
 * `git diff HEAD` **看不见未跟踪文件** —— 旧实现只把文件名列一行，于是闸门收到的
 * 是「有这么个文件」而不是「文件里写了什么」。后果不是报错，而是**闸门恒判负**：
 * 需求「新增 src/greet.js」→ agent 写了、内容也对 → 闸门仍答 `requirementMet=false`，
 * 因为它没法确认那个函数是否真的导出了。
 *
 * 一次真实端到端跑出的原话（DeepSeek 闸门）：
 * 「当前 diff 仅包含 README.md 8 行新增，src/greet.js 仅以未跟踪文件形式列出，
 *   实际文件内容/是否导出 greet 函数不可见，依据现有改动无法确认该模块已实现」
 * —— 判负是对的，**输入是错的**。而「新增文件」是本项目的核心用例。
 *
 * 这些用例钉的就是这条：**新增文件的内容必须出现在闸门看到的 diff 里**。
 */

const TMP_REPOS: string[] = [];

/** 造一个带一次提交的临时 git 仓库（默认分支 main）。 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pral-diff-'));
  TMP_REPOS.push(dir);
  const g = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.email', 'test@local']);
  g(['config', 'user.name', 'test']);
  writeFileSync(join(dir, 'README.md'), '# seed\n');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'chore: seed']);
  return dir;
}

/** 写一个文件（自动建父目录）。 */
function write(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

afterEach(() => {
  while (TMP_REPOS.length) {
    try {
      rmSync(TMP_REPOS.pop()!, { recursive: true, force: true });
    } catch {
      /* 临时目录，失败不影响判定 */
    }
  }
});

describe('renderUntrackedDiff', () => {
  it('没有未跟踪文件时返回空，不产出噪音', () => {
    const dir = makeRepo();
    const r = renderUntrackedDiff(dir, [], 4000);
    expect(r.text).toBe('');
    expect(r.summary).toBe('');
    expect(r.truncated).toBe(false);
  });

  it('把新文件渲染成 git 形状的 new-file diff，并带上每一行内容', () => {
    const dir = makeRepo();
    write(dir, 'src/greet.js', "module.exports = function greet(name) {\n  return 'Hi, ' + name;\n};\n");

    const r = renderUntrackedDiff(dir, ['src/greet.js'], 4000);

    // 形状：让闸门的 LLM 按它已经熟悉的 new-file diff 读
    expect(r.text).toContain('diff --git a/src/greet.js b/src/greet.js');
    expect(r.text).toContain('new file mode 100644');
    expect(r.text).toContain('--- /dev/null');
    expect(r.text).toContain('+++ b/src/greet.js');
    expect(r.text).toContain('@@ -0,0 +1,3 @@');

    // 内容：这才是修复的重点 —— 「写了什么」必须可见
    expect(r.text).toContain("+module.exports = function greet(name) {");
    expect(r.text).toContain("+  return 'Hi, ' + name;");
    expect(r.text).toContain('+};');

    // 统计行让闸门第一眼就知道新增了哪些文件
    expect(r.summary).toContain('[未跟踪新文件] 1 个');
    expect(r.summary).toContain('src/greet.js');
    expect(r.truncated).toBe(false);
  });

  it('空文件也给出明确内容，不留空白歧义', () => {
    const dir = makeRepo();
    write(dir, 'empty.txt', '');
    const r = renderUntrackedDiff(dir, ['empty.txt'], 4000);
    expect(r.text).toContain('@@ -0,0 +1,0 @@');
    expect(r.text).toContain('+(空文件)');
  });

  it('二进制文件不渲染内容，但必须说明「没展开」而不是静默省略', () => {
    const dir = makeRepo();
    write(dir, 'logo.bin', 'PNG\u0000\u0001\u0002binary');
    const r = renderUntrackedDiff(dir, ['logo.bin'], 4000);
    expect(r.text).not.toContain('\u0000');
    expect(r.text).toContain('logo.bin（二进制，未展开内容）');
    // 文件名仍然在统计里 —— 「有这个文件」这个事实不能被丢掉
    expect(r.summary).toContain('logo.bin');
  });

  it('过大文件不展开内容，且明确标注，不静默丢弃', () => {
    const dir = makeRepo();
    write(dir, 'huge.log', 'x'.repeat(2_000_001));
    const r = renderUntrackedDiff(dir, ['huge.log'], 4000);
    expect(r.text).toContain('过大，未展开内容');
    expect(r.truncated).toBe(true);
    expect(r.summary).toContain('huge.log');
  });

  it('预算不够时后面的文件不展开，但逐个有说明 —— 绝不静默消失', () => {
    const dir = makeRepo();
    write(dir, 'a.js', 'a\n'.repeat(500));
    write(dir, 'b.js', 'b\n'.repeat(500));
    write(dir, 'c.js', 'c\n'.repeat(500));

    const r = renderUntrackedDiff(dir, ['a.js', 'b.js', 'c.js'], 1200);

    expect(r.truncated).toBe(true);
    // 文件名一个都不能少
    for (const p of ['a.js', 'b.js', 'c.js']) expect(r.summary).toContain(p);
    // 被跳过的必须留下痕迹，否则「闸门看不见」又会退化成静默失效
    expect(r.text).toMatch(/未展开内容|已按篇幅上限截断/);
  });
});

describe('gitDiffForCommit 对未跟踪新文件的取法', () => {
  it('新文件的内容出现在 diff 里 —— 这是回归点', () => {
    const dir = makeRepo();
    write(dir, 'src/greet.js', "module.exports = { greet: (n) => `你好，${n}！` };\n");

    const { diff } = gitDiffForCommit('main', 8000, dir);

    expect(diff).toContain('src/greet.js');
    expect(diff).toContain('+module.exports = { greet: (n) => `你好，${n}！` };');
    // 旧实现只会给这个标题 + 一行路径，内容永远缺席
    expect(diff).toContain('[未跟踪的新文件 · 含内容]');
  });

  it('改动统计里也要出现新文件 —— 闸门第一眼读的就是它', () => {
    const dir = makeRepo();
    write(dir, 'src/new.js', 'export const x = 1;\n');
    const { stat } = gitDiffForCommit('main', 8000, dir);
    expect(stat).toContain('[未跟踪新文件] 1 个');
    expect(stat).toContain('src/new.js');
  });

  it('已跟踪改动的 diff 很大时，新文件内容仍有保底预算（不被挤掉）', () => {
    const dir = makeRepo();
    const g = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    // 造一个巨大的已跟踪改动，把 diff 预算吃满
    write(dir, 'README.md', 'filler line\n'.repeat(3000));
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'chore: filler']);
    write(dir, 'README.md', 'filler line changed\n'.repeat(3000));
    // 再造一个新文件 —— 它的内容不能被前面的大 diff 顶掉
    write(dir, 'src/greet.js', 'MARKER_UNTRACKED_CONTENT\n');

    const { diff, truncated } = gitDiffForCommit('main', 4000, dir);

    expect(truncated).toBe(true);
    expect(diff).toContain('MARKER_UNTRACKED_CONTENT');
  });

  it('被 .gitignore 忽略的文件不算改动，不得泄进 diff', () => {
    const dir = makeRepo();
    write(dir, '.gitignore', 'node_modules/\n*.log\n');
    write(dir, 'debug.log', 'SHOULD_NOT_APPEAR\n');
    write(dir, 'src/keep.js', 'KEEP_ME\n');

    const { diff, stat } = gitDiffForCommit('main', 8000, dir);

    expect(diff).toContain('KEEP_ME');
    expect(diff).not.toContain('SHOULD_NOT_APPEAR');
    expect(stat).not.toContain('debug.log');
  });
});
