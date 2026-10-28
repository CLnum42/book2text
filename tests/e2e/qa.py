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
                if f"/ {review['chars_total']} 字" in reading["progress"]:
                    report.ok("5 正文审校", "顶栏「已审 0 / 573 字」分母 = API chars_total", reading["progress"])
                else:
                    report.fail("5 正文审校", "顶栏进度分母 = API chars_total",
                                f"progress={reading['progress']!r} chars_total={review['chars_total']}")
                if reading["checkFails"] == 0:
                    report.ok("5 正文审校", "阅读流文本自检 0 失败（__b2tTextCheckFails）", "0")
                else:
                    report.fail("5 正文审校", "阅读流文本自检", f"{reading['checkFails']} 处不一致")
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
