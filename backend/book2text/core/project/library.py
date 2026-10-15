"""项目库：创建、列举、打开、关闭项目（说明书 6.1 / 7.2 / 12.1）。

项目文件夹结构（说明书 12.1）::

    <项目库目录>/b2t_7KQ2M9/
      project.db
      .lock
      source/original.pdf
      ocr_runs/  cache/{thumbs,view,ocr,lines}/  exports/  backups/  logs/

**项目 ID 就是文件夹名**（``b2t_`` + 6 个 Crockford Base32 字符）。说明书 12.1 把它画在
目录结构里，说明书第 10 节要求"项目文件夹名简短，避免触发 Windows 260 字符限制"，
因此不像其他实体那样用 26 字符的 ULID（那条规则见 `ulid.py`，用于 page / block 等行）。

**原始 PDF 只读**（说明书 5.1）：导入是复制到 `source/original.pdf`，用户的原始文件不动。
"""

from __future__ import annotations

import json
import secrets
import shutil
from collections.abc import AsyncIterator, Collection, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .. import platform as b2t_platform
from ..pdf import render
from ..storage import db as db_module
from ..storage.streaming import StreamError, stream_to_file
from ..storage.ulid import new_ulid
from . import jobs as jobs_module
from . import lock as lock_module

PROJECT_PREFIX = "b2t_"
# Crockford Base32 去掉易混字符，与 ulid.py 保持一致
PROJECT_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
PROJECT_ID_LENGTH = 6
PROJECT_ID_ATTEMPTS = 20

LIBRARY_DIR_NAME = "Book2Text"
SOURCE_DIR_NAME = "source"
SOURCE_FILE_NAME = "original.pdf"
OCR_RUNS_DIR_NAME = "ocr_runs"
CACHE_DIR_NAMES = ("thumbs", "view", "ocr", "lines")
EXPORTS_DIR_NAME = "exports"
LOGS_DIR_NAME = "logs"

PAGE_TYPES = ("cover", "toc", "front", "body", "appendix", "index", "blank", "other")
DEFAULT_PAGE_TYPE = "body"

# 说明书 6.1：大部分页面已有文本层时提示"这本 PDF 可能已包含文本"
TEXT_LAYER_HINT_RATIO = 0.5
TEXT_LAYER_CHAR_THRESHOLD = 20


class ProjectError(Exception):
    """项目库层面的错误（找不到项目、ID 不合法等）。"""


@dataclass(frozen=True)
class Project:
    project_id: str
    name: str
    source_file_name: str
    source_sha256: str
    page_count: int
    created_at: str
    updated_at: str
    schema_version: int
    kind: str = "main"
    """主项目（main）还是审校包项目（package，说明书 6.7.3）。"""
    last_view: str | None = None
    last_page_id: str | None = None
    directory: Path | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "project_id": self.project_id,
            "name": self.name,
            "source_file_name": self.source_file_name,
            "source_sha256": self.source_sha256,
            "page_count": self.page_count,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "schema_version": self.schema_version,
            "kind": self.kind,
            "last_view": self.last_view,
            "last_page_id": self.last_page_id,
            "directory": str(self.directory) if self.directory else "",
        }


@dataclass(frozen=True)
class Page:
    page_id: str
    page_no: int
    page_label: str
    width_pt: float
    height_pt: float
    rotation: int
    page_type: str
    include: bool
    has_text_layer: bool
    is_context: bool = False
    """任务包里的只读上下文页（说明书 6.7.2）；主项目里恒为 False。"""
    pdf_page_index: int | None = None
    """这一页在**本项目 PDF** 里的下标（0 起）。主项目里是 None，等于 page_no - 1；
    任务包项目的 PDF 是子集，必须单独记——否则会渲染出别的页。"""
    note: str | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "page_id": self.page_id,
            "page_no": self.page_no,
            "page_label": self.page_label,
            "width_pt": round(self.width_pt, 2),
            "height_pt": round(self.height_pt, 2),
            "rotation": self.rotation,
            "page_type": self.page_type,
            "include": self.include,
            "has_text_layer": self.has_text_layer,
            "is_context": self.is_context,
            "pdf_page_index": self.pdf_page_index,
            "note": self.note,
        }


@dataclass(frozen=True)
class LibraryPageSummary:
    """项目库里一条项目卡片所需的信息。"""

    project: Project
    included_pages: int
    recognized_pages: int
    reviewed_pages: int
    uncertain_blocks: int
    failed_pages: int
    last_page_no: int | None
    """上次停留的页码（说明书 7.2 的"继续"要用它显示"上次位置：第 N 页"）。"""
    last_page_label: str
    """那一页的印张页码（可能是空的）。"""
    pages_with_text_layer: int
    text_layer_hint: bool
    lock_held: bool
    lock_reason: str

    def to_dict(self) -> dict[str, object]:
        return {
            **self.project.to_dict(),
            "included_pages": self.included_pages,
            "recognized_pages": self.recognized_pages,
            "reviewed_pages": self.reviewed_pages,
            "uncertain_blocks": self.uncertain_blocks,
            "failed_pages": self.failed_pages,
            "last_page_no": self.last_page_no,
            "last_page_label": self.last_page_label,
            "pages_with_text_layer": self.pages_with_text_layer,
            "text_layer_hint": self.text_layer_hint,
            "lock_held": self.lock_held,
            "lock_reason": self.lock_reason,
        }


# ---------------------------------------------------------------- 项目库目录

def default_library_dir() -> Path:
    """默认项目库目录：用户"文稿 / 文档"目录下的 Book2Text（说明书 12.1）。"""
    return b2t_platform.documents_dir() / LIBRARY_DIR_NAME


def ensure_library(library: Path) -> Path:
    library.mkdir(parents=True, exist_ok=True)
    return library


def is_valid_project_id(project_id: str) -> bool:
    if not project_id.startswith(PROJECT_PREFIX):
        return False
    suffix = project_id[len(PROJECT_PREFIX) :]
    return len(suffix) == PROJECT_ID_LENGTH and all(
        char in PROJECT_ID_ALPHABET for char in suffix
    )


def project_dir(library: Path, project_id: str) -> Path:
    """项目文件夹路径。**校验 ID 后再拼接**，避免路径穿越。"""
    if not is_valid_project_id(project_id):
        raise ProjectError(f"项目 ID 格式不正确：{project_id!r}")
    return library / project_id


def _new_project_id(library: Path) -> str:
    for _ in range(PROJECT_ID_ATTEMPTS):
        suffix = "".join(secrets.choice(PROJECT_ID_ALPHABET) for _ in range(PROJECT_ID_LENGTH))
        candidate = f"{PROJECT_PREFIX}{suffix}"
        if not (library / candidate).exists():
            return candidate
    raise ProjectError(f"连续 {PROJECT_ID_ATTEMPTS} 次都生成了已存在的项目 ID")


def create_project_dirs(directory: Path) -> None:
    """按说明书 12.1 建好项目文件夹骨架。"""
    (directory / SOURCE_DIR_NAME).mkdir(parents=True, exist_ok=True)
    (directory / OCR_RUNS_DIR_NAME).mkdir(parents=True, exist_ok=True)
    for name in CACHE_DIR_NAMES:
        (directory / "cache" / name).mkdir(parents=True, exist_ok=True)
    (directory / EXPORTS_DIR_NAME).mkdir(parents=True, exist_ok=True)
    (directory / db_module.BACKUP_DIR_NAME).mkdir(parents=True, exist_ok=True)
    (directory / LOGS_DIR_NAME).mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------- 创建项目

@dataclass(frozen=True)
class CreateResult:
    project: Project
    text_layer_hint: bool
    pages_with_text_layer: int


def create_blank_project(
    *,
    name: str,
    source_file_name: str,
    source_sha256: str,
    page_count: int,
    library: Path | None = None,
    kind: str = "main",
) -> tuple[Project, Path]:
    """建一个**空**项目的骨架：目录 + `project` 一行。页面与块由调用方写入。

    与 `create_project`（上传 PDF 建项目）的区别在于"页从哪来"：
    审校包项目的页来自任务包里的快照（页 id 都要沿用负责人的），
    所以这里只给骨架，内容由 `core/collab/packages.py` 落库。
    """
    target_library = ensure_library(library or default_library_dir())
    project_id = _new_project_id(target_library)
    directory = target_library / project_id
    create_project_dirs(directory)

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with db_module.open_database(directory) as conn:
        conn.execute(
            """
            INSERT INTO project (
                project_id, name, source_file_name, source_sha256, page_count,
                created_at, updated_at, schema_version, settings_json, kind
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_id,
                name.strip() or project_id,
                source_file_name,
                source_sha256,
                page_count,
                now,
                now,
                db_module.LATEST_VERSION,
                json.dumps({}, ensure_ascii=False),
                kind,
            ),
        )
        conn.commit()
    return load_project(project_id, library=target_library), directory


async def create_project(
    *,
    name: str,
    original_name: str,
    chunks: AsyncIterator[bytes],
    library: Path | None = None,
) -> CreateResult:
    """从上传的 PDF 新建项目（说明书 6.1）。

    流程：建目录 → 流式写入 `source/original.pdf`（边写边算 SHA-256）→
    读元数据 → 检测文本层 → 建库并写入 project 与 page 两表。
    """
    target_library = ensure_library(library or default_library_dir())
    project_id = _new_project_id(target_library)
    directory = target_library / project_id
    create_project_dirs(directory)

    source_path = directory / SOURCE_DIR_NAME / SOURCE_FILE_NAME
    try:
        streamed = await stream_to_file(chunks, source_path, failure_cleanup=directory)
    except StreamError as exc:
        # 上传内容不合格（空、非 PDF）：转成项目层错误，由 API 层回 400。
        # stream_to_file 已经清掉了失败时建的项目目录。
        raise ProjectError(str(exc)) from exc

    try:
        info = render.info(streamed.path)
        labels = render.page_labels(streamed.path)
        char_counts = render.text_layer_char_counts(streamed.path)
        sizes = render.page_sizes_pt(streamed.path)
        rotations = render.page_rotations(streamed.path)
    except render.PdfError as exc:
        shutil.rmtree(directory, ignore_errors=True)
        raise ProjectError(f"无法读取 PDF：{exc}") from exc

    pages_with_text = sum(
        1 for count in char_counts if count >= TEXT_LAYER_CHAR_THRESHOLD
    )
    hint = info.page_count > 0 and (
        pages_with_text / info.page_count >= TEXT_LAYER_HINT_RATIO
    )

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    display_name = name.strip() or Path(original_name).stem or project_id

    with db_module.open_database(directory) as conn:
        conn.execute(
            """
            INSERT INTO project (
                project_id, name, source_file_name, source_sha256, page_count,
                created_at, updated_at, schema_version, settings_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_id,
                display_name,
                original_name,
                streamed.sha256,
                info.page_count,
                now,
                now,
                db_module.LATEST_VERSION,
                json.dumps({}, ensure_ascii=False),
            ),
        )
        conn.executemany(
            """
            INSERT INTO page (
                page_id, page_no, page_label, width_pt, height_pt, rotation,
                page_type, include, has_text_layer
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
            """,
            [
                (
                    new_ulid(),
                    index + 1,
                    labels[index] if index < len(labels) else "",
                    width,
                    height,
                    rotations[index] if index < len(rotations) else 0,
                    DEFAULT_PAGE_TYPE,
                    1 if char_counts[index] >= TEXT_LAYER_CHAR_THRESHOLD else 0,
                )
                for index, (width, height) in enumerate(sizes)
            ],
        )
        conn.commit()

    project = load_project(project_id, library=target_library)
    return CreateResult(
        project=project, text_layer_hint=hint, pages_with_text_layer=pages_with_text
    )


# ---------------------------------------------------------------- 读取

def _column(row, name: str):
    """读一列；这一列不存在时返回 None。

    迁移是**开库时**做的（`db.open_database`），但读取路径上有几处刻意
    `apply_migrations=False`（见 blocks.py 的说明）——那几处拿到的是老结构，
    这里对"迁移之后才有的列"统一按缺省值处理。
    """
    try:
        return row[name]
    except (IndexError, KeyError):
        return None


def _row_to_project(row, directory: Path) -> Project:
    return Project(
        project_id=row["project_id"],
        name=row["name"],
        source_file_name=row["source_file_name"],
        source_sha256=row["source_sha256"],
        page_count=int(row["page_count"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        schema_version=int(row["schema_version"]),
        kind=_column(row, "kind") or "main",
        last_view=row["last_view"],
        last_page_id=row["last_page_id"],
        directory=directory,
    )


def require_project_dir(project_id: str, *, library: Path | None = None) -> Path:
    """解析项目目录并确认它存在。

    所有开库的函数都要先过这一关：`sqlite3.connect` 对不存在的路径会抛
    `OperationalError`，那是 500 而不是"找不到项目"（404）。
    """
    target_library = library or default_library_dir()
    directory = project_dir(target_library, project_id)
    if not db_module.database_path(directory).is_file():
        raise ProjectError(f"找不到项目：{project_id}")
    return directory


def project_exists(project_id: str, *, library: Path | None = None) -> bool:
    """项目是否存在于项目库中（不看数据库内容，只看文件夹与 project.db）。"""
    if not is_valid_project_id(project_id):
        return False
    target_library = library or default_library_dir()
    return db_module.database_path(target_library / project_id).is_file()


def load_project(project_id: str, *, library: Path | None = None) -> Project:
    target_library = library or default_library_dir()
    directory = project_dir(target_library, project_id)
    if not directory.is_dir():
        raise ProjectError(f"找不到项目：{project_id}")
    with db_module.open_database(directory) as conn:
        row = conn.execute("SELECT * FROM project LIMIT 1").fetchone()
    if row is None:
        raise ProjectError(f"项目数据库里没有 project 记录：{project_id}")
    return _row_to_project(row, directory)


def list_pages(project_id: str, *, library: Path | None = None) -> list[Page]:
    directory = require_project_dir(project_id, library=library)
    with db_module.open_database(directory, apply_migrations=False) as conn:
        rows = conn.execute("SELECT * FROM page ORDER BY page_no").fetchall()
    return [
        Page(
            page_id=row["page_id"],
            page_no=int(row["page_no"]),
            page_label=row["page_label"] or "",
            width_pt=float(row["width_pt"]),
            height_pt=float(row["height_pt"]),
            rotation=int(row["rotation"]),
            page_type=row["page_type"],
            include=bool(row["include"]),
            has_text_layer=bool(row["has_text_layer"]),
            is_context=bool(_column(row, "is_context") or 0),
            pdf_page_index=(
                int(row["pdf_page_index"]) if _column(row, "pdf_page_index") is not None else None
            ),
            note=row["note"],
        )
        for row in rows
    ]


@dataclass(frozen=True)
class _PageCounts:
    """项目卡需要的几个计数（一次查询取回，避免为每项开一次库）。"""

    total: int
    included: int
    with_text_layer: int
    recognized: int
    reviewed: int
    """已审完的纳入页数（说明书 5.3 的 `done`：纳入块已全部确认）。

    与 `blocks.PageReview.status` 同一口径，只是这里用 SQL 现算总数——
    项目库列一屏几十个项目卡，不能为每项把整页的块读进内存。
    """
    uncertain_blocks: int
    failed: int
    """试过识别但没成功、现在也没有可用结果的页数（与 `blocks.STATUS_FAILED` 同口径）。"""
    last_page_no: int | None
    last_page_label: str


def _page_counts(directory: Path) -> _PageCounts:
    with db_module.open_database(directory, apply_migrations=False) as conn:
        row = conn.execute(
            """
            SELECT COUNT(*)                                        AS total,
                   SUM(CASE WHEN p.include         THEN 1 ELSE 0 END) AS included,
                   SUM(CASE WHEN p.has_text_layer  THEN 1 ELSE 0 END) AS with_text,
                   SUM(CASE WHEN p.active_run_id IS NOT NULL THEN 1 ELSE 0 END) AS recognized,
                   SUM(CASE
                         WHEN NOT p.include THEN 0
                         WHEN EXISTS (
                             SELECT 1 FROM block b
                             WHERE b.page_id = p.page_id AND b.deleted_at IS NULL
                               AND b.include AND b.review_status <> 'confirmed'
                         ) THEN 0
                         WHEN EXISTS (
                             SELECT 1 FROM block b
                             WHERE b.page_id = p.page_id AND b.deleted_at IS NULL AND b.include
                         ) THEN 1
                         ELSE 0
                       END)                                     AS reviewed,
                   (SELECT COUNT(*) FROM block b
                    WHERE b.deleted_at IS NULL AND b.include
                      AND b.review_status = 'uncertain')        AS uncertain_blocks,
                   SUM(CASE
                         WHEN p.include AND p.active_run_id IS NULL
                              AND EXISTS (SELECT 1 FROM ocr_run r WHERE r.page_id = p.page_id)
                         THEN 1 ELSE 0
                       END)                                     AS failed
            FROM page p
            """
        ).fetchone()
        last = conn.execute(
            """
            SELECT p.page_no, p.page_label FROM page p
            WHERE p.page_id = (SELECT last_page_id FROM project LIMIT 1)
            """
        ).fetchone()
    return _PageCounts(
        total=int(row["total"] or 0),
        included=int(row["included"] or 0),
        with_text_layer=int(row["with_text"] or 0),
        # "已识别"= 有 active run 的页。完整的识别状态推导在 blocks.py
        # （未识别 / 排队中 / 识别中 / 已识别 / 失败 / 有待选新结果），
        # 项目卡只需要这个总数。
        recognized=int(row["recognized"] or 0),
        reviewed=int(row["reviewed"] or 0),
        uncertain_blocks=int(row["uncertain_blocks"] or 0),
        # "失败"= 试过但没成功、现在也没有 active run 的页（与 blocks.py 的
        # STATUS_FAILED 同一口径：有运行记录、但没有可用的结果）
        failed=int(row["failed"] or 0),
        last_page_no=int(last["page_no"]) if last else None,
        last_page_label=str(last["page_label"] or "") if last else "",
    )


def list_projects(*, library: Path | None = None) -> list[LibraryPageSummary]:
    """扫描项目库目录，返回所有项目（说明书 7.2 的项目库列表）。

    以**目录**为准而不是某个索引文件：项目文件夹自包含、可拷贝（说明书 4.2），
    因此"库里有项目"就等于"目录里有一个 project.db"。
    """
    target_library = library or default_library_dir()
    if not target_library.is_dir():
        return []

    summaries: list[LibraryPageSummary] = []
    for entry in sorted(target_library.iterdir()):
        if not entry.is_dir() or not is_valid_project_id(entry.name):
            continue
        if not db_module.database_path(entry).is_file():
            continue
        try:
            project = load_project(entry.name, library=target_library)
            counts = _page_counts(entry)
        except ProjectError:
            # 目录残缺（例如从网盘同步到一半）：跳过而不是让整个库列不出来
            continue

        lock_status = lock_module.status(entry)
        # "使用中"只对**别人**显示：本进程自己开着的项目在项目卡上不该看起来被占用
        held_by_other = lock_status.held and not lock_status.mine
        summaries.append(
            LibraryPageSummary(
                project=project,
                included_pages=counts.included,
                recognized_pages=counts.recognized,
                reviewed_pages=counts.reviewed,
                uncertain_blocks=counts.uncertain_blocks,
                failed_pages=counts.failed,
                last_page_no=counts.last_page_no,
                last_page_label=counts.last_page_label,
                pages_with_text_layer=counts.with_text_layer,
                text_layer_hint=(
                    counts.total > 0
                    and counts.with_text_layer / counts.total >= TEXT_LAYER_HINT_RATIO
                ),
                lock_held=held_by_other,
                lock_reason=lock_status.describe() if held_by_other else "",
            )
        )
    return summaries


# ---------------------------------------------------------------- 打开与关闭

@dataclass(frozen=True)
class OpenResult:
    """打开项目的结果。"""

    project: Project
    backup_path: Path | None
    lock: lock_module.LockInfo | None
    read_only: bool = False
    warning: str = ""
    interrupted: int = 0          # 这次打开清理掉的"中断任务"数（说明书 5.3）

    def to_dict(self) -> dict[str, object]:
        return {
            "project": self.project.to_dict(),
            "backup_path": str(self.backup_path) if self.backup_path else "",
            "read_only": self.read_only,
            "warning": self.warning,
            "interrupted": self.interrupted,
            "lock": self.lock.to_dict() if self.lock else None,
        }


def open_project(
    project_id: str,
    *,
    library: Path | None = None,
    force: bool = False,
    read_only: bool = False,
    keep_job_ids: Collection[str] = (),
) -> OpenResult:
    """打开项目：检查锁 → 自动备份 → 上锁 → 清理中断的任务（说明书 6.1 / 7.6 / 5.3）。

    - 锁被别的机器或另一个窗口占用时，默认**拒绝**并说明原因。
      调用方可以让用户选择"只读打开"或"强制打开"（``force=True``）。
    - 只读打开不上锁、不备份、不改动任何数据——包括不做中断清理。
    - 每次打开都会备份 `project.db`，用 SQLite 在线备份 API。
    - 中断清理会把"还在跑"的任务标为中断。**本进程正在跑的任务不受影响**——
      调用方从执行器拿到它们的 id 传进来（``keep_job_ids``）。
    """
    target_library = library or default_library_dir()
    directory = project_dir(target_library, project_id)
    if not directory.is_dir():
        raise ProjectError(f"找不到项目：{project_id}")

    lock_status = lock_module.status(directory)

    if read_only:
        project = load_project(project_id, library=target_library)
        return OpenResult(
            project=project,
            backup_path=None,
            lock=None,
            read_only=True,
            warning="只读打开：不会写入任何数据，也不会加锁" + (
                f"；{lock_status.describe()}" if lock_status.held else ""
            ),
        )

    # 自己（同一个服务进程）已经开着的项目不拦：应用只有一个进程，
    # 另一个标签页再打开它看到的还是同一个"我开着它"。
    if lock_status.held and not lock_status.mine and not force:
        raise ProjectError(
            f"{lock_status.describe()}。可以选择只读打开，或强制打开"
            "（强制打开有让两台电脑同时写入同一数据库的风险）"
        )

    warning = ""
    if lock_status.held and force:
        warning = f"已强制打开，但{lock_status.describe()}"
    elif lock_status.stale:
        warning = "覆盖了上次异常退出留下的锁"

    backup_path = db_module.backup_database(directory)
    lock_info = lock_module.acquire(directory)
    interrupted = jobs_module.mark_interrupted(
        directory, keep_job_ids=frozenset(keep_job_ids)
    )
    project = load_project(project_id, library=target_library)

    if interrupted and not warning:
        warning = f"上次有 {interrupted} 个识别任务被中断（应用被关闭），已标记为中断"

    return OpenResult(
        project=project,
        backup_path=backup_path,
        lock=lock_info,
        read_only=False,
        warning=warning,
        interrupted=interrupted,
    )


def close_project(project_id: str, *, library: Path | None = None) -> bool:
    """关闭项目：删掉锁文件。返回是否真的删掉了。"""
    target_library = library or default_library_dir()
    return lock_module.release(project_dir(target_library, project_id))


def update_page(
    project_id: str,
    page_id: str,
    *,
    library: Path | None = None,
    page_type: str | None = None,
    include: bool | None = None,
    note: str | None = None,
) -> Page:
    """更新单页的类型 / 纳入 / 备注（说明书 6.2 的批量操作的单项形式）。"""
    directory = require_project_dir(project_id, library=library)

    assignments = []
    params: list[object] = []
    if page_type is not None:
        if page_type not in PAGE_TYPES:
            raise ProjectError(f"未知的页面类型：{page_type!r}")
        assignments.append("page_type = ?")
        params.append(page_type)
    if include is not None:
        assignments.append("include = ?")
        params.append(1 if include else 0)
    if note is not None:
        assignments.append("note = ?")
        params.append(note)

    if not assignments:
        raise ProjectError("没有要更新的字段")

    params.append(page_id)
    with db_module.open_database(directory, apply_migrations=False) as conn:
        cursor = conn.execute(
            f"UPDATE page SET {', '.join(assignments)} WHERE page_id = ?", params
        )
        if cursor.rowcount == 0:
            raise ProjectError(f"找不到页面：{page_id}")
        conn.execute(
            "UPDATE project SET updated_at = ?",
            (datetime.now(timezone.utc).isoformat(timespec="seconds"),),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM page WHERE page_id = ?", (page_id,)).fetchone()

    return Page(
        page_id=row["page_id"],
        page_no=int(row["page_no"]),
        page_label=row["page_label"] or "",
        width_pt=float(row["width_pt"]),
        height_pt=float(row["height_pt"]),
        rotation=int(row["rotation"]),
        page_type=row["page_type"],
        include=bool(row["include"]),
        has_text_layer=bool(row["has_text_layer"]),
        note=row["note"],
    )


def update_pages(
    project_id: str,
    page_ids: Sequence[str],
    *,
    library: Path | None = None,
    page_type: str | None = None,
    include: bool | None = None,
) -> list[Page]:
    """批量更新页面的类型 / 纳入（说明书 6.2 的批量操作、第 11 节的 PATCH /pages）。

    **整批一个事务**：要么都改，要么都不改——批次里有一个页面 id 不存在就整批拒绝，
    免得界面上出现"改了一半"的中间状态。
    """
    if not page_ids:
        raise ProjectError("没有指定要更新的页面")
    if page_type is None and include is None:
        raise ProjectError("没有要更新的字段")
    if page_type is not None and page_type not in PAGE_TYPES:
        raise ProjectError(f"未知的页面类型：{page_type!r}")

    assignments = []
    params: list[object] = []
    if page_type is not None:
        assignments.append("page_type = ?")
        params.append(page_type)
    if include is not None:
        assignments.append("include = ?")
        params.append(1 if include else 0)

    directory = require_project_dir(project_id, library=library)
    condition = ", ".join("?" for _ in page_ids)

    with db_module.open_database(directory, apply_migrations=False) as conn:
        found = {
            row["page_id"]
            for row in conn.execute(
                f"SELECT page_id FROM page WHERE page_id IN ({condition})", page_ids
            ).fetchall()
        }
        missing = [page_id for page_id in page_ids if page_id not in found]
        if missing:
            raise ProjectError(f"找不到这些页面：{'、'.join(missing[:5])}")

        conn.execute(
            f"UPDATE page SET {', '.join(assignments)} WHERE page_id IN ({condition})",
            (*params, *page_ids),
        )
        conn.execute(
            "UPDATE project SET updated_at = ?",
            (datetime.now(timezone.utc).isoformat(timespec="seconds"),),
        )
        conn.commit()
        rows = conn.execute(
            f"SELECT * FROM page WHERE page_id IN ({condition}) ORDER BY page_no", page_ids
        ).fetchall()

    return [
        Page(
            page_id=row["page_id"],
            page_no=int(row["page_no"]),
            page_label=row["page_label"] or "",
            width_pt=float(row["width_pt"]),
            height_pt=float(row["height_pt"]),
            rotation=int(row["rotation"]),
            page_type=row["page_type"],
            include=bool(row["include"]),
            has_text_layer=bool(row["has_text_layer"]),
            note=row["note"],
        )
        for row in rows
    ]


def update_last_view(
    project_id: str,
    *,
    library: Path | None = None,
    view: str | None = None,
    page_id: str | None = None,
) -> None:
    """记录上次位置（说明书 7.2：项目库里显示"上次位置"，"继续"回到那里）。"""
    directory = require_project_dir(project_id, library=library)

    assignments = []
    params: list[object] = []
    if view is not None:
        assignments.append("last_view = ?")
        params.append(view)
    if page_id is not None:
        assignments.append("last_page_id = ?")
        params.append(page_id)
    if not assignments:
        return

    # project 表仅一行（说明书 5.3），因此不需要 WHERE
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(f"UPDATE project SET {', '.join(assignments)}", params)
        conn.commit()


def touch_project(project_id: str, *, library: Path | None = None) -> None:
    """更新项目的 updated_at——项目库里用来显示"上次：N 小时前"。"""
    directory = require_project_dir(project_id, library=library)
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE project SET updated_at = ?",
            (datetime.now(timezone.utc).isoformat(timespec="seconds"),),
        )
        conn.commit()
