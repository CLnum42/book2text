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
from . import page_numbers as page_numbers_module
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
    if page.margin_box_mode == "auto":
        # 每页自动拟合出来的框算"已定"；行不足、回退默认版心时仍要求默认版心是人工设置。
        if page.margin_box is not None:
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
    - `custom` / `auto`：有本页框；
    - `auto` 行不足或 `inherit`：有项目默认版心；
    """
    if page.margin_box_mode == "none":
        return True
    if page.margin_box is not None:
        return True
    return project.margin_box is not None


def finish_summary(project_id: str, *, library: Path | None = None) -> dict:
    """收尾面板的六个状态：全部从数据库实时聚合，不依赖前端估算。

    「审校」行同时给"可直接通过"与"要人看"的数量：
    可直接通过 = 正文页里识别成功、无建议 / 无分歧 / 无漏行 / 版面已确认 /
    版心已定 / 第二引擎已复核、且还没有确认过的页；其余未确认正文页算要人看。
    """
    pages = library_module.list_pages(project_id, library=library)
    project = _project(project_id, library)
    states = blocks_module.page_recognition_states(project_id, library=library)
    divergences = blocks_module.page_divergences(project_id, library=library)
    aux = blocks_module.pages_with_auxiliary_run(project_id, library=library)
    workflow = workflow_module.project_workflow(project_id, library=library)
    wf_by_no = {item["page_no"]: item for item in workflow["pages"]}
    pending = project_pending(project_id, library=library)
    pending_nos = {item["page_no"] for item in pending["pages"]}

    body_pages = [page for page in pages if page.include]
    confirmed_pages = sum(1 for page in pages if page.page_confirmed)
    layout_done = sum(1 for page in body_pages if page.layout_confirmed)

    margin_done = sum(1 for page in pages if _margin_effective(project, page))
    fallback_pages = [
        page.page_no
        for page in pages
        if page.margin_box_mode == "auto"
        and page.margin_box is None
        and project.margin_box is not None
    ]

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

    checked_pages = [page.page_no for page in body_pages if page.page_id in aux]
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

    complete = [
        confirmed_pages == len(pages),
        margin_done == len(pages),
        layout_done == len(body_pages),
        pn_done,
        len(auto_passable) == 0 and len(needs_human) == 0,
        len(checked_pages) == len(body_pages),
    ]
    return {
        "project": {"project_id": project_id, "name": project.name},
        "page_type": {
            "confirmed": confirmed_pages,
            "total": len(pages),
            "complete": complete[0],
        },
        "margin": {
            "set": margin_done,
            "total": len(pages),
            "fallback": len(fallback_pages),
            "fallback_pages": fallback_pages,
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
            "complete": complete[4],
        },
        "engine": {
            "checked": len(checked_pages),
            "total": len(body_pages),
            "compared_lines": compared,
            "diverging_lines": chars + punct,
            "empty_lines": empty,
            "diverging_rate": diverging_rate,
            "complete": complete[5],
        },
        "k": sum(1 for item in complete if item),
        "k_total": 6,
    }
