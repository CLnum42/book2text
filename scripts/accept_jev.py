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

from book2text.core.ocr import compare
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


def dump_orders(library: Path, project_id: str, out: Path, gold: Path | None = None) -> int:
    rows = [row for row in jev.target_lines(project_id, library=library) if row.line_id not in _acked(project_id, library)]
    scores = jev.line_scores(project_id, library=library)
    texts = _line_texts(project_id, library)
    gold_norm = _gold_text(gold)
    payload = {
        "schema": "book2text.jev-orders.v2",
        # 字段说明见 docs/qa/2026-11-05-jev-orders-schema.md；两种顺序的每一行结构相同：
        # line_id / page_no / block_order / line_index / jev_score / text / aux_text /
        # is_error / is_error_method
        "project_id": project_id,
        "threshold": jev.DEFAULT_THRESHOLD,
        "queue_lines": len(rows),
        "gold": None if gold is None else {"file": gold.name, "is_error_method": "normalized_substring"},
        "baseline": [
            _row(row, scores, texts, gold_norm) for row in rows
        ],
        "jev_sorted": [
            _row(row, scores, texts, gold_norm)
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


def _row(row, scores, texts, gold_norm: str | None) -> dict[str, object]:
    """一行在验收 JSON 里的形状（**字段名就是契约**，见 schema 文档）。"""
    key = (row.block_id, row.line_index)
    text, aux = texts.get(row.line_id, (row.text, ""))
    is_error = None
    method = None
    if gold_norm is not None:
        line_norm = compare.normalize_for_comparison(text or "", keep_newlines=False)
        is_error = bool(line_norm) and line_norm not in gold_norm
        method = "normalized_substring"
    return {
        "line_id": row.line_id,
        "page_no": row.page_no,
        "block_order": row.block_order,
        "line_index": row.line_index,
        "jev_score": scores.get(key),
        "text": text,
        "aux_text": aux,
        "is_error": is_error,
        "is_error_method": method,
    }


def _acked(project_id: str, library: Path) -> set[str]:
    """已裁决的行不进队列（与 next-lines 同一口径）。"""
    directory = library / project_id
    with db_module.open_database(directory, apply_migrations=False) as conn:
        rows = conn.execute(
            "SELECT line_id FROM block_line WHERE diff_ack IS NOT NULL"
        ).fetchall()
    return {str(row["line_id"]) for row in rows}


def _gold_text(gold: Path | None) -> str | None:
    if gold is None:
        return None
    text = Path(gold).expanduser().read_text(encoding="utf-8-sig")
    if "未经逐页确认" in text[:500]:
        raise SystemExit(f"{gold.name} 是分页草稿（文件头写着未经逐页确认），不能当金标准")
    return compare.normalize_for_comparison(text, keep_newlines=False)


def _line_texts(project_id: str, library: Path) -> dict[str, tuple[str, str]]:
    out: dict[str, tuple[str, str]] = {}
    for page in library_module.list_pages(project_id, library=library):
        for line in blocks_module.list_block_lines(project_id, library=library, page_no=page.page_no):
            out[line.line_id] = (line.text or "", line.aux_text or "")
    return out


def _config_from_args(args: argparse.Namespace) -> jev.JevConfig:
    """配置来源：环境变量打底，CLI 显式覆盖。

    OCREval 的模型和服务不在本项目目录里（2.7 GB 不进仓库），所以**任何路径都不许硬编码**：
    它用自己的 `B2T_JEV_MODEL_DIR` / `B2T_JEV_SCORE_URL`，或者直接给这里的参数。
    """
    base = jev.JevConfig.from_env()
    return jev.JevConfig(
        engine_url=(args.engine_url or base.engine_url).rstrip("/"),
        score_url=(args.score_url or base.score_url).rstrip("/"),
        model_dir=Path(args.model_dir).expanduser() if args.model_dir else base.model_dir,
        font_path=args.font or base.font_path,
        batch_size=max(1, min(32, args.batch or base.batch_size)),
        timeout=base.timeout,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Jev 排序验收跑分器")
    parser.add_argument("--project", required=True)
    parser.add_argument("--library")
    parser.add_argument("--check", action="store_true", help="只探测环境")
    parser.add_argument("--run", action="store_true", help="建并跑一次打分任务")
    parser.add_argument("--dump-out", help="把两种顺序写成 JSON")
    parser.add_argument("--gold", help="可选：金标准整本拼接版，用来给每行标 is_error")
    parser.add_argument("--score-url", help="覆盖 B2T_JEV_SCORE_URL（打分服务基址）")
    parser.add_argument("--engine-url", help="覆盖 B2T_JEV_ENGINE_URL（llama.cpp 基址）")
    parser.add_argument("--model-dir", help="覆盖 B2T_JEV_MODEL_DIR（两个 gguf 所在目录）")
    parser.add_argument("--font", help="覆盖 B2T_JEV_FONT（候选文本字体）")
    parser.add_argument("--batch", type=int, help="覆盖 B2T_JEV_BATCH（每批条数，上限 32）")
    args = parser.parse_args(argv)

    library, project_id = resolve_project(args.project, args.library)
    # 与"用户打开项目"同一行为：先跑迁移（0024 只加一列）。老库没有 jev_score 时
    # 任何查询都会 no such column，所以这一步必须在 --check 之外的动作用之前。
    with db_module.open_database(library / project_id):
        pass
    config = _config_from_args(args)
    if args.check:
        return check(config)
    status = 0
    if args.run:
        status = run_once(library, project_id, config)
    if args.dump_out:
        status = max(
            status,
            dump_orders(
                library,
                project_id,
                Path(args.dump_out).expanduser(),
                Path(args.gold).expanduser() if args.gold else None,
            ),
        )
    if not (args.check or args.run or args.dump_out):
        parser.error("至少给一个动作：--check / --run / --dump-out")
    return status


if __name__ == "__main__":
    sys.exit(main())
