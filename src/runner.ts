/**
 * 顺序执行器 —— 本项目的编排原语（零框架）。
 *
 * ## 为什么自己写
 *
 * 需求形态是**固定八步、强制顺序、无分支**：
 * checkout → coding → test → review → commit → push-open-pr → notify → merge。
 * 用编排框架承载它，代价是引入状态机 / 快照 / 事件总线一整套机制，
 * 而真正被用到的能力只有「依次 await 八个函数」。
 *
 * 本模块只提供三样东西：
 * 1. `createStep` —— 把 `{id, inputSchema, outputSchema, execute}` 定义成一个步骤；
 * 2. `createWorkflow` —— 按 `.then()` 顺序串起来，`commit()` 得到可 `run()` 的对象；
 * 3. `suspend` —— 人工关卡的挂起（由 `WorkflowSuspended` 异常承载）。
 *
 * ## 与沿用下来的步骤主体的契约
 *
 * `execute` 收到的上下文形状是
 * `{ inputData, runId, llmHost, suspend, resumeData }` —— 借鉴来的八个步骤主体因此**一行不改**。
 *
 * ## 输出校验是 fail-closed 的
 *
 * 每个步骤返回后都跑一次 `outputSchema.safeParse`。不通过即判该步失败，
 * 而不是把形状不对的上下文喂给下一步 —— 后者会让错误在链路里漂移，
 * 最后在一个与根因无关的地方爆出来。
 */
import type { z } from 'zod';

/**
 * 闸门 LLM 的宿主。
 *
 * 步骤通过 `llmHost.getAgent(name).generate(prompt)` 触发一次**语义判定**。
 * 这是编码步之外的唯一 LLM 用途：test / review / commit 三个闸门。
 */
export interface GateAgent {
  /** `usage` 拿不到时**不返回**（不是返回 0）—— 见 `log-store.ts` 的 normalizeUsage 契约。 */
  generate(prompt: string): Promise<{ text: string; usage?: unknown; totalUsage?: unknown }>;
}

export interface StepHost {
  getAgent(name: string): GateAgent;
}

/** 步骤执行时收到的上下文。 */
export interface StepArgs<TIn> {
  /** 上一步的输出（首步为 workflow 输入）。 */
  inputData: TIn;
  /** 本次 run 的标识（由调用方给出，贯穿所有步骤与结构化事件）。 */
  runId: string;
  /** 闸门 LLM 宿主。 */
  llmHost: StepHost;
  /** 挂起当前 run（人工关卡）。调用即抛 `WorkflowSuspended`，故返回类型是 `never`。 */
  suspend: (payload: unknown) => never;
  /** 恢复时由调用方带进来的数据；首次执行为 `undefined`。 */
  resumeData: unknown;
}

export interface StepDef<TIn = any, TOut = any> {
  id: string;
  description?: string;
  inputSchema: z.ZodType<TIn>;
  outputSchema: z.ZodType<TOut>;
  execute: (args: StepArgs<TIn>) => Promise<TOut>;
}

/** 定义一个步骤。纯恒等函数 —— 存在的意义是给对象字面量提供上下文类型。 */
export function createStep<TIn, TOut>(def: StepDef<TIn, TOut>): StepDef<TIn, TOut> {
  return def;
}

/**
 * 人工关卡挂起的载体。
 *
 * 用异常而非返回值承载，是为了让步骤主体能写 `return suspend({...})` ——
 * 类型上是 `never`，编译器会保证挂起之后不会再有代码被执行。
 */
export class WorkflowSuspended extends Error {
  constructor(
    readonly payload: unknown,
    readonly stepId: string
  ) {
    super(`WORKFLOW_SUSPENDED@${stepId}`);
    this.name = 'WorkflowSuspended';
  }
}

export type RunOutcome<TOut> =
  | { status: 'ok'; output: TOut; steps: string[] }
  | { status: 'suspended'; payload: unknown; atStep: string; steps: string[] }
  | { status: 'failed'; error: Error; failedStep: string; steps: string[] };

export interface WorkflowDef<TIn, TOut> {
  id: string;
  description?: string;
  inputSchema: z.ZodType<TIn>;
  outputSchema: z.ZodType<TOut>;
}

export interface RunOptions {
  runId: string;
  llmHost: StepHost;
  /**
   * 从哪一步开始（恢复已挂起的 run 时用）。
   *
   * ⚠️ 恢复时 `input` 必须是**挂起那一刻的上下文快照**，不是原始输入 ——
   * 否则会拿着 checkout 之前的状态去跑 merge。这是本执行器与「自动快照」型框架
   * 最大的分野：**快照由调用方持有**（本项目落在状态库里，见 `adapters/state-db.ts`）。
   */
  resumeAt?: string;
  resumeData?: unknown;
}

export interface Workflow<TIn, TOut> extends WorkflowDef<TIn, TOut> {
  steps: StepDef<any, any>[];
  run(input: TIn, opts: RunOptions): Promise<RunOutcome<TOut>>;
}

export interface WorkflowBuilder<TIn, TOut> {
  then(step: StepDef<any, any>): WorkflowBuilder<TIn, TOut>;
  commit(): Workflow<TIn, TOut>;
}

export function createWorkflow<TIn, TOut>(def: WorkflowDef<TIn, TOut>): WorkflowBuilder<TIn, TOut> {
  const steps: StepDef<any, any>[] = [];

  const builder: WorkflowBuilder<TIn, TOut> = {
    then(step) {
      steps.push(step);
      return builder;
    },
    commit(): Workflow<TIn, TOut> {
      const committed = [...steps];
      return {
        ...def,
        steps: committed,
        async run(input, opts) {
          const done: string[] = [];
          let startIndex = 0;

          if (opts.resumeAt !== undefined) {
            const idx = committed.findIndex(s => s.id === opts.resumeAt);
            if (idx < 0) {
              throw new Error(
                `resumeAt 指向未知步骤 "${opts.resumeAt}"；已知步骤: ${committed.map(s => s.id).join(' / ')}`
              );
            }
            // 被跳过的步骤计入 steps，让「这次 run 走到哪」仍然是完整可读的轨迹。
            for (let i = 0; i < idx; i++) done.push(committed[i].id);
            startIndex = idx;
          }

          let current: unknown = input;
          for (let i = startIndex; i < committed.length; i++) {
            const step = committed[i];
            try {
              current = await step.execute({
                inputData: current,
                runId: opts.runId,
                llmHost: opts.llmHost,
                suspend: (payload: unknown): never => {
                  throw new WorkflowSuspended(payload, step.id);
                },
                resumeData: opts.resumeData,
              });
            } catch (e) {
              if (e instanceof WorkflowSuspended) {
                return { status: 'suspended', payload: e.payload, atStep: step.id, steps: done };
              }
              return {
                status: 'failed',
                error: e instanceof Error ? e : new Error(String(e)),
                failedStep: step.id,
                steps: done,
              };
            }

            const parsed = step.outputSchema.safeParse(current);
            if (!parsed.success) {
              return {
                status: 'failed',
                failedStep: step.id,
                steps: done,
                error: new Error(
                  `STEP_OUTPUT_INVALID@${step.id}: 步骤输出不符合 outputSchema —— ` +
                    parsed.error.message.slice(0, 300)
                ),
              };
            }
            done.push(step.id);
          }

          return { status: 'ok', output: current as TOut, steps: done };
        },
      };
    },
  };

  return builder;
}
