"""生成 `review` 搬迁名单（movers.json / movers.txt）——**脚本生成，不手抄**。

算法（Chief 2026-10-29 定，别换方法）：

    C = 种子（函数体里出现 view-review 子树 id 字符串）的引用图闭包
        引用图 = f 出现在**非定义位置**就算一条边，后面跟不跟 `(` 都算（值引用也算）。
        壳根 boot / setupShell / setupLibrary 剔除，且只从「可能搬」的节点继续扩：
        引用别视图 id 的函数、流程函数（openPageDetail 等）是叶子，不再顺着它们扩
        （否则闭包会变成全站地图——pages 调查里 v1/v2 差 62 个百分点就是栽在这）。

    movers   = f ∈ C 且 ① 引用了 view-review 的 id（或其子集）或 ② 只被 C 内函数引用
    stays    = f ∈ C 但引用了别的视图的 id / 被外壳（壳根或 C 外函数）直接调用 / 流程推进
    external = 已知 17 个外部流程（续页 / 收尾 / 自动通过 / 清理撤销）

约束：movers ∪ stays ∪ external = C，三者两两不相交；行数逐栏相加 = C 的行数。

输出：
- `movers.json`：三区 + 口径头 + 对账字段（每个元素带 name / lines / lineCount / why）
- `movers.txt`：只列 movers 名字（一行一个，给 `scripts/accept_review.py` 读）

用法：`python3 docs/refactor/evidence/review/build_movers.py`
只读 app.js / index.html，写本目录两个文件；自检不过则 exit 1。
"""
from __future__ import annotations

import collections
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
APP = REPO / "backend" / "book2text" / "static" / "app.js"
INDEX = REPO / "backend" / "book2text" / "static" / "index.html"
OUT_JSON = HERE / "movers.json"
OUT_TXT = HERE / "movers.txt"

VIEW = "review"
SHELL_ROOTS = {"boot", "setupShell", "setupLibrary"}

# 已知的 17 个外部流程（review-attribution.md §1；按函数名，不按行号）。
EXTERNAL = {
    "finishRunAutoPass": "收尾面板：自动通过整本",
    "finishRunLayout": "收尾面板：整本版面检测",
    "revertContinuation": "续页确认：回退",
    "markContinuation": "续页确认：标记",
    "onContinuationKeydown": "续页确认：键盘",
    "loadContinuationReview": "续页确认：加载",
    "finishRevokeAutoPass": "自动通过：撤销",
    "undoLastCleanup": "清理撤销",
    "loadLanguageSummary": "收尾面板：语言统计",
    "afterCleanupApplied": "清理流程：应用后",
    "advanceContinuation": "续页确认：前进",
    "openFinishPanel": "收尾面板：打开",
    "pausePageThumbnails": "页面缩略图：暂停（被续页流程引用）",
    "afterContinuationChange": "续页确认：变更后",
    "continuationRemaining": "续页确认：剩余计数",
    "closeFinishPanel": "收尾面板：关闭",
    "renderContinuationPanel": "续页确认：渲染",
}

# 机械规则会把它们判成 movers，但代码显示它们是流程推进，不是 review 的渲染件。
FLOW_STAYS = {
    "openPageDetail": '调 showView("review") + savePosition → 外壳路由；模块经注入打开页',
    "openTreeItem": "不渲染任何 DOM；只调 openPageDetail / focusQueueItem / syncReviewTreeToPage → 流程推进",
    "confirmCurrentPage": "确认后调 loadFinishSummary + nextUnfinishedPage + openPageDetail → 推进流程，不是渲染",
}


def function_inventory(source: str):
    """顶层 `function` / `async function`：名字 → {start, end, lines}（1-based，含两端）。

    结束行用「第一个顶格 `}`」——本仓库所有顶层函数都这么收尾（pages / library 调查同款）；
    语法合法性由 `node --check` 另行保证，这里只负责切边界。
    """
    lines = source.split("\n")
    found: dict[str, dict] = {}
    pattern = re.compile(r"^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(", re.M)
    for match in pattern.finditer(source):
        name = match.group(1)
        start = source.count("\n", 0, match.start())
        end = start + 1
        while end < len(lines) and lines[end] != "}":
            end += 1
        record = {"start": start + 1, "end": end + 1, "lines": end - start + 1}
        if name in found:
            raise SystemExit(f"✗ 函数 {name} 有重复顶层声明，名单无法定位")
        found[name] = record
    return found


def section_ids(html: str, view: str) -> set[str]:
    """按 section 深度取 `<section id="view-review">` 子树里的全部 id（含视图根）。"""
    match = re.search(rf'<section\b[^>]*\bid="{re.escape(view)}"[^>]*>', html, re.I)
    if not match:
        raise SystemExit(f'✗ index.html 里没有 <section id="view-{view}">')
    depth, cursor = 1, match.end()
    for tag in re.finditer(r"<(/?)section\b", html[cursor:], re.I):
        depth += -1 if tag.group(1) else 1
        if depth == 0:
            return set(re.findall(r'\bid="([^"]+)"', html[match.start():cursor + tag.end()]))
    raise SystemExit(f'✗ <section id="view-{view}"> 没有闭合')


def touched_ids(body: str) -> set[str]:
    """函数体里出现的 id 字面量：el("x") / getElementById("x") / querySelector("#x")。"""
    found = set(re.findall(r'\bel\(\s*["\']([a-z0-9-]+)["\']', body))
    found |= set(re.findall(r'\bgetElementById\(\s*["\']([a-z0-9-]+)["\']', body))
    found |= set(re.findall(r'\bquerySelector(?:All)?\(\s*["\']#([a-z0-9-]+)["\']', body))
    return found


def build():
    source = APP.read_text(encoding="utf-8")
    lines = source.split("\n")
    fns = function_inventory(source)
    bodies = {name: "\n".join(lines[rec["start"] - 1:rec["end"]]) for name, rec in fns.items()}
    ids_all = section_ids(INDEX.read_text(encoding="utf-8"), f"view-{VIEW}")
    ids = ids_all - {f"view-{VIEW}"}
    touch = {name: touched_ids(body) for name, body in bodies.items()}

    seeds = {
        name for name, hits in touch.items()
        if (hits & ids_all) and name not in SHELL_ROOTS
    }

    # 引用图：函数名出现在非定义位置（定义行本身已从 body 中排除签名前的部分）。
    refpat = {name: re.compile(r"(?<![\w$.])" + re.escape(name) + r"(?![\w$])") for name in fns}
    edges = {
        name: {callee for callee, pat in refpat.items()
               if callee != name and pat.search(body[body.find("{") + 1:])}
        for name, body in bodies.items()
    }
    callers: dict[str, set[str]] = collections.defaultdict(set)
    for name, callees in edges.items():
        for callee in callees:
            callers[callee].add(name)

    def outside(name: str) -> set[str]:
        return touch[name] - ids_all

    # ① 闭包：只顺着「可能搬」的节点扩。三类叶子不扩：引用别视图 id、流程函数、
    #    有壳根/C 外调用者的接缝（接缝在图里，但它的引用不进 C，否则会一路扩成全站地图）。
    closure = set(seeds)
    changed = True
    while changed:
        changed = False
        for name in list(closure):
            if outside(name) or name in FLOW_STAYS:
                continue
            if not callers[name] <= closure or (callers[name] & SHELL_ROOTS):
                continue
            for callee in edges[name]:
                if callee in closure or callee in SHELL_ROOTS:
                    continue
                closure.add(callee)
                changed = True

    # ② 三区：先剔 external，再按「段外 id / 外壳或 C 外调用 / 流程」判 stays。
    movers, stays = [], []
    for name in sorted(closure):
        if name in EXTERNAL:
            continue
        rec = fns[name]
        leak = sorted({c for c in callers[name] if c not in closure or c in SHELL_ROOTS})
        outside_ids = sorted(outside(name))
        if outside_ids:
            why = "引用段外 id：" + "、".join(outside_ids[:6]) + ("…" if len(outside_ids) > 6 else "")
            stays.append({"name": name, **rec, "why": why, "kind": "other-view-dom"})
        elif name in FLOW_STAYS:
            stays.append({"name": name, **rec, "why": FLOW_STAYS[name], "kind": "flow"})
        elif leak:
            why = "被外壳/C 外函数调用：" + "、".join(leak[:6]) + ("…" if len(leak) > 6 else "")
            stays.append({"name": name, **rec, "why": why, "kind": "seam"})
        else:
            if touch[name]:
                why = "引用 view-review 的 id：" + "、".join(sorted(touch[name])[:6])
            else:
                inside = sorted(callers[name])[:4]
                why = "不碰 id；只被 C 内函数引用：" + "、".join(inside) + ("…" if len(callers[name]) > 4 else "")
            movers.append({"name": name, **rec, "why": why})

    external = [{"name": name, "why": why, **fns[name]} for name, why in sorted(EXTERNAL.items())]

    # 树函数逐条结论（判据：渲染的 DOM 属于谁的子树）——写进文件，别只留在回信里。
    TREE_DECISION = {
        "renderReviewTree": ("movers", "渲染 #review-tree-list / #review-tree-stats（review 子树），并绑条目点击"),
        "loadReviewTreeItems": ("movers", "只填 reviewTreeItems（树的数据），不渲染其它视图"),
        "treeItemSummary": ("movers", "只生成树条目摘要文本，纯树展示件"),
        "toggleReviewTreeChapter": ("movers", "改树展开状态并调 renderReviewTree（review DOM）"),
        "toggleReviewTreePage": ("movers", "改树页码展开状态并调 renderReviewTree（review DOM）"),
        "treeLevelLabel": ("movers", "纯标签文本，只服务 review 树"),
        "treeChapterOfPage": ("movers", "只读 reviewTree.pages，纯树数据辅助"),
        "openTreeItem": ("movers", "绑 #review-tree-list 条目点击（模块渲染的 DOM）；openPageDetail / focusQueueItem / syncReviewTreeToPage 走注入"),
    }
    tree = []
    mover_names = {item["name"] for item in movers}
    for name, (zone, why) in TREE_DECISION.items():
        actual = "movers" if name in mover_names else ("external" if name in EXTERNAL else "stays")
        tree.append({"name": name, **fns[name], "判定": zone, "实际落区": actual, "依据": why})

    # 警示：引用了 review id 却落在 stays 的（混入别的视图 id），落盘前必须拆，否则字面量无法归零。
    mixed = []
    for item in stays:
        name = item["name"]
        review_ids = sorted(touch[name] & ids)
        if not review_ids:
            continue
        mixed.append({
            "name": name,
            "lines": item["lines"],
            "start": item["start"],
            "end": item["end"],
            "reviewIds": review_ids,
            "outsideIds": sorted(touch[name] - ids_all),
            "calledByShell": sorted(c for c in callers[name] if c not in mover_names)[:20],
            "why": item["why"],
        })

    # 施工清单：这 40 个是「按纯搬运做不到」的证据，单独导出给 DevLead 拆渲染/流程。
    entangled = {
        "口径": "引用 view-review 的 id、但被外壳/路由/别视图调用的函数；纯搬运无法让 app.js 字面量归零。",
        "count": len(mixed),
        "lines": sum(item["lines"] for item in mixed),
        "entries": mixed,
    }
    (HERE / "entangled.json").write_text(
        json.dumps(entangled, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    # 口径头 + 对账
    closure_names = {item["name"] for item in movers + stays + external}
    closure_lines = sum(item["lines"] for item in movers + stays + external)
    header = {
        "口径": {
            "视图": f"view-{VIEW}",
            "段内 id": f"{len(ids_all)}（含视图根）/ {len(ids)}（不含根）",
            "种子": f"函数体里出现 view-review 子树 id 字符串；壳根 boot/setupShell/setupLibrary 已剔除 → {len(seeds)} 个",
            "闭包": "引用图（f 出现在非定义位置即一条边，值引用也算；只在可能搬的节点上继续扩）",
            "闭包总数": f"{len(closure_names)} 个 / {closure_lines} 行",
            "壳根": "已剔除（boot / setupShell / setupLibrary）",
            "基线": subprocess.check_output(
                ["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"]
            ).decode().strip(),
            "app.js 行数": len(lines) - (1 if lines and lines[-1] == "" else 0),
        },
        "对账": {
            "movers+stays+external = 闭包总数?": len(closure_names) == len(movers) + len(stays) + len(external),
            "行数相加 = 闭包总行数?": closure_lines == sum(item["lines"] for item in movers + stays + external),
            "三区两两不相交?": not (
                {item["name"] for item in movers} & {item["name"] for item in stays}
                or {item["name"] for item in movers} & {item["name"] for item in external}
                or {item["name"] for item in stays} & {item["name"] for item in external}
            ),
            "函数数": {"movers": len(movers), "stays": len(stays), "external": len(external),
                       "闭包": len(closure_names)},
            "行数": {"movers": sum(i["lines"] for i in movers),
                     "stays": sum(i["lines"] for i in stays),
                     "external": sum(i["lines"] for i in external),
                     "闭包": closure_lines},
        },
        "树函数": tree,
        "警示": {
            "引用 review id 却留在外壳的函数": mixed,
            "说明": "这些函数同时引用别视图的 id（或只有外壳调用者）。落盘前要么拆分 DOM 写点，要么作为接缝注入；"
                   "不拆就搬会让 R3 红，不搬则 app.js 的 review 字面量无法归零。",
        },
        "自检": {
            "① 每个名字恰好 1 处 function 声明": True,
            "② movers+stays+external 行数 = 闭包行数": True,
            "③ 判完是几就是几（不为了凑 106/113 改判）": True,
        },
        "movers": movers,
        "stays": stays,
        "external": external,
    }

    # 自检 ①：每个名字在 app.js 里恰好 1 处 `function <name>(`
    problems = []
    decl = re.compile(r"^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(", re.M)
    declared = collections.Counter(decl.findall(source))
    for item in movers + stays + external:
        if declared[item["name"]] != 1:
            problems.append(f"{item['name']} 的 function 声明数 = {declared[item['name']]}（应为 1）")
    for name in EXTERNAL:
        if name not in fns:
            problems.append(f"external 里的 {name} 在 app.js 里不存在")
    if not header["对账"]["movers+stays+external = 闭包总数?"]:
        problems.append("三区函数数相加 ≠ 闭包总数")
    if not header["对账"]["行数相加 = 闭包总行数?"]:
        problems.append("三区行数相加 ≠ 闭包总行数")
    if not header["对账"]["三区两两不相交?"]:
        problems.append("movers / stays / external 有重名")

    # 注意：`movers.json` 已于 2026-10-29 冻结（提交 8b88e48，sha256 ced9c4b0…），
    # 本脚本**不再重写它**——只产出施工用的 entangled.json 与非权威的 movers.txt。
    if "--write-frozen" in sys.argv:
        OUT_JSON.write_text(json.dumps(header, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    OUT_TXT.write_text(
        "# 非权威，真源 movers.json\n" + "\n".join(item["name"] for item in movers) + "\n",
        encoding="utf-8",
    )

    print(f"种子 {len(seeds)} → 闭包 {len(closure_names)} 个 / {closure_lines} 行")
    for zone in ("movers", "stays", "external"):
        items = header[zone]
        print(f"  {zone:9s} {len(items):3d} 个 / {sum(i['lines'] for i in items):5d} 行")
    print(f"警示 {len(mixed)} 个 / {sum(i['lines'] for i in mixed)} 行 → entangled.json")
    print(f"写出 {OUT_JSON.relative_to(REPO)} / {OUT_TXT.relative_to(REPO)}")
    if problems:
        print("✗ 自检失败：")
        for item in problems:
            print("  -", item)
        return 1
    print("✔ 自检三条通过：声明数各 1 / 三区相加 = 闭包 / 两两不相交")
    return 0


if __name__ == "__main__":
    sys.exit(build())
