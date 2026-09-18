#!/usr/bin/env python3
"""还原 mattpocock/skills 被截断的 SKILL.md 正文。

背景：2026-08-14 的导入/转换流程只写入了 frontmatter，正文全丢
（25 个 skill 的 SKILL.md 正文均为 0 字节）。本脚本用上游正文补齐，
保留本地已本地化（中文）的 frontmatter 与 agents/openai.yaml 字段映射。
不新增上游有、本地没有的 skill。

上游获取方式：优先读本地克隆（--source-dir），
因为 HTTP 代理只放通 api.github.com，raw.githubusercontent.com 会 502。

用法：
    python restore-matt-skills.py                 # 预览（默认，不写盘）
    python restore-matt-skills.py --apply         # 写入，先备份 .bak
    python restore-matt-skills.py --only tdd,handoff --apply
"""

import argparse
import os
import re
import shutil
import sys

SKILLS_ROOT = os.path.join(os.path.expanduser("~"), ".workbuddy", "skills")
DEFAULT_SOURCE = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    ".upstream",
    "mattpocock-skills",
    "skills",
)
# 本地存在但不来自 mattpocock/skills，不要动
FOREIGN = {
    "bilibili-api__skillhub",
    "jewelry-cad-parametric",
    "parallel-code-review",
    "steelman-debate",
}


def split_frontmatter(text):
    """返回 (frontmatter 块含 --- 定界符, 正文)。无 frontmatter 时前者为 None。"""
    m = re.match(r"^(---\r?\n.*?\r?\n---)\r?\n?(.*)$", text, re.S)
    if not m:
        return None, text
    return m.group(1), m.group(2)


def build_upstream_map(source_dir):
    """扫描上游目录，返回 {skill 目录名: SKILL.md 绝对路径}。"""
    found = {}
    for root, _dirs, files in os.walk(source_dir):
        if "SKILL.md" in files:
            found[os.path.basename(root)] = os.path.join(root, "SKILL.md")
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="实际写入（默认仅预览）")
    ap.add_argument("--skills-root", default=SKILLS_ROOT)
    ap.add_argument("--source-dir", default=DEFAULT_SOURCE)
    ap.add_argument("--only", default="", help="逗号分隔，只处理指定 skill")
    args = ap.parse_args()
    only = {s.strip() for s in args.only.split(",") if s.strip()}

    if not os.path.isdir(args.source_dir):
        print(f"上游目录不存在：{args.source_dir}")
        print("先执行：git clone --depth 1 https://github.com/mattpocock/skills.git "
              ".upstream/mattpocock-skills")
        return 1

    upstream = build_upstream_map(args.source_dir)
    local_dirs = sorted(
        d for d in os.listdir(args.skills_root)
        if os.path.isfile(os.path.join(args.skills_root, d, "SKILL.md"))
    )

    print(f"上游来源：{args.source_dir}")
    print(f"上游 SKILL.md：{len(upstream)} 个；本地已装：{len(local_dirs)} 个\n")

    plan, skipped = [], []
    for name in local_dirs:
        if only and name not in only:
            continue
        if name in FOREIGN:
            continue
        local_path = os.path.join(args.skills_root, name, "SKILL.md")
        local_text = open(local_path, encoding="utf-8").read()
        fm, body = split_frontmatter(local_text)

        if name not in upstream:
            skipped.append((name, "非 mattpocock/skills 来源，跳过"))
            continue
        if fm is None:
            skipped.append((name, "本地无 frontmatter，跳过以免误改"))
            continue
        if body.strip():
            skipped.append((name, f"正文已存在（{len(body.strip())}B）"))
            continue

        up_text = open(upstream[name], encoding="utf-8").read()
        _up_fm, up_body = split_frontmatter(up_text)
        if not up_body.strip():
            skipped.append((name, "上游同样无正文"))
            continue

        body_clean = up_body.strip()
        plan.append((name, local_path, len(local_text), len(fm) + 2 + len(body_clean) + 1, body_clean))

    print(f"{'skill':34s} {'现有':>8s} {'补齐后':>9s}")
    print("-" * 56)
    for name, _p, cur, new, _b in plan:
        print(f"{name:34s} {cur:>7d}B {new:>8d}B")
    for name, why in skipped:
        print(f"{name:34s} {'—':>8s} {'—':>9s}  跳过：{why}")

    print(f"\n待处理 {len(plan)} 个，新增正文合计 {sum(n - c for _, _, c, n, _ in plan)} 字节。")

    if not args.apply:
        print("\n[预览模式] 未写入任何文件。确认无误后加 --apply 执行。")
        return 0

    print()
    for name, path, _c, _n, body_clean in plan:
        shutil.copy2(path, path + ".bak")
        fm = split_frontmatter(open(path, encoding="utf-8").read())[0]
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(fm + "\n\n" + body_clean + "\n")
        print(f"已还原 {name}/SKILL.md（备份 {name}/SKILL.md.bak）", flush=True)

    print(f"\n完成 {len(plan)} 个。回滚：把各自 SKILL.md.bak 覆盖回 SKILL.md。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
