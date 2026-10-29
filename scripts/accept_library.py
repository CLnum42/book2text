#!/usr/bin/env python3
"""scripts/accept_library.py —— `library` 切片落盘后的验收（机械部分）。

口径来源：`docs/refactor/evidence/library/DRYRUN.md`（搬前读数，每个数带出处）。**这里不重新发明数字**：
- `view-library` 子树 id 集合从 `index.html` 现场抽（9 个）；
- `app.js` 对这些 id 的字面量 **24 处 → 0**（R3 判据）；
- 其中 `library-error` / `library-warning` 的写点 **19 处 → 0**（13 + 6，必须改调 `notify`）；
- `app.js` 行数 16,161 → ≈15,796（±20）；**减 < 300 判"复制不是搬"**；
- 导出面恰好 `init` / `enter` / `notify` 三个；
- 17 个搬走函数：`app.js` 里 0 处、`library-view.js` 里 1 处。

退出码三态（这条是它作为"验收闸"的全部意义）：
- **2** = 前置不满足（还没落盘 / `rules.py` 读不出来 / `index.html` 里没有 `view-library`）——
  当前状态就是 2，**不是失败，是"还没到可以验收的时候"**；
- **1** = 落盘了但验收不过（逐条列红）；
- **0** = 全过。

只读：不写任何文件；cwd 无关（按脚本自身位置定位仓库）。
"""
from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parent
STATIC = REPO / "backend/book2text/static"
APP = STATIC / "app.js"
MODULE = STATIC / "library-view.js"
INDEX = STATIC / "index.html"
RULES = REPO / "docs/refactor/evidence/library/rules.py"
DRYRUN = REPO / "docs/refactor/evidence/library/DRYRUN.md"

# 搬前读数（出处：DRYRUN.md §2/§3）。**只作为"对账值"**：数变了先看是不是又漂了。
BASELINE_APP_LINES = 16161
TARGET_APP_LINES = 15796
TARGET_TOLERANCE = 20
MIN_SHRINK = 300
BASELINE_LITERALS = 24
BASELINE_WRITE_POINTS = 19
WRITE_POINT_IDS = ("library-error", "library-warning")
EXPECTED_EXPORTS = {"init", "enter", "notify"}

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
    """统计 `el("x")` / `getElementById("x")` / `querySelector("#x")` 里出现的次数（按 id）。"""
    counts: dict[str, int] = {}
    for element_id in ids:
        quoted = re.escape(element_id)
        pattern = re.compile(
            rf'(?:\bel\(\s*["\']{quoted}["\']\s*\)'
            rf'|getElementById\(\s*["\']{quoted}["\']\s*\)'
            rf'|querySelector(?:All)?\(\s*["\']#{quoted}["\'])'
        )
        hits = len(pattern.findall(source))
        if hits:
            counts[element_id] = hits
    return counts


def load_movers() -> list[str]:
    if not RULES.is_file():
        prereq(f"找不到搬运规则 {RULES.relative_to(REPO)}（57 条映射 / 17 个函数在里面）")
    spec = importlib.util.spec_from_file_location("b2t_library_rules", RULES)
    if spec is None or spec.loader is None:
        prereq(f"{RULES.relative_to(REPO)} 加载不了")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as error:  # noqa: BLE001 - 读不出来就是前置不满足，不是验收失败
        prereq(f"{RULES.relative_to(REPO)} 执行失败：{error}")
    movers = list(getattr(module, "MOVERS", []))
    if not movers:
        prereq(f"{RULES.relative_to(REPO)} 里没有 MOVERS 列表")
    return [name if isinstance(name, str) else name[0] for name in movers]


def module_exports(source: str) -> set[str] | None:
    """取 `window.LibraryView = { … }` 的 key 集合。"""
    match = re.search(r"window\.LibraryView\s*=\s*\{(.*?)\n\s*\};", source, re.S)
    if not match:
        return None
    block = match.group(1)
    keys = set(re.findall(r"^\s*([A-Za-z_$][\w$]*)\s*[:,]", block, re.M))
    return keys


def count_definitions(source: str, name: str) -> int:
    """`function NAME(` 或 `const NAME = (` 各算一处。"""
    patterns = [
        rf"^\s*(?:async\s+)?function\s+{re.escape(name)}\s*\(",
        rf"^\s*(?:const|let|var)\s+{re.escape(name)}\s*=",
    ]
    return sum(len(re.findall(pattern, source, re.M)) for pattern in patterns)


def main() -> int:
    for path, label in ((APP, "app.js"), (INDEX, "index.html"), (DRYRUN, "DRYRUN.md")):
        if not path.is_file():
            prereq(f"找不到 {label}：{path}")

    ids = section_ids(INDEX.read_text(encoding="utf-8"), "view-library")
    if not ids:
        prereq('index.html 里没有 <section id="view-library"> 子树——视图还没建，无法验收')

    movers = load_movers()

    if not MODULE.is_file():
        # 当前状态就该走这里：还没落盘。把"要归零的数"打出来，省得下次重新量。
        app_source = APP.read_text(encoding="utf-8")
        literals = id_literals(app_source, ids)
        total = sum(literals.values())
        writes = sum(literals.get(item, 0) for item in WRITE_POINT_IDS)
        print(f"  view-library 子树 id：{len(ids)} 个")
        print(f"  app.js 仍引用：{len(literals)} 个 id / {total} 处（验收口径 {BASELINE_LITERALS} → 0）")
        print(f"  其中写点（{' / '.join(WRITE_POINT_IDS)}）：{writes} 处（验收口径 {BASELINE_WRITE_POINTS} → 0）")
        print(f"  待搬函数：{len(movers)} 个；library-view.js 不存在")
        prereq("library-view.js 还没落盘")

    app_source = APP.read_text(encoding="utf-8")
    module_source = MODULE.read_text(encoding="utf-8")
    problems: list[str] = []

    # ① DOM 字面量 24 → 0，写点 19 → 0（两个数都报：写点是字面量的子集，拆开才知道断在哪一层）
    literals = id_literals(app_source, ids)
    total = sum(literals.values())
    writes = sum(literals.get(item, 0) for item in WRITE_POINT_IDS)
    print(f"① DOM 字面量：{total} 处（基线 {BASELINE_LITERALS}，目标 0）；"
          f"其中写点 {writes} 处（基线 {BASELINE_WRITE_POINTS}，目标 0）")
    for element_id, hits in sorted(literals.items()):
        problems.append(f"app.js 仍引用 view-library 的 id {element_id}（{hits} 处）")
    if total > BASELINE_LITERALS:
        print(f"   ⚠ 比搬前读数多 {total - BASELINE_LITERALS} 处——先查是不是新加了 library 的 DOM 写点")

    # ② app.js 行数：减 < 300 = "复制不是搬"
    app_lines = len(app_source.splitlines())
    shrink = BASELINE_APP_LINES - app_lines
    print(f"② app.js：{app_lines:,} 行（基线 {BASELINE_APP_LINES:,}，目标 ≈{TARGET_APP_LINES:,}±{TARGET_TOLERANCE}；"
          f"已减 {shrink}）")
    if shrink < MIN_SHRINK:
        problems.append(f"app.js 只减了 {shrink} 行（< {MIN_SHRINK}）：这是「复制」不是「搬」，停")
    if abs(app_lines - TARGET_APP_LINES) > TARGET_TOLERANCE:
        print(f"   ⚠ 与目标差 {app_lines - TARGET_APP_LINES:+d} 行（容差 ±{TARGET_TOLERANCE}）——对账，不自动判红")

    # ③ 导出面恰好 3 个
    exports = module_exports(module_source)
    print(f"③ 导出面：{len(exports) if exports is not None else '?'} 个"
          f"{'（' + ' / '.join(sorted(exports)) + '）' if exports else ''}")
    if exports is None:
        problems.append("library-view.js 里找不到 window.LibraryView = { … } 接口对象")
    elif exports != EXPECTED_EXPORTS:
        missing = EXPECTED_EXPORTS - exports
        extra = exports - EXPECTED_EXPORTS
        if missing:
            problems.append(f"导出面少了 {'、'.join(sorted(missing))}")
        if extra:
            problems.append(f"导出面多了 {'、'.join(sorted(extra))}（R8 按模块建：改大要签字）")

    # ④ 17 个函数：app.js 0 / 模块 1
    moved = [name for name in movers if count_definitions(module_source, name) == 1]
    leftover = [name for name in movers if count_definitions(app_source, name) > 0]
    print(f"④ 搬走函数：{len(moved)}/{len(movers)} 在模块里恰好 1 处；app.js 残留 {len(leftover)} 个")
    for name in leftover:
        problems.append(f"函数 {name} 还在 app.js 里（应已搬走）")
    for name in movers:
        if name not in moved:
            problems.append(f"函数 {name} 在 library-view.js 里不是恰好 1 处定义")

    print("---")
    if problems:
        print(f"[1] 验收失败：{len(problems)} 条")
        for item in problems:
            print(f"    ✗ {item}")
        return EXIT_FAIL
    print("[0] 验收通过：字面量 0 / 写点 0 / 导出 3 / 17 个函数各 1 处")
    return EXIT_OK


if __name__ == "__main__":
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        sys.exit(EXIT_OK)
    sys.exit(main())
