"""审校任务包（说明书 6.7）：分派、快照、生成 `.b2tpkg`、作废、状态。

**这一侧是负责人。** 助手那一侧（打开任务包、导出结果包）在 `packages.py`，
导入与合并（校验、逐页分类、合并审阅）在 `merge.py`。

**一次分派 = 一条 Assignment + 一份基准快照。** 快照是"分派那一刻每一页每一块长什么样"，
它有两个不可替代的作用：

1. **合并时判断"谁动了什么"**：助手的结果包与快照比 → 助手改了什么；
   主项目当前状态与快照比 → 负责人自己改了什么（后者就是**冲突**的判据，说明书 6.7.5）；
2. **助手的结果包只需要带"最终状态"**，不需要带全部原文——差额从快照还原。

快照与任务包都写在项目的 `assignments/<assignment_id>/` 下：

    snapshot.json         基准快照（说明书 6.7.2 的 data.json 就是它的对应物）
    <包文件名>.b2tpkg      生成的任务包（重新导出时覆盖同一个文件）
    results/<seq>.b2tres  每次导入的结果包**原样留档**（被拒绝的变化也要能回看）

**同一页同时只能在一个未完成的任务包里**（说明书 6.7.1）：建分派与预览时都检查，
避免两位助手改同一页。合并完成后页面解除占用（部分合并的页面也能重新分派）。
"""

from __future__ import annotations

import json
import shutil
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ... import __version__
from ..pdf import render
from ..storage import db as db_module
from ..storage.ulid import new_ulid
from ..project import blocks as blocks_module
from ..project.library import (
    SOURCE_DIR_NAME,
    SOURCE_FILE_NAME,
    Page,
    ProjectError,
    default_library_dir,
    list_pages,
    load_project,
    project_dir,
)
from .. import settings as settings_module
from .packages import (
    PACKAGE_DATA_SCHEMA,
    PACKAGE_EXTENSION,
    PACKAGE_SCHEMA,
)

ASSIGNMENTS_DIR_NAME = "assignments"
SNAPSHOT_FILE_NAME = "snapshot.json"
SNAPSHOT_SCHEMA = "book2text.assignment-snapshot.v1"
PACKAGE_DATA_SCHEMA = "book2text.package-data.v1"

STATUS_ISSUED = "issued"
STATUS_RETURNED = "returned"
STATUS_PARTIALLY_MERGED = "partially_merged"
STATUS_MERGED = "merged"
STATUS_CANCELLED = "cancelled"

# 页面被占用的状态（说明书 6.7.1：一个页面同一时间只能在一个未完成的任务包里）
BLOCKING_STATUSES = (STATUS_ISSUED, STATUS_RETURNED)

STATUS_LABELS = {
    STATUS_ISSUED: "已发出",
    STATUS_RETURNED: "已回传",
    STATUS_PARTIALLY_MERGED: "部分合并",
    STATUS_MERGED: "已合并",
    STATUS_CANCELLED: "已作废",
}

# 助手可以做的块级操作（说明书 6.7.3）；页面级与识别 / 导出类都不给
ALLOWED_OPERATIONS = (
    "edit_text",
    "confirm",
    "uncertain",
    "exclude_include_block",
    "block_type",
    "merge",
    "split",
    "move",
    "create",
    "delete",
    "continues_to_next",
    "comment",
    "undo",
    "redo",
)
FORBIDDEN_OPERATIONS = (
    "ocr",
    "reocr",
    "page_type",
    "page_include",
    "structure_tools",
    "export_text",
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _parse_page_ids(text: str | None) -> tuple[str, ...]:
    if not text:
        return ()
    try:
        values = json.loads(text)
    except json.JSONDecodeError:
        return ()
    return tuple(str(item) for item in values) if isinstance(values, list) else ()


@dataclass(frozen=True)
class Assignment:
    assignment_id: str
    project_id: str
    reviewer_name: str
    note: str
    due_date: str | None
    page_ids: tuple[str, ...]
    context_page_ids: tuple[str, ...]
    status: str
    package_name: str
    created_at: str
    updated_at: str
    cancelled_at: str | None
    imported_seq: int
    merged_seq: int
    merged_pages: int

    @property
    def is_active(self) -> bool:
        return self.status in BLOCKING_STATUSES

    def to_dict(self) -> dict[str, object]:
        return {
            "assignment_id": self.assignment_id,
            "project_id": self.project_id,
            "reviewer_name": self.reviewer_name,
            "note": self.note,
            "due_date": self.due_date,
            "page_ids": list(self.page_ids),
            "context_page_ids": list(self.context_page_ids),
            "page_count": len(self.page_ids),
            "status": self.status,
            "status_label": STATUS_LABELS.get(self.status, self.status),
            "package_name": self.package_name,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "cancelled_at": self.cancelled_at,
            "imported_seq": self.imported_seq,
            "merged_seq": self.merged_seq,
            "merged_pages": self.merged_pages,
        }


def _row_to_assignment(row) -> Assignment:
    return Assignment(
        assignment_id=row["assignment_id"],
        project_id=row["project_id"],
        reviewer_name=row["reviewer_name"],
        note=row["note"] or "",
        due_date=row["due_date"],
        page_ids=_parse_page_ids(row["page_ids"]),
        context_page_ids=_parse_page_ids(row["context_page_ids"]),
        status=row["status"],
        package_name=row["package_name"] or "",
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        cancelled_at=row["cancelled_at"],
        imported_seq=int(row["imported_seq"] or 0),
        merged_seq=int(row["merged_seq"] or 0),
        merged_pages=int(row["merged_pages"] or 0),
    )


# ---------------------------------------------------------------- 路径

def assignments_dir(directory: Path) -> Path:
    return directory / ASSIGNMENTS_DIR_NAME


def assignment_dir(directory: Path, assignment_id: str) -> Path:
    return assignments_dir(directory) / assignment_id


def snapshot_path(directory: Path, assignment_id: str) -> Path:
    return assignment_dir(directory, assignment_id) / SNAPSHOT_FILE_NAME


# ---------------------------------------------------------------- 读

def list_assignments(project_id: str, *, library: Path | None = None) -> list[Assignment]:
    directory = project_dir(library or default_library_dir(), project_id)
    with db_module.open_database(directory, apply_migrations=False) as conn:
        rows = conn.execute(
            "SELECT * FROM assignment WHERE project_id = ? ORDER BY created_at DESC, assignment_id DESC",
            (project_id,),
        ).fetchall()
    return [_row_to_assignment(row) for row in rows]


def get_assignment(
    project_id: str, assignment_id: str, *, library: Path | None = None
) -> Assignment:
    directory = project_dir(library or default_library_dir(), project_id)
    with db_module.open_database(directory, apply_migrations=False) as conn:
        row = conn.execute(
            "SELECT * FROM assignment WHERE assignment_id = ?", (assignment_id,)
        ).fetchone()
    if row is None:
        raise ProjectError(f"找不到任务包：{assignment_id}")
    return _row_to_assignment(row)


def page_assignment_map(
    project_id: str, *, library: Path | None = None
) -> dict[str, Assignment]:
    """页 id → 占用它的任务包（只算**未完成**的：已发出 / 已回传）。"""
    result: dict[str, Assignment] = {}
    for assignment in list_assignments(project_id, library=library):
        if not assignment.is_active:
            continue
        for page_id in assignment.page_ids:
            result[page_id] = assignment
    return result


def load_snapshot(directory: Path, assignment_id: str) -> dict:
    path = snapshot_path(directory, assignment_id)
    if not path.is_file():
        raise ProjectError(f"任务包的基准快照不见了：{path.name}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProjectError(f"任务包的基准快照读不出来：{exc}") from exc


# ---------------------------------------------------------------- 快照

def snapshot_pages(
    *,
    project_id: str,
    library: Path,
    book_name: str,
    source_sha256: str,
    reviewer_name: str,
    owner_name: str,
    pages: list[Page],
    context_pages: list[Page],
    note: str,
    due_date: str | None,
    assignment_id: str,
) -> dict:
    """把页面与块整理成快照结构（页序：上下文页在前，分派页按页码升序）。"""
    context_ids = {page.page_id for page in context_pages}
    blocks_by_page: dict[str, list] = {}
    for page in [*context_pages, *pages]:
        blocks_by_page[page.page_id] = blocks_module.list_blocks(
            project_id, library=library, page_no=page.page_no
        )

    def entry(page: Page, *, is_context: bool) -> dict:
        rows = sorted(blocks_by_page.get(page.page_id, []), key=lambda item: item.order_index)
        return {
            "page_id": page.page_id,
            "page_no": page.page_no,
            "page_label": page.page_label,
            "page_type": page.page_type,
            "rotation": page.rotation,
            "width_pt": round(page.width_pt, 2),
            "height_pt": round(page.height_pt, 2),
            "is_context": is_context,
            "blocks": [
                {
                    "block_id": block.block_id,
                    "order_index": block.order_index,
                    "text": block.text,
                    "ocr_text": block.ocr_text,
                    "review_status": block.review_status,
                    "block_type": block.block_type,
                    "include": block.include,
                    "continues_to_next": block.continues_to_next,
                    "comment": block.comment,
                    "revision": block.revision,
                }
                for block in rows
            ],
        }

    return {
        "schema": SNAPSHOT_SCHEMA,
        "assignment_id": assignment_id,
        "project_id": project_id,
        "book_name": book_name,
        "source_sha256": source_sha256,
        "owner_name": owner_name,
        "reviewer_name": reviewer_name,
        "note": note,
        "due_date": due_date,
        "app_version": __version__,
        "created_at": _now(),
        # 页序与**书的阅读顺序一致**（上下文页夹在前后，不单独挪到开头）：
        # 子集 PDF 是照着这个顺序抽的，顺序错乱会让助手翻页看不懂
        "pages": [
            entry(page, is_context=page.page_id in context_ids)
            for page in sorted([*pages, *context_pages], key=lambda item: item.page_no)
        ],
    }


# ---------------------------------------------------------------- 预览

def preview_assignment(
    project_id: str,
    *,
    pages: list[int],
    reviewer_name: str = "",
    with_context: bool = True,
    library: Path | None = None,
) -> dict:
    """分派前的检查（说明书 7.9.1 的对话框）：哪些页能派、哪些要提醒、大概多大。

    - 未识别 / 识别失败 / 已经排除的页 → **默认排除**并说明原因；
    - 已在别的任务包里的页 → **默认排除**并说明是谁的任务包；
    - 估算文件大小：按"每页图像约占多少"算，仅作数量级提示。
    """
    target_library = library or default_library_dir()
    all_pages = {page.page_no: page for page in list_pages(project_id, library=target_library)}
    states = blocks_module.page_recognition_states(project_id, library=target_library)
    occupied = page_assignment_map(project_id, library=target_library)

    selected: list[Page] = []
    skipped: list[dict[str, str]] = []
    for page_no in sorted(set(pages)):
        page = all_pages.get(page_no)
        if page is None:
            skipped.append({"page_no": str(page_no), "reason": "没有这一页"})
            continue
        state = states.get(page.page_id)
        status = state.status if state else blocks_module.STATUS_UNRECOGNIZED
        if not page.include:
            skipped.append({"page_no": str(page_no), "reason": "已排除，不参与审校"})
            continue
        if status in (blocks_module.STATUS_UNRECOGNIZED,):
            skipped.append({"page_no": str(page_no), "reason": "还没识别"})
            continue
        if status == blocks_module.STATUS_FAILED:
            skipped.append({"page_no": str(page_no), "reason": "上次识别失败"})
            continue
        if page.page_id in occupied:
            assignment = occupied[page.page_id]
            skipped.append(
                {
                    "page_no": str(page_no),
                    "reason": f"已分派给 {assignment.reviewer_name}（{STATUS_LABELS[assignment.status]}）",
                }
            )
            continue
        selected.append(page)

    selected.sort(key=lambda item: item.page_no)
    context: list[Page] = []
    if with_context and selected:
        wanted = {selected[0].page_no - 1, selected[-1].page_no + 1}
        for page_no in sorted(wanted):
            page = all_pages.get(page_no)
            if page is not None:
                context.append(page)

    return {
        "reviewer_name": reviewer_name,
        "selected_page_ids": [page.page_id for page in selected],
        "selected_pages": [page.page_no for page in selected],
        "context_pages": [page.page_no for page in context],
        "skipped": skipped,
        "page_count": len(selected),
        "estimated_bytes": _estimate_size(selected, context),
        "note": (
            "未识别的页不能分派——助手端没有识别功能（说明书 6.7.3）。"
            if any("识别" in item["reason"] for item in skipped)
            else ""
        ),
    }


def _estimate_size(pages: list[Page], context: list[Page]) -> int:
    """粗估任务包大小：页面图像按"面积 × 单色位深"折算，只是一个数量级提示。"""
    total_points = sum(page.width_pt * page.height_pt for page in [*pages, *context])
    # 300 DPI 灰度经验值：约 0.35 字节/平方点
    return int(total_points * 0.35)


# ---------------------------------------------------------------- 建分派

def create_assignment(
    project_id: str,
    *,
    pages: list[int],
    reviewer_name: str,
    note: str = "",
    due_date: str | None = None,
    with_context: bool = True,
    library: Path | None = None,
) -> tuple[Assignment, Path]:
    """建分派、写快照、生成任务包。返回 (记录, 任务包路径)。"""
    reviewer_name = (reviewer_name or "").strip()
    if not reviewer_name:
        raise ProjectError("请填写审校人（分派给谁）")

    target_library = library or default_library_dir()
    project = load_project(project_id, library=target_library)
    directory = project_dir(target_library, project_id)

    preview = preview_assignment(
        project_id,
        pages=pages,
        reviewer_name=reviewer_name,
        with_context=with_context,
        library=target_library,
    )
    if not preview["selected_page_ids"]:
        raise ProjectError("没有可以分派的页面（未识别、已排除或已在其他任务包里）")

    all_pages = {page.page_no: page for page in list_pages(project_id, library=target_library)}
    selected = [all_pages[no] for no in preview["selected_pages"]]
    context = [all_pages[no] for no in preview["context_pages"]]

    assignment_id = new_ulid()
    owner_name = settings_module.load_settings(target_library).user_name
    snapshot = snapshot_pages(
        project_id=project_id,
        library=target_library,
        book_name=project.name,
        source_sha256=project.source_sha256,
        reviewer_name=reviewer_name,
        owner_name=owner_name,
        pages=selected,
        context_pages=context,
        note=note,
        due_date=due_date,
        assignment_id=assignment_id,
    )

    target_dir = assignment_dir(directory, assignment_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    snapshot_path(directory, assignment_id).write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    package_name = _package_file_name(project.name, selected, reviewer_name)
    package_path = target_dir / package_name
    build_package(directory, snapshot=snapshot, destination=package_path)

    now = _now()
    with db_module.open_database(directory) as conn:
        conn.execute(
            """
            INSERT INTO assignment (
                assignment_id, project_id, reviewer_name, note, due_date,
                page_ids, context_page_ids, status, package_name,
                created_at, updated_at, cancelled_at, imported_seq, merged_seq, merged_pages
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 0)
            """,
            (
                assignment_id,
                project_id,
                reviewer_name,
                note,
                due_date,
                json.dumps([page.page_id for page in selected]),
                json.dumps([page.page_id for page in context]),
                STATUS_ISSUED,
                package_name,
                now,
                now,
            ),
        )
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()

    return get_assignment(project_id, assignment_id, library=target_library), package_path


def _package_file_name(book_name: str, pages: list[Page], reviewer_name: str) -> str:
    """说明书 6.7.2 的文件名示例：``书名缩写_p87-136_张三_20250301.b2tpkg``。"""
    stem = "".join(ch for ch in book_name.strip() if ch not in '/\\:*?"<>|')[:12] or "book"
    if pages:
        span = f"p{pages[0].page_no}-{pages[-1].page_no}"
    else:  # pragma: no cover - create_assignment 保证非空
        span = "p0"
    safe_name = "".join(ch for ch in reviewer_name if ch not in '/\\:*?"<>|')[:12] or "reviewer"
    stamp = datetime.now().strftime("%Y%m%d")
    return f"{stem}_{span}_{safe_name}_{stamp}{PACKAGE_EXTENSION}"


def build_package(directory: Path, *, snapshot: dict, destination: Path) -> Path:
    """按快照生成 `.b2tpkg`（说明书 6.7.2）：package.json + source/subset.pdf + data.json。"""
    source = directory / SOURCE_DIR_NAME / SOURCE_FILE_NAME
    if not source.is_file():
        raise ProjectError(f"项目的原始 PDF 不见了：{source.name}")

    pages = snapshot["pages"]
    # 子集里的页序 = 快照里的页序（上下文页在前），因此索引逐一对得上
    indexes = [page["page_no"] - 1 for page in pages]
    subset_tmp = destination.with_suffix(".subset.pdf")
    try:
        render.extract_subset(source, indexes, subset_tmp)

        package_json = {
            "schema": PACKAGE_SCHEMA,
            "package_id": snapshot["assignment_id"],
            "project_id": snapshot["project_id"],
            "book_name": snapshot["book_name"],
            "source_sha256": snapshot["source_sha256"],
            "owner_name": snapshot["owner_name"],
            "reviewer_name": snapshot["reviewer_name"],
            "note": snapshot["note"],
            "due_date": snapshot["due_date"],
            "created_at": snapshot["created_at"],
            "app_version": snapshot["app_version"],
            "page_count": sum(1 for page in pages if not page["is_context"]),
            "context_page_count": sum(1 for page in pages if page["is_context"]),
            "pages": [
                {
                    "page_id": page["page_id"],
                    "page_no": page["page_no"],
                    "page_label": page["page_label"],
                    "page_type": page["page_type"],
                    "is_context": page["is_context"],
                    "pdf_index": index,
                }
                for index, page in enumerate(pages)
            ],
            "allowed_operations": list(ALLOWED_OPERATIONS),
            "forbidden_operations": list(FORBIDDEN_OPERATIONS),
        }
        data_json = {
            "schema": PACKAGE_DATA_SCHEMA,
            "package_id": snapshot["assignment_id"],
            "pages": pages,
        }

        destination.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(
                "package.json", json.dumps(package_json, ensure_ascii=False, indent=2) + "\n"
            )
            archive.writestr(
                "data.json", json.dumps(data_json, ensure_ascii=False, indent=2) + "\n"
            )
            archive.write(subset_tmp, "source/subset.pdf")
    finally:
        subset_tmp.unlink(missing_ok=True)
    return destination


def rebuild_package(
    project_id: str, assignment_id: str, *, library: Path | None = None
) -> Path:
    """重新导出任务包（说明书 7.9.1 的「重新导出任务包」）：用**原来那份快照**重打一次。"""
    target_library = library or default_library_dir()
    directory = project_dir(target_library, project_id)
    assignment = get_assignment(project_id, assignment_id, library=target_library)
    if assignment.status == STATUS_CANCELLED:
        raise ProjectError("这个任务包已作废，不能重新导出")
    snapshot = load_snapshot(directory, assignment_id)
    destination = assignment_dir(directory, assignment_id) / assignment.package_name
    return build_package(directory, snapshot=snapshot, destination=destination)


def cancel_assignment(
    project_id: str, assignment_id: str, *, library: Path | None = None
) -> Assignment:
    """作废任务包（说明书 6.7.6）：页面恢复为未分派；之后收到的结果需明确确认才能导入。"""
    target_library = library or default_library_dir()
    directory = project_dir(target_library, project_id)
    assignment = get_assignment(project_id, assignment_id, library=target_library)
    if assignment.status == STATUS_CANCELLED:
        raise ProjectError("这个任务包已经作废了")
    now = _now()
    with db_module.open_database(directory) as conn:
        conn.execute(
            "UPDATE assignment SET status = ?, cancelled_at = ?, updated_at = ? WHERE assignment_id = ?",
            (STATUS_CANCELLED, now, now, assignment_id),
        )
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()
    return get_assignment(project_id, assignment_id, library=target_library)


def delete_assignment_files(directory: Path, assignment_id: str) -> None:
    """删掉任务包目录（测试与清理用）。"""
    shutil.rmtree(assignment_dir(directory, assignment_id), ignore_errors=True)
