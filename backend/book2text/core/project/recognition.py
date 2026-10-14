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

**执行方式是同步的**（本阶段）：接口收到请求后当场把这一页认完再返回，
因此任务一创建就已经结束。说明书 Phase 2 要求的是子进程执行器 + 任务抽屉 +
暂停 / 继续 / 取消 / 重试失败页，那是下一步；数据模型（job / job_item）先按说明书建好，
换成执行器时接口形状不变（见 `docs/decisions.md` D-022）。

**原始输出**写在 ``ocr_runs/<run_id>.json``：引擎给出的行（文本 + 归一化坐标 +
置信度）与引擎自己的元数据。它记录的是**适配器取到的输出**，不是引擎内部对象。
路径以**相对项目目录**的形式入库，整包拷贝到另一台机器仍然有效（说明书第 10 节）。
"""

from __future__ import annotations

import json
import os
from collections.abc import Sequence
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


@dataclass(frozen=True)
class JobOutcome:
    """一次识别任务的结果。"""

    job: blocks_module.JobRecord
    items: tuple[blocks_module.JobItemRecord, ...]

    @property
    def failed_items(self) -> tuple[blocks_module.JobItemRecord, ...]:
        return tuple(item for item in self.items if item.status == "failed")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------- 对外入口

def recognize_pages(
    project_id: str,
    page_nos: Sequence[int],
    *,
    library: Path | None = None,
    dpi: int = DEFAULT_DPI,
    language: str = DEFAULT_LANGUAGE,
    engine: OcrEngine | None = None,
) -> JobOutcome:
    """识别若干页并落库，返回这次任务的结果。

    ``engine`` 留作注入点：生产代码用 RapidOCR，测试用假引擎走同一条落库路径。
    """
    if not page_nos:
        raise ProjectError("没有指定要识别的页面")
    if not MIN_DPI <= dpi <= MAX_DPI:
        raise ProjectError(f"DPI 必须在 {MIN_DPI}–{MAX_DPI} 之间，收到 {dpi}")

    target_library = library if library is not None else default_library_dir()
    directory = project_dir(target_library, project_id)

    # 识别要写数据库。若项目正被**另一个应用实例**打开（项目锁，说明书 7.6），
    # 这里拒绝，避免两个进程同时写同一个库。
    lock_status = lock_module.status(directory)
    if lock_status.held and lock_status.info is not None and lock_status.info.pid != os.getpid():
        raise ProjectError(
            f"{lock_status.describe()}。识别会写入项目数据库，"
            "请先在那边关闭项目，或在本窗口用「强制打开」"
        )

    # 识别要写库，因此这里应用迁移（与读取路径相反，见 blocks.py 的说明）
    load_project(project_id, library=target_library)

    pages_by_no = {page.page_no: page for page in list_pages(project_id, library=target_library)}
    selected: list[Page] = []
    for page_no in page_nos:
        page = pages_by_no.get(page_no)
        if page is None:
            raise ProjectError(f"没有第 {page_no} 页")
        if not page.include:
            raise ProjectError(
                f"第 {page_no} 页已排除，不参与识别。先把它纳入（单击缩略图）再识别"
            )
        selected.append(page)

    adapter: OcrEngine = engine if engine is not None else RapidOcrAdapter()
    available, reason = adapter.available()
    if not available:
        raise EngineUnavailable(reason)

    params = OcrParams(language=language, dpi=dpi)
    engine_version = adapter.version()
    source = directory / SOURCE_DIR_NAME / SOURCE_FILE_NAME

    job_id, item_ids = _create_job(project_id, selected, target_library, dpi=dpi, language=language)
    _update_job(project_id, job_id, target_library, status="running", started_at=_now())

    for page, item_id in zip(selected, item_ids):
        _run_item(
            project_id=project_id,
            library=target_library,
            directory=directory,
            source=source,
            page=page,
            item_id=item_id,
            adapter=adapter,
            params=params,
            engine_version=engine_version,
        )

    job = _finish_job(project_id, job_id, target_library)
    items = tuple(blocks_module.list_job_items(project_id, job_id, library=target_library))
    return JobOutcome(job=job, items=items)


# ---------------------------------------------------------------- 任务记录

def _create_job(
    project_id: str,
    pages: Sequence[Page],
    library: Path,
    *,
    dpi: int,
    language: str,
) -> tuple[str, list[str]]:
    job_id = new_ulid()
    now = _now()
    item_ids = [new_ulid() for _ in pages]

    directory = project_dir(library, project_id)
    with db_module.open_database(directory) as conn:
        conn.execute(
            """
            INSERT INTO job (job_id, job_type, status, total, done, failed, params_json, created_at)
            VALUES (?, 'ocr', 'queued', ?, 0, 0, ?, ?)
            """,
            (job_id, len(pages), json.dumps({"dpi": dpi, "language": language}), now),
        )
        conn.executemany(
            """
            INSERT INTO job_item (item_id, job_id, page_id, status, attempts)
            VALUES (?, ?, ?, 'queued', 0)
            """,
            [(item_id, job_id, page.page_id) for item_id, page in zip(item_ids, pages)],
        )
        conn.commit()
    return job_id, item_ids


def _update_job(
    project_id: str, job_id: str, library: Path, **fields: object
) -> None:
    assignments = ", ".join(f"{name} = ?" for name in fields)
    directory = project_dir(library, project_id)
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            f"UPDATE job SET {assignments} WHERE job_id = ?",
            (*fields.values(), job_id),
        )
        conn.commit()


def _finish_job(project_id: str, job_id: str, library: Path) -> blocks_module.JobRecord:
    """结算任务：done / failed 计数与最终状态。

    **有任何一页失败就算 failed**（部分失败也是失败）——done 与 failed 两个数字
    说明细节，界面上据此提示"3 页失败，可重试"。说明书的重试失败页在下一步。
    """
    directory = project_dir(library, project_id)
    with db_module.open_database(directory, apply_migrations=False) as conn:
        row = conn.execute(
            """
            SELECT SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS done,
                   SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed
            FROM job_item WHERE job_id = ?
            """,
            (job_id,),
        ).fetchone()
        done = int(row["done"] or 0)
        failed = int(row["failed"] or 0)
        conn.execute(
            "UPDATE job SET status = ?, done = ?, failed = ?, finished_at = ? WHERE job_id = ?",
            ("failed" if failed else "succeeded", done, failed, _now(), job_id),
        )
        conn.commit()
    return blocks_module.get_job(project_id, job_id, library=library)


# ---------------------------------------------------------------- 单页识别

def _run_item(
    *,
    project_id: str,
    library: Path,
    directory: Path,
    source: Path,
    page: Page,
    item_id: str,
    adapter: OcrEngine,
    params: OcrParams,
    engine_version: str,
) -> str:
    """识别一页：先落一条 running 的运行记录，成功或失败都会把它结算掉。

    这样"失败原因可见"（说明书 Phase 2 的验收）不依赖界面：
    数据库里就躺着 error_code 与 error_message。
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
                page.page_id,
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
        image = render.render_page_image(source, page.page_no - 1, dpi=params.dpi)
    except render.PdfError as exc:
        _fail_run(directory, run_id, item_id, ERROR_RENDER_FAILED, str(exc))
        return run_id

    try:
        result = adapter.recognize(image, params)
    except OcrEngineError as exc:
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
            page=page,
            result=result,
            params=params,
            engine_version=engine_version,
            total_elapsed=elapsed,
            layout=layout,
        )
    except OSError as exc:
        _fail_run(directory, run_id, item_id, ERROR_PERSIST_FAILED, f"写原始输出失败：{exc}")
        return run_id

    applied = _persist_blocks(
        directory, page, run_id=run_id, item_id=item_id, layout=layout, elapsed=elapsed
    )
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
    page: Page,
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
            "SELECT active_run_id FROM page WHERE page_id = ?", (page.page_id,)
        ).fetchone()
        has_active = active is not None and active["active_run_id"] is not None
        applied = not has_active or not _has_human_results(conn, page.page_id)

        if applied:
            # R1 / R2 的替换：旧块软删除（说明书 5.1：删除一律软删除）
            conn.execute(
                "UPDATE block SET deleted_at = ?, updated_at = ?"
                " WHERE page_id = ? AND deleted_at IS NULL",
                (now, now, page.page_id),
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
                        page.page_id,
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
                "UPDATE page SET active_run_id = ? WHERE page_id = ?", (run_id, page.page_id)
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
    page: Page,
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
        "page_id": page.page_id,
        "page_no": page.page_no,
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
