#!/usr/bin/env python3
"""scripts/audit_ui_asset_literals.py —— **只读**体检 `tests/integration/test_ui_assets.py`
里「锁源码字面量」的断言，并指出哪些会在搬运（move 笔）之后假红。

## 它回答什么问题

`test_ui_assets.py` 有一类断言长这样：

    assert "<某段源码原文>" in script        # script = app.js 全文
    assert "<某段源码原文>" in _function_body_any("X")

这在本仓库是**合法**手段（界面没有 JS 测试运行器，只能做静态约定），但有一个已知的坑：
**断言锁的是「某一行源码」而不是「某个行为」时，函数一搬进视图模块，这条断言就假红。**
2026-10-30 一晚踩了三次（刀 9.1 的 pausePageThumbnails、刀 9.2 的 refreshRecognizedPages、
更早的 divergenceCandidatesOn）。

所以这个脚本给三个数：

    ① 全部字面量断言有多少条（`assert <字面量> in <变量>` / `not in`）
    ② 其中「源码片段形态」有多少条（其余是 CSS 选择器 / HTML id 属性 / 纯名字与常量）
    ③ 其中**会因搬运假红**的有多少条、分别是哪几行

③ 的判据是**现算的**，不是名单：从 `tests/js/boundary.test.mjs` 的 `kinds` 表读出
「kind = T 且带 death 的导出键」= 还要被搬走（或删掉）的函数；如果某条断言锁的源码片段
**只出现在这些函数体内**，那它就会在那一刀假红。

## 用法

    .venv/bin/python scripts/audit_ui_asset_literals.py            # 汇总（三个数）+ 会假红的那几条
    .venv/bin/python scripts/audit_ui_asset_literals.py --list     # 全量逐条（行号 · 原文 · 目标变量 · 风险）
    .venv/bin/python scripts/audit_ui_asset_literals.py --json     # 机读（对集 / 给别的脚本用）

`--min-death N` 只看死期 ≥ N 的键（例如 9.3 开工前 `--min-death 9.3`）。

退出码：`0` 跑完了（**不代表"没问题"**，看输出）；`2` 前置不满足（找不到测试文件 / 解析失败）；
`70` 脚本内部异常（`INTERNAL ERROR:` 开头）。只读、cwd 无关（按脚本自身位置定位仓库）。

## 为什么要有它

这个数是**会长回来的**：今天改完 8 条，下一刀搬新函数、下一批测试又会写出新的整行断言。
所以别引用任何一次跑出来的数字，**要查就现跑**；本文档只写"怎么重跑"，不写结论表。
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TESTS = REPO / "tests/integration/test_ui_assets.py"
STATIC = REPO / "backend/book2text/static"
BOUNDARY = REPO / "tests/js/boundary.test.mjs"

EXIT_OK = 0
EXIT_PRECONDITION = 2
EXIT_INTERNAL = 70

#: 断言右侧变量名 → 它查的是哪几份源码。
#: `app.js` = 只查外壳；`app+module` = `_script_with_view()`（app.js + 某个视图模块）；
#: `slice` = `_function_body*()` 切出来的函数体（只看它自己那一份）。
COMBINED_TARGETS = {
    "both", "index_both", "pages_both", "preview_both",
    "library_script", "preview_script", "index_script",
}

#: 断言右侧查的是 CSS / HTML（app.css、index.html）——不随 JS 搬运变红。
CSS_TARGETS = {"styles", "css"}
HTML_TARGETS = {"page", "page_html", "html"}

#: 「源码片段」的形态判据：含源码语法记号，或"整条语句"（含括号且以 ; { } 收尾）。
#: 纯名字 / 常量 / CSS 选择器 / HTML 属性一律不算 —— 它们不随搬运变红。
SNIPPET_MARKERS = (
    "if (", "if(", "for (", "while (", "const ", "let ", "await ", "return ",
    "function ", "window.", "document.", "=>", "===", "!==", "&&", "||",
    ".then(", ".catch(", "?.", "querySelector(", "getElementById(",
    "addEventListener(", "textContent", ".hidden", "classList", "setAttribute(",
    ".style.", "Math.", "new ", "try {", "catch (", "throw ",
)


def is_code_snippet(text: str) -> bool:
    if any(marker in text for marker in SNIPPET_MARKERS):
        return True
    return "(" in text and ")" in text and text.rstrip().endswith((";", "{", "}"))


def load_sources() -> dict[str, str]:
    if not STATIC.is_dir():
        raise SystemExit(EXIT_PRECONDITION)
    return {
        path.name: path.read_text(encoding="utf-8")
        for path in sorted(STATIC.iterdir())
        if path.is_file() and path.suffix in (".js", ".html", ".css")
    }


def function_spans(text: str) -> list[tuple[str, int, int]]:
    """列 0 起的 `function name(` 及其体（到下一个顶层声明前最后一个 `}`）。"""
    lines = text.split("\n")

    def is_decl(line: str) -> bool:
        return bool(re.match(r"^(?:async )?function [A-Za-z0-9_$]+\(", line)) or bool(
            re.match(r"^(?:const|let|var|class) [A-Za-z0-9_$]+", line)
        )

    starts = [i for i, line in enumerate(lines) if is_decl(line)]
    spans: list[tuple[str, int, int]] = []
    for i, line in enumerate(lines):
        match = re.match(r"^(?:async )?function ([A-Za-z0-9_$]+)\s*\(", line)
        if not match:
            continue
        nxt = next((s for s in starts if s > i), len(lines))
        end = nxt - 1
        while end > i and lines[end].strip() != "}":
            end -= 1
        spans.append((match.group(1), i, end))
    return spans


def movable_keys(min_death: float) -> dict[str, float]:
    """`kinds` 表里 kind=T 且带 death 的键 → 死期（= 还要被搬走或删掉的函数）。"""
    if not BOUNDARY.is_file():
        raise SystemExit(EXIT_PRECONDITION)
    keys: dict[str, float] = {}
    for line in BOUNDARY.read_text(encoding="utf-8").split("\n"):
        match = re.match(r'\s*([A-Za-z_$][\w$]*): \{ kind: "T", death: ([\d.]+) \}', line)
        if match and float(match.group(2)) >= min_death:
            keys[match.group(1)] = float(match.group(2))
    return keys


def collect_asserts() -> list[dict]:
    if not TESTS.is_file():
        raise SystemExit(EXIT_PRECONDITION)
    source = TESTS.read_text(encoding="utf-8")
    tree = ast.parse(source)
    lines = source.split("\n")

    docs: dict[int, tuple[str, str, int]] = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            first = (ast.get_docstring(node) or "").strip().split("\n")[0]
            docs[node.lineno] = (node.name, first, node.end_lineno)

    def enclosing(lineno: int) -> tuple[str, str]:
        best = None
        for start, (name, doc, end) in docs.items():
            if start <= lineno <= end and (best is None or start > best[0]):
                best = (start, name, doc)
        return (best[1], best[2]) if best else ("(模块级)", "")

    rows: list[dict] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assert) or not isinstance(node.test, ast.Compare):
            continue
        compare = node.test
        if len(compare.ops) != 1 or not isinstance(compare.ops[0], (ast.In, ast.NotIn)):
            continue
        left, right = compare.left, compare.comparators[0]
        if isinstance(right, ast.BinOp):
            # `assert "x" in script + pages_script`（拼接两份）→ 同「双份」，不随搬运变红
            name = "(拼接)"
        elif isinstance(right, ast.Name):
            name = right.id
        else:
            continue
        literals: list[str] = []
        if isinstance(left, ast.Constant) and isinstance(left.value, str):
            literals = [left.value]
        elif isinstance(left, ast.Name):
            # `for key in (...): assert key in script` —— 把元组里的字面量展开
            for ancestor in ast.walk(tree):
                if (
                    isinstance(ancestor, ast.For)
                    and isinstance(ancestor.iter, (ast.Tuple, ast.List))
                    and isinstance(ancestor.target, ast.Name)
                    and ancestor.target.id == left.id
                    and ancestor.lineno < node.lineno <= (ancestor.end_lineno or ancestor.lineno)
                ):
                    literals = [e.value for e in ancestor.iter.elts if isinstance(e, ast.Constant)]
                    break
        if not literals:
            continue
        test_name, doc = enclosing(node.lineno)
        rows.append({
            "line": node.lineno,
            "op": "in" if isinstance(compare.ops[0], ast.In) else "not in",
            "target": name,
            "literals": literals,
            "test": test_name,
            "doc": doc,
        })
    return rows


def judge(rows: list[dict], sources: dict[str, str], movable: dict[str, float]) -> list[dict]:
    js_spans = {name: function_spans(text) for name, text in sources.items() if name.endswith(".js")}

    def occurrences(literal: str):
        found = []
        for filename, text in sources.items():
            start = text.find(literal)
            while start != -1:
                line_no = text.count("\n", 0, start)  # 0-based
                host = "(顶层)"
                for func_name, begin, end in js_spans.get(filename, []):
                    if begin <= line_no <= end:
                        host = func_name
                found.append((filename, line_no + 1, host))
                start = text.find(literal, start + 1)
        return found

    out: list[dict] = []
    for row in rows:
        snippets = [lit for lit in row["literals"] if is_code_snippet(lit)]
        if not snippets:
            continue
        record = dict(row, snippets=snippets, hosts=[], risk="不会", why="")
        if row["op"] == "not in":
            record["risk"], record["why"] = "不会", "反向断言：字面量不存在正是它要的"
            out.append(record)
            continue
        if row["target"] in COMBINED_TARGETS or row["target"] == "(拼接)":
            record["risk"], record["why"] = "不会", "断言查 app.js + 模块两份，搬进模块照样命中"
            out.append(record)
            continue
        if row["target"] in CSS_TARGETS or row["target"] in HTML_TARGETS:
            record["risk"], record["why"] = "不会", "断言查 CSS / HTML（app.css、index.html），不随 JS 搬运变红"
            out.append(record)
            continue
        app_text = sources.get("app.js", "")
        hosts: set[str] = set()
        missing = False
        all_movable = True
        for literal in snippets:
            found = [item for item in occurrences(literal) if item[0] == "app.js"]
            if not found:
                missing = True
                continue
            hosts |= {host for _, _, host in found if host != "(顶层)"}
            if any(host not in movable for _, _, host in found):
                all_movable = False
        record["hosts"] = sorted(hosts)
        if missing:
            record["risk"], record["why"] = "会", "app.js 里已找不到这段源码——现在就该红"
        elif all_movable and hosts:
            record["risk"] = "会"
            record["why"] = "app.js 里的出现全在待搬（T + death）函数内"
        else:
            record["risk"], record["why"] = "不会", "app.js 里另有非待搬宿主"
        out.append(record)
    return out


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="体检 test_ui_assets.py 里的源码字面量断言（只读）")
    parser.add_argument("--list", action="store_true", help="逐条列出（行号 · 原文 · 目标变量 · 风险）")
    parser.add_argument("--json", action="store_true", help="机读输出")
    parser.add_argument("--min-death", type=float, default=0.0, help="只看死期 ≥ N 的待搬键（默认全部）")
    parser.add_argument("--truncate", type=int, default=64, help="--list 时原文截断长度（默认 64）")
    args = parser.parse_args(argv)

    sources = load_sources()
    rows = collect_asserts()
    judged = judge(rows, sources, movable_keys(args.min_death))

    snippets = len(judged)
    total = len(rows)
    fragile = [row for row in judged if row["risk"] == "会"]

    if args.json:
        print(json.dumps({
            "literal_asserts": total,
            "snippet_asserts": snippets,
            "fragile": fragile,
            "rows": judged,
        }, ensure_ascii=False, indent=1))
        return EXIT_OK

    print(f"文件：{TESTS.relative_to(REPO)}")
    print(f"字面量断言（assert <字面量> in/not in <变量>）：{total}")
    print(f"  源码片段形态：{snippets}（其余 {total - snippets} 条是 CSS / HTML / 纯名字）")
    print(f"  会因搬运假红：{len(fragile)}")
    if args.min_death:
        print(f"  （只看死期 ≥ {args.min_death} 的待搬键）")
    print()

    if not args.list:
        if not fragile:
            print("没有会因搬运假红的源码字面量断言。")
            return EXIT_OK
        print("会因搬运假红的（行号 · 锁的原文 · 命中宿主）：")
        for row in fragile:
            literal = row["snippets"][0].replace("\n", "\\n")
            hosts = ", ".join(f"{h}(死期 {movable_keys(args.min_death)[h]:g})" for h in row["hosts"])
            print(f"  {row['line']:>5} · {literal[:args.truncate]!r} · {hosts}")
        print("\n建议改法：`assert \"function X(\" in script` → `assert _function_body_any(\"X\")`")
        print("（或 `in _script_with_view()`）；行为那一栏不变，它本来只验「函数存在」。")
        return EXIT_OK

    current_test = None
    for row in judged:
        if row["test"] != current_test:
            print(f"\n# {row['test']} —— {row['doc']}")
            current_test = row["test"]
        literals = " / ".join(repr(lit.replace("\n", "\\n"))[:args.truncate] for lit in row["snippets"][:3])
        print(f"  {row['line']:>5} · {literals} · in {row['target']} · {row['risk']}（{row['why']}）")
    return EXIT_OK


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 —— 与 accept_pages.py 同一约定：内部异常单独一个码
        print(f"INTERNAL ERROR: {exc}", file=sys.stderr)
        raise SystemExit(EXIT_INTERNAL)
