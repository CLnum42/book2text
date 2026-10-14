"""数据库连接与备份（说明书 5.1 / 7.6）。

**每个项目一个 `project.db`，开启 WAL**（说明书 4.2）。本模块只管连接、
迁移应用与备份，不含任何业务查询——业务在 `core/project/` 里。
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from .migration import migrate
from .migrations import MIGRATIONS, LATEST_VERSION

DB_FILE_NAME = "project.db"
BACKUP_DIR_NAME = "backups"
BACKUP_KEEP = 10          # 说明书 7.6：保留最近 10 份
BACKUP_PREFIX = "project-"


def database_path(project_dir: Path) -> Path:
    return project_dir / DB_FILE_NAME


def connect(db_path: Path) -> sqlite3.Connection:
    """打开连接。行以字典风格访问（``row["col"]``），并开启 WAL 与外键。"""
    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    return connection


@contextmanager
def open_database(project_dir: Path, *, apply_migrations: bool = True) -> Iterator[sqlite3.Connection]:
    """打开项目的数据库，必要时应用迁移。"""
    connection = connect(database_path(project_dir))
    try:
        if apply_migrations:
            migrate(connection, MIGRATIONS)
        yield connection
    finally:
        connection.close()


def backup_database(project_dir: Path, *, keep: int = BACKUP_KEEP) -> Path:
    """把 `project.db` 备份到 `backups/`，保留最近 `keep` 份，返回备份文件路径。

    **用 SQLite 的在线备份 API，不复制文件。** 说明书 7.6 明确要求：
    WAL 模式下直接复制数据库文件会得到不一致的副本（已提交的数据可能还在 -wal 里）。

    备份文件名带时间戳，形如 ``project-20250301-140000.db``。
    """
    source_path = database_path(project_dir)
    if not source_path.is_file():
        raise FileNotFoundError(f"找不到数据库：{source_path}")

    backups_dir = project_dir / BACKUP_DIR_NAME
    backups_dir.mkdir(parents=True, exist_ok=True)

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    target = backups_dir / f"{BACKUP_PREFIX}{stamp}.db"
    # 同一秒内重复备份时避免覆盖
    suffix = 1
    while target.exists():
        target = backups_dir / f"{BACKUP_PREFIX}{stamp}-{suffix}.db"
        suffix += 1

    source = connect(source_path)
    try:
        destination = sqlite3.connect(target)
        try:
            source.backup(destination)
            destination.commit()
        finally:
            destination.close()
    finally:
        source.close()

    _prune_backups(backups_dir, keep=keep)
    return target


def list_backups(project_dir: Path) -> list[Path]:
    backups_dir = project_dir / BACKUP_DIR_NAME
    if not backups_dir.is_dir():
        return []
    return sorted(backups_dir.glob(f"{BACKUP_PREFIX}*.db"))


def _prune_backups(backups_dir: Path, *, keep: int) -> list[Path]:
    """删掉多余的旧备份，返回被删掉的路径。"""
    backups = sorted(backups_dir.glob(f"{BACKUP_PREFIX}*.db"))
    if len(backups) <= keep:
        return []
    removed = backups[: len(backups) - keep]
    for path in removed:
        path.unlink(missing_ok=True)
    return removed


def schema_version_of(project_dir: Path) -> int:
    """读取项目数据库的结构版本；库不存在时返回 0。"""
    path = database_path(project_dir)
    if not path.is_file():
        return 0
    connection = connect(path)
    try:
        from .migration import current_version

        return current_version(connection)
    finally:
        connection.close()


__all__ = [
    "BACKUP_KEEP",
    "LATEST_VERSION",
    "backup_database",
    "connect",
    "database_path",
    "list_backups",
    "open_database",
    "schema_version_of",
]
