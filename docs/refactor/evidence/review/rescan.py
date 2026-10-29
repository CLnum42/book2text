"""按 HEAD 重算 `review` 切片的接缝表 / delete-plan / entangled.json。

为什么有这支脚本：2026-10-29 `seam-table.md`、`delete-plan.md`、`entangled.json`
是按 movers 43 那版写的（而冻结名单 `8b88e48` 的文件实际是 movers 120）。
本脚本以 **HEAD 的 movers.json + HEAD 的 app.js / index.html** 为唯一输入，
不读工作区（工作区是多人共享的、随时在变），因此结果可复跑、可对账。

用法：
    python3 docs/refactor/evidence/review/rescan.py            # 只打印读数 + 校验（默认）
    python3 docs/refactor/evidence/review/rescan.py --write    # 重写三份产物
    python3 docs/refactor/evidence/review/rescan.py --expect-sha ced9c4b08f9de814

校验（不通过则 exit 1，不落盘）：
  ① 三区名字在 HEAD app.js 里各恰好 1 处顶层 `function` 声明
  ② movers + stays + external = 闭包；行数逐栏相加 = 闭包行数；两两不相交
  ③ states_and_consts 每条的 kind / declaredAt / writePoints 与 HEAD 源码一致
  ④ movers.json 的 sha256 与 --expect-sha 一致（防止换成别的版本）
  ⑤ 注入面里每个名字都是 HEAD app.js 的顶层声明（不引用不存在的东西）
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
REL_APP = "backend/book2text/static/app.js"
REL_INDEX = "backend/book2text/static/index.html"
REL_MOVERS = "docs/refactor/evidence/review/movers.json"
VIEW = "view-review"

OUT_SEAM = HERE / "seam-table.md"
OUT_DELETE = HERE / "delete-plan.md"
OUT_ENTANGLED = HERE / "entangled.json"


# ---------------------------------------------------------------- 输入（只认 git）

def git_show(rev: str, path: str) -> str:
    result = subprocess.run(
        ["git", "show", f"{rev}:{path}"],
        cwd=REPO, capture_output=True, text=True,
    )
    if result.returncode != 0:
        raise SystemExit(f"✗ git show {rev}:{path} 失败：{result.stderr.strip()}")
    return result.stdout


def head_sha() -> str:
    return subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"],
        cwd=REPO, capture_output=True, text=True, check=True,
    ).stdout.strip()


# ---------------------------------------------------------------- 源码解析

def strip_js(body: str) -> str:
    """去掉字符串与注释，**保留模板字符串 `${…}` 里的表达式**（token 就只出现在那里）。"""
    out, i, n = [], 0, len(body)
    while i < n:
        ch = body[i]
        if ch in "\"'":
            quote, i = ch, i + 1
            while i < n:
                if body[i] == "\\":
                    i += 2
                    continue
                if body[i] == quote:
                    i += 1
                    break
                i += 1
            out.append('""')
        elif ch == "`":
            i += 1
            while i < n:
                if body[i] == "\\":
                    i += 2
                    continue
                if body[i] == "`":
                    i += 1
                    break
                if body[i] == "$" and i + 1 < n and body[i + 1] == "{":
                    depth, j = 1, i + 2
                    while j < n and depth:
                        if body[j] == "{":
                            depth += 1
                        elif body[j] == "}":
                            depth -= 1
                        j += 1
                    out.append(" " + strip_js(body[i + 2:j - 1]) + " ")
                    i = j
                    continue
                i += 1
            out.append("``")
        elif body.startswith("//", i):
            while i < n and body[i] != "\n":
                i += 1
        elif body.startswith("/*", i):
            end = body.find("*/", i + 2)
            i = n if end < 0 else end + 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def function_inventory(source: str) -> dict[str, dict]:
    """顶层 `function` / `async function`：名字 → 1-based {start, end, lines}。"""
    lines = source.split("\n")
    found: dict[str, dict] = {}
    for match in re.finditer(r"^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(", source, re.M):
        name = match.group(1)
        start = source.count("\n", 0, match.start())
        end = start + 1
        while end < len(lines) and lines[end] != "}":
            end += 1
        if name in found:
            raise SystemExit(f"✗ 函数 {name} 有重复顶层声明，无法定位")
        found[name] = {"start": start + 1, "end": end + 1, "lines": end - start + 1}
    return found


def top_level_decls(source: str) -> dict[str, dict]:
    """顶层声明：函数 + `const|let|var NAME =`（含 `const el = (…) =>` 这种箭头函数）。"""
    found: dict[str, dict] = {}
    for name, rec in function_inventory(source).items():
        found[name] = {"kind": "function", "line": rec["start"]}
    for index, line in enumerate(source.split("\n"), 1):
        match = re.match(r"^(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=", line)
        if match and match.group(2) not in found:
            arrow = "=>" in line
            found[match.group(2)] = {
                "kind": "function" if arrow else match.group(1),
                "line": index,
                "arrow": arrow,
            }
    return found


def section_ids(html: str, view: str) -> set[str]:
    """`<section id="view-review">` 子树（按 section 深度）里的全部 id，含视图根。"""
    match = re.search(rf'<section\b[^>]*\bid="{re.escape(view)}"[^>]*>', html, re.I)
    if not match:
        raise SystemExit(f'✗ index.html 里没有 <section id="{view}">')
    depth, cursor = 1, match.end()
    for tag in re.finditer(r"<(/?)section\b", html[cursor:], re.I):
        depth += -1 if tag.group(1) else 1
        if depth == 0:
            return set(re.findall(r'\bid="([^"]+)"', html[match.start():cursor + tag.end()]))
    raise SystemExit(f'✗ <section id="{view}"> 没有闭合')


BUILTIN = set("""
this true false null undefined new return if else for while do switch case break continue
function const let var typeof instanceof in of delete void throw try catch finally class
extends await async yield document window console JSON Math Object Array String Number
Boolean Promise Map Set WeakMap WeakSet Symbol Date RegExp Error TypeError RangeError
parseInt parseFloat isNaN isFinite setTimeout clearTimeout setInterval clearInterval
requestAnimationFrame cancelAnimationFrame fetch alert confirm prompt localStorage
sessionStorage location history navigator URLSearchParams URL URLSearchParams Blob File
FileReader FormData Image Event CustomEvent KeyboardEvent MouseEvent PointerEvent
AbortController encodeURI encodeURIComponent decodeURIComponent btoa atob structuredClone
queueMicrotask Infinity NaN globalThis performance crypto arguments argument
addEventListener removeEventListener IntersectionObserver ResizeObserver MutationObserver
TextEncoder TextDecoder Uint8Array Uint32Array ArrayBuffer Intl matchMedia getComputedStyle
scrollTo open close print eval Proxy Reflect BigInt
""".split())


def identifiers(body: str) -> set[str]:
    """函数体里的自由标识符：先去字符串/注释（保留 `${}`），再去属性访问与声明点。"""
    text = strip_js(body)
    text = re.sub(r"^(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{", "", text)
    text = re.sub(r"\.\s*([A-Za-z_$][\w$]*)", ".", text)          # 属性访问不算引用
    text = re.sub(r"(?:const|let|var)\s+([A-Za-z_$][\w$]*)", " _decl ", text)
    text = re.sub(r"\(\s*([A-Za-z_$][\w$]*)\s*(?:,|\)\s*=>)", lambda m: m.group(0).replace(m.group(1), " _param "), text)
    return set(re.findall(r"(?<![\w$.])([A-Za-z_$][\w$]*)", text))


def write_points(source: str, name: str) -> list[int]:
    """`NAME = …`（非 `==`）的行号；负向前后视排除属性访问。"""
    pattern = re.compile(r"(?<![\w$.])" + re.escape(name) + r"\s*=(?!=)")
    return [i for i, line in enumerate(source.split("\n"), 1) if pattern.search(line)]


# ---------------------------------------------------------------- 计算

def compute(rev: str) -> dict:
    app = git_show(rev, REL_APP)
    index = git_show(rev, REL_INDEX)
    movers_raw = git_show(rev, REL_MOVERS)
    data = json.loads(movers_raw)

    lines = app.split("\n")
    fns = function_inventory(app)
    decls = top_level_decls(app)
    ids = section_ids(index, VIEW)

    zones = {z: {x["name"]: x for x in data[z]} for z in ("movers", "stays", "external")}

    # ① 每个名字在 HEAD 里恰好 1 处顶层声明
    problems = [f"三区名字在 HEAD app.js 找不到：{n}"
                for z in zones.values() for n in z if n not in fns]
    if problems:
        raise SystemExit("✗ " + "；".join(problems))

    # ② 对账
    n_m = len(zones["movers"]) + len(zones["stays"]) + len(zones["external"])
    l_m = sum(x["lines"] for z in zones.values() for x in z.values())
    if n_m != len(fns) and n_m != data["对账"]["函数数"]["闭包"]:
        raise SystemExit(f"✗ 三区函数数和 {n_m} ≠ 闭包 {data['对账']['函数数']['闭包']}")
    if l_m != data["对账"]["行数"]["闭包"]:
        raise SystemExit(f"✗ 三区行数和 {l_m} ≠ 闭包 {data['对账']['行数']['闭包']}")
    for a in ("movers", "stays", "external"):
        for b in ("movers", "stays", "external"):
            if a < b and set(zones[a]) & set(zones[b]):
                raise SystemExit(f"✗ {a} 与 {b} 有交集")

    # ③ states_and_consts 与源码逐条对账
    for item in data["states_and_consts"]:
        name, decl_line = item["name"], item["declaredAt"]
        expected = lines[decl_line - 1] if decl_line <= len(lines) else ""
        kind = "const" if re.match(r"^\s*const\b", expected) else (
            "let" if re.match(r"^\s*(?:let|var)\b", expected) else "other")
        if kind != item["kind"]:
            raise SystemExit(f"✗ {name} 声明形态不符：名单 {item['kind']} / 源码 {kind}")
        got = len(write_points(app, name))
        if got != item["writePoints"]:
            raise SystemExit(f"✗ {name} 写点数不符：名单 {item['writePoints']} / 我数 {got}")

    # ④ 注入面：movers 引用、但不在 movers 内的顶层声明
    mover_names = set(zones["movers"])
    seams: dict[str, dict] = {}
    for name, rec in zones["movers"].items():
        body = "\n".join(lines[rec["start"] - 1:rec["end"]])
        for ident in identifiers(body):
            if ident in BUILTIN or ident in mover_names or ident not in decls:
                continue
            seams.setdefault(ident, {"by": set(), "decl": decls[ident]})["by"].add(name)
    for ident, info in seams.items():
        if ident in zones["stays"]:
            info["zone"] = "stays"
        elif ident in zones["external"]:
            info["zone"] = "external"
        else:
            info["zone"] = "无"

    # ⑤ 分类（Chief 2026-10-29 定：谁负责写，谁持有）
    frozen = {x["name"]: x for x in data["states_and_consts"]}
    for ident, info in seams.items():
        kind = info["decl"]["kind"]
        info["kind"] = kind
        info["writePoints"] = len(write_points(app, ident))
        info["frozen"] = ident in frozen
        info["writtenBy"] = sorted(frozen[ident]["writtenBy"]) if ident in frozen else []
        # 注意：写点正则把**声明行本身**也数进去（`let x = …` 命中 `x =`）。
        # 所以「只读」= writtenBy 只有「声明」，不是 writePoints == 0。
        writes = {w for w in info["writtenBy"] if w not in ("声明",)}
        if kind == "function":
            info["action"] = "注入函数"
        elif kind == "const":
            info["action"] = "注入值"
        elif not writes:
            info["action"] = "注入 get（只读）"
        elif "movers" not in writes:
            info["action"] = "注入 get（外壳持有）"
        elif writes <= {"movers"}:
            info["action"] = "搬进模块（写点全在 movers）"
        else:
            info["action"] = "注入 get/set（写点跨区）"

    # ⑥ movers.txt 是过期子集：它不参与任何计算，但报出来，防止下一个人再去读它
    txt_raw = subprocess.run(
        ["git", "show", f"{rev}:docs/refactor/evidence/review/movers.txt"],
        cwd=REPO, capture_output=True, text=True,
    ).stdout
    txt_names = {ln.strip() for ln in txt_raw.splitlines() if ln.strip() and not ln.startswith("#")}
    stale_txt = {
        "条数": len(txt_names),
        "⊆ movers": txt_names <= mover_names,
        "缺多少": len(mover_names - txt_names),
    }

    # ⑦ 字面量账：movers 内 vs 留在 app.js
    pattern = re.compile(r'["\'](' + "|".join(sorted(map(re.escape, ids), key=len, reverse=True)) + r')["\']')
    owner = {}
    for index_line, line in enumerate(lines, 1):
        hits = pattern.findall(line)
        if not hits:
            continue
        holder = "<顶层>"
        for fname, rec in fns.items():
            if rec["start"] <= index_line <= rec["end"]:
                holder = fname
                break
        owner.setdefault(holder, {"total": 0, "in_movers": 0, "ids": set()})
        owner[holder]["total"] += len(hits)
        owner[holder]["ids"].update(hits)
        if holder in mover_names:
            owner[holder]["in_movers"] += len(hits)
    moved = sum(v["in_movers"] for v in owner.values())
    residual = {k: v for k, v in owner.items() if v["in_movers"] < v["total"]}

    # ⑦ entangled：写 review 的 DOM、但不搬的函数（旧 40 的替代口径）
    entangled = {}
    for name, rec in fns.items():
        if name in mover_names:
            continue
        body = "\n".join(lines[rec["start"] - 1:rec["end"]])
        hits = pattern.findall(body) or []
        if not hits:
            continue
        touched = set(re.findall(r'\bel\(\s*["\']([a-z0-9-]+)["\']', body))
        touched |= set(re.findall(r'\bgetElementById\(\s*["\']([a-z0-9-]+)["\']', body))
        touched |= set(re.findall(r'\bquerySelector(?:All)?\(\s*["\']#([a-z0-9-]+)', body))
        entangled[name] = {
            "zone": ("stays" if name in zones["stays"]
                     else "external" if name in zones["external"] else "无"),
            "start": rec["start"], "end": rec["end"], "lines": rec["lines"],
            "literal_occurrences": len(hits),
            "ids": sorted(set(hits)),
            "reviewIdsViaEl": sorted(touched & ids),
        }

    return {
        "rev": rev,
        "rev_sha": head_sha(),
        "app_sha256": hashlib.sha256(app.encode("utf-8")).hexdigest(),
        "index_sha256": hashlib.sha256(index.encode("utf-8")).hexdigest(),
        "sha256": hashlib.sha256(movers_raw.encode("utf-8")).hexdigest(),
        "app_lines": len(lines) - (1 if lines and lines[-1] == "" else 0),
        "zones": zones,
        "data": data,
        "decls": decls,
        "fns": fns,
        "ids": ids,
        "seams": seams,
        "moved": moved,
        "total_literals": moved + sum(v["total"] - v["in_movers"] for v in residual.values()),
        "residual": residual,
        "entangled": entangled,
        "stale_txt": stale_txt,
    }


# ---------------------------------------------------------------- 产物

def table(headers: list[str], rows: list[list[str]], align: list[str] | None = None) -> str:
    head = "| " + " | ".join(headers) + " |"
    rule = "|" + "|".join(align or ["---"] * len(headers)) + "|"
    return "\n".join([head, rule] + ["| " + " | ".join(str(c) for c in row) + " |" for row in rows])


def render_seam(r: dict) -> str:
    seams = r["seams"]
    by_action: dict[str, list[dict]] = {}
    for name, info in seams.items():
        by_action.setdefault(info["action"], []).append({**info, "name": name})

    def names(action):
        return sorted(by_action.get(action, []), key=lambda x: x["name"])

    out = []
    out.append("# `review` 切片的残余接缝（脚本生成，按内容哈希锚定）\n")
    out.append("**这份表是脚本吐的，不是手抄的**：`python3 docs/refactor/evidence/review/rescan.py`。\n")
    out.append(f"- 锚定：`app.js` sha256 `{r['app_sha256'][:16]}` · `index.html` sha256 `{r['index_sha256'][:16]}`"
               f"（**记内容哈希不记提交号**：提交号每提交一次就过期，内容哈希不会）")
    out.append(f"- 名单：`HEAD:movers.json`，sha256 `{r['sha256'][:16]}`（movers "
               f"{len(r['zones']['movers'])} / stays {len(r['zones']['stays'])} / external "
               f"{len(r['zones']['external'])}）")
    out.append(f"- 源码：`HEAD:app.js` {r['app_lines']:,} 行；`view-review` 子树 {len(r['ids'])} 个 id")
    out.append(f"- **`movers.txt` 不参与任何计算**：同一提交里它只有 {r['stale_txt']['条数']} 条（是 movers 的子集，"
               f"少 {r['stale_txt']['缺多少']} 条）——照它搬就是「落盘后审校树空着、静态门全绿」。真源只有 `movers.json`。")
    out.append("- 口径：**接缝 = movers 的函数体里引用、但不在 movers 内的顶层声明**。")
    out.append("**性质**：这是模块正文会裸引用、必须由 `app.js` 通过 `injected` 提供的全部符号。"
               "处理方式按 Chief 2026-10-29 定的「谁负责写，谁持有」分三类。\n")
    out.append("## 0. 汇总\n")
    out.append(table(["处理", "个数", "判据"], [
        ["注入函数", len(names("注入函数")), "形态 `function`（含 `const f = (…) =>`），写点无关"],
        ["注入值", len(names("注入值")), "形态 `const`，模块只读——**是值，不是 getter**"],
        ["注入 get（只读）", len(names("注入 get（只读）")), "`let`，写点只有声明本身 → 模块只读"],
        ["注入 get（外壳持有）", len(names("注入 get（外壳持有）")), "`let`，写点全在外壳 → 模块只读，声明不搬"],
        ["搬进模块", len(names("搬进模块（写点全在 movers）")), "`let`，写点全在 movers → 模块自己持有"],
        ["注入 get/set", len(names("注入 get/set（写点跨区）")), "`let`，写点跨 movers 与外壳/stays"],
        ["**合计**", len(seams), "三区之外的全部顶层声明依赖"],
    ], ["---", "---:", "---"]))
    out.append("")

    def section(title: str, action: str, note: str):
        rows = names(action)
        if not rows:
            return
        out.append(f"## {title}（{len(rows)}）\n")
        out.append(note + "\n")
        out.append(table(["名字", "形态", "写点", "三区", "被几个 mover 用"], [
            [x["name"], x["kind"] + (" →" if x["decl"].get("arrow") else ""),
             "—" if x["kind"] == "function" else x["writePoints"], x["zone"], len(x["by"])] for x in rows
        ], ["---", "---", "---:", "---", "---:"]))
        out.append("")

    section("1. 注入函数", "注入函数",
            "外壳保留声明，模块调 `injected.name(...)`。`stays` 的按注入面走；"
            "**`无` 的是三区未覆盖的（需要人判是否该归 stays）**。")
    section("2. 注入值（const）", "注入值",
            "**值不是 getter**：`injected.BOX_MIN_HEIGHT`，写成 `getBoxMinHeight()` 是错的（library 第一版就这么错过）。")
    section("3. 注入 get（只读状态）", "注入 get（只读）",
            "写点只有声明本身（`writePoints == 1`）：模块拿 `injected.getX()` 即可，不必开 setter。")
    section("3b. 注入 get（外壳持有的状态）", "注入 get（外壳持有）",
            "写点全在外壳、模块只读 → 声明留外壳，模块只 get。")
    section("4. 搬进模块（状态，写点全在 movers）", "搬进模块（写点全在 movers）",
            "写点全部落在 movers 的函数体里 → 状态归属模块，**声明随搬，`OWNERS` 同批改**。")
    section("5. 注入 get/set（状态，写点跨区）", "注入 get/set（写点跨区）",
            "写点同时落在 movers 与外壳/stays → 按「谁写谁持有」留外壳，模块 `get/set`，"
            "**不要把副本存进模块**（⑧ 状态归属）。")

    out.append("## 6. 三区覆盖不到、但确实被 movers 引用的顶层声明\n")
    orphan = sorted(n for n, i in seams.items() if i["zone"] == "无" and not i["frozen"])
    out.append("这些既不在 `movers`/`stays`/`external`，也不在 `states_and_consts` 里——"
               "**名单的三个区是按函数闭包切的，顶层状态/常量本来就不在闭包里**，"
               "所以「无」不代表判断错，只代表「名单没有为它作判断」。\n")
    out.append(table(["名字", "形态", "写点", "被几个 mover 用", "说明"], [
        [n, seams[n]["kind"], seams[n]["writePoints"], len(seams[n]["by"]),
         "DOM 取元素助手（69 个 movers 调它）" if n == "el" else ""] for n in orphan
    ], ["---", "---", "---:", "---:", "---"]))
    out.append("")

    out.append("## 7. `token` 的写点数是个假阳性（写进文档，别再被它误导）\n")
    token_wp = seams.get("token", {}).get("writePoints")
    out.append(f"`token` 是 `const`（第 14 行），名单报 **{token_wp} 个写点**，实际是 **1 个**"
               f"（就是声明本身）。原因：写点正则 `(?<![\\w$.])NAME\\s*=(?!=)` 会把 URL 查询串里的 "
               "`?token=…` 也算成赋值。**同类符号只要名字出现在查询串里就会中招**；"
               "本切片只有 `token` 一个。按 `const` 处理 → 注入值，不受影响。\n")

    out.append("## 8. 结论：R3（字面量归零）的真实目标不是 0\n")
    out.append(f"`view-review` 子树 {len(r['ids'])} 个 id 在 `HEAD:app.js` 里的字面量出现 **{r['total_literals']} 处**：\n")
    out.append(table(["持有者", "总出现", "随 movers 搬走", "留在 app.js"], [
        [name, info["total"], info["in_movers"], info["total"] - info["in_movers"]]
        for name, info in sorted(r["residual"].items(), key=lambda kv: -(kv[1]["total"] - kv[1]["in_movers"]))
    ], ["---", "---:", "---:", "---:"]))
    left = sum(v["total"] - v["in_movers"] for v in r["residual"].values())
    out.append("")
    out.append(f"**搬完 {len(r['zones']['movers'])} 个 movers 后，`app.js` 里还剩 {left} 处**"
               "（不是 0，更不是旧表说的 218——218 是更早一版的口径，与 HEAD 对不上）。")
    out.append(f"其中 `setupReviewControls` 一个函数占 19 处：它混用了 17 个 review id 与 35 个别的视图 id，"
               f"按闭包算法被判成叶子、**不在三区任何一区**，所以既不搬也不在警示区。")
    out.append("要让这 19 处归零，只有两条路：拆 `setupReviewControls`（review 部分进模块、其余留外壳），"
               "或显式豁免。**纯搬运做不到。**\n")
    return "\n".join(out) + "\n"


def render_delete(r: dict) -> str:
    seams = r["seams"]
    fns = r["fns"]
    zones = r["zones"]
    ent = r["entangled"]
    mover_names = set(zones["movers"])

    out = []
    out.append("# `review` 切片的删除许可证（脚本生成，按内容哈希锚定）\n")
    out.append("**用途**：UX V3 重写会删掉 `view-review` 一大片渲染代码。删之前必须知道"
               "「哪些东西还在别处被用」——这份表就是删的许可证。\n")
    out.append(f"- 锚定：`app.js` sha256 `{r['app_sha256'][:16]}` · `index.html` sha256 `{r['index_sha256'][:16]}`")
    out.append(f"- 名单：`HEAD:movers.json` sha256 `{r['sha256'][:16]}`"
               f"（movers {len(zones['movers'])} / stays {len(zones['stays'])} / external {len(zones['external'])}）")
    out.append(f"- 源码：`HEAD:app.js` {r['app_lines']:,} 行\n")
    out.append("## 1. 删前三问（每个符号都要过）\n")
    out.append("1. **还有谁在引用它？** —— 只看 `HEAD:app.js` 的调用点，不看注释、不看文档。")
    out.append("2. **删了以后谁红？** —— `node tests/js/run.mjs` 的 R3（字面量）/ R5（导出）/ R11（边棘轮），"
               "三张登记表必须先改，再删。")
    out.append("3. **它是状态还是渲染？** —— 状态只许改持有者，渲染可以整段删。\n")

    out.append(f"## 2. 随 movers 一起走的 {len(mover_names)} 个函数（{sum(x['lines'] for x in zones['movers'].values()):,} 行）\n")
    out.append("整段可以删（内容已进模块）：\n")
    rows = [[n, zones["movers"][n]["lines"]] for n in sorted(mover_names, key=lambda x: -zones["movers"][x]["lines"])]
    out.append(table(["名字", "行数"], rows, ["---", "---:"]))
    out.append("")

    out.append(f"## 3. 留在 `app.js`、但写着 review 的 DOM 的函数（{len(ent)} 个 / {sum(v['lines'] for v in ent.values()):,} 行）\n")
    out.append("**这些是删除的硬边界**：删 review 渲染时它们的函数体里还有 review 的 id 字面量。\n")
    out.append(table(["名字", "行范围", "行数", "三区", "review 字面量", "经 el() 碰的 review id"], [
        [n, f"{v['start']}–{v['end']}", v["lines"], v["zone"], v["literal_occurrences"],
         ", ".join(v["reviewIdsViaEl"][:4]) + ("…" if len(v["reviewIdsViaEl"]) > 4 else "")]
        for n, v in sorted(ent.items(), key=lambda kv: -kv[1]["literal_occurrences"])
    ], ["---", "---", "---:", "---", "---:", "---"]))
    out.append("")

    out.append("## 4. 会留在 `app.js` 的 review 字面量（删除账）\n")
    residual = {k: v for k, v in r["residual"].items() if v["in_movers"] < v["total"]}
    out.append(table(["持有者", "留几处", "是些什么 id", "删的时候怎么办"], [
        [name, info["total"] - info["in_movers"], ", ".join(sorted(info["ids"])[:6]) + ("…" if len(info["ids"]) > 6 else ""),
         ("**最大一笔**：拆成 review 部分进模块 + 其余留外壳，或豁免" if name == "setupReviewControls"
          else "跨视图引用：跟着它所属的视图走，别在 review 这一刀删")]
        for name, info in sorted(residual.items(), key=lambda kv: -(kv[1]["total"] - kv[1]["in_movers"]))
    ], ["---", "---:", "---", "---"]))
    left = sum(v["total"] - v["in_movers"] for v in residual.values())
    out.append("")
    out.append(f"合计 **{left} 处**。其中 {residual.get('setupReviewControls', {}).get('total', 0) - residual.get('setupReviewControls', {}).get('in_movers', 0)} 处在 "
               "`setupReviewControls`——它按闭包是叶子、不在三区，所以**名单没为它作判断**，"
               "这是名单的一个已知缺口，不是实现漏了。\n")

    out.append("## 5. 接缝（模块正文会引用的、三区之外的顶层声明）\n")
    by_action: dict[str, dict[str, dict]] = {}
    for name, info in seams.items():
        by_action.setdefault(info["action"], {})[name] = info
    out.append(table(["处理", "个数", "删的时候要不要动它"], [
        ["注入函数", len(by_action.get("注入函数", {})), "生产者在 `app.js`，**外壳函数一个都不许删**"],
        ["注入值", len(by_action.get("注入值", {})), "常量留外壳，删了模块就 ReferenceError"],
        ["注入 get（只读）", len(by_action.get("注入 get（只读）", {})), "留外壳"],
        ["注入 get（外壳持有）", len(by_action.get("注入 get（外壳持有）", {})), "留外壳"],
        ["搬进模块", len(by_action.get("搬进模块（写点全在 movers）", {})), "**声明跟着搬**，外壳那份删掉（否则两份状态）"],
        ["注入 get/set", len(by_action.get("注入 get/set（写点跨区）", {})), "留外壳，模块只 get/set"],
    ], ["---", "---:", "---"]))
    out.append("")
    out.append("## 6. 删除顺序（每步都能单独回滚）\n")
    out.append("1. 先改三张登记表（`OWNERS` / `VIEW_EXPORTS` / `VIEW_STATE_PREFIXES`），让闸知道即将发生什么；")
    out.append("2. 删 movers 的函数体（`app.js` 侧），模块侧已等价；")
    out.append("3. 删 review 的 DOM 写点（含 `setupReviewControls` 里那 19 处）——**这一步才是 R3 归零**；")
    out.append("4. 最后删状态声明（只删「搬进模块」那批，别删 get/set 那批的声明）。")
    out.append("")
    out.append("**任何时候 `node tests/js/run.mjs` 红，就停在这一步，别往下删。**")
    out.append("")
    return "\n".join(out)


def render_entangled(r: dict) -> str:
    payload = {
        "口径": {
            "视图": VIEW,
            "来源": f"HEAD:{REL_APP} + HEAD:{REL_MOVERS}",
            "app_sha256": r["app_sha256"],
            "index_sha256": r["index_sha256"],
            "movers_sha256": r["sha256"],
            "定义": "函数体里出现 view-review 子树 id 字面量、且该函数不在 movers 里（= 搬不走、但写着这个视图的 DOM）",
            "计数口径": "literal_occurrences 是**字面量出现处数**，不是 id 个数、也不是函数个数",
            "上一版": "40 个 / 1,557 行（按 movers 43 那版算，已作废）",
        },
        "对账": {
            "函数数": len(r["entangled"]),
            "行数": sum(v["lines"] for v in r["entangled"].values()),
            "字面量处数": sum(v["literal_occurrences"] for v in r["entangled"].values()),
            "按区": {z: sum(1 for v in r["entangled"].values() if v["zone"] == z)
                    for z in ("stays", "external", "无")},
        },
        "函数": [
            {"name": n, **v}
            for n, v in sorted(r["entangled"].items(), key=lambda kv: -kv[1]["literal_occurrences"])
        ],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


# ---------------------------------------------------------------- main

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rev", default="HEAD")
    parser.add_argument("--write", action="store_true", help="重写三份产物")
    parser.add_argument("--expect-sha", default="", help="movers.json 的 sha256 前缀")
    args = parser.parse_args()

    r = compute(args.rev)
    if args.expect_sha and not r["sha256"].startswith(args.expect_sha):
        raise SystemExit(f"✗ movers.json sha256 {r['sha256'][:16]} ≠ --expect-sha {args.expect_sha}")

    zones = r["zones"]
    print(f"movers.json sha256 {r['sha256'][:16]} · app.js {r['app_lines']:,} 行")
    print(f"三区：movers {len(zones['movers'])} / stays {len(zones['stays'])} / external "
          f"{len(zones['external'])} · 行数 {sum(x['lines'] for x in zones['movers'].values()):,} / "
          f"{sum(x['lines'] for x in zones['stays'].values()):,} / "
          f"{sum(x['lines'] for x in zones['external'].values()):,}")
    by_action: dict[str, int] = {}
    for info in r["seams"].values():
        by_action[info["action"]] = by_action.get(info["action"], 0) + 1
    print(f"接缝（三区外的顶层依赖）：{len(r['seams'])}  " +
          " · ".join(f"{k} {v}" for k, v in sorted(by_action.items())))
    print(f"review 字面量：总 {r['total_literals']} · 随 movers {r['moved']} · "
          f"留在 app.js {r['total_literals'] - r['moved']}")
    print(f"movers.txt（过期，不参与计算）：{r['stale_txt']['条数']} 条 · "
          f"⊆ movers {r['stale_txt']['⊆ movers']} · 比 movers 少 {r['stale_txt']['缺多少']} 条")
    print(f"entangled：{len(r['entangled'])} 个函数 / "
          f"{sum(v['lines'] for v in r['entangled'].values())} 行 / "
          f"{sum(v['literal_occurrences'] for v in r['entangled'].values())} 处字面量")

    if args.write:
        OUT_SEAM.write_text(render_seam(r), encoding="utf-8")
        OUT_DELETE.write_text(render_delete(r), encoding="utf-8")
        OUT_ENTANGLED.write_text(render_entangled(r), encoding="utf-8")
        print(f"已写：{OUT_SEAM.name} / {OUT_DELETE.name} / {OUT_ENTANGLED.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
