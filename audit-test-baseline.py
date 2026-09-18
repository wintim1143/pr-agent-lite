#!/usr/bin/env python3
"""测试基线审计 —— 统计逐文件用例数，并按 import 追踪每个测试文件测的是哪些源模块。

## 为什么需要它

`借鉴清单.md` §7 给出的基线是 **16 文件 / 222 声明 / 243 执行**，
新项目目标是 **13 文件 + jest.setup.ts / 206 声明 / 227 执行**。
M1「项目自立」的出口验收要求「测试在服务器上全绿」，但**条数对不对**需要单独验 ——
少搬一个文件也可能全绿。本脚本就是那道核对。

## 为什么「声明数」不等于「执行数」

`it.each([...])` 声明一次、按数据组展开成多条。源项目里有 9 处，展开后多出 21 条。
**CI 输出的是执行数**，用声明数对不上账。

## 用法

    python audit-test-baseline.py --repo <仓库根目录>                   # 输出全表
    python audit-test-baseline.py --repo <路径> --json                  # 机器可读输出（供 diff 用）
    python audit-test-baseline.py --repo <路径> --diff baseline.json    # 与历史基线对比

⚠️ 只读，不写任何文件、不跑测试。
⚠️ 仓库根目录必须由 `--repo` 显式指定 —— 本脚本**不内置任何机器路径**。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

# 完全不进生产的下游依赖（用于标注「测框架」还是「测业务」）
FRAMEWORK_MARKERS = ("@mastra/", "@midwayjs/")


def split_top_level(inner: str) -> int:
    """数一个数组字面量里的顶层元素个数（用于 it.each 展开计数）。"""
    depth = 0
    count = 0
    has_any = False
    in_str: str | None = None
    escaped = False
    i = 0
    while i < len(inner):
        c = inner[i]
        if in_str:
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == in_str:
                in_str = None
        else:
            if c in "\"'`":
                in_str = c
                has_any = True
            elif c in "([{":
                depth += 1
                if depth == 1:
                    pass
                has_any = True
            elif c in ")]}":
                depth -= 1
                if depth == 0:
                    break
            elif c == "," and depth == 1:
                count += 1
            elif depth == 1 or (depth == 0 and not c.isspace()):
                has_any = True
        i += 1
    return count + 1 if has_any else 0


def count_cases(text: str) -> tuple[int, int, int]:
    """返回 (声明数, it.each 处数, 实际执行数)。"""
    decl = 0
    each_sites = 0
    executed = 0

    # 先按顺序扫出所有 it( / test( / it.each( / test.each(
    pattern = re.compile(r"\b(?:it|test)(\.each)?\s*\(")
    for m in pattern.finditer(text):
        decl += 1
        if not m.group(1):
            executed += 1
            continue
        each_sites += 1
        # 取该调用的第一个参数
        start = m.end()
        depth = 1
        j = start
        while j < len(text) and depth > 0:
            c = text[j]
            if c in "([{":
                depth += 1
            elif c in ")]}":
                depth -= 1
            j += 1
        inner = text[start : j - 1]
        stripped = inner.lstrip()
        if stripped.startswith("["):
            executed += split_top_level(stripped)
        else:
            # it.each(VAR) 或 it.each`table` —— 静态数不出来，按 1 计并标注
            executed += 1
    return decl, each_sites, executed


def audit(repo: str) -> list[dict]:
    test_root = os.path.join(repo, "test")
    if not os.path.isdir(test_root):
        sys.exit(f"找不到测试目录：{test_root}")

    rows = []
    for r, _d, files in os.walk(test_root):
        for name in sorted(files):
            if not name.endswith((".ts", ".tsx")):
                continue
            path = os.path.join(r, name)
            rel = os.path.relpath(path, repo).replace("\\", "/")
            text = open(path, encoding="utf-8", errors="ignore").read()

            decl, each_sites, executed = count_cases(text)
            imports = re.findall(r"""(?:from|require\()\s*['"]([^'"]+)['"]""", text)
            src_mods = sorted({i for i in imports if i.startswith((".", "@/"))})
            ext_mods = sorted(
                {
                    i
                    for i in imports
                    if not i.startswith((".", "@/")) and not i.startswith("node:")
                }
            )
            touches_framework = sorted(
                m for m in ext_mods if any(m.startswith(k) for k in FRAMEWORK_MARKERS)
            )
            # 只测框架的判定：import 了框架包，且**没有**指向任何具体业务模块。
            # 注意框架装配层的入口本身就是框架包（它只做装配，零业务逻辑），
            # 要排除掉，否则「只测装配层」的测试文件会被漏判。
            business_mods = [
                m
                for m in src_mods
                if not re.search(r"/src/mastra/?$", m)
            ]

            rows.append(
                {
                    "file": rel,
                    "is_setup": not name.endswith(".test.ts"),
                    "lines": len(text.splitlines()),
                    "declared": decl,
                    "each_sites": each_sites,
                    "executed": executed,
                    "src_modules": src_mods,
                    "ext_modules": ext_mods,
                    "framework_only": bool(touches_framework) and not business_mods,
                }
            )
    rows.sort(key=lambda x: x["file"])
    return rows


def report(rows: list[dict]) -> None:
    tests = [r for r in rows if not r["is_setup"]]
    print(f"{'file':46s}{'lines':>6s}{'decl':>6s}{'each':>6s}{'exec':>6s}")
    print("-" * 72)
    for r in rows:
        flag = "  [setup]" if r["is_setup"] else ""
        print(
            f"{r['file']:46s}{r['lines']:>6d}{r['declared']:>6d}"
            f"{r['each_sites']:>6d}{r['executed']:>6d}{flag}"
        )
        for s in r["src_modules"]:
            print(f"        src -> {s}")
    print("-" * 72)
    print(
        f"{'合计（不含 setup）':46s}"
        f"{sum(r['lines'] for r in tests):>6d}"
        f"{sum(r['declared'] for r in tests):>6d}"
        f"{sum(r['each_sites'] for r in tests):>6d}"
        f"{sum(r['executed'] for r in tests):>6d}"
    )
    print()
    print(f"测试文件数: {len(tests)}   setup 文件: {len(rows) - len(tests)}")
    print(f"声明 → 执行：{sum(r['declared'] for r in tests)} → {sum(r['executed'] for r in tests)}"
          f"（it.each 展开多出 {sum(r['executed'] - r['declared'] for r in tests)} 条）")

    fw = [r for r in tests if r["framework_only"]]
    if fw:
        print()
        print("只测框架、零业务模块的（新项目不借鉴）：")
        for r in fw:
            print(f"  - {r['file']}  ({r['declared']} 条)")


def diff(rows: list[dict], baseline_path: str) -> None:
    base = {r["file"]: r for r in json.load(open(baseline_path, encoding="utf-8"))}
    cur = {r["file"]: r for r in rows}
    base_t = {k: v for k, v in base.items() if not v["is_setup"]}
    cur_t = {k: v for k, v in cur.items() if not v["is_setup"]}

    print(f"基线: {baseline_path}")
    print(f"  文件 {len(base_t)} → {len(cur_t)}    "
          f"声明 {sum(r['declared'] for r in base_t.values())} → {sum(r['declared'] for r in cur_t.values())}    "
          f"执行 {sum(r['executed'] for r in base_t.values())} → {sum(r['executed'] for r in cur_t.values())}")
    print()
    gone = sorted(set(base_t) - set(cur_t))
    new = sorted(set(cur_t) - set(base_t))
    if gone:
        print("已消失（确认是有意删除）：")
        for g in gone:
            print(f"  - {g}  (原 {base_t[g]['declared']} 条)")
    if new:
        print("新增：")
        for n in new:
            print(f"  + {n}  ({cur_t[n]['declared']} 条)")
    print()
    print("逐文件条数变化：")
    changed = False
    for f in sorted(set(base_t) & set(cur_t)):
        b, c = base_t[f]["declared"], cur_t[f]["declared"]
        if b != c:
            changed = True
            print(f"  {f:46s} {b:>4d} → {c:>4d}  ({c - b:+d})")
    if not changed:
        print("  （无变化）")


def main() -> None:
    ap = argparse.ArgumentParser(description="测试基线审计（只读）")
    ap.add_argument("--repo", required=True, help="要审计的仓库根目录（必填）")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--diff", metavar="BASELINE_JSON", help="与历史基线的 JSON 对比")
    args = ap.parse_args()

    rows = audit(args.repo)
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    report(rows)
    if args.diff:
        print()
        diff(rows, args.diff)


if __name__ == "__main__":
    main()
