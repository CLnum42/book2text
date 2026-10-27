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
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ..storage import db as db_module
from ..storage.ulid import new_ulid
from ..structure import regions as regions_module
from . import blocks as blocks_module
from . import layout as layout_module
from . import library as project_library
from . import recognition
from .library import ProjectError, project_dir

ACTOR_USER = "user"
ACTOR_SYSTEM = "system"
ACTOR_REVIEWER = "reviewer"

# 说明书 5.3 的 action 取值里，本次用到的这些
ACTION_EDIT_TEXT = "edit_text"
ACTION_SET_STATUS = "set_status"
ACTION_SET_TYPE = "set_type"
ACTION_SET_INCLUDE = "set_include"
ACTION_SET_CONTINUES = "set_continues"
ACTION_MERGE = "merge"
ACTION_SPLIT = "split"
ACTION_REORDER = "reorder"
ACTION_CREATE = "create"
ACTION_DELETE = "delete"
ACTION_MOVE_LINE = "move_line"
# 拆分时"被切开那一行"要变成两条 line 记录：不是搬，是新建 / 删除一行
ACTION_CREATE_LINE = "create_line"
ACTION_DELETE_LINE = "delete_line"
ACTION_SET_BBOX = "set_bbox"
ACTION_SET_LAYOUT_CONFIRMED = "set_layout_confirmed"
ACTION_REASSIGN_LINE = "reassign_line"
ACTION_CONFIRM_LAYOUT = "confirm_layout"
ACTION_ACK_KEPT = "diff_ack_kept"
ACTION_ACK_ADOPTED = "diff_ack_adopted"
# 人工裁决一处跨页边界（任务 42）：与 set_continues 分开记，因为"人看过"与
# "自动判定"是两件事，而且撤销这一批时要把 continues_reviewed 写回 0。
ACTION_CONFIRM_CONTINUATION = "confirm_continuation"

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
    "figure",
    "decoration",
    "margin_note",
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
    "bbox": ACTION_SET_BBOX,
    "layout_confirmed": ACTION_SET_LAYOUT_CONFIRMED,
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
    package_id: str | None = None

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
            "package_id": self.package_id,
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
    package_id: str | None = None,
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
        package_id=package_id,
        created_at=now,
    )
    conn.execute(
        """
        INSERT INTO event (event_id, batch_id, entity_type, entity_id, action,
                           before_json, after_json, actor, actor_name, package_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            package_id,
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
    bbox: tuple[float, float, float, float] | None = None,
    layout_confirmed: bool | None = None,
    expected_revision: int | None = None,
    expected_updated_at: str | None = None,
    actor_name: str | None = None,
    actor: str = ACTOR_USER,
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
    if layout_confirmed is not None and not isinstance(layout_confirmed, bool):
        raise ProjectError("layout_confirmed 必须是布尔值")
    bbox_json = None
    if bbox is not None:
        bbox = _validate_bbox(bbox)
        bbox_json = blocks_module.bbox_to_json(blocks_module.BBox(*bbox))

    provided = {
        "text": text,
        "review_status": review_status,
        "block_type": block_type,
        "include": include,
        "continues_to_next": continues_to_next,
        "comment": comment,
        "bbox": bbox_json,
        "layout_confirmed": layout_confirmed,
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
        batch = batch_id or new_ulid()
        events = [
            _record(
                conn,
                entity_type="block",
                entity_id=block_id,
                action=FIELD_ACTIONS[name],
                before={name: before[name]},
                after={name: after[name]},
                batch_id=batch,
                actor=actor,
                actor_name=actor_name,
            )
            for name in changed
        ]
        # 改框之后重新算「行 → 块」归属：不重跑 OCR，只搬 block_line 记录。
        # 这一步与改框的记录在同一个 batch 里，撤销一次就整体回去。
        if "bbox" in changed:
            events.extend(
                _reassign_page_lines(
                    conn,
                    row["page_id"],
                    batch_id=batch,
                    actor=actor,
                    actor_name=actor_name,
                    now=now,
                )
            )
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()
        block = _read_block(conn, block_id)

    return block, events


def apply_block_types(
    project_id: str,
    items: list[tuple[str, str]],
    *,
    library: Path | None = None,
    batch_id: str | None = None,
    actor_name: str | None = None,
    actor: str = ACTOR_SYSTEM,
) -> tuple[list[Event], dict[str, int], tuple[int, ...]]:
    """把一批块**一次**改成指定类型（「全库采用高把握建议」与自动应用共用）。

    与逐个调 `update_block` 的区别只在性能与事件来源：这里一个连接、一个事务、
    一个 `batch_id`，并显式记 `actor`（自动应用 / 批量建议是 `system`，
    不会被结构工具的"人工改过就不覆盖"当成手工类型）。返回
    （事件, 各类型计数, 涉及的页码）。

    已经是指定类型的块跳过（不写无用事件）；找不到或已删除的块跳过
    （任务进行中页面被重新识别时会发生）。
    """
    if library is None:
        from .library import default_library_dir

        library = default_library_dir()
    directory = project_dir(library, project_id)
    batch = batch_id or new_ulid()
    now = _now()
    events: list[Event] = []
    by_type: dict[str, int] = {}
    pages: set[int] = set()

    with _open(directory) as conn:
        page_nos = {
            row["page_id"]: int(row["page_no"])
            for row in conn.execute("SELECT page_id, page_no FROM page").fetchall()
        }
        for block_id, block_type in items:
            if block_type not in BLOCK_TYPES:
                raise ProjectError(f"未知的块类型：{block_type!r}")
            row = _block_of(conn, block_id)
            if row is None or row["deleted_at"]:
                continue
            if row["block_type"] == block_type:
                continue
            block_events, _ = _set_block_fields(
                conn,
                block_id,
                {"block_type": block_type},
                batch_id=batch,
                action=ACTION_SET_TYPE,
                actor_name=actor_name,
                now=now,
                actor=actor,
            )
            events.extend(block_events)
            if block_events:
                by_type[block_type] = by_type.get(block_type, 0) + 1
                page_no = page_nos.get(row["page_id"])
                if page_no is not None:
                    pages.add(page_no)
        if events:
            conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()

    return events, by_type, tuple(sorted(pages))


def apply_continuations(
    project_id: str,
    items: list[tuple[str, bool]],
    *,
    library: Path | None = None,
    batch_id: str | None = None,
    actor_name: str | None = None,
    actor: str = ACTOR_SYSTEM,
) -> tuple[list[Event], int, tuple[int, ...]]:
    """批量设置「延续到下一页」（任务 41 / F1 的自动判定用）。

    与 ``apply_block_types`` 同一套约束：一个连接、一个事务、一个 ``batch_id``，
    显式记 ``actor=system``（自动判定，不是人工）；已经是要的值就跳过，不写无用事件。
    返回（事件, 改了几块, 涉及的页码），整批可以一次撤销。
    """
    if library is None:
        from .library import default_library_dir

        library = default_library_dir()
    directory = project_dir(library, project_id)
    batch = batch_id or new_ulid()
    now = _now()
    events: list[Event] = []
    pages: set[int] = set()
    changed = 0

    with _open(directory) as conn:
        page_nos = {
            row["page_id"]: int(row["page_no"])
            for row in conn.execute("SELECT page_id, page_no FROM page").fetchall()
        }
        for block_id, value in items:
            row = _block_of(conn, block_id)
            if row is None or row["deleted_at"]:
                continue
            if bool(row["continues_to_next"]) == bool(value):
                continue
            block_events, _ = _set_block_fields(
                conn,
                block_id,
                {"continues_to_next": 1 if value else 0},
                batch_id=batch,
                action=ACTION_SET_CONTINUES,
                actor_name=actor_name,
                now=now,
                actor=actor,
            )
            events.extend(block_events)
            if block_events:
                changed += 1
                page_no = page_nos.get(row["page_id"])
                if page_no is not None:
                    pages.add(page_no)
        if events:
            conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()

    return events, changed, tuple(sorted(pages))


def review_continuation(
    project_id: str,
    block_id: str,
    continues: bool,
    *,
    library: Path | None = None,
    actor_name: str | None = None,
) -> tuple[blocks_module.BlockRecord, list[Event]]:
    """人工裁决一处跨页边界（任务 42）：写 `continues_to_next` + `continues_reviewed=1`。

    与 ``apply_continuations`` 的区别是语义：那一个是系统的自动判定（actor=system，
    不动 `continues_reviewed`）；这一个记的是**人看过了**，界面据此把这一处从
    「跨页延续待确认」里移走。撤销时 `continues_reviewed` 会写回 0，那一处重新回到
    待确认——这正是这一列存在的理由（见迁移 0020）。
    """
    return _continuation_review(
        project_id,
        block_id,
        {"continues_to_next": bool(continues), "continues_reviewed": True},
        library=library,
        actor_name=actor_name,
    )


def reopen_continuation(
    project_id: str,
    block_id: str,
    *,
    library: Path | None = None,
    actor_name: str | None = None,
) -> tuple[blocks_module.BlockRecord, list[Event]]:
    """把一处已经人工裁决过的跨页边界**放回待确认**（不改 `continues_to_next`）。

    面板上"撤销这处 / 改判"走这里；它同样是一条可撤销的事件。
    """
    return _continuation_review(
        project_id,
        block_id,
        {"continues_reviewed": False},
        library=library,
        actor_name=actor_name,
    )


def _continuation_review(
    project_id: str,
    block_id: str,
    values: dict,
    *,
    library: Path | None = None,
    actor_name: str | None = None,
) -> tuple[blocks_module.BlockRecord, list[Event]]:
    if library is None:
        from .library import default_library_dir

        library = default_library_dir()
    directory = project_dir(library, project_id)
    now = _now()
    batch_id = new_ulid()

    with _open(directory) as conn:
        row = _block_of(conn, block_id)
        if row is None or row["deleted_at"]:
            raise ProjectError(f"找不到块：{block_id}")
        events, _ = _set_block_fields(
            conn,
            block_id,
            values,
            batch_id=batch_id,
            action=ACTION_CONFIRM_CONTINUATION,
            actor_name=actor_name,
            now=now,
            actor=ACTOR_USER,
        )
        if events:
            conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()
        record = _read_block(conn, block_id)
    return record, events


# ---------------------------------------------------------------- 框与行归属

# 手动框不允许小到点不中；也避免退化成一条线（那样一行都落不进去）
MIN_BBOX_SIDE = 0.005


def _validate_bbox(bbox: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    """校验归一化框：0–1、左上小于右下、不要太小。"""
    if len(bbox) != 4:
        raise ProjectError("框必须是 4 个数：x0, y0, x1, y1")
    try:
        values = tuple(float(value) for value in bbox)
    except (TypeError, ValueError) as exc:
        raise ProjectError("框的坐标必须是数字") from exc
    if not all(math.isfinite(value) for value in values):
        raise ProjectError("框的坐标必须是有限数字")
    x0, y0, x1, y1 = values
    if min(values) < 0.0 or max(values) > 1.0:
        raise ProjectError("框的坐标必须落在 0–1（相对页面显示方向的归一化坐标）")
    if x1 - x0 < MIN_BBOX_SIDE or y1 - y0 < MIN_BBOX_SIDE:
        raise ProjectError("框太小了：宽和高都至少要有半个百分点")
    return (x0, y0, x1, y1)


def _reassign_page_lines(
    conn,
    page_id: str,
    *,
    batch_id: str,
    actor: str,
    actor_name: str | None,
    now: str,
) -> list[Event]:
    """按块框重新分配这一页的行（不重跑 OCR，不改行文本）。

    只搬 ``block_line`` 的三样东西：``block_id``（归给谁）、``line_index``
    （在这个块里的顺序）、``layout_status``（assigned / conflict / unassigned）。
    每一处变化都记一条事件，撤销时逐行写回去。
    """
    block_rows = conn.execute(
        """
        SELECT block_id, bbox, order_index FROM block
        WHERE page_id = ? AND deleted_at IS NULL
        ORDER BY order_index, block_id
        """,
        (page_id,),
    ).fetchall()
    line_rows = conn.execute(
        """
        SELECT l.line_id, l.block_id, l.line_index, l.bbox, l.layout_status
        FROM block_line l
        JOIN block b ON b.block_id = l.block_id
        WHERE b.page_id = ? AND b.deleted_at IS NULL
        """,
        (page_id,),
    ).fetchall()
    if not line_rows:
        return []

    blocks = [
        layout_module.BlockBox(
            block_id=row["block_id"],
            bbox=blocks_module.bbox_from_json(row["bbox"]),
            order_index=int(row["order_index"]),
        )
        for row in block_rows
    ]
    lines = [
        layout_module.LineBox(
            line_id=row["line_id"],
            block_id=row["block_id"],
            bbox=blocks_module.bbox_from_json(row["bbox"]),
        )
        for row in line_rows
    ]
    assignments = {item.line_id: item for item in layout_module.assign_lines(lines, blocks)}

    target: dict[str, tuple[str, str]] = {}
    for row in line_rows:
        assignment = assignments.get(row["line_id"])
        if assignment is None:
            # 没有 bbox 的行（例如拆分后被清掉坐标的那一行）：不动它的归属与状态
            target[row["line_id"]] = (row["block_id"], row["layout_status"])
        else:
            target[row["line_id"]] = (assignment.block_id, assignment.status)

    # 块内顺序：有坐标的按从上到下、从左到右；没坐标的排在该块最后，保持原有相对顺序
    def order_key(row) -> tuple[int, float, float, int]:
        box = blocks_module.bbox_from_json(row["bbox"])
        if box is None:
            return (1, 0.0, 0.0, int(row["line_index"]))
        return (0, box[1], box[0], int(row["line_index"]))

    grouped: dict[str, list] = {}
    for row in line_rows:
        grouped.setdefault(target[row["line_id"]][0], []).append(row)
    desired_index: dict[str, int] = {}
    for rows in grouped.values():
        for index, row in enumerate(sorted(rows, key=order_key)):
            desired_index[row["line_id"]] = index

    events: list[Event] = []
    for row in line_rows:
        line_id = row["line_id"]
        new_block, new_status = target[line_id]
        updates: dict[str, object] = {}
        if row["block_id"] != new_block:
            updates["block_id"] = new_block
        if row["layout_status"] != new_status:
            updates["layout_status"] = new_status
        if int(row["line_index"]) != desired_index[line_id]:
            updates["line_index"] = desired_index[line_id]
        if not updates:
            continue
        before = {name: _column_value(row, name) for name in updates}
        _apply_values(conn, "block_line", line_id, updates, now)
        events.append(
            _record(
                conn,
                entity_type="block_line",
                entity_id=line_id,
                action=ACTION_REASSIGN_LINE,
                before=before,
                after=dict(updates),
                batch_id=batch_id,
                actor=actor,
                actor_name=actor_name,
            )
        )
    return events


# 事件里的 entity_type → (表名, 主键列, 取行用的 SQL)
# 撤销时按这个表把 `before` 写回去，因此**事件里的每个键都必须是真实列名**。
_TABLES = {
    "block": ("block", "block_id"),
    "block_line": ("block_line", "line_id"),
    # page 也在里面：采用新结果要换 active_run_id，那一步同样得能撤销
    "page": ("page", "page_id"),
}


def _column_value(row, name: str):
    value = row[name]
    if name in (
        "include",
        "continues_to_next",
        "layout_confirmed",
        "continues_reviewed",
    ):
        return bool(value)
    return value


def _store(value):
    return int(value) if isinstance(value, bool) else value


def _entity_row(conn, entity_type: str, entity_id: str):
    """取一行（块要带上 page_no 与 page_id，撤销后要告诉界面哪些页变了）。"""
    if entity_type not in _TABLES:
        raise ProjectError(f"事件里出现未知的实体类型：{entity_type!r}")
    if entity_type == "block":
        return conn.execute(
            """
            SELECT b.*, p.page_no FROM block b JOIN page p ON p.page_id = b.page_id
            WHERE b.block_id = ?
            """,
            (entity_id,),
        ).fetchone()
    if entity_type == "page":
        return conn.execute("SELECT * FROM page WHERE page_id = ?", (entity_id,)).fetchone()
    return conn.execute(
        """
        SELECT l.*, b.page_id, p.page_no
        FROM block_line l
        JOIN block b ON b.block_id = l.block_id
        JOIN page p ON p.page_id = b.page_id
        WHERE l.line_id = ?
        """,
        (entity_id,),
    ).fetchone()


def _apply_values(conn, entity_type: str, entity_id: str, values: dict, now: str) -> bool:
    """把一组字段写到某个实体上（撤销 / 重做都走这里）。返回是否找到了那一行。"""
    table, key = _TABLES[entity_type]
    assignments = ", ".join(f"{name} = ?" for name in values)
    sql = f"UPDATE {table} SET {assignments}"
    if entity_type == "block":
        sql += ", revision = revision + 1, updated_at = ?"
    cursor = conn.execute(
        f"{sql} WHERE {key} = ?",
        (*[_store(value) for value in values.values()], *((now, entity_id) if entity_type == "block" else (entity_id,))),
    )
    return cursor.rowcount > 0


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


# ---------------------------------------------------------------- 差异裁决（任务 67）

DIFF_ACK_KEPT = "kept"
DIFF_ACK_ADOPTED = "adopted"
DIFF_ACKS = (DIFF_ACK_KEPT, DIFF_ACK_ADOPTED)


def ack_diff_line(
    project_id: str,
    block_id: str,
    line_index: int,
    ack: str,
    *,
    text: str | None = None,
    library: Path | None = None,
    actor_name: str | None = None,
    actor: str = ACTOR_USER,
    batch_id: str | None = None,
) -> tuple[blocks_module.BlockRecord, dict, list[Event]]:
    """持久化一行差异的裁决：保留原文 / 采纳第二路。

    - `kept` 只写 `block_line.diff_ack='kept'`，不改文本；
    - `adopted` 在**同一个 batch** 里改 `block.text` 并写 `diff_ack='adopted'`，
      这样一次撤销能把文本与裁决一起退回；
    - `diff_ack_text` 记录裁决时这一行的文本，重跑复核时用来判断文本是否真的变了。
    """
    if ack not in DIFF_ACKS:
        raise ProjectError(f"未知的差异裁决：{ack!r}")
    if library is None:
        from .library import default_library_dir

        library = default_library_dir()
    directory = project_dir(library, project_id)
    now = _now()
    with _open(directory) as conn:
        block = conn.execute("SELECT * FROM block WHERE block_id = ?", (block_id,)).fetchone()
        if block is None or block["deleted_at"]:
            raise ProjectError(f"找不到块：{block_id}")
        line = conn.execute(
            "SELECT * FROM block_line WHERE block_id = ? AND line_index = ?",
            (block_id, line_index),
        ).fetchone()
        if line is None:
            raise ProjectError(f"块 {block_id} 没有第 {line_index + 1} 行")
        current_lines = (block["text"] or "").split("\n")
        if line_index < 0 or line_index >= len(current_lines):
            raise ProjectError("这一块的行号对不上了")

        batch = batch_id or new_ulid()
        events: list[Event] = []
        new_text = text
        if ack == DIFF_ACK_ADOPTED:
            if new_text is None:
                raise ProjectError("采纳第二路需要同时提供新的块文本")
            new_lines = new_text.split("\n")
            if len(new_lines) != len(current_lines):
                raise ProjectError("新的块文本行数与原块不一致")
            if new_text != block["text"]:
                events.append(
                    _record(
                        conn,
                        entity_type="block",
                        entity_id=block_id,
                        action=ACTION_EDIT_TEXT,
                        before={"text": block["text"]},
                        after={"text": new_text},
                        batch_id=batch,
                        actor=actor,
                        actor_name=actor_name,
                    )
                )
                conn.execute(
                    "UPDATE block SET text = ?, revision = revision + 1, updated_at = ?"
                    " WHERE block_id = ?",
                    (new_text, now, block_id),
                )
            ack_text = new_lines[line_index]
        else:
            ack_text = current_lines[line_index]

        before_ack = line["diff_ack"] if "diff_ack" in line.keys() else None
        before_ack_text = line["diff_ack_text"] if "diff_ack_text" in line.keys() else None
        if before_ack != ack or before_ack_text != ack_text:
            events.append(
                _record(
                    conn,
                    entity_type="block_line",
                    entity_id=line["line_id"],
                    action=ACTION_ACK_ADOPTED if ack == DIFF_ACK_ADOPTED else ACTION_ACK_KEPT,
                    before={"diff_ack": before_ack, "diff_ack_text": before_ack_text},
                    after={"diff_ack": ack, "diff_ack_text": ack_text},
                    batch_id=batch,
                    actor=actor,
                    actor_name=actor_name,
                )
            )
            conn.execute(
                "UPDATE block_line SET diff_ack = ?, diff_ack_text = ? WHERE line_id = ?",
                (ack, ack_text, line["line_id"]),
            )
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()
        updated_block = _read_block(conn, block_id)
        updated_line = conn.execute(
            "SELECT * FROM block_line WHERE line_id = ?", (line["line_id"],)
        ).fetchone()

    return (
        updated_block,
        {
            "line_id": updated_line["line_id"],
            "line_index": int(updated_line["line_index"]),
            "diff_ack": updated_line["diff_ack"],
            "diff_ack_text": updated_line["diff_ack_text"],
        },
        events,
    )


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


def confirm_page_layout(
    project_id: str,
    page_nos: list[int],
    *,
    library: Path | None = None,
    actor_name: str | None = None,
) -> list[Event]:
    """确认整页的**版面**（哪些块算正文），可批量。

    与页面确认（page_confirmed = 这页算不算正文）是两件事。确认人 / 时间写进
    `event` 表（entity_type=page，action=confirm_layout），不新增列。
    重复确认是幂等的：已经确认过的页不再写事件。

    任何块的类型、框、顺序（含新增 / 软删除）改动都会由迁移 0009 的触发器把
    `page.layout_confirmed` 重置为 0——这里不用在每条编辑路径重复实现。
    """
    if not page_nos:
        raise ProjectError("没有指定要确认版面的页面")
    unique_nos = sorted({int(no) for no in page_nos})
    if library is None:
        from .library import default_library_dir

        library = default_library_dir()
    directory = project_dir(library, project_id)
    now = _now()
    batch_id = new_ulid()

    with _open(directory) as conn:
        condition = ", ".join("?" for _ in unique_nos)
        rows = conn.execute(
            f"SELECT page_id, page_no, layout_confirmed FROM page WHERE page_no IN ({condition})"
            f" ORDER BY page_no",
            unique_nos,
        ).fetchall()
        found = {int(row["page_no"]) for row in rows}
        missing = [no for no in unique_nos if no not in found]
        if missing:
            raise ProjectError(f"找不到这些页面：{'、'.join(str(no) for no in missing[:5])}")

        events: list[Event] = []
        for row in rows:
            if int(row["layout_confirmed"] or 0):
                continue
            conn.execute(
                "UPDATE page SET layout_confirmed = 1 WHERE page_id = ?",
                (row["page_id"],),
            )
            events.append(
                _record(
                    conn,
                    entity_type="page",
                    entity_id=row["page_id"],
                    action=ACTION_CONFIRM_LAYOUT,
                    before={"layout_confirmed": 0},
                    after={"layout_confirmed": 1, "page_no": int(row["page_no"])},
                    batch_id=batch_id,
                    actor_name=actor_name,
                )
            )
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()
    return events


# ---------------------------------------------------------------- 结构编辑（说明书 6.4 / R4）
#
# 五个操作：与上一块合并、在光标处拆分、上移 / 下移、新增、删除（软删除）。
# 全部落在同一套机制上：改行 → 记事件 → 可撤销。
#
# **位置近似的标记：** 说明书写"拆分后两块暂沿用原 bbox，并标记为'位置近似'"、
# 合并后 bbox 取并集。这里用 `origin`（ocr / manual / split / merge）承担这个标记——
# 它不是引擎在那一块上量出来的坐标，界面对 split / merge 的块显示"位置近似"。


def _insert_block(
    conn,
    *,
    page_id: str,
    origin: str,
    order_index: int,
    bbox: str | None,
    text: str,
    ocr_text: str = "",
    origin_run_id: str | None = None,
    include: int = 1,
    continues_to_next: int = 0,
    block_type: str = "paragraph",
    action: str,
    batch_id: str,
    actor_name: str | None,
    now: str,
    block_id: str | None = None,
) -> tuple[str, list[Event]]:
    """新增一个块。

    **先以软删除状态插入，再把"恢复可见"记成一条普通事件**：这样撤销一次新增
    仍然只是"把 `deleted_at` 写回去"，撤销机制里不需要为"新块"开特例。
    """
    block_id = block_id or new_ulid()
    conn.execute(
        """
        INSERT INTO block (
            block_id, page_id, origin_run_id, origin, order_index, bbox, block_type,
            ocr_text, text, review_status, include, continues_to_next, confidence,
            revision, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'unreviewed', ?, ?, NULL, 0, ?, ?, ?)
        """,
        (
            block_id,
            page_id,
            origin_run_id,
            origin,
            order_index,
            bbox,
            block_type,
            ocr_text,
            text,
            include,
            continues_to_next,
            now,
            now,
            now,
        ),
    )
    events, _ = _set_block_fields(
        conn,
        block_id,
        {"deleted_at": None},
        batch_id=batch_id,
        action=action,
        actor_name=actor_name,
        now=now,
    )
    return block_id, events


def _page_blocks(conn, page_id: str) -> list:
    """这一页当前有效的块，按阅读顺序。"""
    return conn.execute(
        """
        SELECT b.*, p.page_no FROM block b JOIN page p ON p.page_id = b.page_id
        WHERE b.page_id = ? AND b.deleted_at IS NULL
        ORDER BY b.order_index, b.block_id
        """,
        (page_id,),
    ).fetchall()


def _block_of(conn, block_id: str):
    return _entity_row(conn, "block", block_id)


def _lines_of(conn, block_id: str) -> list:
    return conn.execute(
        "SELECT * FROM block_line WHERE block_id = ? ORDER BY line_index", (block_id,)
    ).fetchall()


def _union_bbox(left: str | None, right: str | None) -> str | None:
    """两个 JSON bbox 取并集；任一为空则取另一个。"""
    if not left:
        return right
    if not right:
        return left
    a = blocks_module.bbox_from_json(left)
    b = blocks_module.bbox_from_json(right)
    if a is None:
        return right
    if b is None:
        return left
    return json.dumps(
        [
            round(min(a[0], b[0]), 6),
            round(min(a[1], b[1]), 6),
            round(max(a[2], b[2]), 6),
            round(max(a[3], b[3]), 6),
        ]
    )


def _set_block_fields(
    conn,
    block_id: str,
    values: dict,
    *,
    batch_id: str,
    action: str,
    actor_name: str | None,
    now: str,
    actor: str = ACTOR_USER,
) -> tuple[list[Event], dict]:
    """改一个块的若干字段并记事件（结构编辑内部用；返回事件与改动前的值）。"""
    row = _block_of(conn, block_id)
    before = {name: _column_value(row, name) for name in values}
    if before == values:
        return [], before
    _apply_values(conn, "block", block_id, values, now)
    # 一次改多个字段时记多条同类事件（与 update_block 一致）：撤销时逐字段写回去
    events = [
        _record(
            conn,
            entity_type="block",
            entity_id=block_id,
            action=action,
            before={name: before[name]},
            after={name: values[name]},
            batch_id=batch_id,
            actor=actor,
            actor_name=actor_name,
        )
        for name in values
    ]
    return events, before


def merge_with_previous(
    project_id: str,
    block_id: str,
    *,
    library: Path | None = None,
    actor_name: str | None = None,
) -> tuple[blocks_module.BlockRecord, list[Event]]:
    """把这一块合并到**上一块**里（说明书 R4）。

    R4 的规定：文本以 `\\n` 连接、bbox 取并集、`ocr_text` 同样合并、来源块记在事件里。
    行记录也一起搬过去（说明书 5.3：合并时"行记录随文本拼接保留原 bbox"），
    否则合并后的块会缺一半行级坐标。
    """
    if library is None:
        from .library import default_library_dir

        library = default_library_dir()
    directory = project_dir(library, project_id)
    now = _now()
    batch_id = new_ulid()

    with _open(directory) as conn:
        lower = _block_of(conn, block_id)
        if lower is None or lower["deleted_at"]:
            raise ProjectError(f"找不到块：{block_id}")

        siblings = _page_blocks(conn, lower["page_id"])
        index = next(i for i, row in enumerate(siblings) if row["block_id"] == block_id)
        if index == 0:
            raise ProjectError("这一块已经是本页第一块，前面没有可合并的块")
        upper = siblings[index - 1]

        events: list[Event] = []
        # 文本 / 原文 / 坐标 / 来源（R4）
        merged_text = f"{upper['text']}\n{lower['text']}"
        merged_ocr = f"{upper['ocr_text'] or ''}\n{lower['ocr_text'] or ''}".lstrip("\n")
        # 审校状态：两边都已确认才算已确认，否则回到未审（合并改变了内容）
        merged_status = (
            "confirmed"
            if upper["review_status"] == lower["review_status"] == "confirmed"
            else "unreviewed"
        )
        merged_values = {
            "text": merged_text,
            "ocr_text": merged_ocr,
            "bbox": _union_bbox(upper["bbox"], lower["bbox"]),
            "origin": "merge",
            "review_status": merged_status,
            "include": int(bool(upper["include"]) or bool(lower["include"])),
            "continues_to_next": int(
                bool(upper["continues_to_next"]) or bool(lower["continues_to_next"])
            ),
        }
        block_events, _ = _set_block_fields(
            conn,
            upper["block_id"],
            merged_values,
            batch_id=batch_id,
            action=ACTION_MERGE,
            actor_name=actor_name,
            now=now,
        )
        events.extend(block_events)

        # 行记录搬过去：line_index 接在上一块后面
        upper_lines = _lines_of(conn, upper["block_id"])
        offset = len(upper_lines)
        for line in _lines_of(conn, lower["block_id"]):
            _apply_values(
                conn,
                "block_line",
                line["line_id"],
                {"block_id": upper["block_id"], "line_index": line["line_index"] + offset},
                now,
            )
            events.append(
                _record(
                    conn,
                    entity_type="block_line",
                    entity_id=line["line_id"],
                    action=ACTION_MOVE_LINE,
                    before={"block_id": lower["block_id"], "line_index": line["line_index"]},
                    after={
                        "block_id": upper["block_id"],
                        "line_index": line["line_index"] + offset,
                    },
                    batch_id=batch_id,
                    actor_name=actor_name,
                )
            )

        # 被合并掉的那一块软删除（说明书 5.1：删除一律软删除）
        delete_events, _ = _set_block_fields(
            conn,
            lower["block_id"],
            {"deleted_at": now},
            batch_id=batch_id,
            action=ACTION_DELETE,
            actor_name=actor_name,
            now=now,
        )
        events.extend(delete_events)

        # 合并后的框是并集，可能把旁边的行圈进来：重算一次归属
        events.extend(
            _reassign_page_lines(
                conn,
                lower["page_id"],
                batch_id=batch_id,
                actor=ACTOR_USER,
                actor_name=actor_name,
                now=now,
            )
        )

        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()
        merged = _read_block(conn, upper["block_id"])

    return merged, events


# ---------------------------------------------------------------- 拆分
#
# 拆出来的两半各自要有一个**自己的**框。R4 的"两块暂沿用原 bbox"在真书上是两个
# 完全重叠的框，用户还得手动拖一次，所以这里按行框分配：
#
# - 切在行边界：前块拿前面整行的并集，后块拿其余整行的并集（两组行框不相交，
#   两个框也就不重叠）；
# - 切在一行中间：这一行按**字符比例**估一个横向切线（同一个 cut 值同时给前块的
#   右边界和后块的左边界，两块只在边界上相接），前面 / 后面的整行仍按行分配。
#
# 两个框都裁剪到原块范围内（行框可能因为拖动而略超出块框）。

# 拆出来的半边可以比手动框更窄（一行里切半个字），但绝不允许退化成 0 宽
SPLIT_MIN_SIDE = 1e-5
# 批量拆页码时，"不像书眉页脚"的块只有落在页面上下的这个比例带里才考虑
PAGE_NUMBER_BAND = 0.12


def _clip_rect(rect, base):
    x0 = max(float(rect[0]), base[0])
    y0 = max(float(rect[1]), base[1])
    x1 = min(float(rect[2]), base[2])
    y1 = min(float(rect[3]), base[3])
    if x1 - x0 < SPLIT_MIN_SIDE or y1 - y0 < SPLIT_MIN_SIDE:
        return None
    return (x0, y0, x1, y1)


def _union_rects(rects, base):
    clipped = [item for item in (_clip_rect(rect, base) for rect in rects if rect) if item]
    if not clipped:
        return None
    return (
        min(item[0] for item in clipped),
        min(item[1] for item in clipped),
        max(item[2] for item in clipped),
        max(item[3] for item in clipped),
    )


def _round_rect(rect):
    return tuple(round(float(value), 6) for value in rect)


def _rects_overlap(a, b, eps: float = 1e-9) -> bool:
    return (
        min(a[2], b[2]) - max(a[0], b[0]) > eps
        and min(a[3], b[3]) - max(a[1], b[1]) > eps
    )


def _rect_contains(outer, inner, eps: float = 1e-9) -> bool:
    return (
        outer[0] <= inner[0] + eps
        and outer[1] <= inner[1] + eps
        and outer[2] >= inner[2] - eps
        and outer[3] >= inner[3] - eps
    )


def _cut_x(rect, ratio: float | None) -> float:
    """一行里按字符比例算横向切线；夹在行框内部，保证两边都不为 0 宽。"""
    value = 0.5 if ratio is None else min(max(float(ratio), 0.0), 1.0)
    cut = round(rect[0] + (rect[2] - rect[0]) * value, 6)
    return min(max(cut, rect[0] + SPLIT_MIN_SIDE), rect[2] - SPLIT_MIN_SIDE)


def _split_base_estimate(
    base, *, whole_head_lines: int, split_line: int | None, ratio: float | None, line_count: int
):
    """没有行框时的退路。

    - 只有一行（或没有行信息）：按字符比例横切；
    - 多行、切在行内：按行数估出那一行的竖带，整条带子归文字多的那一边
      （横切一个矩形表达不了"上行归前、下行归后"，那样两个框一定会重叠）。
    """
    x0, y0, x1, y1 = base
    total = max(int(line_count), 1)
    if split_line is not None:
        value = 0.5 if ratio is None else min(max(float(ratio), 0.0), 1.0)
        if total <= 1:
            cut = _cut_x(base, value)
            return _round_rect((x0, y0, cut, y1)), _round_rect((cut, y0, x1, y1))
        line_top = round(y0 + (y1 - y0) * (split_line / total), 6)
        line_bottom = round(y0 + (y1 - y0) * ((split_line + 1) / total), 6)
        if value > 0.5:
            return _round_rect((x0, y0, x1, line_bottom)), _round_rect((x0, line_bottom, x1, y1))
        return _round_rect((x0, y0, x1, line_top)), _round_rect((x0, line_top, x1, y1))
    head_lines = min(max(int(whole_head_lines), 0), total)
    cut = round(y0 + (y1 - y0) * (head_lines / total), 6)
    cut = min(max(cut, y0 + SPLIT_MIN_SIDE), y1 - SPLIT_MIN_SIDE)
    return _round_rect((x0, y0, x1, cut)), _round_rect((x0, cut, x1, y1))


def _estimate_split_rects(
    base, line_rects, *, whole_head_lines: int, split_line: int | None, ratio: float | None
):
    """按行框估算拆开后 （前块 bbox, 后块 bbox）；没有坐标就返回 (None, None)。"""
    if base is None:
        return None, None
    base = tuple(float(value) for value in base)
    if not any(line_rects):
        return _split_base_estimate(
            base,
            whole_head_lines=whole_head_lines,
            split_line=split_line,
            ratio=ratio,
            line_count=len(line_rects),
        )

    cut = None
    if split_line is not None:
        source = base
        if 0 <= split_line < len(line_rects) and line_rects[split_line]:
            source = line_rects[split_line]
        cut = _cut_x(source, ratio)

    value = 0.5 if ratio is None else min(max(float(ratio), 0.0), 1.0)
    # 只有被切开的那一行：横切一个矩形就够了（书眉 + 页码就是这种，两块只在边界相接）。
    single_line = split_line is not None and sum(1 for rect in line_rects if rect) <= 1

    head_rects = []
    tail_rects = []
    for index, rect in enumerate(line_rects):
        if rect is None:
            continue
        if split_line is not None:
            if index < split_line:
                head_rects.append(rect)
            elif index > split_line:
                tail_rects.append(rect)
            elif single_line:
                head_rects.append((rect[0], rect[1], cut, rect[3]))
                tail_rects.append((cut, rect[1], rect[2], rect[3]))
            elif value > 0.5:
                # 多行块在行中间拆开：这一行整行算给文字多的那一边，
                # 另一边的框从相邻行边界开始——宁可少包一行，也不要两个框压在一起
                head_rects.append(rect)
            else:
                tail_rects.append(rect)
        elif index < whole_head_lines:
            head_rects.append(rect)
        else:
            tail_rects.append(rect)

    head = _union_rects(head_rects, base)
    tail = _union_rects(tail_rects, base)
    if head is None or tail is None:
        # 有一边一行都落不进原块（例如行框整体偏移到框外）：退回按比例估，两边都要有框
        return _split_base_estimate(
            base,
            whole_head_lines=whole_head_lines,
            split_line=split_line,
            ratio=ratio,
            line_count=len(line_rects),
        )

    head = _round_rect(head)
    tail = _round_rect(tail)

    # 行框本身可能上下轻微交叠（行距估计有误差）。真出现面积重叠时：
    # 行边界切按重叠区中线竖切；行内切只在极端包含关系下按切线收一下。
    if _rects_overlap(head, tail):
        if split_line is None:
            cut_y = round((max(head[1], tail[1]) + min(head[3], tail[3])) / 2, 6)
            head = (head[0], head[1], head[2], min(head[3], cut_y))
            tail = (tail[0], max(tail[1], cut_y), tail[2], tail[3])
        elif cut is not None:
            if _rect_contains(head, tail):
                head = (head[0], head[1], cut, head[3])
            elif _rect_contains(tail, head):
                tail = (cut, tail[1], tail[2], tail[3])
    return head, tail


def _block_text_lines(text: str) -> list[str]:
    return text.split("\n")


def _split_block_with_conn(
    conn,
    row,
    *,
    offset: int,
    now: str,
    batch_id: str,
    actor_name: str | None,
    head_block_type: str | None = None,
    tail_block_type: str | None = None,
    head_text: str | None = None,
    tail_text: str | None = None,
) -> tuple[str, str, list[Event]]:
    """在已打开的连接里把一块拆成两块，返回 （前块 id, 后块 id, 事件）。

    `head_text` / `tail_text` 只在"拆页码"时显式给出：那样可以把接缝处的空白
    去掉，而不必改动 `offset`（`offset` 仍然只用于切 `ocr_text`）。
    """
    text = row["text"] or ""
    if head_text is None or tail_text is None:
        if not 0 < offset < len(text):
            raise ProjectError(f"拆分位置必须在 0 与 {len(text)} 之间，收到 {offset}")
        head_text, tail_text = text[:offset], text[offset:]
    if not head_text or not tail_text:
        raise ProjectError("拆出来的两半都不能是空的")

    text_lines = _block_text_lines(text)
    cut_in_middle = not head_text.endswith("\n")
    whole_head_lines = head_text.count("\n")
    split_line = whole_head_lines if cut_in_middle else None
    lines = _lines_of(conn, row["block_id"])
    cut_line = None
    cut_line_text = ""
    ratio = None
    if split_line is not None:
        head_part = head_text.split("\n")[-1]
        cut_line = next(
            (line for line in lines if int(line["line_index"]) == split_line), None
        )
        # 优先用**行记录**自己的文字算比例：块文本可能被人工改过，
        # 只有"行记录确实以这一小段开头"时才按行切（否则退回 R4 的保守做法）
        if cut_line is not None:
            stored = cut_line["text"] or ""
            if stored.startswith(head_part):
                cut_line_text = stored
        if not cut_line_text:
            cut_line = None
        line_text = cut_line_text or (text_lines[split_line] if split_line < len(text_lines) else "")
        ratio = (len(head_part) / len(line_text)) if line_text else 0.5

    line_rects = [blocks_module.bbox_from_json(line["bbox"]) for line in lines]
    head_bbox, tail_bbox = _estimate_split_rects(
        blocks_module.bbox_from_json(row["bbox"]),
        line_rects,
        whole_head_lines=whole_head_lines,
        split_line=split_line,
        ratio=ratio,
    )

    head_fields: dict[str, object] = {
        "text": head_text,
        "ocr_text": _ocr_slice(row["ocr_text"], offset, head=True),
        "continues_to_next": 0,
    }
    head_bbox_json = (
        blocks_module.bbox_to_json(blocks_module.BBox(*head_bbox)) if head_bbox else None
    )
    if head_bbox_json != row["bbox"]:
        head_fields["bbox"] = head_bbox_json
    if head_block_type and head_block_type != row["block_type"]:
        head_fields["block_type"] = head_block_type

    events: list[Event] = []
    head_events, _ = _set_block_fields(
        conn,
        row["block_id"],
        head_fields,
        batch_id=batch_id,
        action=ACTION_SPLIT,
        actor_name=actor_name,
        now=now,
    )
    events.extend(head_events)

    # 后面的块整体后移一位，给新块腾出位置
    siblings = _page_blocks(conn, row["page_id"])
    index = next(i for i, item in enumerate(siblings) if item["block_id"] == row["block_id"])
    for shifted in siblings[index + 1 :]:
        shift_events, _ = _set_block_fields(
            conn,
            shifted["block_id"],
            {"order_index": int(shifted["order_index"]) + 1},
            batch_id=batch_id,
            action=ACTION_REORDER,
            actor_name=actor_name,
            now=now,
        )
        events.extend(shift_events)

    tail_bbox_json = (
        blocks_module.bbox_to_json(blocks_module.BBox(*tail_bbox)) if tail_bbox else None
    )
    new_block_id, new_events = _insert_block(
        conn,
        page_id=row["page_id"],
        origin="split",
        order_index=int(row["order_index"]) + 1,
        bbox=tail_bbox_json,
        text=tail_text,
        ocr_text=_ocr_slice(row["ocr_text"], offset, head=False),
        origin_run_id=row["origin_run_id"],
        include=int(row["include"]),
        continues_to_next=int(row["continues_to_next"]),
        block_type=tail_block_type or row["block_type"],
        action=ACTION_SPLIT,
        batch_id=batch_id,
        actor_name=actor_name,
        now=now,
    )
    events.extend(new_events)

    # 行分配：光标前的归前块、光标后的归后块；切在一行中间时，把那一行也切成两条
    # line 记录（前块拿左半、后块拿右半），两边用**同一个 cut 值**。
    # 旧行为（R4）是把被切开的行的坐标清空——批量拆 29 页就会多出 29 条"没有坐标"的行，
    # 行归属统计与导出的行级信息都会缺一块。
    head_line_count = whole_head_lines + (1 if cut_in_middle else 0)
    tail_offset = 0
    for line in lines:
        index_in_block = int(line["line_index"])
        if index_in_block < head_line_count:
            if index_in_block == head_line_count - 1 and cut_in_middle:
                tail_offset = 1 if _split_cut_line(
                    conn,
                    line,
                    new_block_id=new_block_id,
                    head_part=head_text.split("\n")[-1],
                    ratio=ratio,
                    now=now,
                    batch_id=batch_id,
                    actor_name=actor_name,
                    events=events,
                ) else 0
            continue
        new_index = index_in_block - head_line_count + tail_offset
        _apply_values(
            conn,
            "block_line",
            line["line_id"],
            {"block_id": new_block_id, "line_index": new_index},
            now,
        )
        events.append(
            _record(
                conn,
                entity_type="block_line",
                entity_id=line["line_id"],
                action=ACTION_MOVE_LINE,
                before={"block_id": row["block_id"], "line_index": index_in_block},
                after={"block_id": new_block_id, "line_index": new_index},
                batch_id=batch_id,
                actor_name=actor_name,
            )
        )
    return row["block_id"], new_block_id, events


def _split_cut_line(
    conn,
    line,
    *,
    new_block_id: str,
    head_part: str,
    ratio: float | None,
    now: str,
    batch_id: str,
    actor_name: str | None,
    events: list[Event],
) -> bool:
    """把"被切开的那一行"变成两条 line 记录；返回是否新建了后半条。

    - 前块那半：改这一行的文字与坐标（左半），分歧信息清空（它不再对应原来那一整行）；
    - 后块那半：新建一行（右半），**用同一个 cut 值**，所以两条记录在 x 上正好相接；
    - 行记录的文字与块文本对不上（块文本被人工改过）时**不切文字**，退回旧做法：
      只清坐标与分歧信息，免得把行记录改坏。
    """
    stored = line["text"] or ""
    bbox = blocks_module.bbox_from_json(line["bbox"])
    if not stored.startswith(head_part):
        values = {"bbox": None, "aux_text": None, "diff_status": None}
        before = {name: _column_value(line, name) for name in values}
        if before != values:
            _apply_values(conn, "block_line", line["line_id"], values, now)
            events.append(
                _record(
                    conn,
                    entity_type="block_line",
                    entity_id=line["line_id"],
                    action=ACTION_SPLIT,
                    before=before,
                    after=values,
                    batch_id=batch_id,
                    actor_name=actor_name,
                )
            )
        return False

    tail_part = stored[len(head_part) :]
    cut = _cut_x(bbox, ratio) if bbox is not None else None
    head_bbox = (bbox[0], bbox[1], cut, bbox[3]) if bbox is not None else None
    tail_bbox = (cut, bbox[1], bbox[2], bbox[3]) if bbox is not None else None
    head_values: dict[str, object] = {"text": head_part}
    if head_bbox is not None:
        head_values["bbox"] = blocks_module.bbox_to_json(blocks_module.BBox(*head_bbox))
    if line["aux_text"] is not None:
        head_values["aux_text"] = None
    if line["diff_status"] is not None:
        head_values["diff_status"] = None
    before = {name: _column_value(line, name) for name in head_values}
    if before != head_values:
        _apply_values(conn, "block_line", line["line_id"], head_values, now)
        events.append(
            _record(
                conn,
                entity_type="block_line",
                entity_id=line["line_id"],
                action=ACTION_SPLIT,
                before=before,
                after=head_values,
                batch_id=batch_id,
                actor_name=actor_name,
            )
        )
    if not tail_part:
        return False

    tail_line_id = new_ulid()
    tail_values: dict[str, object] = {
        "block_id": new_block_id,
        "line_index": 0,
        "text": tail_part,
        "bbox": (
            blocks_module.bbox_to_json(blocks_module.BBox(*tail_bbox))
            if tail_bbox is not None
            else None
        ),
        "aux_text": None,
        "diff_status": None,
        "layout_status": "assigned",
    }
    _insert_line(conn, tail_line_id, tail_values)
    events.append(
        _record(
            conn,
            entity_type="block_line",
            entity_id=tail_line_id,
            action=ACTION_CREATE_LINE,
            before={},
            after=tail_values,
            batch_id=batch_id,
            actor_name=actor_name,
        )
    )
    return True


def _insert_line(conn, line_id: str, values: dict) -> None:
    conn.execute(
        "INSERT INTO block_line (line_id, block_id, line_index, bbox, text, aux_text,"
        " diff_status, layout_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (
            line_id,
            values["block_id"],
            int(values["line_index"]),
            values.get("bbox"),
            values.get("text", ""),
            values.get("aux_text"),
            values.get("diff_status"),
            values.get("layout_status", "assigned"),
        ),
    )


def _ocr_slice(ocr: str | None, offset: int, *, head: bool) -> str:
    """按同一个 offset 切识别原文；长度对不上时按边界退让，不抛错。"""
    text = ocr or ""
    cut = max(0, min(int(offset), len(text)))
    return text[:cut] if head else text[cut:]


def split_block(
    project_id: str,
    block_id: str,
    *,
    library: Path | None = None,
    offset: int,
    actor_name: str | None = None,
) -> tuple[list[blocks_module.BlockRecord], list[Event]]:
    """在**文本的第 offset 个字符处**切开这一块（说明书 R4 / 6.4）。

    两块各自拿到自己的框（见本段开头的说明）：行按位置分配，切在一行中间时
    按字符比例估横向切线；被切开的**行**清空 bbox 与分歧信息（R4）。
    """
    if library is None:
        from .library import default_library_dir

        library = default_library_dir()
    directory = project_dir(library, project_id)
    now = _now()
    batch_id = new_ulid()

    with _open(directory) as conn:
        row = _block_of(conn, block_id)
        if row is None or row["deleted_at"]:
            raise ProjectError(f"找不到块：{block_id}")
        head_id, tail_id, events = _split_block_with_conn(
            conn,
            row,
            offset=offset,
            now=now,
            batch_id=batch_id,
            actor_name=actor_name,
        )
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()
        head = _read_block(conn, head_id)
        tail = _read_block(conn, tail_id)

    return [head, tail], events


@dataclass
class PageNumberSplitPlan:
    """一次"把页码拆出去"的计划（只描述，不写库）。"""

    offset: int
    head_text: str
    tail_text: str
    head_type: str
    tail_type: str
    number: str
    position: str  # "start"（页码在块首）/ "end"（页码在块尾）


def _page_number_split_plan(
    text: str,
    block_type: str,
    bbox,
    *,
    candidate_text: str | None = None,
) -> PageNumberSplitPlan | None:
    """算"把页码拆出去"要切在哪、两半各是什么类型；拆不了就返回 None。

    只收**紧贴块首或块尾**的候选（书眉的两种排法：`11 导读巴赫金` / `2谁是巴赫金?11`）。
    候选夹在中间（`第 11 章`、脚注 `1 这里采用的是…`）一律不动——切了会把正文拆坏。
    接缝处的空白会去掉；非空白字符一个都不动。
    """
    cleaned = text or ""
    if not cleaned.strip():
        return None
    candidates = regions_module.page_number_candidates(cleaned)
    if not candidates:
        return None

    # 只有"一边是空的、另一边有正文"的候选才是页码：两边都有字 = 夹在中间
    usable = []
    for item in candidates:
        before = cleaned[: item.start]
        after = cleaned[item.end :]
        if bool(before.strip()) == bool(after.strip()):
            continue
        usable.append((item, bool(before.strip())))
    if not usable:
        return None

    hint = regions_module.page_number_hint(candidates, bbox) if bbox else candidates[-1]
    chosen = next((entry for entry in usable if entry[0] is hint), None)
    if candidate_text:
        matched = [entry for entry in usable if entry[0].text == candidate_text]
        if matched:
            chosen = next((entry for entry in matched if entry[0] is hint), matched[-1])
    if chosen is None:
        chosen = usable[-1]
    number, at_end = chosen

    rest_type = block_type if block_type != "page_number" else "other"
    if at_end:
        head_text = cleaned[: number.start].rstrip()
        tail_text = cleaned[number.start : number.end].strip()
        if not head_text or not tail_text:
            return None
        return PageNumberSplitPlan(
            offset=number.start,
            head_text=head_text,
            tail_text=tail_text,
            head_type=block_type,
            tail_type="page_number",
            number=number.text,
            position="end",
        )
    head_text = cleaned[: number.end].strip()
    tail_text = cleaned[number.end :].lstrip()
    if not head_text or not tail_text:
        return None
    return PageNumberSplitPlan(
        offset=number.end,
        head_text=head_text,
        tail_text=tail_text,
        head_type="page_number",
        tail_type=rest_type,
        number=number.text,
        position="start",
    )


def split_off_page_number(
    project_id: str,
    block_id: str,
    *,
    library: Path | None = None,
    actor_name: str | None = None,
    candidate_text: str | None = None,
) -> tuple[list[blocks_module.BlockRecord], list[Event], dict]:
    """把这一块里（块首 / 块尾）的页码拆成独立的 `page_number` 块。

    只在用户点了按钮时执行（建议接口里的 `page_number_hint` 只是提示）。
    """
    if library is None:
        from .library import default_library_dir

        library = default_library_dir()
    directory = project_dir(library, project_id)
    now = _now()
    batch_id = new_ulid()

    with _open(directory) as conn:
        row = _block_of(conn, block_id)
        if row is None or row["deleted_at"]:
            raise ProjectError(f"找不到块：{block_id}")
        plan = _page_number_split_plan(
            row["text"] or "",
            row["block_type"],
            blocks_module.bbox_from_json(row["bbox"]),
            candidate_text=candidate_text,
        )
        if plan is None:
            raise ProjectError("这一块里没有可以拆出来的页码（或拆完会剩下空块）")
        head_id, tail_id, events = _split_block_with_conn(
            conn,
            row,
            offset=plan.offset,
            now=now,
            batch_id=batch_id,
            actor_name=actor_name,
            head_block_type=plan.head_type,
            tail_block_type=plan.tail_type,
            head_text=plan.head_text,
            tail_text=plan.tail_text,
        )
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()
        head = _read_block(conn, head_id)
        tail = _read_block(conn, tail_id)

    info = {
        "number": plan.number,
        "position": plan.position,
        "offset": plan.offset,
        "head_type": plan.head_type,
        "tail_type": plan.tail_type,
    }
    return [head, tail], events, info


# 拆页码时，"看起来不像书眉"的块要更严格：这些字符一出现，几乎肯定不是书眉
_SENTENCE_PUNCTUATION = "，。；：、,;:！？!?（）()“”\""
# 书眉 / 页脚通常很短；超过这个字数就不是一行书眉了
PAGE_NUMBER_MAX_CHARS = 40
# 去掉页码以后剩下的部分（书名 / 章名）也很短
PAGE_NUMBER_MAX_REST_CHARS = 30


def _batch_page_number_plans(blocks, *, page_count: int) -> list[dict]:
    """这一页里哪些块可以拆出页码（批量预览与执行共用同一套判断）。

    块类型已经是 header / footer / page_number 的，只要页码贴着块首 / 块尾就收；
    其余类型要同时满足：落在页面上下的 12% 带里、整块很短、去掉页码后剩下的部分
    没有句子标点、页码数值不超过全书页数。这样正文段落里的数字
    （"11 岁""2007 年出版"）不会被整本拆坏。
    """
    plans: list[dict] = []
    for block in blocks:
        if getattr(block, "deleted_at", None):
            continue
        bbox = block.bbox
        if bbox is None:
            continue
        typed = block.block_type in ("header", "footer", "page_number")
        if not typed:
            center = (bbox[1] + bbox[3]) / 2
            if not (center <= PAGE_NUMBER_BAND or center >= 1 - PAGE_NUMBER_BAND):
                continue
            text = (block.text or "").strip()
            if len(text) > PAGE_NUMBER_MAX_CHARS:
                continue
        plan = _page_number_split_plan(block.text or "", block.block_type, bbox)
        if plan is None:
            continue
        rest = plan.head_text if plan.position == "end" else plan.tail_text
        if not typed:
            if not any(char.isalnum() for char in rest):
                # 剩下只有一个 "/" 之类的标点：拆出来只是多一个空块
                continue
            if len(rest) > PAGE_NUMBER_MAX_REST_CHARS:
                continue
            if any(char in rest for char in _SENTENCE_PUNCTUATION):
                continue
            try:
                number_value = int(plan.number)
            except ValueError:
                number_value = None
            if number_value is not None and number_value > page_count:
                # "2007 年出版" 这种：页码不可能比全书页数还大
                continue
        plans.append({"block": block, "plan": plan, "bbox": bbox})
    return plans


def split_page_numbers_batch(
    project_id: str,
    page_numbers: list[int] | None = None,
    *,
    library: Path | None = None,
    dry_run: bool = True,
    actor_name: str | None = None,
) -> tuple[dict, list[Event]]:
    """批量把书眉 / 页脚里粘着的页码拆成 `page_number` 块（整批一个 batch）。

    `page_numbers` 为空 = 全部正文页。`dry_run=True` 只算不写，供预览。
    条件：块类型是 header / footer / page_number，**或**块落在页面上下的 12% 带里；
    并且页码候选紧贴块首 / 块尾。正文段落里的数字不动。
    """
    if library is None:
        from .library import default_library_dir

        library = default_library_dir()
    directory = project_dir(library, project_id)
    all_pages = project_library.list_pages(project_id, library=library)
    total_pages = len(all_pages)
    wanted = set(page_numbers or [])
    plans: list[dict] = []
    considered = 0
    skipped_context: list[int] = []

    for page in all_pages:
        if wanted:
            if page.page_no not in wanted:
                continue
        elif not page.include:
            # 没指定页码：只跑正文页（目录 / 前置 / 后置里的数字多半不是页码）
            continue
        if page.is_context:
            skipped_context.append(page.page_no)
            continue
        considered += 1
        blocks = blocks_module.list_blocks(project_id, library=library, page_no=page.page_no)
        for item in _batch_page_number_plans(blocks, page_count=total_pages):
            plans.append({"page_no": page.page_no, **item})

    result: dict[str, object] = {
        "dry_run": bool(dry_run),
        "pages": len({item["page_no"] for item in plans}),
        "blocks": len(plans),
        "pages_considered": considered,
        "skipped_context_pages": skipped_context,
        "items": [
            {
                "page_no": item["page_no"],
                "block_id": item["block"].block_id,
                "text": (item["block"].text or "")[:80],
                "number": item["plan"].number,
                "position": item["plan"].position,
                "block_type": item["block"].block_type,
                "head_type": item["plan"].head_type,
                "tail_type": item["plan"].tail_type,
            }
            for item in plans[:8]
        ],
    }
    if dry_run or not plans:
        return result, []

    now = _now()
    batch_id = new_ulid()
    events: list[Event] = []
    with _open(directory) as conn:
        # 从后往前做：新块插在后面，不会把还没处理的前面的块挤出顺序
        ordered = sorted(
            plans, key=lambda item: (item["page_no"], -int(item["block"].order_index))
        )
        for item in ordered:
            row = _block_of(conn, item["block"].block_id)
            if row is None or row["deleted_at"]:
                continue
            plan = item["plan"]
            _head, _tail, item_events = _split_block_with_conn(
                conn,
                row,
                offset=plan.offset,
                now=now,
                batch_id=batch_id,
                actor_name=actor_name,
                head_block_type=plan.head_type,
                tail_block_type=plan.tail_type,
                head_text=plan.head_text,
                tail_text=plan.tail_text,
            )
            events.extend(item_events)
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()

    result["dry_run"] = False
    result["events"] = len(events)
    result["pages_affected"] = sorted({item["page_no"] for item in plans})
    return result, events


def move_block(
    project_id: str,
    block_id: str,
    *,
    library: Path | None = None,
    direction: str,
    actor_name: str | None = None,
) -> tuple[blocks_module.BlockRecord, list[Event]]:
    """与相邻的一块交换位置（说明书 6.4 的上移 / 下移）。"""
    if direction not in ("up", "down"):
        raise ProjectError(f"未知的方向：{direction!r}")
    if library is None:
        from .library import default_library_dir

        library = default_library_dir()
    directory = project_dir(library, project_id)
    now = _now()
    batch_id = new_ulid()

    with _open(directory) as conn:
        row = _block_of(conn, block_id)
        if row is None or row["deleted_at"]:
            raise ProjectError(f"找不到块：{block_id}")
        siblings = _page_blocks(conn, row["page_id"])
        index = next(i for i, item in enumerate(siblings) if item["block_id"] == block_id)
        target_index = index - 1 if direction == "up" else index + 1
        if not 0 <= target_index < len(siblings):
            raise ProjectError("已经到头了，不能再移")

        other = siblings[target_index]
        events: list[Event] = []
        for source, target in ((row, other), (other, row)):
            source_events, _ = _set_block_fields(
                conn,
                source["block_id"],
                {"order_index": int(target["order_index"])},
                batch_id=batch_id,
                action=ACTION_REORDER,
                actor_name=actor_name,
                now=now,
            )
            events.extend(source_events)
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()
        moved = _read_block(conn, block_id)

    return moved, events


def create_block(
    project_id: str,
    page_no: int,
    *,
    library: Path | None = None,
    text: str = "",
    bbox: tuple[float, float, float, float] | None = None,
    after_block_id: str | None = None,
    actor_name: str | None = None,
) -> tuple[blocks_module.BlockRecord, list[Event]]:
    """新增一个块（说明书 6.4：可框选位置补全 bbox；不框选则"无位置信息"）。

    插入位置三种给法，按优先级：

    1. `after_block_id`：插在这一块后面（界面上的"在此块后新增"）；
    2. `bbox`：**按框选的竖直位置**插进阅读顺序（第六.4 的框选补 bbox——
       补救漏检区域，漏检的页眉就该插到最前面）；
    3. 都没有：追加到最后。

    人工新增的块 `ocr_text` 为空——它没有 OCR 原文，因此界面上的"已修改"标记恒真，
    这是如实的：它不是识别出来的东西。
    """
    if library is None:
        from .library import default_library_dir

        library = default_library_dir()
    if bbox is not None:
        bbox = _validate_bbox(bbox)
    directory = project_dir(library, project_id)
    now = _now()
    batch_id = new_ulid()

    with _open(directory) as conn:
        page = conn.execute("SELECT * FROM page WHERE page_no = ?", (page_no,)).fetchone()
        if page is None:
            raise ProjectError(f"没有第 {page_no} 页")
        siblings = _page_blocks(conn, page["page_id"])

        events: list[Event] = []
        if after_block_id:
            index = next(
                (i for i, item in enumerate(siblings) if item["block_id"] == after_block_id), None
            )
            if index is None:
                raise ProjectError(f"找不到块：{after_block_id}")
            order_index = int(siblings[index]["order_index"]) + 1
            events.extend(
                _shift_from(
                    conn,
                    page["page_id"],
                    order_index,
                    batch_id=batch_id,
                    actor_name=actor_name,
                    now=now,
                )
            )
        elif bbox is not None:
            order_index = _order_index_for_bbox(conn, page["page_id"], bbox)
            events.extend(
                _shift_from(
                    conn,
                    page["page_id"],
                    order_index,
                    batch_id=batch_id,
                    actor_name=actor_name,
                    now=now,
                )
            )
        else:
            order_index = (int(siblings[-1]["order_index"]) + 1) if siblings else 0

        block_id, create_events = _insert_block(
            conn,
            page_id=page["page_id"],
            origin="manual",
            order_index=order_index,
            bbox=blocks_module.bbox_to_json(blocks_module.BBox(*bbox)) if bbox else None,
            text=text,
            action=ACTION_CREATE,
            batch_id=batch_id,
            actor_name=actor_name,
            now=now,
        )
        events.extend(create_events)
        # 新框可能盖住了别人已有的行：按同一套规则重算归属（冲突 / 未归属照样记状态）
        if bbox is not None:
            events.extend(
                _reassign_page_lines(
                    conn,
                    page["page_id"],
                    batch_id=batch_id,
                    actor=ACTOR_USER,
                    actor_name=actor_name,
                    now=now,
                )
            )
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()
        created = _read_block(conn, block_id)

    return created, events


def _shift_from(
    conn, page_id: str, from_index: int, *, batch_id: str, actor_name: str | None, now: str
) -> list[Event]:
    """把 `order_index >= from_index` 的块整体后移一位，给新块腾出位置。"""
    events: list[Event] = []
    rows = conn.execute(
        """
        SELECT block_id, order_index FROM block
        WHERE page_id = ? AND deleted_at IS NULL AND order_index >= ?
        ORDER BY order_index DESC
        """,
        (page_id, from_index),
    ).fetchall()
    for row in rows:
        shift_events, _ = _set_block_fields(
            conn,
            row["block_id"],
            {"order_index": int(row["order_index"]) + 1},
            batch_id=batch_id,
            action=ACTION_REORDER,
            actor_name=actor_name,
            now=now,
        )
        events.extend(shift_events)
    return events


def _order_index_for_bbox(conn, page_id: str, bbox: tuple[float, float, float, float]) -> int:
    """框选出来的位置该插在阅读顺序的哪里。

    判据是**竖直位置**：比新框的顶边还靠上的块都排在前面（说明书 6.4 的框选补 bbox，
    多半是为了补救 OCR 漏检的区域——漏检的页眉就该插在最前面，漏掉的段落插在
    它该在的位置）。没有任何块比它靠上时插在 0；全都靠上时插在最后。
    """
    rows = conn.execute(
        """
        SELECT bbox, order_index FROM block
        WHERE page_id = ? AND deleted_at IS NULL
        ORDER BY order_index, block_id
        """,
        (page_id,),
    ).fetchall()
    new_top = bbox[1]
    index = 0
    for row in rows:
        index = int(row["order_index"]) + 1
        box = blocks_module.bbox_from_json(row["bbox"])
        if box is None or box[1] > new_top:
            # 无位置信息的块或已经比新框靠下的块：就插在它前面
            index = int(row["order_index"])
            break
    return index


def delete_block(
    project_id: str,
    block_id: str,
    *,
    library: Path | None = None,
    actor_name: str | None = None,
) -> tuple[list[Event], int]:
    """软删除一个块（说明书 5.1：删除一律软删除）。返回 (事件, 页码)。"""
    if library is None:
        from .library import default_library_dir

        library = default_library_dir()
    directory = project_dir(library, project_id)
    now = _now()
    batch_id = new_ulid()

    with _open(directory) as conn:
        row = _block_of(conn, block_id)
        if row is None or row["deleted_at"]:
            raise ProjectError(f"找不到块：{block_id}")
        events, _ = _set_block_fields(
            conn,
            block_id,
            {"deleted_at": now},
            batch_id=batch_id,
            action=ACTION_DELETE,
            actor_name=actor_name,
            now=now,
        )
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()
        page_no = int(row["page_no"])

    return events, page_no


# ---------------------------------------------------------------- 合并助手的审校结果（Phase 5）

ACTION_MERGE_REVIEW = "merge_review"


def apply_reviewer_changes(
    project_id: str,
    *,
    page_no: int,
    changes: list[tuple[str, dict]],
    reviewer_name: str,
    package_id: str | None = None,
    library: Path | None = None,
) -> list[Event]:
    """把一位助手的审校结果写进主项目（说明书 6.7.5 的"接受后的写入"）。

    `changes` 每项是 ``("update", {"block_id": …, 字段…})`` / ``("create", {块字段…})`` /
    ``("delete", {"block_id": …})``，由 `core/collab/merge.py` 算好（它负责"谁的什么变了"）。

    **每一处都是普通事件**：`actor='reviewer'`、`actor_name=助手名字`、`package_id` 已填，
    整批共享一个 `batch_id`（因此可以整体撤销）。助手确认过的块，合并后
    `review_status='confirmed'` 且 `reviewed_by=助手名字`——负责人可以按审校人抽查。
    """
    if library is None:
        from .library import default_library_dir

        library = default_library_dir()
    directory = project_dir(library, project_id)
    now = _now()
    batch_id = new_ulid()

    with _open(directory) as conn:
        page = _page_row(conn, page_no)
        if page is None:
            raise ProjectError(f"没有第 {page_no} 页")
        if page["is_context"]:
            raise ProjectError("只读上下文页不能合并（它本来就不该被修改）")

        events: list[Event] = []
        for operation, payload in changes:
            if operation == "update":
                block_id = str(payload["block_id"])
                values = {key: value for key, value in payload.items() if key != "block_id"}
                if values.get("review_status") == "confirmed":
                    values["reviewed_by"] = reviewer_name
                row = conn.execute(
                    "SELECT * FROM block WHERE block_id = ?", (block_id,)
                ).fetchone()
                if row is None or row["deleted_at"]:
                    # 负责人删掉了这一块：跳过（合并审阅视图里会把它标成冲突）
                    continue
                block_events, _before = _set_block_fields(
                    conn,
                    block_id,
                    values,
                    batch_id=batch_id,
                    action=ACTION_MERGE_REVIEW,
                    actor_name=reviewer_name,
                    now=now,
                )
                events.extend(block_events)
            elif operation == "create":
                block_id, created_events = _insert_block(
                    conn,
                    page_id=page["page_id"],
                    # origin 的取值受 block 表的 CHECK 限制（ocr/manual/split/merge），
                    # 助手新增的块在数据层就是"人工新增"；谁建的由事件的
                    # actor='reviewer' 与 package_id 记着（说明书 5.3 的协作字段）
                    origin="manual",
                    order_index=int(payload.get("order_index") or 0),
                    bbox=None,
                    text=payload.get("text") or "",
                    ocr_text=payload.get("ocr_text") or "",
                    block_type=payload.get("block_type") or "paragraph",
                    include=1 if payload.get("include", True) else 0,
                    continues_to_next=1 if payload.get("continues_to_next") else 0,
                    action=ACTION_MERGE_REVIEW,
                    batch_id=batch_id,
                    actor_name=reviewer_name,
                    now=now,
                    block_id=str(payload["block_id"]),
                )
                events.extend(created_events)
            elif operation == "delete":
                block_events, _before = _set_block_fields(
                    conn,
                    str(payload["block_id"]),
                    {"deleted_at": now},
                    batch_id=batch_id,
                    action=ACTION_MERGE_REVIEW,
                    actor_name=reviewer_name,
                    now=now,
                )
                events.extend(block_events)
            else:  # pragma: no cover - merge.py 只会给这三种
                raise ProjectError(f"不认识的合并操作：{operation!r}")

        # 来源标注（actor 与 package_id 是协作用的两列）
        for event in events:
            conn.execute(
                "UPDATE event SET actor = ?, package_id = ? WHERE event_id = ?",
                (ACTOR_REVIEWER, package_id, event.event_id),
            )
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()

    # 返回的事件带上协作信息，撤销栈与界面据此显示"来自 张三 的审校结果"
    return [
        replace_event(event, actor=ACTOR_REVIEWER, package_id=package_id) for event in events
    ]


def replace_event(event: Event, **changes) -> Event:
    """事件是不可变的 dataclass，改几个字段时用它（别处也用它做"补写来源"）。"""
    from dataclasses import replace

    return replace(event, **changes)


# ---------------------------------------------------------------- 采用 / 保留新识别结果（R2）

ACTION_APPLY_RUN = "apply_run"
ACTION_DECLINE_RUN = "decline_run"


def _page_row(conn, page_no: int):
    return conn.execute("SELECT * FROM page WHERE page_no = ?", (page_no,)).fetchone()


def _set_entity_fields(
    conn,
    entity_type: str,
    entity_id: str,
    values: dict,
    *,
    batch_id: str,
    action: str,
    actor_name: str | None,
    now: str,
    extra_after: dict | None = None,
) -> tuple[list[Event], dict]:
    """改任意实体的若干字段并记事件（块以外的实体也能进事件表）。"""
    row = _entity_row(conn, entity_type, entity_id)
    before = {name: _column_value(row, name) for name in values}
    _apply_values(conn, entity_type, entity_id, values, now)
    after = {**values, **(extra_after or {})}
    return [
        _record(
            conn,
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            before=before,
            after=after,
            batch_id=batch_id,
            actor_name=actor_name,
        )
    ], before


def _insert_run_lines(
    conn, block_id: str, line_indexes: list[int], lines: list[dict], now: str
) -> int:
    """把一次运行的**行记录**补进新块（说明书 5.3 的 BlockLine）。

    **为什么必须有这一步**（2026-10-14 发现）：采用新结果原先只重建了块、没有行，
    于是那一页从此没有行级坐标——第二引擎复核会直接拒绝它（"这一页没有可复核的行"），
    按行比对、分歧标记也就此断掉。行框来自那次运行的原始输出，与块是同一份结果。

    行号在块内重新从 0 编号（`line_index` 是块内阅读顺序）。
    """
    inserted = 0
    for order, source_index in enumerate(line_indexes):
        if not 0 <= source_index < len(lines):
            continue
        line = lines[source_index]
        bbox = line.get("bbox")
        conn.execute(
            """
            INSERT INTO block_line (line_id, block_id, line_index, bbox, text)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                new_ulid(),
                block_id,
                order,
                blocks_module.bbox_to_json(blocks_module.BBox(*bbox)) if bbox else None,
                str(line.get("text") or ""),
            ),
        )
        inserted += 1
    return inserted


def _insert_run_block(
    conn,
    *,
    page_id: str,
    run_id: str,
    item: dict,
    lines: list[dict],
    order_index: int,
    action: str,
    batch_id: str,
    actor_name: str | None,
    now: str,
) -> tuple[str, list[Event]]:
    """按一次运行的输出新增块（含它的行记录）。采用整页与逐块采用共用这一处。"""
    bbox = item.get("bbox")
    block_id, events = _insert_block(
        conn,
        page_id=page_id,
        origin="ocr",
        order_index=order_index,
        bbox=blocks_module.bbox_to_json(blocks_module.BBox(*bbox)) if bbox else None,
        text=item.get("text") or "",
        ocr_text=item.get("text") or "",
        block_type=item.get("block_type") or "paragraph",
        origin_run_id=run_id,
        action=action,
        batch_id=batch_id,
        actor_name=actor_name,
        now=now,
    )
    _insert_run_lines(conn, block_id, list(item.get("line_indexes") or []), lines, now)
    return block_id, events


def adopt_run_block(
    project_id: str,
    page_no: int,
    run_id: str,
    *,
    candidate_index: int,
    target_block_id: str | None = None,
    library: Path | None = None,
    actor_name: str | None = None,
) -> tuple[blocks_module.BlockRecord, list[Event]]:
    """**逐块**采用某一次运行的结果（说明书 6.4 的两版对比，R2 的整页采用之外的补充）。

    整页采用（`adopt_run`）是"要么全换、要么全不换"；但真实情况常常是**取长补短**：
    这一版这三块更好、那两块反而更差。这个函数只换**一块**——

    1. 目标块（没有显式给就按 bbox 重叠配，配不上按序号）软删除；
    2. 把那一次运行里对应的块按原样插回来（含行记录），**沿用目标块的位置**，
       因此阅读顺序不变、其余块一个不动；
    3. 整件事一个 batch，可以撤销；撤销之后目标块回来、新块消失。

    配不上任何现有块的候选块（那次运行多出来的块）会**插进阅读顺序**里合适的位置。
    """
    if library is None:
        from .library import default_library_dir

        library = default_library_dir()
    directory = project_dir(library, project_id)
    now = _now()
    batch_id = new_ulid()

    with _open(directory) as conn:
        page = _page_row(conn, page_no)
        if page is None:
            raise ProjectError(f"没有第 {page_no} 页")
        run = blocks_module.run_of_page(conn, run_id, page["page_id"])
        if run is None:
            raise ProjectError(f"这一页没有这次运行：{run_id}")
        if run.status != "succeeded":
            raise ProjectError("只有成功的运行才能采用")

        payload = recognition.read_run_result(directory, run)
        candidates = payload["blocks"]
        if not 0 <= candidate_index < len(candidates):
            raise ProjectError(f"这份结果里没有第 {candidate_index + 1} 块")
        item = candidates[candidate_index]

        siblings = _page_blocks(conn, page["page_id"])
        target = None
        if target_block_id:
            target = next(
                (row for row in siblings if row["block_id"] == target_block_id), None
            )
            if target is None:
                raise ProjectError(f"这一页没有这个块：{target_block_id}")
        else:
            match = blocks_module.match_candidate_blocks(
                [blocks_module.row_to_block(row) for row in siblings], [item]
            )[0]
            if match["target_block_id"]:
                target = next(
                    row for row in siblings if row["block_id"] == match["target_block_id"]
                )

        events: list[Event] = []
        if target is not None:
            # 沿用目标块的位置：它让出来的 order_index 正好给新块
            order_index = int(target["order_index"])
            delete_events, _ = _set_block_fields(
                conn,
                target["block_id"],
                {"deleted_at": now},
                batch_id=batch_id,
                action=ACTION_DELETE,
                actor_name=actor_name,
                now=now,
            )
            events.extend(delete_events)
        else:
            box = item.get("bbox")
            order_index = (
                _order_index_for_bbox(conn, page["page_id"], tuple(box)) if box else len(siblings)
            )
            events.extend(
                _shift_from(
                    conn,
                    page["page_id"],
                    order_index,
                    batch_id=batch_id,
                    actor_name=actor_name,
                    now=now,
                )
            )

        block_id, created_events = _insert_run_block(
            conn,
            page_id=page["page_id"],
            run_id=run_id,
            item=item,
            lines=payload["lines"],
            order_index=order_index,
            action=ACTION_APPLY_RUN,
            batch_id=batch_id,
            actor_name=actor_name,
            now=now,
        )
        events.extend(created_events)

        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()
        created = _read_block(conn, block_id)

    return created, events


def adopt_run(
    project_id: str,
    page_no: int,
    run_id: str,
    *,
    library: Path | None = None,
    actor_name: str | None = None,
) -> tuple[list[blocks_module.BlockRecord], list[Event]]:
    """采用某一次运行的结果（说明书 R2）。

    R2 的原话："选择'采用新结果'（旧块软删除，可撤销）"——因此这里做三件事，
    **每一件都是普通事件**，连"换 active run"都能撤销：

    1. 旧块软删除；
    2. 按那份结果的**分段**重建块（`ocr_runs/<run_id>.json` 里存着用户对比过的那一份）；
    3. `page.active_run_id` 指向这次运行。

    **行记录也一起重建**（2026-10-14 补）：原先只重建块，导致采用之后那一页没有行级坐标，
    第二引擎复核会拒绝它（"这一页没有可复核的行"）。行框来自这次运行的原始输出。
    """
    if library is None:
        from .library import default_library_dir

        library = default_library_dir()
    directory = project_dir(library, project_id)
    now = _now()
    batch_id = new_ulid()

    with _open(directory) as conn:
        page = _page_row(conn, page_no)
        if page is None:
            raise ProjectError(f"没有第 {page_no} 页")
        run = blocks_module.run_of_page(conn, run_id, page["page_id"])
        if run is None:
            raise ProjectError(f"这一页没有这次运行：{run_id}")
        if run.status != "succeeded":
            raise ProjectError("只有成功的运行才能采用")

        payload = recognition.read_run_result(directory, run)

        events: list[Event] = []
        for row in _page_blocks(conn, page["page_id"]):
            block_events, _ = _set_block_fields(
                conn,
                row["block_id"],
                {"deleted_at": now},
                batch_id=batch_id,
                action=ACTION_DELETE,
                actor_name=actor_name,
                now=now,
            )
            events.extend(block_events)

        for item in payload["blocks"]:
            _, created_events = _insert_run_block(
                conn,
                page_id=page["page_id"],
                run_id=run_id,
                item=item,
                lines=payload["lines"],
                order_index=int(item["order_index"]),
                action=ACTION_APPLY_RUN,
                batch_id=batch_id,
                actor_name=actor_name,
                now=now,
            )
            events.extend(created_events)

        page_events, _ = _set_entity_fields(
            conn,
            "page",
            page["page_id"],
            {"active_run_id": run_id},
            batch_id=batch_id,
            action=ACTION_APPLY_RUN,
            actor_name=actor_name,
            now=now,
        )
        events.extend(page_events)

        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()
        blocks = [
            blocks_module.row_to_block(row) for row in _page_blocks(conn, page["page_id"])
        ]
    return blocks, events


def decline_run(
    project_id: str,
    page_no: int,
    run_id: str,
    *,
    library: Path | None = None,
    actor_name: str | None = None,
) -> list[Event]:
    """保留现有（说明书 R2 的"保留现有"）：**不动块**，只记一条决定。

    这条决定不是摆设：`blocks.page_recognition_states` 把"候选"定义为
    **比最近一次决定更新的**成功运行，否则"保留现有"之后提示会一直挂着、关不掉。
    """
    if library is None:
        from .library import default_library_dir

        library = default_library_dir()
    directory = project_dir(library, project_id)
    now = _now()

    with _open(directory) as conn:
        page = _page_row(conn, page_no)
        if page is None:
            raise ProjectError(f"没有第 {page_no} 页")
        run = blocks_module.run_of_page(conn, run_id, page["page_id"])
        if run is None:
            raise ProjectError(f"这一页没有这次运行：{run_id}")

        events = [
            _record(
                conn,
                entity_type="page",
                entity_id=page["page_id"],
                action=ACTION_DECLINE_RUN,
                before={"active_run_id": page["active_run_id"]},
                after={
                    "active_run_id": page["active_run_id"],
                    "decision": "declined",
                    "run_id": run_id,
                },
                batch_id=new_ulid(),
                actor_name=actor_name,
            )
        ]
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()
    return events


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

    事件可以作用在**块**或**块内行**上（`entity_type` 决定写哪张表）——
    合并 / 拆分要搬行、要清掉被切开的行的坐标，那些改动同样得能撤销。

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
            if event.action in (ACTION_CREATE_LINE, ACTION_DELETE_LINE):
                # 拆分时新建的那条行记录：撤销 = 删掉、重做 = 插回去。
                # 它不像块的软删除那样有 `deleted_at` 可以来回写，所以单独处理；
                # 行记录不存在时插入、存在时删除，两个方向都是幂等的。
                present = (
                    conn.execute(
                        "SELECT 1 FROM block_line WHERE line_id = ?", (event.entity_id,)
                    ).fetchone()
                    is not None
                )
                want_present = (event.action == ACTION_CREATE_LINE) == (direction == "redo")
                if want_present and not present:
                    values = event.after if event.action == ACTION_CREATE_LINE else event.before
                    _insert_line(conn, event.entity_id, values)
                    block_row = conn.execute(
                        "SELECT p.page_no FROM block b JOIN page p ON p.page_id = b.page_id"
                        " WHERE b.block_id = ?",
                        (values["block_id"],),
                    ).fetchone()
                    if block_row is not None and block_row["page_no"] is not None:
                        pages.add(int(block_row["page_no"]))
                    new_events.append(
                        _record(
                            conn,
                            entity_type="block_line",
                            entity_id=event.entity_id,
                            action=ACTION_CREATE_LINE,
                            before={},
                            after=dict(values),
                            batch_id=event.batch_id,
                            actor=event.actor,
                            actor_name=actor_name,
                        )
                    )
                elif not want_present and present:
                    row = conn.execute(
                        "SELECT * FROM block_line WHERE line_id = ?", (event.entity_id,)
                    ).fetchone()
                    block_row = conn.execute(
                        "SELECT p.page_no FROM block b JOIN page p ON p.page_id = b.page_id"
                        " WHERE b.block_id = ?",
                        (row["block_id"],),
                    ).fetchone()
                    if block_row is not None and block_row["page_no"] is not None:
                        pages.add(int(block_row["page_no"]))
                    values = {
                        name: row[name]
                        for name in (
                            "block_id",
                            "line_index",
                            "bbox",
                            "text",
                            "aux_text",
                            "diff_status",
                            "layout_status",
                        )
                        if name in row.keys()
                    }
                    conn.execute("DELETE FROM block_line WHERE line_id = ?", (event.entity_id,))
                    new_events.append(
                        _record(
                            conn,
                            entity_type="block_line",
                            entity_id=event.entity_id,
                            action=ACTION_DELETE_LINE,
                            before=values,
                            after={},
                            batch_id=event.batch_id,
                            actor=event.actor,
                            actor_name=actor_name,
                        )
                    )
                continue
            values = event.before if direction == "undo" else event.after
            if not values:
                continue
            row = _entity_row(conn, event.entity_type, event.entity_id)
            if row is None:
                # 行已经不在了（例如块被硬删、或行随块一起清理过）：
                # 跳过而不是整批失败——撤销一份被改动的成果，不该因为边上少了一行就全停
                continue
            if row["page_no"] is not None:
                pages.add(int(row["page_no"]))

            before = {name: _column_value(row, name) for name in values}
            if not _apply_values(conn, event.entity_type, event.entity_id, values, now):
                continue
            new_events.append(
                _record(
                    conn,
                    entity_type=event.entity_type,
                    entity_id=event.entity_id,
                    action=event.action,
                    before=before,
                    after=dict(values),
                    batch_id=event.batch_id,
                    # 撤销沿用原来那批的 actor：撤销一次"批量标注"，它仍然是系统的改动
                    actor=event.actor,
                    actor_name=actor_name,
                )
            )
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()

    return new_events, pages
