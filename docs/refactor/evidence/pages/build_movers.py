"""生成 `pages` 搬迁名单（movers.json）——**脚本生成，不手抄、不照抄旧调查的数**。

算法（照 `review` 那套，Chief 2026-10-29 定，别换方法）：

    C = 种子（函数体里出现 view-pages 子树 id 字符串）的引用图闭包
        引用图 = f 出现在**非定义位置**就算一条边（值引用也算）。
        壳根 boot / setupShell / setupLibrary 剔除；只从「可能搬」的节点继续扩——
        引用别视图 id 的函数、流程函数、有 C 外调用者的接缝是叶子，不再顺着扩
        （否则闭包会把全站卷进来，pages 调查里 v1/v2 差 62 个百分点就是栽在这）。

    movers   = f ∈ C 且 ① 引用了 view-pages 的 id 或 ② 只被 C 内函数引用
    stays    = f ∈ C 但引用了别的视图的 id / 被外壳或 C 外函数直接调用 / 流程推进
    external = 不属于 pages 的外部流程（预览 / 任务包，见 pages-attribution.md）

**取源码用 HEAD 树，不读工作区**（`git show HEAD:<path>`）——今天已经栽过三次
「验的是哪棵树」。基线 sha 与 app.js 行数写进文件头。

用法：python3 docs/refactor/evidence/pages/build_movers.py
自检不过 exit 1；只写本目录 movers.json。
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
OUT = HERE / "movers.json"

VIEW = "pages"
SHELL_ROOTS = {"boot", "setupShell", "setupLibrary"}

EXTERNAL = {
    "renderCompare": "预览对比：渲染（碰的 id 全在别的 section）",
    "openPackageFile": "任务包：打开文件",
    "loadComparePage": "预览对比：加载页",
    "drawCompareOverlay": "预览对比：画叠加层",
    "selectSegment": "预览：选中段落",
    "loadExportPreview": "导出预览：加载",
    "revealPackage": "任务包：定位",
    "revealExport": "导出：定位",
    "setupPackageControls": "任务包：控件装配",
}

FLOW_STAYS: dict[str, str] = {}

# 接线类调用者（2026-10-29 Chief 定）：一次性接线，调用点随 init 一起进模块 → **不算接缝**。
# 反例（逻辑类，算接缝）：别的视图的流程函数、showView 的路由链——外壳要持续调用它。
WIRING_ROOTS = {"boot", "setupShell", "setupLibrary", "setupPages"}
WIRING_PATTERN = re.compile(r"^setup[A-Z]")


def is_wiring(name: str) -> bool:
    return name in WIRING_ROOTS or bool(WIRING_PATTERN.match(name))


def git_show(path: str) -> str:
    return subprocess.check_output(
        ["git", "-C", str(REPO), "show", f"HEAD:{path}"], text=True
    )


def function_inventory(source: str):
    lines = source.split("\n")
    found: dict[str, dict] = {}
    pattern = re.compile(r"^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(", re.M)
    for match in pattern.finditer(source):
        name = match.group(1)
        start = source.count("\n", 0, match.start())
        end = start + 1
        while end < len(lines) and lines[end] != "}":
            end += 1
        if name in found:
            raise SystemExit(f"✗ 函数 {name} 有重复顶层声明，名单无法定位")
        found[name] = {"start": start + 1, "end": end + 1, "lines": end - start + 1}
    return found


def section_ids(html: str, view: str) -> set[str]:
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
    found = set(re.findall(r'\bel\(\s*["\']([a-z0-9-]+)["\']', body))
    found |= set(re.findall(r'\bgetElementById\(\s*["\']([a-z0-9-]+)["\']', body))
    found |= set(re.findall(r'\bquerySelector(?:All)?\(\s*["\']#([a-z0-9-]+)["\']', body))
    return found


def build():
    source = git_show("backend/book2text/static/app.js")
    html = git_show("backend/book2text/static/index.html")
    baseline = subprocess.check_output(
        ["git", "-C", str(REPO), "rev-parse", "--short", "HEAD"], text=True
    ).strip()
    lines = source.split("\n")
    fns = function_inventory(source)
    bodies = {n: "\n".join(lines[r["start"] - 1:r["end"]]) for n, r in fns.items()}
    ids_all = section_ids(html, f"view-{VIEW}")
    ids = ids_all - {f"view-{VIEW}"}
    touch = {n: touched_ids(b) for n, b in bodies.items()}

    seeds = {n for n, hits in touch.items() if (hits & ids_all) and n not in SHELL_ROOTS}

    refpat = {n: re.compile(r"(?<![\w$.])" + re.escape(n) + r"(?![\w$])") for n in fns}
    edges = {
        n: {c for c, p in refpat.items() if c != n and p.search(b[ b.find("{") + 1:])}
        for n, b in bodies.items()
    }
    callers: dict[str, set[str]] = collections.defaultdict(set)
    for n, callees in edges.items():
        for c in callees:
            callers[c].add(n)

    def outside(name: str) -> set[str]:
        return touch[name] - ids_all

    closure = set(seeds)
    changed = True
    while changed:
        changed = False
        for name in list(closure):
            if outside(name) or name in FLOW_STAYS:
                continue
            blocking = {c for c in callers[name] if not is_wiring(c)}
            if not blocking <= closure:
                continue
            for callee in edges[name]:
                if callee in closure or callee in SHELL_ROOTS:
                    continue
                closure.add(callee)
                changed = True

    movers, stays = [], []
    for name in sorted(closure):
        if name in EXTERNAL:
            continue
        rec = fns[name]
        leak = sorted({c for c in callers[name]
                       if not is_wiring(c) and c not in closure})
        wiring = sorted({c for c in callers[name] if is_wiring(c)})
        outside_ids = sorted(outside(name))
        if outside_ids:
            why = "引用段外 id：" + "、".join(outside_ids[:6]) + ("…" if len(outside_ids) > 6 else "")
            stays.append({"name": name, **rec, "why": why, "kind": "other-view-dom"})
        elif name in FLOW_STAYS:
            stays.append({"name": name, **rec, "why": FLOW_STAYS[name], "kind": "flow"})
        elif leak:
            why = "被逻辑类调用者调用：" + "、".join(leak[:6]) + ("…" if len(leak) > 6 else "")
            if wiring:
                why += "（接线类另有：" + "、".join(wiring[:4]) + "，不计）"
            stays.append({"name": name, **rec, "why": why, "kind": "seam"})
        else:
            if touch[name]:
                why = "引用 view-pages 的 id：" + "、".join(sorted(touch[name])[:6])
            else:
                inside = sorted(callers[name])[:4]
                why = "不碰 id；只被 C 内函数引用：" + "、".join(inside) + ("…" if len(callers[name]) > 4 else "")
            movers.append({"name": name, **rec, "why": why})

    external = [{"name": n, "why": w, **fns[n]} for n, w in sorted(EXTERNAL.items()) if n in fns]

    # 状态与常量：模块要用到的顶层 let/const（闭包不含它们，必须单列）
    consts = re.findall(r"^(?:let|const)\s+([A-Za-z_$][\w$]*)\s*=", source, re.M)
    mover_bodies = "\n".join(bodies[i["name"]] for i in movers)
    states = []
    for name in sorted(set(consts)):
        pat = re.compile(r"(?<![\w$.])" + re.escape(name) + r"(?![\w$])")
        hits = len(pat.findall(mover_bodies))
        if hits:
            states.append({"name": name, "refs_in_movers": hits})

    names = [i["name"] for i in movers + stays + external]
    closure_lines = sum(i["lines"] for i in movers + stays + external)

    # 自检
    decl = re.compile(r"^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(", re.M)
    declared = collections.Counter(decl.findall(source))
    problems = []
    for item in movers + stays + external:
        if declared[item["name"]] != 1:
            problems.append(f"{item['name']} 的 function 声明数 = {declared[item['name']]}（应为 1）")
    mset, sset, eset = {i["name"] for i in movers}, {i["name"] for i in stays}, {i["name"] for i in external}
    disjoint = not (mset & sset or mset & eset or sset & eset)
    sum_ok = closure_lines == sum(i["lines"] for i in movers + stays + external)
    count_ok = len(set(names)) == len(names)
    if not disjoint:
        problems.append("三区有重名")
    if not count_ok:
        problems.append("同名元素出现两次")
    if problems:
        print("\n".join("✗ " + p for p in problems), file=sys.stderr)
        raise SystemExit(1)

    out = {
        "口径": {
            "视图": f"view-{VIEW}",
            "段内 id": f"{len(ids_all)}（含视图根）/ {len(ids)}（不含根）",
            "种子": f"{len(seeds)} 个（函数体里出现 view-pages 子树 id；壳根已剔除）",
            "闭包": "引用图（f 出现在非定义位置即一条边，值引用也算；只在可能搬的节点上继续扩）",
            "闭包总数": f"{len(movers) + len(stays) + len(external)} 个 / {closure_lines} 行",
            "基线": baseline,
            "app.js 行数": len(lines) - (1 if lines and lines[-1] == "" else 0),
            "取源码": "git show HEAD:<path>（HEAD 树，不读工作区）",
            "阈值（2026-10-29 Chief 定）": {
                "接线类调用者（不算接缝，函数可搬）": "boot / setupShell / setupLibrary / setupPages / setupXxx —— 一次性接线，调用点随 init 进模块。例：setupPages 调 buildTile 不构成接缝",
                "逻辑类调用者（算接缝，函数留外壳）": "别的视图的流程函数（如 openProject → resumeLastPosition、导出流程）、showView 路由链 —— 外壳要在这个函数的生命周期里持续调用它",
                "判据一句话": "外壳是否需要在该函数的生命周期里持续调用它：一次性接线是模块自己的事，持续调用才是接缝",
            },
            "接缝 n 是什么桶（2026-10-29 澄清，别和注入面混）": {
                "是分类桶": "`stays·接缝` = 闭包里「被逻辑类调用者调用、因此不随模块搬走」的那些函数。它是**判断的产物**，用途是告诉你哪些函数搬不动、要改成接缝。",
                "不是注入面": "注入面 ≠ 这个桶。注入面只能等于「模块正文里真正引用到的符号」——**那是派生的**，落盘后用 R1（模块里出现 app.js 顶层名即红）反推。",
                "为什么必须分开": "分类桶大 15 个不会出事（多判几个函数留外壳），注入面少 15 个会 ReferenceError。两者差一个就足够线上炸。",
                "落盘时的派生命令": "从模块里反推：grep -oE '\\binjected\\.[A-Za-z_$][A-Za-z0-9_$]*' pages-view.js | sort -u —— 或直接用 R1 的报错清单（它点名的就是缺的注入）。**不要拿这个桶当注入清单抄。**",
            },
            "旧数（作废，勿引）": "pages-attribution.md：能搬 2,338 行 / 接缝 66 个 817 行 —— 基线 16,161 行那棵树、算法不同，两个数都不能当基准；本文件的数是唯一基准",
            "旧数为何不能混用": "接缝 66 个名字一致说明集合判对了，但行数是两种量法（整函数行 vs 被外壳调用那一侧）；这��以整函数行为准",
            "说明": "名单按 HEAD 树重算，不照抄任何旧调查的数",
        },
        "对账": {
            "三区两两不相交?": disjoint,
            "行数相加 = 闭包总行数?": sum_ok,
            "每个名字恰好 1 处 function 声明?": True,
            "函数数": {"movers": len(movers), "stays": len(stays), "external": len(external),
                       "闭包": len(names)},
            "行数": {"movers": sum(i["lines"] for i in movers),
                     "stays": sum(i["lines"] for i in stays),
                     "external": sum(i["lines"] for i in external),
                     "闭包": closure_lines},
        },
        "states_and_consts": {
            "说明": "闭包不含顶层状态/常量；这里单列 movers 引用到的那些，注入/随搬由落盘时逐条定",
            "count": len(states),
            "entries": states,
        },
        "movers": movers,
        "stays": stays,
        "external": external,
    }
    OUT.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"✓ {OUT.name}: movers {len(movers)} / stays {len(stays)} / external {len(external)}"
          f" / 闭包 {closure_lines} 行 / 基线 {baseline}")


if __name__ == "__main__":
    build()
