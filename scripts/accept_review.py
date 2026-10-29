#!/usr/bin/env python3
"""scripts/accept_review.py —— `review` 第二刀落盘后的验收（机械部分）。

口径来源（**脚本不发明数字**）：
- `docs/refactor/review-slice.md`（两刀边界；§4 的 2,400..2,650 是按作废的 106/2,585 算的，已由「按名单派生」取代）
- `docs/refactor/review-attribution.md`（逐字节归属：94 含根 / 93 不含根、17 个外部流程）
- `docs/refactor/accept-template.md`（三态退出码、id 按标签深度、字面量→0、减量硬判据、导出面精确相等）

## 名单判据是「自洽」，不是「等于某个数」

`review` 的名单有四个互相打架的数：70（种子）/ 106（文档）/ 113（含跨视图）/ 121（调用闭包）——
**方法不同，谁都不是判据**。所以本脚本不对任何一条硬编码条数开红（`≠106` 这种告警已删掉），
只判名单**对不对得上自己**：

① 三区 `movers` / `stays` / `external` 的并集条数 = 文件头声明的闭包条数，且三区**两两不相交**；
② 三区行数之和 = 文件头声明的闭包行数；
③ 每个 `movers` 名字在 app.js 里 `function <name>(` **恰好 1 处**（已经搬走的，则模块里恰好 1 处）。

任一条不成立 → **exit 1 并点名**（不是告警）。门框在文件头：`closure_count` / `closure_lines`
（JSON 字段，或 txt 里的 `# closure_count: 121` 这种行）——**声明不出来就没法对账，同样 exit 1**。

## review 与 library 不同的地方

- 名单从**文件**读（`docs/refactor/evidence/review/movers.txt|json`），脚本里不抄任何函数名；
- 导出面**不由本脚本决定**：`--exports init,enter,notify` 传入，不给就是"还没定"（exit 2）；
- 额外一条**边界断言**：17 个外部流程必须「外壳有、模块没有」——这刀的核心边界就是它们没被搬进去。
  只数字面量会把"边界失守"漏掉：它们一旦被拖进 `review-view.js`，字面量照样归零、行数照样减，
  但接缝全乱了。

退出码三态：`2` 前置不满足（还没落盘 / 名单或导出面还没给）/ `1` 验收不过 / `0` 全过。
只读、cwd 无关（按脚本自身位置定位仓库）。
"""
from __future__ import annotations

import hashlib
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
BASELINE_APP_LINES = 15311         # 本刀开工时的 app.js 行数（`sh scripts/status.sh --no-fetch` 读）
# 减量门槛**从名单派生**，不写死数字。
# `review-slice.md` §4 的 2,400..2,650 是按作废的 106 / 2,585 切片算的；冻结名单是 120 个 / 2,974 行，
# 写死任何一个数都会把对的判错（按 43/879 算过的 850..950 更是差 3 倍）。
# 预期净减 ≈ movers 行数和 − 转发段占位。实测先例：library 刀 17 函数 / 371 行 → app.js 减 317（85.4%）。
#   下界 0.85 × 预期：低于它说明有函数没搬（复制不是搬）；
#   上界 1.00 × 预期：减得比名单还多 = 顺手删了别的。
# 有豁免（entangled 等）时，用 `--exempt <文件|名字…>` 把不搬的函数从预期里扣掉，门槛跟着走。
SHRINK_MIN_RATIO = 0.85
ENTANGLED = REPO / "docs/refactor/evidence/review/entangled.json"

# 17 个外部流程（review-attribution.md §1「不属于 review」）。名单文件里有 external 区就用它，
# 没有才从 `review-slice.md` §1 的名单块解析，再解析不出退回这份内置清单并**打印警告**。
EXTERNAL_FLOW_FALLBACK = [
    "finishRunAutoPass", "finishRunLayout", "revertContinuation", "markContinuation",
    "onContinuationKeydown", "loadContinuationReview", "finishRevokeAutoPass", "undoLastCleanup",
    "loadLanguageSummary", "afterCleanupApplied", "advanceContinuation", "openFinishPanel",
    "pausePageThumbnails", "afterContinuationChange", "continuationRemaining", "closeFinishPanel",
    "renderContinuationPanel",
]

# 名单文件的形态（三区），键名允许几种写法；**只认这些，不做模糊匹配**。
ZONES = ("movers", "stays", "external")
ZONE_KEYS = {
    "movers": ("movers", "moves", "to_move"),
    "stays": ("stays", "stay", "remaining"),
    "external": ("external", "externals"),
}
LIST_KEYS = ("items", "list", "functions", "names", "entries")
NAME_KEYS = ("name", "fn", "function")
LINES_KEYS = ("lines", "line_count")
COUNT_KEYS = ("closure_count", "closure_total", "total_count", "total", "count", "functions",
              "函数数", "条数", "闭包总数", "闭包条数", "总数")
LINE_TOTAL_KEYS = ("closure_lines", "total_lines", "闭包行数", "总行数")
HEADER_KEYS = ("header", "口径", "reconcile", "对账", "closure", "totals", "counts", "summary", "meta")
# 分组形态：`{"函数数": {"movers":…, "闭包":…}, "行数": {…}}`
NUMBER_GROUPS_COUNT = ("函数数", "条数", "counts", "functions")
NUMBER_GROUPS_LINES = ("行数", "lines", "line_counts")
CLOSURE_TOTAL_KEYS = ("闭包", "closure", "total", "合计", "总数")

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


def count_function_decls(source: str, name: str) -> int:
    """只认 `function <name>(`（`const x = () =>` 不算——名单是函数名清单）。"""
    return len(re.findall(rf"^\s*(?:async\s+)?function\s+{re.escape(name)}\s*\(", source, re.M))


def module_exports(source: str) -> set[str] | None:
    match = re.search(r"window\.ReviewView\s*=\s*\{(.*?)\n\s*\};", source, re.S)
    if not match:
        return None
    return set(re.findall(r"^\s*([A-Za-z_$][\w$]*)\s*[:,]", match.group(1), re.M))


# ── 名单：读、认形态、对账 ──────────────────────────────────────────────

def _int_or_none(value) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _item_name(item):
    if isinstance(item, str):
        return item
    if isinstance(item, dict):
        for key in NAME_KEYS:
            if isinstance(item.get(key), str):
                return item[key]
    return None


def _item_lines(item) -> int | None:
    if isinstance(item, dict):
        for key in LINES_KEYS:
            value = _int_or_none(item.get(key))
            if value is not None:
                return value
    return None


def _zone_payload(value) -> tuple[list, int | None, int | None]:
    """三区的一个区：可以是数组，也可以是含名单的对象（顺带声明本区 count/lines）。"""
    if isinstance(value, list):
        return value, None, None
    if isinstance(value, dict):
        items: list = []
        for key in LIST_KEYS:
            if isinstance(value.get(key), list):
                items = value[key]
                break
        declared_count = next((_int_or_none(value.get(k)) for k in COUNT_KEYS
                               if _int_or_none(value.get(k)) is not None), None)
        declared_lines = next((_int_or_none(value.get(k)) for k in LINE_TOTAL_KEYS
                               if _int_or_none(value.get(k)) is not None), None)
        return items, declared_count, declared_lines
    return [], None, None


def _blank_manifest(source: str, kind: str) -> dict:
    return {
        "source": source,
        "kind": kind,                 # zones | flat
        "header": [],
        "zones": {zone: [] for zone in ZONES},
        "present": set(),
        "per_zone_decl": {},          # zone -> (count, lines) 本区自报
        "closure_count": None,        # (出处, 值) 文件头声明的闭包条数
        "closure_lines": None,        # (出处, 值) 文件头声明的闭包行数
        "items": {},                  # zone -> [ {name, lines} ]
        "malformed": [],              # 名单自身的问题（缺 name 等）
        "sha256": None,               # 名单文件内容的 sha256（防"读到别人改过的版本"）
    }


def _collect_declarations(node, label: str, acc: dict) -> None:
    """收集文件头声明。认三种形态（Builder 的三区名单用的是后两种）：
    - 平铺 `closure_count: 211` / `closure_lines: 5072`；
    - 分组 `{"函数数": {"movers": 114, …, "闭包": 211}, "行数": {"闭包": 5072, …}}`；
    - 字符串 `{"闭包总数": "211 个 / 5072 行"}`。
    **只认这些明确的键名**，不做模糊匹配（`start`/`end` 那种行号绝不进来）。
    """
    if not isinstance(node, dict):
        return
    for key in COUNT_KEYS:
        value = _int_or_none(node.get(key))
        if value is not None:
            acc["counts"].append((f"{label}{key}", value))
    for key in LINE_TOTAL_KEYS:
        value = _int_or_none(node.get(key))
        if value is not None:
            acc["lines"].append((f"{label}{key}", value))
    for key, value in node.items():
        if isinstance(value, dict):
            if any(word in key for word in NUMBER_GROUPS_COUNT):
                kind = "counts"
            elif any(word in key for word in NUMBER_GROUPS_LINES):
                kind = "lines"
            else:
                continue
            for zone in ZONES:
                for alias in ZONE_KEYS[zone]:
                    number = _int_or_none(value.get(alias))
                    if number is not None:
                        acc[f"zone_{kind}"][zone] = number
                        break
            for total_key in CLOSURE_TOTAL_KEYS:
                number = _int_or_none(value.get(total_key))
                if number is not None:
                    acc[kind].append((f"{label}{key}.{total_key}", number))
                    break
        elif isinstance(value, str) and "闭包" in key:
            match = re.search(r"(\d+)\s*个", value)
            if match:
                acc["counts"].append((f"{label}{key}", int(match.group(1))))
            match = re.search(r"(\d+)\s*行", value)
            if match:
                acc["lines"].append((f"{label}{key}", int(match.group(1))))


def _parse_txt(text: str) -> tuple[dict, list[str]]:
    """`# closure_count: 121` / `# closure_lines: 2975` 这类文件头声明；其余 `#` 行是口径说明。"""
    declared = {"count": None, "lines": None}
    header, names = [], []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#"):
            body = line.lstrip("#").strip()
            match = re.match(r"(closure_count|closure_lines|闭包条数|闭包行数)\s*[:=]\s*(\d+)$", body)
            if match:
                declared["count" if "count" in match.group(1) or "条数" in match.group(1) else "lines"] = \
                    int(match.group(2))
            elif body:
                header.append(body)
            continue
        names.append(line)
    return declared, header


def load_manifest() -> dict:
    """名单从**文件**读（脚本里不抄函数名）。优先三区格式，其次平铺，最后 txt。"""
    data = None
    if MOVERS_JSON.is_file():
        try:
            data = json.loads(MOVERS_JSON.read_text(encoding="utf-8"))
        except json.JSONDecodeError as error:
            prereq(f"{MOVERS_JSON.relative_to(REPO)} 不是合法 JSON：{error}")
    source = str(MOVERS_JSON.relative_to(REPO)) if data is not None else None

    if isinstance(data, dict):
        manifest = _blank_manifest(source, "zones")
        for zone in ZONES:
            for key in ZONE_KEYS[zone]:
                if key in data:
                    items, declared_count, declared_lines = _zone_payload(data[key])
                    manifest["present"].add(zone)
                    manifest["items"][zone] = [
                        {"name": _item_name(item), "lines": _item_lines(item)} for item in items
                    ]
                    manifest["per_zone_decl"][zone] = (declared_count, declared_lines)
                    break
        if manifest["present"]:
            acc = {"counts": [], "lines": [], "zone_counts": {}, "zone_lines": {}}
            _collect_declarations(data, "", acc)
            for key in HEADER_KEYS:
                _collect_declarations(data.get(key), f"{key}.", acc)
            for zone in ZONES:
                payload_count, payload_lines = manifest["per_zone_decl"].get(zone, (None, None))
                manifest["per_zone_decl"][zone] = (
                    acc["zone_counts"].get(zone, payload_count),
                    acc["zone_lines"].get(zone, payload_lines),
                )
            manifest["_count_decls"] = acc["counts"]
            manifest["_line_decls"] = acc["lines"]
            for label, value in acc["counts"]:
                manifest["closure_count"] = manifest["closure_count"] or (label, value)
            for label, value in acc["lines"]:
                manifest["closure_lines"] = manifest["closure_lines"] or (label, value)
            for key in HEADER_KEYS:
                value = data.get(key)
                if isinstance(value, str) and value.strip():
                    manifest["header"].append((key, value.strip()))
                elif isinstance(value, dict):
                    manifest["header"].append((key, value))
            manifest["sha256"] = hashlib.sha256(MOVERS_JSON.read_bytes()).hexdigest()
            return manifest

        prereq("movers.json 是对象，但没有 movers / stays / external 三区——格式不认识"
               "（要么平铺数组，要么三区对象；键名见脚本 ZONE_KEYS）")

    if MOVERS_TXT.is_file():
        declared, header = _parse_txt(MOVERS_TXT.read_text(encoding="utf-8"))
    elif data is not None:
        declared, header = {"count": None, "lines": None}, []
    elif MOVERS_JSON.is_file():
        declared, header = {"count": None, "lines": None}, []
    else:
        prereq(
            "待搬函数名单没有：docs/refactor/evidence/review/movers.txt（或 movers.json）"
            "——从 review-attribution.md 的四栏表生成，脚本里不抄任何函数名",
        )
        return _blank_manifest("", "flat")

    manifest = _blank_manifest(str(MOVERS_TXT.relative_to(REPO)) if MOVERS_TXT.is_file() else str(MOVERS_JSON.relative_to(REPO)), "flat")
    manifest["header"] = [("", line) for line in header]
    if declared["count"] is not None:
        manifest["closure_count"] = ("closure_count", declared["count"])
    if declared["lines"] is not None:
        manifest["closure_lines"] = ("closure_lines", declared["lines"])
    raw_items = data if isinstance(data, list) else None
    if raw_items is None:
        raw_items = MOVERS_TXT.read_text(encoding="utf-8").splitlines()
        raw_items = [line.strip() for line in raw_items if line.strip() and not line.strip().startswith("#")]
    manifest["items"]["movers"] = [
        {"name": _item_name(item), "lines": _item_lines(item)} for item in raw_items
    ]
    manifest["present"] = {"movers"}
    used = MOVERS_TXT if MOVERS_TXT.is_file() else MOVERS_JSON
    manifest["sha256"] = hashlib.sha256(used.read_bytes()).hexdigest() if used.is_file() else None
    return manifest


def _names(manifest: dict, zone: str) -> list[str]:
    return [item["name"] for item in manifest["items"].get(zone, []) if item["name"]]


def print_manifest(manifest: dict) -> None:
    """第一屏：名单来源 + 各区条数 + 文件头口径。验收看的是第一眼。"""
    sha = manifest.get("sha256")
    sha_note = f"；sha256 {sha[:12]}" if sha else ""
    if manifest["kind"] == "zones":
        parts = " / ".join(f"{zone} {len(manifest['items'].get(zone, []))}" for zone in ZONES)
        total = sum(len(manifest["items"].get(zone, [])) for zone in ZONES)
        print(f"名单：{manifest['source']}（三区：{parts}；合计 {total}{sha_note}）")
    else:
        print(f"名单：{manifest['source']}（单列 {len(manifest['items'].get('movers', []))} 个；"
              f"不是三区格式，①② 跳过{sha_note}）")
    for label, value in manifest["header"]:
        if isinstance(value, dict):
            if any(word in label for word in ("对账", "reconcile", "summary")):
                text = json.dumps(value, ensure_ascii=False)
                print(f"口径：{label} = {text if len(text) <= 240 else text[:240] + '…'}")
            else:
                for key, item in value.items():
                    shown = json.dumps(item, ensure_ascii=False) if isinstance(item, (dict, list)) else item
                    print(f"口径：{label}.{key} = {shown}")
        else:
            prefix = f"{label} = " if label else ""
            print(f"口径：{prefix}{value}")
    movers = manifest["items"].get("movers", [])
    mover_lines = sum(item["lines"] for item in movers if item["lines"] is not None)
    if mover_lines:
        print(f"     减量门槛按名单派生：movers {len(movers)} 个 / {mover_lines:,} 行"
              f" → 预期净减 {int(mover_lines * SHRINK_MIN_RATIO):,}..{mover_lines:,}"
              f"（{SHRINK_MIN_RATIO}..1.00；不写死数字）")
    note_entangled(movers)


def note_entangled(movers: list) -> None:
    """entangled：引用 review id、却留在外壳的函数。它们同时决定了「字面量→0」可不可达。"""
    if not ENTANGLED.is_file():
        return
    try:
        data = json.loads(ENTANGLED.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    entries = [entry for entry in data.get("entries") or [] if isinstance(entry, dict)]
    names = {entry.get("name") for entry in entries}
    inside = sorted(name for name in names if name in {item["name"] for item in movers})
    inside_lines = sum(item["lines"] or 0 for item in movers if item["name"] in set(inside))
    print(f"     警示：entangled {len(entries)} 个 / {data.get('lines', 0):,} 行——其中 {len(inside)} 个在 movers 里"
          f"（{inside_lines:,} 行）；纯搬运下 app.js 字面量无法归零，等方向（豁免 / 拆渲染 / 先 UX）")


def manifest_problems(manifest: dict) -> list[str]:
    """①② 三区自洽 + 名单自身形状。返回问题清单（空 = 自洽）。"""
    problems: list[str] = []
    zones = manifest["items"]
    present = manifest["present"]

    # 名单项本身：每个都必须有名字；三区格式每项都必须有行数（否则 ② 没法对账）
    for zone in ZONES:
        items = zones.get(zone, [])
        nameless = sum(1 for item in items if not item["name"])
        if nameless:
            problems.append(f"{zone} 有 {nameless} 项没有 name（名单项必须是字符串或 {{name, lines}}）")
        if manifest["kind"] == "zones":
            no_lines = [item["name"] or "?" for item in items if item["lines"] is None]
            if no_lines:
                shown = "、".join(no_lines[:5]) + ("…" if len(no_lines) > 5 else "")
                problems.append(f"{zone} 有 {len(no_lines)} 项没有行数（需要 {{name, lines}}）：{shown}"
                                f"——行数对账（②）没它成立不了")

    if manifest["kind"] != "zones":
        # 平铺旧格式：没有三区就没有 ①②——只报形状，不假装对过账。
        return problems

    missing = [zone for zone in ZONES if zone not in present]
    if missing:
        problems.append(f"三区不全：缺 {'、'.join(missing)}（三区必须都在，才能判并集与不相交）")
        return problems

    # ①a 两两不相交
    for index, left in enumerate(ZONES):
        for right in ZONES[index + 1:]:
            both = sorted(set(_names(manifest, left)) & set(_names(manifest, right)))
            if both:
                shown = "、".join(both)
                problems.append(f"{left} ∩ {right} 非空，{len(both)} 个同名函数：{shown}")

    # ①b 并集条数 = 文件头声明的闭包条数
    total = sum(len(zones.get(zone, [])) for zone in ZONES)
    count_decls = manifest.get("_count_decls") or ([] if not manifest["closure_count"] else [manifest["closure_count"]])
    values = {value for _, value in count_decls}
    if not count_decls:
        problems.append("文件头没有声明闭包条数（需要 closure_count / 闭包总数；txt 写 `# closure_count: N`）"
                        "——① 没有门框，判不了并集等不等")
    elif len(values) > 1:
        shown = " / ".join(f"{label}={value}" for label, value in count_decls)
        problems.append(f"文件头自相矛盾：闭包条数声明了 {len(values)} 个值（{shown}）")
    elif total not in values:
        label, declared = count_decls[0]
        problems.append(f"三区并集 {total} 个（movers {len(zones['movers'])} + stays {len(zones['stays'])}"
                        f" + external {len(zones['external'])}）≠ 文件头 {label} = {declared}"
                        f"（口径：并集含 external）")

    # ② 行数对账
    all_lines = [item["lines"] for zone in ZONES for item in zones.get(zone, [])]
    line_total = sum(all_lines) if all_lines and all(line is not None for line in all_lines) else None
    line_decls = manifest.get("_line_decls") or ([] if not manifest["closure_lines"] else [manifest["closure_lines"]])
    line_values = {value for _, value in line_decls}
    if line_total is not None:
        if not line_decls:
            problems.append("文件头没有声明闭包行数（需要 closure_lines / 闭包行数；txt 写 `# closure_lines: N`）"
                            "——② 没有门框，判不了行数和")
        elif len(line_values) > 1:
            shown = " / ".join(f"{label}={value}" for label, value in line_decls)
            problems.append(f"文件头自相矛盾：闭包行数声明了 {len(line_values)} 个值（{shown}）")
        elif line_total not in line_values:
            label, declared = line_decls[0]
            problems.append(f"三区行数和 {line_total} ≠ 文件头 {label} = {declared}"
                            f"（口径：行数和含 external）")

    # 本区自报的 count / lines（有就核，没有不编）
    for zone in ZONES:
        declared_count, declared_lines = manifest["per_zone_decl"].get(zone, (None, None))
        if declared_count is not None and declared_count != len(zones.get(zone, [])):
            problems.append(f"{zone} 自报 {declared_count} 个，实际 {len(zones.get(zone, []))} 个")
        if declared_lines is not None:
            zone_lines = [item["lines"] for item in zones.get(zone, [])]
            if zone_lines and all(line is not None for line in zone_lines) \
                    and declared_lines != sum(zone_lines):
                problems.append(f"{zone} 自报 {declared_lines} 行，实际 {sum(zone_lines)} 行")

    # 区内重复
    for zone in ZONES:
        seen: dict[str, int] = {}
        for name in _names(manifest, zone):
            seen[name] = seen.get(name, 0) + 1
        duplicated = sorted(name for name, times in seen.items() if times > 1)
        if duplicated:
            problems.append(f"{zone} 内有重复名：{'、'.join(duplicated)}——重复会让并集与行数都虚高")

    return problems


def status_problems(manifest: dict, app_source: str, module_source: str | None) -> list[str]:
    """③ 每个 movers 名字必须在源码里对得上：app.js `function <name>(` 恰 1 处，或已搬进模块 1 处。"""
    problems: list[str] = []
    for name in _names(manifest, "movers"):
        in_app = count_function_decls(app_source, name)
        in_module = count_function_decls(module_source, name) if module_source else 0
        if in_app > 1:
            problems.append(f"{name} 在 app.js 里 function 声明了 {in_app} 处（应 1 处）")
        elif in_app == 0 and in_module == 0:
            problems.append(f"{name} 在 app.js 里没有 function 声明，{MODULE.name} 里也没有"
                            f"——名单名字对不上源码（写错名，或既没搬也没留）")
        elif in_app == 0 and in_module > 1:
            problems.append(f"{name} 已离开 app.js，但在 {MODULE.name} 里声明了 {in_module} 处（应 1 处）")
    return problems


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


def parse_sha(argv: list[str]) -> str | None:
    """`--expect-sha <sha256>`：名单被重排/换版本时立刻红，而不是拿错名单静默跑完。"""
    for index, arg in enumerate(argv):
        if arg == "--expect-sha" and index + 1 < len(argv):
            return argv[index + 1].strip().lower()
        if arg.startswith("--expect-sha="):
            return arg.split("=", 1)[1].strip().lower()
    return None


def parse_exempt(argv: list[str]) -> set[str]:
    """`--exempt a,b` 或 `--exempt <文件>`：不搬的函数（entangled 等），从预期净减里扣掉。"""
    for index, arg in enumerate(argv):
        if arg == "--exempt" and index + 1 < len(argv):
            raw = argv[index + 1].strip()
        elif arg.startswith("--exempt="):
            raw = arg.split("=", 1)[1].strip()
        else:
            continue
        candidate = Path(raw)
        if candidate.is_file():
            names = {line.strip() for line in candidate.read_text(encoding="utf-8").splitlines()}
        else:
            names = {name.strip() for name in raw.split(",") if name.strip()}
        return {name for name in names if name and not name.startswith("#")}
    return set()


def parse_exports(argv: list[str]) -> set[str] | None:
    for index, arg in enumerate(argv):
        if arg == "--exports" and index + 1 < len(argv):
            return {item.strip() for item in argv[index + 1].split(",") if item.strip()}
        if arg.startswith("--exports="):
            return {item.strip() for item in arg.split("=", 1)[1].split(",") if item.strip()}
    return None


def main(argv: list[str]) -> int:
    manifest = load_manifest()
    print_manifest(manifest)

    expected_sha = parse_sha(argv)
    if expected_sha:
        actual_sha = manifest.get("sha256") or ""
        if actual_sha != expected_sha:
            print("---")
            print(f"[1] 验收失败：名单不是指定的那一版（期望 {expected_sha[:16]}…，实际 {actual_sha[:16] or '?'}…）")
            print("    名单被重排/换版本时，验收必须先红——别拿错名单静默跑完。")
            return EXIT_FAIL

    for path, label in ((APP, "app.js"), (INDEX, "index.html"), (ATTRIBUTION, "review-attribution.md"),
                        (SLICE, "review-slice.md")):
        if not path.is_file():
            prereq(f"找不到 {label}：{path}")

    app_source = APP.read_text(encoding="utf-8")
    module_source = MODULE.read_text(encoding="utf-8") if MODULE.is_file() else None

    # ①② 名单自洽 + ③ 名单对得上源码：任何一条不成立 → exit 1 并点名（不静默放行）
    structural = manifest_problems(manifest)
    status = status_problems(manifest, app_source, module_source)
    if structural or status:
        reason = "名单不自洽" if structural else "名单对不上源码"
        print("---")
        print(f"[1] 验收失败：{len(structural) + len(status)} 条（{reason}）")
        for item in structural + status:
            print(f"    ✗ {item}")
        return EXIT_FAIL

    all_ids = section_ids(INDEX.read_text(encoding="utf-8"), f"view-{VIEW}")
    if not all_ids:
        prereq(f'index.html 里没有 <section id="view-{VIEW}"> 子树——视图还没建，无法验收')
    ids = all_ids - {f"view-{VIEW}"}          # 口径：不含视图根
    if len(ids) != BASELINE_IDS_NO_ROOT:
        print(f"⚠ view-{VIEW} 子树 id：不含根 {len(ids)} 个 / 含根 {len(all_ids)} 个"
              f"（基线 {BASELINE_IDS_NO_ROOT} / {BASELINE_IDS_WITH_ROOT}）——数变了先对账")

    literals = id_literals(app_source, ids)
    refs = len(literals)
    total = sum(literals.values())
    movers = _names(manifest, "movers")

    if module_source is None:
        # 还没落盘：把要归零的数打出来（省得下次重新量），然后 exit 2。
        print(f"  view-{VIEW} 子树 id：不含根 {len(ids)} 个（含根 {len(all_ids)}）")
        print(f"  app.js 仍引用：{refs} 个 id / {total} 处（基线 {BASELINE_REFS} 个 / {BASELINE_LITERALS} 处，目标 0）")
        if manifest["kind"] == "zones":
            print(f"  待搬函数：{len(movers)} 个（名单已自洽：三区对得上文件头声明）")
        else:
            print(f"  待搬函数：{len(movers)} 个（名单是平铺旧格式，①② 未判——等 Builder 出三区）")
        print(f"  {MODULE.name}：不存在")
        prereq(f"{MODULE.name} 还没落盘")

    problems: list[str] = []

    # ① 字面量 → 0（逐 id 点名，别只说"还有残留"）
    print(f"① DOM 字面量：{total} 处（基线 {BASELINE_LITERALS}，目标 0）")
    for element_id, hits in sorted(literals.items()):
        problems.append(f"app.js 仍引用 view-{VIEW} 的 id {element_id}（{hits} 处）")

    # ② 减量：≥2,400（<2,400 = 复制不是搬；>2,650 = 顺手删了别的）
    app_lines = len(app_source.splitlines())
    shrink = BASELINE_APP_LINES - app_lines
    exempt = parse_exempt(argv)
    mover_items = manifest["items"].get("movers", [])   # 带 lines 的那一份（movers 只是名字）
    expected_lines = sum(item["lines"] or 0 for item in mover_items if item["name"] not in exempt)
    exempt_lines = sum(item["lines"] or 0 for item in mover_items if item["name"] in exempt)
    min_shrink = int(expected_lines * SHRINK_MIN_RATIO)
    detail = f"名单 movers {len(movers) - len(exempt)} 个 / {expected_lines:,} 行 × {SHRINK_MIN_RATIO}..1.00"
    if exempt:
        detail += (f"；已扣豁免 {len(exempt)} 个 / {exempt_lines:,} 行"
                   f"（--exempt 目前只影响②减量：⑤/① 仍按全名单判，豁免口径等方向定了再一起改）")
    print(f"② app.js：{app_lines:,} 行（基线 {BASELINE_APP_LINES:,}，已减 {shrink}；"
          f"预期净减 {min_shrink:,}..{expected_lines:,}：{detail}）")
    if shrink < min_shrink:
        problems.append(f"app.js 只减了 {shrink} 行（< {min_shrink}）：名单里还有函数没搬——这是「复制」不是「搬」，停")
    if shrink > expected_lines:
        problems.append(f"app.js 减了 {shrink} 行（> {expected_lines}）：比名单里要搬的还多——顺手删了别的，回退")

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
    if manifest["kind"] == "zones" and _names(manifest, "external"):
        external_flow = _names(manifest, "external")
        print(f"   外部流程来源：{manifest['source']} 的 external 区（{len(external_flow)} 个）")
    else:
        external_flow = load_external_flow()
        print(f"   外部流程来源：review-slice.md §1（{len(external_flow)} 个）")
    wrong = []
    for name in external_flow:
        in_app = count_definitions(app_source, name)
        in_module = count_definitions(module_source, name)
        if in_app != 1 or in_module != 0:
            wrong.append(f"{name}：app.js {in_app} 处、模块 {in_module} 处（应 1 / 0）")
    print(f"④ 外部流程：{len(external_flow) - len(wrong)}/{len(external_flow)} 个仍「外壳 1 / 模块 0」")
    problems.extend(f"边界失守——{item}" for item in wrong)

    # ⑤ 待搬函数：app.js 0 / 模块 1
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
    print("[0] 验收通过：名单自洽 / 字面量 0 / 减量合规 / 导出面精确相等 / 外部流程未越界 / movers 各 1 处")
    return EXIT_OK


if __name__ == "__main__":
    if "--help" in sys.argv or "-h" in sys.argv:
        print(__doc__)
        sys.exit(EXIT_OK)
    sys.exit(main(sys.argv[1:]))
