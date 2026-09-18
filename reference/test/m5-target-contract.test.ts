/**
 * M5b-2 单测：`target` 进共享上下文之后，仍然守住「不进本机路径」这条线。
 *
 * 覆盖 AC-5。这里断言的是 **schema 的形状**，而不是某次运行的行为 ——
 * 「这次没传路径」证明不了「这条约束存在」，而这条约束一旦被破坏，
 * 后果要到**换台机器 resume** 时才暴露（M3-5 挣来的跨进程能力静默失效）。
 */
import { z } from 'zod';
import { ContextSchema } from '../src/workflows/dev-workflow';
import { assertLogicalTarget, looksLikeLocalPath } from '../src/adapters/repo-registry';

const base = { issueNumber: 1, issueTitle: 't', issueBody: '' };

/**
 * 把 ContextSchema 转成 JSON Schema 并取出 target 的属性名。
 *
 * ⚠️ 刻意**不**用 `ContextSchema.shape.target.shape` —— `target` 是 `.optional()`，
 * 拿到的是 `ZodOptional` 而非 `ZodObject`，`.shape` 在它上面不存在（访问到 undefined）。
 * 而且走 `toJSONSchema` 顺带验证了「这个 schema 真的能转 JSON Schema」这件事本身
 * （workflow 的 inputSchema 依赖它），比只看形状更有价值。
 */
function targetJsonProperties(): Record<string, unknown> {
  const json = z.toJSONSchema(ContextSchema) as {
    properties?: Record<string, { properties?: Record<string, unknown> }>;
  };
  return json.properties?.target?.properties ?? {};
}

describe('target 的形状', () => {
  it('ContextSchema 有 target 且可选（不传 = 单仓库模式，M1–M4 行为不变）', () => {
    expect(ContextSchema.parse(base)).not.toHaveProperty('target');
    const parsed = ContextSchema.parse({ ...base, target: { owner: 'o', repo: 'r', baseBranch: 'main' } });
    expect(parsed.target).toEqual({ owner: 'o', repo: 'r', baseBranch: 'main' });
  });

  it('target 的字段恰好是 owner / repo / baseBranch 三个（多一个就多一分把本机事实写进快照的机会）', () => {
    expect(Object.keys(targetJsonProperties()).sort()).toEqual(['baseBranch', 'owner', 'repo']);
  });

  it('target 字段都是必填的非空字符串（缺 baseBranch 会让红线与 diff 基线一起失准）', () => {
    for (const broken of [{ owner: 'o' }, { owner: 'o', repo: 'r' }, { owner: 'o', repo: 'r', baseBranch: '' }]) {
      expect(() => ContextSchema.parse({ ...base, target: broken })).toThrow();
    }
  });
});

describe('AC-5：ContextSchema 里不得出现「本机路径」型的字段', () => {
  it('顶层不含任何路径语义的字段名', () => {
    const keys = Object.keys(ContextSchema.shape);
    for (const forbidden of ['localPath', 'localRoot', 'clonePath', 'cwd', 'repoRoot', 'absPath']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('序列化后的 target 不含路径分隔符形态（换台机器 resume 也不会指到不存在的目录）', () => {
    const parsed = ContextSchema.parse({ ...base, target: { owner: 'acme', repo: 'widget', baseBranch: 'main' } });
    const json = JSON.stringify(parsed.target);
    expect(json).not.toMatch(/[A-Za-z]:[\\/]/);
    expect(json).not.toContain('\\');
    // 逻辑标识里出现的斜杠只能是 owner/repo 的分隔，且不该出现绝对路径的前导斜杠
    expect(json).not.toMatch(/"\//);
  });

  it('本机路径若被塞进 target，运行时解析会显式拒绝（而不是带着它跑完）', () => {
    const smuggled = { owner: 'acme', repo: 'widget', baseBranch: 'D:\\code\\clone' };
    expect(looksLikeLocalPath(smuggled.baseBranch)).toBe(true);
    expect(() => assertLogicalTarget(smuggled)).toThrow(/含本机路径/);
  });
});

describe('为什么 schema 层不做路径 refine：必须能转成 JSON Schema', () => {
  it('ContextSchema 可成功转 JSON Schema，且 target 的结构被保留', () => {
    // ⚠️ 这条是回归护栏：workflow 的 inputSchema 需要转 JSON Schema，
    // 而 `.refine()` / `.transform()` 这类自定义校验会让转换失败或丢字段。
    // 若有人为了"在 schema 层拦路径"而加上 refine，上面的 targetJsonProperties() 会先失败。
    expect(Object.keys(targetJsonProperties()).sort()).toEqual(['baseBranch', 'owner', 'repo']);
  });
});
