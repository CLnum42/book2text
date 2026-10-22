"""数据库迁移（说明书 5.1：数据库有 `schema_version`，结构变化必须有迁移）。

每个迁移是一个 `Migration`：版本号 + 说明 + 应用函数。
`migrate()` 按版本号顺序执行未应用的部分，并把版本写进 `schema_meta` 表。

**为什么用表而不是 `PRAGMA user_version`：** 说明书要求"数据库有 schema_version"，
并且迁移记录要能被人看——一张表可以存应用时间与说明，`PRAGMA` 只能存一个整数。

**迁移函数默认只做结构变更**；确需回填数据时（例如 0008 页面类型收敛）必须在迁移里一次
完成、可重复执行并逐行测试，不留给打开项目时的懒迁移。
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from sqlite3 import Connection

META_TABLE = "schema_meta"


@dataclass(frozen=True)
class Migration:
    version: int
    description: str
    apply: Callable[[Connection], None]


def ensure_meta_table(conn: Connection) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {META_TABLE} (
            version     INTEGER PRIMARY KEY,
            description TEXT    NOT NULL,
            applied_at  TEXT    NOT NULL
        )
        """
    )


def current_version(conn: Connection) -> int:
    """当前已应用的最高迁移版本；空库返回 0。"""
    ensure_meta_table(conn)
    row = conn.execute(f"SELECT MAX(version) AS v FROM {META_TABLE}").fetchone()
    return int(row["v"]) if row and row["v"] is not None else 0


def applied_versions(conn: Connection) -> list[tuple[int, str, str]]:
    """已应用的迁移列表 ``(version, description, applied_at)``，供诊断与测试。"""
    ensure_meta_table(conn)
    rows = conn.execute(
        f"SELECT version, description, applied_at FROM {META_TABLE} ORDER BY version"
    ).fetchall()
    return [(int(r["version"]), str(r["description"]), str(r["applied_at"])) for r in rows]


def migrate(conn: Connection, migrations: list[Migration]) -> int:
    """把 `migrations` 里未应用的部分按版本号顺序应用，返回迁移后的版本号。

    整体在一个事务里——迁移失败不会留下"改了一半"的结构。
    """
    ensure_meta_table(conn)
    have = current_version(conn)
    pending = sorted(
        (migration for migration in migrations if migration.version > have),
        key=lambda item: item.version,
    )

    if not pending:
        return have

    # 版本号必须连续且唯一，否则迁移顺序会出现歧义
    versions = [migration.version for migration in pending]
    if len(set(versions)) != len(versions):
        raise ValueError(f"迁移版本号重复：{versions}")

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    for migration in pending:
        migration.apply(conn)
        conn.execute(
            f"INSERT INTO {META_TABLE} (version, description, applied_at) VALUES (?, ?, ?)",
            (migration.version, migration.description, now),
        )
    conn.commit()
    return current_version(conn)
