#!/usr/bin/env python
"""Jev 排序验收的跑分器（2026-11-05）。

**它不造指标**：命中率（前 50 / 前 100 行里有多少是真错）要拿金标准逐行判，
那是 OCREval/QA 的口径（45.3% vs 28% 那组数）。这里只做三件确定性的事——

1. `--check`：探测引擎 / 打分服务 / 模型 / 字体，缺什么逐条列出来（缺就不跑）；
2. `--run`：直接建并跑一次 `jev_priority` 任务（进程内，不起服务），把分数写进库；
3. `--dump-out`：导出**两种顺序**（正文流原顺序 / Jev 排序后）的完整行表给验收方：
   每行带 page_no / block_id / line_index / jev_score / 该行 A 文本 / 第二引擎 B 文本。

用法::

    PYTHONPATH=backend .venv/bin/python scripts/accept_jev.py --check \
        --project ~/Documents/Book2Text/b2t_H6GXVG
    PYTHONPATH=backend .venv/bin/python scripts/accept_jev.py --run --dump-out /tmp/jev-orders.json \
        --project ~/Documents/Book2Text/b2t_H6GXVG
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from book2text.core.project import blocks as blocks_module
from book2text.core.project import jev_priority as jev
from book2text.core.project import jobs as jobs_module
from book2text.core.project import library as library_module
from book2text.core.storage import db as db_module


def resolve_project(project: str, library: str | None) -> tuple[Path, str]:
    path = Path(project).expanduser()
    if (path / "project.db").is_file():
        return path.parent, path.name
    if library:
        candidate = Path(library).expanduser() / project
        if (candidate / "project.db").is_file():
            return candidate.parent, project
    raise SystemExit(f"找不到项目：{project}（给项目目录，或 --library + 项目 id）")


def check(config: jev.JevConfig) -> int:
    problems = jev.probe(config)
    if not problems:
        print("✔ 环境齐：打分服务 / llama.cpp / 模型文件 / 字体都在")
        return 0
    print("✖ 环境不齐，缺：")
    for item in problems:
        print(f"  · {item}")
    return 2


def run_once(library: Path, project_id: str, config: jev.JevConfig) -> int:
    job = jev.create_job(project_id, library=library, config=config)
    print(f"任务 {job.job_id}：{job.total} 页 · 开始打分")
    outcome = jev.run_job(library / project_id, job, config=config, log=print)
    print(f"结果：{outcome.job.status}")
    counts = jev.scored_counts(project_id, library=library)
    print(f"有分数的行：{counts['scored']} / 分歧行 {counts['diffs']}")
    return 0 if outcome.job.status in jobs_module.SUCCESS_TERMINAL_STATUSES else 1


def dump_orders(library: Path, project_id: str, out: Path) -> int:
    rows = jev.target_lines(project_id, library=library)
    scores = jev.line_scores(project_id, library=library)
    texts = _line_texts(project_id, library)
    payload = {
        "schema": "book2text.jev-orders.v1",
        "project_id": project_id,
        "threshold": jev.DEFAULT_THRESHOLD,
        "baseline": [
            _row(row, scores, texts) for row in rows
        ],
        "jev_sorted": [
            _row(row, scores, texts)
            for row in sorted(
                rows,
                key=lambda item: (
                    jev.tier_key(
                        scores.get((item.block_id, item.line_index)),
                        page_no=item.page_no,
                        block_order=item.block_order,
                        line_index=item.line_index,
                    )[0],
                    item.page_no,
                    item.block_order,
                    item.line_index,
                ),
            )
        ],
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"两种顺序已写出：{out}（{len(rows)} 行）")
    return 0


def _row(row, scores, texts) -> dict[str, object]:
    key = (row.block_id, row.line_index)
    text, aux = texts.get(row.line_id, (row.text, ""))
    return {
        "page_no": row.page_no,
        "block_id": row.block_id,
        "block_order": row.block_order,
        "line_index": row.line_index,
        "line_id": row.line_id,
        "jev_score": scores.get(key),
        "text": text,
        "aux_text": aux,
    }


def _line_texts(project_id: str, library: Path) -> dict[str, tuple[str, str]]:
    out: dict[str, tuple[str, str]] = {}
    for page in library_module.list_pages(project_id, library=library):
        for line in blocks_module.list_block_lines(project_id, library=library, page_no=page.page_no):
            out[line.line_id] = (line.text or "", line.aux_text or "")
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Jev 排序验收跑分器")
    parser.add_argument("--project", required=True)
    parser.add_argument("--library")
    parser.add_argument("--check", action="store_true", help="只探测环境")
    parser.add_argument("--run", action="store_true", help="建并跑一次打分任务")
    parser.add_argument("--dump-out", help="把两种顺序写成 JSON")
    args = parser.parse_args(argv)

    library, project_id = resolve_project(args.project, args.library)
    # 与"用户打开项目"同一行为：先跑迁移（0024 只加一列）。老库没有 jev_score 时
    # 任何查询都会 no such column，所以这一步必须在 --check 之外的动作用之前。
    with db_module.open_database(library / project_id):
        pass
    config = jev.JevConfig.from_env()
    if args.check:
        return check(config)
    status = 0
    if args.run:
        status = run_once(library, project_id, config)
    if args.dump_out:
        status = max(status, dump_orders(library, project_id, Path(args.dump_out).expanduser()))
    if not (args.check or args.run or args.dump_out):
        parser.error("至少给一个动作：--check / --run / --dump-out")
    return status


if __name__ == "__main__":
    sys.exit(main())
