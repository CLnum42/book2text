"""数据库迁移框架测试（说明书 5.1：结构变化必须有迁移）。"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from book2text.core.storage import db as db_module
from book2text.core.storage.migration import (
    Migration,
    applied_versions,
    current_version,
    ensure_meta_table,
    migrate,
)
from book2text.core.storage.migrations import LATEST_VERSION, MIGRATIONS


@pytest.fixture
def conn(tmp_path: Path) -> sqlite3.Connection:
    connection = db_module.connect(tmp_path / "test.db")
    yield connection
    connection.close()


def _table_names(connection: sqlite3.Connection) -> set[str]:
    rows = connection.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).fetchall()
    return {row["name"] for row in rows}


# ---------------------------------------------------------------- 基础行为

def test_fresh_database_reports_version_zero(conn: sqlite3.Connection) -> None:
    assert current_version(conn) == 0


def test_migrate_applies_all_migrations(conn: sqlite3.Connection) -> None:
    version = migrate(conn, MIGRATIONS)
    assert version == LATEST_VERSION
    assert version >= 1


def test_migrate_creates_the_project_and_page_tables(conn: sqlite3.Connection) -> None:
    migrate(conn, MIGRATIONS)
    tables = _table_names(conn)
    assert "project" in tables
    assert "page" in tables


def test_migrate_is_idempotent(conn: sqlite3.Connection) -> None:
    first = migrate(conn, MIGRATIONS)
    second = migrate(conn, MIGRATIONS)
    assert first == second
    assert len(applied_versions(conn)) == len(MIGRATIONS)


def test_applied_versions_record_description_and_time(conn: sqlite3.Connection) -> None:
    migrate(conn, MIGRATIONS)
    rows = applied_versions(conn)
    assert rows[0][0] == 1
    assert rows[0][1], "迁移要记说明，便于事后看结构是怎么来的"
    assert rows[0][2], "迁移要记应用时间"


def test_only_pending_migrations_run(conn: sqlite3.Connection) -> None:
    """已经应用过的不重复执行——重复执行建表语句会报错。"""
    calls: list[int] = []

    def track(version: int):
        def apply(connection: sqlite3.Connection) -> None:
            calls.append(version)
            connection.execute(f"CREATE TABLE t{version} (id INTEGER)")

        return apply

    migrations = [
        Migration(1, "第一版", track(1)),
        Migration(2, "第二版", track(2)),
    ]
    migrate(conn, migrations)
    assert calls == [1, 2]

    migrations.append(Migration(3, "第三版", track(3)))
    migrate(conn, migrations)
    assert calls == [1, 2, 3], "1 与 2 不应重复执行"


def test_duplicate_versions_are_rejected(conn: sqlite3.Connection) -> None:
    migrations = [
        Migration(1, "甲", lambda c: None),
        Migration(1, "乙", lambda c: None),
    ]
    with pytest.raises(ValueError, match="重复"):
        migrate(conn, migrations)


def test_failing_migration_does_not_leave_a_half_applied_version(
    conn: sqlite3.Connection,
) -> None:
    def boom(connection: sqlite3.Connection) -> None:
        connection.execute("CREATE TABLE half (id INTEGER)")
        raise RuntimeError("迁移中途失败")

    with pytest.raises(RuntimeError):
        migrate(conn, [Migration(1, "会失败的迁移", boom)])

    # 失败后版本号不应前进（否则下次启动会跳过这段结构）
    assert current_version(conn) == 0


def test_meta_table_can_be_prepared_twice(conn: sqlite3.Connection) -> None:
    ensure_meta_table(conn)
    ensure_meta_table(conn)
    assert current_version(conn) == 0


# ---------------------------------------------------------------- 真实迁移的结构

def test_page_table_has_the_spec_columns(conn: sqlite3.Connection) -> None:
    """说明书 5.3 里 page 实体的字段应当都在。"""
    migrate(conn, MIGRATIONS)
    columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(page)").fetchall()
    }
    assert {
        "page_id", "page_no", "page_label", "width_pt", "height_pt",
        "rotation", "page_type", "include", "has_text_layer", "active_run_id", "note",
    } <= columns


def test_project_table_has_the_spec_columns(conn: sqlite3.Connection) -> None:
    migrate(conn, MIGRATIONS)
    columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(project)").fetchall()
    }
    assert {
        "project_id", "name", "source_file_name", "source_sha256", "page_count",
        "created_at", "updated_at", "schema_version", "settings_json",
        "last_view", "last_page_id", "last_block_id",
    } <= columns


def test_page_no_is_unique(conn: sqlite3.Connection) -> None:
    migrate(conn, MIGRATIONS)
    conn.execute(
        "INSERT INTO page (page_id, page_no, width_pt, height_pt) VALUES ('a', 1, 1, 1)"
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO page (page_id, page_no, width_pt, height_pt) VALUES ('b', 1, 1, 1)"
        )


# ---------------------------------------------------------------- 迁移 0002

def test_recognition_tables_are_created(conn: sqlite3.Connection) -> None:
    migrate(conn, MIGRATIONS)
    tables = _table_names(conn)
    assert {"ocr_run", "block", "block_line", "job", "job_item"} <= tables


@pytest.mark.parametrize(
    ("table", "columns"),
    [
        (
            "ocr_run",
            {
                "run_id", "page_id", "run_type", "engine_id", "engine_version",
                "params_json", "status", "error_code", "error_message",
                "raw_result_path", "created_at", "finished_at",
            },
        ),
        (
            "block",
            {
                "block_id", "page_id", "origin_run_id", "origin", "order_index", "bbox",
                "block_type", "ocr_text", "text", "review_status", "include",
                "continues_to_next", "confidence", "revision", "reviewed_by", "comment",
                "created_at", "updated_at", "deleted_at",
            },
        ),
        (
            "block_line",
            {"line_id", "block_id", "line_index", "bbox", "text", "aux_text", "diff_status"},
        ),
        (
            "job",
            {
                "job_id", "job_type", "status", "total", "done", "failed",
                "params_json", "created_at", "started_at", "finished_at",
            },
        ),
        (
            "job_item",
            {"item_id", "job_id", "page_id", "status", "run_id", "error_message", "attempts"},
        ),
    ],
)
def test_recognition_tables_have_the_spec_columns(
    conn: sqlite3.Connection, table: str, columns: set[str]
) -> None:
    """说明书 5.3 与 R7：双路 OCR 与协作所需字段从 Phase 2 起就建好。"""
    migrate(conn, MIGRATIONS)
    actual = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    assert columns <= actual


def test_ocr_run_status_is_constrained(conn: sqlite3.Connection) -> None:
    """状态取值用 CHECK 钉住，免得写进拼错的状态（说明书 5.3 的枚举）。"""
    migrate(conn, MIGRATIONS)
    conn.execute(
        "INSERT INTO page (page_id, page_no, width_pt, height_pt) VALUES ('p', 1, 1, 1)"
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """
            INSERT INTO ocr_run (run_id, page_id, engine_id, engine_version, status, created_at)
            VALUES ('r1', 'p', 'fake', '1', 'succeed', 'now')
            """
        )
    conn.execute(
        """
        INSERT INTO ocr_run (run_id, page_id, engine_id, engine_version, status, created_at)
        VALUES ('r2', 'p', 'fake', '1', 'succeeded', 'now')
        """
    )


# ---------------------------------------------------------------- 迁移 0006：版面

def _columns(connection: sqlite3.Connection, table: str) -> dict[str, sqlite3.Row]:
    rows = connection.execute(f"PRAGMA table_info({table})").fetchall()
    return {row["name"]: row for row in rows}


def test_layout_migration_adds_columns(conn: sqlite3.Connection) -> None:
    migrate(conn, MIGRATIONS)
    block_columns = _columns(conn, "block")
    line_columns = _columns(conn, "block_line")
    assert block_columns["layout_confirmed"]["dflt_value"] == "0"
    assert line_columns["layout_status"]["dflt_value"] == "'assigned'"


def test_layout_migration_upgrades_an_old_database_with_safe_defaults(
    conn: sqlite3.Connection,
) -> None:
    """0006 之前的库：老块默认「未确认」，老行默认 assigned，已有数据原样保留。"""
    migrate(conn, MIGRATIONS[:5])
    conn.execute(
        """
        INSERT INTO project (project_id, name, source_file_name, source_sha256,
                             page_count, created_at, updated_at, schema_version)
        VALUES ('p1', '老项目', 'old.pdf', 'x' * 64, 1,
                '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', 5)
        """
    )
    conn.execute(
        """
        INSERT INTO page (page_id, page_no, width_pt, height_pt)
        VALUES ('page1', 1, 595.0, 842.0)
        """
    )
    conn.execute(
        """
        INSERT INTO block (block_id, page_id, origin, order_index, bbox, block_type,
                           ocr_text, text, created_at, updated_at)
        VALUES ('b1', 'page1', 'ocr', 0, '[0.1,0.1,0.9,0.2]', 'paragraph',
                '旧文本', '旧文本', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')
        """
    )
    conn.execute(
        """
        INSERT INTO block_line (line_id, block_id, line_index, bbox, text)
        VALUES ('l1', 'b1', 0, '[0.1,0.1,0.9,0.2]', '旧文本')
        """
    )
    conn.commit()

    migrate(conn, MIGRATIONS)

    block = conn.execute("SELECT * FROM block WHERE block_id = 'b1'").fetchone()
    line = conn.execute("SELECT * FROM block_line WHERE line_id = 'l1'").fetchone()
    assert block["text"] == "旧文本"
    assert int(block["layout_confirmed"]) == 0
    assert line["layout_status"] == "assigned"
    assert line["text"] == "旧文本"
    # 结构版本前进了，但老数据一条没少
    assert current_version(conn) == LATEST_VERSION


# ---------------------------------------------------------------- 迁移 0007：页面确认

def test_page_confirmation_migration_defaults_to_unconfirmed(conn: sqlite3.Connection) -> None:
    migrate(conn, MIGRATIONS)
    columns = _columns(conn, "page")
    assert columns["page_confirmed"]["dflt_value"] == "0"


def test_page_confirmation_migration_upgrades_an_old_database(conn: sqlite3.Connection) -> None:
    migrate(conn, MIGRATIONS[:6])
    conn.execute(
        """
        INSERT INTO project (project_id, name, source_file_name, source_sha256,
                             page_count, created_at, updated_at, schema_version)
        VALUES ('p1', '老项目', 'old.pdf', 'x' * 64, 1,
                '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', 6)
        """
    )
    conn.execute(
        "INSERT INTO page (page_id, page_no, width_pt, height_pt) VALUES ('page1', 1, 595.0, 842.0)"
    )
    conn.commit()

    migrate(conn, MIGRATIONS)
    row = conn.execute("SELECT page_confirmed, page_type, include FROM page WHERE page_id = 'page1'").fetchone()
    assert int(row["page_confirmed"]) == 0
    assert row["page_type"] == "body"
    assert int(row["include"]) == 1


def test_page_type_migration_maps_every_old_row(conn: sqlite3.Connection) -> None:
    """迁移 0008：老库按"行为不变"映射成五类，include 与类型一致。"""
    migrate(conn, MIGRATIONS[:7])
    conn.execute(
        """
        INSERT INTO project (project_id, name, source_file_name, source_sha256,
                             page_count, created_at, updated_at, schema_version)
        VALUES ('p1', '老项目', 'old.pdf', 'x' * 64, 12,
                '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', 7)
        """
    )
    cases = [
        (1, "body", 1, "body", 1),
        (2, "cover", 0, "front", 0),
        (3, "front", 0, "front", 0),
        (4, "foreword", 0, "front", 0),
        (5, "copyright", 0, "front", 0),
        (6, "body", 0, "body_excluded", 0),
        (7, "toc", 0, "toc", 0),
        (8, "appendix", 0, "back", 0),
        (9, "index", 0, "back", 0),
        (10, "blank", 0, "back", 0),
        (11, "other", 0, "back", 0),
        # include=1 优先：旧类型是什么都归正文（行为不变）
        (12, "toc", 1, "body", 1),
    ]
    conn.executemany(
        """
        INSERT INTO page (page_id, page_no, width_pt, height_pt, page_type, include)
        VALUES (?, ?, 595.0, 842.0, ?, ?)
        """,
        [(f"page{no}", no, old_type, include) for no, old_type, include, *_ in cases],
    )
    conn.commit()

    migrate(conn, MIGRATIONS)
    rows = {
        row["page_no"]: (row["page_type"], int(row["include"]))
        for row in conn.execute("SELECT page_no, page_type, include FROM page")
    }
    for no, _old_type, _old_include, expected_type, expected_include in cases:
        assert rows[no] == (expected_type, expected_include), no
    assert len(rows) == len(cases), "迁移不丢页"
    assert conn.execute("SELECT schema_version FROM project").fetchone()[0] == LATEST_VERSION


# ---------------------------------------------------------------- 迁移 0009：整页版面确认

def test_page_layout_migration_adds_column_and_reset_triggers(
    conn: sqlite3.Connection,
) -> None:
    migrate(conn, MIGRATIONS)
    columns = _columns(conn, "page")
    assert columns["layout_confirmed"]["dflt_value"] == "0"

    conn.execute(
        """
        INSERT INTO project (project_id, name, source_file_name, source_sha256,
                             page_count, created_at, updated_at, schema_version)
        VALUES ('p1', '项目', 'p.pdf', 'x' * 64, 1,
                '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00', 9)
        """
    )
    conn.execute(
        "INSERT INTO page (page_id, page_no, width_pt, height_pt) VALUES ('page1', 1, 595, 842)"
    )
    insert_block = (
        "INSERT INTO block (block_id, page_id, origin, order_index, bbox, block_type,"
        " ocr_text, text, created_at, updated_at)"
        " VALUES (?, 'page1', 'ocr', ?, '[0.1,0.1,0.9,0.2]', 'paragraph',"
        " '文本', '文本', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')"
    )
    conn.execute(insert_block, ("b1", 0))
    conn.execute(insert_block, ("b2", 1))
    conn.commit()

    def confirmed() -> int:
        return int(
            conn.execute("SELECT layout_confirmed FROM page WHERE page_id='page1'").fetchone()[0]
        )

    def set_confirmed() -> None:
        conn.execute("UPDATE page SET layout_confirmed = 1 WHERE page_id='page1'")
        conn.commit()
        assert confirmed() == 1

    # 改文本 / 改块级 include 不算版面变化
    set_confirmed()
    conn.execute("UPDATE block SET text = '改过' WHERE block_id = 'b1'")
    conn.commit()
    assert confirmed() == 1, "改文本不该重置整页版面确认"
    conn.execute("UPDATE block SET include = 0 WHERE block_id = 'b1'")
    conn.commit()
    assert confirmed() == 1, "块级 include 不是版面"

    # 类型 / 框 / 顺序 / 软删除 / 新增块都要重置
    set_confirmed()
    conn.execute("UPDATE block SET block_type = 'header' WHERE block_id = 'b1'")
    conn.commit()
    assert confirmed() == 0, "改类型要重置"

    set_confirmed()
    conn.execute("UPDATE block SET bbox = '[0.2,0.2,0.8,0.3]' WHERE block_id = 'b1'")
    conn.commit()
    assert confirmed() == 0, "改框要重置"

    set_confirmed()
    conn.execute("UPDATE block SET order_index = 5 WHERE block_id = 'b2'")
    conn.commit()
    assert confirmed() == 0, "改顺序要重置"

    set_confirmed()
    conn.execute("UPDATE block SET deleted_at = '2026-01-02T00:00:00+00:00' WHERE block_id = 'b2'")
    conn.commit()
    assert confirmed() == 0, "软删除要重置"

    set_confirmed()
    conn.execute(insert_block, ("b3", 2))
    conn.commit()
    assert confirmed() == 0, "新增块要重置"


def test_migration_0010_adds_the_auto_apply_table(conn: sqlite3.Connection) -> None:
    """自动应用发生在识别子进程里，撤销栈在 API 进程：靠这张表把整批找回来。"""
    migrate(conn, MIGRATIONS)
    assert "auto_apply_run" in _table_names(conn)
    columns = {
        row["name"]: row["type"]
        for row in conn.execute("PRAGMA table_info(auto_apply_run)").fetchall()
    }
    for name in (
        "auto_apply_id",
        "job_id",
        "status",
        "pages",
        "blocks",
        "by_type_json",
        "created_at",
        "undone_at",
    ):
        assert name in columns, name
    # 状态只允许 applied / undone：撤销之后不许再撤一次
    conn.execute(
        "INSERT INTO auto_apply_run (auto_apply_id, job_id, status, created_at)"
        " VALUES ('x', 'j', 'applied', '2026-10-22T00:00:00+00:00')"
    )
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO auto_apply_run (auto_apply_id, job_id, status, created_at)"
            " VALUES ('y', 'j', 'whatever', '2026-10-22T00:00:00+00:00')"
        )


def test_migration_0011_adds_margin_box_columns(conn: sqlite3.Connection) -> None:
    """版心：项目级默认 + 页级三态；老行默认 inherit、不设置版心。"""
    migrate(conn, MIGRATIONS)
    project_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(project)").fetchall()
    }
    page_columns = {
        row["name"]: row["dflt_value"]
        for row in conn.execute("PRAGMA table_info(page)").fetchall()
    }
    assert "margin_box" in project_columns
    assert "margin_box" in page_columns
    assert "margin_box_mode" in page_columns
    assert page_columns["margin_box_mode"] == "'inherit'"

    # 现有行不需要回填：默认就是"沿用全局"
    conn.execute(
        "INSERT INTO page (page_id, page_no, width_pt, height_pt)"
        " VALUES ('p1', 1, 595.0, 842.0)"
    )
    row = conn.execute(
        "SELECT margin_box, margin_box_mode FROM page WHERE page_id = 'p1'"
    ).fetchone()
    assert row["margin_box"] is None
    assert row["margin_box_mode"] == "inherit"


def test_migration_0012_adds_margin_suggestion_columns(conn: sqlite3.Connection) -> None:
    """自动推算：来源 / 时间 / 最近建议三列；老行全部为 NULL（不假装是手动或自动）。"""
    migrate(conn, MIGRATIONS)
    columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(project)").fetchall()
    }
    for name in ("margin_box_source", "margin_box_set_at", "margin_box_suggestion"):
        assert name in columns, name

    conn.execute(
        "INSERT INTO project (project_id, name, source_file_name, source_sha256,"
        " page_count, created_at, updated_at, schema_version)"
        " VALUES ('p1', '测试', 'a.pdf', 'x', 1, '2026-01-01', '2026-01-01', 12)"
    )
    row = conn.execute(
        "SELECT margin_box_source, margin_box_set_at, margin_box_suggestion"
        " FROM project WHERE project_id = 'p1'"
    ).fetchone()
    assert row["margin_box_source"] is None
    assert row["margin_box_set_at"] is None
    assert row["margin_box_suggestion"] is None


def test_migration_0013_adds_printed_page_columns(conn: sqlite3.Connection) -> None:
    """页码设置：两列页面字段 + 项目级模板；老行为 NULL（没确认过模板）。"""
    migrate(conn, MIGRATIONS)
    page_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(page)").fetchall()
    }
    project_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(project)").fetchall()
    }
    assert {"printed_page", "printed_page_source"} <= page_columns
    assert "page_number_template" in project_columns

    conn.execute(
        "INSERT INTO page (page_id, page_no, width_pt, height_pt)"
        " VALUES ('p1', 1, 595.0, 842.0)"
    )
    row = conn.execute(
        "SELECT printed_page, printed_page_source FROM page WHERE page_id = 'p1'"
    ).fetchone()
    assert row["printed_page"] is None
    assert row["printed_page_source"] is None
