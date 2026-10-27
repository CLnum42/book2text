"""真实引擎的**输出质量**（说明书 5.2 的坐标基准）。

需要 OCR 依赖（`uv sync --group ocr-eval`），未安装时整体跳过。
**慢**：任务跑在真子进程里，这里只留最小的一组——旋转页的坐标方向、
原始输出文件的内容、重启后仍在。

任务控制、中断、重试在 `test_worker_subprocess.py`；
假引擎覆盖的一大片（R1 / R2 / 失败原因）在 `test_recognition_api.py`。
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.ocr.adapters import RapidOcrAdapter

pytestmark = [pytest.mark.ocr, pytest.mark.macos_only]


@pytest.fixture(autouse=True)
def _require_ocr_engine():
    """同上：跳过放到运行时，模块级 skip 会污染 marker 过滤后的零 skip 守卫。"""
    available, reason = RapidOcrAdapter().available()
    if not available:
        pytest.skip(f"未安装 OCR 引擎（uv sync --group ocr-eval）：{reason}")


def run_job_and_wait(
    client: TestClient, headers: dict[str, str], project_id: str, pages: list[int], *,
    timeout: float = 300.0
) -> dict:
    """建任务并等它跑完（真子进程，因此要轮询）。"""
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr", json={"pages": pages}, headers=headers
    )
    assert response.status_code == 200, response.text
    job_id = response.json()["job"]["job_id"]

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        data = client.get(
            f"/api/projects/{project_id}/jobs/{job_id}", headers=headers
        ).json()
        if data["job"]["status"] in ("succeeded", "failed", "cancelled", "interrupted"):
            return data
        time.sleep(1.0)
    raise AssertionError("任务没有在预期时间内结束")


def test_real_engine_persists_blocks_into_the_project(
    client: TestClient,
    auth_headers: dict[str, str],
    rotated_pdf: Path,
    library_dir: Path,
) -> None:
    """真实引擎跑通"识别 → 落库"，并且坐标是**显示方向**的归一化坐标。

    夹具是一页声明 `/Rotate=90` 的横向内容（`fixtures/pdf/rotated-page-90.pdf`），
    因此识别用图应当是横的、文字应当正立——这正是说明书 5.2 的坐标基准。
    """
    created = client.post(
        "/api/projects",
        params={"name": "真引擎识别", "filename": rotated_pdf.name},
        content=rotated_pdf.read_bytes(),
        headers={**auth_headers, "Content-Type": "application/pdf"},
    )
    project_id = created.json()["project"]["project_id"]

    data = run_job_and_wait(client, auth_headers, project_id, [1])

    assert data["job"]["status"] == "succeeded", data["items"]
    item = data["items"][0]
    assert item["status"] == "succeeded"
    pages = client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()["pages"]
    assert pages[0]["recognition"]["status"] == "recognized"

    content = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()
    assert content["active_run"]["engine_id"] == "rapidocr"
    assert content["active_run"]["elapsed_seconds"] > 0
    assert content["block_count"] >= 1

    texts = "\n".join(block["text"] for block in content["blocks"])
    assert "ROTATED" in texts.upper(), f"识别结果里应有夹具上的文字，实际是：{texts!r}"

    for block in content["blocks"]:
        assert block["origin"] == "ocr"
        assert block["review_status"] == "unreviewed"
        assert block["modified"] is False
        assert block["lines"], "每个块都要带行"
        for line in block["lines"]:
            box = line["bbox"]
            assert len(box) == 4
            assert all(0.0 <= value <= 1.0 for value in box), f"坐标越界：{box}"
            assert box[2] > box[0] and box[3] > box[1]
        assert block["text"] == "\n".join(line["text"] for line in block["lines"])

    # 行框在页面上确实是横向分布的（旋转页若按存储方向识别，坐标会全挤在一侧）
    widest = max(line["bbox"][2] - line["bbox"][0] for block in content["blocks"] for line in block["lines"])
    assert widest > 0.3, f"最宽的行走不出 30% 页宽，坐标基准可疑：{widest}"

    # 原始输出落盘，且记下的是**横向**的识别用图
    raw_path = library_dir / project_id / content["active_run"]["raw_result_path"]
    payload = json.loads(raw_path.read_text(encoding="utf-8"))
    assert payload["engine_id"] == "rapidocr"
    assert payload["image_width"] > payload["image_height"], "旋转页的识别用图应为横向"
    assert payload["line_count"] >= 1


def test_real_engine_results_survive_a_restart(
    client: TestClient, auth_headers: dict[str, str], rotated_pdf: Path, library_dir: Path
) -> None:
    from book2text.api.app import create_app
    from tests.conftest import TEST_ORIGIN, TEST_TOKEN

    created = client.post(
        "/api/projects",
        params={"name": "真引擎重启", "filename": rotated_pdf.name},
        content=rotated_pdf.read_bytes(),
        headers={**auth_headers, "Content-Type": "application/pdf"},
    )
    project_id = created.json()["project"]["project_id"]
    run_job_and_wait(client, auth_headers, project_id, [1])
    before = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()

    fresh = TestClient(
        create_app(session_token=TEST_TOKEN, origins=[TEST_ORIGIN], library_dir=library_dir)
    )
    after = fresh.get(f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers).json()

    assert after["blocks"] == before["blocks"]
    assert after["active_run"] == before["active_run"]
