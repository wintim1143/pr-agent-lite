#!/usr/bin/env python3
"""文档体检 —— 检查文档里是否混入了机器相关信息、或指向仓库外的实现。

## 为什么需要它

两条硬约定，靠人自觉守不住，得能自动查：

1. **交付形态是远程服务器上的服务** —— 文档里写死的机器路径、服务器地址，
   部署时必然变成错误信息，还会让接手的人照错的路径去配环境。
2. **本仓库自成一体** —— 参考代码副本（`reference/`）就在仓库里，文档不应再指向
   任何仓库外的实现，否则换一台机器就找不到东西。

## 检查项

| 类别 | 具体 |
|---|---|
| 绝对路径 | 盘符（`C:\\` / `D:/`）、UNC（`\\\\host\\share`）、家目录（`~/` `~\\`） |
| 主机信息 | IPv4 地址、SSH 私钥字段、`ssh <host>` 调用 |
| 依赖路径 | `node_modules/…` |
| 外部指向 | 指向仓库外实现的措辞（见 `BANNED`），以及遗留身份标识 |
| 自定义禁止词 | 由 `--forbid` 传入（正则） |

## 不该被误杀的

- **仓库内相对路径**（`reference/src/…`、`.workbuddy/memory/…`）—— 跨机器成立，是正常的
- **参考副本内的文件名 + 行号**（`adapters/github.ts:375-394`）—— 这是「借鉴什么」的必要标识
- **普通域名**（官方文档 URL）—— 只有 IP 才算主机信息

## 默认跳过

- `.workbuddy/` —— agent 的过程记录，含本机信息是正常的
- `reference/` —— 抽取来的原料，不是本项目文档；它内部保留了源实现的测试样例
  （如 `D:/code/x` 这种**路径格式样例**，是函数行为的契约，不是机器事实）

想连这些一起查就传 `--exclude ""`。

## 用法

    python check-docs.py                     # 检查当前目录下所有 .md
    python check-docs.py --dir <目录>
    python check-docs.py --exclude ""        # 不跳过任何目录
    python check-docs.py --forbid <正则>     # 追加禁止词

退出码：0 = 干净；1 = 有命中。
⚠️ 只读，不修改任何文件。
"""

from __future__ import annotations

import argparse
import os
import re
import sys

SKIP_DIRS = {".git", "node_modules", ".upstream", "dist", "build", "__pycache__"}

#: 默认跳过的目录（`--exclude ""` 可关掉）
DEFAULT_EXCLUDE = ".workbuddy,reference"

#: 「文档不应指向仓库外」这条约定的默认禁止词。
#: 参考代码副本就在 `reference/`，没必要再指向别处；这些措辞会让人（和 agent）
#: 去找一个不存在的地方。
BANNED: list[tuple[str, re.Pattern[str], str]] = [
    ("外部指向", re.compile(r"源项目|源文件|源实现"), "指向仓库外的实现，应写「参考副本」"),
    ("外部指向", re.compile(r"旧项目|另行检出|需要时检出"), "外部依赖措辞，应写「参考副本」"),
    ("身份残留", re.compile(r"pr-agent", re.I), "遗留身份标识"),
]

CHECKS: list[tuple[str, re.Pattern[str], str]] = [
    ("绝对路径", re.compile(r"(?<![A-Za-z0-9])[A-Za-z]:[\\/]"), "盘符开头的路径"),
    ("绝对路径", re.compile(r"\\\\[A-Za-z0-9_.-]+[\\/]"), "UNC 路径"),
    ("绝对路径", re.compile(r"(?<![A-Za-z0-9])~[\\/]"), "家目录"),
    ("主机信息", re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b"), "IPv4 地址"),
    ("主机信息", re.compile(r"\bIdentityFile\b"), "SSH 密钥字段"),
    ("主机信息", re.compile(r"\bssh\s+[A-Za-z][\w.-]*"), "ssh 调用"),
    ("依赖路径", re.compile(r"node_modules[\\/]"), "依赖安装目录"),
] + BANNED


def scan(path: str, extra: list[tuple[str, re.Pattern[str], str]]) -> list[tuple[int, str, str, str]]:
    """返回 [(行号, 类别, 说明, 该行原文)]。"""
    hits: list[tuple[int, str, str, str]] = []
    try:
        text = open(path, encoding="utf-8", errors="ignore").read()
    except OSError as exc:  # pragma: no cover
        print(f"  读取失败 {path}: {exc}", file=sys.stderr)
        return hits

    for lineno, line in enumerate(text.splitlines(), 1):
        for kind, pattern, desc in CHECKS + extra:
            if pattern.search(line):
                hits.append((lineno, kind, desc, line.strip()))
    return hits


def main() -> None:
    ap = argparse.ArgumentParser(description="文档体检（只读）")
    ap.add_argument("--dir", default=".", help="要检查的目录（默认当前目录）")
    ap.add_argument("--ext", default=".md", help="只检查这些扩展名，逗号分隔（默认 .md）")
    ap.add_argument(
        "--exclude",
        default=DEFAULT_EXCLUDE,
        help=f"跳过的目录名，逗号分隔（默认 {DEFAULT_EXCLUDE}；传空串则不跳过）",
    )
    ap.add_argument(
        "--forbid",
        nargs="*",
        default=[],
        metavar="PATTERN",
        help="追加禁止词（正则），如仓库地址、服务商域名",
    )
    args = ap.parse_args()

    extra = [(f"禁止词", re.compile(p), p) for p in args.forbid]
    exts = tuple(e.strip() for e in args.ext.split(",") if e.strip())
    skip = SKIP_DIRS | {d.strip() for d in args.exclude.split(",") if d.strip()}

    total = 0
    files = 0
    for root, dirs, names in os.walk(args.dir):
        dirs[:] = [d for d in dirs if d not in skip]
        for name in sorted(names):
            if not name.endswith(exts):
                continue
            files += 1
            rel = os.path.relpath(os.path.join(root, name), args.dir).replace("\\", "/")
            hits = scan(os.path.join(root, name), extra)
            if hits:
                print(f"\n{rel}")
                for lineno, kind, desc, line in hits:
                    total += 1
                    snippet = line if len(line) <= 100 else line[:97] + "..."
                    print(f"  {lineno:>4d}  [{kind}] {desc}")
                    print(f"        {snippet}")

    print()
    if total:
        print(f"✗ {files} 个文件中命中 {total} 处 —— 逐条确认是真问题还是误报。")
        print("  提示：仓库内相对路径与参考副本内的文件名+行号是允许的（跨机器成立）。")
        sys.exit(1)
    print(f"✓ {files} 个文件干净：无机器路径、无主机信息、无外部指向。")


if __name__ == "__main__":
    main()
