"""版面检测与页面工作流的单元测试（任务 58）。

这里不碰真 PDF / 真引擎：验证的是范围解析、状态记录的"只前进"、
失败不倒退、回填与按状态筛选。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from book2text.core.layout import detection as layout_detection
from book2text.core.project import workflow as workflow_module
from book2text.core.storage import db as db_module
from book2text.core.storage.migration import migrate
from book2text.core.storage.migrations import MIGRATIONS


def _connect(tmp_path: Path):
    return db_module.connect(tmp_path / "test.db")


def test_migration_0015_creates_layout_and_workflow_tables(tmp_path: Path) -> None:
    conn = _connect(tmp_path)
    try:
        migrate(conn, MIGRATIONS)
        tables = {
            row["name"]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
        assert {"layout_run", "page_layout_line", "page_workflow"} <= tables
        columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(page_workflow)").fetchall()
        }
        assert {
            "page_id",
            "stage",
            "failed_stage",
            "failure_reason",
            "stage_times_json",
            "page_number_state",
            "revision",
            "updated_at",
        } <= columns
        layout_columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(layout_run)").fetchall()
        }
        assert {"engine_id", "engine_version", "params_json", "line_count"} <= layout_columns
        # 任务 61：确认方式与自动通过撤销标记
        confirmation_columns = {
            row["name"]
            for row in conn.execute("PRAGMA table_info(page_workflow)").fetchall()
        }
        assert {"confirm_mode", "confirmed_at", "auto_pass_excluded"} <= confirmation_columns
    finally:
        conn.close()


def _library(tmp_path: Path) -> Path:
    return tmp_path


def test_backfill_uses_page_type_and_confirmation(minimal_project: Path, tmp_path: Path) -> None:
    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        conn.execute("UPDATE page SET page_confirmed = 1 WHERE page_id = 'page1'")
        conn.execute(
            "UPDATE page SET page_type = 'front', include = 0 WHERE page_id = 'page2'"
        )
        conn.commit()

    inserted = workflow_module.backfill_project(minimal_project.name, library=_library(tmp_path))
    assert inserted == 3

    states = {}
    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        for row in conn.execute("SELECT page_id, stage FROM page_workflow").fetchall():
            states[row["page_id"]] = row["stage"]
    assert states["page1"] == workflow_module.STAGE_CONFIRMED
    assert states["page2"] == workflow_module.STAGE_EXCLUDED
    assert states["page3"] == workflow_module.STAGE_PAGE_UNCONFIRMED

    # 再打开一次不重复插入、不改已有进度
    assert workflow_module.backfill_project(minimal_project.name, library=_library(tmp_path)) == 0


def test_record_stage_only_moves_forward_and_failure_does_not_regress(
    minimal_project: Path,
) -> None:
    workflow_module.record_stage(
        minimal_project, "page1", workflow_module.STAGE_DETECTED
    )
    workflow_module.record_stage(minimal_project, "page1", workflow_module.STAGE_OCR1_DONE)
    # 再记一个更早的阶段：stage 不能倒退
    assert (
        workflow_module.record_stage(
            minimal_project, "page1", workflow_module.STAGE_CONFIRMED
        )
        == workflow_module.STAGE_OCR1_DONE
    )

    workflow_module.record_failure(minimal_project, "page1", "detected", "渲染失败")
    state = workflow_module.page_workflow(minimal_project, "page1")
    assert state["stage"] == workflow_module.STAGE_OCR1_DONE
    assert state["failed_stage"] == "detected"
    assert state["failure_reason"] == "渲染失败"
    assert "detected" in state["stage_times"]

    # 成功记录会清掉失败标记
    workflow_module.record_stage(minimal_project, "page1", workflow_module.STAGE_DETECTED)
    state = workflow_module.page_workflow(minimal_project, "page1")
    assert state["failed_stage"] is None


def test_rebuild_requires_continuous_products(minimal_project: Path) -> None:
    """连续判定：有 OCR 但没有检测行 → 只能到 confirmed，不能跳到已识别①。"""
    from book2text.core.storage.ulid import new_ulid

    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        conn.execute("UPDATE page SET page_confirmed = 1 WHERE page_id IN ('page1','page2')")
        run_id = new_ulid()
        conn.execute(
            """
            INSERT INTO layout_run (
                run_id, page_id, engine_id, engine_version, params_json,
                status, line_count, created_at
            ) VALUES (?, 'page1', 'fake-layout', '1', '{}', 'succeeded', 3, ?)
            """,
            (run_id, "2026-01-01T00:00:00+00:00"),
        )
        ocr_id = new_ulid()
        conn.execute(
            """
            INSERT INTO ocr_run (
                run_id, page_id, run_type, engine_id, engine_version, params_json,
                status, created_at
            ) VALUES (?, 'page1', 'primary', 'fake', '1', '{}', 'succeeded', ?)
            """,
            (ocr_id, "2026-01-01T00:00:00+00:00"),
        )
        conn.execute(
            "UPDATE page SET active_run_id = ? WHERE page_id = 'page1'", (ocr_id,)
        )
        conn.commit()

    assert workflow_module.rebuild_page_stage(minimal_project, "page1") == "ocr1_done"
    # 有 OCR 但没检测：连续判定停在已确认
    assert workflow_module.rebuild_page_stage(minimal_project, "page2") == "confirmed"
    # 非正文页永不参与
    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        conn.execute("UPDATE page SET page_type = 'back', include = 0 WHERE page_id = 'page3'")
        conn.commit()
    assert workflow_module.rebuild_page_stage(minimal_project, "page3") == "excluded"


def test_project_workflow_derives_missing_rows_and_filters(
    minimal_project: Path, tmp_path: Path
) -> None:
    workflow_module.record_stage(
        minimal_project, "page1", workflow_module.STAGE_DETECTED
    )
    data = workflow_module.project_workflow(minimal_project.name, library=_library(tmp_path))
    assert data["summary"]["total"] == 3
    assert data["counts"]["detected"] == 1
    # 没回填的页按页面类型 / 确认状态派生，不会消失
    assert data["counts"]["page_unconfirmed"] == 2

    only_detected = workflow_module.project_workflow(
        minimal_project.name, library=_library(tmp_path), stage="detected"
    )
    assert [page["page_no"] for page in only_detected["pages"]] == [1]

    with pytest.raises(workflow_module.WorkflowError):
        workflow_module.project_workflow(
            minimal_project.name, library=_library(tmp_path), stage="not-a-stage"
        )


def test_resolve_layout_pages_scope_and_skip(minimal_project: Path, tmp_path: Path) -> None:
    from book2text.core.storage.ulid import new_ulid

    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        conn.execute(
            """
            INSERT INTO layout_run (
                run_id, page_id, engine_id, engine_version, params_json,
                status, line_count, created_at
            ) VALUES (?, 'page1', 'fake-layout', '1', '{}', 'succeeded', 3, ?)
            """,
            (new_ulid(), "2026-01-01T00:00:00+00:00"),
        )
        conn.commit()

    selected = layout_detection.resolve_layout_pages(
        minimal_project.name, library=_library(tmp_path), scope="body"
    )
    assert [page.page_no for page in selected] == [2, 3]

    explicit = layout_detection.resolve_layout_pages(
        minimal_project.name,
        library=_library(tmp_path),
        pages=[1],
        skip_detected=False,
    )
    assert [page.page_no for page in explicit] == [1]

    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE page SET page_type = 'front', include = 0 WHERE page_id = 'page2'"
        )
        conn.commit()
    with pytest.raises(Exception, match="不是「正文」"):
        layout_detection.resolve_layout_pages(
            minimal_project.name, library=_library(tmp_path), pages=[2]
        )


def test_repair_unfinished_settles_layout_runs(minimal_project: Path) -> None:
    """取消 / 中断要结算 layout_run，不能留下永远 running 的记录（任务 58 实测撞到）。"""
    from book2text.core.project import jobs as jobs_module
    from book2text.core.storage.ulid import new_ulid

    job = jobs_module.create_job(
        minimal_project,
        pages=[("page1", 1)],
        params={"dpi": 200, "engine_id": "fake-layout"},
        job_type=jobs_module.JOB_TYPE_LAYOUT,
    )
    run_id = new_ulid()
    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        conn.execute(
            """
            INSERT INTO layout_run (
                run_id, page_id, engine_id, engine_version, params_json,
                status, line_count, created_at
            ) VALUES (?, 'page1', 'fake-layout', '1', '{}', 'running', 0, ?)
            """,
            (run_id, "2026-01-01T00:00:00+00:00"),
        )
        conn.execute(
            "UPDATE job_item SET status = 'running', run_id = ? WHERE job_id = ?",
            (run_id, job.job_id),
        )
        conn.commit()

    jobs_module.repair_unfinished(minimal_project, message="断了", job_id=job.job_id)
    with db_module.open_database(minimal_project, apply_migrations=False) as conn:
        run = conn.execute(
            "SELECT status, error_code FROM layout_run WHERE run_id = ?", (run_id,)
        ).fetchone()
    assert run["status"] == "failed"
    assert run["error_code"] == "interrupted"
