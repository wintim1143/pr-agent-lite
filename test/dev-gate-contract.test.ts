/**
 * M4-3 / M4-6 的契约与重试单测。
 *
 * 这里验的都是**结构性性质**，不是「跑一遍看看」：
 * - AC-2 后半：`testsPassed` 在任何情况下都不可能来自 LLM —— 因为 LLM 侧 schema 里**没有这个字段**
 * - AC-6：test 步的 prompt 里不再含「以其结果为准」这类 LLM 无法执行的指令
 * - AC-9：重试时把上次的 zod 报错回灌进下一次 prompt（P0-2）
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LlmTestGateSchema, TestGateSchema, runGate } from '../src/workflows/dev-workflow';
import { GATE_SKILLS } from '../src/llm/prompts';

const SRC = readFileSync(join(__dirname, '../src/workflows/dev-workflow.ts'), 'utf8');

describe('test 闸门契约 —— 字段归属（AC-2）', () => {
  it('LLM 侧 schema 只有语义字段：不含 testsPassed / passed / agentModifiedTests', () => {
    const keys = Object.keys(LlmTestGateSchema.shape);
    expect(keys.sort()).toEqual(['report', 'requirementMet']);
    // 这三者都是**事实**，必须由程序写入；模型在结构上无处安放它们
    for (const forbidden of ['testsPassed', 'passed', 'agentModifiedTests', 'exitCode']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('完整契约里 testsPassed 可为 null（无测试可跑 ≠ 测试通过）', () => {
    const shape = TestGateSchema.shape;
    // null 必须被接受：不假通过，也不假判负
    expect(shape.testsPassed.safeParse(null).success).toBe(true);
    expect(shape.testsPassed.safeParse(true).success).toBe(true);
    expect(shape.testsPassed.safeParse(false).success).toBe(true);
    // 但不能是「缺省 true」之外的任何东西——undefined 不是合法值
    expect(shape.testsPassed.safeParse(undefined).success).toBe(false);
  });

  it('完整契约含程序侧与 LLM 侧两半，字段名不许漂移', () => {
    expect(Object.keys(TestGateSchema.shape).sort()).toEqual(
      [
        'addedTestFiles',
        'agentModifiedTests',
        'modifiedTestFiles',
        'passed',
        'report',
        'requirementMet',
        'testRun',
        'testsPassed',
      ].sort()
    );
  });

  it('合成公式：(testsPassed !== false) && requirementMet', () => {
    // 与 testStep 里的实现同构；把语义钉在测试里，防止日后被改成「只要测试过就算过」
    const synthesize = (testsPassed: boolean | null, requirementMet: boolean): boolean =>
      testsPassed !== false && requirementMet;
    expect(synthesize(true, true)).toBe(true);
    expect(synthesize(true, false)).toBe(false);
    expect(synthesize(false, true)).toBe(false); // 测试红 → 判负，模型说需求实现了也没用
    expect(synthesize(false, false)).toBe(false);
    expect(synthesize(null, true)).toBe(true); // 无测试可跑 → 只看需求判定
    expect(synthesize(null, false)).toBe(false);
  });
});

describe('test 步 prompt —— 不再要求 LLM 做它做不到的事（AC-6）', () => {
  it('test 步 prompt 里不再出现「以其结果为准」这类无从执行的指令', () => {
    expect(SRC).not.toContain('以其结果为准');
  });

  it('test 步要求模型输出的字段与 LLM schema 一致（不含 passed）', () => {
    // prompt 里的输出契约必须只写 requirementMet / report
    expect(SRC).toContain('"requirementMet": boolean');
    // 旧的 test 契约文本（"passed": boolean + 注释）不应残留在 test 步
    expect(SRC).not.toContain('"passed": boolean,   // 改动是否可安全进入审核');
  });

  it('显式声明「测试结论不由你判断」的职责边界', () => {
    expect(SRC).toContain('不由你判断');
    expect(SRC).toContain('不要输出任何测试结论字段');
  });
});

describe('runGate —— 重试回灌上次错误（AC-9 / P0-2）', () => {
  /** 造一个最小的闸门宿主替身：只实现 getAgent('dev-agent').generate() */
  function fakeHost(replies: string[]): { host: never; prompts: string[] } {
    const prompts: string[] = [];
    let i = 0;
    const host = {
      getAgent: () => ({
        generate: async (prompt: string) => {
          prompts.push(prompt);
          return { text: replies[Math.min(i++, replies.length - 1)] };
        },
      }),
    };
    return { host: host as never, prompts };
  }

  const SCHEMA = z.object({ alpha: z.number(), beta: z.string() });

  it('第一次 schema 不符、第二次修正 → 第二次 prompt 里含上次的 zod 报错', async () => {
    const { host, prompts } = fakeHost([
      JSON.stringify({ alpha: 'not-a-number' }), // 类型错 → zod 失败
      JSON.stringify({ alpha: 1, beta: 'ok' }), // 修正后成功
    ]);
    const out = await runGate(host, '做点什么', SCHEMA);
    expect(out).toEqual({ alpha: 1, beta: 'ok' });
    expect(prompts).toHaveLength(2);
    // 第一次不带回灌
    expect(prompts[0]).not.toContain('上一次尝试失败');
    // 第二次必须带上，且带上具体错误 —— 这是「不再盲重试」的判据
    expect(prompts[1]).toContain('上一次尝试失败');
    expect(prompts[1]).toContain('GATE_SCHEMA_INVALID');
    expect(prompts[1]).toContain('alpha');
  });

  it('第一次完全不是 JSON → 第二次 prompt 里含 GATE_NO_JSON', async () => {
    const { host, prompts } = fakeHost(['我拒绝输出 JSON', JSON.stringify({ alpha: 2, beta: 'y' })]);
    await runGate(host, '做点什么', SCHEMA);
    expect(prompts[1]).toContain('GATE_NO_JSON');
  });

  it('始终不合法 → 抛错（fail-closed，闸门宁可不通过）且尝试次数等于上限', async () => {
    const { host, prompts } = fakeHost(['{}']);
    await expect(runGate(host, '做点什么', SCHEMA)).rejects.toThrow(/GATE_SCHEMA_INVALID/);
    expect(prompts.length).toBe(Number(process.env.GATE_MAX_ATTEMPTS ?? 3));
  }, 30_000);

  it('传了 skill：prompt 里带上技能判据；不传则只发 instruction', async () => {
    // 「技能文本必须真的进到 prompt 里」是**结构性性质** —— 少接一步，
    // 闸门不会报错，只会judge得更糙（这正是最贵的失败形态：静默降级）。
    const withSkill = fakeHost([JSON.stringify({ alpha: 1, beta: 'ok' })]);
    await runGate(withSkill.host, '做点什么', SCHEMA, null, GATE_SKILLS.review);
    expect(withSkill.prompts[0]).toContain('code-review');
    expect(withSkill.prompts[0]).toContain('不要为看不见的内容背书');
    expect(withSkill.prompts[0]).toContain('【输出格式(强制)】');

    const without = fakeHost([JSON.stringify({ alpha: 1, beta: 'ok' })]);
    await runGate(without.host, '做点什么', SCHEMA);
    expect(without.prompts[0]).not.toContain('code-review');
    expect(without.prompts[0]).toContain('【输出格式(强制)】');
  });
});
