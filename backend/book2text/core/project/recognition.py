"""识别一页并落库（说明书 5.3 的数据模型 + 5.4 的 R1 / R2）。

一次识别在数据库里留下五条记录，它们回答的是五个不同的问题：

====================  ==========================================================
``job``               这次操作是什么（谁发起、共几页、成没成）
``job_item``          任务里的这一页（状态、关联到哪次运行、失败原因）
``ocr_run``           哪个引擎、什么参数、耗时多久、原始输出存在哪
``block``             当前有效的块（文本、类型、坐标、审校状态）
``block_line``        块内每一行（行级坐标，供框选联动与按行比对）
====================  ==========================================================

**两条业务规则（说明书 5.4）**

- **R1 首次识别：** 页面没有 active run 时，运行成功后自动设为 active，并生成块。
- **R2 重新识别：** 页面已有 active run 时——
  没有任何人工成果（没确认过、没改过、没调整过结构）→ 直接替换：旧块**软删除**，
  新块入库，active run 换成新的；
  已有人工成果 → **只保存为待选结果**，不碰块、不换 active run
  （"系统绝不自动覆盖人工成果"）。页面的"有待选新结果"状态由 `blocks.py` 推导，
  采用 / 保留的对比界面属于 Phase 3（说明书 6.4）。

**两条入口，职责分开：**

- `create_ocr_job()`：在**服务进程**里建任务（校验页面、锁、引擎可用性），不做识别。
- `run_job()`：**在子进程里**逐页识别并落库（`book2text.worker` 调它），
  也可以在同进程里跑（测试用假引擎走的就是这条）。为什么要子进程见
  `core/jobs/executor.py`：峰值内存约 2.7 GB、要能取消、引擎崩了不该带走应用。

父子之间**只通过数据库交换状态**（任务状态就是控制信号：暂停就写 paused，
取消就写 cancelled），因此哪一边重启都不会丢进度。

**原始输出**写在 ``ocr_runs/<run_id>.json``：引擎给出的行（文本 + 归一化坐标 +
置信度）与引擎自己的元数据。它记录的是**适配器取到的输出**，不是引擎内部对象。
路径以**相对项目目录**的形式入库，整包拷贝到另一台机器仍然有效（说明书第 10 节）。
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ..ocr.adapters import RapidOcrAdapter
from ..ocr.base import OcrEngine, OcrEngineError, OcrParams, OcrResult
from ..pdf import render
from ..storage import db as db_module
from ..storage.ulid import new_ulid
from ..structure import grouping
from . import blocks as blocks_module
from . import jobs as jobs_module
from . import lock as lock_module
from .library import (
    OCR_RUNS_DIR_NAME,
    SOURCE_DIR_NAME,
    SOURCE_FILE_NAME,
    Page,
    ProjectError,
    default_library_dir,
    list_pages,
    load_project,
    project_dir,
)

RAW_SCHEMA_ID = "book2text.ocr-run.v1"

DEFAULT_DPI = 300
DEFAULT_LANGUAGE = "ch"
MIN_DPI = 72
MAX_DPI = 600

ORIGIN_OCR = "ocr"
REVIEW_UNREVIEWED = "unreviewed"

# 失败原因的分类（写进 ocr_run.error_code 与 job_item.error_message）
ERROR_RENDER_FAILED = "render_failed"
ERROR_OCR_FAILED = "ocr_failed"
ERROR_PERSIST_FAILED = "persist_failed"


class EngineUnavailable(ProjectError):
    """OCR 引擎不可用。

    这是**服务器能力**问题，不是页面问题：调用方应据此提示安装依赖（说明书 1.6），
    因此单独成类，接口层映射成 503 而不是 400。
    """

    def __init__(self, reason: str) -> None:
        super().__init__(f"OCR 引擎不可用：{reason}。安装后重试：uv sync --group ocr-eval")
        self.reason = reason


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------- 建任务（服务进程）

# 批量识别的两种范围（说明书 6.3："选中页或全部纳入页；已有识别结果的页面默认跳过"）
SCOPE_UNRECOGNIZED = "unrecognized"
SCOPE_ALL = "all"
SCOPES = (SCOPE_UNRECOGNIZED, SCOPE_ALL)


# 已有**可用识别结果**的状态：说明书 6.3 说批量识别"已有识别结果的页面默认跳过"
STATUSES_WITH_RESULT = (
    blocks_module.STATUS_RECOGNIZED,
    blocks_module.STATUS_HAS_CANDIDATE,
)


def resolve_pages(
    project_id: str,
    *,
    library: Path | None = None,
    pages: Sequence[int] | None = None,
    scope: str | None = None,
    skip_recognized: bool = True,
) -> list[Page]:
    """把"要识别哪些页"解析成页面列表。

    - 显式页码：必须存在且已纳入（排除的页不参与识别，界面上也是这么说的）。
    - ``scope="unrecognized"``：全部纳入页里**没有可用识别结果**的（未识别或上次失败）。
    - ``scope="all"``：全部纳入页（重新识别，适用规则 R2）。
    - ``skip_recognized``：显式页码时是否跳过已识别的页（默认跳过，与说明书 6.3 一致；
      单页"重新识别"按钮会显式传 False）。
    """
    if (pages is None) == (scope is None):
        raise ProjectError("pages 与 scope 必须给出且只给出一个")
    if scope is not None and scope not in SCOPES:
        raise ProjectError(f"未知的范围：{scope!r}（可选：{'、'.join(SCOPES)}）")

    target_library = library if library is not None else default_library_dir()
    all_pages = list_pages(project_id, library=target_library)
    states = blocks_module.page_recognition_states(project_id, library=target_library)

    def usable_result(page: Page) -> bool:
        state = states.get(page.page_id)
        return state is not None and state.status in STATUSES_WITH_RESULT

    if scope is not None:
        selected = []
        for page in all_pages:
            if not page.include:
                continue
            if scope == SCOPE_ALL:
                selected.append(page)
                continue
            state = states.get(page.page_id)
            status = state.status if state else blocks_module.STATUS_UNRECOGNIZED
            if status in (blocks_module.STATUS_UNRECOGNIZED, blocks_module.STATUS_FAILED):
                selected.append(page)
        return selected

    by_no = {page.page_no: page for page in all_pages}
    selected = []
    for page_no in pages or ():
        page = by_no.get(page_no)
        if page is None:
            raise ProjectError(f"没有第 {page_no} 页")
        if not page.include:
            raise ProjectError(
                f"第 {page_no} 页已排除，不参与识别。先把它纳入（单击缩略图）再识别"
            )
        if skip_recognized and usable_result(page):
            continue
        selected.append(page)
    return selected


def create_ocr_job(
    project_id: str,
    *,
    library: Path | None = None,
    pages: Sequence[int] | None = None,
    scope: str | None = None,
    skip_recognized: bool = True,
    dpi: int = DEFAULT_DPI,
    language: str = DEFAULT_LANGUAGE,
) -> jobs_module.JobRecord:
    """建一个识别任务（不执行）。执行由 `core/jobs/executor.py` 起子进程完成。"""
    if not MIN_DPI <= dpi <= MAX_DPI:
        raise ProjectError(f"DPI 必须在 {MIN_DPI}–{MAX_DPI} 之间，收到 {dpi}")

    target_library = library if library is not None else default_library_dir()
    directory = project_dir(target_library, project_id)

    # 识别要写数据库。若项目正被**另一个应用实例**打开（项目锁，说明书 7.6），
    # 这里拒绝，避免两个进程同时写同一个库。
    lock_status = lock_module.status(directory)
    if lock_status.held and not lock_status.mine:
        raise ProjectError(
            f"{lock_status.describe()}。识别会写入项目数据库，"
            "请先在那边关闭项目，或在本窗口用「强制打开」"
        )

    # 识别要写库，因此这里应用迁移（与读取路径相反，见 blocks.py 的说明）
    load_project(project_id, library=target_library)

    selected = resolve_pages(
        project_id,
        library=target_library,
        pages=pages,
        scope=scope,
        skip_recognized=skip_recognized,
    )
    if not selected:
        raise ProjectError(
            "没有需要识别的页面（已识别的页会跳过，排除的页不参与）"
            + ("——要去掉「跳过已识别的页」的勾选才会重新识别它们" if pages else "")
        )

    running = jobs_module.active_job(directory)
    if running is not None:
        raise ProjectError(
            f"已经有一个识别任务在进行中（{running.status}，"
            f"{running.done + running.failed}/{running.total}）。"
            "说明书 6.3 规定默认只跑 1 个 OCR 子进程：先暂停或取消它，再建新任务"
        )

    adapter: OcrEngine = RapidOcrAdapter()
    available, reason = adapter.available()
    if not available:
        # 引擎不可用是环境问题，不该建出一个注定失败的任务
        raise EngineUnavailable(reason)

    return jobs_module.create_job(
        directory,
        pages=[(page.page_id, page.page_no) for page in selected],
        params={"dpi": dpi, "language": language, "engine_id": adapter.engine_id},
    )


# ---------------------------------------------------------------- 跑任务（子进程）

# 执行循环的三种决定（由 should_continue() 返回）
DECISION_RUN = "run"          # 继续做下一页
DECISION_PAUSE = "pause"      # 任务被暂停：原地等着
DECISION_STOP = "stop"        # 任务被取消 / 已由别人结算 / 父进程已死：收工

# 暂停时轮询任务状态的间隔（秒）
PAUSE_POLL_SECONDS = 0.5


@dataclass(frozen=True)
class JobOutcome:
    """一次执行的结果。"""

    job: jobs_module.JobRecord
    items: tuple[jobs_module.JobItemRecord, ...]

    @property
    def failed_items(self) -> tuple[jobs_module.JobItemRecord, ...]:
        return tuple(item for item in self.items if item.status == jobs_module.ITEM_STATUS_FAILED)


def run_job(
    directory: Path,
    job_id: str,
    *,
    engine: OcrEngine | None = None,
    should_continue: Callable[[], str] | None = None,
    log: Callable[[str], None] | None = None,
) -> JobOutcome:
    """把这个任务里**还没成功**的页面逐页识别并落库。

    ``engine`` / ``should_continue`` / ``log`` 都是注入点：生产代码用 RapidOCR、
    读数据库判断该不该继续、把进度打到 stdout（由父进程收进项目日志）；
    测试用假引擎与脚本化的决定，走的是同一套落库路径。
    """
    job = jobs_module.get_job(directory, job_id)
    if job.status in jobs_module.TERMINAL_STATUSES:
        # 已经被别人结算（通常是父进程取消了它）——不该再动手
        return JobOutcome(job=job, items=tuple(jobs_module.list_job_items(directory, job_id)))

    jobs_module.set_status(directory, job_id, jobs_module.STATUS_RUNNING)

    adapter: OcrEngine = engine if engine is not None else RapidOcrAdapter()
    available, reason = adapter.available()
    if not available:
        _fail_job(directory, job_id, EngineUnavailable(reason))
        return JobOutcome(job=jobs_module.get_job(directory, job_id), items=tuple(
            jobs_module.list_job_items(directory, job_id)
        ))

    params = OcrParams(
        language=str(job.params.get("language", DEFAULT_LANGUAGE)),
        dpi=int(job.params.get("dpi", DEFAULT_DPI)),
    )
    engine_version = adapter.version()
    source = directory / SOURCE_DIR_NAME / SOURCE_FILE_NAME
    decide = should_continue if should_continue is not None else _status_decider(directory, job_id)
    say = log if log is not None else (lambda message: None)

    say(f"job {job_id} start total={job.total} dpi={params.dpi} engine={adapter.engine_id}")

    stopped = False
    for item in jobs_module.pending_items(directory, job_id):
        decision = _wait_for_go(decide)
        if decision == DECISION_STOP:
            stopped = True
            break
        if item.page_no is None:
            # 单元指向的页面已经不在了（页面记录被删）：如实记失败，
            # 不要静默跳过——否则任务会显示"成功"却一页都没做。
            jobs_module.mark_item_failed(
                directory, item.item_id, "单元指向的页面不存在（页面记录可能已被删除）"
            )
            jobs_module.update_progress(directory, job_id)
            say(f"item {item.item_id} failed page_missing")
            continue
        _run_item(
            directory=directory,
            source=source,
            page_no=item.page_no,
            page_id=item.page_id,
            item_id=item.item_id,
            adapter=adapter,
            params=params,
            engine_version=engine_version,
            log=say,
        )
        jobs_module.update_progress(directory, job_id)

    job = jobs_module.get_job(directory, job_id)
    if not stopped:
        # 没被停：按结果结算。有任何一页失败就算 failed（done / failed 说明细节）
        jobs_module.set_status(
            directory,
            job_id,
            jobs_module.STATUS_FAILED if job.failed else jobs_module.STATUS_SUCCEEDED,
        )
        job = jobs_module.get_job(directory, job_id)
    say(f"job {job_id} end status={job.status} done={job.done} failed={job.failed}")

    return JobOutcome(job=job, items=tuple(jobs_module.list_job_items(directory, job_id)))


def _status_decider(directory: Path, job_id: str) -> Callable[[], str]:
    """默认的"该不该继续"判断：读数据库里这个任务的状态。

    任务状态本身就是控制信号——暂停写 paused、取消写 cancelled，
    子进程每次做下一页之前看一眼。这样父子之间不需要额外的管道协议。
    """

    def decide() -> str:
        status = jobs_module.get_job(directory, job_id).status
        if status == jobs_module.STATUS_PAUSED:
            return DECISION_PAUSE
        if status == jobs_module.STATUS_RUNNING:
            return DECISION_RUN
        return DECISION_STOP

    return decide


def _wait_for_go(decide: Callable[[], str]) -> str:
    """暂停时就地等，直到重新变成 run 或收到 stop。"""
    while True:
        decision = decide()
        if decision != DECISION_PAUSE:
            return decision
        time.sleep(PAUSE_POLL_SECONDS)


def _fail_job(directory: Path, job_id: str, error: Exception) -> None:
    """整个任务起不来（例如引擎不可用）：把所有还没做的单元标记失败并写明原因。"""
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE job_item SET status = 'failed', error_message = ?"
            " WHERE job_id = ? AND status IN ('queued', 'running')",
            (str(error), job_id),
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
    adapter: OcrEngine,
    params: OcrParams,
    engine_version: str,
    log: Callable[[str], None] = lambda message: None,
) -> str:
    """识别一页：先落一条 running 的运行记录，成功或失败都会把它结算掉。

    这样"失败原因可见"（说明书 Phase 2 的验收）不依赖界面：
    数据库里就躺着 error_code 与 error_message。
    日志只写页码、结果与耗时——**不写识别文本，也不写路径**（说明书 Phase 6 的日志规则）。
    """
    run_id = new_ulid()
    started = _now()
    started_clock = datetime.now(timezone.utc)

    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            """
            INSERT INTO ocr_run (
                run_id, page_id, run_type, engine_id, engine_version, params_json,
                status, created_at
            ) VALUES (?, ?, 'primary', ?, ?, ?, 'running', ?)
            """,
            (
                run_id,
                page_id,
                adapter.engine_id,
                engine_version,
                json.dumps({"dpi": params.dpi, "language": params.language}, ensure_ascii=False),
                started,
            ),
        )
        conn.execute(
            """
            UPDATE job_item SET status = 'running', run_id = ?, attempts = attempts + 1
            WHERE item_id = ?
            """,
            (run_id, item_id),
        )
        conn.commit()

    # 渲染：与界面显示、与 Phase 0 的门槛实测走同一个函数（含 /Rotate）
    try:
        image = render.render_page_image(source, page_no - 1, dpi=params.dpi)
    except render.PdfError as exc:
        log(f"page {page_no} failed render_failed")
        _fail_run(directory, run_id, item_id, ERROR_RENDER_FAILED, str(exc))
        return run_id

    try:
        result = adapter.recognize(image, params)
    except OcrEngineError as exc:
        log(f"page {page_no} failed ocr_failed")
        _fail_run(directory, run_id, item_id, ERROR_OCR_FAILED, str(exc))
        return run_id
    finally:
        image.close()

    layout = grouping.group_lines(result.lines)
    elapsed = (datetime.now(timezone.utc) - started_clock).total_seconds()

    raw_path = directory / OCR_RUNS_DIR_NAME / f"{run_id}.json"
    try:
        _write_raw_result(
            raw_path,
            run_id=run_id,
            page_id=page_id,
            page_no=page_no,
            result=result,
            params=params,
            engine_version=engine_version,
            total_elapsed=elapsed,
            layout=layout,
        )
    except OSError as exc:
        log(f"page {page_no} failed persist_failed")
        _fail_run(directory, run_id, item_id, ERROR_PERSIST_FAILED, f"写原始输出失败：{exc}")
        return run_id

    _persist_blocks(
        directory,
        page_id,
        run_id=run_id,
        item_id=item_id,
        layout=layout,
        elapsed=elapsed,
    )
    log(f"page {page_no} succeeded {elapsed:.1f}s blocks={len(layout.blocks)}")
    return run_id


def _fail_run(
    directory: Path, run_id: str, item_id: str, error_code: str, message: str
) -> None:
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            """
            UPDATE ocr_run SET status = 'failed', error_code = ?, error_message = ?, finished_at = ?
            WHERE run_id = ?
            """,
            (error_code, message, _now(), run_id),
        )
        conn.execute(
            "UPDATE job_item SET status = 'failed', error_message = ? WHERE item_id = ?",
            (message, item_id),
        )
        conn.commit()


# ---------------------------------------------------------------- 落块

def _has_human_results(conn, page_id: str) -> bool:
    """页面是否已有人工成果（说明书 R2）。

    凡"确认过 / 改过文本 / 不是 OCR 来源"的块都算：这三类分别对应
    ``review_status``、``text != ocr_text`` 与 ``origin``。
    """
    row = conn.execute(
        """
        SELECT COUNT(*) AS n FROM block
        WHERE page_id = ? AND deleted_at IS NULL
          AND (text <> ocr_text OR review_status <> ? OR origin <> ?)
        """,
        (page_id, REVIEW_UNREVIEWED, ORIGIN_OCR),
    ).fetchone()
    return int(row["n"]) > 0


def _persist_blocks(
    directory: Path,
    page_id: str,
    *,
    run_id: str,
    item_id: str,
    layout: grouping.PageLayout,
    elapsed: float,
) -> bool:
    """结算这次识别：块与行的写入、运行状态、active run、任务单元，**一个事务**。

    这几件事必须一起成功或一起失败——否则会出现"块进去了但 active run 没换"
    或"运行成功了但没块"这类半截状态（进程刚好在两步之间被杀就能撞上）。
    返回这次运行是否被采用（R1 / R2 的结论）。
    """
    now = _now()
    with db_module.open_database(directory, apply_migrations=False) as conn:
        active = conn.execute(
            "SELECT active_run_id FROM page WHERE page_id = ?", (page_id,)
        ).fetchone()
        has_active = active is not None and active["active_run_id"] is not None
        applied = not has_active or not _has_human_results(conn, page_id)

        if applied:
            # R1 / R2 的替换：旧块软删除（说明书 5.1：删除一律软删除）
            conn.execute(
                "UPDATE block SET deleted_at = ?, updated_at = ?"
                " WHERE page_id = ? AND deleted_at IS NULL",
                (now, now, page_id),
            )
            for block in layout.blocks:
                block_id = new_ulid()
                confidences = [
                    line.confidence for line in block.lines if line.confidence is not None
                ]
                text = block.text
                conn.execute(
                    """
                    INSERT INTO block (
                        block_id, page_id, origin_run_id, origin, order_index, bbox, block_type,
                        ocr_text, text, review_status, include, continues_to_next, confidence,
                        revision, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, 0, ?, ?)
                    """,
                    (
                        block_id,
                        page_id,
                        run_id,
                        ORIGIN_OCR,
                        block.order_index,
                        blocks_module.bbox_to_json(block.bbox),
                        block.block_type,
                        text,
                        text,
                        REVIEW_UNREVIEWED,
                        (sum(confidences) / len(confidences)) if confidences else None,
                        now,
                        now,
                    ),
                )
                conn.executemany(
                    """
                    INSERT INTO block_line (line_id, block_id, line_index, bbox, text)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    [
                        (
                            new_ulid(),
                            block_id,
                            index,
                            blocks_module.bbox_to_json(line.bbox),
                            line.text,
                        )
                        for index, line in enumerate(block.lines)
                    ],
                )

        conn.execute(
            """
            UPDATE ocr_run
            SET status = 'succeeded', finished_at = ?, elapsed_seconds = ?, raw_result_path = ?
            WHERE run_id = ?
            """,
            (now, round(elapsed, 3), f"{OCR_RUNS_DIR_NAME}/{run_id}.json", run_id),
        )
        if applied:
            # R1 / R2：只有"采用"了这次运行才换 active_run_id
            conn.execute(
                "UPDATE page SET active_run_id = ? WHERE page_id = ?", (run_id, page_id)
            )
        conn.execute("UPDATE job_item SET status = 'succeeded' WHERE item_id = ?", (item_id,))
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()
        return applied


# ---------------------------------------------------------------- 原始输出

def _write_raw_result(
    path: Path,
    *,
    run_id: str,
    page_id: str,
    page_no: int,
    result: OcrResult,
    params: OcrParams,
    engine_version: str,
    total_elapsed: float,
    layout: grouping.PageLayout,
) -> None:
    """写 ``ocr_runs/<run_id>.json``（说明书 5.3 的 ``raw_result_path``）。"""
    payload = {
        "schema": RAW_SCHEMA_ID,
        "run_id": run_id,
        "page_id": page_id,
        "page_no": page_no,
        "engine_id": result.engine_id,
        "engine_version": engine_version,
        "params": {"dpi": params.dpi, "language": params.language},
        "image_width": result.image_width,
        "image_height": result.image_height,
        # 引擎自己报的耗时，与整页耗时（含渲染与落库）分开记
        "engine_elapsed_seconds": round(result.elapsed_seconds, 3),
        "total_elapsed_seconds": round(total_elapsed, 3),
        "line_count": len(result.lines),
        "lines": [
            {
                "index": index,
                "text": line.text,
                "bbox": line.bbox.as_list(),
                "confidence": line.confidence,
            }
            for index, line in enumerate(result.lines)
        ],
        # 分段当时的版面判断。块本身已入库（block / block_line），这里留下的是
        # **判断依据**："检测到疑似 N 栏，阅读顺序需人工确认"这类提示不该丢。
        "layout": {
            "block_count": len(layout.blocks),
            "column_count": layout.column_count,
            "reading_order_uncertain": layout.reading_order_uncertain,
            "notes": list(layout.notes),
        },
        "engine_raw": result.raw,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    # default=str：引擎元数据里可能有非 JSON 类型，宁可留字符串也不要写不下去
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )
