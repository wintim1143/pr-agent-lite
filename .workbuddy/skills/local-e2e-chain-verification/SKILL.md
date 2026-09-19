---
name: local-e2e-chain-verification
description: 在本机验证 pr-agent-lite 的整条链是否真的通 —— 需求 → 建分支 → 编码 CLI 真写文件 → 三道闸门 → 真产生提交，并区分「管道不通」与「端点不通」。当出现以下情况时使用：改完编码链/闸门链要回归、用户说「我配好了你试下」、怀疑「日志全绿但其实没写文件」、要判断失败该归因给代码还是凭据、要验经 MCP dev_start 触发的那条路（Hermes 的唯一入口）。
agent_created: true
---

# 本机整链验证（两层：假端点验管道，真端点验端到端）

**先想清楚要证的是哪一件事**，否则会把两种完全不同的失败混成一句「跑不通」：

| 要证的事 | 用什么 | 判定 |
|---|---|---|
| **管道通不通**（编排、围栏、建分支、闸门串接、提交） | `scripts/stub-endpoint.cjs` 确定性**双协议**假端点 | 与真端点是否可用**无关**，永远可验 |
| **端点通不通**（凭据、模型名、上游兼容性） | 真端点，两条链**分别**配 | 一次 curl 就能判 |

**这是本仓库最有价值的一个杠杆**：分开验，真端点挂掉时链路照样能被完整验穿。

---

## 0. 三条链的配置不是一套（最容易搞错的地方）

| 链 | 协议 | 端点从哪来 |
|---|---|---|
| 闸门链（test / review / commit） | **OpenAI**（`{LLM_BASE_URL}/chat/completions`） | `LLM_PROVIDER` / `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY` |
| 编码链（真正写文件） | **Anthropic**（Claude Code CLI） | CLI 自己读 `~/.claude/settings.json`；不设 `CODING_ANTHROPIC_*` 时走这条 |

⚠️ **闸门链不能用本机 cc-switch 的代理端口** —— 它只答 Anthropic 形状：
`/v1/chat/completions` 回 `{"error":{"message":"未配置供应商","type":"proxy_error"}}`。
闸门链要另找 OpenAI 兼容端点（DeepSeek 官方 baseURL **不带 `/v1`**）。

---

## 1. 搭靶场（一次性）

```sh
TARGET="$HOME/Documents/code/pral-demo-target"   # 或任意临时仓库
rm -rf "$TARGET" && mkdir -p "$TARGET" && cd "$TARGET"
git init -q -b main && git config user.email demo@local && git config user.name pral-demo
printf '# demo target\n' > README.md && git add -A && git commit -q -m "chore: init"

cat > /tmp/pral-registry.json <<JSON
{ "repos": { "demo/target": { "localPath": "$TARGET", "baseBranch": "main" } } }
JSON
```

**每跑一轮前必须重置**，否则上一轮的脏工作树会让「这一轮到底改了什么」无法判定：

```sh
cd "$TARGET" && git checkout -q main && \
  git branch | grep -v '^\*' | xargs -r git branch -D && git clean -qfd && git checkout -q -- .
```

## 2. 跑一轮

```sh
cd <仓库根> && npm run build        # dist 必须新 —— 忘了构建会验到旧代码
export REPO_REGISTRY_PATH=/tmp/pral-registry.json
export PRAL_PROGRESS_FILE=/tmp/pral-run.log PRAL_DB_PATH=/tmp/pral-state.db
export LLM_PROVIDER=deepseek LLM_BASE_URL=https://api.deepseek.com \
       LLM_MODEL=deepseek-v4-pro LLM_API_KEY=<key> LLM_TIMEOUT_MS=180000
export CODING_CLI_PATH=<claude 绝对路径>          # 非交互 shell 的 PATH 里没有它
export CODING_MAX_TURNS=40 CODING_MAX_BUDGET_USD=20 CODING_TIMEOUT_MS=420000
unset ANTHROPIC_BASE_URL ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL

node dist/dev-runner.js --target=demo/target \
  --title="新增 greet 模块并补充用法说明" \
  --body="新增 src/greet.js 导出 greet(name)；README 末尾追加 ## 用法" \
  --issue-number=1 --run-id=e2e-1
```

⚠️ **入参用 `--key=value` 形式**（不是 `--key value`）。

## 3. 判「到底成没成」—— 看磁盘，不看日志

```sh
cd "$TARGET"
git log --oneline --all --graph          # 有没有真提交、落在哪个分支
git show --stat feat/<n>-<slug>          # 提交带了哪些文件
git ls-tree main -r --name-only          # ⚠️ base 分支必须**没被改动**
git status --short                       # 工作树应干净
```

日志里 `stepsDone=6 / stepsFailed=0` **不等于**文件真的写了 —— 两样都要看。

## 4. 经 MCP 触发（Hermes 的唯一入口）

```sh
cd <仓库根> && NODE_PATH=$PWD/node_modules \
  node .workbuddy/skills/local-e2e-chain-verification/mcp-harness.cjs \
       demo/target "新增 farewell 模块" "新增 src/farewell.js；README 追加 ## 告别"
```

只观测已有 run：末尾加 `--observe <runId>`。

---

## 五个真踩过的坑

1. **`git diff` 看不见未跟踪文件的内容** —— 新文件在闸门眼里只有文件名。
   症状是**闸门恒判负**（「新增 X 文件」这类需求永远过不去）而**不报错**。
   已在 `github.ts` 的 `renderUntrackedDiff` 修掉；回归测试 `test/diff-untracked.test.ts`。
2. **零改动 ≠ 通过**：模型可能**反问**而不是动手（实测 `num_turns=9`、0 次写文件、`end_turn`），
   而 coding 步照样 `step:done`。现在由 `codingChangeFailure` 当场判负。**提示词里
   「无人值守、不要反问」是必需项。**
3. **`CODING_MAX_BUDGET_USD` 是名义成本**：CLI 用自带价目表算，接中转站时**与实付无关**，
   却能在 249s 处掐断一次正常编码（`Reached maximum budget ($2)`）。接中转站先调大。
4. **`text` 不是 JSON**：MCP 工具的 `content[0].text` 是给人读的文本，结构化数据在
   `structuredContent` —— 直接 `JSON.parse` 必挂。
5. **刚 `dev_start` 完查 `run_status` 可能「查不到」**：子进程还没落第一条记录。
   重试几秒即可，**不要当成错误**（工具里已加了这句说明）。

## 归因纪律

失败时先看 `run:end` 的 `reason` 属于哪一类，再决定查哪里：

| reason 里出现 | 该查 |
|---|---|
| `NO_CHANGES@coding` | 模型行为 / 提示词 / 围栏是否全拦了 |
| `Reached maximum budget` / `CODING_TIMEOUT` | 上限配置，不是代码 |
| `GATE_REJECTED@test` + `requirementMet=false` | **先看 diff 里有没有新文件内容**（坑 1） |
| `LLM_HTTP_4xx` / 403 | 端点与凭据（与代码无关） |
| `no-coding-credentials` | `~/.claude/settings.json` 或 `CODING_ANTHROPIC_*` |
