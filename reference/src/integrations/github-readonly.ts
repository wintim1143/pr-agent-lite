import 'dotenv/config';
import { z } from 'zod';
import { Integration } from '@mastra/core/integration';
import { createTool } from '@mastra/core/tools';
import { getGithubConfig, githubRequest, type GithubConfig } from '../adapters/github';
import type { RepoTarget } from '../adapters/repo-registry';

/**
 * GitHub 只读集成(M1-2)。
 *
 * 设计取舍(先读现有代码再动手,非猜):
 * - **复用** `adapters/github` 的 `getGithubConfig()`(自动从 `git remote get-url origin`
 *   解析 owner/repo,见 `adapters/github.ts:60` 的正则思路)与 `githubRequest()`(统一 REST 调用,
 *   失败抛清晰错误)。不重写一坨 fetch。
 * - 继承 `Integration` 基类(对应 M1 卡 §5 模块选型):把「认证 + 工具集 + api client」收敛成一个对象,
 *   agent 与 workflow 拿到的是同一套。裸写 fetch 只能给 workflow 用,agent 用不了。
 * - 三个只读工具:`listIssues` / `getIssue` / `listCommits`,全部 GET,对目标仓库**零写入**。
 *
 * 重要:本模块**加载不抛错**(否则拖垮 `npm test` 与 `GET /api/agents` 仅列元数据)。
 * `getGithubReadonlyClient()` 在未配置(GITHUB_TOKEN 缺失或无法解析 owner/repo)时返回 `null`,
 * 工具 `execute` 内部判空并给明确错误,不阻断导入。
 */

export interface GithubIssueSummary {
  number: number;
  title: string;
  state: string;
  url: string;
}

export interface GithubIssueDetail extends GithubIssueSummary {
  body: string;
}

export interface GithubCommitSummary {
  sha: string;
  message: string;
  author: string;
  date: string;
}

export interface GithubReadonlyClient {
  listIssues(opts?: { state?: 'open' | 'closed' | 'all'; perPage?: number }): Promise<GithubIssueSummary[]>;
  getIssue(issueNumber: number): Promise<GithubIssueDetail>;
  listCommits(opts?: { perPage?: number }): Promise<GithubCommitSummary[]>;
}

/** 用已解析的 GitHub 配置构造只读 client。仅封装 GET,绝不写。 */
function makeClient(cfg: GithubConfig): GithubReadonlyClient {
  return {
    async listIssues(opts) {
      const params = new URLSearchParams();
      // GitHub 把 PR 也混进 issues 列表,过滤掉,避免洞察里混入 PR
      params.set('per_page', String(opts?.perPage ?? 10));
      if (opts?.state) params.set('state', opts.state);
      const items = await githubRequest<Array<Record<string, unknown>>>(cfg, `/issues?${params.toString()}`);
      return items
        .filter(i => !i.pull_request) // 排除 PR(它们也走 issues 端点)
        .map(i => ({
          number: i.number as number,
          title: (i.title as string) ?? '',
          state: (i.state as string) ?? '',
          url: (i.html_url as string) ?? '',
        }));
    },
    async getIssue(issueNumber) {
      const i = await githubRequest<Record<string, unknown>>(cfg, `/issues/${issueNumber}`);
      return {
        number: i.number as number,
        title: (i.title as string) ?? '',
        state: (i.state as string) ?? '',
        url: (i.html_url as string) ?? '',
        body: ((i.body as string) ?? '').slice(0, 4000),
      };
    },
    async listCommits(opts) {
      const params = new URLSearchParams();
      params.set('per_page', String(opts?.perPage ?? 10));
      const items = await githubRequest<Array<Record<string, unknown>>>(cfg, `/commits?${params.toString()}`);
      return items.map(c => {
        const commit = (c.commit as Record<string, unknown>) ?? {};
        const author = (commit.author as Record<string, unknown>) ?? {};
        const who = (c.author as Record<string, unknown>)?.login ?? author.name ?? 'unknown';
        return {
          sha: (c.sha as string) ?? '',
          message: ((commit.message as string) ?? '').split('\n')[0] ?? '',
          author: String(who),
          date: (author.date as string) ?? '',
        };
      });
    },
  };
}

/** 读取 GitHub 只读 client;未配置返回 null(不抛)。 */
export function getGithubReadonlyClient(target?: RepoTarget): GithubReadonlyClient | null {
  const cfg = getGithubConfig(target);
  return cfg ? makeClient(cfg) : null;
}

// ---------- 三个只读工具(供 insight-agent 与 workflow collect 步使用) ----------

const IssuesListSchema = z.object({
  count: z.number(),
  issues: z.array(
    z.object({
      number: z.number(),
      title: z.string(),
      state: z.string(),
      url: z.string(),
    })
  ),
});

const listIssuesTool = createTool({
  id: 'github-list-issues',
  description:
    '列出当前仓库的 issue(只读 GET /repos/{owner}/{repo}/issues)。可选按状态过滤。注意:该端点也返回 PR,本工具已过滤掉 PR。',
  inputSchema: z.object({
    state: z.enum(['open', 'closed', 'all']).optional().describe('issue 状态过滤,默认 open'),
    perPage: z.number().int().min(1).max(100).optional().describe('每页条数,默认 10'),
  }),
  outputSchema: IssuesListSchema,
  execute: async inputData => {
    const client = getGithubReadonlyClient();
    if (!client)
      throw new Error('GitHub 未配置:缺少 GITHUB_TOKEN(需 Contents 读权限)或无法从 git remote 解析 owner/repo');
    const issues = await client.listIssues({ state: inputData.state, perPage: inputData.perPage });
    return { count: issues.length, issues };
  },
});

const IssueDetailSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  url: z.string(),
  body: z.string(),
});

const getIssueTool = createTool({
  id: 'github-get-issue',
  description: '获取单个 issue 的详情(只读 GET /repos/{owner}/{repo}/issues/{number}),含标题/状态/正文。',
  inputSchema: z.object({
    issueNumber: z.number().int().positive().describe('issue 编号'),
  }),
  outputSchema: IssueDetailSchema,
  execute: async inputData => {
    const client = getGithubReadonlyClient();
    if (!client) throw new Error('GitHub 未配置:缺少 GITHUB_TOKEN 或无法解析 owner/repo');
    return client.getIssue(inputData.issueNumber);
  },
});

const CommitsListSchema = z.object({
  count: z.number(),
  commits: z.array(
    z.object({
      sha: z.string(),
      message: z.string(),
      author: z.string(),
      date: z.string(),
    })
  ),
});

const listCommitsTool = createTool({
  id: 'github-list-commits',
  description: '列出当前仓库的提交记录(只读 GET /repos/{owner}/{repo}/commits)。',
  inputSchema: z.object({
    perPage: z.number().int().min(1).max(100).optional().describe('每页条数,默认 10'),
  }),
  outputSchema: CommitsListSchema,
  execute: async inputData => {
    const client = getGithubReadonlyClient();
    if (!client) throw new Error('GitHub 未配置:缺少 GITHUB_TOKEN 或无法解析 owner/repo');
    const commits = await client.listCommits({ perPage: inputData.perPage });
    return { count: commits.length, commits };
  },
});

/**
 * GitHub 只读 Integration(M1 卡 §5)。
 * - `listStaticTools()` 把三个只读工具暴露给 agent / workflow。
 * - `getApiClient()` 返回可直接调用的只读 client(供 workflow collect 步在 step 内直接调,
 *   不必绕经工具抽象)。
 */
export class GithubReadonlyIntegration extends Integration<void, GithubReadonlyClient> {
  name = 'github-readonly';

  getApiClient(): Promise<GithubReadonlyClient> {
    const client = getGithubReadonlyClient();
    if (!client) {
      return Promise.reject(new Error('GitHub 未配置:缺少 GITHUB_TOKEN 或无法从 git remote 解析 owner/repo'));
    }
    return Promise.resolve(client);
  }

  listStaticTools() {
    return {
      listIssues: listIssuesTool,
      getIssue: getIssueTool,
      listCommits: listCommitsTool,
    };
  }
}

/** 单例:注册到 Mastra 或供脚本直接引用。 */
export const githubReadonlyIntegration = new GithubReadonlyIntegration();
