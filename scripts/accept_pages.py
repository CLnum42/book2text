#!/usr/bin/env python3
"""scripts/accept_pages.py —— `pages` 落盘后的验收（机械部分）。

**验收器先于实现存在**（Chief 2026-10-29）：模块还没写出来时它就该能跑，exit 2 并打出基线数，
这样判据是先钉住的；等生成器改完，它直接判——不是一边做一边现编判据。

口径来源（**脚本不发明数字**）：
- `docs/refactor/evidence/pages/movers.json` —— 名单（movers 63 / stays 67 / external 9 / 闭包 139）；
- `docs/refactor/evidence/pages/rules.py` —— 注入表（IDENT 38）与状态分类（STATES 45，名单 46 = 45 + el）。

## 五条判据

① **名单自洽**：三区并集 = 文件头声明的闭包条数、行数相加 = 闭包行数、两两不相交；
   每个 movers 名字在 app.js **或**模块里恰好 1 处 `function` 声明。
② **DOM 字面量归零**：`view-pages` 子树的 id 在 app.js 里的引用处数 = 0（基线 117）。
③ **状态落地**：46 条按 `rules.py` 的分类处理——
   - 「搬进模块」10 条：**app.js 里的声明必须消失**（`let x =` / `const x =` 一行都不许留）；
   - 其余 35 条：**声明必须还在 app.js**（外壳持有；被顺手删掉 = 模块运行时炸）。
   这一条是这刀最容易错的地方：**两份状态比没搬更坏**。
④ **减量按名单派生**：`app.js` 净减 ∈ [movers 行数 × 0.85, × 1.00]。0.85 的先例是 library 刀
   （17 函数 371 行 → 净减 317 = 85.4%，转发段占了余下部分）。**不写死数**。
⑤ **第三消费者**（`PageTile`）：同页同档 `<img>.src` 赋值 = 1、observer 数 ≤ 6。
   这两个数**只能来自真机/酸测试**，所以从 `--acid <json>` 读；**第 2 刀起**不给就是「未验」→ exit 2
   （刀 1 不是它的前置：PageTile 接线不在刀 1 名单里，已裁定进刀 2；刀号常量 `ACID_REQUIRED_FROM_STAGE`）。
   **不要数网络请求**：`/pages/N/image` 带 `max-age=300`，第二次命中浏览器缓存会把重复取图盖掉。

退出码：`0` 全过 / `1` 验收不过 / `2` 前置不满足（还没落盘、酸测试没给、名单版本判不了）/
`64` 调用方式错（参数不认识）/ `70` **脚本内部异常**（`INTERNAL ERROR:` 开头）。
后两个必须与 `1` 分开：`exit 1 + traceback` 和 `exit 1 + 结论` 在日志里长得一样，修法却一个查产品、一个查工具。
只读、cwd 无关（按脚本自身位置定位仓库）。
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import subprocess
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
APP_REL = "backend/book2text/static/app.js"
REPO = SCRIPT_DIR.parent
STATIC = REPO / "backend/book2text/static"
APP = STATIC / "app.js"
INDEX = STATIC / "index.html"
MODULE = STATIC / "pages-view.js"
RULES = REPO / "docs/refactor/evidence/pages/rules.py"
MANIFEST_JSON = REPO / "docs/refactor/evidence/pages/movers.json"
#: 当前判的那份名单（`--movers` 可换；刀 1 用 stage1-movers.json）
MANIFEST_PATH = MANIFEST_JSON

VIEW = "pages"
#: 基线（2026-10-29 HEAD 实测，**三种口径都打出来，判据只有「归零」**）：
#: - 引号字面量出现处 270 处、涉及 116 个 id；
#: - `el()` / `getElementById()` / `querySelector('#id')` 命中 111 个 id。
#: Chief 转来的「117」按这三种都复现不出来——**不影响判据**（目标是 0），但别把 117 当基线引用。
BASELINE_REFS = {"el": 111, "literal": 116, "occurrences": 270}
#: 净减占比区间：下界来自 library 刀（371 行 → 净减 317 = 85.4%），上界是"不复制"的极限。
SHRINK_LOW, SHRINK_HIGH = 0.85, 1.00
#: `--acid` 的必填四字段。缺一 = 未验（exit 2），不是通过、也不是红。
ACID_FIELDS = ("imgSrcAssignments", "observers", "sameImg", "evidence")
#: `--acid` 从第几刀起必填。刀 1 不是它的前置（PageTile 接线不在刀 1 名单里，已裁定进刀 2），
#: 所以刀 1 允许不给；**刀 2 起缺了就是「未验」→ exit 2**。
#: 这一条不许删（删了第三消费者再也没人验），只准挪这个数。
ACID_REQUIRED_FROM_STAGE = 3   # 2026-10-30：PageTile 未落盘，acid 三探针随 PageTile 单独一刀，刀 3 起强制（stage 2 仍打印不阻断）
PLAN = REPO / "docs/refactor/pages-plan.md"
BOUNDARY_TESTS = REPO / "tests/js/boundary.test.mjs"


def plan_slices() -> list[dict]:
    """从 `pages-plan.md` 的 5 刀表解析（序号 / 操作 / 行数）。**不在这里手抄行数。**"""
    if not PLAN.exists():
        return []
    slices = []
    for line in PLAN.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^\|\s*\*\*(\d)\*\*\s*\|\s*\*\*(.+?)\*\*\s*\|\s*([\d,]+)\s*\|", line)
        if match:
            slices.append({"n": int(match.group(1)), "name": match.group(2), "lines": int(match.group(3).replace(",", ""))})
    return slices


def r3_exemptions() -> tuple[int, int, list[str]]:
    """R3 豁免表现状（条数 / 上限 / 涉及的 id）。计划要求「不新增豁免」。"""
    text = BOUNDARY_TESTS.read_text(encoding="utf-8") if BOUNDARY_TESTS.exists() else ""
    block = re.search(r"const R3_EXEMPTIONS = \[(.*?)\n\];", text, re.S)
    ids = re.findall(r'id:\s*"([^"]+)"', block.group(1)) if block else []
    cap = re.search(r"const R3_MAX_EXEMPTIONS = (\d+)", text)
    return len(ids), int(cap.group(1)) if cap else -1, ids


def run_stage(args, stage_n: int) -> int:
    """按 `pages-plan.md` 的按刀口径判（**5 刀不是一次归零**）。

    计划里写死的只有三件：每刀的行数、R3 的定性期望、以及「少于一半 = 复制不是搬」。
    所以这里**只判得到的东西**：减量下界取自计划、R3 期望取自计划表、豁免只降不升。
    上界计划没给（每刀 movers 归属没列），不自己发明。
    """
    slices = plan_slices()
    spec = next((item for item in slices if item["n"] == stage_n), None)
    if spec is None:
        print(f"[64] 调用方式错（不是验收失败）：pages-plan.md 里没有第 {stage_n} 刀"
              f"（现有 {[item['n'] for item in slices]}）")
        return EXIT_USAGE
    print(f"第 {spec['n']} 刀「{spec['name']}」：计划 {spec['lines']:,} 行（调用者）"
          f"（出处 docs/refactor/pages-plan.md §1；该刀 movers 归属计划未列，所以行数只判调用者列）")

    app_text = APP.read_text(encoding="utf-8") if APP.exists() else ""
    if not app_text or not MODULE.exists():
        print(f"   {MODULE.name}：{'不存在' if not MODULE.exists() else '在'}")
        print(f"[2] 前置不满足：第 {spec['n']} 刀还没落盘")
        return 2

    base = baseline()
    app_lines = len(app_text.split("\n")) - (1 if app_text.endswith("\n") else 0)
    shrink = (base["app_lines"] or 0) - app_lines
    floor = -(-spec["lines"] // 2)   # ceil(50%)：987 → 494（493 仍小于一半，必须红）
    print(f"   减量：app.js {base['app_lines']:,} → {app_lines:,}（净减 {shrink:,}；"
          f"下界 {floor:,} = ceil(计划 {spec['lines']:,} × 50%)，计划原文「少于一半 = 复制不是搬，停」）")

    problems: list[str] = []
    if shrink < floor:
        problems.append(f"第 {spec['n']} 刀净减 {shrink:,} < {floor:,}（计划 {spec['lines']:,} 的一半）"
                        f"——这是「复制」不是「搬」，停")

    ids = section_ids(INDEX.read_text(encoding="utf-8"), f"view-{VIEW}")
    refs, _count = id_literal_count(app_text, ids)
    if stage_n == 5:
        print(f"   R3：view-{VIEW} 字面量 {refs} 处（第 5 刀必须归零）")
        if refs != 0:
            problems.append(f"第 5 刀之后 view-{VIEW} 仍有 {refs} 处字面量——计划要求这一刀归零")
    else:
        print(f"   R3：view-{VIEW} 字面量 {refs} 处（第 {stage_n} 刀：相对基线 {BASELINE_REFS['occurrences']} 处"
              f"要下降、且**不能归零**）")
        if refs == 0:
            problems.append(f"第 {stage_n} 刀之后字面量已归零——与计划不符（其余组还在 app.js 里），先核对口径")
        elif refs >= BASELINE_REFS["occurrences"]:
            problems.append(f"第 {stage_n} 刀之后仍是 {refs} 处，没低于基线 "
                            f"{BASELINE_REFS['occurrences']} 处——这一刀没减到字面量")

    count, cap, exempt_ids = r3_exemptions()
    print(f"   R3 豁免：{count} 条（上限 {cap}；计划要求「不新增豁免」）")
    if cap >= 0 and count > cap:
        problems.append(f"R3 豁免 {count} 条 > 上限 {cap}——计划禁止为过闸新增豁免")
    pages_exempt = [item for item in exempt_ids if item.startswith("pages")]
    if pages_exempt:
        problems.append(f"R3 豁免里出现 pages 的 id：{pages_exempt}——§2 明确「不批只搬接线类靠开豁免过闸」")

    if not args.expect_sha:
        # 报错要能照着做：给出**可直接粘贴**的算法，而不是只说「没给」
        # （2026-10-30：记档命令漏了这个参数，照着跑的人拿到假红去查产品）
        rel = os.path.relpath(MANIFEST, REPO) if "MANIFEST" in globals() else args.movers
        print(f"[2] 前置不满足：第 {stage_n} 刀没给 --expect-sha——每刀必须用**该刀冻结版**名单的 sha，"
              f"否则判的是另一份名单（exit 2 = 未验）。\n"
              f"    怎么给（直接粘贴）：\n"
              f"      --expect-sha \"$(shasum -a 256 {rel} | cut -d' ' -f1)\"")
        return 2
    if args.acid:
        acid_problems = check_acid(args.acid)
        if acid_problems is None:
            return 2
        problems.extend(acid_problems)
    elif stage_n >= ACID_REQUIRED_FROM_STAGE:
        print("[2] 前置不满足：第 %d 刀没给 --acid 实测——从第 %d 刀起第三消费者没验就不算搬完"
              % (stage_n, ACID_REQUIRED_FROM_STAGE))
        return 2

    print("---")
    if problems:
        print(f"[1] 验收失败：{len(problems)} 条")
        for item in problems:
            print(f"    ✗ {item}")
        return 1
    print(f"[0] 第 {spec['n']} 刀通过：减量过下界 / R3 符合该刀期望 / 豁免未增 / 酸测试齐")
    return 0


def check_acid(path_text: str) -> list[str] | None:
    """--acid 四字段校验。返回 None = 未验（调用方 exit 2）；返回 [] / 问题清单 = 验过了。"""
    acid_path = Path(path_text)
    if not acid_path.is_file():
        print(f"[2] 前置不满足：--acid 指向的文件不存在：{acid_path}")
        return None
    acid = json.loads(acid_path.read_text(encoding="utf-8"))
    missing_fields = [name for name in ACID_FIELDS if name not in acid]
    if missing_fields:
        print(f"[2] 前置不满足：--acid 缺字段 {'、'.join(missing_fields)}——"
              f"四个字段（{', '.join(ACID_FIELDS)}）缺一即「未验」，未验 ≠ 通过")
        return None
    writes, observers, same, evidence = (acid["imgSrcAssignments"], acid["observers"],
                                         acid["sameImg"], acid["evidence"])
    if not isinstance(evidence, str) or not evidence.strip():
        print("[2] 前置不满足：--acid 的 evidence 是空的——证据路径都没写，等于没验")
        return None
    evidence_path = Path(evidence)
    if not evidence_path.is_absolute():
        evidence_path = REPO / evidence_path
    if not evidence_path.exists():
        print(f"[2] 前置不满足：--acid 的 evidence 指的文件不存在：{evidence}（未验 ≠ 通过）")
        return None
    print(f"⑤ 第三消费者：img.src 赋值 {writes} 次（须 1）· observer {observers} 个（须 ≤ 6）"
          f"· sameImg={same} · 证据 {evidence}")
    problems = []
    if writes != 1:
        problems.append(f"⑤ 同页同档 img.src 赋值 {writes} 次 ≠ 1——第三个消费者没走 PageTile")
    if not isinstance(observers, int) or observers > 6:
        problems.append(f"⑤ observer {observers} 个 > 6——调度又变成多份")
    if same is not True:
        problems.append(f"⑤ 同页同档取到的不是同一张图（sameImg={same}）——缓存/URL 参数又分叉了")
    return problems


def _sha256(path: Path) -> str:
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _head_bytes(path: Path) -> bytes | None:
    """同名文件在 HEAD 里的内容（不在仓库里 / 没入库 → None）。"""
    try:
        rel = path.resolve().relative_to(REPO)
    except ValueError:
        return None
    try:
        out = subprocess.run(["git", "show", f"HEAD:{rel.as_posix()}"], cwd=REPO,
                             capture_output=True, check=False)
    except OSError:
        return None
    return out.stdout if out.returncode == 0 else None


def check_manifest_version(args) -> int | None:
    """名单版本门。None = 过；返回码 = 直接退出。

    - 给了 `--expect-sha`：**以给定的为准**（对历史版本复跑），不符 → exit 1；
    - 没给：与 **HEAD 里的同名文件**比对（现算两边 sha256）。工作区被改过 → exit 1，
      这挡的正是"名单在消费时被改"（今天因此白跑三轮）。
      判定不了的（不在 HEAD 里，比如指向 /tmp 的副本）→ exit 2（未验），不猜。
    """
    if not MANIFEST_PATH.is_file():
        print(f"[2] 前置不满足：名单不存在：{MANIFEST_PATH}")
        return 2
    actual = _sha256(MANIFEST_PATH)
    if args.expect_sha:
        if not actual.startswith(args.expect_sha.lower()):
            print(f"[1] 验收失败：名单不是指定的那一版（期望 {args.expect_sha[:16]}…，实际 {actual[:16]}…）")
            print("    名单被重排/换版本时验收必须先红——别拿错名单静默跑完。")
            return 1
        print(f"名单：{MANIFEST_PATH.name} · sha256 {actual[:16]}…（显式指定，历史复跑口径）")
        return None
    head = _head_bytes(MANIFEST_PATH)
    if head is None:
        print(f"[2] 前置不满足：{MANIFEST_PATH.name} 不在 HEAD 里，无法自动核对版本——"
              f"历史/外部副本请显式给 --expect-sha <sha>（未验 ≠ 通过）")
        return 2
    head_sha = hashlib.sha256(head).hexdigest()
    if actual != head_sha:
        print(f"[1] 验收失败：名单被改过——工作区 {actual[:16]}… ≠ HEAD {head_sha[:16]}…"
              f"（{MANIFEST_PATH.name}）")
        print("    不给 --expect-sha 时，判据要求名单与 HEAD 一致；确认是有意改动请先提交，")
        print("    要对历史版本复跑请显式给 --expect-sha <那一版的 sha>。")
        return 1
    print(f"名单：{MANIFEST_PATH.name} · sha256 {actual[:16]}…（与 HEAD 一致）")
    return None


def load_rules():
    spec = importlib.util.spec_from_file_location("pages_rules", RULES)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def manifest() -> dict | None:
    if not MANIFEST_PATH.exists():
        return None
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def section_ids(html: str, view: str) -> set[str]:
    """`<section id="view-XXX">` 子树（按 section 深度）里的全部 id，含视图根。"""
    match = re.search(rf'<section\b[^>]*\bid="{re.escape(view)}"[^>]*>', html, re.I)
    if not match:
        raise SystemExit(f'✗ index.html 里没有 <section id="{view}">')
    depth, cursor = 1, match.end()
    for tag in re.finditer(r"<(/?)section\b", html[cursor:], re.I):
        depth += -1 if tag.group(1) else 1
        if depth == 0:
            return set(re.findall(r'\bid="([^"]+)"', html[match.start():cursor + tag.end()]))
    raise SystemExit(f'✗ <section id="{view}"> 没有闭合')


def id_literal_count(app_text: str, ids: set[str]) -> tuple[int, int]:
    """子树 id 在 app.js 里的**出现处数**与涉及的 id 个数（按引号字面量数）。"""
    pattern = re.compile(r'["\'](' + "|".join(sorted(map(re.escape, ids), key=len, reverse=True)) + r')["\']')
    total, hit = 0, set()
    for line in app_text.split("\n"):
        found = pattern.findall(line)
        if found:
            total += len(found)
            hit.update(found)
    return total, len(hit)


def declared_in(text: str, name: str) -> bool:
    """顶层声明存在吗（`function` / `const` / `let` / `var`）。"""
    patterns = [
        rf"^(?:async\s+)?function\s+{re.escape(name)}\s*\(",
        rf"^(?:const|let|var)\s+{re.escape(name)}\s*=",
    ]
    return any(re.search(pattern, text, re.M) for pattern in patterns)


def function_count(text: str, name: str) -> int:
    return len(re.findall(rf"^(?:async\s+)?function\s+{re.escape(name)}\s*\(", text, re.M))


def module_functions(text: str) -> set[str]:
    return set(re.findall(r"^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(", text, re.M))


def _as_dict(value) -> dict:
    """字段可能是 int（按刀名单的 `行数: 1090` / `函数数: 21`）——不是 dict 就当空表，别炸。"""
    return value if isinstance(value, dict) else {}


def baseline() -> dict:
    """基线字段的**两种名单形态**都要认（否则按刀一换名单，减量就变成负数）：

    - 整刀名单 `movers.json`：`口径."app.js 行数"` + `对账.函数数/行数`
    - 按刀名单 `stage1-movers.json`：顶层 `基线_app_js_行数` + `行数.movers` + `函数数`
    """
    data = manifest() or {}
    summary = _as_dict(data.get("对账"))
    counts = _as_dict(summary.get("函数数"))
    lines = _as_dict(summary.get("行数"))
    top_raw = data.get("行数")
    top = _as_dict(top_raw)
    sc = _as_dict(data.get("states_and_consts"))
    # 三种已知名单形态按顺序试；一条都不命中就**主动报错**，绝不许带着 None 往下走到格式化
    # （2026-10-30：stage2-movers.json 用「基线.appLines」这第三种形态，老代码没认，
    #   结果在 `{base['app_lines']:,}` 处抛 TypeError + exit 70——看起来像产品坏了，实际是读的人没跟上。）
    tried = []
    app_lines = (data.get("口径", {}) or {}).get("app.js 行数")
    tried.append('口径."app.js 行数"=' + repr(app_lines))
    if app_lines is None:
        app_lines = data.get("基线_app_js_行数")
        tried.append("基线_app_js_行数=" + repr(app_lines))
    if app_lines is None:
        app_lines = (data.get("基线") or {}).get("appLines")
        tried.append("基线.appLines=" + repr(app_lines))
    if not isinstance(app_lines, int):
        keys = sorted(data.keys())
        sys.exit(f"✗ 名单里读不到基线 app.js 行数：试过 {len(tried)} 种形态都没命中\n"
                 f"   试过的：{'; '.join(tried)}\n"
                 f"   文件顶层键：{keys}\n"
                 f"   → 名单换了新形态就必须在 baseline() 里加一支，且加完跑反证（正/负各一次）。")
    # 交叉核对：名单自称的基线 head + appLines 必须与那棵树的真实行数一致（防「基线抄错」）
    head = (data.get("基线") or {}).get("head")
    if head:
        got = subprocess.run(["git", "show", f"{head}:{APP_REL}"], cwd=REPO,
                             capture_output=True, text=True)
        if got.returncode == 0:
            real = len(got.stdout.split("\n")) - (1 if got.stdout.endswith("\n") else 0)
            if real != app_lines:
                sys.exit(f"✗ 基线自称 appLines={app_lines}，但 `git show {head}:{APP_REL} | wc -l` 是 {real}"
                         f"——基线抄错了，先查名单，别改判据")
    movers_lines = lines.get("movers", top.get("movers"))
    if movers_lines is None and isinstance(top_raw, int):
        movers_lines = top_raw          # 按刀名单把"这一刀的行数"直接写在顶层 `行数`

    movers_count = counts.get("movers")
    if movers_count is None:
        movers_count = len(data.get("movers", []) or [])
    return {
        "closure_count": counts.get("闭包"),
        "closure_lines": lines.get("闭包"),
        "movers": movers_count,
        "movers_lines": movers_lines,
        "states": sc.get("count"),
        "app_lines": app_lines,
    }


#: 调用方式错（参数不认识）用这个码，**不许与 2（未验）混在一起**：
#: `land_pages.sh` 把参数原样透传，多一个自己的 flag 就会走到这里——那时该报"调用方式错"，
#: 而不是"验收器 exit 2（多半是没给 --acid）"。
EXIT_USAGE = 64
#: 脚本内部异常（不是判据不过，也不是用法错）。**必须与 1 分开**：
#: `exit 1 + traceback` 和 `exit 1 + 结论` 在日志里长得一样，而修法完全不同（查产品 vs 查工具）。
EXIT_INTERNAL = 70


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="pages 落盘验收。只收 --acid / --expect-sha；别的参数一律算调用方式错。",
    )
    parser.add_argument("--acid", default="", help="第三消费者的实测 JSON（img.src 赋值次数 / observer 数）")
    parser.add_argument("--movers", default="", help="名单文件（默认 docs/refactor/evidence/pages/movers.json；刀 1 用 stage1-movers.json）")
    parser.add_argument("--expect-sha", default="",
                        help="显式指定名单 sha256 前缀（对历史版本复跑用）；不给则与 HEAD 里的同名文件比对")
    parser.add_argument("--stage", type=int, default=0,
                        help="按 pages-plan.md 的第 N 刀判（1..5）：减量下界 + R3 该刀期望 + 豁免不增")
    parser.add_argument("--slice", dest="stage", type=int,
                        help=argparse.SUPPRESS)   # 别名：第一版叫 --slice，别让旧命令变用法错
    # `land_pages.sh` 的 `"${@:-}"` 在无参数时会传一个**空字符串**进来（实测：POSIX sh 展开成 `[]`）。
    # 空参数永远没有意义，丢掉它，别让它变成 "unrecognized arguments: " 再被误读成"没给 --acid"。
    argv = [arg for arg in argv if arg != ""]
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        if exc.code == 2:
            print("[64] 调用方式错（不是验收失败）：accept_pages.py 只收 --acid / --expect-sha"
                  f"——收到的是 {' '.join(argv) or '（空）'}")
            print("     先修调用方（land_pages.sh 把参数原样透传），别去查产品。")
            return EXIT_USAGE
        raise

    # 名单版本校验放最前：**整刀与按刀都必须核**，否则按刀判的是另一份名单。
    global MANIFEST_PATH
    if args.movers:
        MANIFEST_PATH = Path(args.movers).resolve()
        if not MANIFEST_PATH.is_file():
            print(f"[2] 前置不满足：--movers 指向的文件不存在：{args.movers}")
            return 2
    sha_exit = check_manifest_version(args)
    if sha_exit is not None:
        return sha_exit

    if args.stage:
        return run_stage(args, args.stage)

    base = baseline()
    rules = load_rules()
    problems: list[str] = []
    pending: list[str] = []

    print(f"baseline：闭包 {base['closure_count']} 个 / {base['closure_lines']:,} 行 · "
          f"movers {base['movers']} 个 / {base['movers_lines']:,} 行 · "
          f"states_and_consts {base['states']} · app.js {base['app_lines']:,} 行")

    if not MANIFEST_JSON.exists():
        print(f"[2] 前置不满足：找不到名单 {MANIFEST_JSON.relative_to(REPO)}")
        return 2
    # ① 名单自洽
    data = manifest()
    zones = {z: {x["name"]: x for x in data.get(z, [])} for z in ("movers", "stays", "external")}
    total = sum(len(v) for v in zones.values())
    total_lines = sum(x["lines"] for v in zones.values() for x in v.values())
    if total != base["closure_count"]:
        problems.append(f"① 三区合计 {total} ≠ 文件头闭包 {base['closure_count']}——名单自洽失败")
    if total_lines != base["closure_lines"]:
        problems.append(f"① 三区行数合计 {total_lines:,} ≠ 文件头闭包 {base['closure_lines']:,}")
    for a in zones:
        for b in zones:
            if a < b and set(zones[a]) & set(zones[b]):
                problems.append(f"① {a} 与 {b} 有交集：{sorted(set(zones[a]) & set(zones[b]))[:3]}")

    app_text = APP.read_text(encoding="utf-8") if APP.exists() else ""
    if not app_text:
        print(f"[2] 前置不满足：找不到 {APP.relative_to(REPO)}")
        return 2
    module_exists = MODULE.exists()
    module_text = MODULE.read_text(encoding="utf-8") if module_exists else ""
    module_names = module_functions(module_text) if module_exists else set()

    # ② DOM 字面量
    ids = section_ids(INDEX.read_text(encoding="utf-8"), f"view-{VIEW}")
    refs, id_count = id_literal_count(app_text, ids)
    by_el = {name for name in re.findall(r'\bel\(\s*["\']([a-z0-9-]+)["\']', app_text) if name in ids}
    by_gid = {name for name in re.findall(r'\bgetElementById\(\s*["\']([a-z0-9-]+)["\']', app_text) if name in ids}
    by_qs = {name for name in re.findall(r'\bquerySelector(?:All)?\(\s*["\']#([a-z0-9-]+)', app_text) if name in ids}
    print(f"② view-{VIEW} 子树：id {len(ids)} 个（含根）· app.js 仍引用 {id_count} 个 / {refs} 处"
          f"（基线：el/qs 命中 {BASELINE_REFS['el']} 个 · 字面量 {BASELINE_REFS['literal']} 个 / "
          f"{BASELINE_REFS['occurrences']} 处；目标 0）")
    print(f"   现在：el() {len(by_el)} 个 · getElementById {len(by_gid)} 个 · querySelector {len(by_qs)} 个")
    if refs != 0 and module_exists:
        problems.append(f"② app.js 里仍有 {refs} 处 view-{VIEW} 的 id 字面量（目标 0）")

    # ③ movers：模块 1 / app.js 0
    misplaced = []
    for name in zones["movers"]:
        in_app = function_count(app_text, name)
        in_mod = 1 if name in module_names else 0
        if module_exists and (in_mod != 1 or in_app != 0):
            misplaced.append(f"{name}（模块 {in_mod} / app.js {in_app}）")
        elif not module_exists and in_app != 1:
            misplaced.append(f"{name}（app.js {in_app} 处声明，应为 1）")
    if misplaced and module_exists:
        problems.append(f"③ movers 落位不对 {len(misplaced)} 个：{'、'.join(misplaced[:5])}")

    # ④ 状态分类落地（两份状态比没搬更坏）
    app_lines = len(app_text.split("\n")) - (1 if app_text.endswith("\n") else 0)
    moved, kept, bad = 0, 0, []
    for name, kind, _writes, _by, action in rules.STATES:
        still = declared_in(app_text, name)
        if action == "搬进模块":
            moved += 1
            if still:
                bad.append(f"{name} 判「搬进模块」，但 app.js 里声明还在——两份状态")
        else:
            kept += 1
            if not still:
                bad.append(f"{name} 判「{action}」，但 app.js 里声明没了——模块会 ReferenceError")
    for name, _expr, _form in rules.IDENT:
        if not declared_in(app_text, name):
            bad.append(f"{name} 是注入函数，但 app.js 里没有声明")
    if bad and module_exists:
        problems.extend(f"④ {item}" for item in bad)
    print(f"③ 状态：46 条 =「搬进模块」{moved}（app.js 声明须消失）+「外壳持有/只读/const」{kept}"
          f"（声明须还在）+ el 在 IDENT · 违例 {len(bad)}")

    # ⑤ 减量（按名单派生）
    shrink = (base["app_lines"] or 0) - app_lines
    low = int((base["movers_lines"] or 0) * SHRINK_LOW)
    high = int((base["movers_lines"] or 0) * SHRINK_HIGH)
    print(f"④ 减量：app.js {base['app_lines']:,} → {app_lines:,}（净减 {shrink:,}；"
          f"门槛 {low:,}..{high:,} = movers 行数 × {SHRINK_LOW}..{SHRINK_HIGH}）")
    if module_exists and not low <= shrink <= high:
        problems.append(
            f"④ 净减 {shrink:,} 不在 {low:,}..{high:,}——这是「复制」不是「搬」"
            f"（门槛 = movers 行数 × {SHRINK_LOW}..{SHRINK_HIGH}，转发段会让净减少一点，但不会少这么多）",
        )

    # ⑥ 第三消费者（只能来自实测）
    if not args.acid:
        pending.append("⑤ 第三消费者没给实测（--acid <json>：{imgSrcAssignments, observers, sameImg, evidence}）"
                       "——这条不判就等于没验")
    else:
        acid_problems = check_acid(args.acid)
        if acid_problems is None:
            return 2
        problems.extend(acid_problems)

    if not module_exists:
        # 落盘前的预检：名单错、名单与源码对不上，此刻就该红——否则落盘那天红的是「名单错」，
        # 会被误读成「搬错了」，等于验收器自己骗人。
        for name in misplaced:
            problems.append(f"③ 名单里的 {name}")
        print(f"   {MODULE.name}：不存在（还没落盘）")
        print("---")
        if problems:
            print(f"[1] 验收失败：{len(problems)} 条（落盘前预检：名单自洽 / 名单与 app.js 对不上）")
            for item in problems:
                print(f"    ✗ {item}")
            return 1
        print("[2] 前置不满足：模块还没写出来——上面是基线，落盘后直接判。")
        return 2
    print("---")
    if problems:
        print(f"[1] 验收失败：{len(problems)} 条")
        for item in problems:
            print(f"    ✗ {item}")
        return 1
    if pending:
        print("[2] 前置不满足（不是失败，是还没到能判的时候）：")
        for item in pending:
            print(f"    … {item}")
        return 2
    print("[0] 全过")
    return 0


def _run_guarded() -> int:
    """main() 的输出先攒着：**崩溃时 `INTERNAL ERROR:` 必须是首行**（前面不留半截读数）。"""
    import io
    import traceback
    buffer = io.StringIO()
    real_stdout = sys.stdout
    sys.stdout = buffer
    try:
        code = main(sys.argv[1:])
    except SystemExit:
        raise
    except Exception as exc:                      # noqa: BLE001 —— 这里就是要兜住一切
        sys.stdout = real_stdout
        frame = traceback.extract_tb(exc.__traceback__)[-1]
        print(f"INTERNAL ERROR: {type(exc).__name__} at {frame.filename}:{frame.lineno} in {frame.name}")
        print(f"INTERNAL ERROR: {exc}")
        print("  → 这是**脚本自己坏了**，不是判据不过：先修工具，别去查产品。")
        print("— 崩溃前的输出 —")
        print(buffer.getvalue().rstrip())
        return EXIT_INTERNAL
    finally:
        sys.stdout = real_stdout
    print(buffer.getvalue(), end="")
    return code


if __name__ == "__main__":
    sys.exit(_run_guarded())
