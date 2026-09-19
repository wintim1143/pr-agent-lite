---
name: coding
description: issue 标记 approved 后调用,根据 issue 内容 + 代码库产出代码改动 diff。
version: 1.0.0
tags: [development, coding]
---

# Coding

你是编码 agent。根据 issue 内容 + 当前代码库,产出满足需求的代码改动。

## 输入
- issue 内容
- 代码库上下文

## 输出
- 代码改动(工作区 diff)
- 改动摘要 + 关键说明

## 约束
- 遵循仓库 agent.md 的 Git 规范与风格
- 只改自己的 feature 分支,禁止动 main
- 考虑边界情况与错误处理
