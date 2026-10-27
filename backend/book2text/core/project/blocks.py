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
from collections.abc import Sequence
from dataclasses import dataclass, replace
from pathlib import Path

from ..ocr import compare as compare_module
from ..ocr.base import BBox
from ..ocr.compare import GRADES
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

RUN_STATUS_SUCCEEDED = "succeeded"


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
    # 改框之后「行 → 块」归属的结果（说明书 5.3 的扩展，见迁移 0006）：
    # assigned / conflict / unassigned。行本身永远不会被丢弃。
    layout_status: str = "assigned"
    # 任务 67：人工裁决。NULL = 未处理；kept = 保留原文；adopted = 采纳第二路。
    diff_ack: str | None = None
    diff_ack_text: str | None = None
    # 任务 59：行内字 / 词框（JSON，迁移 0021）。NULL = 没有字框，界面退化成整行标记。
    word_boxes: str | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "line_id": self.line_id,
            "block_id": self.block_id,
            "line_index": self.line_index,
            "bbox": list(self.bbox) if self.bbox else None,
            "text": self.text,
            "aux_text": self.aux_text,
            "diff_status": self.diff_status,
            "layout_status": self.layout_status,
            "diff_ack": self.diff_ack,
            "word_boxes": self.word_boxes,
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
    # 版面（框 / 类型 / 顺序）是否被人工确认过；默认未确认（老项目升级后同样是未确认）。
    layout_confirmed: bool = False
    # 「延续到下一页」是否**人看过并决定**（任务 42）。自动判定写 continues_to_next
    # 但不动这一列——机器判的不算人看过；撤销时写回 0，那一处重新回到待确认。
    continues_reviewed: bool = False

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
            "layout_confirmed": self.layout_confirmed,
            "continues_reviewed": self.continues_reviewed,
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

def row_to_run(row) -> RunRecord:
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
    return [row_to_run(row) for row in rows]


def run_of_page(conn, run_id: str, page_id: str) -> RunRecord | None:
    """给编辑层用：在一份已打开的连接上取"这一页的这次运行"。"""
    row = conn.execute(
        """
        SELECT r.*, p.page_no FROM ocr_run r JOIN page p ON p.page_id = r.page_id
        WHERE r.run_id = ? AND r.page_id = ?
        """,
        (run_id, page_id),
    ).fetchone()
    return row_to_run(row) if row else None


def latest_decline(conn, page_id: str) -> str | None:
    """这一页最近一次"保留现有"的时间（说明书 R2）。

    候选 = 比这个时间更新的成功运行。"采用"**不**参与这个判断——
    采用之后 active run 就是它，`run_id != active_run_id` 自然把它排除掉了；
    而如果把它也算进来，"采用之后又撤销"会把候选一起压掉。
    """
    row = conn.execute(
        """
        SELECT created_at FROM event
        WHERE entity_type = 'page' AND entity_id = ? AND action = 'decline_run'
        ORDER BY created_at DESC, event_id DESC LIMIT 1
        """,
        (page_id,),
    ).fetchone()
    return str(row["created_at"]) if row else None


def get_run(project_id: str, run_id: str, *, library: Path | None = None) -> RunRecord:
    with _open_for_read(project_id, library) as conn:
        _require_tables(conn, project_id)
        row = conn.execute(f"{_RUN_SELECT} WHERE r.run_id = ?", (run_id,)).fetchone()
    if row is None:
        raise ProjectError(f"找不到识别记录：{run_id}")
    return row_to_run(row)


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
        # 迁移 0006 之前的库在 SELECT 里也会带上这一列（默认 0）；用 len(row) 兼容旧行对象
        layout_confirmed=bool(row["layout_confirmed"]) if "layout_confirmed" in row.keys() else False,
        continues_reviewed=(
            bool(row["continues_reviewed"]) if "continues_reviewed" in row.keys() else False
        ),
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


def get_block(
    project_id: str,
    block_id: str,
    *,
    library: Path | None = None,
) -> BlockRecord:
    """按 id 取一个块（不存在 / 已软删除就报错）。"""
    with _open_for_read(project_id, library) as conn:
        _require_tables(conn, project_id)
        row = conn.execute(
            f"{_BLOCK_SELECT} WHERE b.block_id = ? AND b.deleted_at IS NULL",
            (block_id,),
        ).fetchone()
    if row is None:
        raise ProjectError(f"找不到块：{block_id}")
    return row_to_block(row)


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
            layout_status=row["layout_status"] if "layout_status" in row.keys() else "assigned",
            diff_ack=row["diff_ack"] if "diff_ack" in row.keys() else None,
            diff_ack_text=row["diff_ack_text"] if "diff_ack_text" in row.keys() else None,
            word_boxes=row["word_boxes"] if "word_boxes" in row.keys() else None,
        )
        for row in rows
    ]


# 书眉 / 页脚 / 页码 / 插图 / 装饰：**不是正文行**。版心拟合、行数统计、
# "这一页有没有文字"三处必须用同一份口径，否则会出现"界面说有 23 页可生成、
# 拟合却说没行"（TTBVW3 实测：23 页只有书眉块）。
FURNITURE_BLOCK_TYPES = frozenset(
    {"header", "footer", "page_number", "figure", "decoration"}
)


def pages_with_text(
    project_id: str, *, library: Path | None = None
) -> set[str]:
    """有**非空识别文字**的 page_id 集合（一次查询，不做 N+1）。

    收尾面板要区分"这页还没有正文行（未定）"与"这页本来就没有字"（插图页 / 空白页）：
    后者缺版心不算未定，否则步骤条永远绿不了。没识别过的页自然不在集合里。
    """
    with _open_for_read(project_id, library) as conn:
        _require_tables(conn, project_id)
        rows = conn.execute(
            """
            SELECT DISTINCT b.page_id FROM block b
            WHERE b.deleted_at IS NULL AND TRIM(COALESCE(b.text, '')) <> ''
              AND b.block_type NOT IN (?, ?, ?, ?, ?)
            """,
            tuple(sorted(FURNITURE_BLOCK_TYPES)),
        ).fetchall()
    return {row["page_id"] for row in rows}


def page_has_successful_run(
    project_id: str, page_id: str, *, library: Path | None = None
) -> bool:
    """这一页有没有**已成功的主引擎识别运行**（一次查询）。

    「无文字」（插图页 / 空白页）与「还没识别」必须分开：只有识别真的跑过、
    结果确实没有字，才叫无文字；从没识别过的页是未定，不是无文字。
    """
    with _open_for_read(project_id, library) as conn:
        _require_tables(conn, project_id)
        row = conn.execute(
            "SELECT 1 FROM ocr_run WHERE page_id = ? AND run_type = ? AND status = 'succeeded'"
            " LIMIT 1",
            (page_id, RUN_TYPE_PRIMARY),
        ).fetchone()
    return row is not None


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


# ---------------------------------------------------------------- 候选块与现有块的配对

# bbox 重叠到什么程度才算"同一个块"（说明书 6.4 的逐块采用要用它）
MATCH_MIN_IOU = 0.3


def bbox_overlap(left, right) -> float:
    """两个框的 IoU（交并比）。任一为空或面积为 0 时返回 0。"""
    if not left or not right:
        return 0.0
    x0 = max(left[0], right[0])
    y0 = max(left[1], right[1])
    x1 = min(left[2], right[2])
    y1 = min(left[3], right[3])
    if x1 <= x0 or y1 <= y0:
        return 0.0
    intersection = (x1 - x0) * (y1 - y0)
    left_area = max(left[2] - left[0], 0.0) * max(left[3] - left[1], 0.0)
    right_area = max(right[2] - right[0], 0.0) * max(right[3] - right[1], 0.0)
    union = left_area + right_area - intersection
    return intersection / union if union > 0 else 0.0


def match_candidate_blocks(
    current: Sequence[BlockRecord],
    candidate: Sequence[dict],
    *,
    min_iou: float = MATCH_MIN_IOU,
) -> list[dict[str, object]]:
    """把一份候选结果的块与**现有**的块配对（说明书 6.4 的"逐块采用"）。

    同一页的两次识别，块的排布大体不变，所以先按 **bbox 重叠（IoU）**贪心配对
    （重叠大的先配，一个现有块最多配一次）；配不上的按**序号**退化配对；
    还配不上的就是"这次多出来的块"，`target_block_id` 为 None——
    界面据此显示"新增块"，采用时插到阅读顺序里合适的位置。

    返回与 `candidate` 等长的列表，每项：
    ``{"target_block_id", "target_index", "iou", "same_text"}``。
    """
    matched: list[dict[str, object]] = [
        {"target_block_id": None, "target_index": None, "iou": 0.0, "same_text": False}
        for _ in candidate
    ]
    used: set[int] = set()

    scored: list[tuple[float, int, int]] = []
    for candidate_index, item in enumerate(candidate):
        box = item.get("bbox")
        if not box:
            continue
        for block_index, block in enumerate(current):
            if block.bbox is None:
                continue
            iou = bbox_overlap(tuple(box), block.bbox)
            if iou >= min_iou:
                scored.append((iou, candidate_index, block_index))

    for iou, candidate_index, block_index in sorted(scored, reverse=True):
        if matched[candidate_index]["target_block_id"] is not None or block_index in used:
            continue
        block = current[block_index]
        matched[candidate_index] = {
            "target_block_id": block.block_id,
            "target_index": block_index,
            "iou": round(iou, 4),
            "same_text": (candidate[candidate_index].get("text") or "") == block.text,
        }
        used.add(block_index)

    # 退化：按序号配（识别顺序与阅读顺序一致时，这是最常见的情形）
    for candidate_index, item in enumerate(candidate):
        if matched[candidate_index]["target_block_id"] is not None:
            continue
        if candidate_index < len(current) and candidate_index not in used:
            block = current[candidate_index]
            matched[candidate_index] = {
                "target_block_id": block.block_id,
                "target_index": candidate_index,
                "iou": 0.0,
                "same_text": (item.get("text") or "") == block.text,
            }
            used.add(candidate_index)
    return matched


# ---------------------------------------------------------------- 分歧（说明书 8.5 的落点）


@dataclass(frozen=True)
class LineDivergence:
    """一行的分歧标记：**块里现在的这一行** vs 第二引擎读到的那一行。"""

    line_index: int
    level: str
    current: str
    candidate: str
    ack: str | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "line_index": self.line_index,
            "level": self.level,
            "current": self.current,
            "candidate": self.candidate,
            "ack": self.ack,
        }


@dataclass(frozen=True)
class BlockDivergence:
    """一个块的分歧概况（说明书 8.5）。

    标记按**块里现在的文本**逐行现算，而不是照抄识别时写下的 ``diff_status``：
    说明书 8.5 要求"点一下即可替换为另一路文本（作为对 ``text`` 的编辑）"，
    换过之后那一行的标记就该消失。因此 ``diff_status`` 只用来判断这一行复核过没有。
    """

    identical: int = 0
    chars: int = 0
    punct: int = 0
    empty: int = 0
    format_only: int = 0
    acked: int = 0
    stale: bool = False
    marks: tuple[LineDivergence, ...] = ()

    @property
    def lines(self) -> int:
        """有实质分歧的行数（汉字级 + 标点级），即说明书 8.5 的"分歧行"。"""
        return self.chars + self.punct

    def to_dict(self) -> dict[str, object]:
        return {
            "lines": self.lines,
            "identical": self.identical,
            "chars": self.chars,
            "punct": self.punct,
            "empty": self.empty,
            "format_only": self.format_only,
            "acked": self.acked,
            "stale": self.stale,
            "marks": [mark.to_dict() for mark in self.marks],
        }


@dataclass(frozen=True)
class PageDivergence:
    """一页的分歧概况：逐块相加，外加"这一页跑没跑过第二引擎复核"。

    ``checked`` 为假时不能把"0 分歧"读成"两路一致"——那一页根本没复核过。
    """

    identical: int = 0
    chars: int = 0
    punct: int = 0
    empty: int = 0
    format_only: int = 0
    acked: int = 0
    stale_blocks: int = 0
    checked: bool = False
    engine_id: str | None = None
    checked_at: str | None = None

    @property
    def lines(self) -> int:
        return self.chars + self.punct

    @property
    def compared_lines(self) -> int:
        """两边都有文本、能比的行数（分歧率的分母）。"""
        return self.identical + self.format_only + self.chars + self.punct

    def to_dict(self) -> dict[str, object]:
        return {
            "lines": self.lines,
            "identical": self.identical,
            "chars": self.chars,
            "punct": self.punct,
            "empty": self.empty,
            "format_only": self.format_only,
            "acked": self.acked,
            "stale_blocks": self.stale_blocks,
            "checked": self.checked,
            "engine_id": self.engine_id,
            "checked_at": self.checked_at,
        }


EMPTY_BLOCK_DIVERGENCE = BlockDivergence()
EMPTY_PAGE_DIVERGENCE = PageDivergence()


def block_divergence(
    block: BlockRecord, lines: Sequence[BlockLineRecord]
) -> BlockDivergence:
    """按块里现在的文本，逐行标出与第二引擎的分歧（说明书 8.5）。"""
    graded = [line for line in lines if line.aux_text is not None]
    if not graded:
        return EMPTY_BLOCK_DIVERGENCE

    current_lines = block.text.split("\n")
    # 行记录与文本行必须一一对应。人工在块里增删过换行之后就对不上了，
    # 这时按序号标出来的是错的——宁可不标，也不指错地方。
    aligned = len(current_lines) == len(lines) and [
        line.line_index for line in lines
    ] == list(range(len(lines)))
    if not aligned:
        return BlockDivergence(stale=True)

    counts = dict.fromkeys(GRADES, 0)
    identical = 0
    acked = 0
    marks: list[LineDivergence] = []
    for line in lines:
        if line.aux_text is None:
            continue
        current = current_lines[line.line_index]
        # 文本被人工改过之后，旧 ack 不再适用：立即恢复成待处理，等下一次复核再清库。
        ack = line.diff_ack if (line.diff_ack_text or "") == current else None
        # 第二引擎什么也没读出来：它没提供任何关于原文的信息，不算分歧
        level = (
            compare_module.NO_CANDIDATE
            if not line.aux_text.strip()
            else compare_module.grade_line(current, line.aux_text)
        )
        if ack:
            acked += 1
            if level == compare_module.IDENTICAL:
                identical += 1
                continue
            # 已裁决的行仍然出现在 marks 里，界面可以展开查看 / 审计；
            # 但计数只算未裁决的行。
            marks.append(
                LineDivergence(
                    line_index=line.line_index,
                    level=level,
                    current=current,
                    candidate=line.aux_text,
                    ack=ack,
                )
            )
            continue
        if level == compare_module.IDENTICAL:
            identical += 1
            continue
        counts[level] = counts.get(level, 0) + 1
        marks.append(
            LineDivergence(
                line_index=line.line_index,
                level=level,
                current=current,
                candidate=line.aux_text,
            )
        )
    return BlockDivergence(
        identical=identical,
        chars=counts[compare_module.DIFFERS_CHARS],
        punct=counts[compare_module.DIFFERS_PUNCT],
        empty=counts[compare_module.NO_CANDIDATE],
        format_only=counts[compare_module.FORMAT_ONLY_DIFFERS],
        acked=acked,
        marks=tuple(marks),
    )


def pages_with_auxiliary_run(
    project_id: str, *, library: Path | None = None
) -> set[str]:
    """有**成功**的第二引擎复核记录的页 id（说明书 8.5：复核可以随时补跑 / 重跑）。

    只在"跳过已复核的页"这一处用——它回答的是"这一页复核过没有"，
    不回答"有没有分歧"（那是 `page_divergences` 的事）。
    """
    with _open_for_read(project_id, library) as conn:
        _require_tables(conn, project_id)
        rows = conn.execute(
            "SELECT DISTINCT page_id FROM ocr_run WHERE run_type = ? AND status = ?",
            (RUN_TYPE_AUXILIARY, RUN_STATUS_SUCCEEDED),
        ).fetchall()
    return {row["page_id"] for row in rows}


def _latest_auxiliary_run(runs: Sequence[RunRecord]) -> RunRecord | None:
    """最近一次**成功**的第二引擎复核（说明书 8.5：复核可以随时补跑 / 重跑）。"""
    succeeded = [
        run
        for run in runs
        if run.run_type == RUN_TYPE_AUXILIARY and run.status == RUN_STATUS_SUCCEEDED
    ]
    if not succeeded:
        return None
    return max(succeeded, key=lambda run: (run.finished_at or run.created_at, run.run_id))


def page_divergence_summary(
    blocks: Sequence[BlockRecord],
    lines: Sequence[BlockLineRecord],
    runs: Sequence[RunRecord],
    *,
    inside_block_ids: set[str] | None = None,
) -> PageDivergence:
    """一页的分歧概况：各块相加 + 复核记录（审校视图与疑难筛选共用这一份）。

    ``inside_block_ids`` 给了就只统计这些块（版心内）。审校 / 待处理 / 自动通过 /
    导出状态都传这一份；``None`` 表示整页都算（老调用方 / 没有版心的页）。
    """
    by_block: dict[str, list[BlockLineRecord]] = {}
    for line in lines:
        by_block.setdefault(line.block_id, []).append(line)

    identical = chars = punct = empty = format_only = acked = stale_blocks = 0
    for block in blocks:
        if inside_block_ids is not None and block.block_id not in inside_block_ids:
            continue
        divergence = block_divergence(block, by_block.get(block.block_id, []))
        identical += divergence.identical
        chars += divergence.chars
        punct += divergence.punct
        empty += divergence.empty
        format_only += divergence.format_only
        acked += divergence.acked
        stale_blocks += 1 if divergence.stale else 0

    run = _latest_auxiliary_run(runs)
    return PageDivergence(
        identical=identical,
        chars=chars,
        punct=punct,
        empty=empty,
        format_only=format_only,
        acked=acked,
        stale_blocks=stale_blocks,
        checked=run is not None,
        engine_id=run.engine_id if run else None,
        checked_at=(run.finished_at or run.created_at) if run else None,
    )


def page_divergences(
    project_id: str, *, library: Path | None = None
) -> dict[str, PageDivergence]:
    """整个项目每页的分歧概况（读全部块 / 行 / 复核记录，不给每页单独查询）。

    页面列表用它给"有分歧"筛选与缩略图上的标记供数。

    任务 34 起只统计**版心内**的块（与导出第一层同一个
    `margin_box.block_inside_margin`）；版心外的书眉 / 页码差异不进审校口径。
    """
    target_library = library if library is not None else default_library_dir()
    blocks = list_blocks(project_id, library=target_library)
    lines = list_block_lines(project_id, library=target_library)
    runs = list_runs(project_id, library=target_library, run_type=RUN_TYPE_AUXILIARY)

    lines_by_block: dict[str, list[BlockLineRecord]] = {}
    for line in lines:
        lines_by_block.setdefault(line.block_id, []).append(line)
    blocks_by_page: dict[str, list[BlockRecord]] = {}
    for block in blocks:
        blocks_by_page.setdefault(block.page_id, []).append(block)
    runs_by_page: dict[str, list[RunRecord]] = {}
    for run in runs:
        runs_by_page.setdefault(run.page_id, []).append(run)

    # 延迟导入：`margin_box` 在模块顶层 import 了本模块（循环），这里运行时两边都已加载。
    from . import library as library_module
    from . import margin_box as margin_box_module

    project = library_module.load_project(project_id, library=target_library)
    pages = library_module.list_pages(project_id, library=target_library)
    page_by_id = {page.page_id: page for page in pages}

    result: dict[str, PageDivergence] = {}
    for page_id, page_blocks in blocks_by_page.items():
        page_lines = [
            line
            for block in page_blocks
            for line in lines_by_block.get(block.block_id, [])
        ]
        page = page_by_id.get(page_id)
        # 任务 34：审校 / 待处理 / 导出状态只算**版心内**的块；没有版心的页整页都算。
        inside_ids = (
            {
                block.block_id
                for block in page_blocks
                if margin_box_module.block_inside_margin(project, page, block.bbox)
            }
            if page is not None
            else None
        )
        result[page_id] = page_divergence_summary(
            page_blocks, page_lines, runs_by_page.get(page_id, []),
            inside_block_ids=inside_ids,
        )
    # 没有块却有复核记录的页（复核过又删光了块）也要出现在结果里
    for page_id, page_runs in runs_by_page.items():
        if page_id not in result:
            result[page_id] = page_divergence_summary((), (), page_runs)
    return result


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
        # 最近一次"采用 / 保留"决定（说明书 R2）：决定之后的运行才算新候选，
        # 否则用户点了"保留现有"之后提示会一直挂着
        decision_rows = conn.execute(
            """
            SELECT entity_id, MAX(created_at) AS declined_at FROM event
            WHERE entity_type = 'page' AND action = 'decline_run' GROUP BY entity_id
            """
        ).fetchall()
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
    declined_at = {row["entity_id"]: str(row["declined_at"]) for row in decision_rows}
    queued_pages = {row["page_id"] for row in item_rows if row["status"] == "queued"}
    running_pages = {row["page_id"] for row in item_rows if row["status"] == "running"}

    # 每页的最新运行、最新成功运行、最新失败原因
    latest: dict[str, RunRecord] = {}
    latest_succeeded: dict[str, RunRecord] = {}
    latest_error: dict[str, str] = {}
    counts: dict[str, int] = {}
    for row in run_rows:
        run = row_to_run(row)
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
        elif (
            candidate is not None
            and candidate.run_id != active_run_id
            and _is_newer_than_decision(candidate, declined_at.get(page_id))
        ):
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


def _is_newer_than_decision(run: RunRecord, declined_at: str | None) -> bool:
    """这次运行是不是在最近一次"保留现有"之后产生的（说明书 R2）。"""
    if declined_at is None:
        return True
    stamp = run.finished_at or run.created_at
    return stamp > declined_at


def empty_recognition(page_id: str) -> PageRecognition:
    """给还没有任何运行记录的页面用的初始状态。"""
    return replace(EMPTY_RECOGNITION, page_id=page_id)
