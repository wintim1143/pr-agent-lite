/**
 * 启动自检 —— 进程起来做的第一件事，**无条件执行、永不抛错**。
 *
 * ## 它防的是什么
 *
 * 不是「进程起不来」这类显眼的失败，而是三种**不报错的**失败：
 *
 * | 失败 | 症状 |
 * |---|---|
 * | 模型名被服务商静默回落到默认值 | 跑得通，但跑的不是你要的模型 |
 * | 编码侧端点来自一个你忘了在用的配置文件 | 跑得通，但连的是别的后端 |
 * | 闸门链的 `LLM_*` 有一项没配 | 直到第一次闸门调用才暴露，而那可能是几分钟之后 |
 *
 * 三种的共同点是**难归因**。把「本次实际生效的配置」在启动时就落成一条持久事件，
 * 事后排障的第一句话就有答案了 —— 这也是为什么它必须**即使端点不通也打印**：
 * 「连的是哪个端点」是**配置期事实**，「通不通」是**运行期事实**，前者不该依赖后者。
 *
 * ## 两条链分开打印，不假定同源
 *
 * - **闸门链**（test / review / commit 三个语义闸门）走 `LLM_*` → OpenAI Chat Completions 形状
 * - **编码链**（真正写文件的编码执行体）走 Claude Code CLI 自己的 `ANTHROPIC_*`
 *
 * 它们的凭据、端点、模型**都可以不同**，且没有任何理由默认它们一致。
 * 打印成一行一句，就是为了让「换了一边忘了另一边」在启动时就看得见。
 *
 * ## 只落事件，不抛错
 *
 * 缺配置是**事实**，不是启动失败 —— 记录它，把判断留给使用者。
 * 真正缺配置的显式失败发生在发起调用时（见 `llm/chat.ts` 与 coding 步），
 * 那里才有「缺了就必须停」的语义。
 */
import { logLlmConfig, missingLlmConfig } from './config.js';
import { describeActiveLlm } from './llm/chat.js';
import { describeCodingBackend, describeCodingLimits } from './agents/coding-agent.js';
import { registrySummary } from './adapters/repo-registry.js';
import { stateDbPath } from './adapters/state-db.js';
import { logFilePath } from './log-store.js';
import { stage } from './progress.js';

/** 落一行启动期事件。`runId: null` 是规范允许的三种阶段之一（启动期不属于任何 run）。 */
function note(field: string, message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  stage('config:check', { stage: 'startup', runId: null, level, field, message });
}

/**
 * 打印本次实际生效的配置。**不抛错、不返回值** —— 它是观测点，不是校验器。
 *
 * 最后一行是 `startup:ready`，作为「自检走完」的锚点：
 * 日志里没有这一行，就说明进程在自检期间就死了（而不是配置有问题）。
 */
export function logStartupSelfCheck(): void {
  note('runtime', `node=${process.version} pid=${process.pid} cwd=${process.cwd()}`);

  // —— 闸门链（LLM_*，OpenAI 兼容）——
  // describeActiveLlm() 与 logLlmConfig() 都只读值、不发请求：
  // 端点通不通是运行期事实，不能因为不通就把「连的是哪个端点」也一并丢掉。
  note('LLM', `闸门链 ${describeActiveLlm()}`);
  logLlmConfig('[gate]');
  const missing = missingLlmConfig();
  if (missing.length) {
    note(
      'LLM',
      `闸门链缺 ${missing.length} 项配置：${missing.join(' / ')} —— 三个语义闸门（test/review/commit）会失败；M2 的只读工具不受影响`,
      'warn'
    );
  }

  // —— 编码链（Claude Code CLI，Anthropic 协议）——
  note('CODING', `编码链 ${describeCodingBackend()}`);
  // 上限必须与 SDK 装配读同一处 —— 否则「自检说 30 轮、实际跑 20 轮」这类分叉
  // 又会变成一条要翻失败理由才知道的消息（2026-09-19 真被 $2 上限掐断过一次）。
  note('CODING', `编码步上限 ${describeCodingLimits()}`);

  // —— 运行期落点（路径全部来自配置，不写死）——
  note('paths', `日志=${logFilePath()} 状态库=${stateDbPath()}`);
  // 注册表读不出内容（文件缺失 / JSON 非法 / 结构不符）时 `registrySummary()` 会抛错 ——
  // 自检**不能因此中断**：注册表没配好是「M0 前置未就位」的事实，不是进程起不来。
  try {
    const reg = registrySummary();
    note(
      'repos',
      `仓库注册表 path=${reg.path} exists=${reg.exists} keys=[${reg.keys.join(', ') || '空'}]`,
      reg.exists ? 'info' : 'warn'
    );
  } catch (e) {
    note('repos', `仓库注册表不可用：${e instanceof Error ? e.message : String(e)}`, 'warn');
  }

  note('startup', '自检完成（以上均为配置期事实，不代表端点可达）');
}
