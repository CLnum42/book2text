"""真实第二引擎（Apple Vision）的集成测试（说明书 8.5）。

需要 macOS + pyobjc 桥接包（uv sync --group ocr-eval 会装）。
非 macOS 或未装依赖时整体跳过——第二引擎是**逐平台**的（Windows 的系统 OCR 未实现）。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.ocr.adapters.apple_vision import AppleVisionAdapter
from book2text.core.project import blocks as blocks_module
from book2text.core.project import recognition

pytestmark = [pytest.mark.ocr, pytest.mark.macos_only]


@pytest.fixture(autouse=True)
def _require_apple_vision():
    """同上：跳过放到运行时，模块级 skip 会污染 marker 过滤后的零 skip 守卫。"""
    available, reason = AppleVisionAdapter().available()
    if not available:
        pytest.skip(f"Apple Vision 不可用：{reason}")


@pytest.fixture
def recognized_page(
    client: TestClient, auth_headers: dict[str, str], rotated_pdf: Path
) -> str:
    """一页已识别（用真引擎，真实行图）。"""
    created = client.post(
        "/api/projects",
        params={"name": "第二引擎真机", "filename": rotated_pdf.name},
        content=rotated_pdf.read_bytes(),
        headers={**auth_headers, "Content-Type": "application/pdf"},
    )
    project_id = created.json()["project"]["project_id"]
    started = client.post(
        f"/api/projects/{project_id}/jobs/ocr",
        json={"pages": [1], "skip_recognized": False},
        headers=auth_headers,
    )
    assert started.status_code == 200, started.text
    import time

    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        data = client.get(
            f"/api/projects/{project_id}/jobs/{started.json()['job']['job_id']}",
            headers=auth_headers,
        ).json()
        if data["job"]["status"] in ("succeeded", "failed", "cancelled", "interrupted"):
            break
        time.sleep(0.5)
    assert data["job"]["status"] == "succeeded", data
    return project_id


def test_vision_reviews_every_line_and_records_a_run(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, recognized_page: str
) -> None:
    """Apple Vision 逐行复核：行级候选写进 BlockLine，运行记为 auxiliary。"""
    project_id = recognized_page
    response = client.post(
        f"/api/projects/{project_id}/pages/1/auxiliary", headers=auth_headers
    )
    assert response.status_code == 200, response.text
    data = response.json()

    assert data["engine_id"] == "apple_vision"
    assert data["line_count"] > 0
    assert data["identical"] + data["format_only_differs"] + data["differs"] == data["line_count"]
    assert data["elapsed_seconds"] > 0
    # 行图是按第一引擎那次的 DPI 裁的
    assert data["dpi"] >= 72

    lines = blocks_module.list_block_lines(project_id, library=library_dir, page_no=1)
    assert all(line.aux_text is not None for line in lines), "每一行都要有第二引擎的候选"
    assert all(line.diff_status for line in lines)

    runs = [run for run in blocks_module.list_runs(project_id, library=library_dir) if run.run_type == "auxiliary"]
    assert len(runs) == 1
    assert runs[0].engine_id == "apple_vision"


def test_vision_on_a_rotated_page_uses_display_coordinates(
    client: TestClient, auth_headers: dict[str, str], library_dir: Path, recognized_page: str
) -> None:
    """旋转页的坐标基准是**显示方向**（说明书 5.2）——两路文本能对上就说明这一点。

    夹具是一页 `/Rotate=90` 的横向内容。若第二引擎用的是存储方向，
    它读出来的会是竖着的乱码，与第一引擎的行文本几乎不可能一致。
    """
    project_id = recognized_page
    data = client.post(
        f"/api/projects/{project_id}/pages/1/auxiliary", headers=auth_headers
    ).json()

    agree = data["identical"] + data["format_only_differs"]
    assert agree >= data["line_count"] * 0.5, (
        f"两路只有 {agree}/{data['line_count']} 行能对上，坐标基准可能不一致"
    )


def test_vision_reports_itself_through_the_selfcheck() -> None:
    """引擎自检要如实报告第二引擎可用（说明书 Phase 0 第 4 项）。"""
    from book2text.core.ocr import selfcheck

    report = selfcheck.report()
    probe = next(
        item for item in report["probes"] if item["engine_id"] == "apple_vision"
    )
    assert probe["available"] is True
    assert probe["role"] == "secondary"
