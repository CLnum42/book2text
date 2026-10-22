"""协作往返（说明书 6.7 / 场景 G）：负责人在 Mac 上分派 → 助手审校 → 回传 → 合并。

这一个文件把整条链路串起来走一遍（都在本机两套项目库里，等价于"两个应用实例"）：

1. 负责人建项目、识别、分派（生成 `.b2tpkg`）；
2. 助手打开任务包（另一个项目库）→ 审校（改文本、确认、加备注、拆一块）→ 导出 `.b2tres`；
3. 负责人导入结果包 → 逐页分类（块级 / 结构变化 / 冲突）→ 接受 / 拒绝；
4. 合并后的主项目：文本是助手的、状态是"已确认"且 `reviewed_by` 是助手、事件可追溯、整批可撤销。

同时锁住三处**权限限制**（说明书 6.7.3：界面藏按钮，服务端也必须拦）。
"""

from __future__ import annotations

import io
import json
import tempfile
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.collab import assignments as assignments_module
from book2text.core.storage import db as db_module
from tests.fakes import FakeOcrEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path, name: str) -> str:
    response = client.post(
        "/api/projects",
        params={"name": name, "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def recognize(client: TestClient, headers: dict[str, str], project_id: str, *page_nos: int) -> None:
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": list(page_nos), "skip_recognized": False},
        headers=headers,
    )
    assert response.status_code == 200, response.text


def page_blocks(client: TestClient, headers: dict[str, str], project_id: str, page_no: int) -> dict:
    response = client.get(
        f"/api/projects/{project_id}/pages/{page_no}/blocks", headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


def patch_block(client: TestClient, headers: dict[str, str], project_id: str, block: dict, patch: dict):
    return client.patch(
        f"/api/projects/{project_id}/blocks/{block['block_id']}",
        json={**patch, "expected_revision": block["revision"]},
        headers=headers,
    )


def make_package(
    client: TestClient, headers: dict[str, str], project_id: str, page_nos: list[int], reviewer: str
) -> Path:
    """负责人分派并取回任务包文件。"""
    response = client.post(
        f"/api/projects/{project_id}/assignments",
        json={
            "pages": page_nos,
            "reviewer_name": reviewer,
            "note": "注意人名统一",
            "with_context": False,
        },
        headers=headers,
    )
    assert response.status_code == 200, response.text
    assignment_id = response.json()["assignment"]["assignment_id"]
    download = client.get(
        f"/api/projects/{project_id}/assignments/{assignment_id}/package", headers=headers
    )
    assert download.status_code == 200
    path = Path(tempfile.gettempdir()) / f"{assignment_id}.b2tpkg"
    path.write_bytes(download.content)
    return path


def open_package_in(client: TestClient, headers: dict[str, str], package: Path) -> dict:
    """助手（另一套项目库）打开任务包。"""
    response = client.post(
        f"/api/packages/open?filename={package.name}",
        content=package.read_bytes(),
        headers={**headers, "Content-Type": "application/zip"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def export_result(client: TestClient, headers: dict[str, str], project_id: str) -> tuple[Path, dict]:
    response = client.post(
        f"/api/projects/{project_id}/package/result", headers=headers
    )
    assert response.status_code == 200, response.text
    payload = response.json()
    path = Path(tempfile.gettempdir()) / payload["file_name"]
    path.write_bytes(
        client.get(
            f"/api/projects/{project_id}/package/results/{payload['file_name']}",
            headers=headers,
        ).content
    )
    return path, payload["summary"]


def import_result(
    client: TestClient, headers: dict[str, str], project_id: str, result: Path
) -> dict:
    response = client.post(
        f"/api/projects/{project_id}/results?filename={result.name}",
        content=result.read_bytes(),
        headers={**headers, "Content-Type": "application/zip"},
    )
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def owner(client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs: FakeOcrEngine):
    project_id = create_project(client, auth_headers, sample_pdf, "合作的书")
    recognize(client, auth_headers, project_id, 1)
    return project_id


# ---------------------------------------------------------------- 分派 → 助手审校 → 回传

def test_full_round_trip_block_level_change(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, owner: str
) -> None:
    package = make_package(client, auth_headers, owner, [1], "张三")

    # 助手：打开任务包 → 改文本 + 确认 + 备注
    assistant = open_package_in(client, auth_headers, package)
    assert assistant["project"]["kind"] == "package"
    assistant_id = assistant["project"]["project_id"]
    assert assistant["package"]["owner_name"] == ""  # 负责人没填名字（设置里是空的）
    assert assistant["package"]["page_nos"] == [1]
    assert "张三" in assistant["project"]["name"] or assistant["package"]["reviewer_name"] == "张三"

    detail = page_blocks(client, auth_headers, assistant_id, 1)
    block = detail["blocks"][0]
    patched = patch_block(
        client, auth_headers, assistant_id, block,
        {"text": block["text"] + "（张三改）", "review_status": "confirmed", "comment": "这里原书似有印刷错误"},
    )
    assert patched.status_code == 200, patched.text

    # 助手导出结果包
    result, summary = export_result(client, auth_headers, assistant_id)
    assert summary["confirmed"] >= 1
    assert summary["commented"] == 1
    assert result.suffix == ".b2tres"

    # 负责人导入 → 分类应该是"块级修改"（负责人没动过这一页）
    imported = import_result(client, auth_headers, owner, result)
    assert imported["seq"] == 1
    assert imported["counts"]["changed_pages"] == 1
    assert imported["counts"]["block_level"] == 1
    assert imported["counts"]["conflict"] == 0
    assert imported["counts"]["comments"] == 1
    changed = imported["changed_pages"][0]
    assert changed["page_no"] == 1
    assert changed["page_no"] == 1 and changed["kind"] == "block_level"
    fields = changed["block_changes"][0]["fields"]
    assert "text" in fields and fields["text"]["owner_changed"] is False
    assert "comment" in fields

    # 负责人接受这一页
    applied = client.post(
        f"/api/projects/{owner}/assignments/{imported['assignment']['assignment_id']}/merge",
        json={"decisions": [{"page_id": changed["page_id"], "action": "accept"}], "reviewer_name": "张三"},
        headers=auth_headers,
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["accepted_pages"] == 1
    assert applied.json()["assignment"]["status"] == "merged"

    # 主项目里：文本是助手的、状态已确认、reviewed_by 是张三、备注在
    after = page_blocks(client, auth_headers, owner, 1)["blocks"][0]
    assert after["text"].endswith("（张三改）")
    assert after["review_status"] == "confirmed"
    assert after["reviewed_by"] == "张三"
    assert after["comment"] == "这里原书似有印刷错误"

    # 事件：actor=reviewer、actor_name=张三、package_id 已填，且整批可撤销
    with db_module.open_database(library_dir / owner, apply_migrations=False) as conn:
        rows = conn.execute(
            "SELECT * FROM event WHERE actor = 'reviewer' ORDER BY created_at"
        ).fetchall()
    assert rows, "合并要留下 reviewer 事件"
    assert all(row["actor_name"] == "张三" for row in rows)
    assert all(row["package_id"] == imported["assignment"]["assignment_id"] for row in rows)
    batch_ids = {row["batch_id"] for row in rows}
    assert len(batch_ids) == 1, "一次导入共享一个 batch"

    undo = client.post(f"/api/projects/{owner}/undo", headers=auth_headers)
    assert undo.status_code == 200, undo.text
    restored = page_blocks(client, auth_headers, owner, 1)["blocks"][0]
    assert not restored["text"].endswith("（张三改）"), "撤销要退回助手的改动"
    assert restored["review_status"] == "unreviewed"


def test_structural_change_is_merged_as_a_whole_page(
    client: TestClient, auth_headers: dict[str, str], owner: str
) -> None:
    """说明书 6.7.5：结构变化按整页接受（块之间相互依赖）。"""
    package = make_package(client, auth_headers, owner, [1], "张三")
    assistant = open_package_in(client, auth_headers, package)
    assistant_id = assistant["project"]["project_id"]

    # 助手把第一块拆成两块（结构变化）
    detail = page_blocks(client, auth_headers, assistant_id, 1)
    block = detail["blocks"][0]
    split = client.post(
        f"/api/projects/{assistant_id}/blocks/{block['block_id']}/split",
        json={"offset": 3},
        headers=auth_headers,
    )
    assert split.status_code == 200, split.text

    result, _summary = export_result(client, auth_headers, assistant_id)
    imported = import_result(client, auth_headers, owner, result)
    assert imported["counts"]["structural"] == 1
    changed = imported["changed_pages"][0]
    assert changed["kind"] == "structural"
    assert changed["accept_scope"] == "page"
    assert changed["added_blocks"], "拆分产生的新块要出现在差异里"

    # 接受整页 → 主项目块数变多
    before_count = len(page_blocks(client, auth_headers, owner, 1)["blocks"])
    applied = client.post(
        f"/api/projects/{owner}/assignments/{imported['assignment']['assignment_id']}/merge",
        json={"decisions": [{"page_id": changed["page_id"], "action": "accept"}]},
        headers=auth_headers,
    )
    assert applied.status_code == 200, applied.text
    after = page_blocks(client, auth_headers, owner, 1)["blocks"]
    assert len(after) == before_count + 1, "拆分后的两块都要进来"


def test_conflict_is_flagged_when_both_sides_changed(
    client: TestClient, auth_headers: dict[str, str], owner: str
) -> None:
    """说明书 6.7.5：分派后负责人也改了同一块 → 冲突，必须单独处理。"""
    package = make_package(client, auth_headers, owner, [1], "张三")
    assistant = open_package_in(client, auth_headers, package)
    assistant_id = assistant["project"]["project_id"]

    # 助手改第一块的文本
    assistant_blocks = page_blocks(client, auth_headers, assistant_id, 1)["blocks"]
    patch_block(
        client, auth_headers, assistant_id, assistant_blocks[0],
        {"text": assistant_blocks[0]["text"] + "（助手版）"},
    )
    # 负责人也改同一块（分派之后）
    owner_blocks = page_blocks(client, auth_headers, owner, 1)["blocks"]
    patch_block(
        client, auth_headers, owner, owner_blocks[0],
        {"text": owner_blocks[0]["text"] + "（负责人版）"},
    )

    result, _summary = export_result(client, auth_headers, assistant_id)
    imported = import_result(client, auth_headers, owner, result)
    assert imported["counts"]["conflict"] == 1
    changed = imported["changed_pages"][0]
    assert changed["kind"] == "conflict"
    change = changed["block_changes"][0]
    assert change["conflict"] is True
    text_field = change["fields"]["text"]
    assert text_field["owner_changed"] is True
    assert "（负责人版）" in text_field["mine"]
    assert "（助手版）" in text_field["theirs"]

    # 保留我的：主项目不动
    applied = client.post(
        f"/api/projects/{owner}/assignments/{imported['assignment']['assignment_id']}/merge",
        json={"decisions": [{"page_id": changed["page_id"], "action": "keep_mine"}]},
        headers=auth_headers,
    )
    assert applied.status_code == 200, applied.text
    assert applied.json()["accepted_pages"] == 0
    assert applied.json()["assignment"]["status"] == "partially_merged"
    kept = page_blocks(client, auth_headers, owner, 1)["blocks"][0]
    assert kept["text"].endswith("（负责人版）")


def test_import_rejects_wrong_project(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, owner: str
) -> None:
    """导入校验：必须是同一个项目、同一本书。"""
    package = make_package(client, auth_headers, owner, [1], "张三")
    assistant = open_package_in(client, auth_headers, package)
    result, _summary = export_result(client, auth_headers, assistant["project"]["project_id"])

    other = create_project(client, auth_headers, sample_pdf, "另一本书")
    recognize(client, auth_headers, other, 1)
    response = client.post(
        f"/api/projects/{other}/results?filename={result.name}",
        content=result.read_bytes(),
        headers={**auth_headers, "Content-Type": "application/zip"},
    )
    assert response.status_code == 400
    assert "不是这个项目的" in response.json()["error"]["detail"]


def test_import_rejects_older_result_by_default(
    client: TestClient, auth_headers: dict[str, str], owner: str
) -> None:
    """序号不大于已导入的 → 提示"这是较早的结果"，默认不处理。"""
    package = make_package(client, auth_headers, owner, [1], "张三")
    assistant = open_package_in(client, auth_headers, package)
    assistant_id = assistant["project"]["project_id"]

    first, _ = export_result(client, auth_headers, assistant_id)
    imported = import_result(client, auth_headers, owner, first)
    assignment_id = imported["assignment"]["assignment_id"]

    again = client.post(
        f"/api/projects/{owner}/results?filename={first.name}",
        content=first.read_bytes(),
        headers={**auth_headers, "Content-Type": "application/zip"},
    )
    assert again.status_code == 400
    assert "较早的结果" in again.json()["error"]["detail"]

    forced = client.post(
        f"/api/projects/{owner}/results?filename={first.name}&allow_older=true",
        content=first.read_bytes(),
        headers={**auth_headers, "Content-Type": "application/zip"},
    )
    assert forced.status_code == 200, forced.text
    assert forced.json()["assignment"]["assignment_id"] == assignment_id


def test_cancelled_assignment_requires_explicit_confirmation(
    client: TestClient, auth_headers: dict[str, str], owner: str
) -> None:
    """说明书 6.7.5：任务包已作废时，要负责人明确确认才能导入。"""
    package = make_package(client, auth_headers, owner, [1], "张三")
    imported_ids = client.get(f"/api/projects/{owner}/assignments", headers=auth_headers).json()
    assignment_id = imported_ids["assignments"][0]["assignment_id"]
    client.post(
        f"/api/projects/{owner}/assignments/{assignment_id}/cancel", headers=auth_headers
    )

    assistant = open_package_in(client, auth_headers, package)
    result, _summary = export_result(client, auth_headers, assistant["project"]["project_id"])

    refused = client.post(
        f"/api/projects/{owner}/results?filename={result.name}",
        content=result.read_bytes(),
        headers={**auth_headers, "Content-Type": "application/zip"},
    )
    assert refused.status_code == 400
    assert "已作废" in refused.json()["error"]["detail"]

    forced = client.post(
        f"/api/projects/{owner}/results?filename={result.name}&allow_cancelled=true",
        content=result.read_bytes(),
        headers={**auth_headers, "Content-Type": "application/zip"},
    )
    assert forced.status_code == 200, forced.text


# ---------------------------------------------------------------- 助手端的权限限制

def test_package_project_cannot_recognize_or_export(
    client: TestClient, auth_headers: dict[str, str], owner: str
) -> None:
    """说明书 6.7.3：审校包里不能识别、不能改页面类型 / 纳入、不能导出 TXT / JSONL。"""
    package = make_package(client, auth_headers, owner, [1], "张三")
    assistant_id = open_package_in(client, auth_headers, package)["project"]["project_id"]

    ocr = client.post(
        f"/api/projects/{assistant_id}/jobs/ocr",
        json={"pages": [1], "skip_recognized": False},
        headers=auth_headers,
    )
    assert ocr.status_code == 403
    assert ocr.json()["error"]["code"] == "package_project_forbidden"

    auxiliary = client.post(
        f"/api/projects/{assistant_id}/jobs/auxiliary", json={"pages": [1]}, headers=auth_headers
    )
    assert auxiliary.status_code == 403

    pages = client.get(f"/api/projects/{assistant_id}/pages", headers=auth_headers).json()["pages"]
    patch = client.patch(
        f"/api/projects/{assistant_id}/pages",
        json={"page_ids": [pages[0]["page_id"]], "page_type": "front"},
        headers=auth_headers,
    )
    assert patch.status_code == 403

    structure = client.post(
        f"/api/projects/{assistant_id}/structure/header-footer/preview",
        json={},
        headers=auth_headers,
    )
    assert structure.status_code == 403

    export = client.post(
        f"/api/projects/{assistant_id}/export/preflight",
        json={"format": "txt"},
        headers=auth_headers,
    )
    assert export.status_code == 403
    assert "审校任务" in export.json()["error"]["message"]

    # 但**块编辑**是允许的（说明书 6.7.3 的第一行）
    blocks = page_blocks(client, auth_headers, assistant_id, 1)["blocks"]
    allowed = patch_block(
        client, auth_headers, assistant_id, blocks[0], {"review_status": "confirmed"}
    )
    assert allowed.status_code == 200, allowed.text


def test_context_pages_are_read_only(
    client: TestClient, auth_headers: dict[str, str], owner: str
) -> None:
    """说明书 6.7.2：前后各 1 页是只读上下文，能看不能改。"""
    recognize(client, auth_headers, owner, 2)
    package = client.post(
        f"/api/projects/{owner}/assignments",
        json={"pages": [2], "reviewer_name": "张三", "with_context": True},
        headers=auth_headers,
    )
    assert package.status_code == 200, package.text
    assert package.json()["assignment"]["context_page_ids"], "要带上下文页"

    download = client.get(
        f"/api/projects/{owner}/assignments/"
        f"{package.json()['assignment']['assignment_id']}/package",
        headers=auth_headers,
    )
    path = Path(tempfile.gettempdir()) / "context-check.b2tpkg"
    path.write_bytes(download.content)
    assistant_id = open_package_in(client, auth_headers, path)["project"]["project_id"]

    pages = client.get(f"/api/projects/{assistant_id}/pages", headers=auth_headers).json()["pages"]
    context_page = next(page for page in pages if page["is_context"])
    assert context_page["page_no"] == 1

    context_blocks = page_blocks(client, auth_headers, assistant_id, context_page["page_no"])["blocks"]
    refused = patch_block(
        client, auth_headers, assistant_id, context_blocks[0], {"text": "偷偷改上下文页"}
    )
    assert refused.status_code == 403
    assert refused.json()["error"]["code"] == "context_page_readonly"

    # 新增块也要拦（按页码判）
    create = client.post(
        f"/api/projects/{assistant_id}/pages/{context_page['page_no']}/blocks",
        json={"text": "新块"},
        headers=auth_headers,
    )
    assert create.status_code == 403


def test_package_info_endpoint(
    client: TestClient, auth_headers: dict[str, str], owner: str
) -> None:
    package = make_package(client, auth_headers, owner, [1], "张三")
    assistant_id = open_package_in(client, auth_headers, package)["project"]["project_id"]

    info = client.get(f"/api/projects/{assistant_id}/package", headers=auth_headers)
    assert info.status_code == 200
    assert info.json()["package"]["reviewer_name"] == "张三"
    assert info.json()["package"]["note"] == "注意人名统一"

    # 主项目不是审校包
    missing = client.get(f"/api/projects/{owner}/package", headers=auth_headers)
    assert missing.status_code == 404


def test_assistant_sees_owner_edits_through_a_second_result(
    client: TestClient, auth_headers: dict[str, str], owner: str
) -> None:
    """多次回传：第一次合并之后，负责人看到的差异只包含"尚未合并的变化"。"""
    package = make_package(client, auth_headers, owner, [1], "张三")
    assistant_id = open_package_in(client, auth_headers, package)["project"]["project_id"]

    blocks = page_blocks(client, auth_headers, assistant_id, 1)["blocks"]
    patch_block(client, auth_headers, assistant_id, blocks[0], {"text": blocks[0]["text"] + "（一）"})
    first, _ = export_result(client, auth_headers, assistant_id)
    imported = import_result(client, auth_headers, owner, first)
    client.post(
        f"/api/projects/{owner}/assignments/{imported['assignment']['assignment_id']}/merge",
        json={"decisions": [{"page_id": imported["changed_pages"][0]["page_id"], "action": "accept"}]},
        headers=auth_headers,
    )

    # 助手继续改第二块 → 第二次导出
    blocks = page_blocks(client, auth_headers, assistant_id, 1)["blocks"]
    patch_block(client, auth_headers, assistant_id, blocks[1], {"text": blocks[1]["text"] + "（二）"})
    second, _ = export_result(client, auth_headers, assistant_id)
    assert second.name != first.name

    imported2 = import_result(client, auth_headers, owner, second)
    assert imported2["seq"] == 2
    # 第二次的差异里只有第二块（第一块已经在主项目里合并过了，与结果包一致）
    changed = imported2["changed_pages"][0]
    assert len(changed["block_changes"]) == 1
    assert "（二）" in changed["block_changes"][0]["fields"]["text"]["theirs"]


# ---------------------------------------------------------------- 老任务包：旧页面类型值

def _rewrite_package_page_types(package: Path, values: list[str]) -> Path:
    """把任务包 data.json 里的页面类型换成指定值（模拟旧版本生成的任务包）。"""
    with zipfile.ZipFile(package) as archive:
        entries = {name: archive.read(name) for name in archive.namelist()}
    data = json.loads(entries["data.json"])
    for page, value in zip(data["pages"], values):
        page["page_type"] = value
    entries["data.json"] = json.dumps(data, ensure_ascii=False).encode("utf-8")
    target = package.with_name(f"legacy-{package.name}")
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return target


def test_old_page_types_in_a_package_are_mapped_on_open(
    client: TestClient, auth_headers: dict[str, str], owner: str
) -> None:
    """旧包里的 cover / appendix / foreword 按五类映射，include 跟着派生。"""
    recognize(client, auth_headers, owner, 1, 2, 3)
    package = make_package(client, auth_headers, owner, [1, 2, 3], "张三")
    legacy = _rewrite_package_page_types(package, ["cover", "appendix", "foreword"])

    assistant = open_package_in(client, auth_headers, legacy)
    assistant_id = assistant["project"]["project_id"]
    items = client.get(
        f"/api/projects/{assistant_id}/pages", headers=auth_headers
    ).json()["pages"]
    assert [page["page_type"] for page in items] == ["front", "back", "front"]
    assert all(page["include"] is False for page in items)


def test_unknown_page_type_in_a_package_is_refused(
    client: TestClient, auth_headers: dict[str, str], owner: str
) -> None:
    recognize(client, auth_headers, owner, 1, 2, 3)
    package = make_package(client, auth_headers, owner, [1, 2, 3], "张三")
    legacy = _rewrite_package_page_types(package, ["body", "不认识的类型", "body"])

    response = client.post(
        "/api/packages/open?filename=legacy.b2tpkg",
        content=legacy.read_bytes(),
        headers={**auth_headers, "Content-Type": "application/zip"},
    )
    assert response.status_code == 400
    assert "页面类型不认识" in response.json()["error"]["detail"]
