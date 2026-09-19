#!/usr/bin/env python3
"""测试基线审计 —— 统计逐文件用例数，并按 import 追踪每个测试文件测的是哪些源模块。

## 为什么需要它

M1「项目自立」的出口验收要求「测试在服务器上全绿」，但**条数对不对**需要单独验 ——
少搬一个文件也可能全绿。本脚本就是那道核对：拿它跟 `test-baseline.json` 对，
才能证明「该搬的都搬了、该删的都删了」，而不是只证明「剩下的能跑」。

## 为什么「声明数」不等于「执行数」

`it.each(<数据>)` 声明一次、按数据组展开成多条。**CI 输出的是执行数**，
用声明数对不上账。

## ⚠️ 为什么 `it.each` 的展开必须做「不猜」的解析

首参有两种形态：
- **数组字面量** `it.each([...])` —— 直接数顶层元素；
- **标识符** `it.each(denied)` / `it.each(PROTECTED_PATHS)` —— 长度在别处。

早期版本对第二种**按 1 计**，于是 `guard.test.ts` 被数成 46 条而 jest 实际跑 95 条 ——
**差了 49 条且不报错**。这正是本仓库反复在防的那类失败：数字看着像真的。

现在两条路解析标识符：① 同文件的 `const NAME = [...]`；② 相对 import 的模块里的
`export const NAME = [...]`。**两条都走不通就计入 `unresolved_each` 并在报告里点名**，
绝不假装数准了。

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

# 完全不进生产的下游依赖（用于标注「测框架」还是「测业务」）。
# 新项目已零框架依赖，这两项保留是为了审计**参考副本**（reference/）时仍能识别。
FRAMEWORK_MARKERS = ("@mastra/", "@midwayjs/")

# 只做装配、零业务逻辑的入口。判定「只测框架」时要排除，否则会被漏判。
ASSEMBLY_MARKERS = ("/src/mastra", "/src/index")


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
    if not has_any:
        return 0
    # ⚠️ 尾逗号不是「一个元素」：本项目所有数组都写成多行 + 尾逗号，
    # 不回看这一下，`[a, b, c,]` 会被数成 4 个（实测把 6 元素数成 7）。
    # i 指向**闭合括号本身**，所以从它前一个字符往回看
    k = min(i, len(inner)) - 1
    while k >= 0 and inner[k].isspace():
        k -= 1
    trailing_comma = k >= 0 and inner[k] == ","
    return count + (0 if trailing_comma else 1)


def find_array_literal(name: str, text: str, before: int | None = None) -> str | None:
    """在源码里找 `[export] const NAME[: T] = [ ... ]`，返回**含方括号**的完整字面量。

    ⚠️ 必须含括号：`split_top_level()` 是按「depth 恰为 1 时数逗号」实现的，
    它期望拿到带外层括号的字面量。只传内部会导致**元素本身是数组**时
    （`[['a',1],['b',2]]`）逗号全落在 depth 0，长度被算成 2 ——
    实测把 `guard.test.ts` 的 14 条 `denied` 数成 2 条。

    `before` 给定时，只认**该位置之前最近的一次**定义 —— 同一文件里不同 `describe`
    各自声明同名 `const denied = [...]` 是常见写法，取「第一个」会系统性少算。

    找不到返回 `None`。注意这是文本层面的括号配对，字符串里出现裸 `]` 会算错 ——
    因此解析结果只用作「比 1 更准的估计」，且未解析成功的会被**点名上报**。
    """
    pat = re.compile(
        r"(?:export\s+)?(?:const|let|var)\s+" + re.escape(name) + r"\s*(?::[^=]+?)?=\s*\["
    )
    matches = [mm for mm in pat.finditer(text) if before is None or mm.start() < before]
    if not matches:
        return None
    m = matches[-1]
    start = m.end() - 1  # 指向 '['
    depth = 0
    i = start
    while i < len(text):
        c = text[i]
        if c == "[":
            depth += 1
        elif c == "]":
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
        i += 1
    return None


def resolve_module(spec: str, from_file: str, repo: str) -> str | None:
    """把相对 import 说明符解析成实际文件路径（依次试 .ts / .tsx / index.ts）。"""
    if not spec.startswith("."):
        return None
    base = os.path.normpath(os.path.join(os.path.dirname(from_file), spec))
    for cand in (base + ".ts", base + ".tsx", os.path.join(base, "index.ts")):
        if os.path.isfile(cand):
            return cand
    return None


def count_cases(text: str, resolve_each=None) -> tuple[int, int, int, int]:
    """返回 (声明数, it.each 处数, 实际执行数, 未能展开的 each 处数)。"""
    decl = 0
    each_sites = 0
    executed = 0
    unresolved = 0

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
            continue

        # `it.each(<标识符>)` —— 去别处解析长度。解析不出**按 1 计但记名**，
        # 不静默当作数准了（历史事故：49 条差异无人察觉）。
        name = stripped.strip()
        is_ident = bool(re.fullmatch(r"[A-Za-z_$][\w$]*", name))
        n = resolve_each(name, m.start()) if (resolve_each and is_ident) else None
        if n is None:
            unresolved += 1
            executed += 1
        else:
            executed += n

    return decl, each_sites, executed, unresolved


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

            imports = re.findall(r"""(?:from|require\()\s*['"]([^'"]+)['"]""", text)
            rel_imports = [i for i in imports if i.startswith(".")]
            # 供 count_cases 解析 `it.each(<标识符>)`：先同文件，再相对 import 的模块。
            mod_cache: dict[str, str] = {}

            def resolve_each(var_name: str, pos: int) -> int | None:
                lit = find_array_literal(var_name, text, before=pos)
                if lit is not None:
                    return split_top_level(lit)
                for spec in rel_imports:
                    mod = resolve_module(spec, path, repo)
                    if not mod:
                        continue
                    if mod not in mod_cache:
                        mod_cache[mod] = open(mod, encoding="utf-8", errors="ignore").read()
                    lit = find_array_literal(var_name, mod_cache[mod])
                    if lit is not None:
                        return split_top_level(lit)
                return None

            decl, each_sites, executed, unresolved = count_cases(text, resolve_each)
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
            # 注意装配层入口本身也长在框架包上（它只做装配，零业务逻辑），
            # 要排除掉，否则「只测装配层」的测试文件会被漏判。
            business_mods = [
                m for m in src_mods if not any(re.search(p + r"/?$", m) for p in ASSEMBLY_MARKERS)
            ]

            rows.append(
                {
                    "file": rel,
                    "is_setup": not name.endswith(".test.ts"),
                    "lines": len(text.splitlines()),
                    "declared": decl,
                    "each_sites": each_sites,
                    "unresolved_each": unresolved,
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
        warn = f"  ⚠ 未展开 {r['unresolved_each']} 处" if r.get("unresolved_each") else ""
        print(
            f"{r['file']:46s}{r['lines']:>6d}{r['declared']:>6d}"
            f"{r['each_sites']:>6d}{r['executed']:>6d}{flag}{warn}"
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
    print(
        f"声明 → 执行：{sum(r['declared'] for r in tests)} → {sum(r['executed'] for r in tests)}"
        f"（it.each 展开多出 {sum(r['executed'] - r['declared'] for r in tests)} 条）"
    )

    unres = sum(r.get("unresolved_each", 0) for r in tests)
    if unres:
        print()
        print(f"⚠️ 有 {unres} 处 it.each 的展开数**未能解析**（已保守按 1 计）。")
        print("   这些文件的『执行』列是**下界**，不能当准数用 —— 以 `npx jest` 的输出为准：")
        for r in tests:
            if r.get("unresolved_each"):
                print(f"   - {r['file']}（{r['unresolved_each']} 处）")

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
    print(
        f"  文件 {len(base_t)} → {len(cur_t)}    "
        f"声明 {sum(r['declared'] for r in base_t.values())} → {sum(r['declared'] for r in cur_t.values())}    "
        f"执行 {sum(r['executed'] for r in base_t.values())} → {sum(r['executed'] for r in cur_t.values())}"
    )
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
        b, c = base_t[f]["executed"], cur_t[f]["executed"]
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
