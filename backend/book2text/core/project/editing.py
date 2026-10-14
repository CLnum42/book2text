"""审校期的写入：改块、确认整页、撤销 / 重做（说明书 5.3 / 5.4 / 6.4）。

**每一次修改都写一条 Event**（说明书 5.1："所有修改写入事件表，支持撤销与追溯"）。
事件里存的是**这次改动涉及的字段**（`before_json` / `after_json`），不是整行快照——
撤销就是把 `before` 写回去，事件本身也保持可读。

**同一批操作共享 `batch_id`**（例如"确认整页"一次改 12 个块），撤销按 batch 走。
撤销栈只存在内存里（说明书 5.3："撤销栈仅限本次会话"），因此本模块**不**保存栈，
它只负责"应用一批改动并记事件"与"把一批事件反过来应用"；
栈由接口层持有（`api/review_history.py`）。

**文本隔离（R5）：** 改 `text` 永远不碰 `ocr_text`——后者是识别原文，
界面上"恢复为 OCR 原文"就是把它写回 `text`。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ..storage import db as db_module
from ..storage.ulid import new_ulid
from . import blocks as blocks_module
from .library import ProjectError, project_dir

ACTOR_USER = "user"

# 说明书 5.3 的 action 取值里，本次用到的这些
ACTION_EDIT_TEXT = "edit_text"
ACTION_SET_STATUS = "set_status"
ACTION_SET_TYPE = "set_type"
ACTION_SET_INCLUDE = "set_include"
ACTION_SET_CONTINUES = "set_continues"

REVIEW_STATUSES = ("unreviewed", "confirmed", "uncertain")

# 块的类型（说明书 5.3 的取值，与界面上的中文标签一一对应）
BLOCK_TYPES = (
    "heading",
    "paragraph",
    "header",
    "footer",
    "page_number",
    "footnote",
    "caption",
    "other",
)

# 可改的字段 → 事件里的动作名
FIELD_ACTIONS = {
    "text": ACTION_EDIT_TEXT,
    "review_status": ACTION_SET_STATUS,
    "block_type": ACTION_SET_TYPE,
    "include": ACTION_SET_INCLUDE,
    "continues_to_next": ACTION_SET_CONTINUES,
    "comment": ACTION_SET_STATUS,
}


class BlockConflict(ProjectError):
    """乐观并发检查失败：这个块在别处已经被改过。

    单独成类是因为接口层要回 **409** 而不是 400——客户端据此提示
    "这一页在别处被改过"，而不是把它当成参数错误。
    """


@dataclass(frozen=True)
class Event:
    event_id: str
    batch_id: str
    entity_type: str
    entity_id: str
    action: str
    before: dict
    after: dict
    actor: str
    actor_name: str | None
    created_at: str

    def to_dict(self) -> dict[str, object]:
        return {
            "event_id": self.event_id,
            "batch_id": self.batch_id,
            "entity_type": self.entity_type,
            "entity_id": self.entity_id,
            "action": self.action,
            "before": self.before,
            "after": self.after,
            "actor": self.actor,
            "actor_name": self.actor_name,
            "created_at": self.created_at,
        }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _open(directory: Path):
    if not directory.is_dir() or not db_module.database_path(directory).is_file():
        raise ProjectError(f"找不到项目数据库：{directory}")
    return db_module.open_database(directory, apply_migrations=False)


def _record(
    conn,
    *,
    entity_type: str,
    entity_id: str,
    action: str,
    before: dict,
    after: dict,
    batch_id: str,
    actor: str = ACTOR_USER,
    actor_name: str | None = None,
) -> Event:
    now = _now()
    event = Event(
        event_id=new_ulid(),
        batch_id=batch_id,
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        before=before,
        after=after,
        actor=actor,
        actor_name=actor_name,
        created_at=now,
    )
    conn.execute(
        """
        INSERT INTO event (event_id, batch_id, entity_type, entity_id, action,
                           before_json, after_json, actor, actor_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event.event_id,
            batch_id,
            entity_type,
            entity_id,
            action,
            json.dumps(before, ensure_ascii=False),
            json.dumps(after, ensure_ascii=False),
            actor,
            actor_name,
            now,
        ),
    )
    return event


# ---------------------------------------------------------------- 改块

def update_block(
    project_id: str,
    block_id: str,
    *,
    library: Path | None = None,
    text: str | None = None,
    review_status: str | None = None,
    block_type: str | None = None,
    include: bool | None = None,
    continues_to_next: bool | None = None,
    comment: str | None = None,
    expected_revision: int | None = None,
    expected_updated_at: str | None = None,
    actor_name: str | None = None,
    batch_id: str | None = None,
) -> tuple[blocks_module.BlockRecord, list[Event]]:
    """改一个块，返回改后的块与这次写入的事件。

    ``expected_revision`` / ``expected_updated_at`` 是乐观并发检查（说明书第 11 节）：
    对不上就抛 `BlockConflict`，界面据此提示"这一页在别处被改过"而不是静默覆盖。
    `revision` 是首选的检查方式——它是单调递增的整数，比秒级时间戳更稳。
    """
    if library is None:
        from .library import default_library_dir

        library = default_library_dir()
    directory = project_dir(library, project_id)

    if review_status is not None and review_status not in REVIEW_STATUSES:
        raise ProjectError(f"未知的审校状态：{review_status!r}")
    if block_type is not None and block_type not in BLOCK_TYPES:
        raise ProjectError(f"未知的块类型：{block_type!r}")

    provided = {
        "text": text,
        "review_status": review_status,
        "block_type": block_type,
        "include": include,
        "continues_to_next": continues_to_next,
        "comment": comment,
    }
    changed = {name: value for name, value in provided.items() if value is not None}
    if not changed:
        raise ProjectError("没有要更新的字段")

    now = _now()
    with _open(directory) as conn:
        row = conn.execute("SELECT * FROM block WHERE block_id = ?", (block_id,)).fetchone()
        if row is None or row["deleted_at"]:
            raise ProjectError(f"找不到块：{block_id}")

        if expected_revision is not None and int(row["revision"]) != expected_revision:
            raise BlockConflict(
                f"这个块已经被改过（现在是第 {row['revision']} 版，你手上是第 {expected_revision} 版）"
            )
        if expected_updated_at is not None and row["updated_at"] != expected_updated_at:
            raise BlockConflict("这个块已经被改过（更新时间对不上）")

        before = {name: _column_value(row, name) for name in changed}
        after = dict(changed)
        if before == after:
            # 值没变就不写事件、不加 revision：避免"点一下没改也留一条历史"
            return _read_block(conn, block_id), []

        assignments = ", ".join(f"{name} = ?" for name in changed)
        params: list[object] = [_store(value) for value in changed.values()]
        conn.execute(
            f"UPDATE block SET {assignments}, revision = revision + 1, updated_at = ?"
            f" WHERE block_id = ?",
            (*params, now, block_id),
        )
        # 有实质修改才记事件（一次写入可能同时改多个字段，就记多条同类事件）
        events = [
            _record(
                conn,
                entity_type="block",
                entity_id=block_id,
                action=FIELD_ACTIONS[name],
                before={name: before[name]},
                after={name: after[name]},
                batch_id=batch_id or new_ulid(),
                actor_name=actor_name,
            )
            for name in changed
        ]
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()
        block = _read_block(conn, block_id)

    return block, events


def _column_value(row, name: str):
    value = row[name]
    if name in ("include", "continues_to_next"):
        return bool(value)
    return value


def _store(value):
    return int(value) if isinstance(value, bool) else value


def _read_block(conn, block_id: str) -> blocks_module.BlockRecord:
    row = conn.execute(
        """
        SELECT b.*, p.page_no FROM block b JOIN page p ON p.page_id = b.page_id
        WHERE b.block_id = ?
        """,
        (block_id,),
    ).fetchone()
    if row is None:  # pragma: no cover - 刚写过
        raise ProjectError(f"找不到块：{block_id}")
    return blocks_module.row_to_block(row)


# ---------------------------------------------------------------- 确认整页（R3）

@dataclass(frozen=True)
class ConfirmResult:
    page_no: int
    confirmed: int          # 这次被确认的块数
    uncertain: int          # 仍然不确定的块数（说明书 R3 要求提示）
    events: tuple[Event, ...]


def confirm_page(
    project_id: str,
    page_no: int,
    *,
    library: Path | None = None,
    actor_name: str | None = None,
    block_ids: list[str] | None = None,
) -> ConfirmResult:
    """确认整页（说明书 5.4 的 R3）。

    - 把这一页**纳入且未审**的块设为 confirmed；
    - **不确定（uncertain）的块不动**，并返回它们的数量（界面提示"本页仍有 N 个不确定项"）；
    - 排除的块也不动：它们不参与导出，确认与否没有意义。
    """
    if library is None:
        from .library import default_library_dir

        library = default_library_dir()
    directory = project_dir(library, project_id)
    now = _now()
    batch_id = new_ulid()

    with _open(directory) as conn:
        page = conn.execute("SELECT * FROM page WHERE page_no = ?", (page_no,)).fetchone()
        if page is None:
            raise ProjectError(f"没有第 {page_no} 页")

        # 只在真的给了 block_ids 时才加这个条件——`IN ()` 在 SQLite 里恒为假，
        # 会把"确认整页"变成"一个都不确认"
        clause = ""
        params: list[object] = [page["page_id"]]
        if block_ids:
            clause = "AND block_id IN ({})".format(", ".join("?" for _ in block_ids))
            params.extend(block_ids)
        rows = conn.execute(
            f"""
            SELECT * FROM block
            WHERE page_id = ? AND deleted_at IS NULL AND include = 1
              AND review_status = 'unreviewed' {clause}
            """,
            params,
        ).fetchall()

        events: list[Event] = []
        for row in rows:
            conn.execute(
                "UPDATE block SET review_status = 'confirmed', revision = revision + 1,"
                " updated_at = ? WHERE block_id = ?",
                (now, row["block_id"]),
            )
            events.append(
                _record(
                    conn,
                    entity_type="block",
                    entity_id=row["block_id"],
                    action=ACTION_SET_STATUS,
                    before={"review_status": "unreviewed"},
                    after={"review_status": "confirmed"},
                    batch_id=batch_id,
                    actor_name=actor_name,
                )
            )

        uncertain = conn.execute(
            "SELECT COUNT(*) AS n FROM block WHERE page_id = ? AND deleted_at IS NULL"
            " AND include = 1 AND review_status = 'uncertain'",
            (page["page_id"],),
        ).fetchone()["n"]
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()

    return ConfirmResult(
        page_no=page_no,
        confirmed=len(events),
        uncertain=int(uncertain),
        events=tuple(events),
    )


# ---------------------------------------------------------------- 撤销 / 重做

def revert_events(
    project_id: str,
    events: list[Event],
    *,
    library: Path | None = None,
    direction: str = "undo",
    actor_name: str | None = None,
) -> tuple[list[Event], set[int]]:
    """把一批事件**反过来应用**（撤销）或再应用一次（重做）。

    撤销 = 写回 `before`，重做 = 再写 `after`；两者都**记新事件**（历史保持线性、
    可追溯），并复用原来那批事件的 `batch_id`，这样"撤销掉的这一批"仍然是一批。

    返回 (新事件, 涉及的页码集合)。
    """
    if not events:
        return [], set()
    if direction not in ("undo", "redo"):
        raise ProjectError(f"未知的方向：{direction!r}")

    if library is None:
        from .library import default_library_dir

        library = default_library_dir()
    directory = project_dir(library, project_id)
    now = _now()
    new_events: list[Event] = []
    pages: set[int] = set()

    with _open(directory) as conn:
        for event in events:
            values = event.before if direction == "undo" else event.after
            if not values:
                continue
            row = conn.execute(
                "SELECT b.*, p.page_no FROM block b JOIN page p ON p.page_id = b.page_id"
                " WHERE b.block_id = ?",
                (event.entity_id,),
            ).fetchone()
            if row is None:  # pragma: no cover - 块被硬删只可能来自人工改库
                continue
            pages.add(int(row["page_no"]))

            assignments = ", ".join(f"{name} = ?" for name in values)
            conn.execute(
                f"UPDATE block SET {assignments}, revision = revision + 1, updated_at = ?"
                f" WHERE block_id = ?",
                (*[_store(value) for value in values.values()], now, event.entity_id),
            )
            new_events.append(
                _record(
                    conn,
                    entity_type="block",
                    entity_id=event.entity_id,
                    action=event.action,
                    before={name: _column_value(row, name) for name in values},
                    after=dict(values),
                    batch_id=event.batch_id,
                    actor_name=actor_name,
                )
            )
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()

    return new_events, pages

