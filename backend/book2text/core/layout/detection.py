"""版面检测任务：建任务、逐页检测、落库（`docs/workflow.md` 阶段 2）。

**只检测不识别。** 每页写一条 `layout_run` + 若干 `page_layout_line`，
原始输出放 `layout_runs/<run_id>.json`。检测成功把页面工作流记成 `detected`，
失败记 `failed_stage=detected` 与原因；**不碰** `block` / `ocr_run` / 导出。
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ..layout.adapters import RapidOcrDetAdapter
from ..layout.base import LayoutEngine, LayoutEngineError, LayoutParams
from ..pdf import render
from ..project import jobs as jobs_module
from ..project import lock as lock_module
from ..project import workflow as workflow_module
from ..storage import db as db_module
from ..storage.ulid import new_ulid
from ..project.library import (
    SOURCE_DIR_NAME,
    SOURCE_FILE_NAME,
    Page,
    ProjectError,
    default_library_dir,
    list_pages,
    load_project,
    project_dir,
    require_project_dir,
)

LAYOUT_RUNS_DIR_NAME = "layout_runs"
LAYOUT_RAW_SCHEMA_ID = "book2text.layout-run.v1"
LAYOUT_ENGINE = "rapidocr_det"
# 检测与识别用同一个渲染 DPI：行框要与 OCR 行 / 块行同口径（文档 3.1）
DEFAULT_LAYOUT_DPI = 200

ERROR_RENDER_FAILED = "render_failed"
ERROR_DETECTOR_FAILED = "detector_crashed"
ERROR_PERSIST_FAILED = "persist_failed"

SCOPE_BODY = "body"
LAYOUT_SCOPES = (SCOPE_BODY,)


class LayoutUnavailable(ProjectError):
    """检测引擎不可用（服务器能力问题，接口层映射 503）。"""

    def __init__(self, reason: str) -> None:
        super().__init__(f"版面检测引擎不可用：{reason}。安装后重试：uv sync --group ocr-eval")
        self.reason = reason


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def default_layout_engine() -> LayoutEngine:
    """生产用的检测引擎。测试注入假引擎时替换这一个函数。"""
    return RapidOcrDetAdapter()


def resolve_layout_pages(
    project_id: str,
    *,
    library: Path | None = None,
    pages: Sequence[int] | None = None,
    scope: str | None = None,
    skip_detected: bool = True,
) -> list[Page]:
    """解析"要检测哪些页"。

    - 显式页码：必须存在且是正文（`page.include`）；默认跳过已检测的页。
    - `scope="body"`：全部正文页；默认跳过已检测的页。
    - 非正文页不参与检测（与识别一致）。
    """
    if (pages is None) == (scope is None):
        raise ProjectError("pages 与 scope 必须给出且只给出一个")
    if scope is not None and scope not in LAYOUT_SCOPES:
        raise ProjectError(f"未知的检测范围：{scope!r}（可选：{'、'.join(LAYOUT_SCOPES)}）")

    target_library = library if library is not None else default_library_dir()
    all_pages = list_pages(project_id, library=target_library)
    directory = project_dir(target_library, project_id)
    detected = _detected_page_ids(directory)

    def selectable(page: Page) -> bool:
        return page.include

    def wanted(page: Page) -> bool:
        return not (skip_detected and page.page_id in detected)

    if scope is not None:
        return [page for page in all_pages if selectable(page) and wanted(page)]

    by_no = {page.page_no: page for page in all_pages}
    selected: list[Page] = []
    for page_no in pages or ():
        page = by_no.get(page_no)
        if page is None:
            raise ProjectError(f"没有第 {page_no} 页")
        if not page.include:
            raise ProjectError(
                f"第 {page_no} 页不是「正文」类型，不参与版面检测。把类型改成「正文」再检测"
            )
        if wanted(page):
            selected.append(page)
    return selected


def _detected_page_ids(directory: Path) -> set[str]:
    if not directory.is_dir() or not db_module.database_path(directory).is_file():
        return set()
    with db_module.open_database(directory, apply_migrations=False) as conn:
        rows = conn.execute(
            "SELECT DISTINCT page_id FROM layout_run WHERE status = 'succeeded'"
        ).fetchall()
    return {row["page_id"] for row in rows}


def create_layout_job(
    project_id: str,
    *,
    library: Path | None = None,
    pages: Sequence[int] | None = None,
    scope: str | None = None,
    skip_detected: bool = True,
    dpi: int | None = None,
    prepare: bool = False,
) -> jobs_module.JobRecord:
    """建一个版面检测任务（不执行；由 Supervisor 起子进程跑）。"""
    target_library = library if library is not None else default_library_dir()
    directory = project_dir(target_library, project_id)

    lock_status = lock_module.status(directory)
    if lock_status.held and not lock_status.mine:
        raise ProjectError(
            f"{lock_status.describe()}。版面检测会写入项目数据库，"
            "请先在那边关闭项目，或在本窗口用「强制打开」"
        )

    load_project(project_id, library=target_library)

    from ..project.recognition import MAX_DPI, MIN_DPI, recognition_settings

    settings = recognition_settings(project_id, library=target_library)
    use_dpi = int(dpi if dpi is not None else settings["recognition_dpi"])
    if not MIN_DPI <= use_dpi <= MAX_DPI:
        raise ProjectError(f"DPI 必须在 {MIN_DPI}–{MAX_DPI} 之间，收到 {use_dpi}")

    if prepare:
        # 「检测并定版心」：正文页全部进任务；已有检测行的页只拟合版心，
        # 没有检测行的页才真正检测。这样不会为了定版心把全书重检测一遍。
        all_pages = list_pages(project_id, library=target_library)
        if pages is not None:
            by_no = {page.page_no: page for page in all_pages}
            selected = []
            for page_no in pages:
                page = by_no.get(page_no)
                if page is None:
                    raise ProjectError(f"没有第 {page_no} 页")
                if not page.include:
                    raise ProjectError(
                        f"第 {page_no} 页不是「正文」类型，不参与页面准备"
                    )
                selected.append(page)
        else:
            selected = [page for page in all_pages if page.include]
    else:
        selected = resolve_layout_pages(
            project_id,
            library=target_library,
            pages=pages,
            scope=scope,
            skip_detected=skip_detected,
        )
    if not selected:
        raise ProjectError("没有需要检测的页面（已检测的页会跳过，非正文页不参与）")

    running = jobs_module.active_job(directory)
    if running is not None:
        raise ProjectError(
            f"已经有一个任务在进行中（{running.status}，"
            f"{running.done + running.failed}/{running.total}）。"
            "默认只跑 1 个 OCR 子进程：先暂停或取消它，再建新任务"
        )

    adapter = default_layout_engine()
    available, reason = adapter.available()
    if not available:
        raise LayoutUnavailable(f"{adapter.engine_id} 不可用：{reason}")

    return jobs_module.create_job(
        directory,
        pages=[(page.page_id, page.page_no) for page in selected],
        params={
            "dpi": use_dpi,
            "engine_id": adapter.engine_id,
            "engine_setting": LAYOUT_ENGINE,
            "mode": "prepare" if prepare else "det_only",
            "fit_margin": bool(prepare),
        },
        job_type=jobs_module.JOB_TYPE_LAYOUT,
    )


@dataclass(frozen=True)
class LayoutOutcome:
    job: jobs_module.JobRecord
    items: tuple[jobs_module.JobItemRecord, ...]


# ---------------------------------------------------------------- 检测计划与估时
#
# 界面上"检测版面"不是主入口，但按下去之前必须说清两件事：**要跑多少页**、
# **大概多久**。页数从检测记录算（没检测过的页），时间优先用本项目的历史实测
# 中位数；没有历史时才退回下面这个常数——它是这台机器上实测出来的，不是拍的。

# RapidOCR det + 200 dpi 渲染，单页耗时：本机实测（Apple Silicon，macOS）
# 5 页一次 2 秒，逐页 elapsed_seconds 均值 0.384、最小 0.316、最大 0.625（首启那次）。
# 取 0.45 作保守默认值；项目里有历史耗时时用历史中位数（见 `_seconds_per_page`）。
DEFAULT_SECONDS_PER_PAGE = 0.45
# 历史耗时的采样条数：只取最近的，换机器 / 换 DPI 之后老数据会自然被挤出去。
ESTIMATE_SAMPLE_SIZE = 60


def _seconds_per_page(directory: Path) -> tuple[float, str]:
    """单页检测耗时（秒）与来源：`history`（本项目历史中位数）/ `default`。"""
    try:
        with db_module.open_database(directory, apply_migrations=False) as conn:
            rows = conn.execute(
                """
                SELECT elapsed_seconds FROM layout_run
                WHERE status = 'succeeded' AND elapsed_seconds IS NOT NULL
                ORDER BY created_at DESC, rowid DESC LIMIT ?
                """,
                (ESTIMATE_SAMPLE_SIZE,),
            ).fetchall()
    except Exception:  # noqa: BLE001 - 老库没有检测表就是"没有历史"
        return DEFAULT_SECONDS_PER_PAGE, "default"
    values = sorted(
        float(row["elapsed_seconds"])
        for row in rows
        if row["elapsed_seconds"] is not None and float(row["elapsed_seconds"]) > 0
    )
    if not values:
        return DEFAULT_SECONDS_PER_PAGE, "default"
    middle = len(values) // 2
    if len(values) % 2:
        median = values[middle]
    else:
        median = (values[middle - 1] + values[middle]) / 2
    return round(median, 3), "history"


def layout_plan(project_id: str, *, library: Path | None = None) -> dict[str, object]:
    """这一本"检测版面"要做什么、大概多久。

    - `need_detection`：正文页里**还没有成功检测记录**的页号（检测要跑的正是这些）；
    - `need_fit`：已检测、但 `auto` 页还没有版心框的页号（只需再拟合，不重检测）；
    - `seconds_per_page` / `estimated_seconds`：按本项目历史实测中位估算，
      没有历史时用 `DEFAULT_SECONDS_PER_PAGE`，并在 `estimate_source` 里说明来源。
    """
    target_library = library if library is not None else default_library_dir()
    directory = require_project_dir(project_id, library=target_library)
    pages = list_pages(project_id, library=target_library)
    summaries = workflow_module.layout_summaries(directory)
    body = [page for page in pages if page.include]
    need_detection = [page.page_no for page in body if page.page_id not in summaries]
    need_fit = [
        page.page_no
        for page in body
        if page.page_id in summaries
        and page.margin_box_mode == "auto"
        and page.margin_box is None
    ]
    seconds, source = _seconds_per_page(directory)
    return {
        "total_pages": len(pages),
        "body_pages": len(body),
        "detected": len(body) - len(need_detection),
        "need_detection": need_detection,
        "need_fit": need_fit,
        "seconds_per_page": seconds,
        "estimated_seconds": int(round(seconds * len(need_detection))),
        "estimate_source": source,
    }


DECISION_RUN = "run"
DECISION_PAUSE = "pause"
DECISION_STOP = "stop"
PAUSE_POLL_SECONDS = 0.5


def run_layout_job(
    directory: Path,
    job_id: str,
    *,
    engine: LayoutEngine | None = None,
    should_continue: Callable[[], str] | None = None,
    log: Callable[[str], None] | None = None,
) -> LayoutOutcome:
    """把这个任务里还没成功的页逐页检测并落库。"""
    job = jobs_module.get_job(directory, job_id)
    if job.status in jobs_module.TERMINAL_STATUSES:
        return LayoutOutcome(job=job, items=tuple(jobs_module.list_job_items(directory, job_id)))

    jobs_module.set_status(directory, job_id, jobs_module.STATUS_RUNNING)
    adapter = engine if engine is not None else default_layout_engine()
    available, reason = adapter.available()
    say = log if log is not None else (lambda message: None)
    if not available:
        _fail_job(directory, job_id, f"版面检测引擎不可用：{reason}")
        return LayoutOutcome(
            job=jobs_module.get_job(directory, job_id),
            items=tuple(jobs_module.list_job_items(directory, job_id)),
        )

    params = LayoutParams(dpi=int(job.params.get("dpi", DEFAULT_LAYOUT_DPI)))
    source = directory / SOURCE_DIR_NAME / SOURCE_FILE_NAME
    say(
        f"job {job_id} start total={job.total} dpi={params.dpi} "
        f"engine={adapter.engine_id} type=layout"
    )

    decide = should_continue or _status_decider(directory, job_id)
    for item in jobs_module.pending_items(directory, job_id):
        decision = _wait_for_go(decide)
        if decision == DECISION_STOP:
            break
        if item.page_no is None:
            jobs_module.mark_item_failed(
                directory, item.item_id, "单元指向的页面不存在（页面记录可能已被删除）"
            )
            jobs_module.update_progress(directory, job_id)
            say(f"item {item.item_id} failed page_missing")
            continue
        if str(job.params.get("mode") or "") == "prepare" and _has_detection(
            directory, item.page_id
        ):
            _fit_existing_item(
                directory=directory,
                item=item,
                log=say,
            )
        else:
            _run_item(
                directory=directory,
                source=source,
                page_no=item.page_no,
                page_id=item.page_id,
                item_id=item.item_id,
                adapter=adapter,
                params=params,
                log=say,
            )
        jobs_module.update_progress(directory, job_id)

    job = jobs_module.get_job(directory, job_id)
    if job.status not in jobs_module.TERMINAL_STATUSES:
        jobs_module.set_status(
            directory,
            job_id,
            jobs_module.STATUS_FAILED if job.failed else jobs_module.STATUS_SUCCEEDED,
        )
        job = jobs_module.get_job(directory, job_id)
    say(f"job {job_id} end status={job.status} done={job.done} failed={job.failed}")
    outcome = LayoutOutcome(
        job=job, items=tuple(jobs_module.list_job_items(directory, job_id))
    )
    _auto_margin_after_job(directory, job_id, outcome, say)
    return outcome


def _auto_margin_after_job(
    directory: Path, job_id: str, outcome: LayoutOutcome, say: Callable[[str], None]
) -> None:
    """检测任务收尾：用检测行自动推算一次版心（任务 59）。

    **为什么在检测收尾：** 新工作流是「检测 → 版心 → 识别」，版心不能等识别。
    一次任务只算一次（不是每页一次），避免框在处理过程中来回跳。
    写入规则不变：没有手动版心才自动写并标 ``auto``；手动值只更新建议、绝不覆盖。
    失败只写一行日志，不影响任务结算。
    """
    succeeded = [
        item
        for item in outcome.items
        if item.page_no is not None and item.status == jobs_module.ITEM_STATUS_SUCCEEDED
    ]
    if not succeeded:
        return
    from ..project import margin_box as margin_box_module

    try:
        result = margin_box_module.write_margin_suggestion(
            directory.name,
            trigger="layout_job",
            job_id=job_id,
            library=directory.parent,
        )
    except Exception as exc:  # noqa: BLE001 - 自动推算失败不该让检测任务变成失败
        say(f"margin_suggestion failed {type(exc).__name__}")
        return
    if result.get("suggestion"):
        say(
            "margin_suggestion "
            f"applied={1 if result['applied'] else 0} "
            f"pages={result['suggestion'].get('pages')}"
        )


def _has_detection(directory: Path, page_id: str) -> bool:
    with db_module.open_database(directory, apply_migrations=False) as conn:
        row = conn.execute(
            "SELECT 1 FROM layout_run WHERE page_id = ? AND status = 'succeeded' LIMIT 1",
            (page_id,),
        ).fetchone()
    return row is not None


def _fit_existing_item(
    *,
    directory: Path,
    item: jobs_module.JobItemRecord,
    log: Callable[[str], None],
) -> None:
    """页面准备任务：已有检测行的页只拟合版心，不重新检测。"""
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE job_item SET status = 'running', attempts = attempts + 1 WHERE item_id = ?",
            (item.item_id,),
        )
        conn.commit()
    try:
        from ..project import margin_box as margin_box_module

        result = margin_box_module.fit_page_margin(
            directory.name, item.page_no, library=directory.parent
        )
    except Exception as exc:  # noqa: BLE001 - 拟合失败如实记在页上，不静默
        jobs_module.mark_item_failed(directory, item.item_id, f"版心拟合失败：{exc}")
        log(f"page {item.page_no} margin failed")
        return
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE job_item SET status = 'succeeded' WHERE item_id = ?", (item.item_id,)
        )
        conn.commit()
    log(
        f"page {item.page_no} margin fitted={1 if result.get('updated') else 0} "
        f"fallback={1 if result.get('fallback') else 0}"
    )


def _fit_detected_page(directory: Path, page_no: int, log: Callable[[str], None]) -> None:
    """检测完成后顺手拟合一次 auto 页版心。"""
    try:
        from ..project import margin_box as margin_box_module

        result = margin_box_module.fit_page_margin(
            directory.name, page_no, library=directory.parent
        )
    except Exception as exc:  # noqa: BLE001 - 拟合失败不影响检测产物
        log(f"page {page_no} margin_fit_failed {type(exc).__name__}")
        return
    if result.get("updated"):
        log(
            f"page {page_no} margin fitted=1 fallback={1 if result.get('fallback') else 0}"
        )


def _status_decider(directory: Path, job_id: str) -> Callable[[], str]:
    def decide() -> str:
        status = jobs_module.get_job(directory, job_id).status
        if status == jobs_module.STATUS_PAUSED:
            return DECISION_PAUSE
        if status == jobs_module.STATUS_RUNNING:
            return DECISION_RUN
        return DECISION_STOP

    return decide


def _wait_for_go(decide: Callable[[], str]) -> str:
    while True:
        decision = decide()
        if decision != DECISION_PAUSE:
            return decision
        time.sleep(PAUSE_POLL_SECONDS)


def _fail_job(directory: Path, job_id: str, message: str) -> None:
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE job_item SET status = 'failed', error_message = ?"
            " WHERE job_id = ? AND status IN ('queued', 'running')",
            (message, job_id),
        )
        conn.commit()
    jobs_module.update_progress(directory, job_id)
    jobs_module.set_status(directory, job_id, jobs_module.STATUS_FAILED)


def _run_item(
    *,
    directory: Path,
    source: Path,
    page_no: int,
    page_id: str,
    item_id: str,
    adapter: LayoutEngine,
    params: LayoutParams,
    log: Callable[[str], None],
) -> str:
    run_id = new_ulid()
    started = _now()
    started_clock = datetime.now(timezone.utc)

    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            """
            INSERT INTO layout_run (
                run_id, page_id, engine_id, engine_version, params_json,
                status, line_count, created_at
            ) VALUES (?, ?, ?, ?, ?, 'running', 0, ?)
            """,
            (
                run_id,
                page_id,
                adapter.engine_id,
                adapter.version(),
                json.dumps({"dpi": params.dpi, "mode": "det_only"}, ensure_ascii=False),
                started,
            ),
        )
        conn.execute(
            "UPDATE job_item SET status = 'running', run_id = ?, attempts = attempts + 1"
            " WHERE item_id = ?",
            (run_id, item_id),
        )
        conn.commit()

    try:
        image = render.render_page_image(source, page_no - 1, dpi=params.dpi)
    except render.PdfError as exc:
        log(f"page {page_no} failed render_failed")
        _fail_run(directory, run_id, item_id, page_id, ERROR_RENDER_FAILED, str(exc))
        return run_id

    try:
        result = adapter.detect(image, params)
    except LayoutEngineError as exc:
        log(f"page {page_no} failed detector_crashed")
        _fail_run(directory, run_id, item_id, page_id, ERROR_DETECTOR_FAILED, str(exc))
        return run_id
    finally:
        image.close()

    elapsed = (datetime.now(timezone.utc) - started_clock).total_seconds()
    raw_path = directory / LAYOUT_RUNS_DIR_NAME / f"{run_id}.json"
    try:
        _write_raw_result(
            raw_path,
            run_id=run_id,
            page_id=page_id,
            page_no=page_no,
            params=params,
            result=result,
            total_elapsed=elapsed,
        )
    except OSError as exc:
        log(f"page {page_no} failed persist_failed")
        _fail_run(directory, run_id, item_id, page_id, ERROR_PERSIST_FAILED, f"写原始输出失败：{exc}")
        return run_id

    now = _now()
    try:
        with db_module.open_database(directory, apply_migrations=False) as conn:
            conn.executemany(
                """
                INSERT INTO page_layout_line (
                    line_id, run_id, page_id, line_index, bbox, confidence, reading_order
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        new_ulid(),
                        run_id,
                        page_id,
                        index,
                        json.dumps(line.bbox.as_list()),
                        line.confidence,
                        line.reading_order,
                    )
                    for index, line in enumerate(result.lines)
                ],
            )
            conn.execute(
                """
                UPDATE layout_run
                SET status = 'succeeded', line_count = ?, elapsed_seconds = ?,
                    raw_result_path = ?, finished_at = ?
                WHERE run_id = ?
                """,
                (
                    len(result.lines),
                    round(elapsed, 3),
                    f"{LAYOUT_RUNS_DIR_NAME}/{run_id}.json",
                    now,
                    run_id,
                ),
            )
            conn.execute("UPDATE job_item SET status = 'succeeded' WHERE item_id = ?", (item_id,))
            conn.execute("UPDATE project SET updated_at = ?", (now,))
            conn.commit()
    except Exception as exc:  # noqa: BLE001 - 落库失败要如实记在本页
        log(f"page {page_no} failed persist_failed")
        _fail_run(directory, run_id, item_id, page_id, ERROR_PERSIST_FAILED, str(exc))
        return run_id

    try:
        # 用连续判定而不是只记 detected：老项目里这一页可能已经有旧 OCR 块，
        # 检测行一落库，真实状态就是"已检测 + 已识别①"，不能显示成"未识别"。
        workflow_module.rebuild_page_stage(directory, page_id)
    except Exception as exc:  # noqa: BLE001 - 状态索引失败不影响检测产物
        log(f"page {page_no} workflow_stage_failed {type(exc).__name__}")

    _fit_detected_page(directory, page_no, log)
    log(f"page {page_no} detected lines={len(result.lines)} {elapsed:.1f}s {run_id}")
    return run_id


def _fail_run(
    directory: Path,
    run_id: str,
    item_id: str,
    page_id: str,
    error_code: str,
    message: str,
) -> None:
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            """
            UPDATE layout_run
            SET status = 'failed', error_code = ?, error_message = ?, finished_at = ?
            WHERE run_id = ?
            """,
            (error_code, message, _now(), run_id),
        )
        conn.execute(
            "UPDATE job_item SET status = 'failed', error_message = ? WHERE item_id = ?",
            (message, item_id),
        )
        conn.commit()
    try:
        workflow_module.record_failure(
            directory, page_id, workflow_module.STAGE_DETECTED, message
        )
    except Exception:  # noqa: BLE001 - 失败索引写不进去也不能盖住原始错误
        pass


def _write_raw_result(
    path: Path,
    *,
    run_id: str,
    page_id: str,
    page_no: int,
    params: LayoutParams,
    result,
    total_elapsed: float,
) -> None:
    payload = {
        "schema": LAYOUT_RAW_SCHEMA_ID,
        "run_id": run_id,
        "page_id": page_id,
        "page_no": page_no,
        "engine_id": result.engine_id,
        "engine_version": result.engine_version,
        "params": {"dpi": params.dpi, "mode": "det_only"},
        "image_width": result.image_width,
        "image_height": result.image_height,
        "engine_elapsed_seconds": round(result.elapsed_seconds, 3),
        "total_elapsed_seconds": round(total_elapsed, 3),
        "line_count": len(result.lines),
        "lines": [
            {
                "index": index,
                "bbox": line.bbox.as_list(),
                "confidence": line.confidence,
                "reading_order": line.reading_order,
            }
            for index, line in enumerate(result.lines)
        ],
        # 明确记下"这一份输出没有文字"，避免将来有人把检测结果当识别结果
        "text_produced": False,
        "engine_raw": result.raw,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )


def page_layout(
    project_id: str, page_no: int, *, library: Path | None = None
) -> dict:
    """一页最近一次成功检测的运行与行框（只读）。"""
    directory = require_project_dir(project_id, library=library)
    pages = list_pages(project_id, library=library)
    page = next((item for item in pages if item.page_no == page_no), None)
    if page is None:
        raise ProjectError(f"没有第 {page_no} 页")
    with db_module.open_database(directory, apply_migrations=False) as conn:
        run = conn.execute(
            """
            SELECT * FROM layout_run
            WHERE page_id = ? AND status = 'succeeded'
            ORDER BY created_at DESC, rowid DESC LIMIT 1
            """,
            (page.page_id,),
        ).fetchone()
        rows = []
        if run is not None:
            rows = conn.execute(
                "SELECT line_index, bbox, confidence, reading_order FROM page_layout_line"
                " WHERE run_id = ? ORDER BY line_index",
                (run["run_id"],),
            ).fetchall()
    if run is None:
        return {"page_no": page_no, "run": None, "lines": []}
    return {
        "page_no": page_no,
        "run": {
            "run_id": run["run_id"],
            "engine_id": run["engine_id"],
            "engine_version": run["engine_version"],
            "params": json.loads(run["params_json"] or "{}"),
            "line_count": int(run["line_count"]),
            "elapsed_seconds": run["elapsed_seconds"],
            "raw_result_path": run["raw_result_path"],
            "created_at": run["created_at"],
        },
        "lines": [
            {
                "line_index": int(row["line_index"]),
                "bbox": json.loads(row["bbox"]),
                "confidence": row["confidence"],
                "reading_order": int(row["reading_order"]),
            }
            for row in rows
        ],
    }


__all__ = [
    "DEFAULT_LAYOUT_DPI",
    "LAYOUT_ENGINE",
    "LAYOUT_RUNS_DIR_NAME",
    "LayoutOutcome",
    "LayoutUnavailable",
    "create_layout_job",
    "default_layout_engine",
    "page_layout",
    "resolve_layout_pages",
    "run_layout_job",
]
