"""结果包导入与合并（说明书 6.7.5）。

**导入校验**（不通过就拒绝，并把原因说清楚）：

1. `project_id` 与 `source_sha256` 必须与主项目一致；
2. `package_id` 必须对应主项目里的一个 Assignment；**已作废**的要负责人明确确认才能继续
   （`allow_cancelled=True`）；
3. `seq` 不大于已导入的序号时，提示"这是较早的结果"，默认不处理（`allow_older=True` 才继续）。

**逐页分类**（以分派时的基准快照为参照）：

- **无变化**：助手没改这一页 → 不显示；
- **块级变化**：只有文本 / 状态 / 类型 / 纳入 / 备注 / 延续变了 → 可逐块接受或拒绝；
- **结构变化**：有块的增删、合并、拆分、重排 → **整页**接受或拒绝（块之间相互依赖）；
- **冲突**：分派后负责人自己也动了同一块（块级）或同一页的任何块（结构变化时）——
  必须单独处理（保留我的 / 采用助手的）。

**接受的写入**走 `editing.apply_reviewer_changes()`：一次导入一个 batch，事件
`actor='reviewer'`、`actor_name=助手名字`、`package_id` 已填，整批可撤销。
被拒绝的**不写入**主项目，但结果包原样留在 `assignments/<id>/results/<seq>-<原名>`，
随时能回看。

**分类为什么这么算：** 助手改了什么 = 结果包与**快照**比；负责人改了什么 = 主项目当前
与**快照**比。两边都动过的块就是冲突——这正是"分派时的基准快照"存在的理由。
"""

from __future__ import annotations

import json
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ..storage import db as db_module
from . import assignments as assignments_module
from ..project import blocks as blocks_module
from ..project import editing
from ..project import library as library_module
from ..project.library import ProjectError, default_library_dir, project_dir

RESULT_SCHEMA = "book2text.result.v1"
RESULTS_DIR_NAME = "results"

KIND_NO_CHANGE = "no_change"
KIND_BLOCK_LEVEL = "block_level"
KIND_STRUCTURAL = "structural"
KIND_CONFLICT = "conflict"

KIND_LABELS = {
    KIND_NO_CHANGE: "无变化",
    KIND_BLOCK_LEVEL: "块级修改",
    KIND_STRUCTURAL: "结构变化",
    KIND_CONFLICT: "冲突",
}

DECISION_ACCEPT = "accept"
DECISION_REJECT = "reject"
DECISION_KEEP_MINE = "keep_mine"

# 块级变化里"哪些字段变了"
BLOCK_FIELDS = (
    "text",
    "review_status",
    "block_type",
    "include",
    "continues_to_next",
    "comment",
)

FIELD_LABELS = {
    "text": "文本",
    "review_status": "状态",
    "block_type": "类型",
    "include": "纳入",
    "continues_to_next": "延续下页",
    "comment": "备注",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------- 读结果包

def read_result(path: Path) -> tuple[dict, dict, dict]:
    """读一个 `.b2tres`，返回 `(result.json, events.json, summary.json)`。"""
    if not path.is_file():
        raise ProjectError(f"找不到结果包：{path}")
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            missing = {"result.json", "summary.json"} - names
            if missing:
                raise ProjectError(f"结果包缺少文件：{'、'.join(sorted(missing))}")
            result = json.loads(archive.read("result.json"))
            summary = json.loads(archive.read("summary.json"))
            events = json.loads(archive.read("events.json")) if "events.json" in names else {}
    except zipfile.BadZipFile as exc:
        raise ProjectError("这不是一个结果包（zip 读不开）") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise ProjectError(f"结果包读不出来：{exc}") from exc
    if result.get("schema") != RESULT_SCHEMA:
        raise ProjectError(f"结果包格式不认识的版本：{result.get('schema')}")
    return result, events, summary


# ---------------------------------------------------------------- 差异

@dataclass(frozen=True)
class BlockChange:
    block_id: str
    fields: dict[str, dict[str, object]]
    conflict: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "block_id": self.block_id,
            "fields": self.fields,
            "conflict": self.conflict,
            # 字段名 → 中文标签（界面按字段名取值显示）
            "field_labels": {name: FIELD_LABELS.get(name, name) for name in self.fields},
        }


@dataclass(frozen=True)
class PageDiff:
    page_id: str
    page_no: int
    kind: str
    block_changes: tuple[BlockChange, ...]
    added_blocks: tuple[dict, ...]
    removed_blocks: tuple[str, ...]
    reordered: bool
    comment_count: int

    @property
    def changed_blocks(self) -> int:
        return len(self.block_changes) + len(self.added_blocks) + len(self.removed_blocks)

    @property
    def has_conflict(self) -> bool:
        return self.kind == KIND_CONFLICT

    def to_dict(self) -> dict[str, object]:
        return {
            "page_id": self.page_id,
            "page_no": self.page_no,
            "kind": self.kind,
            "kind_label": KIND_LABELS.get(self.kind, self.kind),
            "changed_blocks": self.changed_blocks,
            "block_changes": [change.to_dict() for change in self.block_changes],
            "added_blocks": list(self.added_blocks),
            "removed_blocks": list(self.removed_blocks),
            "reordered": self.reordered,
            "comment_count": self.comment_count,
            "conflict": self.has_conflict,
            "accept_scope": "page" if self.kind in (KIND_STRUCTURAL, KIND_CONFLICT) else "block",
        }


def _same(field: str, left, right) -> bool:
    """两个值算不算"没变"（纳入 / 延续是布尔，其余按字符串比）。"""
    if field in ("include", "continues_to_next"):
        return bool(left) == bool(right)
    return (left or "") == (right or "")


def diff_page(
    *,
    snapshot_page: dict,
    snapshot_blocks: dict[str, dict],
    current_blocks: list[blocks_module.BlockRecord],
    their_blocks: list[dict],
) -> PageDiff:
    """一页的差异：助手改了什么、负责人改了什么、算哪一类。"""
    page_id = snapshot_page["page_id"]
    page_block_ids = {block["block_id"] for block in snapshot_page.get("blocks") or []}
    current_by_id = {block.block_id: block for block in current_blocks}
    theirs_by_id = {block["block_id"]: block for block in their_blocks}

    changes: list[BlockChange] = []
    added: list[dict] = []
    comments = 0

    for block_id, theirs in theirs_by_id.items():
        base = snapshot_blocks.get(block_id)
        mine = current_by_id.get(block_id)
        if base is None:
            if mine is not None and not any(
                not _same(field, theirs.get(field), getattr(mine, field))
                for field in BLOCK_FIELDS
            ):
                continue
            added.append(
                {
                    "block_id": block_id,
                    "order_index": theirs.get("order_index"),
                    "text": theirs.get("text") or "",
                    "review_status": theirs.get("review_status"),
                    "comment": theirs.get("comment"),
                }
            )
            continue
        fields: dict[str, dict[str, object]] = {}
        mine = current_by_id.get(block_id)
        for field in BLOCK_FIELDS:
            theirs_value = theirs.get(field)
            base_value = base.get(field)
            mine_value = getattr(mine, field) if mine is not None else None
            if _same(field, theirs_value, base_value):
                continue
            # 已经合并过的变化不再显示（说明书 6.7.1："每次导入只处理尚未合并的变化"）
            if mine is not None and _same(field, theirs_value, mine_value):
                continue
            # 与快照比：负责人自己也动过这个字段吗？
            owner_changed = mine is None or not _same(field, mine_value, base_value)
            fields[field] = {
                "mine": mine_value,
                "snapshot": base_value,
                "theirs": theirs_value,
                "owner_changed": owner_changed,
            }
            if field == "comment" and theirs_value:
                comments += 1
        if fields:
            changes.append(
                BlockChange(
                    block_id=block_id,
                    fields=fields,
                    conflict=any(item["owner_changed"] for item in fields.values()),
                )
            )

    removed = [
        block_id
        for block_id in page_block_ids
        if block_id not in theirs_by_id and block_id in current_by_id
    ]

    # 顺序变化：只看两边都有的块
    theirs_order = {
        block_id: int((theirs_by_id[block_id].get("order_index") or 0))
        for block_id in page_block_ids
        if block_id in theirs_by_id
    }
    base_order = {
        block["block_id"]: int(block.get("order_index") or 0)
        for block in snapshot_page.get("blocks") or []
        if block["block_id"] in theirs_by_id
    }
    reordered = False
    if theirs_order:
        reordered = sorted(base_order, key=lambda item: base_order[item]) != sorted(
            theirs_order, key=lambda item: theirs_order[item]
        )

    # 负责人动过这一页吗（结构变化时按整页算冲突）
    owner_touched = any(
        block.block_id in page_block_ids
        and block.revision != int(snapshot_blocks.get(block.block_id, {}).get("revision") or 0)
        for block in current_blocks
    )
    owner_deleted = any(block_id not in current_by_id for block_id in page_block_ids)
    conflicted = any(change.conflict for change in changes) or owner_deleted

    if not (changes or added or removed or reordered):
        kind = KIND_NO_CHANGE
    elif added or removed or reordered:
        kind = KIND_CONFLICT if (owner_touched or conflicted) else KIND_STRUCTURAL
    else:
        kind = KIND_CONFLICT if conflicted else KIND_BLOCK_LEVEL

    return PageDiff(
        page_id=page_id,
        page_no=int(snapshot_page["page_no"]),
        kind=kind,
        block_changes=tuple(changes),
        added_blocks=tuple(added),
        removed_blocks=tuple(removed),
        reordered=reordered,
        comment_count=comments,
    )


# ---------------------------------------------------------------- 导入

@dataclass(frozen=True)
class MergeState:
    assignment: assignments_module.Assignment
    seq: int
    reviewer_name: str
    summary: dict
    pages: tuple[PageDiff, ...]
    result_name: str

    @property
    def changed_pages(self) -> tuple[PageDiff, ...]:
        return tuple(page for page in self.pages if page.kind != KIND_NO_CHANGE)

    def to_dict(self) -> dict[str, object]:
        changed = self.changed_pages
        return {
            "assignment": self.assignment.to_dict(),
            # 页 id 在 assignment 里，页码在快照里；界面显示"第 N 页"要的是页码
            "page_nos": [page.page_no for page in self.pages],
            "seq": self.seq,
            "reviewer_name": self.reviewer_name,
            "summary": self.summary,
            "result_name": self.result_name,
            "pages": [page.to_dict() for page in self.pages],
            "changed_pages": [page.to_dict() for page in changed],
            "counts": {
                "changed_pages": len(changed),
                "block_level": sum(1 for page in changed if page.kind == KIND_BLOCK_LEVEL),
                "structural": sum(1 for page in changed if page.kind == KIND_STRUCTURAL),
                "conflict": sum(1 for page in changed if page.kind == KIND_CONFLICT),
                "comments": sum(page.comment_count for page in changed),
                "changed_blocks": sum(page.changed_blocks for page in changed),
            },
        }


def _archived_results(directory: Path, assignment_id: str) -> Path:
    path = assignments_module.assignment_dir(directory, assignment_id) / RESULTS_DIR_NAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def import_result(
    project_id: str,
    *,
    path: Path,
    source_name: str = "",
    library: Path | None = None,
    allow_cancelled: bool = False,
    allow_older: bool = False,
) -> MergeState:
    """导入一个结果包：校验 → 留档 → 分类。**这一层不写正文**，等负责人逐页决定。"""
    target_library = library or default_library_dir()
    directory = project_dir(target_library, project_id)
    main = library_module.load_project(project_id, library=target_library)
    result, _events, summary = read_result(path)

    if result.get("project_id") != project_id:
        raise ProjectError(
            "这个结果包不是这个项目的"
            f"（结果包属于 {result.get('project_id')}，当前项目是 {project_id}）"
        )
    if result.get("source_sha256") != main.source_sha256:
        raise ProjectError("结果包对应的书与当前项目不一致（源文件 SHA-256 不同）")

    assignment = assignments_module.get_assignment(
        project_id, str(result.get("package_id") or ""), library=target_library
    )
    if assignment.status == assignments_module.STATUS_CANCELLED and not allow_cancelled:
        raise ProjectError(
            "这个任务包已经作废——确认要继续导入的话，勾上「已作废也导入」再试一次"
        )
    seq = int(result.get("seq") or 0)
    if seq <= assignment.imported_seq and not allow_older:
        raise ProjectError(
            f"这是较早的结果（第 {seq} 次导出；已经导入过第 {assignment.imported_seq} 次）"
        )

    # 原样留档（说明书 6.7.5：被拒绝的变化也要能回看）
    safe_name = Path(source_name).name or f"result{seq}.b2tres"
    archived = _archived_results(directory, assignment.assignment_id) / f"{seq}-{safe_name}"
    archived.write_bytes(path.read_bytes())

    # 分类
    snapshot = assignments_module.load_snapshot(directory, assignment.assignment_id)
    snapshot_blocks: dict[str, dict] = {}
    for page in snapshot.get("pages") or []:
        for block in page.get("blocks") or []:
            snapshot_blocks[block["block_id"]] = block
    snapshot_pages = {
        page["page_id"]: page for page in snapshot.get("pages") or [] if not page.get("is_context")
    }
    current_blocks = blocks_module.list_blocks(project_id, library=target_library)
    blocks_by_page: dict[str, list] = {}
    for block in current_blocks:
        blocks_by_page.setdefault(block.page_id, []).append(block)

    pages: list[PageDiff] = []
    for page_result in result.get("pages") or []:
        page_id = str(page_result.get("page_id") or "")
        snapshot_page = snapshot_pages.get(page_id)
        if snapshot_page is None:
            raise ProjectError(f"结果包里有任务包里没有的页面：{page_id}")
        pages.append(
            diff_page(
                snapshot_page=snapshot_page,
                snapshot_blocks=snapshot_blocks,
                current_blocks=blocks_by_page.get(page_id, []),
                their_blocks=page_result.get("blocks") or [],
            )
        )

    now = _now()
    with db_module.open_database(directory) as conn:
        conn.execute(
            """
            UPDATE assignment
            SET status = CASE WHEN status = ? THEN ? ELSE status END,
                imported_seq = ?, updated_at = ?
            WHERE assignment_id = ?
            """,
            (
                assignments_module.STATUS_ISSUED,
                assignments_module.STATUS_RETURNED,
                seq,
                now,
                assignment.assignment_id,
            ),
        )
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()

    return MergeState(
        assignment=assignments_module.get_assignment(
            project_id, assignment.assignment_id, library=target_library
        ),
        seq=seq,
        reviewer_name=str(result.get("reviewer_name") or assignment.reviewer_name),
        summary=summary,
        pages=tuple(pages),
        result_name=archived.name,
    )


# ---------------------------------------------------------------- 接受 / 拒绝

def latest_result_path(directory: Path, assignment_id: str, seq: int) -> Path | None:
    """上一次导入的结果包留档（接受时以它为准——"接受的就是看过的那一份"）。"""
    folder = _archived_results(directory, assignment_id)
    matches = sorted(folder.glob(f"{seq}-*"))
    return matches[-1] if matches else None


def apply_decisions(
    project_id: str,
    *,
    assignment_id: str,
    decisions: list[dict],
    reviewer_name: str,
    library: Path | None = None,
) -> dict:
    """按负责人的决定把助手的改动写进主项目（说明书 6.7.5）。

    `decisions` 每项：``{"page_id": …, "action": "accept" | "reject" | "keep_mine",
    "block_ids": [...]}``——块级变化可以只接受其中几块；结构变化与冲突按整页处理。
    """
    if not decisions:
        raise ProjectError("没有要处理的页面")

    target_library = library or default_library_dir()
    directory = project_dir(target_library, project_id)
    assignment = assignments_module.get_assignment(
        project_id, assignment_id, library=target_library
    )
    if assignment.imported_seq <= 0:
        raise ProjectError("还没导入过结果包，先导入再合并")

    archived = latest_result_path(directory, assignment_id, assignment.imported_seq)
    if archived is None:
        raise ProjectError("找不到已导入的结果包留档，请重新导入一次")
    result, _events, _summary = read_result(archived)
    blocks_by_page = {
        str(page.get("page_id")): page.get("blocks") or [] for page in result.get("pages") or []
    }

    snapshot = assignments_module.load_snapshot(directory, assignment_id)
    snapshot_blocks: dict[str, dict] = {}
    for page in snapshot.get("pages") or []:
        for block in page.get("blocks") or []:
            snapshot_blocks[block["block_id"]] = block
    snapshot_pages = {
        page["page_id"]: page for page in snapshot.get("pages") or [] if not page.get("is_context")
    }

    events: list[editing.Event] = []
    accepted_pages = 0
    rejected_pages = 0
    for decision in decisions:
        page_id = str(decision.get("page_id") or "")
        action = str(decision.get("action") or "")
        snapshot_page = snapshot_pages.get(page_id)
        if snapshot_page is None:
            raise ProjectError(f"这一页不在任务包里：{page_id}")
        if action not in (DECISION_ACCEPT, DECISION_REJECT, DECISION_KEEP_MINE):
            raise ProjectError(f"不认识的处理方式：{action!r}")
        if action in (DECISION_REJECT, DECISION_KEEP_MINE):
            rejected_pages += 1
            continue

        theirs = blocks_by_page.get(page_id, [])
        theirs_by_id = {block["block_id"]: block for block in theirs}
        wanted = decision.get("block_ids")
        only = set(wanted) if wanted else None
        page_block_ids = {block["block_id"] for block in snapshot_page.get("blocks") or []}

        changes: list[tuple[str, dict]] = []
        for block_id, their_block in theirs_by_id.items():
            if only is not None and block_id not in only:
                continue
            base = snapshot_blocks.get(block_id)
            if base is None:
                changes.append(("create", dict(their_block)))
                continue
            payload = {
                field: their_block.get(field)
                for field in BLOCK_FIELDS
                if not _same(field, their_block.get(field), base.get(field))
            }
            if payload:
                changes.append(("update", {"block_id": block_id, **payload}))

        # 助手删掉的块：只有整页接受时才删（块级变化里不会走到这里）
        if only is None:
            for block_id in page_block_ids:
                if block_id not in theirs_by_id:
                    changes.append(("delete", {"block_id": block_id}))

        events.extend(
            editing.apply_reviewer_changes(
                project_id,
                page_no=int(snapshot_page["page_no"]),
                changes=changes,
                reviewer_name=reviewer_name or assignment.reviewer_name,
                package_id=assignment_id,
                library=target_library,
            )
        )
        accepted_pages += 1

    now = _now()
    status = (
        assignments_module.STATUS_MERGED
        if rejected_pages == 0
        else assignments_module.STATUS_PARTIALLY_MERGED
    )
    with db_module.open_database(directory) as conn:
        conn.execute(
            """
            UPDATE assignment
            SET status = ?, merged_seq = ?, merged_pages = merged_pages + ?, updated_at = ?
            WHERE assignment_id = ?
            """,
            (status, assignment.imported_seq, accepted_pages, now, assignment_id),
        )
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()

    return {
        "events": events,
        "accepted_pages": accepted_pages,
        "rejected_pages": rejected_pages,
        "assignment": assignments_module.get_assignment(
            project_id, assignment_id, library=target_library
        ).to_dict(),
    }
