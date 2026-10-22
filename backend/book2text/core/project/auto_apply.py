"""识别完成后**自动应用**高把握的块类型建议（项目级开关，默认关）。

**为什么这不算"静默应用"：**

1. 它是用户在项目里**预先授权**的开关（`project.settings_json` 的
   `auto_apply_high_suggestions`），默认关闭；关着时行为与以前完全一样（只建议）。
2. 只应用 `high`（把握较大）的建议：页码形态、跨页重复 ≥ 3 次的书眉 / 页脚。
   `review`（需确认）与标题永远不动。
3. 每次自动应用都落一条 `auto_apply_run`，界面顶部有提示条，
   可以一键撤销**整批**（撤销走 `editing.revert_events`，与手工撤销同一套）。

**为什么放在子进程里做：** 识别跑在子进程（`worker`），只有它真正知道"这一页做完了"。
放在 API 轮询里做会依赖"浏览器每隔 1.2 秒问一次"——用户关掉页面就不会应用了，
那不是"服务端自动应用"。子进程写的事件本来就在 `event` 表里（带 batch_id），
API 撤销时按 batch_id 把事件捞回来即可，不需要把撤销栈搬到子进程。
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from ..storage import db as db_module
from ..storage.ulid import new_ulid
from . import editing
from . import library as project_library
from . import structure

SETTING_KEY = "auto_apply_high_suggestions"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def enabled(project_id: str, *, library: Path | None = None) -> bool:
    """这个项目是否打开了"识别完成后自动应用"。坏掉的设置按关闭处理。"""
    try:
        settings = project_library.get_settings(project_id, library=library)
    except project_library.ProjectError:
        return False
    return bool(settings.get(SETTING_KEY))


def apply_for_job(
    directory: Path,
    job_id: str,
    page_numbers: list[int] | tuple[int, ...],
    *,
    actor_name: str | None = None,
) -> dict[str, object] | None:
    """本任务认完的页里，有高把握建议就一次应用掉并记一条 `auto_apply_run`。

    返回这一批的摘要；没有可应用的块时返回 None（不写记录、不留空批次）。
    """
    project_id = directory.name
    library = directory.parent
    wanted = sorted({int(page_no) for page_no in page_numbers if page_no})
    if not wanted:
        return None
    plan = structure.scan_high_suggestions(
        project_id, library=library, page_numbers=wanted
    )
    if not plan.items:
        return None

    auto_apply_id = new_ulid()
    events, by_type, pages = editing.apply_block_types(
        project_id,
        [(block_id, block_type) for block_id, block_type, _ in plan.items],
        library=library,
        batch_id=auto_apply_id,
        actor_name=actor_name,
        actor=editing.ACTOR_SYSTEM,
    )
    if not events:
        return None

    now = _now()
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            """
            INSERT INTO auto_apply_run (
                auto_apply_id, job_id, status, pages, blocks, by_type_json, created_at
            ) VALUES (?, ?, 'applied', ?, ?, ?, ?)
            """,
            (
                auto_apply_id,
                job_id,
                len(pages),
                len(events),
                json.dumps(by_type, ensure_ascii=False),
                now,
            ),
        )
        conn.commit()

    return {
        "auto_apply_id": auto_apply_id,
        "job_id": job_id,
        "status": "applied",
        "pages": len(pages),
        "blocks": len(events),
        "by_type": by_type,
        "created_at": now,
    }


def _row_to_run(row) -> dict[str, object]:
    return {
        "auto_apply_id": row["auto_apply_id"],
        "job_id": row["job_id"],
        "status": row["status"],
        "pages": int(row["pages"]),
        "blocks": int(row["blocks"]),
        "by_type": json.loads(row["by_type_json"] or "{}"),
        "created_at": row["created_at"],
        "undone_at": row["undone_at"],
    }


def latest_run(directory: Path) -> dict[str, object] | None:
    """最近一条自动应用记录（含已撤销的，界面据此显示"已撤销"）。"""
    with db_module.open_database(directory, apply_migrations=False) as conn:
        row = conn.execute(
            "SELECT * FROM auto_apply_run ORDER BY created_at DESC, rowid DESC LIMIT 1"
        ).fetchone()
    return _row_to_run(row) if row else None


def load_events(directory: Path, batch_id: str) -> list[editing.Event]:
    """按 batch 把事件从库里读回来（自动应用发生在子进程，撤销在 API 进程）。"""
    with db_module.open_database(directory, apply_migrations=False) as conn:
        rows = conn.execute(
            "SELECT * FROM event WHERE batch_id = ? ORDER BY created_at, rowid",
            (batch_id,),
        ).fetchall()
    return [
        editing.Event(
            event_id=row["event_id"],
            batch_id=row["batch_id"],
            entity_type=row["entity_type"],
            entity_id=row["entity_id"],
            action=row["action"],
            before=json.loads(row["before_json"] or "{}"),
            after=json.loads(row["after_json"] or "{}"),
            actor=row["actor"],
            actor_name=row["actor_name"],
            created_at=row["created_at"],
            package_id=row["package_id"],
        )
        for row in rows
    ]


class AutoApplyError(project_library.ProjectError):
    """撤销自动应用时的可预期错误（已撤销 / 之后又有别的修改）。"""


def undo_run(
    directory: Path,
    auto_apply_id: str,
    *,
    actor_name: str | None = None,
) -> dict[str, object]:
    """撤销一次自动应用（整批）。只允许撤销**最近一次**、且之后没有别的修改。

    自动应用发生在子进程，不在 API 的撤销栈里，所以这里按 batch 从 `event` 表
    把事件读回来再反过来应用。为防止覆盖用户后来的修改：这一批之后只要还有
    别的批次写过事件，就拒绝撤销，让用户先把后面的改完。
    """
    project_id = directory.name
    library = directory.parent
    with db_module.open_database(directory, apply_migrations=False) as conn:
        row = conn.execute(
            "SELECT * FROM auto_apply_run WHERE auto_apply_id = ?", (auto_apply_id,)
        ).fetchone()
        if row is None:
            raise AutoApplyError("没有这次自动应用的记录")
        if row["status"] == "undone":
            raise AutoApplyError("这次自动应用已经撤销过了")
        # 用 rowid 而不是 created_at 判断"之后有没有别的修改"：`created_at` 只有秒精度，
        # 同一秒内的手工修改会漏掉（测试里一秒跑完，真人也可能手快）。
        last_rowid = conn.execute(
            "SELECT MAX(rowid) AS m FROM event WHERE batch_id = ?", (auto_apply_id,)
        ).fetchone()["m"]
        later = conn.execute(
            "SELECT COUNT(*) AS n FROM event WHERE rowid > ? AND batch_id <> ?",
            (int(last_rowid or 0), auto_apply_id),
        ).fetchone()
        if int(later["n"]) > 0:
            raise AutoApplyError(
                "自动应用之后还有别的修改，先撤销那些再撤销这次自动应用"
            )

    events = load_events(directory, auto_apply_id)
    if not events:
        raise AutoApplyError("这次自动应用没有留下可撤销的记录")
    new_events, pages = editing.revert_events(
        project_id, events, library=library, direction="undo", actor_name=actor_name
    )
    now = _now()
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE auto_apply_run SET status = 'undone', undone_at = ?"
            " WHERE auto_apply_id = ?",
            (now, auto_apply_id),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM auto_apply_run WHERE auto_apply_id = ?", (auto_apply_id,)
        ).fetchone()
    result = _row_to_run(row)
    result["reverted_events"] = len(new_events)
    result["pages_affected"] = sorted(pages)
    return result
