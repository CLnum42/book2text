"""基线「三元组」的前两层指纹：输入层 + 管线层。

拆模块是「行为保持不变」的重构，所以对照基线之前必须先证明**输入没变、管线没变**，
否则读数一漂就分不清是拆错了还是输入换了（662 页那本书有 3 个副本，块数 4851/3325/3325，
同名不同副本，只认 source_sha256 会漏掉后两个）。

三层定义（与 `samples/README.md`、`baseline-run-2026-10-28/BASELINE.md` 同一套说法）：

  输入层    source_sha256 / 源文件字节 / 页数 / 有文字层页数 / 正文块数 / 正文字符数
            —— 与代码版本无关；变了就是输入变了，不是回归。
  管线层    导出预检的正文流（段数 / 字数 / 正文页 / 跨块合并 / 断词还原 / 未审段）
            + 审校队列（总数 / 汉字 / 标点 / 已裁决）
            —— 用**当前代码**在同一份输入上现算；变了要么管线改了，要么输入改了。
  前端层    队列 859(567+292)、进度 0/567、三步页号、导出文件字节与 sha
            —— 只能由真实界面跑出来（smoke / pagesync / 导出两次），本模块不伪造。

判据：输入层与管线层逐字段**全等**才允许拿基线做对照；任何一项不等位 = 不许对照
（`qa.py up` 直接拒，`qa.py fingerprint` 退出码 1），换输入必须单开新基线并标「输入变更」。
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND = REPO_ROOT / "backend"
DEFAULT_BASELINE = REPO_ROOT / "samples" / "baseline-input.json"

#: 基线文件可用环境变量覆盖（红测、以及将来第二份基线用）。
BASELINE_ENV = "B2T_QA_BASELINE_INPUT"

_EXPORT: Any = None
_MARKS: Any = None


def baseline_path() -> Path:
    return Path(os.environ.get(BASELINE_ENV) or DEFAULT_BASELINE)


def load_baseline(path: Path | None = None) -> dict[str, Any]:
    target = path or baseline_path()
    return json.loads(target.read_text(encoding="utf-8"))


def _backend() -> tuple[Any, Any]:
    """只在需要时 import 后端做离线复算（不依赖服务在跑）。"""
    global _EXPORT, _MARKS
    if _EXPORT is None or _MARKS is None:
        if str(BACKEND) not in sys.path:
            sys.path.insert(0, str(BACKEND))
        from book2text.core.export import project as export_project
        from book2text.core.project import reading_marks

        _EXPORT, _MARKS = export_project, reading_marks
    return _EXPORT, _MARKS


def input_layer(project_id: str, library: Path) -> dict[str, Any]:
    """直接读库，不碰后端代码——代码怎么改都不该影响这一层。"""
    db = library / project_id / "project.db"
    if not db.is_file():
        raise FileNotFoundError(f"没有项目库：{db}")
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as conn:
        row = conn.execute(
            "select source_sha256, page_count, source_file_name from project "
            "where project_id = ?",
            (project_id,),
        ).fetchone()
        if row is None:
            raise RuntimeError(f"project 表里没有 {project_id}：{db}")
        blocks, chars = conn.execute(
            "select count(*), coalesce(sum(length(text)), 0) from block "
            "where deleted_at is null and include = 1"
        ).fetchone()
        text_pages = conn.execute(
            "select count(*) from page where has_text_layer = 1"
        ).fetchone()[0]
        total_pages = conn.execute("select count(*) from page").fetchone()[0]
    source = library / project_id / "source" / "original.pdf"
    return {
        "source_sha256": row[0],
        "source_file": row[2],
        "source_bytes": source.stat().st_size if source.is_file() else None,
        "page_count": row[1],
        "pages_in_db": total_pages,
        "text_pages": text_pages,
        "blocks": blocks,
        "chars": chars,
    }


def pipeline_layer(project_id: str, library: Path) -> dict[str, Any]:
    """用当前工作区代码在同一份输入上现算导出预检 + 审校队列。"""
    export_project, reading_marks = _backend()
    pre = export_project.preflight(
        project_id, library=library, options=export_project.ExportOptions()
    )
    marks = reading_marks.marks_data(project_id, library=library)
    counts = marks["counts"]
    return {
        "body_segments": pre["segment_count"],
        "body_chars": pre["char_count"],
        "body_pages": pre["page_count"],
        "merged_segments": pre["merged_segments"],
        "hyphenations": pre["hyphenations_restored"],
        "unreviewed_segments": pre["unreviewed_segments"],
        "queue_total": counts["total"],
        "queue_chars": counts["chars_total"],
        "queue_punct": counts["punct_total"],
        "queue_acked": counts["acked"],
    }


def compute(project_id: str, library: Path) -> dict[str, Any]:
    return {
        "project_id": project_id,
        "input": input_layer(project_id, library),
        "pipeline": pipeline_layer(project_id, library),
    }


def diff(expected: dict[str, Any], actual: dict[str, Any]) -> list[dict[str, Any]]:
    """逐字段比，返回所有不等位（不短路：一次报全，省得来回跑）。"""
    drift: list[dict[str, Any]] = []
    for layer in ("input", "pipeline"):
        want = expected.get(layer) or {}
        got = actual.get(layer) or {}
        for field, value in want.items():
            if got.get(field) != value:
                drift.append(
                    {"layer": layer, "field": field, "expected": value, "actual": got.get(field)}
                )
    return drift


def format_drift(drift: list[dict[str, Any]]) -> str:
    lines = [
        f"  {item['layer']:8s} {item['field']:22s} 基线 {item['expected']!r} → 实测 {item['actual']!r}"
        for item in drift
    ]
    return "输入/管线指纹不符：\n" + "\n".join(lines)
