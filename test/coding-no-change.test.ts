/**
 * 编码步「零改动」判据（2026-09-19，真跑暴露）。
 *
 * ## 为什么值得一个独立测试文件
 *
 * 这条判据防的是**归因错位**这一整类问题：流水线带着空 diff 往下走，
 * 闸门诚实地说「需求未实现」—— 结论没错，但它把「模型没动手」说成了「实现不合格」，
 * 排障会往改提示词/改闸门的方向查，而真因在模型行为上。
 *
 * 实测案例（岚风 / gpt-5.6-terra）：模型回了
 * 「为避免猜测：`greet(name)` 的返回值是否采用简单格式……？」然后 `end_turn` 收工，
 * `num_turns=9` 但 0 次写文件；日志里 coding 步是 `step:done`，一路到闸门才判负。
 */
import { codingChangeFailure } from '../src/workflows/dev-workflow';

describe('codingChangeFailure —— 零改动必须在 coding 步就报出来', () => {
  it('有改动就通过（返回 null）', () => {
    expect(codingChangeFailure(['src/greet.js'], 'main', '已新增 greet 模块')).toBeNull();
    // 只改一个既有文件同样算有产出
    expect(codingChangeFailure(['README.md'], 'main', '')).toBeNull();
  });

  it('零改动时给出可归因的失败理由，而不是沉默', () => {
    const reason = codingChangeFailure([], 'main', '为避免猜测：返回值格式是否……？');

    expect(reason).not.toBeNull();
    // 机器可读的标记，便于日志检索与 CI 判别
    expect(reason).toContain('NO_CHANGES@coding');
    // 基线分支名要出现 —— 否则无法判断它到底跟谁比的
    expect(reason).toContain('main');
    // 模型的回复要带进来：排障第一眼看的就是「它到底说了什么」
    expect(reason).toContain('为避免猜测');
    // 并且要点出这类现象的常见成因，别让读者以为只能去查闸门
    expect(reason).toContain('反问');
  });

  it('回复为空是更严重的信号，理由里必须区分开', () => {
    const reason = codingChangeFailure([], 'develop', '   ');

    expect(reason).toContain('NO_CHANGES@coding');
    expect(reason).toContain('develop');
    expect(reason).toContain('回复为空');
  });

  it('长回复按 300 字符截断 —— 失败理由不该被整篇输出撑爆', () => {
    const long = 'x'.repeat(5000);
    const reason = codingChangeFailure([], 'main', long)!;
    // 标记 + 说明 + 截断后的 300 字符，总量远小于原文
    expect(reason.length).toBeLessThan(1000);
    expect(reason).toContain('(5000 字符)');
  });

  it('基线分支名进理由：换过 base 的仓库也能看出它比错了对象', () => {
    expect(codingChangeFailure([], 'release/2.x', 'noop')!).toContain('release/2.x');
  });
});
