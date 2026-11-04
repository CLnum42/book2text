"""审校「待处理」与自动通过（任务 61 / 工作流阶段 9）。

**唯一的数据来源**（不另算一套）：

- 块类型建议：`structure.suggestions_by_page()`（与审校徽章同一套规则）；
- 两路分歧：`blocks.page_divergences()`（与页面 / 块上的分歧标记同源）；
- 漏行候选：`ink_gaps.find_ink_gaps()`（与审校顶部漏行提示同源）；
- 版面确认：`page.layout_confirmed`；
- 版心：`page.margin_box_mode` / `project.margin_box_source`（自动框未确认不算"版心已定"）；
- 识别状态：`blocks.page_recognition_states()`；
- 第二引擎是否跑过：`blocks.pages_with_auxiliary_run()`；
- 确认方式：`page_workflow.confirm_mode`（迁移 0016）。

**自动通过只写工作流状态**：`stage=human_confirmed` + `confirm_mode=auto`，
不改块文本、类型、框，也不改审校状态。界面必须显示「自动通过（未经人工）」。
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from ..export import header_cleanup
from . import blocks as blocks_module
from . import cache_policy
from . import continuations as continuations_module
from . import ink_gaps as ink_gaps_module
from . import library as library_module
from . import margin_box as margin_box_module
from . import page_index as page_index_module
from . import page_numbers as page_numbers_module
from . import punct_groups as punct_groups_module
from . import structure as structure_module
from . import workflow as workflow_module
from ..ocr import compare as compare_module
from ..storage import db as db_module

AUTO_PASS_FAILED = "recognition_failed"
AUTO_PASS_UNRECOGNIZED = "unrecognized"
AUTO_PASS_LAYOUT = "layout_unconfirmed"
AUTO_PASS_MARGIN = "margin_unconfirmed"
AUTO_PASS_SUGGESTION = "suggestions"
AUTO_PASS_DIVERGENCE = "divergence"
AUTO_PASS_INK_GAP = "ink_gaps"
AUTO_PASS_SINGLE_ENGINE = "single_engine"
AUTO_PASS_EXCLUDED = "auto_pass_excluded"
AUTO_PASS_ALREADY_CONFIRMED = "already_confirmed"

REASON_LABELS = {
    AUTO_PASS_FAILED: "识别失败",
    AUTO_PASS_UNRECOGNIZED: "还没识别",
    AUTO_PASS_LAYOUT: "版面未确认",
    AUTO_PASS_MARGIN: "版心未定",
    AUTO_PASS_SUGGESTION: "有类型建议",
    AUTO_PASS_DIVERGENCE: "有两路分歧",
    AUTO_PASS_INK_GAP: "有漏行候选",
    AUTO_PASS_SINGLE_ENGINE: "单引擎未复核",
    AUTO_PASS_EXCLUDED: "已撤销自动通过",
    AUTO_PASS_ALREADY_CONFIRMED: "已人工确认",
}


def _project(project_id: str, library: Path | None):
    return library_module.load_project(project_id, library=library)


def margin_is_set(project, page) -> bool:
    """这一页的版心是否算"已定"。

    - 页级 `custom`：有本页四边；
    - 页级 `none`：明确不适用，算已定；
    - `inherit`：全局版心存在且是**人工设置**（自动推算未确认不算，避免自动通过建立在
      一个还没人看过的框上）。
    """
    if page.margin_box_mode == "custom":
        return page.margin_box is not None
    if page.margin_box_mode == "none":
        return True
    if page.margin_box_mode == "auto":
        # 每页自动拟合 / 本页包围盒兜底出来的框算"已定"；没有框（未定）**不回退全局**，
        # 直接算没定——否则自动通过会建立在一个跟这一页无关的框上（任务 33）。
        return page.margin_box is not None
    return project.margin_box is not None and project.margin_box_source == margin_box_module.SOURCE_MANUAL


def _block_bboxes(
    project_id: str, *, library: Path | None, page_no: int | None = None
) -> dict[int, dict[str, object]]:
    """page_no → {block_id: bbox}（建议 / 漏行按版心过滤时查块框用）。"""
    result: dict[int, dict[str, object]] = {}
    for block in blocks_module.list_blocks(
        project_id, library=library, page_no=page_no
    ):
        result.setdefault(block.page_no, {})[block.block_id] = block.bbox
    return result


def _inside_suggestions(
    project,
    page,
    suggestions,
    bboxes: dict[str, object] | None,
) -> list:
    """只保留**块中心在版心内**的类型建议（任务 34：审校与导出同一口径）。"""
    if not suggestions:
        return []
    if bboxes is None:
        return list(suggestions)
    return [
        item
        for item in suggestions
        if margin_box_module.block_inside_margin(
            project, page, bboxes.get(item.block_id)
        )
    ]


def _inside_ink_count(project, page, ink: dict) -> int:
    """漏行候选里中心在版心内的条数（版心外的墨迹是书眉 / 装饰，不计）。"""
    candidates = ink.get("candidates") or []
    return sum(
        1
        for item in candidates
        if margin_box_module.block_inside_margin(project, page, item.get("bbox"))
    )


def _page_reasons(
    *,
    page,
    project,
    state,
    divergence,
    suggestion_count: int,
    ink_gap_count: int,
    aux_checked: bool,
    include_unrecognized: bool = True,
) -> list[dict[str, object]]:
    reasons: list[dict[str, object]] = []
    status = state.status if state is not None else blocks_module.STATUS_UNRECOGNIZED
    if status == blocks_module.STATUS_FAILED:
        reasons.append({"code": AUTO_PASS_FAILED, "label": REASON_LABELS[AUTO_PASS_FAILED]})
    elif status == blocks_module.STATUS_UNRECOGNIZED and include_unrecognized:
        reasons.append({"code": AUTO_PASS_UNRECOGNIZED, "label": REASON_LABELS[AUTO_PASS_UNRECOGNIZED]})
    if not page.layout_confirmed:
        reasons.append({"code": AUTO_PASS_LAYOUT, "label": REASON_LABELS[AUTO_PASS_LAYOUT]})
    if not margin_is_set(project, page):
        reasons.append({"code": AUTO_PASS_MARGIN, "label": REASON_LABELS[AUTO_PASS_MARGIN]})
    if suggestion_count:
        reasons.append(
            {
                "code": AUTO_PASS_SUGGESTION,
                "label": REASON_LABELS[AUTO_PASS_SUGGESTION],
                "count": suggestion_count,
            }
        )
    if divergence is not None and divergence.lines:
        reasons.append(
            {
                "code": AUTO_PASS_DIVERGENCE,
                "label": REASON_LABELS[AUTO_PASS_DIVERGENCE],
                "count": divergence.lines,
            }
        )
    if ink_gap_count:
        reasons.append(
            {
                "code": AUTO_PASS_INK_GAP,
                "label": REASON_LABELS[AUTO_PASS_INK_GAP],
                "count": ink_gap_count,
            }
        )
    if status == blocks_module.STATUS_RECOGNIZED and not aux_checked:
        reasons.append(
            {"code": AUTO_PASS_SINGLE_ENGINE, "label": REASON_LABELS[AUTO_PASS_SINGLE_ENGINE]}
        )
    return reasons


def evaluate_page(
    project_id: str,
    page_no: int,
    *,
    library: Path | None = None,
    check_ink_gaps: bool = True,
) -> dict:
    """评估一页是否满足自动通过的全部条件（只读）。"""
    pages = library_module.list_pages(project_id, library=library)
    page = next((item for item in pages if item.page_no == page_no), None)
    if page is None:
        raise library_module.ProjectError(f"没有第 {page_no} 页")
    project = _project(project_id, library)
    states = blocks_module.page_recognition_states(project_id, library=library)
    state = states.get(page.page_id)
    divergences = blocks_module.page_divergences(project_id, library=library)
    divergence = divergences.get(page.page_id)
    aux_checked = page.page_id in blocks_module.pages_with_auxiliary_run(
        project_id, library=library
    )
    page_bboxes = _block_bboxes(
        project_id, library=library, page_no=page_no
    ).get(page_no, {})
    suggestions = _inside_suggestions(
        project,
        page,
        structure_module.suggestions_by_page(
            project_id, library=library, page_numbers=[page_no]
        ).get(page_no, ()),
        page_bboxes,
    )
    ink_count = 0
    # 已经有别的未处理项时，不必再跑图像检测；自动通过只在"其他都干净"时才需要它。
    preliminary = _page_reasons(
        page=page,
        project=project,
        state=state,
        divergence=divergence,
        suggestion_count=len(suggestions),
        ink_gap_count=0,
        aux_checked=aux_checked,
    )
    if check_ink_gaps and not preliminary:
        try:
            ink = ink_gaps_module.find_ink_gaps(project_id, page_no, library=library)
            ink_count = _inside_ink_count(project, page, ink)
        except Exception:  # noqa: BLE001 - 漏行检测是辅助信息，读不到不阻断判定
            ink_count = 0
    reasons = _page_reasons(
        page=page,
        project=project,
        state=state,
        divergence=divergence,
        suggestion_count=len(suggestions),
        ink_gap_count=ink_count,
        aux_checked=aux_checked,
    )
    wf = workflow_module.page_workflow(
        library_module.require_project_dir(project_id, library=library), page.page_id
    )
    if (wf or {}).get("confirm_mode") == workflow_module.CONFIRM_HUMAN:
        reasons.append(
            {"code": AUTO_PASS_ALREADY_CONFIRMED, "label": REASON_LABELS[AUTO_PASS_ALREADY_CONFIRMED]}
        )
    if (wf or {}).get("auto_pass_excluded"):
        reasons.append(
            {"code": AUTO_PASS_EXCLUDED, "label": REASON_LABELS[AUTO_PASS_EXCLUDED]}
        )
    eligible = (
        bool(page.include)
        and state is not None
        and state.status == blocks_module.STATUS_RECOGNIZED
        and not reasons
        and not (wf or {}).get("auto_pass_excluded")
    )
    return {
        "page_no": page_no,
        "page_id": page.page_id,
        "eligible": eligible,
        "reasons": reasons,
        "suggestion_count": len(suggestions),
        "divergence_lines": divergence.lines if divergence else 0,
        "ink_gap_count": ink_count,
        "layout_confirmed": bool(page.layout_confirmed),
        "margin_set": margin_is_set(project, page),
        "aux_checked": aux_checked,
        "confirm_mode": (wf or {}).get("confirm_mode"),
        "auto_pass_excluded": bool((wf or {}).get("auto_pass_excluded")),
    }


def auto_pass_page(project_id: str, page_no: int, *, library: Path | None = None) -> dict:
    """自动通过一页：满足全部条件才写状态，否则原样返回原因。"""
    result = evaluate_page(project_id, page_no, library=library)
    if not result["eligible"]:
        return {**result, "applied": False}
    directory = library_module.require_project_dir(project_id, library=library)
    workflow_module.set_confirmation(
        directory, result["page_id"], workflow_module.CONFIRM_AUTO
    )
    return {
        **result,
        "applied": True,
        "confirm_mode": workflow_module.CONFIRM_AUTO,
        "stage_label": "自动通过（未经人工）",
    }


def revoke_auto_pass(project_id: str, page_no: int, *, library: Path | None = None) -> dict:
    """撤销一页的自动通过（人工确认不受影响）。"""
    pages = library_module.list_pages(project_id, library=library)
    page = next((item for item in pages if item.page_no == page_no), None)
    if page is None:
        raise library_module.ProjectError(f"没有第 {page_no} 页")
    directory = library_module.require_project_dir(project_id, library=library)
    stage = workflow_module.revoke_auto_pass(directory, page.page_id)
    return {"page_no": page_no, "page_id": page.page_id, "stage": stage, "revoked": True}


def project_pending(
    project_id: str,
    *,
    library: Path | None = None,
    divergences: dict | None = None,
) -> dict:
    """页面视图的「待处理」：只返回**有理由**的页，并给出理由计数。"""
    pages = library_module.list_pages(project_id, library=library)
    project = _project(project_id, library)
    states = blocks_module.page_recognition_states(project_id, library=library)
    if divergences is None:
        divergences = blocks_module.page_divergences(project_id, library=library)
    aux = blocks_module.pages_with_auxiliary_run(project_id, library=library)
    directory = library_module.require_project_dir(project_id, library=library)
    try:
        with db_module.open_database(directory, apply_migrations=False) as conn:
            workflow_rows = {
                row["page_id"]: row
                for row in conn.execute("SELECT * FROM page_workflow")
            }
    except Exception:  # noqa: BLE001 - 老库没有状态表
        workflow_rows = {}
    recognized = [
        page.page_no
        for page in pages
        if page.include
        and (states.get(page.page_id) is not None)
        and states[page.page_id].status == blocks_module.STATUS_RECOGNIZED
    ]
    # 任务 63：**不带 page_numbers** 调用，才能命中"整本建议"的缓存
    # （带子集每次都要重算 1.8 s，收尾面板每次刷新都会踩到）。
    # 结果里多出来的页不影响：下面只按 `page.page_no` 取。
    suggestion_map = structure_module.suggestions_by_page(project_id, library=library)
    bboxes_by_page = _block_bboxes(project_id, library=library)
    items: list[dict] = []
    counts: dict[str, int] = {}
    for page in pages:
        if not page.include:
            continue
        suggestions = _inside_suggestions(
            project,
            page,
            suggestion_map.get(page.page_no, ()),
            bboxes_by_page.get(page.page_no),
        )
        wf_row = workflow_rows.get(page.page_id)
        reasons = _page_reasons(
            page=page,
            project=project,
            state=states.get(page.page_id),
            divergence=divergences.get(page.page_id),
            suggestion_count=len(suggestions),
            ink_gap_count=0,
            aux_checked=page.page_id in aux,
            include_unrecognized=False,
        )
        if wf_row is not None and wf_row["auto_pass_excluded"] and (
            wf_row["confirm_mode"] != workflow_module.CONFIRM_HUMAN
        ):
            reasons.append(
                {"code": AUTO_PASS_EXCLUDED, "label": REASON_LABELS[AUTO_PASS_EXCLUDED]}
            )
        # 只有前面都干净时才检查漏行，避免为已经待处理的页做多余的图像分析
        if not reasons:
            try:
                ink = ink_gaps_module.find_ink_gaps(project_id, page.page_no, library=library)
                ink_count = _inside_ink_count(project, page, ink)
            except Exception:  # noqa: BLE001 - 辅助信息
                ink_count = 0
            if ink_count:
                reasons = _page_reasons(
                    page=page,
                    project=project,
                    state=states.get(page.page_id),
                    divergence=divergences.get(page.page_id),
                    suggestion_count=len(suggestions),
                    ink_gap_count=ink_count,
                    aux_checked=page.page_id in aux,
                    include_unrecognized=False,
                )
        if not reasons:
            continue
        for reason in reasons:
            counts[reason["code"]] = counts.get(reason["code"], 0) + 1
        items.append(
            {
                "page_no": page.page_no,
                "page_id": page.page_id,
                "reasons": reasons,
                "suggestion_count": len(suggestions),
                "divergence_lines": (
                    divergences[page.page_id].lines
                    if page.page_id in divergences
                    else 0
                ),
            }
        )
    return {
        "count": len(items),
        "pages": items,
        "counts": counts,
        "labels": REASON_LABELS,
    }


def status_counts(
    project_id: str,
    *,
    library: Path | None = None,
    page_numbers: list[int] | None = None,
) -> dict:
    """导出预检 / manifest 用的工作流状态计数（按当前导出页范围）。"""
    pages = library_module.list_pages(project_id, library=library)
    wanted = {int(no) for no in page_numbers} if page_numbers is not None else None
    if wanted is not None:
        pages = [page for page in pages if page.page_no in wanted]
    states = blocks_module.page_recognition_states(project_id, library=library)
    aux = blocks_module.pages_with_auxiliary_run(project_id, library=library)
    directory = library_module.require_project_dir(project_id, library=library)
    from ..storage import db as db_module

    rows = {}
    try:
        with db_module.open_database(directory, apply_migrations=False) as conn:
            rows = {row["page_id"]: row for row in conn.execute("SELECT * FROM page_workflow")}
    except Exception:  # noqa: BLE001 - 老库没有状态表时按全空处理
        rows = {}
    counts = {
        "total": len(pages),
        "human_confirmed": 0,
        "auto_passed": 0,
        "single_engine": 0,
        "layout_unconfirmed": 0,
        "recognition_failed": 0,
        "unrecognized": 0,
        "pending": 0,
    }
    for page in pages:
        row = rows.get(page.page_id)
        confirm_mode = row["confirm_mode"] if row is not None else None
        state = states.get(page.page_id)
        status = state.status if state is not None else blocks_module.STATUS_UNRECOGNIZED
        if confirm_mode == workflow_module.CONFIRM_HUMAN:
            counts["human_confirmed"] += 1
        elif confirm_mode == workflow_module.CONFIRM_AUTO:
            counts["auto_passed"] += 1
        if status == blocks_module.STATUS_RECOGNIZED and page.page_id not in aux:
            counts["single_engine"] += 1
        if not page.layout_confirmed:
            counts["layout_unconfirmed"] += 1
        if status == blocks_module.STATUS_FAILED:
            counts["recognition_failed"] += 1
        if status == blocks_module.STATUS_UNRECOGNIZED:
            counts["unrecognized"] += 1
        if confirm_mode is None:
            counts["pending"] += 1
    # 任务 67：人工裁决的差异数（导出 manifest 追溯"保留原状"用了多少处）。
    counts["diff_kept"] = 0
    counts["diff_adopted"] = 0
    page_ids = [page.page_id for page in pages]
    if page_ids:
        marks = ",".join("?" for _ in page_ids)
        try:
            with db_module.open_database(directory, apply_migrations=False) as conn:
                for ack, key in (
                    ("kept", "diff_kept"),
                    ("adopted", "diff_adopted"),
                ):
                    counts[key] = conn.execute(
                        f"""
                        SELECT COUNT(*) FROM block_line l
                        JOIN block b ON b.block_id = l.block_id
                        WHERE b.page_id IN ({marks}) AND l.diff_ack = ?
                        """,
                        (*page_ids, ack),
                    ).fetchone()[0]
        except Exception:  # noqa: BLE001 - 老库没有 ack 列时按 0
            counts["diff_kept"] = 0
            counts["diff_adopted"] = 0
    return counts


# ---------------------------------------------------------------- 收尾面板汇总（任务 66）

def _margin_effective(project, page) -> bool:
    """版心是否有生效框（收尾面板口径，不要求默认版心是人工设置）。

    - `none`：明确不适用，算已定；
    - `custom` / `auto`：有本页落库框（`fit` 或 `bbox`）才算；
      `auto` 没有框 = 未定，**不拿项目默认框顶替**（任务 33）；
    - `inherit`：有项目默认版心。
    """
    if page.margin_box_mode == "none":
        return True
    if page.margin_box_mode == "auto":
        return page.margin_box is not None
    if page.margin_box is not None:
        return True
    return project.margin_box is not None


def review_tree(project_id: str, *, library: Path | None = None) -> dict:
    """审校左栏那棵树的数据（任务 45 / H 刀）：回目 + 全书每一页的差异计数。

    与 `/review/pending` 的区别：pending 只返回"有理由"的页，表达不了
    「这页 0 处差异」。树要的是**每一页**的未裁决 / 已裁决数，前端才能把
    无差异页只留一行页码。

    回目来自目录索引（`page_index`，第 C 刀）；没有章首时 `chapters=[]`，
    前端平铺页列表，不造假分组。
    """
    pages = library_module.list_pages(project_id, library=library)
    divergences = blocks_module.page_divergences(project_id, library=library)
    try:
        index = page_index_module.build_page_index(project_id, library=library)
    except Exception:  # noqa: BLE001 - 索引是旁路，坏了不影响树
        index = {"chapters": []}

    chapters: list[dict] = []
    for item in index.get("chapters") or []:
        printed = item.get("printed") or []
        chapters.append(
            {
                "id": f"c{len(chapters)}",
                "title": item.get("title") or "",
                "printed_page": printed[0] if printed else None,
                "page_from": int(item.get("page_no") or 0),
                "page_to": None,
            }
        )
    last_page_no = pages[-1].page_no if pages else 0
    for i, chapter in enumerate(chapters):
        chapter["page_to"] = (
            chapters[i + 1]["page_from"] - 1
            if i + 1 < len(chapters)
            else last_page_no
        )

    def chapter_of(page_no: int) -> str | None:
        current = None
        for chapter in chapters:
            if chapter["page_from"] <= page_no:
                current = chapter["id"]
            else:
                break
        return current

    # 队列口径与阅读流 / 收尾面板同一个函数：正文块 + 版心内 + 实质差异行
    queue = queue_items(project_id, library=library)
    rows: list[dict] = []
    for page in pages:
        divergence = divergences.get(page.page_id)
        counts = queue["per_page"].get(page.page_no) or {}
        rows.append(
            {
                "page_no": page.page_no,
                "chapter": chapter_of(page.page_no),
                "unacked": int(counts.get("unacked") or 0),
                "total": int(counts.get("total") or 0),
                "acked": int(counts.get("acked") or 0),
                "checked": bool(divergence.checked) if divergence else False,
                "included": bool(page.include),
            }
        )
    return {
        "chapters": chapters,
        "pages": rows,
        "stats": {
            "pages": len(rows),
            "chapters": len(chapters),
            "unacked": queue["totals"]["unacked"],
            "total_items": queue["totals"]["total"],
            "acked": queue["totals"]["acked"],
            "outside_items": queue["totals"]["outside"],
            "other_items": queue["totals"]["other_types"],
        },
    }


#: 阅读审校队列的块类型：与导出正文同一集合（脚注 / 图注不进连续正文流）
QUEUE_BLOCK_TYPES = frozenset({"paragraph", "heading"})


def _is_page_number_mark(mark, line_by_index: dict) -> bool:
    """这条差异是不是"整行就是页码"那种噪声（只影响显示与计数，不改数据）。"""
    line = line_by_index.get(getattr(mark, "line_index", -1))
    if line is None:
        return False
    return header_cleanup.is_page_number_noise(
        getattr(line, "text", "") or "",
        getattr(line, "bbox", None),
        first_line=getattr(mark, "line_index", -1) == 0,
    )


def queue_items(
    project_id: str,
    *,
    library: Path | None = None,
    index: "blocks_module.DivergenceIndex | None" = None,
) -> dict:
    """审校队列的**唯一**统计口径（左树 / 顶栏分母 / 收尾面板三处共用）。

    集合 = 正文块（paragraph / heading）+ 版心内 + 有第二引擎文本的实质差异行
    （汉字级 / 标点级，`format_only` 不算——它没有可看的差别）。

    另外单独给出"版心外"的实质差异行数：它们不进队列，但要让用户看得见。
    返回 per_page（页面 → 队列内的未裁决数 / 总数）与汇总。
    """
    target_library = library if library is not None else library_module.default_library_dir()
    # 任务 62：能共用收尾面板算好的索引就共用（块级分歧只算一次）
    idx = index or blocks_module.divergence_index(project_id, library=target_library)
    project = idx.project
    pages = list(idx.pages.values())
    page_by_no = {page.page_no: page for page in pages}
    blocks = list(idx.blocks)
    lines_by_block = idx.lines_by_block
    per_page: dict[int, dict] = {}
    totals = {
        "total": 0,
        "unacked": 0,
        "acked": 0,
        "outside": 0,
        "other_types": 0,
        # 分两类：含汉字差异 / 纯标点差异。显示分开、判定合并（D-096 / 2026-10-28 拍板）：
        # 标点可以按模式批量裁决，但"没判"不能算完成。
        "chars_total": 0,
        "chars_unacked": 0,
        "punct_total": 0,
        "punct_unacked": 0,
    }
    for block in blocks:
        if not block.include:
            continue
        if block.block_type not in QUEUE_BLOCK_TYPES:
            divergence = idx.by_block.get(block.block_id) or blocks_module.EMPTY_BLOCK_DIVERGENCE
            other = divergence.chars + divergence.punct
            if other:
                totals["other_types"] += other
            continue
        page = page_by_no.get(block.page_no)
        if page is None:
            continue
        divergence = idx.by_block.get(block.block_id) or blocks_module.EMPTY_BLOCK_DIVERGENCE
        # **按 marks 数，不按 divergence.chars / punct 数**：后两者只统计"未裁决"的行，
        # 一个块的差异全裁完就会变成 0，于是这些行连"已裁决"都统计不到
        # （2026-10-28 实测：899 行汉字差异全标 kept 后 total 掉到 724、acked 只有 354）。
        # marks 里已裁决的行**仍然在**（审计要看），所以 total = 全部差异行、
        # acked = 其中已裁决的、unacked = 剩下的。
        marks = [
            mark
            for mark in divergence.marks
            if mark.level in (compare_module.DIFFERS_CHARS, compare_module.DIFFERS_PUNCT)
        ]
        # 任务 82：**整行就是页码**的差异不进队列（`Page xxi` vs `Page xx1`、
        # 裸露的 `ix`、OCR 把 `76` 认成的 `7b`）。让用户在罗马数字大小写上做决定
        # 是纯噪声；数据一个字都不动，只是不显示。
        if marks:
            line_by_index = {line.line_index: line for line in lines_by_block.get(block.block_id, [])}
            marks = [
                mark
                for mark in marks
                if not _is_page_number_mark(mark, line_by_index)
            ]
        if not marks:
            continue
        if not idx.inside(block):
            totals["outside"] += len(marks)
            continue
        acked_here = sum(1 for mark in marks if mark.ack)
        entry = per_page.setdefault(
            block.page_no, {"page_no": block.page_no, "total": 0, "unacked": 0, "acked": 0}
        )
        entry["total"] += len(marks)
        entry["acked"] += acked_here
        entry["unacked"] += len(marks) - acked_here
        totals["total"] += len(marks)
        totals["acked"] += acked_here
        totals["unacked"] += len(marks) - acked_here
        for mark in marks:
            if mark.level == compare_module.DIFFERS_CHARS:
                totals["chars_total"] += 1
                if not mark.ack:
                    totals["chars_unacked"] += 1
            else:
                totals["punct_total"] += 1
                if not mark.ack:
                    totals["punct_unacked"] += 1
    return {"per_page": per_page, "totals": totals, "pages": len(per_page)}


#: 收尾面板 payload 的结构版本；**改了字段或语义就 +1**
FINISH_CACHE_VERSION = 3

_FINISH_CACHE: dict[str, tuple[str, dict]] = {}
"""收尾面板结果缓存：项目 → (签名, 结果)。

签名用 `project.updated_at` + **`project.db` / `project.db-wal` 的 mtime**。
只要有任何写入提交，SQLite 文件的 mtime 就会变（WAL 模式下看 `-wal`），
所以不需要给每个写入方加"版本号"，也不会出现"同一秒内改了却拿旧结果"。
读一次 `stat()` 是微秒级，换来 2.4 s → ~0 ms。
"""


def _finish_cache_path(project_id: str, library: Path) -> Path:
    return library_module.project_dir(library, project_id) / "cache" / "finish-summary.json"


def _read_finish_cache_any(project_id: str, library: Path) -> dict | None:
    """读磁盘上的收尾面板快照，**不校验签名**（只给"识别进行中先用旧值"用）。"""
    path = _finish_cache_path(project_id, library)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    data = payload.get("payload") if isinstance(payload, dict) else None
    return data if isinstance(data, dict) else None


def _read_finish_cache(project_id: str, library: Path, signature: str) -> dict | None:
    """读磁盘上的收尾面板结果（任务 63：跨进程也秒回）。

    Chief 的建议：收尾面板只是几个计数，没必要每次开机都重算 2.8 s。
    这里把 `{signature, payload}` 写到 `<项目>/cache/finish-summary.json`；
    `signature` 是项目 `updated_at` + 数据库文件 mtime，任何写入都会让它对不上。
    """
    if not signature:
        return None
    path = _finish_cache_path(project_id, library)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("signature") != signature:
        return None
    data = payload.get("payload")
    return data if isinstance(data, dict) else None


def _write_finish_cache(
    project_id: str, library: Path, signature: str, payload: dict
) -> None:
    if not signature:
        return
    path = _finish_cache_path(project_id, library)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(path.name + ".tmp")
        temp.write_text(
            json.dumps({"signature": signature, "payload": payload}, ensure_ascii=False),
            encoding="utf-8",
        )
        os.replace(temp, path)
    except OSError:
        # 写不进去只是少一次缓存，不影响正确性
        pass


def _finish_signature(project_id: str, library: Path) -> str:
    try:
        project = library_module.load_project(project_id, library=library)
        updated = project.updated_at
    except library_module.ProjectError:
        return ""
    directory = library_module.project_dir(library, project_id)
    # 结构版本号：payload 的**形状**变了（加字段 / 改语义）也要让磁盘缓存失效，
    # 否则升级后第一次打开会读到旧形状的快照（实测：目录步还显示旧的"完成"）。
    return f"v{FINISH_CACHE_VERSION}|{updated}|{db_module.content_signature(directory)}"


_FINISH_CACHE_AT: dict[str, float] = {}


def _cache_age(project_id: str) -> float:
    """这份收尾面板结果放了多久（秒）；没缓存过就是极大值。"""
    stamp = _FINISH_CACHE_AT.get(project_id)
    if stamp is None:
        return float("inf")
    return max(0.0, time.monotonic() - stamp)


def _stale_snapshot(payload: dict, computed_at: float | None) -> dict:
    """把缓存里的收尾面板结果标成"旧快照"返回（不改缓存本身）。"""
    served_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    age = None if computed_at is None else round(max(0.0, time.monotonic() - computed_at), 1)
    return {**payload, "stale": True, "served_at": served_at, "stale_age_seconds": age}


def finish_summary(project_id: str, *, library: Path | None = None) -> dict:
    """收尾面板的六个状态：全部从数据库实时聚合，不依赖前端估算。

    「审校」行同时给"可直接通过"与"要人看"的数量：
    可直接通过 = 正文页里识别成功、无建议 / 无分歧 / 无漏行 / 版面已确认 /
    版心已定 / 第二引擎已复核、且还没有确认过的页；其余未确认正文页算要人看。

    「审校」完成还要跨页延续的第三桶为 0（任务 42）：自动判定判不了的
    16 处页边界只要还有人没看，这一步就不算完——否则那 16 处段落错误没人知道。
    """
    target_library = library if library is not None else library_module.default_library_dir()
    # 任务 69：识别在跑的整个过程中，**一律返回旧快照，不再重算**。
    # 识别每认完一页都写库，签名每 3–5 秒变一次；662 页整本重算空闲 340 ms、
    # 有负载时 3.5 s——为了步骤条上几个此刻没人盯的数字，去跟识别抢几十次核，不值得。
    #
    # 所以"有没有任务在跑"这个判断放在**最前面**：命中就直接返回快照，
    # 连签名（要 `load_project` + stat 库文件）都不算——那两个动作在识别写库时
    # 会被 SQLite 写锁拖到 100–400 ms，正是上一版毛刺的来源。
    # 任务一结束判断变假，走下面的正常路径，第一次请求就是真实值。
    if cache_policy.can_serve_stale(project_id, target_library):
        snapshot = _FINISH_CACHE.get(project_id)
        served_at = _FINISH_CACHE_AT.get(project_id)
        if snapshot is None:
            # 进程刚起、内存里还没有：磁盘上那份快照就算签名不匹配也先拿来用
            disk_any = _read_finish_cache_any(project_id, target_library)
            if disk_any is not None:
                _FINISH_CACHE[project_id] = ("", disk_any)
                _FINISH_CACHE_AT[project_id] = time.monotonic()
                snapshot = ("", disk_any)
                served_at = _FINISH_CACHE_AT[project_id]
        if snapshot is not None:
            return _stale_snapshot(snapshot[1], served_at)
    signature = _finish_signature(project_id, target_library)
    cached = _FINISH_CACHE.get(project_id)
    if cached and signature and cached[0] == signature:
        return cached[1]
    disk = _read_finish_cache(project_id, target_library, signature)
    if disk is not None:
        _FINISH_CACHE[project_id] = (signature, disk)
        _FINISH_CACHE_AT[project_id] = time.monotonic()
        return disk
    pages = library_module.list_pages(project_id, library=library)
    project = _project(project_id, library)
    states = blocks_module.page_recognition_states(project_id, library=library)
    # 任务 62：块级分歧只算**一次**，收尾 / 队列 / 标点分组共用这份索引
    idx = blocks_module.divergence_index(project_id, library=library)
    divergences = idx.by_page
    aux = blocks_module.pages_with_auxiliary_run(project_id, library=library)
    workflow = workflow_module.project_workflow(project_id, library=library)
    wf_by_no = {item["page_no"]: item for item in workflow["pages"]}
    pending = project_pending(project_id, library=library, divergences=divergences)
    pending_nos = {item["page_no"] for item in pending["pages"]}
    continuation = continuations_module.pending(project_id, library=library)

    body_pages = [page for page in pages if page.include]
    confirmed_pages = sum(1 for page in pages if page.page_confirmed)
    layout_done = sum(1 for page in body_pages if page.layout_confirmed)

    margin_done = sum(1 for page in body_pages if _margin_effective(project, page))
    # 任务 33：兜底不再是"回退默认版心"，而是"本页包围盒"；没有框的页是"未定"。
    # 刀 1（2026-10-27）：分母只算**正文页**（37 个非正文页不进），否则步骤条永远
    # 绿不了；「无文字」的页（插图 / 空白）标"跳过"，不算未定，也不挡完成。
    text_pages = blocks_module.pages_with_text(project_id, library=library)
    fallback_pages = [
        page.page_no
        for page in body_pages
        if page.margin_box_mode == "auto" and page.margin_box is not None
        and getattr(page, "margin_box_method", None) == "bbox"
    ]
    no_text_pages = [
        page.page_no
        for page in body_pages
        if page.margin_box_mode == "auto"
        and page.margin_box is None
        and page.page_id not in text_pages
        # 只有识别真的跑过、且结果确实没有字，才算"无文字，跳过"；
        # 从没识别过的页是未定（鹿鼎记 474 页就是这种情况，不能算跳过）。
        and (states.get(page.page_id) is not None)
        and states[page.page_id].status
        in (blocks_module.STATUS_RECOGNIZED, blocks_module.STATUS_HAS_CANDIDATE)
    ]
    no_text_nos = set(no_text_pages)
    undetermined_pages = [
        page.page_no
        for page in body_pages
        if page.margin_box_mode == "auto"
        and page.margin_box is None
        and page.page_no not in no_text_nos
    ]
    # "已定"= 正文页有生效版心，或这一页本来就没有字（跳过）
    margin_settled = margin_done + len(no_text_pages)
    margin_total = len(body_pages)

    auto_passable = []
    confirmed_body = 0
    for page in body_pages:
        wf = wf_by_no.get(page.page_no) or {}
        if wf.get("confirm_mode") in (
            workflow_module.CONFIRM_HUMAN,
            workflow_module.CONFIRM_AUTO,
        ):
            confirmed_body += 1
            continue
        state = states.get(page.page_id)
        if (
            state is not None
            and state.status == blocks_module.STATUS_RECOGNIZED
            and not wf.get("auto_pass_excluded")
            and page.page_no not in pending_nos
        ):
            auto_passable.append(page.page_no)
    needs_human = [
        page.page_no
        for page in body_pages
        if (wf_by_no.get(page.page_no) or {}).get("confirm_mode")
        not in (workflow_module.CONFIRM_HUMAN, workflow_module.CONFIRM_AUTO)
        and page.page_no not in set(auto_passable)
    ]

    try:
        pn_state = page_numbers_module.page_number_state(project_id, library=library)
    except Exception:  # noqa: BLE001 - 页码是旁路，读不到不影响收尾
        pn_state = {"template": None, "ranges": [], "filled": 0, "total": len(pages)}
    pn_done = bool(pn_state.get("template") or pn_state.get("ranges"))
    # 任务 37（C 刀）：目录确认 = 页码跳转索引生成成功。只给计数，明细走 /page-index。
    try:
        index_state = page_index_module.page_index_summary(project_id, library=library)
    except Exception:  # noqa: BLE001 - 索引坏了不该拖垮收尾面板
        index_state = {
            "total": len(pages),
            "numbered": 0,
            "missing": len(pages),
            "chapters": 0,
            "numbering_step": 1,
            "page_order_only": True,
            "complete": False,
        }

    checked_pages = [page.page_no for page in body_pages if page.page_id in aux]
    # 完成判定只看**主引擎**（任务 58）：第二引擎是给审校的定位信号，
    # 不能让 41 分钟的可选任务把版心 / 目录 / 审校全卡成灰。
    main_done = sum(
        1
        for page in body_pages
        if (states.get(page.page_id) is not None)
        and states[page.page_id].status
        in (blocks_module.STATUS_RECOGNIZED, blocks_module.STATUS_HAS_CANDIDATE)
    )
    compared = identical = format_only = chars = punct = empty = 0
    for page in body_pages:
        divergence = divergences.get(page.page_id)
        if divergence is None:
            continue
        identical += divergence.identical
        format_only += divergence.format_only
        chars += divergence.chars
        punct += divergence.punct
        empty += divergence.empty
    compared = identical + format_only + chars + punct
    diverging_rate = round((chars + punct) / compared, 4) if compared else 0.0

    queue = queue_items(project_id, library=library, index=idx)
    complete = [
        confirmed_pages == len(pages),
        margin_settled >= margin_total,
        layout_done == len(body_pages),
        pn_done,
        len(auto_passable) == 0
        and len(needs_human) == 0
        and continuation["count"] == 0
        # 整条审校队列（汉字差异 + 标点差异）都必须有裁决。标点可以按模式批量判，
        # 但"没判"不能算完成——否则主队列清零、步骤变绿，几百行标点差异没人看过。
        and queue["totals"]["unacked"] == 0,
        main_done == len(body_pages),
    ]
    result = {
        "project": {"project_id": project_id, "name": project.name},
        "page_type": {
            "confirmed": confirmed_pages,
            "total": len(pages),
            "complete": complete[0],
        },
        "margin": {
            "set": margin_settled,
            "total": margin_total,
            # 迁移 0025：这本书有没有真的生成过版心。「未开始」不能靠"没有框"推——
            # 从没开始与"跑过但一页也没拟出来"在页数据上长得一样。
            "fit_started": bool(getattr(project, "margin_fit_at", None)),
            "fit_at": getattr(project, "margin_fit_at", None),
            # 正文页里有框的页数（任何 mode）。界面用它判「未开始」：
            # fit_started=false 且一个框都没有 ⇒ 还没生成过；有框就是历史数据。
            "with_box": sum(1 for page in body_pages if page.margin_box is not None),
            "fallback": len(fallback_pages),
            "fallback_pages": fallback_pages,
            "no_text": len(no_text_pages),
            "no_text_pages": no_text_pages,
            "undetermined": len(undetermined_pages),
            "undetermined_pages": undetermined_pages,
            "complete": complete[1],
        },
        "layout": {
            "confirmed": layout_done,
            "total": len(body_pages),
            "remaining": len(body_pages) - layout_done,
            "pending_pages": [page.page_no for page in body_pages if not page.layout_confirmed],
            "complete": complete[2],
        },
        "page_numbers": {
            "located": pn_done,
            "template": pn_state.get("template"),
            "filled": pn_state.get("filled", 0),
            "total": pn_state.get("total", len(pages)),
            "complete": complete[3],
            "skippable": True,
        },
        "review": {
            "auto_passable": len(auto_passable),
            "auto_passable_pages": auto_passable,
            "needs_human": len(needs_human),
            "needs_human_pages": needs_human,
            "confirmed": confirmed_body,
            "total": len(body_pages),
            # 审校队列的唯一口径（与左树 / 阅读流顶栏同源）：版心内正文差异行
            "total_items": queue["totals"]["total"],
            "pending_items": queue["totals"]["unacked"],
            # 分两类显示（判定仍看上面的合计）
            "chars_total": queue["totals"]["chars_total"],
            "chars_pending": queue["totals"]["chars_unacked"],
            "punct_total": queue["totals"]["punct_total"],
            "punct_pending": queue["totals"]["punct_unacked"],
            "punct_groups": punct_groups_module.group_counts(
                project_id, library=library, index=idx
            ),
            "outside_items": queue["totals"]["outside"],
            "other_items": queue["totals"]["other_types"],
            # 任务 42：F1 第三桶（自动判不了的页边界）——没确认完，审校就不算完成
            "continuation_pending": continuation["count"],
            "continuation_total": continuation["total"],
            "complete": complete[4],
        },
        "index": index_state,
        "engine": {
            "checked": len(checked_pages),
            "total": len(body_pages),
            # 主引擎完整度：识别步的完成判定用它；第二引擎只报进度（可选）
            "main_recognized": main_done,
            "main_complete": main_done == len(body_pages),
            "aux_complete": len(checked_pages) == len(body_pages),
            "compared_lines": compared,
            "diverging_lines": chars + punct,
            "empty_lines": empty,
            "diverging_rate": diverging_rate,
            "complete": complete[5],
        },
        "k": sum(1 for item in complete if item),
        "k_total": 6,
    }
    if signature:
        _FINISH_CACHE[project_id] = (signature, result)
        _FINISH_CACHE_AT[project_id] = time.monotonic()
        _write_finish_cache(project_id, target_library, signature, result)
    return result
