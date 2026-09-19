/**
 * 闸门技能文本 —— 「怎么做这件事」的唯一运行期真相源。
 *
 * ## 为什么是一个独立的模块而不是散在各处
 *
 * 三个质量闸门（test / review / commit）各自需要两样东西：
 * - **输出形状** —— 由 `dev-workflow.ts` 的 zod schema 与 prompt 的「输出契约」段钉死；
 * - **判定依据** —— 即「怎么做这件事」，就是本模块。
 *
 * 两者分开写是有意的：形状错会让闸门**恒失败**（症状显眼），
 * 判据缺失只会让闸门**判得糙**（症状隐蔽）。前者靠 schema 拦，后者靠这里补。
 *
 * ## ⚠️ 技能只描述「能力与判据」，**不规定输出形状**
 *
 * 每条文本结尾都有一句「输出形状以调用方指定的结构化契约为准」。
 * 早期实现让技能自己声明最终格式（如 commit-message 写「输出 `<type>(<scope>): <subject>`」），
 * 而闸门用 zod 校验 `{message}` —— 两边对不上，闸门 3 次重试 byte 级相同、全挂。
 *
 * ## ⚠️ 不得写入「模型做不到的事」
 *
 * 曾经的 code-testing 文本写「以测试的真实结果为准」，而**模型没有执行能力** ——
 * 这类指令的后果不是「多做一点」，而是诱导模型**声称做过实际没做过的事**。
 * 测试结论是程序侧事实（见 `dev-workflow.ts` 的 `testStep`），这里只留「判需求是否实现」。
 *
 * ## 与 `src/skills/**` 的关系
 *
 * `src/skills/<name>/SKILL.md` 与 `references/*.md` 是**给人读的存档规范**，
 * 不参与运行（编译产物不含 `.md`，不做运行期路径解析）。**本模块是运行期唯一生效的副本**；
 * 两者对不上时以本模块为准。改技能语义时**两边都要改**。
 */
/** 本实现真正用到的技能标识。**闭集** —— 加一个就必须同时在下面给出文本。 */
export type GateSkillName = 'code-testing' | 'code-review' | 'commit-message';

/**
 * 闸门 → 技能标识。
 *
 * 键与 `dev-workflow.ts` 里的步骤 id 同名，便于一眼对上；值是技能的人类可读名。
 */
export const GATE_SKILLS: Record<'test' | 'review' | 'commit', GateSkillName> = {
  test: 'code-testing',
  review: 'code-review',
  commit: 'commit-message',
};

const SKILL_TEXT: Record<GateSkillName, string> = {
  'code-testing': `【技能 code-testing —— 测试闸门】

**测试是否通过不由你判断。** 编排层已真实执行过测试，结果写在调用方给出的输入里
（还包含「本次未执行测试」这种情形 —— 那也是事实，不是失败）。

你只回答一个问题：**上述改动有没有真正实现需求。**
1. 依据 diff 与需求逐条核对，而不是「看起来像做了」
2. 改动为空、与需求无关、只做了一部分 → 判未实现，并在报告里说清**缺什么**
3. **不要输出任何测试结论字段**（通过 / 失败 / exit code / 用例数）—— 那是程序侧事实，模型在结构上也无处安放
4. **不要为看不见的内容背书**

禁止声称跑过实际未执行的测试，也禁止声称做过未执行的静态检查（lint / 构建 / 类型检查）。
输出形状以调用方指定的结构化契约（JSON 字段）为准。`,

  'code-review': `【技能 code-review —— 代码审核】

你是代码审核员。审核**调用方给出的改动 diff**，而不是你想象中的仓库。
1. 检查正确性与边界情况（空值、异常路径、并发、资源释放）
2. 核对是否与既有风格和约定一致
3. 排查 bug / 安全隐患 / 性能问题
4. 判断改动是否**真的满足需求**——改了别的地方、或只改了一半，都算 request-changes

结论二选一：
- \`approve\`：可进入 commit
- \`request-changes\`：附**具体**意见（定位到文件与行为，不要泛泛而谈），打回重做

约束：
- 仅对 diff 中**真实出现**的改动给出结论
- 未执行的静态检查（lint / 构建 / 类型检查）不得声称做过
- **不要为看不见的内容背书**：diff 里没有的，不要说它没问题
- 输出形状以调用方指定的结构化契约（JSON 字段）为准`,

  'commit-message': `【技能 commit-message —— 提交信息生成】

根据**调用方给出的改动 diff** + issue 号，生成 Conventional Commits 提交信息：

\`\`\`
<type>(<scope>): <subject>

[body]

Closes #<issue-number>
\`\`\`

约束：
- \`type\` ∈ {feat, fix, refactor, test, docs, chore, perf}
- \`subject\` 用祈使句，≤50 字符，不加句号
- \`type\` / \`scope\` 必须与**真实改动**相符（只有文档改动就别写 feat）
- 提交信息不得为空
- 输出形状以调用方指定的结构化契约（JSON 字段）为准（通常是单个 message 字符串）；
  **不要**输出 type / scope / subject / body 这类拆分字段`,
};

/**
 * 取某个闸门的技能文本。
 *
 * 纯查表 —— 不做 IO、不读环境变量。技能文本随编译产物一起发布，
 * 因此不存在「部署时缺一个 .md 文件」这一失败形态。
 */
export function gateSkillText(name: GateSkillName): string {
  return SKILL_TEXT[name];
}
