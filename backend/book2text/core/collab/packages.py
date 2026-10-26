"""审校包（助手侧，说明书 6.7.3 / 6.7.4）：打开任务包、导出结果包。

**打开 `.b2tpkg` → 建一个 `kind='package'` 的项目。** 它和普通项目的区别：

- 页面来自**子集 PDF**（所以每页记着 `pdf_page_index`）；
- 页 id **沿用负责人的页 id**——结果包回传时靠它对应回主项目；
- 分派范围外的页是**只读上下文**（`is_context`），不能编辑；
- 功能按说明书 6.7.3 收窄：不能识别、不能改页面类型 / 纳入、没有页眉页脚工具、不能导出 TXT；
  能编辑文本、确认、不确定、改类型、合并拆分移动增删、加备注、撤销重做。

**导出结果包 `.b2tres`**（几十 KB，适合聊天工具发送）：`result.json`（每页的最终块状态 +
基准 revision）、`events.json`（助手的编辑事件，用于追溯）、`summary.json`
（已完成 / 未完成页数、不确定块数、备注数）。允许**部分完成**就导出——
助手可以每天发一次进度，负责人每次只处理尚未合并的变化。
"""

from __future__ import annotations

import io
import json
import shutil
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ... import __version__
from ..storage import db as db_module
from ..storage.ulid import new_ulid
from ..project import blocks as blocks_module
from ..project import library as library_module
from ..project.library import (
    SOURCE_DIR_NAME,
    SOURCE_FILE_NAME,
    Project,
    ProjectError,
    create_blank_project,
    default_library_dir,
    project_dir,
)

PACKAGE_INFO_DIR_NAME = "package"
PACKAGE_INFO_FILE_NAME = "package.json"
PACKAGE_STATE_FILE_NAME = "state.json"
RESULTS_DIR_NAME = "results"
# 子集 PDF 在项目里就叫 `original.pdf`（项目的源文件名）：渲染 / 处理的代码路径
# 都是按这个名字找文件的，换名字会到处都要特判。它是**这个项目**的源文件，
# 原书全名与 SHA-256 记在 package.json 与 project 行里。
SUBSET_FILE_NAME = SOURCE_FILE_NAME

PACKAGE_EXTENSION = ".b2tpkg"
"""任务包的扩展名（说明书 6.7.2）。读写两侧共用这一处定义。"""

PACKAGE_SCHEMA = "book2text.package.v1"
PACKAGE_DATA_SCHEMA = "book2text.package-data.v1"
RESULT_SCHEMA = "book2text.result.v1"
RESULT_EXTENSION = ".b2tres"

def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@dataclass(frozen=True)
class PackageInfo:
    """任务包的元信息（打开之后随项目一起保存，界面据此显示"审校任务"）。"""

    package_id: str
    project_id: str
    book_name: str
    source_sha256: str
    owner_name: str
    reviewer_name: str
    note: str
    due_date: str | None
    created_at: str
    page_count: int
    page_nos: tuple[int, ...]
    context_page_nos: tuple[int, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "package_id": self.package_id,
            "project_id": self.project_id,
            "book_name": self.book_name,
            "source_sha256": self.source_sha256,
            "owner_name": self.owner_name,
            "reviewer_name": self.reviewer_name,
            "note": self.note,
            "due_date": self.due_date,
            "created_at": self.created_at,
            "page_count": self.page_count,
            "page_nos": list(self.page_nos),
            "context_page_nos": list(self.context_page_nos),
        }


def _package_info_from_manifest(manifest: dict) -> PackageInfo:
    pages = manifest.get("pages") or []
    return PackageInfo(
        package_id=str(manifest.get("package_id") or ""),
        project_id=str(manifest.get("project_id") or ""),
        book_name=str(manifest.get("book_name") or ""),
        source_sha256=str(manifest.get("source_sha256") or ""),
        owner_name=str(manifest.get("owner_name") or ""),
        reviewer_name=str(manifest.get("reviewer_name") or ""),
        note=str(manifest.get("note") or ""),
        due_date=manifest.get("due_date"),
        created_at=str(manifest.get("created_at") or ""),
        page_count=int(manifest.get("page_count") or 0),
        page_nos=tuple(
            int(page["page_no"]) for page in pages if not page.get("is_context")
        ),
        context_page_nos=tuple(
            int(page["page_no"]) for page in pages if page.get("is_context")
        ),
    )


# ---------------------------------------------------------------- 打开任务包

def read_package(path: Path) -> tuple[dict, dict]:
    """读一个 `.b2tpkg`，返回 `(package.json, data.json)`。格式不对就如实报错。"""
    if not path.is_file():
        raise ProjectError(f"找不到任务包：{path}")
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            missing = {"package.json", "data.json", "source/subset.pdf"} - names
            if missing:
                raise ProjectError(f"任务包缺少文件：{'、'.join(sorted(missing))}")
            manifest = json.loads(archive.read("package.json"))
            data = json.loads(archive.read("data.json"))
    except zipfile.BadZipFile as exc:
        raise ProjectError("这不是一个任务包（zip 读不开）") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise ProjectError(f"任务包读不出来：{exc}") from exc

    if manifest.get("schema") != PACKAGE_SCHEMA:
        raise ProjectError(f"任务包格式不认识的版本：{manifest.get('schema')}")
    if data.get("schema") != PACKAGE_DATA_SCHEMA:
        raise ProjectError(f"任务包数据格式不认识的版本：{data.get('schema')}")
    return manifest, data


def open_package(path: Path, *, library: Path | None = None) -> Project:
    """把任务包打开成一个审校包项目（说明书 6.7.3）。

    页面与块的 **id 全部沿用**负责人那份——结果包回传时靠它对应回去。
    """
    target_library = library or default_library_dir()
    manifest, data = read_package(path)
    info = _package_info_from_manifest(manifest)

    name = f"{info.book_name} · 审校任务（第 {_span_text(info)}）"
    # 页面与块由下面手工落库（id 沿用负责人的），所以这里只建骨架
    project, directory = create_blank_project(
        name=name,
        source_file_name=SUBSET_FILE_NAME,
        source_sha256=info.source_sha256,
        page_count=len(manifest.get("pages") or []),
        library=target_library,
        kind="package",
    )
    project_id = project.project_id

    # 1) 子集 PDF 落进 source/（助手端渲染的就是它）
    (directory / SOURCE_DIR_NAME).mkdir(parents=True, exist_ok=True)
    subset_path = directory / SOURCE_DIR_NAME / SUBSET_FILE_NAME
    with zipfile.ZipFile(path) as archive:
        subset_path.write_bytes(archive.read("source/subset.pdf"))

    # 2) 任务包元信息留一份（界面显示"审校任务：第 87–136 页 · 来自 李四"）
    info_dir = directory / PACKAGE_INFO_DIR_NAME
    info_dir.mkdir(parents=True, exist_ok=True)
    (info_dir / PACKAGE_INFO_FILE_NAME).write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (info_dir / PACKAGE_STATE_FILE_NAME).write_text(
        json.dumps({"exported_seq": 0}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    # 3) 页面与块落库（id 沿用，页码沿用，PDF 下标单独记）
    from ..pdf import render

    text_layer = render.text_layer_char_counts(subset_path)
    pages = data.get("pages") or []
    now = _now()
    with db_module.open_database(directory) as conn:
        for index, page in enumerate(pages):
            has_text = index < len(text_layer) and text_layer[index] > 0
            # 老任务包里可能还是 cover / appendix / blank 等旧值：按同一张映射表
            # 收成五类（body → body，封面 / 前言类 → front，目录 → toc，
            # 附录 / 索引 / 空白 / 其他 → back），未知值直接报错，不写进库。
            try:
                page_type = library_module.normalize_page_type(
                    str(page.get("page_type") or "body")
                )
            except ProjectError as exc:
                raise ProjectError(
                    f"任务包第 {page.get('page_no')} 页的页面类型不认识：{exc}"
                ) from exc
            conn.execute(
                """
                INSERT INTO page (
                    page_id, page_no, page_label, width_pt, height_pt, rotation,
                    page_type, include, has_text_layer, is_context, pdf_page_index, note,
                    margin_box_mode
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'auto')
                """,
                (
                    page["page_id"],
                    int(page["page_no"]),
                    page.get("page_label") or "",
                    float(page.get("width_pt") or 0),
                    float(page.get("height_pt") or 0),
                    int(page.get("rotation") or 0),
                    page_type,
                    1 if library_module.page_type_includes(page_type) else 0,
                    1 if has_text else 0,
                    1 if page.get("is_context") else 0,
                    int(page.get("pdf_index", index)),
                ),
            )
            for block in page.get("blocks") or []:
                conn.execute(
                    """
                    INSERT INTO block (
                        block_id, page_id, origin_run_id, origin, order_index, bbox,
                        block_type, ocr_text, text, review_status, include,
                        continues_to_next, confidence, revision, reviewed_by, comment,
                        created_at, updated_at, deleted_at
                    ) VALUES (?, ?, NULL, 'ocr', ?, NULL, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, NULL)
                    """,
                    (
                        block["block_id"],
                        page["page_id"],
                        int(block.get("order_index") or 0),
                        block.get("block_type") or "paragraph",
                        block.get("ocr_text") or "",
                        block.get("text") or "",
                        block.get("review_status") or "unreviewed",
                        1 if block.get("include", True) else 0,
                        1 if block.get("continues_to_next") else 0,
                        int(block.get("revision") or 0),
                        block.get("comment"),
                        now,
                        now,
                    ),
                )
        conn.commit()

    return library_module.load_project(project_id, library=target_library)


def _span_text(info: PackageInfo) -> str:
    if not info.page_nos:
        return "—"
    return f"{info.page_nos[0]}–{info.page_nos[-1]}"


def package_info(project_id: str, *, library: Path | None = None) -> PackageInfo | None:
    """读项目里的任务包元信息；不是审校包项目就返回 None。"""
    directory = project_dir(library or default_library_dir(), project_id)
    path = directory / PACKAGE_INFO_DIR_NAME / PACKAGE_INFO_FILE_NAME
    if not path.is_file():
        return None
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):  # pragma: no cover - 文件坏了
        return None
    return _package_info_from_manifest(manifest)


def is_package_project(project_id: str, *, library: Path | None = None) -> bool:
    return package_info(project_id, library=library) is not None


# ---------------------------------------------------------------- 导出结果包

def _state_path(directory: Path) -> Path:
    return directory / PACKAGE_INFO_DIR_NAME / PACKAGE_STATE_FILE_NAME


def _next_seq(directory: Path) -> int:
    path = _state_path(directory)
    seq = 0
    if path.is_file():
        try:
            seq = int(json.loads(path.read_text(encoding="utf-8")).get("exported_seq") or 0)
        except (OSError, json.JSONDecodeError):  # pragma: no cover
            seq = 0
    return seq + 1


def _bump_seq(directory: Path, seq: int) -> None:
    _state_path(directory).write_text(
        json.dumps({"exported_seq": seq}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def build_result(directory: Path, *, project_id: str) -> dict:
    """拼出结果包的内容（不写文件）：`result.json` / `events.json` / `summary.json`。"""
    info = package_info(project_id, library=directory.parent)
    if info is None:
        raise ProjectError("这个项目不是审校包项目（没有任务包信息）")

    seq = _next_seq(directory)
    leaf = Path(directory).name
    pages_payload: list[dict] = []
    confirmed = uncertain = modified = commented = unreviewed = 0

    with db_module.open_database(directory, apply_migrations=False) as conn:
        # 基准 revision 从任务包里带进来的初始值即可：负责人那边的合并用**他那份快照**判断，
        # 这里记下"助手手上这一块的起始 revision"，供负责人核对
        for page in _package_pages(conn):
            blocks = blocks_module.list_blocks(project_id, library=directory.parent, page_no=page["page_no"])
            if page["is_context"]:
                continue
            entries = []
            structural = False
            for block in blocks:
                entries.append(
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
                        "origin": block.origin,
                    }
                )
                if block.origin in ("manual", "merge", "split"):
                    structural = True
                if block.review_status == "confirmed":
                    confirmed += 1
                elif block.review_status == "uncertain":
                    uncertain += 1
                elif block.review_status == "unreviewed":
                    unreviewed += 1
                if block.text != block.ocr_text:
                    modified += 1
                if block.comment:
                    commented += 1
            pages_payload.append(
                {
                    "page_id": page["page_id"],
                    "page_no": page["page_no"],
                    "structural_change": structural,
                    "blocks": entries,
                }
            )

        events = [
            {
                "event_id": row["event_id"],
                "entity_type": row["entity_type"],
                "entity_id": row["entity_id"],
                "action": row["action"],
                "before_json": row["before_json"],
                "after_json": row["after_json"],
                "batch_id": row["batch_id"],
                "created_at": row["created_at"],
            }
            for row in conn.execute(
                "SELECT * FROM event WHERE actor = 'user' ORDER BY created_at, event_id"
            ).fetchall()
        ]

    unfinished_pages = [
        page["page_no"]
        for page in pages_payload
        if any(block["review_status"] == "unreviewed" for block in page["blocks"])
    ]
    result = {
        "schema": RESULT_SCHEMA,
        "package_id": info.package_id,
        "project_id": info.project_id,
        "source_sha256": info.source_sha256,
        "book_name": info.book_name,
        "owner_name": info.owner_name,
        "reviewer_name": info.reviewer_name,
        "app_version": __version__,
        "exported_at": _now(),
        "seq": seq,
        "pages": pages_payload,
    }
    summary = {
        "page_count": len(pages_payload),
        "confirmed": confirmed,
        "uncertain": uncertain,
        "modified": modified,
        "commented": commented,
        "unreviewed": unreviewed,
        "unfinished_pages": unfinished_pages,
        "structural_pages": [
            page["page_no"] for page in pages_payload if page["structural_change"]
        ],
    }
    return {
        "result": result,
        "events": {
            "schema": "book2text.result-events.v1",
            "package_id": info.package_id,
            "seq": seq,
            "events": events,
        },
        "summary": summary,
        "package": info,
        "project_dir_name": leaf,
    }


def export_result(
    project_id: str, *, library: Path | None = None, file_name: str | None = None
) -> tuple[Path, dict]:
    """导出结果包：写成 `<项目>/results/<n>.b2tres` 并返回 (路径, 摘要)。"""
    target_library = library or default_library_dir()
    directory = project_dir(target_library, project_id)
    payload = build_result(directory, project_id=project_id)
    info: PackageInfo = payload["package"]
    seq = payload["result"]["seq"]

    results_dir = directory / PACKAGE_INFO_DIR_NAME / RESULTS_DIR_NAME
    results_dir.mkdir(parents=True, exist_ok=True)
    if file_name is None:
        stamp = datetime.now().strftime("%Y%m%d")
        stem = "".join(
            ch for ch in f"{info.book_name}_{_span_text(info)}_{info.reviewer_name}_结果{seq}"
            if ch not in '/\\:*?"<>|'
        )[:60]
        file_name = f"{stem}_{stamp}{RESULT_EXTENSION}"
    path = results_dir / file_name

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "result.json", json.dumps(payload["result"], ensure_ascii=False, indent=2) + "\n"
        )
        archive.writestr(
            "events.json", json.dumps(payload["events"], ensure_ascii=False, indent=2) + "\n"
        )
        archive.writestr(
            "summary.json", json.dumps(payload["summary"], ensure_ascii=False, indent=2) + "\n"
        )
    path.write_bytes(buffer.getvalue())
    _bump_seq(directory, seq)
    return path, payload["summary"]


def list_results(project_id: str, *, library: Path | None = None) -> list[dict]:
    """这个审校包里已经导出过的结果包（按序号）。"""
    directory = project_dir(library or default_library_dir(), project_id)
    results_dir = directory / PACKAGE_INFO_DIR_NAME / RESULTS_DIR_NAME
    if not results_dir.is_dir():
        return []
    entries = []
    for path in sorted(results_dir.glob(f"*{RESULT_EXTENSION}")):
        stat = path.stat()
        entries.append(
            {
                "name": path.name,
                "size": stat.st_size,
                "modified_at": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(
                    timespec="seconds"
                ),
            }
        )
    return entries


def result_path(project_id: str, name: str, *, library: Path | None = None) -> Path:
    directory = project_dir(library or default_library_dir(), project_id)
    results_dir = directory / PACKAGE_INFO_DIR_NAME / RESULTS_DIR_NAME
    path = (results_dir / name).resolve()
    if results_dir.resolve() not in path.parents or not path.is_file():
        raise ProjectError(f"找不到结果包：{name}")
    return path


def _package_pages(conn) -> list[dict]:
    rows = conn.execute(
        "SELECT page_id, page_no, is_context FROM page ORDER BY page_no"
    ).fetchall()
    return [
        {"page_id": row["page_id"], "page_no": int(row["page_no"]), "is_context": bool(row["is_context"])}
        for row in rows
    ]


def remove_project(project_id: str, *, library: Path | None = None) -> None:
    """删掉一个审校包项目（测试与清理用；界面不提供删除）。"""
    directory = project_dir(library or default_library_dir(), project_id)
    shutil.rmtree(directory, ignore_errors=True)
