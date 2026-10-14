"""真子进程 + 真引擎的端到端测试（说明书 Phase 2 的验收：中断测试、失败原因可见）。

**慢**：每个任务都要现付一次子进程启动与模型加载（数秒）。因此这里只留最必要的几组，
且都用 1–3 页的样本。

这一组要证明的事情只有真子进程能证明：

- 识别真的跑在**另一个进程**里，进度写进数据库，界面靠轮询看得到；
- 杀掉那个进程之后，任务能被**对账**成中断，不留下永远 running 的记录；
- 父进程一侧的管子一断，子进程会自己收工（不会留下孤儿进程继续写库）。
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from book2text.core.ocr.adapters import RapidOcrAdapter

pytestmark = pytest.mark.ocr

if not RapidOcrAdapter().available()[0]:
    pytest.skip("未安装 OCR 引擎（uv sync --group ocr-eval）", allow_module_level=True)

TERMINAL = ("succeeded", "failed", "cancelled", "interrupted")


def create_project(client: TestClient, headers: dict[str, str], pdf: Path) -> str:
    response = client.post(
        "/api/projects",
        params={"name": "子进程测试", "filename": pdf.name},
        content=pdf.read_bytes(),
        headers={**headers, "Content-Type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["project_id"]


def start_job(
    client: TestClient, headers: dict[str, str], project_id: str, pages: list[int]
) -> dict:
    response = client.post(
        f"/api/projects/{project_id}/jobs/ocr", json={"pages": pages}, headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()


def get_job(client: TestClient, headers: dict[str, str], project_id: str, job_id: str) -> dict:
    response = client.get(f"/api/projects/{project_id}/jobs/{job_id}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def wait_for_job(
    client: TestClient,
    headers: dict[str, str],
    project_id: str,
    job_id: str,
    *,
    timeout: float = 300.0,
) -> dict:
    """等到任务结算**并且**子进程退出。

    状态先落库、进程再退出（收尾要几十毫秒），因此这两件事要分别等——
    只看状态断言 `alive is False` 会偶发失败。
    """
    deadline = time.monotonic() + timeout
    data = get_job(client, headers, project_id, job_id)
    while time.monotonic() < deadline:
        data = get_job(client, headers, project_id, job_id)
        if data["job"]["status"] in TERMINAL:
            break
        time.sleep(1.0)
    else:
        raise AssertionError(f"任务在 {timeout}s 内没有结束：{data['job']['status']}")

    exit_deadline = time.monotonic() + 20
    while data["alive"] and time.monotonic() < exit_deadline:
        time.sleep(0.5)
        data = get_job(client, headers, project_id, job_id)
    return data


# ---------------------------------------------------------------- 端到端

def test_batch_job_runs_in_a_subprocess(
    client: TestClient, auth_headers: dict[str, str], scan_sample_pdf: Path, library_dir: Path
) -> None:
    """一次建任务、子进程逐页认完、进度与结果都落库。"""
    project_id = create_project(client, auth_headers, scan_sample_pdf)
    started = start_job(client, auth_headers, project_id, [1, 2])

    assert started["job"]["status"] == "queued", "请求立刻返回，不在请求里做识别"
    assert started["job"]["total"] == 2
    job_id = started["job"]["job_id"]

    finished = wait_for_job(client, auth_headers, project_id, job_id)
    assert finished["job"]["status"] == "succeeded", finished["failed_items"]
    assert finished["job"]["done"] == 2
    assert finished["alive"] is False, "跑完之后子进程已经退出"
    assert all(item["attempts"] == 1 for item in finished["items"])
    assert all(item["run_id"] for item in finished["items"])

    # 两个页面各自有块与运行记录
    for page_no in (1, 2):
        content = client.get(
            f"/api/projects/{project_id}/pages/{page_no}/blocks", headers=auth_headers
        ).json()
        assert content["block_count"] >= 1, f"第 {page_no} 页没有块"
        assert content["active_run"]["engine_id"] == "rapidocr"
        assert content["page"]["recognition"]["status"] == "recognized"
        for block in content["blocks"]:
            for line in block["lines"]:
                box = line["bbox"]
                assert all(0.0 <= value <= 1.0 for value in box), f"坐标越界：{box}"

    # 子进程的日志落在项目里，且只写页码 / 结果 / 耗时（不写识别文本）
    log_path = library_dir / project_id / finished["log_path"]
    log_text = log_path.read_text(encoding="utf-8")
    assert "page 1 succeeded" in log_text
    assert "page 2 succeeded" in log_text
    assert "job " + job_id + " end status=succeeded" in log_text
    content = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()
    sample_text = content["blocks"][0]["text"][:8]
    assert sample_text and sample_text not in log_text, "日志里不该出现识别出的文本"


# ---------------------------------------------------------------- 中断

def test_killing_the_worker_is_reconciled_as_interrupted(
    client: TestClient, auth_headers: dict[str, str], scan_sample_pdf: Path, library_dir: Path
) -> None:
    """说明书 Phase 2 的验收：中断测试。

    杀掉识别进程（模拟引擎崩溃 / 系统回收），下一次读任务时必须如实变成"中断"，
    而且**不留下永远 running 的单元与运行记录**。
    """
    import os
    import signal

    project_id = create_project(client, auth_headers, scan_sample_pdf)
    started = start_job(client, auth_headers, project_id, [1, 2, 3])
    job_id = started["job"]["job_id"]

    # 等它真的开始跑（子进程起来、状态写成 running）
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        now = get_job(client, auth_headers, project_id, job_id)
        if now["job"]["status"] == "running":
            break
        time.sleep(0.3)
    else:  # pragma: no cover - 引擎坏到起不来
        raise AssertionError("任务一直没有进入 running")

    pid = now["process_id"]
    assert pid, "拿不到子进程的 pid"
    os.kill(pid, signal.SIGKILL)

    reconciled = wait_for_job(client, auth_headers, project_id, job_id)
    assert reconciled["job"]["status"] == "interrupted", reconciled["job"]
    assert reconciled["alive"] is False
    assert not any(item["status"] == "running" for item in reconciled["items"])

    with_runs = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()["runs"]
    for run in with_runs:
        assert run["status"] in ("succeeded", "failed"), run["status"]
        if run["status"] == "failed":
            assert run["error_code"] == "interrupted"

    # 中断之后可以继续：只做没成功的页
    resumed = client.post(
        f"/api/projects/{project_id}/jobs/{job_id}/resume", headers=auth_headers
    )
    assert resumed.status_code == 200, resumed.text
    assert resumed.json()["job"]["status"] == "running"
    again = wait_for_job(client, auth_headers, project_id, job_id)
    assert again["job"]["status"] == "succeeded"


def test_losing_the_parent_pipe_stops_the_worker(
    client: TestClient, auth_headers: dict[str, str], scan_sample_pdf: Path, library_dir: Path
) -> None:
    """应用被强杀时不该留下孤儿进程继续写数据库。

    父进程持有一根从不写入的 stdin 管子；这里直接把它关掉——那正是父进程死亡时
    操作系统会做的事。子进程应当**自己**收工，并把任务结算成中断。
    """
    project_id = create_project(client, auth_headers, scan_sample_pdf)
    started = start_job(client, auth_headers, project_id, [1, 2, 3, 4])
    job_id = started["job"]["job_id"]

    supervisor = client.app.state.job_supervisor

    # 直接拿到 Popen 是唯一能模拟"父进程死亡"的办法：关掉管子的写端
    child = supervisor._children[job_id]  # noqa: SLF001 - 测试要模拟父进程消失
    assert child.process.stdin is not None
    child.process.stdin.close()

    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        if not supervisor.is_alive(job_id) and child.process.poll() is not None:
            break
        time.sleep(0.5)
    else:  # pragma: no cover - 看门狗失效时
        supervisor.stop(job_id)
        raise AssertionError("子进程没有在父进程管子关闭后自行退出")

    # 子进程自己把状态结算成中断
    data = get_job(client, auth_headers, project_id, job_id)
    assert data["job"]["status"] == "interrupted", data["job"]
    assert not any(item["status"] == "running" for item in data["items"])
    # 孤儿退出的路径里，父进程没插手：进度是子进程自己写的
    assert data["job"]["done"] + data["job"]["failed"] <= 4


# ---------------------------------------------------------------- 失败可见

def test_worker_reports_a_broken_page_without_stopping_the_batch(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    rotated_pdf: Path,
    library_dir: Path,
) -> None:
    """一页出错不该让整批停下——失败原因写进单元，其余页照做。

    做法：项目是用三页 PDF 建的，但把项目里的副本换成**一页**的 PDF。
    于是第 1 页认得出来，第 2、3 页渲染失败（页码超出现有页数）。
    """
    project_id = create_project(client, auth_headers, sample_pdf)
    source = library_dir / project_id / "source" / "original.pdf"
    source.write_bytes(rotated_pdf.read_bytes())

    started = start_job(client, auth_headers, project_id, [1, 2, 3])
    finished = wait_for_job(client, auth_headers, project_id, started["job"]["job_id"])

    assert finished["job"]["status"] == "failed", "有页失败，整个任务记为失败"
    assert finished["job"]["done"] == 1, "坏页之后的页还是要继续做"
    assert finished["job"]["failed"] == 2
    assert [item["page_no"] for item in finished["failed_items"]] == [2, 3]
    for item in finished["failed_items"]:
        assert item["error_message"], "失败原因不能为空（说明书 Phase 2：失败原因可见）"

    # 失败页的记录留在库里：任务、单元、运行三处都写着原因
    content = client.get(
        f"/api/projects/{project_id}/pages/2/blocks", headers=auth_headers
    ).json()
    assert content["blocks"] == []
    assert content["runs"][0]["status"] == "failed"
    assert content["runs"][0]["error_code"] == "render_failed"
    assert content["page"]["recognition"]["status"] == "failed"
    assert content["page"]["recognition"]["last_error"]

    # 成功的那一页照常入库
    good = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()
    assert good["block_count"] >= 1
    assert good["page"]["recognition"]["status"] == "recognized"


def test_failed_pages_can_be_retried_in_a_subprocess(
    client: TestClient,
    auth_headers: dict[str, str],
    sample_pdf: Path,
    rotated_pdf: Path,
    library_dir: Path,
) -> None:
    """说明书 Phase 2 的验收："重试不产生重复块"——在真子进程上也成立。"""
    project_id = create_project(client, auth_headers, sample_pdf)
    source = library_dir / project_id / "source" / "original.pdf"
    good_bytes = source.read_bytes()
    source.write_bytes(rotated_pdf.read_bytes())

    started = start_job(client, auth_headers, project_id, [1, 2])
    first = wait_for_job(client, auth_headers, project_id, started["job"]["job_id"])
    assert first["job"]["failed"] == 1
    page1_before = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()

    # 把 PDF 换回去，失败的那页就有救了
    source.write_bytes(good_bytes)
    retried = client.post(
        f"/api/projects/{project_id}/jobs/{first['job']['job_id']}/retry-failed",
        headers=auth_headers,
    )
    assert retried.status_code == 200, retried.text
    assert retried.json()["retried"] == 1
    second = wait_for_job(client, auth_headers, project_id, first["job"]["job_id"])

    assert second["job"]["status"] == "succeeded"
    assert second["job"]["failed"] == 0
    assert second["job"]["done"] == 2

    page1_after = client.get(
        f"/api/projects/{project_id}/pages/1/blocks", headers=auth_headers
    ).json()
    assert page1_after["blocks"] == page1_before["blocks"], "成功的那页没被重做、块也没变"
    assert len(page1_after["runs"]) == 1

    page2 = client.get(
        f"/api/projects/{project_id}/pages/2/blocks", headers=auth_headers
    ).json()
    assert page2["block_count"] >= 1
    assert [run["status"] for run in page2["runs"]] == ["succeeded", "failed"]
