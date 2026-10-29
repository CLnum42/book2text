"""项目数据库的备份列表与恢复（任务 65）。

用户：重跑第二引擎这类大动作之后，出问题必须能自己退回去。现在只留备份文件，
等于没有——这里给"列备份 / 恢复备份"两个动作。

规则（按说明书 1.4 的优先级，先保证不丢数据）：

- 恢复**必须没有写入方**：项目还开着（有锁）或还有任务在跑，一律拒绝，先关项目；
- 恢复前把**当前库**再备份一份（`project-before-restore-<时间>.db`），恢复错了还有退路；
- 只允许恢复 `backups/` 目录里的 `project-*.db`，不接受任意路径；
- 恢复用 SQLite 在线备份 API（WAL 下直接拷文件会不一致）。
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query, Request

from ..core.project import jobs as jobs_module
from ..core.project import library as project_library
from ..core.project import lock as lock_module
from ..core.storage import db as db_module
from .deps import library_dir as _library
from .errors import AppError

router = APIRouter(prefix="/api", tags=["backups"])

BACKUP_GLOB = "project-*.db"


def _backup_note(name: str) -> str:
    if "before-restore" in name:
        return "恢复前的安全备份"
    if "before-word-boxes" in name:
        return "字框回填前"
    if "before-aux-rerun" in name:
        return "重跑第二引擎前"
    if "before-recognize" in name:
        return "重识别前的自动备份"
    return "打开 / 批量操作前的自动备份"


def _describe(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "name": path.name,
        "size": stat.st_size,
        "created_at": datetime.fromtimestamp(stat.st_mtime, tz=timezone.utc).isoformat(
            timespec="seconds"
        ),
        "note": _backup_note(path.name),
    }


@router.get("/projects/{project_id}/backups")
def list_backups(request: Request, project_id: str) -> dict[str, Any]:
    """这个项目的备份（新的在前）。"""
    library = _library(request)
    directory = project_library.require_project_dir(project_id, library=library)
    backups = sorted(
        (directory / db_module.BACKUP_DIR_NAME).glob(BACKUP_GLOB),
        key=lambda item: item.stat().st_mtime,
        reverse=True,
    )
    return {"backups": [_describe(path) for path in backups], "count": len(backups)}


@router.post("/projects/{project_id}/backups/{name}/restore")
def restore_backup(
    request: Request,
    project_id: str,
    name: str,
    confirm: bool = Query(default=False),
) -> dict[str, Any]:
    """用某份备份覆盖当前库（先确认，再给当前库做一份安全备份）。"""
    if not confirm:
        raise AppError(400, "confirmation_required", "恢复备份需要二次确认")
    library = _library(request)
    directory = project_library.require_project_dir(project_id, library=library)

    backups_dir = (directory / db_module.BACKUP_DIR_NAME).resolve()
    target = (backups_dir / name).resolve()
    # 只允许 backups/ 下、文件名像备份的文件；防目录穿越
    if target.parent != backups_dir or not target.name.startswith("project-") or not target.is_file():
        raise AppError(400, "bad_backup", "找不到这份备份")

    lock_status = lock_module.status(directory)
    if lock_status.held:
        raise AppError(
            409,
            "project_busy",
            "恢复备份前要先关闭项目",
            detail=lock_status.describe(),
        )
    try:
        active = jobs_module.active_jobs(directory)
    except Exception:  # noqa: BLE001 - 老库没有 job 表
        active = []
    if active:
        raise AppError(
            409,
            "project_busy",
            "还有任务在跑，先等它结束或取消",
            detail=f"{len(active)} 个任务",
        )

    # 恢复前：把当前库也备份一份（恢复错了还有退路）
    safety = db_module.backup_database(directory)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    safety_named = safety.with_name(f"project-before-restore-{stamp}.db")
    try:
        safety.replace(safety_named)
    except OSError:
        safety_named = safety

    # 用在线备份 API 把备份写回当前库（不直接拷文件）
    import sqlite3

    source = sqlite3.connect(target)
    try:
        destination = sqlite3.connect(db_module.database_path(directory))
        try:
            source.backup(destination)
            destination.commit()
        finally:
            destination.close()
    finally:
        source.close()

    return {
        "restored": True,
        "from": target.name,
        "safety_backup": safety_named.name,
    }
