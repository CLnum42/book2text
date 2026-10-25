"""任务与任务单元（说明书 5.3 的 Job / JobItem，6.3 的任务控制）。

一个任务就是**一批识别**：按页拆成单元（JobItem），因此可以断点续跑与幂等重试。
本模块只管 `job` / `job_item` 两张表里的**状态、进度与修理**，
不跑识别——跑识别的是 `recognition.py`，而且是在**子进程**里跑
（见 `core/jobs/executor.py`）。

**为什么参数是项目目录而不是 project_id + 库目录：** 执行识别的子进程只知道
自己的项目文件夹，既拿不到也不需要项目库的位置。父进程那边由
`library.project_dir()` 解析出目录后传进来。

**修理（repair）的规矩：** 把还停在 `running` 的单元与运行记录结算成"已中断"，
**只能在确认执行者已经退出之后**做——否则会与还活着的子进程抢着写同一条记录。
子进程自己退出（读到取消信号或父进程已死）时由它自己修理；
被父进程杀掉时，由父进程在 `wait()` 返回之后修理。
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ..storage import db as db_module
from ..storage.ulid import new_ulid

JOB_TYPE_OCR = "ocr"

# 第二引擎复核（说明书 8.5 / R1b）：任务形状与识别完全一样（按页一个单元、
# 可暂停 / 取消 / 重试失败页），只是每页做的是"逐行复核"而不是"识别并生成块"。
JOB_TYPE_AUXILIARY = "auxiliary"

# 版面检测（任务 58 / 工作流阶段 2）：只检测不识别，落 layout_run + page_layout_line。
# 任务形状与识别完全一样（按页一个单元），共用暂停 / 继续 / 取消 / 重试。
JOB_TYPE_LAYOUT = "layout"

JOB_TYPES = (JOB_TYPE_OCR, JOB_TYPE_AUXILIARY, JOB_TYPE_LAYOUT)

# 任务类型的人话名字（界面与日志共用）
JOB_TYPE_LABELS = {
    JOB_TYPE_OCR: "识别",
    JOB_TYPE_AUXILIARY: "第二引擎复核",
    JOB_TYPE_LAYOUT: "版面检测",
}

STATUS_QUEUED = "queued"
STATUS_RUNNING = "running"
STATUS_PAUSED = "paused"
STATUS_SUCCEEDED = "succeeded"
STATUS_FAILED = "failed"
STATUS_CANCELLED = "cancelled"
STATUS_INTERRUPTED = "interrupted"

# 还在进行中的状态（没跑完也没被停掉）
ACTIVE_STATUSES = (STATUS_QUEUED, STATUS_RUNNING, STATUS_PAUSED)
TERMINAL_STATUSES = (
    STATUS_SUCCEEDED,
    STATUS_FAILED,
    STATUS_CANCELLED,
    STATUS_INTERRUPTED,
)

ITEM_STATUS_QUEUED = "queued"
ITEM_STATUS_RUNNING = "running"
ITEM_STATUS_SUCCEEDED = "succeeded"
ITEM_STATUS_FAILED = "failed"

# 未成功的单元：还会被继续 / 重试挑走
UNFINISHED_ITEM_STATUSES = (ITEM_STATUS_QUEUED, ITEM_STATUS_RUNNING, ITEM_STATUS_FAILED)

INTERRUPTED_MESSAGE = "识别过程中断（应用被关闭）"


class JobError(Exception):
    """任务层面的错误（找不到任务、状态不允许这个操作等）。"""


@dataclass(frozen=True)
class JobRecord:
    job_id: str
    job_type: str
    status: str
    total: int
    done: int
    failed: int
    params: dict
    created_at: str
    started_at: str | None
    finished_at: str | None

    @property
    def is_active(self) -> bool:
        return self.status in ACTIVE_STATUSES

    @property
    def remaining(self) -> int:
        return max(self.total - self.done - self.failed, 0)

    @property
    def percent(self) -> float:
        if self.total <= 0:
            return 100.0
        return round((self.done + self.failed) / self.total * 100, 1)

    def to_dict(self) -> dict[str, object]:
        return {
            "job_id": self.job_id,
            "job_type": self.job_type,
            "status": self.status,
            "total": self.total,
            "done": self.done,
            "failed": self.failed,
            "remaining": self.remaining,
            "percent": self.percent,
            "params": self.params,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


@dataclass(frozen=True)
class JobItemRecord:
    item_id: str
    job_id: str
    page_id: str
    page_no: int | None
    status: str
    run_id: str | None
    error_message: str | None
    attempts: int

    def to_dict(self) -> dict[str, object]:
        return {
            "item_id": self.item_id,
            "job_id": self.job_id,
            "page_id": self.page_id,
            "page_no": self.page_no,
            "status": self.status,
            "run_id": self.run_id,
            "error_message": self.error_message,
            "attempts": self.attempts,
        }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _open(directory: Path):
    """打开项目数据库（读写的通用入口）。

    目录或数据库不存在时给出明确错误：``sqlite3.connect`` 会**创建**缺失的文件，
    照直连过去就会在不存在的地方凭空造出一个空库。
    """
    if not directory.is_dir() or not db_module.database_path(directory).is_file():
        raise JobError(f"找不到项目数据库：{directory}")
    return db_module.open_database(directory, apply_migrations=False)


def _require_tables(conn: sqlite3.Connection) -> None:
    try:
        conn.execute("SELECT 1 FROM job LIMIT 1")
        conn.execute("SELECT 1 FROM job_item LIMIT 1")
    except sqlite3.OperationalError as exc:
        if "no such table" not in str(exc):
            raise
        raise JobError(f"项目结构还是旧版本（{exc}）：先打开一次项目以升级结构") from exc


# ---------------------------------------------------------------- 读取

def _row_to_job(row) -> JobRecord:
    try:
        params = json.loads(row["params_json"] or "{}")
    except json.JSONDecodeError:
        params = {}
    return JobRecord(
        job_id=row["job_id"],
        job_type=row["job_type"],
        status=row["status"],
        total=int(row["total"]),
        done=int(row["done"]),
        failed=int(row["failed"]),
        params=params,
        created_at=row["created_at"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
    )


def get_job(directory: Path, job_id: str) -> JobRecord:
    with _open(directory) as conn:
        _require_tables(conn)
        row = conn.execute("SELECT * FROM job WHERE job_id = ?", (job_id,)).fetchone()
    if row is None:
        raise JobError(f"找不到任务：{job_id}")
    return _row_to_job(row)


def list_jobs(directory: Path, *, limit: int = 20) -> list[JobRecord]:
    """最近的任务，最新的在前。"""
    with _open(directory) as conn:
        _require_tables(conn)
        rows = conn.execute(
            "SELECT * FROM job ORDER BY created_at DESC, job_id DESC LIMIT ?", (limit,)
        ).fetchall()
    return [_row_to_job(row) for row in rows]


def count_by_status(directory: Path) -> dict[str, int]:
    """按状态数任务（质量统计：任务失败率用）。没出现过的状态不返回，调用方按 0 处理。"""
    with _open(directory) as conn:
        _require_tables(conn)
        rows = conn.execute("SELECT status, COUNT(*) AS n FROM job GROUP BY status").fetchall()
    return {row["status"]: int(row["n"]) for row in rows}


def list_job_items(directory: Path, job_id: str) -> list[JobItemRecord]:
    """任务的全部单元，按页码排序。"""
    with _open(directory) as conn:
        _require_tables(conn)
        rows = conn.execute(
            """
            SELECT i.*, p.page_no
            FROM job_item i LEFT JOIN page p ON p.page_id = i.page_id
            WHERE i.job_id = ?
            ORDER BY p.page_no, i.item_id
            """,
            (job_id,),
        ).fetchall()
    return [_row_to_item(row) for row in rows]


def _row_to_item(row) -> JobItemRecord:
    return JobItemRecord(
        item_id=row["item_id"],
        job_id=row["job_id"],
        page_id=row["page_id"],
        page_no=int(row["page_no"]) if row["page_no"] is not None else None,
        status=row["status"],
        run_id=row["run_id"],
        error_message=row["error_message"],
        attempts=int(row["attempts"]),
    )


def pending_items(directory: Path, job_id: str) -> list[JobItemRecord]:
    """这个任务里**还没成功**的单元：排队中 / 识别中 / 失败。

    执行器与"继续 / 重试失败页"都用它决定要做哪些页——说明书 5.3
    要求"用户点击继续后，只处理未成功的 Item"。
    """
    placeholders = ", ".join("?" for _ in UNFINISHED_ITEM_STATUSES)
    with _open(directory) as conn:
        _require_tables(conn)
        rows = conn.execute(
            f"""
            SELECT i.*, p.page_no
            FROM job_item i LEFT JOIN page p ON p.page_id = i.page_id
            WHERE i.job_id = ? AND i.status IN ({placeholders})
            ORDER BY p.page_no, i.item_id
            """,
            (job_id, *UNFINISHED_ITEM_STATUSES),
        ).fetchall()
    return [_row_to_item(row) for row in rows]


def active_jobs(directory: Path) -> list[JobRecord]:
    """本项目所有"还在进行中"的任务，最新的在前。

    正常只有一个（说明书 6.3：默认 1 个 OCR 子进程），但异常退出留下的
    running 记录可能不止一条，因此返回列表而不是单条。
    """
    placeholders = ", ".join("?" for _ in ACTIVE_STATUSES)
    with _open(directory) as conn:
        _require_tables(conn)
        rows = conn.execute(
            f"SELECT * FROM job WHERE status IN ({placeholders})"
            " ORDER BY created_at DESC, job_id DESC",
            ACTIVE_STATUSES,
        ).fetchall()
    return [_row_to_job(row) for row in rows]


def active_job(directory: Path) -> JobRecord | None:
    """本项目正在进行的任务（取最新的一个），没有则 None。

    说明书 6.3 规定"默认 1 个 OCR 子进程"，因此同一时间只允许一个任务在跑：
    两个子进程同时写同一个数据库还会让 R1 / R2 的判断互相打架。
    """
    found = active_jobs(directory)
    return found[0] if found else None


# ---------------------------------------------------------------- 创建与状态

def create_job(
    directory: Path,
    *,
    pages: list[tuple[str, int]],
    params: dict,
    job_type: str = JOB_TYPE_OCR,
) -> JobRecord:
    """建一个任务，每页一个单元。``pages`` 是 ``(page_id, page_no)`` 列表。"""
    if not pages:
        raise JobError("任务里没有任何页面")
    job_id = new_ulid()
    now = _now()
    with _open(directory) as conn:
        _require_tables(conn)
        conn.execute(
            """
            INSERT INTO job (job_id, job_type, status, total, done, failed, params_json, created_at)
            VALUES (?, ?, ?, ?, 0, 0, ?, ?)
            """,
            (
                job_id,
                job_type,
                STATUS_QUEUED,
                len(pages),
                json.dumps(params, ensure_ascii=False),
                now,
            ),
        )
        conn.executemany(
            """
            INSERT INTO job_item (item_id, job_id, page_id, status, attempts)
            VALUES (?, ?, ?, 'queued', 0)
            """,
            [(new_ulid(), job_id, page_id) for page_id, _ in pages],
        )
        conn.commit()
    return get_job(directory, job_id)


def set_status(
    directory: Path,
    job_id: str,
    status: str,
    *,
    expect: tuple[str, ...] | None = None,
) -> JobRecord:
    """切换任务状态。

    ``expect`` 给出允许的来源状态：不匹配就抛错。这样并发的两个操作
    （比如界面上同时点了"取消"和"继续"）不会互相覆盖，
    后到的那个会得到一条明确的拒绝。
    """
    now = _now()
    assignments = ["status = ?"]
    params: list[object] = [status]

    if status == STATUS_RUNNING:
        # 第一次开始跑时记 started_at；暂停后继续不改它
        assignments.append("started_at = COALESCE(started_at, ?)")
        params.append(now)
    elif status in TERMINAL_STATUSES:
        assignments.append("finished_at = ?")
        params.append(now)

    with _open(directory) as conn:
        _require_tables(conn)
        row = conn.execute("SELECT status FROM job WHERE job_id = ?", (job_id,)).fetchone()
        if row is None:
            raise JobError(f"找不到任务：{job_id}")
        if expect is not None and row["status"] not in expect:
            raise JobError(
                f"任务当前是「{row['status']}」，不能这样操作（允许的状态：{'、'.join(expect)}）"
            )
        conn.execute(
            f"UPDATE job SET {', '.join(assignments)} WHERE job_id = ?",
            (*params, job_id),
        )
        conn.commit()
    return get_job(directory, job_id)


def update_progress(directory: Path, job_id: str) -> JobRecord:
    """按单元的实际状态重算 done / failed。执行器每做完一页调一次。

    重算而不是累加：即使某次写入被中断，进度也始终与单元状态一致。
    """
    with _open(directory) as conn:
        _require_tables(conn)
        row = conn.execute(
            """
            SELECT SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS done,
                   SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed
            FROM job_item WHERE job_id = ?
            """,
            (job_id,),
        ).fetchone()
        conn.execute(
            "UPDATE job SET done = ?, failed = ?, total = ("
            " SELECT COUNT(*) FROM job_item WHERE job_id = ?) WHERE job_id = ?",
            (int(row["done"] or 0), int(row["failed"] or 0), job_id, job_id),
        )
        conn.commit()
    return get_job(directory, job_id)


def mark_item_failed(directory: Path, item_id: str, message: str) -> None:
    """把一个单元直接标记为失败（还没有生成运行记录时用）。

    例如单元指向的页面已经不在库里了：这种情况必须**如实记为失败**，
    不能让执行循环悄悄跳过——那会让任务显示"成功"却一页都没做。
    """
    with _open(directory) as conn:
        _require_tables(conn)
        conn.execute(
            "UPDATE job_item SET status = 'failed', error_message = ? WHERE item_id = ?",
            (message, item_id),
        )
        conn.commit()


def reset_failed_items(directory: Path, job_id: str) -> int:
    """把失败的单元退回排队（说明书 6.3 的"失败页可单独重试"），返回条数。"""
    with _open(directory) as conn:
        _require_tables(conn)
        cursor = conn.execute(
            "UPDATE job_item SET status = 'queued', error_message = NULL"
            " WHERE job_id = ? AND status = 'failed'",
            (job_id,),
        )
        conn.commit()
        changed = cursor.rowcount
    update_progress(directory, job_id)
    return changed


# ---------------------------------------------------------------- 修理

def repair_unfinished(
    directory: Path, *, message: str, job_id: str | None = None
) -> dict[str, int]:
    """把还停在 **running** 的单元与运行记录结算为失败（原因写明中断 / 取消）。

    **排队中的单元不动**：它们只是还没轮到，不是失败——状态留着 `queued`，
    "继续"时会接着做，进度条上也仍然算"待做"。写成失败会让人以为这些页出了问题。

    **调用前必须确认执行者已经退出**（子进程已 wait 返回，或本机根本没有它），
    否则会与活着的子进程抢写同一条记录。

    ``job_id`` 给定时只修理这个任务；不给则修理整个项目里所有没结算的记录
    （用于"上次异常退出的残留"，见 `mark_interrupted`）。
    任务本身的状态由调用方用 `set_status` 设置——因为"取消"与"中断"的终态不同。
    """
    now = _now()
    scope = "AND job_id = ?" if job_id else ""
    scope_params: tuple[object, ...] = (job_id,) if job_id else ()

    with _open(directory) as conn:
        _require_tables(conn)
        runs = conn.execute(
            f"""
            UPDATE ocr_run
            SET status = 'failed', error_code = 'interrupted', error_message = ?, finished_at = ?
            WHERE status IN ('queued', 'running')
              AND run_id IN (SELECT run_id FROM job_item WHERE 1 = 1 {scope})
            """,
            (message, now, *scope_params),
        ).rowcount
        items = conn.execute(
            f"""
            UPDATE job_item SET status = 'failed', error_message = ?
            WHERE status = 'running' {scope}
            """,
            (message, *scope_params),
        ).rowcount
        # 版面检测运行（任务 58）也要结算，否则取消 / 中断会在 layout_run 里
        # 留下永远 running 的记录。老库没有这张表时忽略。
        try:
            conn.execute(
                f"""
                UPDATE layout_run
                SET status = 'failed', error_code = 'interrupted',
                    error_message = ?, finished_at = ?
                WHERE status IN ('queued', 'running')
                  AND page_id IN (SELECT page_id FROM job_item WHERE 1 = 1 {scope})
                """,
                (message, now, *scope_params),
            ).rowcount
        except sqlite3.OperationalError as exc:
            if "no such table" not in str(exc):
                raise
        conn.commit()
    if job_id:
        update_progress(directory, job_id)
    return {"runs": runs, "items": items}


def mark_interrupted(
    directory: Path, *, keep_job_ids: frozenset[str] | set[str] = frozenset()
) -> int:
    """把"还在跑"的任务标记为中断，并修理它们的单元与运行记录（说明书 5.3）。

    只对**没有活着的执行者**的任务做这件事：``keep_job_ids`` 由调用方给出——
    服务进程里正在跑的任务不该被自己人打断（见 `executor.Supervisor`）。

    返回被标记的任务数。
    """
    placeholders = ", ".join("?" for _ in ACTIVE_STATUSES)
    keep = tuple(keep_job_ids)
    keep_clause = ""
    keep_params: tuple[object, ...] = ()
    if keep:
        keep_clause = f" AND job_id NOT IN ({', '.join('?' for _ in keep)})"
        keep_params = keep

    now = _now()
    with _open(directory) as conn:
        _require_tables(conn)
        stale = [
            row["job_id"]
            for row in conn.execute(
                f"SELECT job_id FROM job WHERE status IN ({placeholders}){keep_clause}",
                (*ACTIVE_STATUSES, *keep_params),
            ).fetchall()
        ]
        if not stale:
            return 0
        for job_id in stale:
            conn.execute(
                "UPDATE job SET status = ?, finished_at = ? WHERE job_id = ?",
                (STATUS_INTERRUPTED, now, job_id),
            )
        conn.commit()

    for job_id in stale:
        repair_unfinished(directory, message=INTERRUPTED_MESSAGE, job_id=job_id)
    return len(stale)


__all__ = [
    "ACTIVE_STATUSES",
    "INTERRUPTED_MESSAGE",
    "ITEM_STATUS_FAILED",
    "ITEM_STATUS_QUEUED",
    "ITEM_STATUS_RUNNING",
    "ITEM_STATUS_SUCCEEDED",
    "JOB_TYPE_OCR",
    "JobError",
    "JobItemRecord",
    "JobRecord",
    "STATUS_CANCELLED",
    "STATUS_FAILED",
    "STATUS_INTERRUPTED",
    "STATUS_PAUSED",
    "STATUS_QUEUED",
    "STATUS_RUNNING",
    "STATUS_SUCCEEDED",
    "TERMINAL_STATUSES",
    "UNFINISHED_ITEM_STATUSES",
    "active_job",
    "active_jobs",
    "create_job",
    "get_job",
    "list_job_items",
    "list_jobs",
    "mark_item_failed",
    "mark_interrupted",
    "pending_items",
    "repair_unfinished",
    "reset_failed_items",
    "set_status",
    "update_progress",
]
