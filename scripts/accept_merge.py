#!/usr/bin/env python3
"""scripts/accept_merge.py —— `merge` 切片落盘后的验收（机械部分）。

模板来自 `scripts/accept_library.py`；**可变部分全部按 merge 自己的实测重写**，没有照抄 library 的数字。

读数口径（2026-10-29 在 HEAD 实测，命令见文末）：
- `view-merge` 子树 id **19 个**（含 section 根 `view-merge`；app.js 只引用其中 **18 个**）；
- app.js 对这些 id 的字面量 **32 处 / 18 个 id → 0**（Chief 的口径是"18 个 id 归零"，这里两数都报）；
- 围栏函数 **9 个 / 361 行**（= 引用 view-merge id 的顶层函数去掉 `setupCollabControls`；
  后者同时接 assign-*/package 控件、被 `setupLibrary()` 调用，是共享接线，不属于 merge）；
- 导出面恰好 `init` / `enter` **2 个**（D-100：merge 没有域操作需求，不加第 3 个）；
- app.js 行数基线 **15,870**；净减门槛**由切片文档定、不在这里发明**，用 `--min-shrink N` 传
  （不传就 exit 2：没定门槛就验收，等于用一个自己编的数当判据）。

退出码三态（与 library 一致，这条是它作为"验收闸"的全部意义）：
- **2** = 前置不满足（模块还没落盘 / index.html 没有 view-merge / 门槛没定）——不是失败；
- **1** = 落盘了但验收不过（逐条列红）；
- **0** = 全过。

只读：不写任何文件；cwd 无关（按脚本自身位置定位仓库）。
"""
from __future__ import annotations

import argparse
import importlib.util
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parent
STATIC = REPO / "backend/book2text/static"
APP = STATIC / "app.js"
MODULE = STATIC / "merge-view.js"
INDEX = STATIC / "index.html"
RULES = REPO / "docs/refactor/evidence/merge/rules.py"

# 搬前读数（2026-10-29 HEAD cd0a508 实测）
BASELINE_APP_LINES = 15870
BASELINE_IDS_REFERENCED = 18
BASELINE_LITERALS = 32
BASELINE_FENCE_LINES = 361

# 围栏函数（9 个，合计 361 行）。派生方式：引用 view-merge id 的顶层函数，
# 去掉 setupCollabControls（它同时接 assign-*/package 控件，被 setupLibrary() 调，是共享接线）。
BUILTIN_MOVERS = [
    "renderMergeView",
    "loadMergePageImage",
    "renderMergeListView",
    "showMergePage",
    "drawMergeOverlay",
    "submitMergeDecisions",
    "renderMergeFooter",
    "openMergeView",
    "mergeVisiblePages",
]

EXPECTED_EXPORTS = {"init", "enter"}

EXIT_PREREQ = 2
EXIT_FAIL = 1
EXIT_OK = 0


def prereq(message: str) -> None:
    print(f"[2] 前置不满足：{message}")
    print("    这不是失败，是还没到可以验收的时候。")
    sys.exit(EXIT_PREREQ)


def section_ids(html: str, view: str) -> set[str]:
    """按标签深度取 `<section id="view-X">` 子树里的 id（视图里有嵌套 section，别见第一个 </section> 就停）。"""
    open_tag = re.compile(rf'<section\b[^>]*\bid="{re.escape(view)}"[^>]*>', re.I)
    match = open_tag.search(html)
    if not match:
        return set()
    depth = 1
    cursor = match.end()
    for tag in re.finditer(r"<(/?)section\b", html[cursor:], re.I):
        depth += -1 if tag.group(1) else 1
        if depth == 0:
            subtree = html[match.start():cursor + tag.end()]
            return set(re.findall(r'\bid="([^"]+)"', subtree))
    return set(re.findall(r'\bid="([^"]+)"', html[match.start():]))


def id_literals(source: str, ids: set[str]) -> dict[str, int]:
    """统计 app.js 里**任何引号字面量**等于这些 id 的次数（按 id）。

    比 library 那版（只认 `el()` / `getElementById()` / `querySelector()`）更严：id 也可能被
    传给别的小工具函数，只认三种调用形态会让那种残留静默通过。误匹配风险：字符串里恰好是
    这个 id（当前没有这种数据），比漏检可接受。
    """
    counts: dict[str, int] = {}
    for element_id in ids:
        quoted = re.escape(element_id)
        hits = len(re.findall(rf'["\']{quoted}["\']', source))
        if hits:
            counts[element_id] = hits
    return counts


def load_movers() -> tuple[list[str], str]:
    """优先读生成器的 MOVERS（落盘时它是权威）；没有就用内置 9 个。"""
    if not RULES.is_file():
        return list(BUILTIN_MOVERS), "内置（evidence/merge/rules.py 还不存在）"
    spec = importlib.util.spec_from_file_location("b2t_merge_rules", RULES)
    if spec is None or spec.loader is None:
        prereq(f"{RULES.relative_to(REPO)} 加载不了")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as error:  # noqa: BLE001 - 读不出来是前置不满足，不是验收失败
        prereq(f"{RULES.relative_to(REPO)} 执行失败：{error}")
    movers = list(getattr(module, "MOVERS", []))
    if not movers:
        prereq(f"{RULES.relative_to(REPO)} 里没有 MOVERS 列表")
    names = [name if isinstance(name, str) else name[0] for name in movers]
    source = f"{RULES.relative_to(REPO)}（{len(names)} 个）"
    if sorted(names) != sorted(BUILTIN_MOVERS):
        print(f"   ⚠ 生成器的 MOVERS 与内置 9 个不一致：{sorted(set(names) ^ set(BUILTIN_MOVERS))}"
              "——以生成器为准，但要确认围栏是不是变了")
    return names, source


def module_exports(source: str) -> set[str] | None:
    """取 `window.MergeView = { … }` 的 key 集合。"""
    match = re.search(r"window\.MergeView\s*=\s*\{(.*?)\n\s*\};", source, re.S)
    if not match:
        return None
    block = match.group(1)
    return set(re.findall(r"^\s*([A-Za-z_$][\w$]*)\s*[:,]", block, re.M))


def count_definitions(source: str, name: str) -> int:
    """`function NAME(` 或 `const NAME = (` 各算一处。"""
    patterns = [
        rf"^\s*(?:async\s+)?function\s+{re.escape(name)}\s*\(",
        rf"^\s*(?:const|let|var)\s+{re.escape(name)}\s*=",
    ]
    return sum(len(re.findall(pattern, source, re.M)) for pattern in patterns)


def main() -> int:
    parser = argparse.ArgumentParser(description="merge 切片落盘验收（机械部分）")
    parser.add_argument("--min-shrink", type=int, default=None,
                        help="app.js 净减门槛（行）；不传 = 前置不满足（门槛由切片文档定）")
    args = parser.parse_args()

    for path, label in ((APP, "app.js"), (INDEX, "index.html")):
        if not path.is_file():
            prereq(f"找不到 {label}：{path}")

    ids = section_ids(INDEX.read_text(encoding="utf-8"), "view-merge")
    if not ids:
        prereq('index.html 里没有 <section id="view-merge"> 子树——视图还没建，无法验收')

    movers, movers_source = load_movers()

    if not MODULE.is_file():
        # 当前状态就该走这里：还没落盘。把"要归零的数"打出来，省得下次重新量。
        app_source = APP.read_text(encoding="utf-8")
        literals = id_literals(app_source, ids)
        total = sum(literals.values())
        print(f"  view-merge 子树 id：{len(ids)} 个（含 section 根）")
        print(f"  app.js 仍引用：{len(literals)} 个 id / {total} 处"
              f"（验收口径 {BASELINE_IDS_REFERENCED} 个 id / {BASELINE_LITERALS} 处 → 0）")
        app_lines = len(app_source.splitlines())
        print(f"  app.js：{app_lines:,} 行（基线 {BASELINE_APP_LINES:,}）")
        print(f"  围栏函数：{len(movers)} 个 / 基线 {BASELINE_FENCE_LINES} 行（来源：{movers_source}）")
        if args.min_shrink is None:
            prereq("净减门槛没定（--min-shrink N）：门槛按围栏真归属算，由切片文档给，脚本不发明")
        prereq("merge-view.js 还没落盘")

    if args.min_shrink is None:
        prereq("净减门槛没定（--min-shrink N）：门槛按围栏真归属算，由切片文档给，脚本不发明")

    app_source = APP.read_text(encoding="utf-8")
    module_source = MODULE.read_text(encoding="utf-8")
    problems: list[str] = []

    # ① DOM 字面量：18 个 id / 32 处 → 0
    literals = id_literals(app_source, ids)
    total = sum(literals.values())
    print(f"① DOM 字面量：{len(literals)} 个 id / {total} 处"
          f"（基线 {BASELINE_IDS_REFERENCED} 个 / {BASELINE_LITERALS} 处，目标 0）")
    for element_id, hits in sorted(literals.items()):
        problems.append(f"app.js 仍引用 view-merge 的 id {element_id}（{hits} 处）")

    # ② app.js 行数：净减门槛由 --min-shrink 给（不在此发明数字）
    app_lines = len(app_source.splitlines())
    shrink = BASELINE_APP_LINES - app_lines
    print(f"② app.js：{app_lines:,} 行（基线 {BASELINE_APP_LINES:,}；已减 {shrink}，门槛 {args.min_shrink}）")
    if shrink < args.min_shrink:
        problems.append(f"app.js 只减了 {shrink} 行（< {args.min_shrink}）：这是「复制」不是「搬」，停")

    # ③ 导出面恰好 2 个（init / enter）
    exports = module_exports(module_source)
    print(f"③ 导出面：{len(exports) if exports is not None else '?'} 个"
          f"{'（' + ' / '.join(sorted(exports)) + '）' if exports else ''}")
    if exports is None:
        problems.append("merge-view.js 里找不到 window.MergeView = { … } 接口对象")
    elif exports != EXPECTED_EXPORTS:
        missing = EXPECTED_EXPORTS - exports
        extra = exports - EXPECTED_EXPORTS
        if missing:
            problems.append(f"导出面少了 {'、'.join(sorted(missing))}")
        if extra:
            problems.append(f"导出面多了 {'、'.join(sorted(extra))}（D-100：merge 没有域操作需求，不加第 3 个）")

    # ④ 围栏 9 个函数：app.js 0 / 模块 1
    moved = [name for name in movers if count_definitions(module_source, name) == 1]
    leftover = [name for name in movers if count_definitions(app_source, name) > 0]
    print(f"④ 搬走函数：{len(moved)}/{len(movers)} 在模块里恰好 1 处；app.js 残留 {len(leftover)} 个")
    for name in leftover:
        problems.append(f"函数 {name} 还在 app.js 里（应已搬走）")
    for name in movers:
        if name not in moved:
            problems.append(f"函数 {name} 在 merge-view.js 里不是恰好 1 处定义")

    # ⑤ 页面接线（library 刀漏过这一步：标签漏了，所有静态门全绿而目录页永远空着）
    html = INDEX.read_text(encoding="utf-8")
    has_tag = "/static/merge-view.js" in html
    print(f"⑤ script 标签：{'有' if has_tag else '没有'}（/static/merge-view.js）")
    if not has_tag:
        problems.append("index.html 里没有 merge-view.js 的 <script>：window.MergeView 是 undefined，页面会静默空白")

    if problems:
        print(f"\n[1] 验收不过，{len(problems)} 条：")
        for item in problems:
            print(f"    ✗ {item}")
        return EXIT_FAIL

    print("\n[0] 全过：DOM 字面量 0 / 行数达标 / 导出 2 个 / 围栏函数各 1 处 / script 标签在")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
