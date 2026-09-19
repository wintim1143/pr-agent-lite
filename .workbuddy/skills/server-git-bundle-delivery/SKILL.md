---
name: server-git-bundle-delivery
description: 把某个 git 仓库的基线投递到「不持代码平台凭据、不直连代码平台」的服务器，并验证服务器取到的 base 与开发机声明一致。适用范围是**第二版及以后**（接真实靶子仓库时）；当出现以下情况时使用——服务器上的常驻副本要更新基线、靶子仓库怎么进服务器、服务器没有 key 怎么拿到最新代码、要断言「分支不是从过期基线建出来的」。
agent_created: true
---

# 用 git bundle 把仓库基线投递到无凭据服务器

> ⚠️ **第一版不用这个**：第一版被编码的代码是**服务器上自建的本地仓**（无上游远端，见 `需求说明.md` D3），没有投递需求。本 skill 在**接真实靶子仓库**时才启用。

**适用前提**：服务器不能直连代码平台（无凭据 / 出口被阻断），但服务器与开发机之间可传输文件。
背景见 `需求说明.md` 的 D3 / D7 与 `AGENTS.md` §4「代码平台通道」。

## 为什么是 bundle，不是 rsync 整个目录

服务器上的常驻副本**就是编码 agent 的工作区**（会建分支、改文件）。

- 整目录 `rsync --delete` **会抹掉工作区改动** —— 错。
- `git bundle` **只更新 refs 与对象，不碰工作树** —— 对。

代价：bundle 是全量快照（小仓 300 KB 量级，可忽略）。仓库变大后再考虑用范围语法做增量（**未实测**）。

## 步骤

```bash
# 1) 开发机：打一个包含完整历史的 bundle
git -C <本地仓库> bundle create /tmp/repo.bundle --all
git -C <本地仓库> bundle verify /tmp/repo.bundle     # 应看到 "records a complete history"

# 2) 记下开发机声明的基线（后面要比对的事实来源）
git -C <本地仓库> rev-parse HEAD

# 3) 传输
scp /tmp/repo.bundle <host>:/tmp/repo.bundle

# 4) 服务器：首次投递时初始化，之后每次都是同一条 fetch
cd <服务器上的常驻副本>
git init -q .                                        # 仅首次
git fetch /tmp/repo.bundle 'refs/heads/*:refs/remotes/origin/*'

# 5) 验证：两侧 SHA 必须一致
git rev-parse refs/remotes/origin/main
```

## 验证判据（唯一可断言的「基线新鲜」）

**服务器取出的 base SHA == 开发机声明值**。

这一步不能省：`createBranchVerified` 用的是**本地 base ref**、全程不 fetch，基线过期时**不报错**（`AGENTS.md` 硬性注意 #4）。把比对结果写进日志，让「新鲜」变成可查的事实。

## 坑

| 坑 | 症状 | 处理 |
|---|---|---|
| `git fetch <bundle>` 不带 refspec | 只落到 `FETCH_HEAD`，remote-tracking ref **不更新** | 必须显式写 `'refs/heads/*:refs/remotes/origin/*'` |
| 服务器无提交身份 | `git commit` 报 `Author identity unknown` | 显式 `-c user.name=… -c user.email=…` 或配 global。**裸 `git commit` 会失败** |
| 拿 bundle 当工作副本用 | bundle 是只读快照，不能在它里面开发 | 它是**传输格式**，落地后是正常的 `.git` |
| 用 bundle 分发工作区 | 不含未提交改动与未跟踪文件 | 只传**已提交的基线**；工作区改动走别的通道 |

## 已验证事实（勿重复摸索）

两条命令在两台机器间实测通过，**版本无需对齐**：开发机 git 2.39.5 ↔ 服务器 git 2.43.0。

投递后以下动作全部正常：建分支（`git branch <b> refs/remotes/origin/main`）、`rev-list --count <base>..<branch>`（即 `countAhead`）、`git commit`。
