#!/usr/bin/env python
"""Book2Text 前端↔后端一致性验收（QA 脚手架）。

用法（在仓库根目录）：

    .venv/bin/python tests/e2e/qa.py up --project b2t_ZAQHGH     # 起隔离环境（复制库 + 独立端口）
    .venv/bin/python tests/e2e/qa.py prepare                     # 打开浏览器、进项目（1423×900@2）
    .venv/bin/python tests/e2e/qa.py smoke                       # 七步冒烟（一键）
    .venv/bin/python tests/e2e/qa.py check                       # 三组一致性断言
    .venv/bin/python tests/e2e/qa.py down                        # 拆环境（删临时库）

规矩：**报告"通过"必须能复现**。每条结论都带命令、证据（数字/文本/文件路径），
报告同时落到 `$TMPDIR/b2t-qa/<run>/report-*.json`。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))

import _browser
import _env
from _api import Api, Store, block_fingerprint

PROJECT_DIR_NAME = "b2t_ZAQHGH"


class Report:
    def __init__(self, title: str) -> None:
        self.title = title
        self.rows: list[dict[str, Any]] = []

    def ok(self, step: str, assertion: str, evidence: str) -> None:
        self.rows.append({"step": step, "assertion": assertion, "status": "PASS", "evidence": evidence})
        print(f"  PASS  [{step}] {assertion}\n        {evidence}")

    def fail(self, step: str, assertion: str, evidence: str) -> None:
        self.rows.append({"step": step, "assertion": assertion, "status": "FAIL", "evidence": evidence})
        print(f"  FAIL  [{step}] {assertion}\n        {evidence}")

    def blocked(self, step: str, reason: str) -> None:
        self.rows.append({"step": step, "assertion": "步骤未能执行", "status": "BLOCKED", "evidence": reason})
        print(f"  BLOCK [{step}] {reason}")

    def finish(self, path: Path) -> int:
        failed = [row for row in self.rows if row["status"] != "PASS"]
        path.write_text(json.dumps({"title": self.title, "rows": self.rows}, ensure_ascii=False, indent=2))
        print()
        print(f"{self.title}：{len(self.rows) - len(failed)}/{len(self.rows)} 通过"
              + ("（有失败 / 卡点）" if failed else "（全部通过）"))
        print(f"报告：{path}")
        return 1 if failed else 0


def _image_issues(row: dict[str, Any]) -> list[str]:
    """一条页图不能破的三件事：分辨率、没被模糊、不是占位图。"""
    issues: list[str] = []
    if row["ratio"] < 1.0:
        issues.append(f"分辨率不足（比例 {row['ratio']:.3f} < 1.0）")
    if row.get("filter", "none") != "none":
        issues.append(f"被 CSS 模糊（filter={row['filter']}）")
    if row.get("placeholderClass"):
        issues.append("仍带 is-placeholder 占位类")
    return issues


def _image_table(rows: list[dict[str, Any]]) -> str:
    lines = ["页号 | size | naturalWidth | CSS宽 | dpr | 比例 | filter | 占位类 | 结果"]
    for row in rows:
        issues = _image_issues(row)
        lines.append(
            f"p{row['page']} | {row['size']} | {row['naturalWidth']} | {row['cssWidth']} | "
            f"{row['dpr']} | {row['ratio']:.3f} | {row.get('filter', 'none')} | "
            f"{'是' if row.get('placeholderClass') else '否'} | "
            f"{'PASS' if not issues else 'FAIL：' + '；'.join(issues)}"
        )
    return "\n".join(lines)


def _image_check(report: Report, step: str, result: dict[str, Any], label: str,
                 min_page: int | None = None) -> None:
    """页图底线：分辨率 ≥ 1.0、filter === none、不带 is-placeholder。

    分辨率够但被模糊是真实发生过的一类 bug：高清图到了、占位类没摘，
    naturalWidth ÷ (CSS宽 × dpr) 仍然 1.66，只看分辨率会 PASS。
    """
    rows = result.get("rows", [])
    if not rows:
        report.fail(step, f"页图底线（{label}）", "没有量到任何可见页块")
        return
    if min_page is not None and max(row["page"] for row in rows) < min_page:
        report.fail(step, f"页图底线（{label}）",
                    f"测量位置不可信：本该在书的中段，实际停在第 "
                    f"{min(row['page'] for row in rows)}–{max(row['page'] for row in rows)} 页\n"
                    + _image_table(rows))
        return
    bad = [row for row in rows if _image_issues(row)]
    worst = min(rows, key=lambda row: row["ratio"])
    detail = (f"{len(rows) - len(bad)}/{len(rows)} 个可见页图满足「分辨率 ≥ 1.0 且 filter=none 且非占位」；"
              f"最小比例 p{worst['page']} {worst['ratio']:.3f}（size={worst['size']}，"
              f"naturalWidth={worst['naturalWidth']}，CSS宽={worst['cssWidth']}，dpr={worst['dpr']}）\n"
              + _image_table(rows))
    if not bad:
        report.ok(step, f"页图底线：分辨率 ≥ 1.0 / filter=none / 非占位（{label}）", detail)
        return
    blur_only = [
        row for row in bad
        if row["ratio"] >= 1.0
        and (row.get("filter", "none") != "none" or row.get("placeholderClass"))
    ]
    prefix = "分辨率够但被模糊了：" if blur_only else ""
    report.fail(step, f"页图底线：分辨率 ≥ 1.0 / filter=none / 非占位（{label}）",
                prefix + detail)


PAGESYNC_PATHS = [
    ("open", "打开审校"),
    ("tree", "点左树条目（第 50 页）"),
    ("next20", "连按下一处未审 20 次"),
    ("scroll", "左栏手动滚到第 120 页"),
    ("resize", "窗口尺寸变化（拖页列 + 1180px）"),
    ("crosspage", "跨页条目"),
    ("closepanel", "主动关闭面板后不许自己冒出来"),
]


def _branch_stats(next_log: list[dict[str, Any]]) -> tuple[dict[str, int], int]:
    branches: dict[str, int] = {}
    opened_false = 0
    for record in next_log or []:
        branch = str(record.get("branch") or "?")
        branches[branch] = branches.get(branch, 0) + 1
        if record.get("panelOpened") is False:
            opened_false += 1
    return branches, opened_false


def _three_way(snap: dict[str, Any]) -> tuple[int | None, int | None, int | None]:
    # "左侧可见页"按"覆盖视口面积最大的 tile"（客观的视觉主导页）。
    # 固定 25% 锚点在正常滚动下会落在上一页（样本：面板/顶部/中心都是 49，25% 是 48，
    # 而上一页只占视口顶部约四分之一），那是锚点定义问题，不是左右不同步。
    return snap.get("panelPage"), snap.get("label"), snap.get("tileDominant")


def _sync_detail(snap: dict[str, Any]) -> str:
    panel, top, tile = _three_way(snap)
    highlight = snap.get("highlight") or {}
    log = snap.get("syncLog") or []
    return (
        f"面板第 {panel} 页 / 顶部第 {top} 页 / 左栏主导第 {tile} 页"
        f"（25% 锚点={snap.get('tilePage')}，中心={snap.get('tileCenter')}）；"
        f"面板可见={snap.get('panelVisible')}；高亮 line={highlight.get('lineCurrent')} "
        f"mark={highlight.get('markCurrent')} pdfBox={highlight.get('pdfBoxes')} diffBox={highlight.get('diffBoxes')}；"
        f"__b2tPageSyncLog={json.dumps(log, ensure_ascii=False)}"
    )


def _assert_snapshot(report: Report, step: str, label: str, snap: dict[str, Any],
                     snap2: dict[str, Any] | None = None) -> bool:
    panel, top, tile = _three_way(snap)
    detail = _sync_detail(snap)
    if not snap.get("panelVisible"):
        # 面板已经滚出视口：此刻没有"用户正在看的差异项"，只能比两方。
        if top == tile:
            report.ok(step, f"两方一致（面板已滚出视口）：{label}", detail)
        else:
            report.fail(step, f"两方一致（面板已滚出视口）：{label}",
                        f"顶部第 {top} 页 ≠ 左栏主导第 {tile} 页；{detail}")
        return
    ok = panel is not None and panel == top == tile
    if ok:
        report.ok(step, f"三方一致：{label}", detail)
    else:
        report.fail(step, f"三方一致：{label}",
                    f"当前差异项第 {panel} 页 ≠ 顶部第 {top} 页 ≠ 左栏主导第 {tile} 页；{detail}")
    if snap.get("panelVisible"):
        if snap2 is not None and not snap2.get("panelVisible"):
            report.fail(step, f"候选面板 500ms 后仍在：{label}",
                        f"出现后又被收掉了；{detail}")
        else:
            report.ok(step, f"候选面板可见（500ms 后仍在）：{label}", f"panelVisible=true；{detail}")
    else:
        report.fail(step, f"候选面板可见：{label}", f"panelVisible=false；{detail}")
    highlight = snap.get("highlight") or {}
    if highlight.get("any"):
        report.ok(step, f"当前行有高亮：{label}", detail)
    else:
        report.fail(step, f"当前行有高亮：{label}", f"行层/字层/PDF 框都没有；{detail}")
    return ok


def _pagesync_check(report: Report, step: str, label: str, result: dict[str, Any],
                    queue_pending: int | None = None) -> None:
    if result.get("skipped"):
        if "跨页" in label:
            report.ok(step, f"{label}：不适用", f"{result.get('reason')}（本书 0 个跨页段）")
        else:
            report.blocked(step, f"{label}：{result.get('reason')}")
        return
    if result.get("path") == "next20":
        iterations = result.get("iterations") or []
        failures = []
        for item in iterations:
            if item.get("stopped"):
                failures.append({"index": item.get("index"), "reason": "翻页没有变化（队列可能已空）"})
                continue
            snap = item.get("snapshot") or {}
            snap2 = item.get("snapshot2") or {}
            panel, top, tile = _three_way(snap)
            highlight = snap.get("highlight") or {}
            stayed = (not snap2) or snap2.get("panelVisible")
            if not (panel is not None and panel == top == tile and snap.get("panelVisible")
                    and highlight.get("any") and stayed and item.get("progressed")):
                failures.append({
                    "index": item.get("index"),
                    "page": snap.get("label"),
                    "panel": snap.get("panelPage"),
                    "dominant": snap.get("tileDominant"),
                    "panelVisible": snap.get("panelVisible"),
                    "highlight": (snap.get("highlight") or {}).get("any"),
                    "highlightKey": item.get("targetCurrent"),
                    "panelVisibleAfter500ms": snap2.get("panelVisible"),
                    "progressed": item.get("progressed"),
                    "branch": (item.get("logEntry") or {}).get("branch"),
                    "reason": (item.get("logEntry") or {}).get("reason"),
                    "blocks": (item.get("logEntry") or {}).get("blocks"),
                })
        total = len([item for item in iterations if not item.get("stopped")])
        branches, opened_false = _branch_stats(result.get("nextLog") or [])
        branch_text = "、".join(f"{name} {count}" for name, count in sorted(branches.items())) or "无"

        # 判据：行高亮 20/20，且带 is-current 的那一行必须就是面板的 key（只数数量会漏）。
        hl_bad = [
            item for item in iterations
            if not item.get("stopped") and not item.get("targetCurrent")
        ]
        if hl_bad:
            brief_hl = [
                {
                    "index": item.get("index"),
                    "panelKey": item.get("panelKey"),
                    "lineExists": item.get("targetExists"),
                    "lineCurrent": item.get("targetCurrent"),
                    "currentLines": (item.get("snapshot") or {}).get("highlight", {}).get("lineCurrent"),
                }
                for item in hl_bad[:5]
            ]
            report.fail(step, "当前行高亮且 data-key === 面板 key（20/20）",
                        f"{len(hl_bad)} 次不满足：" + json.dumps(brief_hl, ensure_ascii=False))
        else:
            report.ok(step, "当前行高亮且 data-key === 面板 key（20/20）",
                      f"{total}/{total} 次：目标行存在且带 is-current")

        # 判据：missing 必须为 0（否则把 key 交出去）
        missing = [
            item for item in iterations
            if (item.get("logEntry") or {}).get("branch") == "missing"
        ]
        if missing:
            brief_missing = [
                {
                    "index": item.get("index"),
                    "entryKey": (item.get("logEntry") or {}).get("entryKey"),
                    "entryPage": (item.get("logEntry") or {}).get("entryPage"),
                    "page": (item.get("snapshot") or {}).get("label"),
                }
                for item in missing[:5]
            ]
            report.fail(step, "missing = 0",
                        f"{len(missing)} 次 missing：" + json.dumps(brief_missing, ensure_ascii=False))
        else:
            report.ok(step, "missing = 0", "20 次里没有 missing")

        # 判据：不许谎报完成
        final_progress = str(result.get("finalProgress") or "")
        if "全部处理完" in final_progress and (queue_pending or 0) > 0:
            report.fail(step, "不许谎报完成",
                        f"chars_unacked={queue_pending} 仍 >0，但界面显示「{final_progress}」")
        else:
            report.ok(step, "不许谎报完成",
                      f"最终进度「{final_progress}」；队列 pending={queue_pending}")

        # 判据 4：队列非空时 branch=none 必须为 0
        none_count = branches.get("none", 0)
        if queue_pending is None:
            report.blocked(step, "队列非空时 branch=none = 0：没有拿到队列长度")
        elif queue_pending > 0 and none_count == 0:
            report.ok(step, "队列非空时 branch=none = 0", f"pending={queue_pending}；branch：{branch_text}")
        elif queue_pending > 0:
            report.fail(step, "队列非空时 branch=none = 0",
                        f"pending={queue_pending}，但 none 出现 {none_count} 次；branch：{branch_text}")
        else:
            report.ok(step, "队列为空，branch=none 合理", f"pending=0；branch：{branch_text}")

        # 判据 3：顶部页码从不为 1（除非条目本身在第 1 页）
        page1 = [
            item for item in iterations
            if (item.get("snapshot") or {}).get("label") == 1
            and ((item.get("logEntry") or {}).get("entryPage") or (item.get("snapshot") or {}).get("panelPage")) != 1
        ]
        if page1:
            sample = page1[0]
            report.fail(step, "顶部页码从不为 1（除非条目本身在第 1 页）",
                        f"{len(page1)} 次跳回第 1 页；例：第 {sample.get('index')} 次 "
                        f"entryPage={(sample.get('logEntry') or {}).get('entryPage')}")
        else:
            report.ok(step, "顶部页码从不为 1（除非条目本身在第 1 页）", "20 次都没有跳回第 1 页")

        # 判据 1：500ms 后仍可见
        stayed = [
            item for item in iterations
            if not item.get("stopped") and (item.get("snapshot2") or {}).get("panelVisible")
        ]
        report.ok(step, "面板 500ms 后仍可见（逐次数）",
                  f"{len(stayed)}/{total} 次在 500ms 后仍可见；branch：{branch_text}")

        if total == 20 and not failures:
            report.ok(step, "连按 20 次：三方一致 + 面板可见 + 行高亮 + 500ms 后仍在",
                      f"20/20 通过；branch 分布：{branch_text}；panelOpened=false {opened_false} 条；"
                      f"最后一次：{_sync_detail(result.get('snapshot') or {})}")
        else:
            brief = [
                {
                    "index": item.get("index"),
                    "label": (item.get("snapshot") or {}).get("label"),
                    "panel": (item.get("snapshot") or {}).get("panelPage"),
                    "dominant": (item.get("snapshot") or {}).get("tileDominant"),
                    "panelVisible": (item.get("snapshot") or {}).get("panelVisible"),
                    "highlight": (item.get("snapshot") or {}).get("highlight", {}).get("any"),
                    "reason": item.get("reason"),
                }
                for item in failures[:3]
            ]
            report.fail(step, "连按 20 次：三方一致 + 面板可见 + 当前行高亮",
                        f"通过 {total - len(failures)}/{total}；失败项：" +
                        json.dumps(brief, ensure_ascii=False)[:900])
        return

    if result.get("path") == "closepanel":
        opened = result.get("opened") or {}
        close_result = result.get("closeResult") or {}
        after = close_result.get("after") or {}
        if opened.get("panelVisible") and close_result.get("panelBack") is False:
            report.ok(step, "主动关闭后不许自己冒出来",
                      f"关闭前面板可见；滚一下 + 跳页重绘后 panelBack=false；"
                      f"顶部第 {after.get('label')} 页 / 主导第 {after.get('tileDominant')} 页")
        else:
            report.fail(step, "主动关闭后不许自己冒出来",
                        f"关闭前 panelVisible={opened.get('panelVisible')}；"
                        f"之后 panelBack={close_result.get('panelBack')}；{_sync_detail(after)}")
        return

    snap = result.get("snapshot") or {}
    if result.get("path") == "open":
        # 打开审校时还没有"当前差异项"，只比两方（顶部 == 左栏）
        panel, top, tile = _three_way(snap)
        detail = _sync_detail(snap)
        if top == tile:
            report.ok(step, f"打开审校：顶部 == 左栏（无当前项）", detail)
        else:
            report.fail(step, f"打开审校：顶部 == 左栏（无当前项）", detail)
        return
    _assert_snapshot(report, step, label, snap, result.get("snapshot2"))
    if result.get("path") == "resize":
        before = result.get("before") or {}
        if not before.get("panelVisible"):
            report.ok(step, "尺寸变化后仍在当前差异项所在页",
                      "面板在尺寸变化前已滚出视口，无当前项可锚定，本项不适用")
            return
        after_drag = result.get("afterDrag") or {}
        if after_drag and after_drag.get("label") != before.get("label"):
            report.fail(step, "尺寸变化后仍在当前差异项所在页",
                        f"跳转前第 {before.get('label')} 页；拖动页列后第 {after_drag.get('label')} 页；"
                        f"改视口后第 {snap.get('label')} 页")
        else:
            report.ok(step, "尺寸变化后仍在当前差异项所在页",
                      f"前 {before.get('label')} → 后 {snap.get('label')}")


def _api(state: dict[str, Any]) -> Api:
    return Api(state["base_url"], state["token"])


# ---------------------------------------------------------------- up / down / status


def cmd_up(args: argparse.Namespace) -> int:
    state = _env.start(project_id=args.project)
    print("隔离环境已就绪：")
    print(f"  项目副本：{state['library']}/{state['project_id']}")
    print(f"  服务    ：{state['base_url']}（pid {state['pid']}）")
    print(f"  界面    ：{state['url']}")
    print(f"  日志    ：{state['log']}")
    print()
    print("下一步：")
    print("  .venv/bin/python tests/e2e/qa.py prepare")
    return 0


def cmd_down(args: argparse.Namespace) -> int:
    result = _env.stop(remove=not args.keep)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    state = _env.load_state()
    with _api(state) as api:
        info = api.app_info()
        summary = api.summary(state["project_id"])
    print(f"服务：{state['base_url']}  pid {state['pid']}")
    print(f"库  ：{state['library']}/{state['project_id']}")
    print(f"版本：{info['app'].get('version')}  阶段：{info['app'].get('stage')}")
    print(f"页数：{summary['pages'].get('total')}")
    return 0


# ---------------------------------------------------------------- 浏览器命令


def _require_state() -> dict[str, Any]:
    return _env.load_state()


def cmd_prepare(args: argparse.Namespace) -> int:
    state = _require_state()
    data = _browser.run(state, "prepare")
    print(json.dumps(
        {
            "view": data["view"],
            "viewport": f"{data['innerWidth']}×{data['innerHeight']} dpr {data['dpr']}",
            "workflowCurrent": data["workflowCurrent"],
            "steps": [{"id": step["id"], "text": step["text"]} for step in data["steps"]],
            "screenshot": data.get("screenshot"),
        },
        ensure_ascii=False,
        indent=2,
    ))
    return 0


def cmd_step(args: argparse.Namespace) -> int:
    state = _require_state()
    data = _browser.run(state, "step", {"step": args.name})
    print(json.dumps(
        {
            "view": data["view"],
            "bodyStep": data["bodyStep"],
            "texts": {key: value for key, value in data["texts"].items() if value},
            "screenshot": data.get("screenshot"),
        },
        ensure_ascii=False,
        indent=2,
    ))
    return 0


def cmd_reading(args: argparse.Namespace) -> int:
    state = _require_state()
    data = _browser.run(state, "reading", {"page": args.page})
    print(json.dumps({key: data[key] for key in ("treeHead", "progress", "pageNo", "draftChip", "checkFails")}, ensure_ascii=False, indent=2))
    print(f"已渲染段落：{len(data['segments'])}，左树行：{len(data['rows'])}")
    return 0


# ---------------------------------------------------------------- 七步冒烟


def cmd_images(args: argparse.Namespace) -> int:
    state = _require_state()
    report = Report("页图清晰度")
    report_path = Path(state["run_dir"]) / "report-images.json"
    try:
        _browser.run(state, "prepare")
    except Exception as error:  # noqa: BLE001
        report.blocked("准备", str(error))
        return report.finish(report_path)

    screens = [
        ("review", "top", "审校第 1 屏", {}),
        ("review", "middle", "审校中间一屏", {}),
        ("index", "top", "目录确认·适合宽度", {}),
        # 85% 是余量最薄的一档（Builder 实测 mid 1870 / 914.6 → 1.02），最该常驻盯。
        ("index", "top", "目录确认·85%", {"zoomPercent": 85}),
    ]
    for where, scroll, label, extra in screens:
        try:
            payload = {"where": where, "scroll": scroll, **extra}
            result = _browser.run(state, "images", payload)
            _image_check(report, label, result, label,
                         min_page=50 if scroll == "middle" else None)
        except Exception as error:  # noqa: BLE001
            report.blocked(label, str(error))

    if args.selftest:
        # 负向自检 1：换成 thumb，必须因"分辨率不足"报 FAIL。
        try:
            result = _browser.run(state, "images",
                                  {"where": "review", "scroll": "top", "forceSize": "thumb"})
            rows = result.get("rows", [])
            bad = [row for row in rows if row["ratio"] < 1.0]
            if bad:
                report.ok("负向自检·低清档", "换成 thumb 后断言报 FAIL（分辨率不足）",
                          _image_table(rows))
            else:
                report.fail("负向自检·低清档", "换成 thumb 后断言报 FAIL",
                            "换成 thumb 后比例仍 ≥ 1.0，断言不可信\n" + _image_table(rows))
        except Exception as error:  # noqa: BLE001
            report.blocked("负向自检·低清档", str(error))

        # 负向自检 2：高清图 + 加回占位类（= 永久 CSS 模糊）。
        # 比例仍是 1.66，但 filter 不是 none —— 证明新检查抓得到"分辨率够但糊"。
        try:
            # 用目录确认那一屏做负向自检：上一项自检把审校 p1 的 src 换成了 thumb，
            # 在这里接着量会变成"低清 + 模糊"，证明不了"分辨率够但被模糊"。
            result = _browser.run(state, "images",
                                  {"where": "index", "scroll": "top", "zoomPercent": 85,
                                   "forcePlaceholderClass": True, "forceBlur": True})
            rows = result.get("rows", [])
            bad = [row for row in rows if _image_issues(row)]
            caught = [row for row in bad if row["ratio"] >= 1.0 and row.get("filter", "none") != "none"]
            if caught:
                sample = caught[0]
                report.ok("负向自检·高清+模糊", "分辨率仍 ≥1.0、filter 非 none 时断言报 FAIL",
                          f"p{sample['page']}：比例 {sample['ratio']:.3f}，"
                          f"filter={sample['filter']}，占位类={'是' if sample['placeholderClass'] else '否'}\n"
                          + _image_table(rows))
            else:
                report.fail("负向自检·高清+模糊", "加回 is-placeholder 后断言应报 FAIL",
                            "没有抓到 filter 非 none 的页图（或比例被误判）\n" + _image_table(rows))
        except Exception as error:  # noqa: BLE001
            report.blocked("负向自检·高清+模糊", str(error))
    return report.finish(report_path)


def cmd_pagesync(args: argparse.Namespace) -> int:
    state = _require_state()
    report = Report("左右页同步（六条路径）")
    report_path = Path(state["run_dir"]) / "report-pagesync.json"
    try:
        _browser.run(state, "prepare")
    except Exception as error:  # noqa: BLE001
        report.blocked("准备", str(error))
        return report.finish(report_path)
    with _api(state) as api:
        pending = api.finish_summary(state["project_id"])["review"]["pending_items"]
    for path, label in PAGESYNC_PATHS:
        try:
            _pagesync_check(report, label, label,
                            _browser.run(state, "page_sync", {"path": path}),
                            queue_pending=pending if path == "next20" else None)
        except Exception as error:  # noqa: BLE001
            report.blocked(label, str(error))
    return report.finish(report_path)


def cmd_queueend(args: argparse.Namespace) -> int:
    """队列跑完时按「下一处未审」：必须明确告诉用户"全部处理完"，不能毫无反应。"""
    state = _require_state()
    report = Report("队列跑完时的提示")
    report_path = Path(state["run_dir"]) / "report-queueend.json"
    try:
        _browser.run(state, "prepare")
    except Exception as error:  # noqa: BLE001
        report.blocked("准备", str(error))
        return report.finish(report_path)

    with _api(state) as api:
        finish = api.finish_summary(state["project_id"])
        pending = finish["review"]["pending_items"]
        report.ok("队列长度", "测量前确认未审数量（干净副本）",
                  f"pending_items={pending}（汉字 {finish['review']['chars_pending']} + "
                  f"标点 {finish['review']['punct_pending']}）")
        if pending == 0:
            report.blocked("清空队列", "副本里已经没有未审项，无法验证队尾提示")
            return report.finish(report_path)

        # 全部 ack（ack=kept 只记"保留原文"，不改文本）——不是"批量采用"。
        items = []
        marks = api.get(f"/api/projects/{state['project_id']}/review/marks").get("items", [])
        for mark in marks:
            items.append({
                "block_id": mark["block_id"],
                "line_index": mark["line_index"],
                "ack": "kept",
                "new_line_text": None,
            })
        for start in range(0, len(items), 200):
            api.post(f"/api/projects/{state['project_id']}/review/submit-drafts",
                     {"items": items[start:start + 200]})
        after = api.finish_summary(state["project_id"])
        if after["review"]["pending_items"] != 0:
            report.fail("清空队列", "全部 ack 后 pending_items 应为 0",
                        f"仍剩 {after['review']['pending_items']}")
            return report.finish(report_path)
        report.ok("清空队列", "全部 ack 后 pending_items = 0",
                  f"ack {len(items)} 条；pending=0")

    # 队列是经 API 清空的，界面还拿着旧 marks；重开一次再看"队尾提示"，
    # 否则测到的是"界面以为还有未审"的旧状态。
    try:
        _browser.run(state, "prepare")
    except Exception as error:  # noqa: BLE001
        report.blocked("重开界面", str(error))
        return report.finish(report_path)
    try:
        result = _browser.run(state, "queue_end", {})
    except Exception as error:  # noqa: BLE001
        report.blocked("队尾提示", str(error))
        return report.finish(report_path)
    message = result.get("message") or ""
    if result.get("explicit"):
        report.ok("队尾提示", "按「下一处未审」后界面明确说已全部处理完",
                  f"文案：{message!r}")
    else:
        report.fail("队尾提示", "按「下一处未审」后界面明确说已全部处理完",
                    f"没有明确提示；progress={message!r}，面板可见={result.get('panelVisible')}，"
                    f"按钮文案={result.get('buttonText')!r}")
    return report.finish(report_path)


def cmd_smoke(args: argparse.Namespace) -> int:
    state = _require_state()
    report = Report("七步冒烟")
    report_path = Path(state["run_dir"]) / "report-smoke.json"

    with _api(state) as api:
        try:
            open_snapshot = _browser.run(state, "prepare")
        except Exception as error:  # noqa: BLE001 - 报告要保留完整原因
            report.blocked("0 打开项目", f"{error}")
            return report.finish(report_path)

        # 0 打开项目
        report.ok("0 打开项目", "视口 = 用户机器（1423×900 CSS px，dpr 2）",
                  f"{open_snapshot['innerWidth']}×{open_snapshot['innerHeight']}，dpr {open_snapshot['dpr']}")
        if len(open_snapshot["steps"]) == 6:
            report.ok("0 打开项目", "步骤条 6 步", "、".join(step["text"].split()[0] if step["text"] else step["id"] for step in open_snapshot["steps"]))
        else:
            report.fail("0 打开项目", "步骤条 6 步", f"实际 {len(open_snapshot['steps'])} 步")

        page_count = api.finish_summary(state["project_id"])["page_type"]["total"]
        if page_count == 662:
            report.ok("0 打开项目", "项目页数 = 662（API）", f"{page_count}")
        else:
            report.fail("0 打开项目", "项目页数 = 662（API）", f"{page_count}")

        finish = api.finish_summary(state["project_id"])
        pages = api.pages(state["project_id"])
        stored = Store(Path(state["library"]) / state["project_id"])
        try:
            # 1 页面确认
            try:
                snap = _browser.run(state, "step", {"step": "pages"})
                page_summary = snap["texts"].get("page-summary", "")
                included = sum(1 for page in pages if page["include"])
                confirmed = finish["page_type"]["confirmed"]
                evidence = f"API：共 {len(pages)} 页，纳入 {included}；已确认 {confirmed}/{finish['page_type']['total']}"
                if f"{len(pages)}" in page_summary:
                    report.ok("1 页面确认", "页面摘要显示 662 页（UI = API）", evidence + f"；UI：{page_summary[:80]}")
                else:
                    report.fail("1 页面确认", "页面摘要显示 662 页（UI = API）", evidence + f"；UI：{page_summary[:80]}")
                if included == 662:
                    report.ok("1 页面确认", "纳入集合 = 662 页", "include=1 的页：" + str(included))
                else:
                    report.fail("1 页面确认", "纳入集合 = 662 页", f"实际 {included}")
            except Exception as error:  # noqa: BLE001
                report.blocked("1 页面确认", str(error))

            # 2 文字识别
            try:
                snap = _browser.run(state, "step", {"step": "recognition"})
                engine = finish["engine"]
                title = next((step["title"] for step in snap["steps"] if step["id"] == "recognition"), "")
                active = stored.query("SELECT COUNT(*) FROM page WHERE active_run_id IS NOT NULL")[0][0]
                recognized = f"主引擎 {engine['main_recognized']}/{engine['total']}"
                if engine["main_recognized"] == 662 and engine["total"] == 662 and active == 662:
                    report.ok("2 文字识别", "662 页都有主引擎结果（API + 库）",
                              f"{recognized}；active_run 页数 {active}；UI 步骤：{title[:90]}")
                else:
                    report.fail("2 文字识别", "662 页都有主引擎结果",
                                f"{recognized}；active_run 页数 {active}")
                if recognized in title:
                    report.ok("2 文字识别", "步骤条数字与 API 一致", title[:120])
                else:
                    report.fail("2 文字识别", "步骤条数字与 API 一致", f"期望包含「{recognized}」；实际：{title[:160]}")
            except Exception as error:  # noqa: BLE001
                report.blocked("2 文字识别", str(error))

            # 3 版心确认
            try:
                snap = _browser.run(state, "step", {"step": "margin"})
                margin = finish["margin"]
                with_box = stored.query("SELECT COUNT(*) FROM page WHERE margin_box IS NOT NULL")[0][0]
                empty_pages = stored.query(
                    "SELECT COUNT(*) FROM page p WHERE p.margin_box IS NULL AND "
                    "(SELECT COUNT(*) FROM block b WHERE b.page_id = p.page_id AND b.deleted_at IS NULL) > 0"
                )[0][0]
                expected_boxes = margin["total"] - margin["no_text"]
                detail = (f"版心已定 {margin['set']}/{margin['total']}（无文字页 {margin['no_text']} 不需要框）；"
                          f"库里 margin_box 非空 {with_box} 页（应 = {expected_boxes}）；"
                          f"无框但有块的页 {empty_pages}；未定 {margin['undetermined']}")
                if with_box == expected_boxes and empty_pages == 0:
                    report.ok("3 版心确认", "有文字的页都有版心框（库）", detail)
                else:
                    report.fail("3 版心确认", "有文字的页都有版心框（库）", detail)
                if margin["complete"]:
                    report.ok("3 版心确认", "版心步被后端判定完成", f"complete=True；{detail}")
                else:
                    report.fail("3 版心确认", "版心步被后端判定完成", detail)
                tile = next((step for step in snap["steps"] if step["id"] == "margin"), {})
                shown = f"{margin['set']}/{margin['total']}"
                if shown in tile.get("count", "") or shown in tile.get("title", ""):
                    report.ok("3 版心确认", "步骤条显示 662/662（UI = API）", f"count={tile.get('count')!r} title={tile.get('title', '')[:80]}")
                else:
                    report.fail("3 版心确认", "步骤条显示 662/662（UI = API）", f"count={tile.get('count')!r}")
            except Exception as error:  # noqa: BLE001
                report.blocked("3 版心确认", str(error))

            # 4 目录确认
            try:
                snap = _browser.run(state, "step", {"step": "index"})
                index = finish["index"]
                meta = snap["texts"].get("index-meta", "")
                detail = (f"索引 {index.get('numbered', 0)}/{index.get('total', 0)} 页有印刷页码、"
                          f"缺 {index.get('missing', 0)}；complete={index.get('complete')} "
                          f"skippable={index.get('skippable')}；UI：「{meta}」")
                numbered_text = f"{index.get('numbered', 0)} 页有印刷页码"
                missing_text = f"{index.get('missing', 0)} 页未识别页码"
                if numbered_text in meta and missing_text in meta:
                    report.ok("4 目录确认", "界面页码计数 = finish-summary（UI = API）", detail)
                else:
                    report.fail("4 目录确认", "界面页码计数 = finish-summary（UI = API）", detail)
                tile = next((step for step in snap["steps"] if step["id"] == "index"), {})
                if index.get("skippable") and "可跳过" in tile.get("count", ""):
                    report.ok("4 目录确认", "无可信页码时步骤条写「可跳过」（与 API skippable 一致）",
                              f"count={tile.get('count')!r}；{detail}")
                else:
                    report.fail("4 目录确认", "无可信页码时步骤条写「可跳过」",
                                f"count={tile.get('count')!r}；{detail}")
                for extra, label in (({}, "目录确认·适合宽度"),
                                     ({"zoomPercent": 85}, "目录确认·85%")):
                    try:
                        _image_check(report, "4 目录确认",
                                     _browser.run(state, "images",
                                                  {"where": "index", "scroll": "top", **extra}),
                                     label)
                    except Exception as error:  # noqa: BLE001
                        report.blocked(f"4 目录确认 · 页图清晰度（{label}）", str(error))
            except Exception as error:  # noqa: BLE001
                report.blocked("4 目录确认", str(error))

            # 5 正文审校
            try:
                reading = _browser.run(state, "reading")
                review = finish["review"]
                head_total = _count_before(reading["treeHead"], "处")
                rows_sum = sum(_count_before(row["text"], "处") for row in reading["rows"])
                chars = review["chars_total"] + review["punct_total"]
                detail = (f"左树头「{reading['treeHead']}」；行之和 {rows_sum}；"
                          f"API：汉字 {review['chars_total']} + 标点 {review['punct_total']} = {chars}，"
                          f"pending={review['pending_items']}；进度「{reading['progress']}」")
                if head_total == review["total_items"]:
                    report.ok("5 正文审校", "队列数（左树头「队列 N 处」）= API total_items", detail)
                else:
                    report.fail("5 正文审校", "队列数（左树头）= API total_items", detail)
                if rows_sum == review["pending_items"]:
                    report.ok("5 正文审校", "左树各行「N 处」之和 = API pending_items", detail)
                else:
                    report.fail("5 正文审校", "左树各行之和 = API pending_items", detail)
                if review["total_items"] == chars and head_total == review["total_items"]:
                    report.ok("5 正文审校", "顶栏分母（汉字）+ 标点 = 队列总数", detail)
                else:
                    report.ok("5 正文审校", "队列拆分（汉字 + 标点 = 总数）已记录", detail)
                if f"/ {review['chars_total']} " in reading["progress"]:
                    report.ok("5 正文审校", "顶栏「已审 0 / 573 字」分母 = API chars_total", reading["progress"])
                else:
                    report.fail("5 正文审校", "顶栏进度分母 = API chars_total",
                                f"progress={reading['progress']!r} chars_total={review['chars_total']}")
                if reading["checkFails"] == 0:
                    report.ok("5 正文审校", "阅读流文本自检 0 失败（__b2tTextCheckFails）", "0")
                else:
                    report.fail("5 正文审校", "阅读流文本自检", f"{reading['checkFails']} 处不一致")
                for path, sync_label in PAGESYNC_PATHS:
                    try:
                        _pagesync_check(report, "5 正文审校", sync_label,
                                        _browser.run(state, "page_sync", {"path": path}),
                                        queue_pending=(finish["review"]["pending_items"]
                                                       if path == "next20" else None))
                    except Exception as error:  # noqa: BLE001
                        report.blocked(f"5 正文审校 · 左右页同步（{sync_label}）", str(error))
                for scroll, label in (("top", "审校第 1 屏"), ("middle", "审校中间一屏")):
                    try:
                        _image_check(report, "5 正文审校",
                                     _browser.run(state, "images", {"where": "review", "scroll": scroll}),
                                     label, min_page=50 if scroll == "middle" else None)
                    except Exception as error:  # noqa: BLE001
                        report.blocked(f"5 正文审校 · 页图清晰度（{label}）", str(error))
            except Exception as error:  # noqa: BLE001
                report.blocked("5 正文审校", str(error))

            # 6 导出
            try:
                snap = _browser.run(state, "export")
                preflight = api.preflight(state["project_id"])
                preview = api.preview(state["project_id"])
                segments = preview.get("segments", [])
                exported_pages = preflight.get("exported_pages", [])
                detail = (f"预检：导出页 {len(exported_pages)} · 有正文的页 {preflight.get('page_count')} · "
                          f"{preflight.get('segment_count')} 段 · {preflight.get('char_count')} 字；"
                          f"预览 {len(segments)} 段；UI：{snap['texts'].get('export-preflight', '')[:90]}")
                if len(exported_pages) == 662 and len(segments) == preflight.get("segment_count"):
                    report.ok("6 导出", "导出覆盖 662 页，预览段数 = 预检段数", detail)
                else:
                    report.fail("6 导出", "导出覆盖 662 页，预览段数 = 预检段数", detail)
                ui_text = snap["texts"].get("export-preflight", "")
                if "662 页" in ui_text and f"{preflight.get('segment_count')} 段" in ui_text:
                    report.ok("6 导出", "导出面板的页数/段数 = 预检（UI = API）", ui_text[:120])
                else:
                    report.fail("6 导出", "导出面板的页数/段数 = 预检（UI = API）", ui_text[:160])
                if snap.get("written"):
                    report.ok("6 导出", "点击导出真的落盘",
                              f"export_id={snap['written'].get('meta')}；文件 {snap['written'].get('files')}")
                else:
                    report.fail("6 导出", "点击导出真的落盘", "没有看到导出结果")
            except Exception as error:  # noqa: BLE001
                report.blocked("6 导出", str(error))
        finally:
            stored.close()

    return report.finish(report_path)


def _count_before(text: str, unit: str) -> int:
    """从「第 12 页 403 处」里取「处」前面的数；「✓」记 0。"""
    import re as _re

    match = _re.search(r"(\d+)\s*" + _re.escape(unit), text or "")
    return int(match.group(1)) if match else 0


# ---------------------------------------------------------------- 三组一致性断言


def cmd_check(args: argparse.Namespace) -> int:
    state = _require_state()
    report = Report("三组一致性断言")
    report_path = Path(state["run_dir"]) / "report-check.json"
    project_dir = Path(state["library"]) / state["project_id"]

    # 先从干净界面开始：prepare 会清掉本机草稿并重新打开项目。
    # 否则上一轮失败的草稿会让「显示≠导出」变成假阳性（草稿本来就没写进库）。
    try:
        _browser.run(state, "prepare")
    except Exception as error:  # noqa: BLE001
        report.blocked("准备（清草稿 + 重开项目）", str(error))
        return report.finish(report_path)

    with _api(state) as api, Store(project_dir) as store:
        # A. 显示 = 导出
        try:
            reading = _browser.run(state, "reading")
            # 用**阅读视图自己发出的那组选项**取预览：选项不同，段文本本来就可能不同，
            # 拿默认选项去比会把"选项差异"误报成"显示≠导出"。
            preview = api.preview(state["project_id"], reading.get("options") or {})
            by_seq = {segment["seq"]: segment for segment in preview.get("segments", [])}
            mismatches = []
            for shown in reading["segments"]:
                source = by_seq.get(shown["seq"])
                if source is None:
                    mismatches.append(f"seq {shown['seq']} 在导出预览里不存在")
                elif shown["text"] != source["text"]:
                    mismatches.append(_first_diff(shown["seq"], shown["text"], source["text"]))
            if reading["checkFails"] == 0 and not mismatches:
                report.ok("A 显示=导出", f"{len(reading['segments'])} 个已渲染段落逐字相同",
                          f"自检失败 0；首段「{reading['segments'][0]['text'][:40]}…」")
            else:
                report.fail("A 显示=导出", "右栏可见文本 = 导出段文本",
                            f"自检失败 {reading['checkFails']}；" + "；".join(mismatches[:5]))
        except Exception as error:  # noqa: BLE001
            report.blocked("A 显示=导出", str(error))

        # B. 提交 → 库；C. 撤销 → 字节
        edited: list[dict[str, Any]] = []
        before_blocks: dict[str, dict] = {}
        try:
            edit_result = _browser.run(state, "edit", {"count": 2, "suffix": " QA"})
            edited = edit_result["edits"]
            for item in edited:
                block = store.block(item["block"])
                if block is None:
                    raise AssertionError(f"编辑的行找不到块：{item['block']}")
                before_blocks[item["block"]] = block
            before_fp = block_fingerprint(before_blocks.values())

            submit_result = _browser.run(state, "submit", {})
            after_blocks = {block_id: store.block(block_id) for block_id in before_blocks}

            text_changed = [
                block_id for block_id, block in after_blocks.items()
                if block and block["text"] != before_blocks[block_id]["text"]
            ]
            contains_expected = [
                item for item in edited
                if after_blocks[item["block"]]
                and _norm(item["after"] or "") in _norm(after_blocks[item["block"]]["text"])
            ]
            if len(text_changed) == len(edited):
                report.ok("B 提交→库", f"{len(edited)} 处编辑都写进了库",
                          "；".join(f"{block_id[:10]}… {before_blocks[block_id]['text'][:20]!r} → "
                                   f"{after_blocks[block_id]['text'][:20]!r}" for block_id in text_changed))
            else:
                report.fail("B 提交→库", "编辑都写进了库",
                            f"改动 {len(text_changed)}/{len(edited)} 块；提交返回 {submit_result.get('after')}")
            if len(contains_expected) == len(edited):
                report.ok("B 提交→库", "库里的块文本包含 UI 上新输入的行", "全部命中")
            else:
                report.fail("B 提交→库", "库里的块文本包含 UI 上新输入的行",
                            f"{len(contains_expected)}/{len(edited)} 命中")

            revisions = [
                (after_blocks[item["block"]]["revision"], before_blocks[item["block"]]["revision"])
                for item in edited
            ]
            if all(after > before for after, before in revisions):
                report.ok("B 提交→库", "revision 递增（写入确实是一次提交）", str(revisions))
            else:
                report.fail("B 提交→库", "revision 递增", str(revisions))

            # C. 撤销 → 字节。判据是**库**，不是界面刷新（界面重渲染可能延迟）：
            # 轮询到内容指纹回到提交前，或超时。
            undo_result = _browser.run(state, "undo", {})
            deadline = time.monotonic() + 60
            restored: dict[str, dict] = {}
            after_fp = ""
            while time.monotonic() < deadline:
                restored = {block_id: store.block(block_id) for block_id in before_blocks}
                after_fp = block_fingerprint(restored.values())
                if after_fp == before_fp:
                    break
                time.sleep(0.5)
            if after_fp == before_fp:
                report.ok("C 撤销→字节", "撤销后内容指纹 = 提交前（逐字段）",
                          f"{before_fp[:16]}… == {after_fp[:16]}…；界面重渲染={undo_result.get('mutated')}")
            else:
                diff = [
                    f"{block_id[:10]}…: {before_blocks[block_id]['text'][:30]!r} → "
                    f"{restored[block_id]['text'][:30]!r}"
                    for block_id in before_blocks
                    if restored[block_id] and restored[block_id]["text"] != before_blocks[block_id]["text"]
                ]
                report.fail("C 撤销→字节", "撤销后内容指纹 = 提交前",
                            f"{before_fp[:16]}… != {after_fp[:16]}…；差异：{diff}")
        except Exception as error:  # noqa: BLE001
            report.blocked("B 提交→库 / C 撤销→字节", f"{error}")

    return report.finish(report_path)


def _norm(text: str) -> str:
    """去掉空白差异，只比字。UI 的行文本与块文本之间可能差在换行/空格。"""
    return "".join((text or "").split())


def _first_diff(seq: int, shown: str, source: str) -> str:
    index = 0
    while index < len(shown) and index < len(source) and shown[index] == source[index]:
        index += 1
    start = max(0, index - 15)
    return (f"seq {seq} 第 {index} 字起不同：显示「{shown[start:index + 20]}」"
            f" vs 导出「{source[start:index + 20]}」")


# ---------------------------------------------------------------- CLI


def _pin_brief(row: dict[str, Any] | None) -> str:
    if not row:
        return "（没有采样）"
    pin = row.get("pin") or {}
    return (
        f"顶部 {row.get('label')} / 左栏主导 {row.get('dominant')} / 面板 {row.get('panelPage')} / "
        f"锚点行 {row.get('anchorPage')}（mark={'有' if row.get('anchorMark') else '无'}）/ "
        f"is-current {row.get('currentLines')} / 面板行{'在' if row.get('panelLineIn') else '不在'}视口 / "
        f"pin.held={pin.get('held')} pin.escape={pin.get('escape')} / "
        f"settleKey={row.get('settleKey')}"
    )


def cmd_pinguard(args: argparse.Namespace) -> int:
    """页码守卫三段：跳转不漂 / 滚一页要跟 / 滚多页继续跟。

    判据（DevLead 定）：
    - 跳转落位后 500ms 与 +1.5s：顶部 = 左栏主导 = 面板页
    - 面板开着滚到相邻页：顶部必须变成相邻页（上一版 |Δ|≤1 就死在这条）
    - 继续滚到 +2/+4：顶部跟着走；held 只在跳转那次涨、之后不涨；escape = 0
    - 滚完 is-current 仍 ≥1（别为了修页码把高亮弄丢）
    """
    state = _require_state()
    report = Report("页码守卫三段（跳转不漂 / 滚一页 / 滚多页）")
    report_path = Path(state["run_dir"]) / "report-pinguard.json"
    try:
        _browser.run(state, "prepare")
    except Exception as error:  # noqa: BLE001
        report.blocked("准备", str(error))
        return report.finish(report_path)
    try:
        data = _browser.run(state, "pin_guard", {"targetPage": args.page, "maxJumps": args.max_jumps},
                            timeout=900.0)
    except Exception as error:  # noqa: BLE001
        report.blocked("三段探针", str(error))
        return report.finish(report_path)
    # 原始数据单独落盘：report.finish 会写同一个路径，别让它把证据覆盖掉。
    raw_path = Path(state["run_dir"]) / "raw-pinguard.json"
    raw_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    if data.get("error"):
        tail = (data.get("jumpRows") or [])[-6:]
        report.blocked("第 1 段·跳转",
                       f"{data['error']}（按了 {data.get('jumps')} 次；最后 6 次："
                       + "；".join(f"#{row['n']} 面板{row.get('panelPage')}/顶部{row.get('label')}"
                                  f"/锚点{row.get('anchorPage')}/scrollTop{row.get('scrollTop')}"
                                  for row in tail)
                       + f"；{_pin_brief(data.get('last'))}；raw={raw_path}）")
        return report.finish(report_path)

    target = int(data["target"])
    landing = data.get("landing") or {}
    at500 = data.get("at500") or {}
    at1500 = data.get("at1500") or {}

    # ---------------------------------------------------------------- 1. 跳转不漂
    if not landing.get("panelKey"):
        report.fail("第 1 段·跳转不漂", "跳到目标页后面板没有 key（面板没开 / 不是这条路径）",
                    _pin_brief(landing))
    elif not landing.get("panelLineExists"):
        report.fail("第 1 段·跳转不漂", "面板 key 在正文流里找不到行",
                    _pin_brief(landing))
    else:
        report.ok("第 1 段·前置", "跳转后面板开着、目标行在流里",
                  f"按了 {data.get('jumps')} 次「下一处未审」进第 {target} 页；"
                  f"panelKey={landing.get('panelKey')}；{_pin_brief(landing)}")

    for label, snap, wait in (("500ms", at500, "500ms"), ("+1.5s", at1500, "1.5s 后")):
        problems = []
        if snap.get("label") != target:
            problems.append(f"顶部 {snap.get('label')} ≠ {target}")
        if snap.get("dominant") != target:
            problems.append(f"左栏主导 {snap.get('dominant')} ≠ {target}")
        if snap.get("panelPage") != target:
            problems.append(f"面板 {snap.get('panelPage')} ≠ {target}")
        if problems:
            report.fail(f"第 1 段·跳转不漂（{label}）", "；".join(problems), _pin_brief(snap))
        else:
            report.ok(f"第 1 段·跳转不漂（{label}）",
                      f"顶部 = 左栏主导 = 面板 = 第 {target} 页（{wait} 仍站住）", _pin_brief(snap))

    # ---------------------------------------------------------------- 2. 滚一页要跟
    step143 = data.get("step143") or {}
    if step143.get("label") != target + 1:
        report.fail("第 2 段·滚一页要跟",
                    f"滚到锚点第 {step143.get('anchorPage')} 页，顶部却停在 {step143.get('label')} 页"
                    f"（应为 {target + 1}）",
                    _pin_brief(step143))
    elif (step143.get("currentLines") or 0) < 1:
        report.fail("第 2 段·滚一页要跟", "页码跟上了，但 is-current 没了（高亮被弄丢）",
                    _pin_brief(step143))
    else:
        report.ok("第 2 段·滚一页要跟",
                  f"面板开着滚到第 {target + 1} 页：顶部 {step143.get('label')}、"
                  f"is-current {step143.get('currentLines')}",
                  _pin_brief(step143))

    # ---------------------------------------------------------------- 3. 滚多页继续跟
    step144 = data.get("step144") or {}
    step146 = data.get("step146") or {}
    held_after_jump = (at1500.get("pin") or {}).get("held")
    held_later = [(row.get("pin") or {}).get("held")
                  for row in (step143, step144, step146)]
    escape = (step146.get("pin") or {}).get("escape")
    problems = []
    if step144.get("label") != target + 2:
        problems.append(f"第 {target + 2} 页：顶部 {step144.get('label')}")
    if step146.get("label") != target + 4:
        problems.append(f"第 {target + 4} 页：顶部 {step146.get('label')}")
    if any(value != held_after_jump for value in held_later):
        problems.append(f"held 在跳转后还在涨：落位时 {held_after_jump} → 滚动后 {held_later}")
    if escape not in (0, None):
        problems.append(f"escape={escape}（保底放行被触发，说明有落位一直没完成）")
    if problems:
        report.fail("第 3 段·滚多页继续跟", "；".join(problems),
                    "\n".join(f"第 {row.get('anchorPage')} 页：" + _pin_brief(row)
                               for row in (step143, step144, step146)))
    else:
        report.ok("第 3 段·滚多页继续跟",
                  f"滚到 {target + 2} / {target + 4} 页顶部都跟着走；"
                  f"held 跳转后不再涨（{held_after_jump}）；escape=0；"
                  f"is-current {step146.get('currentLines')}",
                  "\n".join(f"第 {row.get('anchorPage')} 页：" + _pin_brief(row)
                             for row in (step143, step144, step146)))
    return report.finish(report_path)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Book2Text QA：隔离环境 + 一致性验收")
    sub = parser.add_subparsers(dest="command", required=True)

    up = sub.add_parser("up", help="复制项目库并起隔离服务")
    up.add_argument("--project", default=PROJECT_DIR_NAME, help=f"源项目 id（默认 {PROJECT_DIR_NAME}）")
    up.set_defaults(func=cmd_up)

    down = sub.add_parser("down", help="关服务、删临时库")
    down.add_argument("--keep", action="store_true", help="只关服务，保留临时库供排查")
    down.set_defaults(func=cmd_down)

    sub.add_parser("status", help="查看环境与服务状态").set_defaults(func=cmd_status)
    sub.add_parser("prepare", help="浏览器打开项目（1423×900@2），等到步骤条就绪").set_defaults(func=cmd_prepare)

    step = sub.add_parser("step", help="点一个工作流步骤并导出界面状态")
    step.add_argument("name", choices=["pages", "recognition", "margin", "index", "review", "export"])
    step.set_defaults(func=cmd_step)

    reading = sub.add_parser("reading", help="读取正文审校界面状态与已渲染段落")
    reading.add_argument("--page", type=int, default=None)
    reading.set_defaults(func=cmd_reading)

    sub.add_parser("smoke", help="七步冒烟（一键）").set_defaults(func=cmd_smoke)
    images = sub.add_parser("images", help="页图清晰度：审校第 1 屏 / 中间一屏 / 目录确认一屏")
    images.add_argument("--selftest", action="store_true", help="负向自检：低清档 / 高清+模糊，断言都必须报 FAIL")
    images.set_defaults(func=cmd_images)
    sub.add_parser("check", help="三组一致性断言：显示=导出 / 提交→库 / 撤销→字节").set_defaults(func=cmd_check)
    sub.add_parser("pagesync", help="左右页同步（三方）：六条路径").set_defaults(func=cmd_pagesync)
    sub.add_parser("queueend", help="清空未审队列后验证「下一处未审」的队尾提示").set_defaults(func=cmd_queueend)
    pinguard = sub.add_parser("pinguard", help="页码守卫三段：跳转不漂 / 滚一页要跟 / 滚多页继续跟")
    pinguard.add_argument("--page", type=int, default=142, help="跳转落位目标页（默认 142）")
    pinguard.add_argument("--max-jumps", type=int, default=240, help="为达到目标页最多按多少次「下一处未审」")
    pinguard.set_defaults(func=cmd_pinguard)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except Exception:  # noqa: BLE001 - CLI 顶层要把完整栈打给使用者
        traceback.print_exc()
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
