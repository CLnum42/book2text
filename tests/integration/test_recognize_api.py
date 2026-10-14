"""识别接口的集成测试。

需要 OCR 引擎（`uv sync --group ocr-eval`），未安装时整体跳过。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.ocr.adapters import RapidOcrAdapter

pytestmark = pytest.mark.ocr

if not RapidOcrAdapter().available()[0]:
    pytest.skip("未安装 OCR 引擎（uv sync --group ocr-eval）", allow_module_level=True)


def _upload(client: TestClient, headers: dict[str, str], path: Path) -> str:
    response = client.post(
        "/api/scratch/upload",
        params={"filename": path.name},
        content=path.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["upload_id"]


def test_recognize_returns_normalized_lines(
    client: TestClient, auth_headers: dict[str, str], rotated_pdf: Path
) -> None:
    upload_id = _upload(client, auth_headers, rotated_pdf)

    response = client.post(f"/api/scratch/{upload_id}/page/0/recognize", headers=auth_headers)
    assert response.status_code == 200, response.text
    data = response.json()

    assert data["engine_id"] == "rapidocr"
    assert data["line_count"] == len(data["lines"])
    assert data["line_count"] >= 2
    assert data["image_width"] > data["image_height"], "旋转页的识别用图应为横向"
    assert data["elapsed_seconds"] > 0

    for line in data["lines"]:
        assert line["text"].strip()
        bbox = line["bbox"]
        assert len(bbox) == 4
        assert all(0.0 <= value <= 1.0 for value in bbox), f"坐标越界：{bbox}"
        assert bbox[2] > bbox[0] and bbox[3] > bbox[1]


def test_recognize_returns_blocks(
    client: TestClient, auth_headers: dict[str, str], rotated_pdf: Path
) -> None:
    """识别接口要同时返回**块**（说明书 8.1 的分段结果）与行。"""
    upload_id = _upload(client, auth_headers, rotated_pdf)

    data = client.post(
        f"/api/scratch/{upload_id}/page/0/recognize", headers=auth_headers
    ).json()

    assert data["block_count"] == len(data["blocks"])
    assert data["block_count"] >= 1
    assert data["column_count"] >= 1
    assert isinstance(data["reading_order_uncertain"], bool)
    assert isinstance(data["layout_notes"], list)

    for block in data["blocks"]:
        assert block["block_type"] == "paragraph", "现阶段只会产出 paragraph"
        assert block["line_count"] == len(block["lines"])
        assert block["text"] == "\n".join(line["text"] for line in block["lines"])
        bbox = block["bbox"]
        assert len(bbox) == 4
        assert all(0.0 <= value <= 1.0 for value in bbox)
        assert bbox[2] > bbox[0] and bbox[3] > bbox[1]

    # 每块的行必须被完整包含，且块与行的总数对得上
    assert sum(block["line_count"] for block in data["blocks"]) == data["line_count"]


def test_blocks_cover_lines_in_reading_order(
    client: TestClient, auth_headers: dict[str, str], rotated_pdf: Path
) -> None:
    upload_id = _upload(client, auth_headers, rotated_pdf)
    data = client.post(
        f"/api/scratch/{upload_id}/page/0/recognize", headers=auth_headers
    ).json()

    assert [block["order_index"] for block in data["blocks"]] == list(
        range(data["block_count"])
    )
    # 单栏英文页自上而下：每块的顶边不应高于前一块
    tops = [block["bbox"][1] for block in data["blocks"]]
    assert tops == sorted(tops)


def test_recognize_requires_token(
    client: TestClient, auth_headers: dict[str, str], rotated_pdf: Path
) -> None:
    upload_id = _upload(client, auth_headers, rotated_pdf)
    response = client.post(f"/api/scratch/{upload_id}/page/0/recognize")
    assert response.status_code == 401


def test_recognize_rejects_out_of_range_page(
    client: TestClient, auth_headers: dict[str, str], rotated_pdf: Path
) -> None:
    upload_id = _upload(client, auth_headers, rotated_pdf)
    response = client.post(f"/api/scratch/{upload_id}/page/99/recognize", headers=auth_headers)
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "render_failed"


def test_recognize_unknown_upload_returns_404(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    response = client.post(
        "/api/scratch/d652d6406a08416b91c5fb5b09faf72c/page/0/recognize",
        headers=auth_headers,
    )
    assert response.status_code == 404


def test_recognize_respects_dpi_parameter(
    client: TestClient, auth_headers: dict[str, str], rotated_pdf: Path
) -> None:
    upload_id = _upload(client, auth_headers, rotated_pdf)
    response = client.post(
        f"/api/scratch/{upload_id}/page/0/recognize",
        params={"dpi": 150},
        headers=auth_headers,
    )
    assert response.status_code == 200
    data = response.json()
    assert data["dpi"] == 150
    # 150 DPI 下 A4 横向约 1754x1241，明显小于 300 DPI
    assert data["image_width"] < 2000


def test_recognize_rejects_absurd_dpi(
    client: TestClient, auth_headers: dict[str, str], rotated_pdf: Path
) -> None:
    upload_id = _upload(client, auth_headers, rotated_pdf)
    response = client.post(
        f"/api/scratch/{upload_id}/page/0/recognize",
        params={"dpi": 5000},
        headers=auth_headers,
    )
    assert response.status_code == 422  # 参数校验拒绝
