"""API 集成测试：令牌、Origin、上传、渲染、删除的完整链路。"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from tests.conftest import TEST_ORIGIN, TEST_TOKEN


# ---------------------------------------------------------------- 安全

def test_index_page_is_served_without_token(client: TestClient) -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert "Book2Text" in response.text


def test_static_assets_are_served(client: TestClient) -> None:
    for path in ("/static/app.js", "/static/app.css"):
        assert client.get(path).status_code == 200


def test_api_requires_token(client: TestClient) -> None:
    response = client.get("/api/app/info")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_token"


def test_api_rejects_wrong_token(client: TestClient) -> None:
    response = client.get("/api/app/info", headers={"X-B2T-Token": "wrong-token"})
    assert response.status_code == 401


def test_api_rejects_foreign_origin(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.get(
        "/api/app/info",
        headers={**auth_headers, "Origin": "http://evil.example.com"},
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "origin_not_allowed"


def test_api_accepts_expected_origin(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.get("/api/app/info", headers={**auth_headers, "Origin": TEST_ORIGIN})
    assert response.status_code == 200


def test_error_envelope_shape(client: TestClient) -> None:
    payload = client.get("/api/app/info").json()
    error = payload["error"]
    assert set(error) == {"code", "message", "detail", "correlation_id"}
    assert error["message"]
    assert len(error["correlation_id"]) == 12


# ---------------------------------------------------------------- 自检接口

def test_app_info_reports_platform_and_engines(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    info = client.get("/api/app/info", headers=auth_headers).json()

    assert info["app"]["name"] == "Book2Text"
    assert isinstance(info["platform"]["supported"], bool)
    # 不受支持时必须带原因
    if not info["platform"]["supported"]:
        assert info["platform"]["unsupported_reason"]

    engines = info["engines"]
    assert engines["total_count"] == len(engines["probes"])
    assert engines["probes"]
    for probe in engines["probes"]:
        assert probe["role"] in {"primary", "layout", "secondary"}
        if not probe["available"]:
            assert probe["reason"]

    # PDF 后端选型未定，必须如实报告
    assert info["pdf_backend"]["selected"] is False
    assert info["limits"]


# ---------------------------------------------------------------- 上传与渲染

def test_upload_render_and_delete(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    upload = client.post(
        "/api/scratch/upload",
        params={"filename": sample_pdf.name},
        content=sample_pdf.read_bytes(),
        headers={**auth_headers, "Content-Type": "application/pdf"},
    )
    assert upload.status_code == 200, upload.text
    data = upload.json()
    assert data["page_count"] == 3
    assert data["original_name"] == sample_pdf.name
    assert data["size_bytes"] == sample_pdf.stat().st_size
    upload_id = data["upload_id"]

    metadata = client.get(f"/api/scratch/{upload_id}", headers=auth_headers)
    assert metadata.status_code == 200
    assert metadata.json()["sha256"] == data["sha256"]

    image = client.get(f"/api/scratch/{upload_id}/page/0/image", headers=auth_headers)
    assert image.status_code == 200
    assert image.headers["content-type"] == "image/png"
    assert image.content.startswith(b"\x89PNG\r\n\x1a\n")

    deleted = client.delete(f"/api/scratch/{upload_id}", headers=auth_headers)
    assert deleted.status_code == 200
    assert client.get(f"/api/scratch/{upload_id}", headers=auth_headers).status_code == 404


def test_upload_requires_token(client: TestClient, sample_pdf: Path) -> None:
    response = client.post(
        "/api/scratch/upload",
        content=sample_pdf.read_bytes(),
        headers={"Content-Type": "application/pdf"},
    )
    assert response.status_code == 401


def test_upload_rejects_non_pdf(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.post(
        "/api/scratch/upload",
        content=b"definitely not a pdf",
        headers={**auth_headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_upload"


def test_upload_rejects_empty_body(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.post(
        "/api/scratch/upload",
        content=b"",
        headers={**auth_headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 400


def test_filename_with_path_is_reduced_to_basename(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    """原始文件名只用于展示，不能带路径进来。"""
    response = client.post(
        "/api/scratch/upload",
        params={"filename": "../../../etc/passwd.pdf"},
        content=sample_pdf.read_bytes(),
        headers={**auth_headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200
    assert response.json()["original_name"] == "passwd.pdf"


def test_render_page_out_of_range_returns_400(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path
) -> None:
    upload_id = client.post(
        "/api/scratch/upload",
        params={"filename": "s.pdf"},
        content=sample_pdf.read_bytes(),
        headers={**auth_headers, "Content-Type": "application/pdf"},
    ).json()["upload_id"]

    response = client.get(
        f"/api/scratch/{upload_id}/page/99/image", headers=auth_headers
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "render_failed"


def test_unknown_upload_id_returns_404(client: TestClient, auth_headers: dict[str, str]) -> None:
    response = client.get(
        "/api/scratch/d652d6406a08416b91c5fb5b09faf72c", headers=auth_headers
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "upload_not_found"


def test_malformed_upload_id_returns_404(client: TestClient, auth_headers: dict[str, str]) -> None:
    """格式非法的 ID 也走 404，且不泄露路径信息。"""
    response = client.get("/api/scratch/not-a-valid-id", headers=auth_headers)
    assert response.status_code == 404
