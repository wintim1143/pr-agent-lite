import path from 'node:path';
import { makeGuardHook } from '../src/agents/coding-agent';

const REPO = path.resolve(__dirname, '../../');

describe('makeGuardHook', () => {
  it('PreToolUse + 写受保护路径 → 返回 deny 判定结构', async () => {
    const hook = makeGuardHook(REPO);
    const out = await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: path.join(REPO, 'agent.md') },
    } as never);

    const spec = out as {
      hookSpecificOutput?: { hookEventName: string; permissionDecision: string };
      decision?: string;
    };
    expect(spec.hookSpecificOutput?.hookEventName).toBe('PreToolUse');
    expect(spec.hookSpecificOutput?.permissionDecision).toBe('deny');
    // 兜底兼容字段
    expect(spec.decision).toBe('block');
    expect(spec.reason).toBeTruthy();
  });

  it('PreToolUse + 合法写普通业务文件 → 返回空对象（放行）', async () => {
    const hook = makeGuardHook(REPO);
    const out = await hook({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: path.join(REPO, 'src/feature/ok.ts') },
    } as never);
    expect(out).toEqual({});
  });

  it('非 PreToolUse 事件 → 放行（不误伤其他 hook）', async () => {
    const hook = makeGuardHook(REPO);
    const out = await hook({ hook_event_name: 'PostToolUse' } as never);
    expect(out).toEqual({});
  });
});
