/**
 * `dev_start` 触发器入参解析的单测。
 *
 * ## 为什么值得单测一个「解析参数」的函数
 *
 * 这个解析结果直接决定**在哪个仓库上动文件**。三处一旦出错，后果都不是报错而是静默走偏：
 *
 * - `target` 解析错 → 在**另一个仓库**建分支、改文件（且日志里看着一切正常）；
 * - `stopAfterCommit` 默认值错 → 忘记传参时**悄悄推远端**，而默认值本该是最保守的那个；
 * - `issue-number` 少一层校验 → 分支名里出现 `NaN`，或 commit 信息里挂一个不存在的编号。
 *
 * 所以这里断言的重点不是「能解析」，而是**这些默认值与拒绝规则确实存在**。
 */
import { parseArgs } from '../src/dev-runner';

function ok(argv: string[]) {
  const r = parseArgs(argv);
  if ('error' in r) throw new Error(`期望解析成功，实际报错：${r.error}`);
  return r.args;
}

function err(argv: string[]): string {
  const r = parseArgs(argv);
  if (!('error' in r)) throw new Error('期望解析失败，实际成功了');
  return r.error;
}

describe('dev-runner 入参解析', () => {
  it('缺少 --target 直接拒绝（不允许靠默认值猜仓库）', () => {
    expect(err(['--title=x'])).toContain('--target');
  });

  it('缺少 --title 直接拒绝', () => {
    expect(err(['--target=o/r'])).toContain('--title');
  });

  it('target 非法（不是 owner/repo）直接拒绝', () => {
    expect(err(['--target=just-a-name', '--title=x'])).toMatch(/target 格式非法|owner\/repo/);
  });

  it('默认 stopAfterCommit = true —— 忘记传参时**不做事**，而不是悄悄推远端', () => {
    expect(ok(['--target=o/r', '--title=x']).stopAfterCommit).toBe(true);
  });

  it('--allow-remote 才关闭 stopAfterCommit', () => {
    expect(ok(['--target=o/r', '--title=x', '--allow-remote']).stopAfterCommit).toBe(false);
  });

  it('显式 issue-number 原样采用；非整数/负数被拒', () => {
    expect(ok(['--target=o/r', '--title=x', '--issue-number=42']).issueNumber).toBe(42);
    expect(err(['--target=o/r', '--title=x', '--issue-number=abc'])).toContain('非负整数');
    expect(err(['--target=o/r', '--title=x', '--issue-number=-1'])).toContain('非负整数');
  });

  it('不传 issue-number 时自动生成一个正整数（分支名里不能出现 NaN）', () => {
    const n = ok(['--target=o/r', '--title=x']).issueNumber;
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
  });

  it('调用方给的 run-id 原样采用（否则日志与触发请求对不上）', () => {
    expect(ok(['--target=o/r', '--title=x', '--run-id=run-abc']).runId).toBe('run-abc');
  });

  it('不传 run-id 时自动生成，且两次不重复', () => {
    const a = ok(['--target=o/r', '--title=x']).runId;
    const b = ok(['--target=o/r', '--title=x']).runId;
    expect(a).not.toBe(b);
    expect(a.startsWith('run-')).toBe(true);
  });

  it('base-branch 可覆盖，缺省时为注册表默认值（main）', () => {
    expect(ok(['--target=o/r', '--title=x']).target.baseBranch).toBe('main');
    expect(ok(['--target=o/r', '--title=x', '--base-branch=develop']).target.baseBranch).toBe('develop');
  });

  it('--body 缺省为空串（而不是 undefined —— 下游 schema 要 string）', () => {
    expect(ok(['--target=o/r', '--title=x']).issueBody).toBe('');
    expect(ok(['--target=o/r', '--title=x', '--body=hello']).issueBody).toBe('hello');
  });

  it('忽略非 -- 开头的参数（argv[0]/[1] 是 node 与脚本路径）', () => {
    const a = ok(['/usr/bin/node', '/x/dev-runner.js', '--target=o/r', '--title=x']);
    expect(a.target.owner).toBe('o');
  });
});
