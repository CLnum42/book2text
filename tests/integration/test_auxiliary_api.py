"""第二引擎（辅助识别）的集成测试（说明书 8.5 / R1b）。

R1b 的规定：页面已有 active run 时，第二引擎**按行**识别第一引擎切出的行图，
结果记 `run_type = auxiliary` 的 OCRRun，写进 `BlockLine.aux_text` 与 `diff_status`，
**不生成块、不影响审校状态**。

这里用假引擎跑（快、确定）；真实 Apple Vision 的用法在
`test_secondary_engine_vision.py`（需要 macOS + pyobjc）。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import blocks as blocks_module
from book2text.core.project import recognition
from book2text.core.storage import db as db_module
from tests.fakes import FakeOcrEngine, FakeSecondEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "第二引擎", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def recognize(client: TestClient, headers: dict[str, str], project_id: str, page_no: int = 1) -> None:
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [page_no], "skip_recognized": False},
        headers=headers,
    )
    assert response.status_code == 200, response.text


@pytest.fixture
def recognized_page(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs: FakeOcrEngine
) -> str:
    """第 1 页已识别（假引擎：2 块 3 行）。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id)
    return project_id


def _drop_text_layer(library_dir: Path, project_id: str, page_no: int = 1) -> None:
    """把这一页标成"没有文字层"：让测试走真正的第二引擎那条路。

    任务 58 起，带文字层的页直接读文字层（不跑引擎）；这几条用例验的是**引擎**
    路径（不可用要 503、结果要来自引擎），所以先把文字层摘掉。
    """
    with db_module.open_database(library_dir / project_id) as conn:
        conn.execute("UPDATE page SET has_text_layer = 0 WHERE page_no = ?", (page_no,))
        conn.commit()

def lines_of(project_id: str, library_dir: Path, page_no: int = 1):
    return blocks_module.list_block_lines(project_id, library=library_dir, page_no=page_no)


# ---------------------------------------------------------------- 逐行复核

def test_auxiliary_writes_line_candidates_without_touching_blocks(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, recognized_page: str
) -> None:
    """第二引擎只写 BlockLine 的候选与分歧标记，块与审校状态一点不动。"""
    project_id = recognized_page
    before = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()
    before_lines = lines_of(project_id, library_dir)

    # 第二引擎的答案：第 1 行一致、第 2 行只有格式差异（全角/半角）、第 3 行真分歧
    engine = FakeSecondEngine(
        [
            before_lines[0].text,
            before_lines[1].text.replace("。", "."),
            "完全不一样的一行",
        ]
    )
    result = recognition.run_auxiliary(library_dir / project_id, 1, engine=engine)

    assert result["line_count"] == 3
    assert result["identical"] == 1
    assert result["format_only_differs"] == 1
    assert result["differs"] == 1

    after_lines = lines_of(project_id, library_dir)
    assert [line.aux_text for line in after_lines] == [
        before_lines[0].text,
        before_lines[1].text.replace("。", "."),
        "完全不一样的一行",
    ]
    assert [line.diff_status for line in after_lines] == [
        "identical",
        "format_only_differs",
        "differs",
    ]
    # 行文本本身没被改动（候选只是候选）
    assert [line.text for line in after_lines] == [line.text for line in before_lines]

    after = client.get(f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers).json()
    assert [b["text"] for b in after["blocks"]] == [b["text"] for b in before["blocks"]]
    assert [b["review_status"] for b in after["blocks"]] == [
        b["review_status"] for b in before["blocks"]
    ]
    # 块载荷带**分级后**的分歧（说明书 8.5）：只有那一行实质分歧算"分歧行"，
    # 全角/半角那一行是格式差异（不计入分歧，但要能显示出来）
    graded = [b for b in after["blocks"] if b["divergence"]["lines"]]
    assert len(graded) == 1, "只有一行实质分歧"
    assert graded[0]["divergence"]["chars"] == 1
    assert graded[0]["divergence"]["punct"] == 0
    assert graded[0]["diff_line_count"] == 1
    mark = graded[0]["divergence"]["marks"][0]
    assert mark["candidate"] == "完全不一样的一行"
    assert mark["level"] == "differs_chars"
    assert mark["line_index"] == 0, "标记的是块内行号，不是全页行号"
    formatted = [b for b in after["blocks"] if b["divergence"]["format_only"]]
    assert len(formatted) == 1, "格式差异单独计数，不算分歧"


def test_auxiliary_run_is_recorded_as_a_run_not_blocks(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, recognized_page: str
) -> None:
    """说明书 8.5：记 `run_type = auxiliary` 的 OCRRun，输出写 ocr_runs/<run_id>.json。"""
    import json

    project_id = recognized_page
    engine = FakeSecondEngine(["甲", "乙", "丙"])
    result = recognition.run_auxiliary(library_dir / project_id, 1, engine=engine)

    runs = blocks_module.list_runs(project_id, library=library_dir, page_no=1)
    auxiliary = [run for run in runs if run.run_type == "auxiliary"]
    assert len(auxiliary) == 1
    run = auxiliary[0]
    assert run.run_id == result["run_id"]
    assert run.engine_id == "fake-second"
    assert run.status == "succeeded"
    assert run.raw_result_path == result["raw_result_path"]

    # active run 还是第一引擎那次（辅助识别不抢 active）
    page = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"][0]
    assert page["recognition"]["active_run_id"] != run.run_id
    assert page["recognition"]["status"] == "recognized", "辅助识别不改变页面识别状态"

    payload = json.loads((library_dir / project_id / run.raw_result_path).read_text(encoding="utf-8"))
    assert payload["run_type"] == "auxiliary"
    assert payload["line_count"] == 3
    assert len(payload["line_results"]) == 3
    assert payload["line_results"][0]["block_id"], "每条要能追到块"


def test_auxiliary_uses_the_primary_run_dpi(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, library_dir: Path,
    inprocess_jobs: FakeOcrEngine,
) -> None:
    """行框是第一引擎那一次量出来的，因此复核要用同一个 DPI 渲染，否则对不上。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "skip_recognized": False, "dpi": 150},
        headers=auth_headers,
    )
    assert response.status_code == 200, response.text

    engine = FakeSecondEngine(["x"])
    result = recognition.run_auxiliary(library_dir / project_id, 1, engine=engine)
    assert result["dpi"] == 150

    # 行图是按 150 DPI 的页面裁的：宽度应当明显小于 300 DPI 时的
    blocks_module.list_block_lines(project_id, library=library_dir, page_no=1)
    widest = max(width for width, _ in engine.crops)
    assert widest < 1400, f"行图宽度 {widest} 说明用的不是 150 DPI"


def test_auxiliary_needs_a_primary_run_first(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    library_dir: Path,
    monkeypatch,
) -> None:
    """还没识别过的页没有可复核的行。

    显式给一个**可用**的假第二引擎：本用例要验的是"先识别"这道前置检查，
    不是引擎可用性。否则在没有第二引擎的平台（Windows、没装 pyobjc 的 macOS）上，
    接口会先回 503，这条断言永远走不到。
    """
    monkeypatch.setattr(
        recognition, "default_secondary_engine", lambda: FakeSecondEngine()
    )
    project_id = create_project(client, auth_headers, sample_pdf)
    response = client.post(
        f"/api/projects/{project_id}/pages/1/auxiliary", headers=auth_headers
    )
    assert response.status_code == 400
    assert "先识别" in response.json()["error"]["detail"]


def test_auxiliary_can_be_rerun(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, recognized_page: str
) -> None:
    """辅助识别可以随时重跑（说明书 R1b），只覆盖候选与分歧标记。"""
    project_id = recognized_page
    recognition.run_auxiliary(
        library_dir / project_id, 1, engine=FakeSecondEngine(["第一次的答案"])
    )
    recognition.run_auxiliary(
        library_dir / project_id, 1, engine=FakeSecondEngine(["第二次的答案"])
    )
    lines = lines_of(project_id, library_dir)
    assert all(line.aux_text == "第二次的答案" for line in lines)
    runs = [run for run in blocks_module.list_runs(project_id, library=library_dir) if run.run_type == "auxiliary"]
    assert len(runs) == 2, "两次复核各有一条运行记录"


def test_auxiliary_endpoint_reports_the_engine_is_unavailable(
    client: TestClient,
    auth_headers: dict[str, str],
    recognized_page: str,
    library_dir: Path,
    monkeypatch,
) -> None:
    """第二引擎不可用时回 503 并说明原因（说明书 1.6）。"""

    class Unavailable(FakeSecondEngine):
        def available(self) -> tuple[bool, str]:
            return False, "未安装 pyobjc 桥接包"

    _drop_text_layer(library_dir, recognized_page)
    monkeypatch.setattr(recognition, "default_secondary_engine", lambda: Unavailable())
    response = client.post(
        f"/api/projects/{recognized_page}/pages/1/auxiliary", headers=auth_headers
    )
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "secondary_engine_unavailable"
    assert "pyobjc" in response.json()["error"]["detail"]


def test_auxiliary_requires_token(client: TestClient) -> None:
    assert client.post("/api/projects/b2t_ZZZZZZ/pages/1/auxiliary").status_code == 401


def test_auxiliary_endpoint_returns_differences(
    client: TestClient,
    auth_headers: dict[str, str],
    recognized_page: str,
    library_dir: Path,
    monkeypatch,
) -> None:
    _drop_text_layer(library_dir, recognized_page)
    engine = FakeSecondEngine(["一模一样", "也一模一样", "不一样"])
    monkeypatch.setattr(recognition, "default_secondary_engine", lambda: engine)
    response = client.post(
        f"/api/projects/{recognized_page}/pages/1/auxiliary", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["engine_id"] == "fake-second"
    assert data["line_count"] == 3
    assert data["differs"] == 3, "三条都与第一引擎不同"
    assert len(data["differences"]) == 3
    assert data["differences"][0]["aux_text"] == "一模一样"
    assert data["blocks"], "顺带把最新的块返回，界面不用再拉一次"
