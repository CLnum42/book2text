#!/usr/bin/env python3
"""scripts/accept_review.py —— `review` 第二刀落盘后的验收（机械部分）。

口径来源（**脚本不发明数字**）：
- `docs/refactor/review-slice.md`（两刀边界、减量门槛 2,400）
- `docs/refactor/review-attribution.md`（14 逐字节归属：94 含根 / 93 不含根、17 个外部流程 420 行）
- `docs/refactor/accept-template.md`（三态退出码、id 按标签深度、字面量→0、减量硬判据、导出面精确相等）

`review` 与 library 的形态不同，多一条**边界断言**：
- **17 个外部流程函数必须「外壳有、模块没有」**（app.js 恰 1 处 `function` 声明、模块 0 处）——
  这刀的核心边界就是它们**没被搬进去**；只数字面量会把"边界失守"漏掉：
  它们一旦被拖进 `review-view.js`，字面量照样归零、行数照样减，但接缝全乱了。

导出面**不由本脚本决定**：`review` 的出口数等 DevLead 给（`init`/`enter`/`notify` + 可能的域操作），
所以写成参数 `--exports init,enter,notify`；不给就是"还没定"，模块落盘后按前置不满足处理（exit 2），
**不抄 library 的 3 个**。

退出码三态：`2` 前置不满足（还没落盘 / 名单或导出面还没给）/ `1` 验收不过 / `0` 全过。
只读、cwd 无关（按脚本自身位置定位仓库）。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parent
STATIC = REPO / "backend/book2text/static"
APP = STATIC / "app.js"
MODULE = STATIC / "review-view.js"
INDEX = STATIC / "index.html"
ATTRIBUTION = REPO / "docs/refactor/review-attribution.md"
SLICE = REPO / "docs/refactor/review-slice.md"
MOVERS_TXT = REPO / "docs/refactor/evidence/review/movers.txt"
MOVERS_JSON = REPO / "docs/refactor/evidence/review/movers.json"

# ── 可变配置（每刀填这几项；判据部分不改） ────────────────────────────────
VIEW = "review"
# 搬前读数（review-attribution.md §1 / review-slice.md §4）。**只作对账**，不是判据本身。
BASELINE_IDS_NO_ROOT = 93          # 不含视图根（口径：根是容器，不是内容节点）
BASELINE_IDS_WITH_ROOT = 94        # 含视图根——引用这个数时必须写明含不含根
BASELINE_REFS = 89                 # app.js 引用到的 id 数（不含根集合）
BASELINE_LITERALS = 218            # app.js 里这些 id 的字面量总处数（不含根集合）
BASELINE_MOVERS = 106              # 能搬 113 − 树 7（review-slice.md §1）
BASELINE_APP_LINES = 15311         # 本刀开工时的 app.js 行数（`sh scripts/status.sh --no-fetch` 读）
MIN_SHRINK = 2400                  # review-slice.md §4：≥2,400；>2,650 说明顺手删了别的
MAX_SHRINK = 2650

# 17 个外部流程（review-attribution.md §1「不属于 review」，420 行）。
# 首选从 `review-slice.md` §1 的名单块解析（改名单只改文档一处）；
# 解析不出 17 个才退回这份内置清单，并打印警告——**不静默用旧的**。
EXTERNAL_FLOW_FALLBACK = [
    "finishRunAutoPass", "finishRunLayout", "revertContinuation", "markContinuation",
    "onContinuationKeydown", "loadContinuationReview", "finishRevokeAutoPass", "undoLastCleanup",
    "loadLanguageSummary", "afterCleanupApplied", "advanceContinuation", "openFinishPanel",
    "pausePageThumbnails", "afterContinuationChange", "continuationRemaining", "closeFinishPanel",
    "renderContinuationPanel",
]

EXIT_PREREQ, EXIT_FAIL, EXIT_OK = 2, 1, 0


def prereq(message: str) -> None:
    print(f"[2] 前置不满足：{message}")
    print("    这不是失败，是还没到可以验收的时候。")
    sys.exit(EXIT_PREREQ)


def section_ids(html: str, view: str) -> set[str]:
    """按标签深度取 `<section id="view-X">` 子树里的 id（视图里有嵌套 section）。"""
    match = re.search(rf'<section\b[^>]*\bid="{re.escape(view)}"[^>]*>', html, re.I)
    if not match:
        return set()
    depth = 1
    cursor = match.end()
    for tag in re.finditer(r"<(/?)section\b", html[cursor:], re.I):
        depth += -1 if tag.group(1) else 1
        if depth == 0:
            return set(re.findall(r'\bid="([^"]+)"', html[match.start():cursor + tag.end()]))
    return set(re.findall(r'\bid="([^"]+)"', html[match.start():]))


def id_literals(source: str, ids: set[str]) -> dict[str, int]:
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


def count_definitions(source: str, name: str) -> int:
    patterns = [
        rf"^\s*(?:async\s+)?function\s+{re.escape(name)}\s*\(",
        rf"^\s*(?:const|let|var)\s+{re.escape(name)}\s*=",
    ]
    return sum(len(re.findall(pattern, source, re.M)) for pattern in patterns)


def module_exports(source: str) -> set[str] | None:
    match = re.search(r"window\.ReviewView\s*=\s*\{(.*?)\n\s*\};", source, re.S)
    if not match:
        return None
    return set(re.findall(r"^\s*([A-Za-z_$][\w$]*)\s*[:,]", match.group(1), re.M))


def load_movers() -> tuple[list[str], str]:
    """名单从**文件**读，脚本里不抄函数名（改名就得改两处）。支持两种可机读格式：
    - `movers.txt`：一行一个名字，`#` 开头是注释；
    - `movers.json`：数组；元素是字符串，或 `{"name": …, "lines": …}` 这类对象。
    """
    if MOVERS_TXT.is_file():
        raw = [line.strip() for line in MOVERS_TXT.read_text(encoding="utf-8").splitlines()]
        names = [line for line in raw if line and not line.startswith("#")]
        return names, str(MOVERS_TXT.relative_to(REPO))
    if MOVERS_JSON.is_file():
        data = json.loads(MOVERS_JSON.read_text(encoding="utf-8"))
        names = [item if isinstance(item, str) else item.get("name") for item in data]
        return [name for name in names if name], str(MOVERS_JSON.relative_to(REPO))
    prereq(
        "待搬函数名单没有：docs/refactor/evidence/review/movers.txt（或 movers.json）"
        "——从 review-attribution.md 的四栏表生成，脚本里不抄 106 个名字",
    )


def load_external_flow() -> list[str]:
    """从 `review-slice.md` §1 的名单块解析 17 个外部流程（`name(行数)` 形态）。"""
    try:
        text = SLICE.read_text(encoding="utf-8")
    except OSError:
        text = ""
    # 跳过开栅栏本身（``` 之后到配对闭栅栏之间才是名单）
    block = re.search(r"### 第一刀[\s\S]*?```[^\n]*\n([\s\S]*?)```", text)
    names = re.findall(r"\b([A-Za-z_$][\w$]*)\((\d+)\)", block.group(1) if block else "")
    found = [name for name, _ in names]
    if len(found) == 17:
        return found
    print(f"   ⚠ review-slice.md §1 里没解析出 17 个外部流程（得到 {len(found)} 个）——"
          f"退回内置清单（与 review-attribution.md §1 一致）")
    return list(EXTERNAL_FLOW_FALLBACK)


def parse_exports(argv: list[str]) -> set[str] | None:
    for index, arg in enumerate(argv):
        if arg == "--exports" and index + 1 < len(argv):
            return {item.strip() for item in argv[index + 1].split(",") if item.strip()}
        if arg.startswith("--exports="):
            return {item.strip() for item in arg.split("=", 1)[1].split(",") if item.strip()}
    return None


def main(argv: list[str]) -> int:
    for path, label in ((APP, "app.js"), (INDEX, "index.html"), (ATTRIBUTION, "review-attribution.md"),
                        (SLICE, "review-slice.md")):
        if not path.is_file():
            prereq(f"找不到 {label}：{path}")

    all_ids = section_ids(INDEX.read_text(encoding="utf-8"), f"view-{VIEW}")
    if not all_ids:
        prereq(f'index.html 里没有 <section id="view-{VIEW}"> 子树——视图还没建，无法验收')
    ids = all_ids - {f"view-{VIEW}"}          # 口径：不含视图根
    if len(ids) != BASELINE_IDS_NO_ROOT:
        print(f"⚠ view-{VIEW} 子树 id：不含根 {len(ids)} 个 / 含根 {len(all_ids)} 个"
              f"（基线 {BASELINE_IDS_NO_ROOT} / {BASELINE_IDS_WITH_ROOT}）——数变了先对账")

    app_source = APP.read_text(encoding="utf-8")
    literals = id_literals(app_source, ids)
    refs = len(literals)
    total = sum(literals.values())

    if not MODULE.is_file():
        # 当前状态：还没落盘。把要归零的数打出来（省得下次重新量），然后 exit 2。
        print(f"  view-{VIEW} 子树 id：不含根 {len(ids)} 个（含根 {len(all_ids)}）")
        print(f"  app.js 仍引用：{refs} 个 id / {total} 处（基线 {BASELINE_REFS} 个 / {BASELINE_LITERALS} 处，目标 0）")
        print(f"  待搬函数：{BASELINE_MOVERS} 个（能搬 113 − 树 7）；{len(load_external_flow())} 个外部流程留在外壳")
        print(f"  {MODULE.name}：不存在")
        prereq(f"{MODULE.name} 还没落盘")

    module_source = MODULE.read_text(encoding="utf-8")
    problems: list[str] = []

    # ① 字面量 → 0（逐 id 点名，别只说"还有残留"）
    print(f"① DOM 字面量：{total} 处（基线 {BASELINE_LITERALS}，目标 0）")
    for element_id, hits in sorted(literals.items()):
        problems.append(f"app.js 仍引用 view-{VIEW} 的 id {element_id}（{hits} 处）")

    # ② 减量：≥2,400（<2,400 = 复制不是搬；>2,650 = 顺手删了别的）
    app_lines = len(app_source.splitlines())
    shrink = BASELINE_APP_LINES - app_lines
    print(f"② app.js：{app_lines:,} 行（基线 {BASELINE_APP_LINES:,}，已减 {shrink}；门槛 {MIN_SHRINK}..{MAX_SHRINK}）")
    if shrink < MIN_SHRINK:
        problems.append(f"app.js 只减了 {shrink} 行（< {MIN_SHRINK}）：这是「复制」不是「搬」，停")
    if shrink > MAX_SHRINK:
        problems.append(f"app.js 减了 {shrink} 行（> {MAX_SHRINK}）：顺手删了别的，回退")

    # ③ 导出面：等 DevLead 给，参数传；不给就是还没定（exit 2，不猜）
    expected = parse_exports(argv)
    actual = module_exports(module_source)
    if expected is None:
        prereq("导出面还没定：用 `--exports init,enter,notify,…` 传入（review 的出口数等 DevLead 给，别抄 library）")
    print(f"③ 导出面：{len(actual) if actual is not None else '?'} 个"
          f"{'（' + ' / '.join(sorted(actual)) + '）' if actual else ''}；期望 {len(expected)} 个"
          f"（{' / '.join(sorted(expected))}）")
    if actual is None:
        problems.append(f"{MODULE.name} 里找不到 window.ReviewView = {{ … }} 接口对象")
    elif actual != expected:
        missing = expected - actual
        extra = actual - expected
        if missing:
            problems.append(f"导出面少了 {'、'.join(sorted(missing))}")
        if extra:
            problems.append(f"导出面多了 {'、'.join(sorted(extra))}（R8 按模块建：改大要签字）")

    # ④ 17 个外部流程必须「外壳有、模块没有」——这刀的核心边界
    external_flow = load_external_flow()
    wrong = []
    for name in external_flow:
        in_app = count_definitions(app_source, name)
        in_module = count_definitions(module_source, name)
        if in_app != 1 or in_module != 0:
            wrong.append(f"{name}：app.js {in_app} 处、模块 {in_module} 处（应 1 / 0）")
    print(f"④ 外部流程：{len(external_flow) - len(wrong)}/{len(external_flow)} 个仍「外壳 1 / 模块 0」")
    problems.extend(f"边界失守——{item}" for item in wrong)

    # ⑤ 106 个待搬函数：app.js 0 / 模块 1
    movers, movers_src = load_movers()
    print(f"   名单来源：{movers_src}（{len(movers)} 个）")
    if len(movers) != BASELINE_MOVERS:
        print(f"   ⚠ 名单 {len(movers)} 个（基线 {BASELINE_MOVERS}）——先对账")
    leftover = [name for name in movers if count_definitions(app_source, name) > 0]
    not_in_module = [name for name in movers if count_definitions(module_source, name) != 1]
    print(f"⑤ 待搬函数：{len(movers) - len(leftover)}/{len(movers)} 已离开 app.js；"
          f"{len(movers) - len(not_in_module)}/{len(movers)} 在模块里恰好 1 处")
    problems.extend(f"函数 {name} 还在 app.js 里（应已搬走）" for name in leftover)
    problems.extend(f"函数 {name} 在 {MODULE.name} 里不是恰好 1 处定义" for name in not_in_module)

    print("---")
    if problems:
        print(f"[1] 验收失败：{len(problems)} 条")
        for item in problems:
            print(f"    ✗ {item}")
        return EXIT_FAIL
    print("[0] 验收通过：字面量 0 / 减量合规 / 导出面精确相等 / 17 个外部流程未越界 / 106 个函数各 1 处")
    return EXIT_OK


if __name__ == "__main__":
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        sys.exit(EXIT_OK)
    sys.exit(main(sys.argv[1:]))
