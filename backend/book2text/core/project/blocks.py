"""块、行、识别运行与任务的读取（说明书 5.3）。

这是**读**的一侧：把 `ocr_run` / `block` / `block_line` / `job` / `job_item`
里的记录拿出来，并按说明书 5.3 的规则**推导页面的识别状态**——
说明书明确"页面的识别状态与审校状态不单独存储，由 OCRRun 和 Block 推导"。

写的一侧在 `recognition.py`（识别 → 落库）。

坐标：``bbox`` 在数据库里是 JSON 文本（``[x0, y0, x1, y1]``，归一化，说明书 5.2），
读写两处共用本模块的 `bbox_to_json` / `bbox_from_json`。
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, replace
from pathlib import Path

from ..ocr.base import BBox
from ..storage import db as db_module
from .jobs import JOB_TYPE_OCR
from .library import Page, ProjectError, default_library_dir, list_pages, project_dir

# ---------------------------------------------------------------- 派生状态
#
# 说明书 5.3 的识别状态：未识别 / 排队中 / 识别中 / 已识别 / 失败 / 有待选新结果

STATUS_UNRECOGNIZED = "unrecognized"
STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_RECOGNIZED = "recognized"
STATUS_FAILED = "failed"
STATUS_HAS_CANDIDATE = "has_candidate"

RUN_TYPE_PRIMARY = "primary"
RUN_TYPE_AUXILIARY = "auxiliary"


# ---------------------------------------------------------------- 坐标 JSON

def bbox_to_json(bbox: BBox | None) -> str | None:
    if bbox is None:
        return None
    return json.dumps([round(value, 6) for value in bbox.as_list()])


def bbox_from_json(text: str | None) -> tuple[float, float, float, float] | None:
    if not text:
        return None
    try:
        values = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(values, list) or len(values) != 4:
        return None
    return (float(values[0]), float(values[1]), float(values[2]), float(values[3]))


# ---------------------------------------------------------------- 记录

@dataclass(frozen=True)
class RunRecord:
    run_id: str
    page_id: str
    page_no: int
    run_type: str
    engine_id: str
    engine_version: str
    params: dict
    status: str
    error_code: str | None
    error_message: str | None
    raw_result_path: str | None
    elapsed_seconds: float | None
    created_at: str
    finished_at: str | None

    def to_dict(self) -> dict[str, object]:
        return {
            "run_id": self.run_id,
            "page_id": self.page_id,
            "page_no": self.page_no,
            "run_type": self.run_type,
            "engine_id": self.engine_id,
            "engine_version": self.engine_version,
            "params": self.params,
            "status": self.status,
            "error_code": self.error_code,
            "error_message": self.error_message,
            "raw_result_path": self.raw_result_path,
            "elapsed_seconds": self.elapsed_seconds,
            "created_at": self.created_at,
            "finished_at": self.finished_at,
        }


@dataclass(frozen=True)
class BlockLineRecord:
    line_id: str
    block_id: str
    line_index: int
    bbox: tuple[float, float, float, float] | None
    text: str
    aux_text: str | None
    diff_status: str | None

    def to_dict(self) -> dict[str, object]:
        return {
            "line_id": self.line_id,
            "block_id": self.block_id,
            "line_index": self.line_index,
            "bbox": list(self.bbox) if self.bbox else None,
            "text": self.text,
            "aux_text": self.aux_text,
            "diff_status": self.diff_status,
        }


@dataclass(frozen=True)
class BlockRecord:
    block_id: str
    page_id: str
    page_no: int
    origin_run_id: str | None
    origin: str
    order_index: int
    bbox: tuple[float, float, float, float] | None
    block_type: str
    ocr_text: str
    text: str
    review_status: str
    include: bool
    continues_to_next: bool
    confidence: float | None
    revision: int
    reviewed_by: str | None
    comment: str | None
    created_at: str
    updated_at: str

    @property
    def modified(self) -> bool:
        """说明书 5.3：已修改 = ``text != ocr_text``，不需要用户设置。"""
        return self.text != self.ocr_text

    def to_dict(self) -> dict[str, object]:
        return {
            "block_id": self.block_id,
            "page_id": self.page_id,
            "page_no": self.page_no,
            "origin_run_id": self.origin_run_id,
            "origin": self.origin,
            "order_index": self.order_index,
            "bbox": list(self.bbox) if self.bbox else None,
            "block_type": self.block_type,
            "ocr_text": self.ocr_text,
            "text": self.text,
            "review_status": self.review_status,
            "include": self.include,
            "continues_to_next": self.continues_to_next,
            "confidence": self.confidence,
            "revision": self.revision,
            "reviewed_by": self.reviewed_by,
            "comment": self.comment,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "modified": self.modified,
        }


@dataclass(frozen=True)
class PageRecognition:
    """一页的**识别状态**（说明书 5.3 的推导结果）。"""

    page_id: str
    status: str
    active_run_id: str | None
    pending_run_id: str | None
    block_count: int
    run_count: int
    last_run_at: str | None
    last_error: str | None

    def to_dict(self) -> dict[str, object]:
        return {
            "status": self.status,
            "active_run_id": self.active_run_id,
            "pending_run_id": self.pending_run_id,
            "block_count": self.block_count,
            "run_count": self.run_count,
            "last_run_at": self.last_run_at,
            "last_error": self.last_error,
        }


EMPTY_RECOGNITION = PageRecognition(
    page_id="",
    status=STATUS_UNRECOGNIZED,
    active_run_id=None,
    pending_run_id=None,
    block_count=0,
    run_count=0,
    last_run_at=None,
    last_error=None,
)


# ---------------------------------------------------------------- 连接

def _directory(project_id: str, library: Path | None) -> Path:
    return project_dir(library if library is not None else default_library_dir(), project_id)


def _require_tables(conn: sqlite3.Connection, project_id: str) -> None:
    """识别相关表必须存在。

    读取一律**不应用迁移**（读接口不该悄悄改结构，只读打开的项目更不该被改）。
    若项目还是迁移 0001 的结构，给出可操作的提示而不是 500。
    """
    try:
        conn.execute("SELECT 1 FROM ocr_run LIMIT 1")
        conn.execute("SELECT 1 FROM block LIMIT 1")
        conn.execute("SELECT 1 FROM job LIMIT 1")
    except sqlite3.OperationalError as exc:
        if "no such table" not in str(exc):
            raise
        raise ProjectError(
            f"项目的数据库结构还是旧版本（{exc}）。先在界面上打开一次项目，"
            "打开时会自动备份并升级结构"
        ) from exc


def _open_for_read(project_id: str, library: Path | None):
    directory = _directory(project_id, library)
    if not directory.is_dir():
        raise ProjectError(f"找不到项目：{project_id}")
    return db_module.open_database(directory, apply_migrations=False)


# ---------------------------------------------------------------- 运行记录

def _row_to_run(row) -> RunRecord:
    try:
        params = json.loads(row["params_json"] or "{}")
    except json.JSONDecodeError:
        params = {}
    return RunRecord(
        run_id=row["run_id"],
        page_id=row["page_id"],
        page_no=int(row["page_no"]) if row["page_no"] is not None else 0,
        run_type=row["run_type"],
        engine_id=row["engine_id"],
        engine_version=row["engine_version"],
        params=params,
        status=row["status"],
        error_code=row["error_code"],
        error_message=row["error_message"],
        raw_result_path=row["raw_result_path"],
        elapsed_seconds=(
            float(row["elapsed_seconds"]) if row["elapsed_seconds"] is not None else None
        ),
        created_at=row["created_at"],
        finished_at=row["finished_at"],
    )


_RUN_SELECT = """
    SELECT r.*, p.page_no
    FROM ocr_run r JOIN page p ON p.page_id = r.page_id
"""


def list_runs(
    project_id: str,
    *,
    library: Path | None = None,
    page_no: int | None = None,
    run_type: str | None = None,
) -> list[RunRecord]:
    """按时间倒序列出识别运行；可按页号或类型（主 / 辅助）过滤。"""
    with _open_for_read(project_id, library) as conn:
        _require_tables(conn, project_id)
        clauses, params = [], []
        if page_no is not None:
            clauses.append("p.page_no = ?")
            params.append(page_no)
        if run_type is not None:
            clauses.append("r.run_type = ?")
            params.append(run_type)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = conn.execute(
            f"{_RUN_SELECT} {where} ORDER BY r.created_at DESC, r.run_id DESC", params
        ).fetchall()
    return [_row_to_run(row) for row in rows]


def get_run(project_id: str, run_id: str, *, library: Path | None = None) -> RunRecord:
    with _open_for_read(project_id, library) as conn:
        _require_tables(conn, project_id)
        row = conn.execute(f"{_RUN_SELECT} WHERE r.run_id = ?", (run_id,)).fetchone()
    if row is None:
        raise ProjectError(f"找不到识别记录：{run_id}")
    return _row_to_run(row)


# ---------------------------------------------------------------- 块与行

def row_to_block(row) -> BlockRecord:
    return BlockRecord(
        block_id=row["block_id"],
        page_id=row["page_id"],
        page_no=int(row["page_no"]),
        origin_run_id=row["origin_run_id"],
        origin=row["origin"],
        order_index=int(row["order_index"]),
        bbox=bbox_from_json(row["bbox"]),
        block_type=row["block_type"],
        ocr_text=row["ocr_text"] or "",
        text=row["text"] or "",
        review_status=row["review_status"],
        include=bool(row["include"]),
        continues_to_next=bool(row["continues_to_next"]),
        confidence=float(row["confidence"]) if row["confidence"] is not None else None,
        revision=int(row["revision"]),
        reviewed_by=row["reviewed_by"],
        comment=row["comment"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


_BLOCK_SELECT = """
    SELECT b.*, p.page_no
    FROM block b JOIN page p ON p.page_id = b.page_id
"""


def list_blocks(
    project_id: str,
    *,
    library: Path | None = None,
    page_no: int | None = None,
    include_deleted: bool = False,
) -> list[BlockRecord]:
    """按阅读顺序（页号、块序）列出块。默认不含软删除的块。"""
    with _open_for_read(project_id, library) as conn:
        _require_tables(conn, project_id)
        clauses, params = [], []
        if not include_deleted:
            clauses.append("b.deleted_at IS NULL")
        if page_no is not None:
            clauses.append("p.page_no = ?")
            params.append(page_no)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        rows = conn.execute(
            f"{_BLOCK_SELECT} {where} ORDER BY p.page_no, b.order_index, b.block_id", params
        ).fetchall()
    return [row_to_block(row) for row in rows]


def list_block_lines(
    project_id: str,
    *,
    library: Path | None = None,
    page_no: int | None = None,
) -> list[BlockLineRecord]:
    """按块序、行序列出块内行。"""
    with _open_for_read(project_id, library) as conn:
        _require_tables(conn, project_id)
        params: list[object] = []
        clause = ""
        if page_no is not None:
            clause = "WHERE p.page_no = ?"
            params.append(page_no)
        rows = conn.execute(
            f"""
            SELECT l.* FROM block_line l
            JOIN block b ON b.block_id = l.block_id
            JOIN page p ON p.page_id = b.page_id
            {clause}
            ORDER BY p.page_no, b.order_index, l.line_index
            """,
            params,
        ).fetchall()
    return [
        BlockLineRecord(
            line_id=row["line_id"],
            block_id=row["block_id"],
            line_index=int(row["line_index"]),
            bbox=bbox_from_json(row["bbox"]),
            text=row["text"] or "",
            aux_text=row["aux_text"],
            diff_status=row["diff_status"],
        )
        for row in rows
    ]


def load_page_content(
    project_id: str, page_no: int, *, library: Path | None = None
) -> tuple[Page, list[RunRecord], list[BlockRecord], list[BlockLineRecord]]:
    """一页的全部内容：页面记录、该页的运行、当前块、块内行。

    块是**当前有效**的块（未被软删除），按 ``order_index`` 排好序。
    """
    pages = {page.page_no: page for page in list_pages(project_id, library=library)}
    page = pages.get(page_no)
    if page is None:
        raise ProjectError(f"没有第 {page_no} 页")

    runs = list_runs(project_id, library=library, page_no=page_no)
    blocks = list_blocks(project_id, library=library, page_no=page_no)
    lines = list_block_lines(project_id, library=library, page_no=page_no)
    return page, runs, blocks, lines


# ---------------------------------------------------------------- 派生状态

def page_recognition_states(
    project_id: str, *, library: Path | None = None
) -> dict[str, PageRecognition]:
    """每页的识别状态（说明书 5.3 的推导规则）。

    推导顺序（先到先得）：

    1. 这一页在**正在进行的任务**里排着队 / 正在认 → 排队中 / 识别中
       （任务还没写运行记录，所以要看 job_item）。
    2. 最新一次运行还在排队 / 识别中 → 排队中 / 识别中。
    3. 页面**没有** active run：最新运行失败 → 失败；否则 → 未识别。
    4. 有 active run：若存在比它更新的**成功**运行 → 有待选新结果（说明书 R2
       所说的"新识别结果"）；否则 → 已识别。

    审校状态不在本函数里：它由块的 `review_status` 推导，属于 Phase 3 的审校视图。
    """
    with _open_for_read(project_id, library) as conn:
        _require_tables(conn, project_id)
        run_rows = conn.execute(
            f"{_RUN_SELECT} WHERE r.run_type = ? ORDER BY r.created_at DESC, r.run_id DESC",
            (RUN_TYPE_PRIMARY,),
        ).fetchall()
        page_rows = conn.execute("SELECT page_id, active_run_id FROM page").fetchall()
        block_rows = conn.execute(
            "SELECT page_id, COUNT(*) AS n FROM block WHERE deleted_at IS NULL GROUP BY page_id"
        ).fetchall()
        # 正在进行的任务里的单元：任务开始后、运行记录写出之前，
        # "这一页在排队 / 正在认"只能从 job_item 看出来
        item_rows = conn.execute(
            """
            SELECT i.page_id, i.status
            FROM job_item i JOIN job j ON j.job_id = i.job_id
            WHERE j.status IN ('queued', 'running', 'paused')
              AND j.job_type = ? AND i.status IN ('queued', 'running')
            ORDER BY i.item_id
            """,
            (JOB_TYPE_OCR,),
        ).fetchall()

    block_counts = {row["page_id"]: int(row["n"]) for row in block_rows}
    active_by_page = {row["page_id"]: row["active_run_id"] for row in page_rows}
    queued_pages = {row["page_id"] for row in item_rows if row["status"] == "queued"}
    running_pages = {row["page_id"] for row in item_rows if row["status"] == "running"}

    # 每页的最新运行、最新成功运行、最新失败原因
    latest: dict[str, RunRecord] = {}
    latest_succeeded: dict[str, RunRecord] = {}
    latest_error: dict[str, str] = {}
    counts: dict[str, int] = {}
    for row in run_rows:
        run = _row_to_run(row)
        counts[run.page_id] = counts.get(run.page_id, 0) + 1
        latest.setdefault(run.page_id, run)
        if run.status == "succeeded":
            latest_succeeded.setdefault(run.page_id, run)
        elif run.status == "failed" and run.page_id not in latest_error:
            latest_error[run.page_id] = run.error_message or run.error_code or "识别失败"

    states: dict[str, PageRecognition] = {}
    for page_id, active_run_id in active_by_page.items():
        newest = latest.get(page_id)
        candidate = latest_succeeded.get(page_id)

        if page_id in running_pages:
            status, pending = STATUS_RUNNING, active_run_id
        elif page_id in queued_pages:
            status, pending = STATUS_QUEUED, active_run_id
        elif newest is not None and newest.status in ("queued", "running"):
            status = STATUS_QUEUED if newest.status == "queued" else STATUS_RUNNING
            pending = active_run_id
        elif active_run_id is None:
            status = STATUS_FAILED if newest is not None else STATUS_UNRECOGNIZED
            pending = None
        elif candidate is not None and candidate.run_id != active_run_id:
            status = STATUS_HAS_CANDIDATE
            pending = candidate.run_id
        else:
            status = STATUS_RECOGNIZED
            pending = None

        states[page_id] = PageRecognition(
            page_id=page_id,
            status=status,
            active_run_id=active_run_id,
            pending_run_id=pending,
            block_count=block_counts.get(page_id, 0),
            run_count=counts.get(page_id, 0),
            last_run_at=(newest.finished_at or newest.created_at) if newest else None,
            last_error=latest_error.get(page_id),
        )
    return states


@dataclass(frozen=True)
class PageReview:
    """一页的**审校进度**（说明书 5.3 的推导规则，与识别状态同源）：

    未开始 / 进行中 / 已完成（所有纳入的块均已确认）/ 有疑问（存在不确定块）。
    只统计**纳入**的块——排除的块不参与导出，确认与否没有意义。
    """

    block_count: int = 0
    included: int = 0
    unreviewed: int = 0
    confirmed: int = 0
    uncertain: int = 0
    modified: int = 0

    @property
    def status(self) -> str:
        if self.included == 0:
            return "not_started" if self.block_count == 0 else "excluded"
        if self.uncertain:
            return "questioned"
        if self.unreviewed:
            return "in_progress" if self.confirmed or self.modified else "not_started"
        return "done"

    def to_dict(self) -> dict[str, object]:
        return {
            "status": self.status,
            "block_count": self.block_count,
            "included": self.included,
            "unreviewed": self.unreviewed,
            "confirmed": self.confirmed,
            "uncertain": self.uncertain,
            "modified": self.modified,
        }


def page_review_states(project_id: str, *, library: Path | None = None) -> dict[str, PageReview]:
    """每页的审校进度（一次聚合查询，不给每页单独查一次）。"""
    with _open_for_read(project_id, library) as conn:
        _require_tables(conn, project_id)
        rows = conn.execute(
            """
            SELECT page_id,
                   COUNT(*) AS block_count,
                   SUM(CASE WHEN include THEN 1 ELSE 0 END) AS included,
                   SUM(CASE WHEN include AND review_status = 'unreviewed' THEN 1 ELSE 0 END) AS unreviewed,
                   SUM(CASE WHEN include AND review_status = 'confirmed'  THEN 1 ELSE 0 END) AS confirmed,
                   SUM(CASE WHEN include AND review_status = 'uncertain'  THEN 1 ELSE 0 END) AS uncertain,
                   SUM(CASE WHEN include AND text <> ocr_text THEN 1 ELSE 0 END) AS modified
            FROM block WHERE deleted_at IS NULL GROUP BY page_id
            """
        ).fetchall()
    return {
        row["page_id"]: PageReview(
            block_count=int(row["block_count"] or 0),
            included=int(row["included"] or 0),
            unreviewed=int(row["unreviewed"] or 0),
            confirmed=int(row["confirmed"] or 0),
            uncertain=int(row["uncertain"] or 0),
            modified=int(row["modified"] or 0),
        )
        for row in rows
    }


def empty_review() -> PageReview:
    return PageReview()


def empty_recognition(page_id: str) -> PageRecognition:
    """给还没有任何运行记录的页面用的初始状态。"""
    return replace(EMPTY_RECOGNITION, page_id=page_id)
