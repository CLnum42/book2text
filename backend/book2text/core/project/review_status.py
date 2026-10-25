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

from pathlib import Path

from . import blocks as blocks_module
from . import ink_gaps as ink_gaps_module
from . import library as library_module
from . import margin_box as margin_box_module
from . import structure as structure_module
from . import workflow as workflow_module
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
    return project.margin_box is not None and project.margin_box_source == margin_box_module.SOURCE_MANUAL


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
    suggestions = structure_module.suggestions_by_page(
        project_id, library=library, page_numbers=[page_no]
    ).get(page_no, ())
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
            ink_count = len(ink.get("candidates") or [])
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


def project_pending(project_id: str, *, library: Path | None = None) -> dict:
    """页面视图的「待处理」：只返回**有理由**的页，并给出理由计数。"""
    pages = library_module.list_pages(project_id, library=library)
    project = _project(project_id, library)
    states = blocks_module.page_recognition_states(project_id, library=library)
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
    suggestion_map = structure_module.suggestions_by_page(
        project_id, library=library, page_numbers=recognized
    )
    items: list[dict] = []
    counts: dict[str, int] = {}
    for page in pages:
        if not page.include:
            continue
        suggestions = suggestion_map.get(page.page_no, ())
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
                ink_count = len(ink.get("candidates") or [])
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
    return counts
