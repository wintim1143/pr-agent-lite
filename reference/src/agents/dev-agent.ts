import { Agent } from '@mastra/core/agent';
import { createSkill } from '@mastra/core/skills';
import { llmModelConfig } from '../config';

/**
 * dev-agent:文档(11-IM驱动的多Agent自动开发工作流设计.md)设计的「自动开发」主控 agent。
 * 由 Mastra workflow 按强制顺序调度,每个质量闸门 = 一个 skill。
 *
 * 说明:
 * - 6 个 skill 全部用 createSkill 内联,保证编译期 + 运行期稳定(不依赖 cwd 下的 SKILL.md 路径解析)。
 * - 规范版 SKILL.md 已落在 src/skills/<name>/SKILL.md(文档 §11.5 要求),作为技能定义存档;
 *   后续若改用 `skills: ['./skills/<name>']` 路径加载,需先确认构建后 cwd 解析基准。
 * - model 由 `../config` 的 `llmModelConfig` 提供,全部走环境变量(模型名 / baseURL / apiKey 均可配),
 *   适配任意 OpenAI 兼容中转站。详见 src/config.ts 与仓库根 `.env.example`。
 *   GET /api/agents 只列元数据,不触发 generate,故不影响接入验证。
 */

const requirementParser = createSkill({
  name: 'requirement-parser',
  description: 'IM 收到需求文本时调用:把自然语言需求解析为结构化需求(标题/正文/验收标准),用于创建 GitHub issue。',
  instructions: `你是需求解析器。输入用户的 IM 文本需求,输出结构化需求:
- title: 一句话需求标题(祈使句)
- body: 背景、目标、验收标准
- 信息不足时,列出需要向用户澄清的问题
只做解析,不写代码、不创建 issue(issue 创建由 workflow 节点执行)。`,
});

const coding = createSkill({
  name: 'coding',
  description: 'issue 标记 approved 后调用:根据 issue 内容 + 当前代码库,产出满足需求的代码改动(工作区 diff)。',
  instructions: `你是编码 agent。输入 issue 内容 + 代码库上下文,产出代码改动:
- 遵循仓库 agent.md 的 Git 规范与风格
- 只改自己的 feature 分支,禁止动 main
- 输出改动摘要 + 关键 diff 说明
编码质量优先,考虑边界情况与错误处理。`,
});

/**
 * ⚠️ skill 只描述「能力与判据」,**不规定输出形状**(2026-09-15 修正)。
 *
 * 原实现让 skill 声明最终格式(如 commit-message 写「输出 `<type>(<scope>): <subject>`」),
 * 而 workflow 的闸门用 zod 校验 `{message}`,两边对不上 → 闸门 3 次重试全挂。
 * 现在统一约定:**输出形状由调用方(闸门)在 prompt 的「输出契约」段指定**,
 * skill 只负责「怎么做这件事」;下面每个 instructions 结尾都保留一句此约定。
 *
 * 同时清掉三处**不可执行的幻觉指令**(项目里根本没有对应工具):
 * - code-testing 原写「跑相关单元测试」→ 纯文档改动无测试可跑,模型会陷入两难;
 * - code-review 原写「跑 lint」→ 项目 `npm run lint` 指向 `mwts check`,本环境冷启动卡死;
 * - commit-message 原写「必须过 commitlint」→ 无依赖、无配置、无 husky hook。
 * 这类指令的后果不是"多做一点",而是诱导模型**声称做过实际没做的事**。
 */
const codeTesting = createSkill({
  name: 'code-testing',
  description: '编码完成后强制调用:对改动 diff 评估测试情况,输出通过/失败 + 报告。不通过不可进入审核。',
  instructions: `你是测试闸门。对**调用方给出的改动 diff**评估测试情况:
1. 若仓库存在与改动相关的可执行测试,以其真实结果为准
2. 若为纯文档/配置类改动(无可执行测试),则判断改动是否满足需求、是否引入破坏性变更
3. 输出:通过/失败 + 判断依据 + 失败时的定位建议
测试不通过必须明确标红,不可放行。禁止声称跑过实际未执行的测试。
输出形状以调用方指定的结构化契约(JSON 字段)为准。`,
});

const codeReview = createSkill({
  name: 'code-review',
  description: '测试通过后强制调用:审核代码改动的正确性、风格、隐患,输出 approve 或 request changes + 意见。',
  instructions: `你是代码审核员。审核**调用方给出的改动 diff**:
1. 检查正确性与边界情况
2. 核对仓库风格与约定
3. 排查 bug / 安全隐患 / 性能问题
输出:approve(可进入 commit)或 request changes(附具体意见,打回 coding 重做)。
仅对 diff 中**真实出现**的改动给出结论;未执行的静态检查(lint 等)不得声称做过。
输出形状以调用方指定的结构化契约(JSON 字段)为准。`,
});

const commitMessage = createSkill({
  name: 'commit-message',
  description: '审核通过后强制调用:根据改动 diff + issue 号生成 Conventional Commits 格式的 commit message。',
  instructions: `你是 commit message 生成器。根据**调用方给出的改动 diff** + issue 号,生成 Conventional Commits 提交信息:
<type>(<scope>): <subject>
[body]
Closes #<issue-number>
type ∈ {feat,fix,refactor,test,docs,chore,perf};subject 祈使句 ≤50 字符。
提交信息不得为空。
输出形状以调用方指定的结构化契约(JSON 字段)为准(通常是单个 message 字符串)。`,
});

const mergePr = createSkill({
  name: 'merge-pr',
  description: '用户确认合并后强制调用:执行 squash merge 把 PR 合入 main,并关闭关联 issue。',
  instructions: `你是合并闸门。用户确认后:
1. squash merge PR 到 main
2. 关闭关联 issue(Closes #<issue>)
3. 输出合并结果
禁止未经用户确认合并;禁止 push/force push main。`,
});

export const devAgent = new Agent({
  id: 'dev-agent',
  name: '自动开发 Agent',
  instructions: `你是自动开发工作流的主控 agent。严格按 workflow 强制顺序执行质量闸门:
需求解析 → 编码 → 测试(强制) → 审核(强制) → commit(强制) → 合并(强制,需用户确认)。
每个环节按需加载对应 skill。任何闸门不通过,停止并上报,不得跳过。
遵循仓库 agent.md 的 Git 规范与红线。`,
  model: llmModelConfig,
  skills: [requirementParser, coding, codeTesting, codeReview, commitMessage, mergePr],
});
