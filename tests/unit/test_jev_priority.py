"""Jev 打分任务：选行 / 建任务 / 执行 / 清除（2026-11-05）。

不碰真引擎：`run_job` 的 `scorer` / `renderer` 都是注入点；`create_job` 的探测在这里
用 monkeypatch 跳过（真探测的形态在 `test_jev_probe` 里单测）。真机那条路由
（llama.cpp + 打分服务 + 40 页项目）不在自动化里，见 docs/qa 的验收脚本。
"""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from book2text.core.project import jev_priority as jev
from book2text.core.project import jobs as jobs_module
from book2text.core.storage import db as db_module


def _add_page_lines(directory: Path, page_no: int, page_id: str) -> None:
    with db_module.open_database(directory) as conn:
        conn.execute(
            """
            INSERT INTO block (block_id, page_id, origin, order_index, bbox, block_type,
                               ocr_text, text, include, continues_to_next, created_at, updated_at)
            VALUES (?, ?, 'ocr', 0, '[0.1,0.1,0.9,0.2]', 'paragraph', '甲', '甲', 1, 0,
                    '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')
            """,
            (f"block{page_no}", page_id),
        )
        rows = [
            (f"line{page_no}a", 0, "甲甲甲", "乙乙乙", "differs"),   # 汉字级分歧
            (f"line{page_no}b", 1, "丙丙丙", None, "differs"),        # 没有第二引擎文本
            (f"line{page_no}c", 2, "丁丁丁", "丁丁丁", "identical"),  # 不是分歧行
        ]
        for line_id, index, text, aux, status in rows:
            conn.execute(
                """
                INSERT INTO block_line (line_id, block_id, line_index, bbox, text, aux_text, diff_status)
                VALUES (?, ?, ?, '[0.1,0.1,0.9,0.2]', ?, ?, ?)
                """,
                (line_id, f"block{page_no}", index, text, aux, status),
            )
        conn.commit()


@pytest.fixture
def project_with_diffs(minimal_project: Path) -> Path:
    _add_page_lines(minimal_project, 1, "page1")
    _add_page_lines(minimal_project, 2, "page2")
    return minimal_project


def test_target_lines_only_picks_diff_lines_with_aux_text(project_with_diffs: Path) -> None:
    rows = jev.target_lines("b2t_TESTS1", library=project_with_diffs.parent)
    assert [(row.page_no, row.line_index) for row in rows] == [(1, 0), (2, 0)]
    assert all(row.bbox for row in rows)


def test_create_job_needs_engine_and_models(project_with_diffs: Path, monkeypatch) -> None:
    """探测不过 ⇒ 拒绝建任务，队列不动。"""
    monkeypatch.setattr(jev, "probe", lambda config: ["Jev 打分服务没起"])
    with pytest.raises(jev.JevUnavailable) as caught:
        jev.create_job("b2t_TESTS1", library=project_with_diffs.parent)
    assert "打分服务" in str(caught.value)
    assert jobs_module.list_jobs(project_with_diffs, limit=5) == []


def test_create_job_rejects_when_no_aux_text(minimal_project: Path, monkeypatch) -> None:
    """没有第二引擎文本的行 ⇒ 提示先跑第二引擎，不建任务。"""
    monkeypatch.setattr(jev, "probe", lambda config: [])
    with pytest.raises(jev.JevUnavailable) as caught:
        jev.create_job("b2t_TESTS1", library=minimal_project.parent)
    assert "第二引擎" in str(caught.value)


def test_run_job_writes_scores_and_succeeds(project_with_diffs: Path) -> None:
    rows = jev.target_lines("b2t_TESTS1", library=project_with_diffs.parent)
    job = jobs_module.create_job(
        project_with_diffs,
        pages=[("page1", 1), ("page2", 2)],
        params={},
        job_type=jev.JOB_TYPE_JEV,
    )

    def fake_renderer(source, index, dpi):  # noqa: ANN001
        return Image.new("RGB", (200, 400), "white")

    calls: list[int] = []

    def fake_scorer(config, items):  # noqa: ANN001
        calls.append(len(items))
        return [0.0123 for _ in items]

    outcome = jev.run_job(
        project_with_diffs,
        job,
        config=jev.JevConfig(model_dir=None),
        scorer=fake_scorer,
        renderer=fake_renderer,
    )

    assert outcome.job.status == jobs_module.STATUS_SUCCEEDED
    assert sum(calls) == len(rows)
    with db_module.open_database(project_with_diffs, apply_migrations=False) as conn:
        scores = conn.execute(
            "SELECT line_id, jev_score FROM block_line WHERE jev_score IS NOT NULL"
        ).fetchall()
    assert {row["line_id"] for row in scores} == {row.line_id for row in rows}
    assert all(abs(row["jev_score"] - 0.0123) < 1e-9 for row in scores)


def test_run_job_keeps_scores_when_a_page_fails(project_with_diffs: Path) -> None:
    """跑一半失败：job 标 failed，**已写分数保留**（不清列）。"""
    job = jobs_module.create_job(
        project_with_diffs,
        pages=[("page1", 1), ("page2", 2)],
        params={},
        job_type=jev.JOB_TYPE_JEV,
    )
    state = {"calls": 0}

    def flaky_scorer(config, items):  # noqa: ANN001
        state["calls"] += 1
        if state["calls"] == 2:
            raise jev.JevUnavailable("打分服务挂了")
        return [0.02 for _ in items]

    outcome = jev.run_job(
        project_with_diffs,
        job,
        config=jev.JevConfig(model_dir=None),
        scorer=flaky_scorer,
        renderer=lambda source, index, dpi: Image.new("RGB", (200, 400), "white"),
    )

    assert outcome.job.status == jobs_module.STATUS_FAILED
    with db_module.open_database(project_with_diffs, apply_migrations=False) as conn:
        kept = conn.execute("SELECT COUNT(*) AS n FROM block_line WHERE jev_score IS NOT NULL").fetchone()["n"]
    assert kept == 1, "第一页写的分数必须保留"


def test_clear_scores_clears_and_writes_event(project_with_diffs: Path) -> None:
    job = jobs_module.create_job(
        project_with_diffs, pages=[("page1", 1), ("page2", 2)], params={}, job_type=jev.JOB_TYPE_JEV
    )
    jev.run_job(
        project_with_diffs,
        job,
        config=jev.JevConfig(model_dir=None),
        scorer=lambda config, items: [0.03 for _ in items],
        renderer=lambda source, index, dpi: Image.new("RGB", (200, 400), "white"),
    )
    assert jev.scored_counts("b2t_TESTS1", library=project_with_diffs.parent)["scored"] == 2

    cleared = jev.clear_scores("b2t_TESTS1", library=project_with_diffs.parent, actor_name="测试")

    assert cleared == 2
    assert jev.scored_counts("b2t_TESTS1", library=project_with_diffs.parent)["scored"] == 0
    with db_module.open_database(project_with_diffs, apply_migrations=False) as conn:
        event = conn.execute(
            "SELECT action, before_json FROM event WHERE action = 'jev_priority_cleared'"
        ).fetchone()
    assert event is not None and '"scored": 2' in event["before_json"]


def test_probe_lists_missing_model_files(tmp_path: Path) -> None:
    config = jev.JevConfig(model_dir=tmp_path, font_path=str(tmp_path / "nope.ttc"))
    problems = jev.probe(config)
    assert any("模型文件缺失" in item for item in problems)
    assert any("字体缺失" in item for item in problems)
    assert any("打分服务" in item for item in problems)
