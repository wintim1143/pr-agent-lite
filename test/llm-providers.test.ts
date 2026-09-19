import {
  PROVIDERS,
  resolveLlmProvider,
  inspectLlmConfig,
  describeProvider,
} from '../src/llm/providers';

/**
 * LLM provider 抽象层单测(2026-09-14)。
 *
 * 重点覆盖三类「切服务商时真会踩的坑」,它们都是实测/文档核对出的边界,不是凑覆盖率:
 * 1. env 与 provider 默认值的优先级(env 必须能覆盖)
 * 2. 模型名必须落在 provider 文档列明的清单里 —— 部分服务商对未知模型名
 *    **静默回落**而非报错,只在配置期拦住才可靠
 * 3. 未知 provider 要在配置期就报出来,而不是等上游 404
 *
 * ⚠️ 刻意**不再校验 baseURL 的 `/v1`**。DeepSeek 官方文档的 base_url 就是
 * `https://api.deepseek.com`(不带 /v1),全局 /v1 规则会把正确配置误报为警告。
 * 是否带 /v1 由各 provider 注册表默认值负责,见下面的「注册表自身约束」。
 *
 * 注意:本文件注释内不得出现 星号加斜杠 的序列,否则会提前闭合块注释。
 */
describe('LLM provider 抽象层', () => {
  describe('resolveLlmProvider — 默认值与优先级', () => {
    it('未设 LLM_PROVIDER 时回退 relay', () => {
      const r = resolveLlmProvider({});
      expect(r.provider).toBe('relay');
      expect(r.known).toBe(true);
    });

    it('deepseek:未提供 baseURL/model 时用 provider 默认值', () => {
      const r = resolveLlmProvider({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-x' });
      // 官方文档 base_url 不带 /v1 —— 这是文档事实,不是笔误
      expect(r.baseURL).toBe('https://api.deepseek.com');
      expect(r.modelId).toBe('deepseek-flash');
      expect(r.providerLabel).toBe('DeepSeek');
    });

    it('env 显式值优先于 provider 默认值', () => {
      const r = resolveLlmProvider({
        LLM_PROVIDER: 'deepseek',
        LLM_BASE_URL: 'https://relay.example.com/v1',
        LLM_MODEL: 'deepseek-v4-pro',
        LLM_API_KEY: 'sk-x',
      });
      expect(r.baseURL).toBe('https://relay.example.com/v1');
      expect(r.modelId).toBe('deepseek-v4-pro');
    });

    it('baseURL 尾部斜杠被去掉(避免拼出双斜杠端点)', () => {
      const r = resolveLlmProvider({ LLM_BASE_URL: 'https://api.deepseek.com/v1///' });
      expect(r.baseURL).toBe('https://api.deepseek.com/v1');
    });

    it('relay 无内置 baseURL,必须由使用者提供', () => {
      const r = resolveLlmProvider({ LLM_PROVIDER: 'relay', LLM_API_KEY: 'sk-x' });
      expect(r.baseURL).toBe('');
      expect(r.modelId).toBe('');
    });

    it('空白字符串视为未设置(不因空格绕过默认值)', () => {
      const r = resolveLlmProvider({ LLM_PROVIDER: '  ', LLM_MODEL: '   ' });
      expect(r.provider).toBe('relay');
      expect(r.modelId).toBe('');
    });
  });

  describe('inspectLlmConfig — 配置期校验', () => {
    const base = { LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-x' };

    it('配置齐全时无 error', () => {
      const issues = inspectLlmConfig(resolveLlmProvider(base));
      expect(issues.filter(i => i.level === 'error')).toHaveLength(0);
    });

    it('deepseek 官方默认配置不产生任何 warn(回归:曾因全局 /v1 校验误报)', () => {
      const issues = inspectLlmConfig(resolveLlmProvider(base));
      expect(issues).toHaveLength(0);
    });

    it('缺 API key → error', () => {
      const issues = inspectLlmConfig(resolveLlmProvider({ LLM_PROVIDER: 'deepseek' }));
      expect(issues.find(i => i.field === 'LLM_API_KEY')?.level).toBe('error');
    });

    it('未知 provider → error 且提示可用名单', () => {
      const issues = inspectLlmConfig(resolveLlmProvider({ ...base, LLM_PROVIDER: 'nope' }));
      const issue = issues.find(i => i.field === 'LLM_PROVIDER');
      expect(issue?.level).toBe('error');
      expect(issue?.message).toContain('relay');
      expect(issue?.message).toContain('deepseek');
    });

    it('模型名不在 provider 已知清单 → warn,并提示静默回落风险', () => {
      const issues = inspectLlmConfig(resolveLlmProvider({ ...base, LLM_MODEL: 'deepseek-chat' }));
      const issue = issues.find(i => i.field === 'LLM_MODEL');
      expect(issue?.level).toBe('warn');
      expect(issue?.message).toContain('静默回落');
      expect(issue?.message).toContain('deepseek-flash');
    });

    it('legacy 模型名 deepseek-v4-flash 也 warn(已退役,上游按 flash 计费)', () => {
      const issues = inspectLlmConfig(resolveLlmProvider({ ...base, LLM_MODEL: 'deepseek-v4-flash' }));
      expect(issues.find(i => i.field === 'LLM_MODEL')?.level).toBe('warn');
    });

    it('deepseek-v4-pro 在清单内,不 warn', () => {
      const issues = inspectLlmConfig(resolveLlmProvider({ ...base, LLM_MODEL: 'deepseek-v4-pro' }));
      expect(issues.find(i => i.field === 'LLM_MODEL')).toBeUndefined();
    });

    it('relay 无 models 清单约束,任意模型名都不 warn', () => {
      const issues = inspectLlmConfig(
        resolveLlmProvider({ LLM_PROVIDER: 'relay', LLM_BASE_URL: 'https://x.com/v1', LLM_MODEL: 'glm-5.2', LLM_API_KEY: 'k' })
      );
      expect(issues.filter(i => i.level === 'warn')).toHaveLength(0);
    });

    it('使用者显式写不带 /v1 的 baseURL 不再被误报', () => {
      const issues = inspectLlmConfig(
        resolveLlmProvider({ ...base, LLM_BASE_URL: 'https://api.deepseek.com' })
      );
      expect(issues.find(i => i.field === 'LLM_BASE_URL')).toBeUndefined();
    });
  });

  describe('PROVIDERS 注册表自身约束', () => {
    it('内置 provider 的 baseURL 必须与官方文档一致(deepseek 刻意不带 /v1)', () => {
      // 不断言 /v1,只断言非空 provider 的 baseURL 是个像样的 https 地址,
      // 且**没有**被无脑补上 /v1 —— 这正是上一版假阳性校验的病根。
      for (const [name, spec] of Object.entries(PROVIDERS)) {
        if (!spec.baseURL) continue; // relay 刻意留空
        expect(spec.baseURL).toMatch(/^https:\/\//);
        expect(spec.baseURL).not.toMatch(/\/v1$/);
        expect(name).toBe(name.trim());
      }
    });

    it('声明了 models 的 provider,其 defaultModel 必须在 models 里', () => {
      for (const spec of Object.values(PROVIDERS)) {
        if (!spec.models?.length || !spec.defaultModel) continue;
        expect(spec.models).toContain(spec.defaultModel);
      }
    });

    it('describeProvider 不泄露密钥', () => {
      const out = describeProvider(
        resolveLlmProvider({ LLM_PROVIDER: 'deepseek', LLM_API_KEY: 'sk-super-secret-value' })
      );
      expect(out).not.toContain('sk-super-secret-value');
      expect(out).toContain('已设置');
    });
  });
});
