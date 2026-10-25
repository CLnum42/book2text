"""页面工作流状态（`docs/workflow.md` 第 2 节）。

**这一刀只做"能记录、能读、能筛"**（任务 58 / 决策 D-073）：

- 版面检测成功 → `detected`；
- 现有识别任务成功 → `ocr1_done`；
- 其余阶段留空（`margin_set` / `ocr2_done` / `diff_done` / `arbitrated` /
  `human_confirmed` / `export_ready` 还没有写入点）。
- **不驱动流程**：识别 / 导出 / 版心 / 页码的行为完全不变。

`page_workflow` 是索引 / 缓存，权威产物仍是 `page` / `layout_run` / `ocr_run` /
`block` 等。`rebuild_page_stage()` 从产物重算"最近连续完成的状态"；
老项目回填按文档 2.2：非正文 `excluded`、正文已确认 `confirmed`，
**不会**因为旧 OCR 块就跳到 `ocr1_done`（旧块继续用于旧导出 / 只读兼容）。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from ..storage import db as db_module
from .library import list_pages, load_project, require_project_dir

# 主链顺序（用户给定）
STAGE_PAGE_UNCONFIRMED = "page_unconfirmed"
STAGE_CONFIRMED = "confirmed"
STAGE_DETECTED = "detected"
STAGE_MARGIN_SET = "margin_set"
STAGE_OCR1_DONE = "ocr1_done"
STAGE_OCR2_DONE = "ocr2_done"
STAGE_DIFF_DONE = "diff_done"
STAGE_ARBITRATED = "arbitrated"
STAGE_HUMAN_CONFIRMED = "human_confirmed"
STAGE_EXPORT_READY = "export_ready"
STAGE_EXCLUDED = "excluded"

MAIN_STAGES = (
    STAGE_PAGE_UNCONFIRMED,
    STAGE_CONFIRMED,
    STAGE_DETECTED,
    STAGE_MARGIN_SET,
    STAGE_OCR1_DONE,
    STAGE_OCR2_DONE,
    STAGE_DIFF_DONE,
    STAGE_ARBITRATED,
    STAGE_HUMAN_CONFIRMED,
    STAGE_EXPORT_READY,
)
STAGES = MAIN_STAGES + (STAGE_EXCLUDED,)
STAGE_RANK = {stage: index for index, stage in enumerate(MAIN_STAGES)}

STAGE_LABELS = {
    STAGE_PAGE_UNCONFIRMED: "待确认页面",
    STAGE_CONFIRMED: "已确认",
    STAGE_DETECTED: "已检测",
    STAGE_MARGIN_SET: "版心已定",
    STAGE_OCR1_DONE: "已识别①",
    STAGE_OCR2_DONE: "已识别②",
    STAGE_DIFF_DONE: "差异已算",
    STAGE_ARBITRATED: "已仲裁",
    STAGE_HUMAN_CONFIRMED: "人工已确认",
    STAGE_EXPORT_READY: "可导出",
    STAGE_EXCLUDED: "不参与",
}

# 这一刀已经会写的阶段；其余阶段留给后续切片
IMPLEMENTED_STAGES = (STAGE_PAGE_UNCONFIRMED, STAGE_CONFIRMED, STAGE_DETECTED, STAGE_OCR1_DONE, STAGE_EXCLUDED)

# 确认方式（迁移 0016）：自动通过与人工确认共用 stage=human_confirmed，靠这一列区分
CONFIRM_HUMAN = "human"
CONFIRM_AUTO = "auto"
CONFIRM_MODES = (CONFIRM_HUMAN, CONFIRM_AUTO)

PAGE_NUMBER_MISSING = "missing"
PAGE_NUMBER_READY = "ready"
PAGE_NUMBER_SKIPPED = "skipped"
PAGE_NUMBER_STATES = (PAGE_NUMBER_MISSING, PAGE_NUMBER_READY, PAGE_NUMBER_SKIPPED)


class WorkflowError(Exception):
    """工作流状态读写失败（页面不存在、阶段未知等）。"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _open(directory: Path):
    if not directory.is_dir() or not db_module.database_path(directory).is_file():
        raise WorkflowError(f"找不到项目数据库：{directory}")
    return db_module.open_database(directory, apply_migrations=False)


def stage_label(stage: str, confirm_mode: str | None = None) -> str:
    """阶段文案；`human_confirmed` 要按确认方式区分，不能把自动通过写成人工确认。"""
    if stage == STAGE_HUMAN_CONFIRMED:
        if confirm_mode == CONFIRM_AUTO:
            return "自动通过（未经人工）"
        if confirm_mode == CONFIRM_HUMAN:
            return "人工已确认"
        return "已确认（来源未知）"
    return STAGE_LABELS.get(stage, stage)


def _initial_stage(page_type: str, page_confirmed: bool) -> str:
    if page_type != "body":
        return STAGE_EXCLUDED
    return STAGE_CONFIRMED if page_confirmed else STAGE_PAGE_UNCONFIRMED


def _project_page_number_state(directory: Path) -> str:
    """项目有没有页码模板 / 范围：有就是旁路 `ready`，否则 `missing`。"""
    with _open(directory) as conn:
        row = conn.execute(
            "SELECT page_number_template, page_number_ranges FROM project LIMIT 1"
        ).fetchone()
    if row is None:
        return PAGE_NUMBER_MISSING
    template = row["page_number_template"]
    ranges = row["page_number_ranges"]
    if template or (ranges and ranges not in ("", "[]", "null")):
        return PAGE_NUMBER_READY
    return PAGE_NUMBER_MISSING


def backfill_project(project_id: str, *, library: Path | None = None) -> int:
    """给没有状态行的页面补一条初始状态（只插不改），返回新增条数。

    在打开主项目时调用。已经有的行**一律不动**：重复打开不能把进度打回去。
    """
    directory = require_project_dir(project_id, library=library)
    load_project(project_id, library=library)
    number_state = _project_page_number_state(directory)
    pages = list_pages(project_id, library=library)
    now = _now()
    inserted = 0
    with _open(directory) as conn:
        for page in pages:
            exists = conn.execute(
                "SELECT 1 FROM page_workflow WHERE page_id = ?", (page.page_id,)
            ).fetchone()
            if exists:
                continue
            stage = _initial_stage(page.page_type, page.page_confirmed)
            conn.execute(
                """
                INSERT INTO page_workflow (
                    page_id, stage, failed_stage, failure_reason, stage_times_json,
                    page_number_state, revision, updated_at
                ) VALUES (?, ?, NULL, NULL, ?, ?, 0, ?)
                """,
                (
                    page.page_id,
                    stage,
                    json.dumps({stage: now}, ensure_ascii=False),
                    number_state,
                    now,
                ),
            )
            inserted += 1
        conn.commit()
    return inserted


def _ensure_row(conn, page_id: str) -> None:
    row = conn.execute(
        "SELECT 1 FROM page_workflow WHERE page_id = ?", (page_id,)
    ).fetchone()
    if row is not None:
        return
    page = conn.execute(
        "SELECT page_type, page_confirmed FROM page WHERE page_id = ?", (page_id,)
    ).fetchone()
    if page is None:
        raise WorkflowError(f"没有这一页：{page_id}")
    stage = _initial_stage(page["page_type"], bool(page["page_confirmed"]))
    now = _now()
    conn.execute(
        """
        INSERT INTO page_workflow (
            page_id, stage, failed_stage, failure_reason, stage_times_json,
            page_number_state, revision, updated_at
        ) VALUES (?, ?, NULL, NULL, ?, ?, 0, ?)
        """,
        (page_id, stage, json.dumps({stage: now}, ensure_ascii=False), PAGE_NUMBER_MISSING, now),
    )


def record_stage(directory: Path, page_id: str, stage: str) -> str:
    """记一个阶段完成，返回记录后的 `stage`。

    **只前进，不回退**：`stage` 取已完成阶段里最靠后的一个；每段完成时间都
    合并进 `stage_times_json`（这样"已识别①但没检测"这种跳步也能看出来）。
    """
    if stage not in STAGES:
        raise WorkflowError(f"未知的工作流阶段：{stage!r}")
    now = _now()
    with _open(directory) as conn:
        _ensure_row(conn, page_id)
        row = conn.execute(
            "SELECT stage, stage_times_json FROM page_workflow WHERE page_id = ?",
            (page_id,),
        ).fetchone()
        current = row["stage"]
        try:
            times = json.loads(row["stage_times_json"] or "{}")
        except json.JSONDecodeError:
            times = {}
        if not isinstance(times, dict):
            times = {}
        times.setdefault(stage, now)
        new_stage = current
        if stage != STAGE_EXCLUDED and current != STAGE_EXCLUDED:
            if STAGE_RANK[stage] > STAGE_RANK.get(current, -1):
                new_stage = stage
        conn.execute(
            """
            UPDATE page_workflow
            SET stage = ?, failed_stage = NULL, failure_reason = NULL,
                stage_times_json = ?, revision = revision + 1, updated_at = ?
            WHERE page_id = ?
            """,
            (new_stage, json.dumps(times, ensure_ascii=False), now, page_id),
        )
        conn.commit()
    return new_stage


def record_stages(directory: Path, page_ids, stage: str) -> None:
    """批量记阶段；单页失败不影响其他页（调用方决定是否记日志）。"""
    for page_id in page_ids:
        record_stage(directory, page_id, stage)


def record_failure(directory: Path, page_id: str, failed_stage: str, reason: str) -> None:
    """记失败阶段与原因。**不改变 `stage`**（失败不等于倒退）。"""
    if failed_stage not in STAGES:
        raise WorkflowError(f"未知的工作流阶段：{failed_stage!r}")
    now = _now()
    with _open(directory) as conn:
        _ensure_row(conn, page_id)
        conn.execute(
            """
            UPDATE page_workflow
            SET failed_stage = ?, failure_reason = ?, revision = revision + 1,
                updated_at = ?
            WHERE page_id = ?
            """,
            (failed_stage, reason[:1000], now, page_id),
        )
        conn.commit()


def clear_failure(directory: Path, page_id: str) -> None:
    with _open(directory) as conn:
        conn.execute(
            "UPDATE page_workflow SET failed_stage = NULL, failure_reason = NULL,"
            " revision = revision + 1, updated_at = ? WHERE page_id = ?",
            (_now(), page_id),
        )
        conn.commit()


def set_confirmation(
    directory: Path, page_id: str, mode: str, *, actor_name: str | None = None
) -> str:
    """把页面记成已确认：``human`` 或 ``auto``。

    **只写状态，不改任何块文本 / 类型 / 框。** 自动通过也用这个函数，
    但 `confirm_mode` 必须是 ``auto``，界面据此显示"自动通过（未经人工）"。
    """
    if mode not in CONFIRM_MODES:
        raise WorkflowError(f"未知的确认方式：{mode!r}")
    now = _now()
    with _open(directory) as conn:
        _ensure_row(conn, page_id)
        row = conn.execute(
            "SELECT stage, stage_times_json FROM page_workflow WHERE page_id = ?",
            (page_id,),
        ).fetchone()
        if row["stage"] == STAGE_EXCLUDED:
            raise WorkflowError("非正文页不参与确认")
        try:
            times = json.loads(row["stage_times_json"] or "{}")
        except json.JSONDecodeError:
            times = {}
        if not isinstance(times, dict):
            times = {}
        times["human_confirmed"] = now
        conn.execute(
            """
            UPDATE page_workflow
            SET stage = ?, confirm_mode = ?, confirmed_at = ?, auto_pass_excluded = 0,
                failed_stage = NULL, failure_reason = NULL, stage_times_json = ?,
                revision = revision + 1, updated_at = ?
            WHERE page_id = ?
            """,
            (
                STAGE_HUMAN_CONFIRMED,
                mode,
                now,
                json.dumps(times, ensure_ascii=False),
                now,
                page_id,
            ),
        )
        conn.commit()
    return STAGE_HUMAN_CONFIRMED


def revoke_auto_pass(directory: Path, page_id: str) -> str:
    """撤销自动通过：回到重算后的阶段，并标记不再自动通过。只写状态。"""
    with _open(directory) as conn:
        _ensure_row(conn, page_id)
        row = conn.execute(
            "SELECT confirm_mode FROM page_workflow WHERE page_id = ?", (page_id,)
        ).fetchone()
        if row["confirm_mode"] != CONFIRM_AUTO:
            raise WorkflowError("这一页不是自动通过状态，不能撤销自动通过")
        conn.execute(
            """
            UPDATE page_workflow
            SET stage = ?, confirm_mode = NULL, confirmed_at = NULL,
                auto_pass_excluded = 1, revision = revision + 1, updated_at = ?
            WHERE page_id = ?
            """,
            (STAGE_OCR1_DONE, _now(), page_id),
        )
        conn.commit()
    # 用产物重算一版更准确的阶段（例如没有检测行时回到 confirmed）
    return rebuild_page_stage(directory, page_id)


def rebuild_page_stage(directory: Path, page_id: str) -> str:
    """按权威产物重算这一页"最近连续完成的状态"。

    - 非正文 → `excluded`；
    - 正文未确认 → `page_unconfirmed`，已确认 → `confirmed`；
    - 有成功的 `layout_run` → `detected`；
    - **连续**要求已检测且 `page.active_run_id` 指向成功的主运行 → `ocr1_done`
      （所以老项目里"有旧 OCR 块但没检测"的页回填后停在 `confirmed`，
      与 `docs/workflow.md` 2.2 一致）。
    - 更后面的阶段还没有产物写入点，不在这里伪造。
    """
    with _open(directory) as conn:
        page = conn.execute(
            "SELECT page_type, page_confirmed, active_run_id FROM page WHERE page_id = ?",
            (page_id,),
        ).fetchone()
        if page is None:
            raise WorkflowError(f"没有这一页：{page_id}")
        stage = _initial_stage(page["page_type"], bool(page["page_confirmed"]))
        detected = conn.execute(
            "SELECT 1 FROM layout_run WHERE page_id = ? AND status = 'succeeded' LIMIT 1",
            (page_id,),
        ).fetchone()
        if detected is not None and stage != STAGE_EXCLUDED:
            stage = STAGE_DETECTED
            if page["active_run_id"]:
                run = conn.execute(
                    "SELECT status FROM ocr_run WHERE run_id = ?",
                    (page["active_run_id"],),
                ).fetchone()
                if run is not None and run["status"] == "succeeded":
                    stage = STAGE_OCR1_DONE
        now = _now()
        row = conn.execute(
            "SELECT stage_times_json, stage, confirm_mode FROM page_workflow WHERE page_id = ?",
            (page_id,),
        ).fetchone()
        # 已经人工确认 / 自动通过的页不因为一次重算被降级；撤销自动通过走 revoke_auto_pass。
        if row is not None and row["stage"] == STAGE_HUMAN_CONFIRMED and row["confirm_mode"]:
            stage = STAGE_HUMAN_CONFIRMED
        try:
            times = json.loads(row["stage_times_json"] or "{}") if row else {}
        except json.JSONDecodeError:
            times = {}
        if not isinstance(times, dict):
            times = {}
        times.setdefault(stage, now)
        _ensure_row(conn, page_id)
        conn.execute(
            """
            UPDATE page_workflow
            SET stage = ?, stage_times_json = ?, revision = revision + 1, updated_at = ?
            WHERE page_id = ?
            """,
            (stage, json.dumps(times, ensure_ascii=False), now, page_id),
        )
        conn.commit()
    return stage


def latest_layout_run(directory: Path, page_id: str) -> dict | None:
    """这一页最近一次**成功**的检测运行（没有则 None）。"""
    with _open(directory) as conn:
        row = conn.execute(
            """
            SELECT run_id, engine_id, engine_version, params_json, line_count,
                   elapsed_seconds, raw_result_path, created_at
            FROM layout_run
            WHERE page_id = ? AND status = 'succeeded'
            ORDER BY created_at DESC, rowid DESC LIMIT 1
            """,
            (page_id,),
        ).fetchone()
    return dict(row) if row is not None else None


def _layout_map(conn) -> dict[str, dict]:
    """每页最近一次成功检测的摘要（一次查询，不做 N+1）。"""
    rows = conn.execute(
        """
        SELECT l.page_id, l.run_id, l.line_count, l.created_at, l.engine_id
        FROM layout_run l
        WHERE l.status = 'succeeded'
          AND NOT EXISTS (
              SELECT 1 FROM layout_run newer
              WHERE newer.page_id = l.page_id AND newer.status = 'succeeded'
                AND (newer.created_at > l.created_at
                     OR (newer.created_at = l.created_at AND newer.rowid > l.rowid))
          )
        """
    ).fetchall()
    return {
        row["page_id"]: {
            "run_id": row["run_id"],
            "line_count": int(row["line_count"]),
            "detected_at": row["created_at"],
            "engine_id": row["engine_id"],
        }
        for row in rows
    }


def project_workflow(
    project_id: str,
    *,
    library: Path | None = None,
    stage: str | None = None,
    failed: bool | None = None,
    page_number_state: str | None = None,
) -> dict:
    """页面状态列表 + 各状态数量 + 摘要。

    没有状态行的页按页面类型 / 确认状态**派生默认值**，所以即使还没打开过项目
    （没跑回填），接口也不会漏页。筛选在服务端做，界面也用它做角标。
    """
    if stage is not None and stage not in STAGES:
        raise WorkflowError(f"未知的工作流阶段：{stage!r}")
    if page_number_state is not None and page_number_state not in PAGE_NUMBER_STATES:
        raise WorkflowError(f"未知的页码旁路状态：{page_number_state!r}")
    directory = require_project_dir(project_id, library=library)
    pages = list_pages(project_id, library=library)
    with _open(directory) as conn:
        rows = conn.execute("SELECT * FROM page_workflow").fetchall()
        layouts = _layout_map(conn)
    stored = {row["page_id"]: row for row in rows}
    counts = {name: 0 for name in STAGES}
    items: list[dict] = []
    for page in pages:
        row = stored.get(page.page_id)
        if row is not None:
            page_stage = row["stage"]
            failed_stage = row["failed_stage"]
            failure_reason = row["failure_reason"]
            try:
                times = json.loads(row["stage_times_json"] or "{}")
            except json.JSONDecodeError:
                times = {}
            number_state = row["page_number_state"]
            updated_at = row["updated_at"]
            confirm_mode = row["confirm_mode"]
            confirmed_at = row["confirmed_at"]
            auto_pass_excluded = bool(row["auto_pass_excluded"])
        else:
            page_stage = _initial_stage(page.page_type, page.page_confirmed)
            failed_stage = None
            failure_reason = None
            times = {}
            number_state = PAGE_NUMBER_MISSING
            updated_at = None
            confirm_mode = None
            confirmed_at = None
            auto_pass_excluded = False
        counts[page_stage] = counts.get(page_stage, 0) + 1
        layout = layouts.get(page.page_id)
        item = {
            "page_id": page.page_id,
            "page_no": page.page_no,
            "page_type": page.page_type,
            "include": page.include,
            "stage": page_stage,
            "stage_label": stage_label(page_stage, confirm_mode),
            "confirm_mode": confirm_mode,
            "confirmed_at": confirmed_at,
            "auto_pass_excluded": auto_pass_excluded,
            "failed_stage": failed_stage,
            "failed_stage_label": stage_label(failed_stage) if failed_stage else None,
            "failure_reason": failure_reason,
            "stage_times": times,
            "page_number_state": number_state,
            "layout": layout,
            "updated_at": updated_at,
        }
        if stage is not None and page_stage != stage:
            continue
        if failed is True and not failed_stage:
            continue
        if failed is False and failed_stage:
            continue
        if page_number_state is not None and number_state != page_number_state:
            continue
        items.append(item)

    body = [item for item in items if item["include"]]
    detected = [
        item
        for item in body
        if item["layout"] is not None
        and STAGE_RANK.get(item["stage"], -1) >= STAGE_RANK[STAGE_DETECTED]
    ]
    recognized = [
        item
        for item in body
        if STAGE_RANK.get(item["stage"], -1) >= STAGE_RANK[STAGE_OCR1_DONE]
    ]
    failed_pages = [item for item in items if item["failed_stage"]]
    auto_passed = [
        item
        for item in items
        if item["stage"] == STAGE_HUMAN_CONFIRMED
        and item["confirm_mode"] == CONFIRM_AUTO
    ]
    human_confirmed = [
        item
        for item in items
        if item["stage"] == STAGE_HUMAN_CONFIRMED
        and item["confirm_mode"] == CONFIRM_HUMAN
    ]
    return {
        "count": len(items),
        "pages": items,
        "counts": counts,
        "confirmation_counts": {
            "human": len(human_confirmed),
            "auto": len(auto_passed),
            "unknown": sum(
                1
                for item in items
                if item["stage"] == STAGE_HUMAN_CONFIRMED and item["confirm_mode"] is None
            ),
        },
        "summary": {
            "total": len(items),
            "body": len(body),
            "detected": len(detected),
            "ocr1_done": len(recognized),
            "failed": len(failed_pages),
            "auto_passed": len(auto_passed),
            "human_confirmed": len(human_confirmed),
            "unfinished": sum(
                1
                for item in items
                if item["stage"] in (STAGE_PAGE_UNCONFIRMED, STAGE_CONFIRMED, STAGE_DETECTED)
            ),
        },
    }


def page_workflow(directory: Path, page_id: str) -> dict | None:
    """单页状态（任务 / 测试用；界面走 `project_workflow`）。"""
    with _open(directory) as conn:
        row = conn.execute(
            "SELECT * FROM page_workflow WHERE page_id = ?", (page_id,)
        ).fetchone()
    if row is None:
        return None
    data = dict(row)
    try:
        data["stage_times"] = json.loads(data.pop("stage_times_json") or "{}")
    except json.JSONDecodeError:
        data["stage_times"] = {}
    data["stage_label"] = stage_label(data["stage"], data.get("confirm_mode"))
    data["auto_pass_excluded"] = bool(data.get("auto_pass_excluded"))
    return data


__all__ = [
    "IMPLEMENTED_STAGES",
    "MAIN_STAGES",
    "PAGE_NUMBER_MISSING",
    "PAGE_NUMBER_READY",
    "PAGE_NUMBER_SKIPPED",
    "STAGES",
    "STAGE_ARBITRATED",
    "STAGE_CONFIRMED",
    "STAGE_DETECTED",
    "STAGE_DIFF_DONE",
    "STAGE_EXCLUDED",
    "STAGE_EXPORT_READY",
    "STAGE_HUMAN_CONFIRMED",
    "STAGE_LABELS",
    "STAGE_MARGIN_SET",
    "STAGE_OCR1_DONE",
    "STAGE_OCR2_DONE",
    "STAGE_PAGE_UNCONFIRMED",
    "STAGE_RANK",
    "WorkflowError",
    "backfill_project",
    "clear_failure",
    "latest_layout_run",
    "page_workflow",
    "project_workflow",
    "rebuild_page_stage",
    "record_failure",
    "revoke_auto_pass",
    "set_confirmation",
    "record_stage",
    "record_stages",
    "stage_label",
]
