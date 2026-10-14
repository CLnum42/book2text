"""项目摘要与质量统计（说明书第 11 节的 `GET /projects/{id}/summary`，8.5 的分歧率，13.4 的指标）。

要点：

1. **数字与界面上看到的一致**：分歧计数与审校视图里标出来的同源（都是
   `blocks.page_divergences`），不另起一套口径；
2. **算不出来的如实列出**（CER / 捕获率 / 每页审校时间……在 `not_measured` 里），
   不假装算过（说明书 1.7）；
3. **分歧率的口径写死**：分母是"两边都有文本、能比的行"，"第二引擎没读出来"的行不进分母。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.project import blocks as blocks_module
from book2text.core.project import recognition
from book2text.core.project import stats as stats_module
from tests.fakes import FakeOcrEngine, FakeSecondEngine


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "质量统计", "filename": pdf.name},
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


def summary(client: TestClient, headers: dict[str, str], project_id: str) -> dict:
    response = client.get(f"/api/projects/{project_id}/summary", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def lines_of(project_id: str, library_dir: Path, page_no: int = 1):
    return blocks_module.list_block_lines(project_id, library=library_dir, page_no=page_no)


@pytest.fixture
def project_with_one_page(
    client: TestClient, auth_headers: dict[str, str], sample_pdf: Path, inprocess_jobs: FakeOcrEngine
) -> str:
    project_id = create_project(client, auth_headers, sample_pdf)
    recognize(client, auth_headers, project_id, 1)
    return project_id


# ---------------------------------------------------------------- 摘要的形状

def test_summary_reports_pages_review_and_jobs(
    client: TestClient, auth_headers: dict[str, str], project_with_one_page: str
) -> None:
    data = summary(client, auth_headers, project_with_one_page)

    assert data["project_id"] == project_with_one_page
    assert data["name"] == "质量统计"
    # 3 页的合成 PDF：第 1 页识别过，另两页没有
    assert data["pages"]["total"] == 3
    assert data["pages"]["recognized"] == 1
    assert data["pages"]["unrecognized"] == 2
    # 假引擎给出 2 块 3 行，都未审
    assert data["review"]["blocks"] == 2
    assert data["review"]["included"] == 2
    assert data["review"]["unreviewed"] == 2
    assert data["review"]["modified"] == 0
    assert data["review"]["modified_rate"] == 0.0
    # 任务：这一次识别成功了
    assert data["jobs"]["total"] == 1
    assert data["jobs"]["succeeded"] == 1
    assert data["jobs"]["failure_rate"] == 0.0
    # 还没复核过
    assert data["divergence"]["checked_pages"] == 0
    assert data["divergence"]["diverging_rate"] == 0.0


def test_summary_lists_what_cannot_be_measured(
    client: TestClient, auth_headers: dict[str, str], project_with_one_page: str
) -> None:
    """说明书 1.7：算不出来的要如实说，不能假装算过。"""
    data = summary(client, auth_headers, project_with_one_page)
    names = [item["name"] for item in data["not_measured"]]
    assert any("CER" in name for name in names)
    assert any("捕获率" in name for name in names)
    assert any("审校时间" in name for name in names)
    assert all("reason" in item and item["reason"] for item in data["not_measured"])


def test_summary_404_for_unknown_project(
    client: TestClient, auth_headers: dict[str, str]
) -> None:
    response = client.get("/api/projects/b2t_NOPE/summary", headers=auth_headers)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "project_error"


# ---------------------------------------------------------------- 分歧率的口径

def test_divergence_rate_uses_comparable_lines_as_denominator(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    project_with_one_page: str,
    inprocess_aux_jobs: FakeSecondEngine,
) -> None:
    """3 行：一致 1、汉字级 1、没读出来 1 → 分母是 2（不含"没读出来"），分歧率 50%。"""
    project_id = project_with_one_page
    lines = lines_of(project_id, library_dir)
    assert len(lines) == 3
    engine = FakeSecondEngine(
        [
            lines[0].text,                     # 一致
            lines[1].text.replace("段", "叚"),   # 汉字级分歧
            "",                                # 第二引擎什么也没读出来
        ]
    )
    recognition.run_auxiliary(library_dir / project_id, 1, engine=engine)

    divergence = summary(client, auth_headers, project_id)["divergence"]
    assert divergence["checked_pages"] == 1
    assert divergence["identical"] == 1
    assert divergence["chars"] == 1
    assert divergence["punct"] == 0
    assert divergence["empty"] == 1
    assert divergence["compared_lines"] == 2, "没读出来的行不进分母"
    assert divergence["checked_lines"] == 3, "但它确实被复核过，单独计入复核行数"
    assert divergence["diverging_lines"] == 1
    assert divergence["diverging_rate"] == 0.5


def test_summary_counts_review_edits_and_confirms(
    client: TestClient, auth_headers: dict[str, str], project_with_one_page: str
) -> None:
    """人工修改率与确认数跟着编辑走（说明书 13.4）。"""
    project_id = project_with_one_page
    detail = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()
    first, second = detail["blocks"][0], detail["blocks"][1]

    # 第一块：改一个字（算人工修改）
    client.patch(
        f"/api/projects/{project_id}/blocks/{first['block_id']}",
        json={"text": first["text"] + "改", "expected_revision": first["revision"]},
        headers=auth_headers,
    )
    # 第二块：确认
    client.patch(
        f"/api/projects/{project_id}/blocks/{second['block_id']}",
        json={"review_status": "confirmed", "expected_revision": second["revision"]},
        headers=auth_headers,
    )

    review = summary(client, auth_headers, project_id)["review"]
    assert review["modified"] == 1
    assert review["confirmed"] == 1
    assert review["unreviewed"] == 1
    assert review["modified_rate"] == 0.5, "2 个纳入块里改了 1 个"


def test_summary_counts_failed_jobs(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    sample_pdf: Path,
    inprocess_aux_jobs: FakeSecondEngine,
) -> None:
    """任务失败率：取消与中断不算成败（只算成功 / 失败）。"""
    from book2text.core.project import jobs as jobs_module

    project_id = create_project(client, auth_headers, sample_pdf)
    directory = library_dir / project_id
    page_ids = [
        page["page_id"]
        for page in client.get(f"/api/projects/{project_id}/pages", headers=auth_headers).json()[
            "pages"
        ]
    ]

    def make(job_type: str) -> str:
        job = jobs_module.create_job(
            directory,
            pages=[(page_ids[0], 1)],
            params={},
            job_type=job_type,
        )
        return job.job_id

    make(jobs_module.JOB_TYPE_OCR)  # 留在排队中（active）
    jobs_module.set_status(directory, make(jobs_module.JOB_TYPE_AUXILIARY), jobs_module.STATUS_SUCCEEDED)
    jobs_module.set_status(directory, make(jobs_module.JOB_TYPE_OCR), jobs_module.STATUS_FAILED)
    jobs_module.set_status(directory, make(jobs_module.JOB_TYPE_OCR), jobs_module.STATUS_CANCELLED)

    jobs = summary(client, auth_headers, project_id)["jobs"]
    assert jobs["total"] == 4
    assert jobs["succeeded"] == 1
    assert jobs["failed"] == 1
    assert jobs["cancelled"] == 1
    assert jobs["active"] == 1
    assert jobs["finished"] == 2, "取消不算成败"
    assert jobs["failure_rate"] == 0.5


# ---------------------------------------------------------------- 读模型不该写东西

def test_summary_does_not_write_anything(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    project_with_one_page: str,
    inprocess_aux_jobs: FakeSecondEngine,
) -> None:
    """摘要是读模型：连读两次结果一样，复核计数不会因为读它而变化。"""
    project_id = project_with_one_page
    lines = lines_of(project_id, library_dir)
    recognition.run_auxiliary(
        library_dir / project_id, 1, engine=FakeSecondEngine([lines[0].text.replace("段", "叚")])
    )
    project_before = client.get(f"/api/projects/{project_id}", headers=auth_headers).json()

    first = summary(client, auth_headers, project_id)
    second = summary(client, auth_headers, project_id)
    assert first == second

    project_after = client.get(f"/api/projects/{project_id}", headers=auth_headers).json()
    assert project_after["pages"] == project_before["pages"], "读摘要不改任何状态"
    assert all(line.aux_text is not None for line in lines_of(project_id, library_dir))


def test_core_summary_matches_page_level_counts(
    client: TestClient,
    auth_headers: dict[str, str],
    library_dir: Path,
    project_with_one_page: str,
    inprocess_aux_jobs: FakeSecondEngine,
) -> None:
    """汇总数和逐页数必须一致——两处口径同源，不能各算各的。"""
    project_id = project_with_one_page
    lines = lines_of(project_id, library_dir)
    recognition.run_auxiliary(
        library_dir / project_id, 1, engine=FakeSecondEngine([lines[0].text.replace("段", "叚")])
    )

    core = stats_module.project_summary(project_id, library=library_dir)
    per_page = blocks_module.page_divergences(project_id, library=library_dir)
    assert core.divergence.chars == sum(item.chars for item in per_page.values())
    assert core.divergence.punct == sum(item.punct for item in per_page.values())
    assert core.divergence.empty == sum(item.empty for item in per_page.values())
    assert core.divergence.checked_pages == sum(1 for item in per_page.values() if item.checked)
