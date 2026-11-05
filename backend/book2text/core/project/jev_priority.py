"""Jev 审校队列排序：行级可疑度打分（2026-11-05）。

**它做什么**：只对「两引擎分歧」的行（`diff_status ∈ {differs_chars, differs_punct}`）打分。
Jev（MiniCPM-OCR-Jev）给出「候选文本与原图一致的概率」`prob_1`（0–1，**越低越可疑**），
写进 `block_line.jev_score`。排序由查询侧 opt-in（默认顺序逐字不变），本模块只负责"算分"。

**默认关、手动触发**：`job_type = "jev_priority"` 的后台任务，不进识别链路。
建任务前先探测引擎 / 打分服务 / 模型文件，缺什么就报什么、不建任务（队列不动）。

**行图口径（锁死，否则分数不可比）**：`block_line.bbox`（归一化）× 200 DPI 渲染整页、
**不扩边**裁切；候选文本渲染成同宽高、白底、宋体、字号 `int(h*0.72)`、起点 `(6, (h-size)//2)`。
2026-10-28 那轮实验用的是「RapidOCR 行框 + 外扩 2%」，与这份不是同一口径，分数不能混用。

**配置（环境变量，全部可选）**：

- `B2T_JEV_ENGINE_URL`  llama.cpp 基址（默认 `http://127.0.0.1:18499`）
- `B2T_JEV_SCORE_URL`   打分服务基址（默认 `http://127.0.0.1:18501`）
- `B2T_JEV_MODEL_DIR`   两个 gguf 所在目录（探测模型文件必需）
- `B2T_JEV_FONT`        候选文本字体（默认 macOS 宋体）
- `B2T_JEV_BATCH`       每批条数（默认 32：CPU 下 64 条要 178 s，会超服务端 120 s 超时）
"""

from __future__ import annotations

import base64
import io
import json
import os
import shutil
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

from PIL import Image, ImageDraw, ImageFont

from ..export import header_cleanup
from ..ocr import compare as compare_module
from ..pdf import render as render_module
from ..storage import db as db_module
from ..storage.ulid import new_ulid
from . import blocks as blocks_module
from . import jev_health
from . import jobs as jobs_module
from . import library as library_module
from . import recognition as recognition_module
from . import review_status

JOB_TYPE_JEV = "jev_priority"
JOB_LABEL = "Jev 可疑度打分"

#: 分数语义：`prob_1` ≤ 这个值算"可疑"（配方实测 0.05：标 86 行 / 真错 39 条 / 精确率 45.3%）
DEFAULT_THRESHOLD = 0.05
#: 每批条数：CPU 下 64 条要 178 s > 服务端 120 s 超时；32 条约 89 s
DEFAULT_BATCH = 32
DEFAULT_DPI = 200
#: 只给"分歧行"打分（format_only / identical 没有可看的差别）
SCORED_STATUSES = ("differs_chars", "differs_punct")

DEFAULT_FONT = "/System/Library/Fonts/Supplemental/Songti.ttc"


class JevUnavailable(RuntimeError):
    """环境不具备跑 Jev 的条件（缺引擎 / 缺模型 / 缺字体）。**不降级、不建任务。**"""


@dataclass(frozen=True)
class JevConfig:
    engine_url: str = "http://127.0.0.1:18499"
    score_url: str = "http://127.0.0.1:18501"
    model_dir: Path | None = None
    font_path: str = DEFAULT_FONT
    batch_size: int = DEFAULT_BATCH
    timeout: float = 120.0

    @classmethod
    def from_env(cls) -> "JevConfig":
        model_dir = os.environ.get("B2T_JEV_MODEL_DIR")
        return cls(
            engine_url=os.environ.get("B2T_JEV_ENGINE_URL", "http://127.0.0.1:18499").rstrip("/"),
            score_url=os.environ.get("B2T_JEV_SCORE_URL", "http://127.0.0.1:18501").rstrip("/"),
            model_dir=Path(model_dir) if model_dir else None,
            font_path=os.environ.get("B2T_JEV_FONT", DEFAULT_FONT),
            batch_size=max(1, min(32, int(os.environ.get("B2T_JEV_BATCH", DEFAULT_BATCH)))),
            timeout=float(os.environ.get("B2T_JEV_TIMEOUT", "120")),
        )


# ---------------------------------------------------------------- 探测


def probe(config: JevConfig | None = None, *, runtime=None) -> list[str]:
    """建任务前的检查：返回**缺什么**（空列表 = 可以跑）。

    **"能不能打分"的判据只有一处**：`jev_health`（第 1–3 步，含拿固定 fixture 真打一次分）。
    这里不再自己查引擎 / 打分服务 / 模型文件——那份重复实现正是上一轮 bug 的形状。

    唯一额外的一条是**字体**：它不影响"引擎能不能打分"，但影响"候选文本能不能渲染出来"
    （打分要拿渲染图去比），所以放在建任务的前置里，且文案里说清是字体问题。
    """
    cfg = config or JevConfig.from_env()
    verdict = (
        runtime.check()
        if runtime is not None
        else jev_health.check_urls(
            cfg.engine_url, cfg.score_url, model_dir=cfg.model_dir, timeout=cfg.timeout
        )
    )
    problems = verdict.problems()
    if not Path(cfg.font_path).is_file():
        problems.append(f"候选文本字体缺失：{cfg.font_path}（B2T_JEV_FONT，渲染候选用）")
    return problems


def runnable(config: JevConfig) -> tuple[bool, list[str]]:
    problems = probe(config)
    return (not problems, problems)


# ---------------------------------------------------------------- 选行与建任务


@dataclass(frozen=True)
class TargetLine:
    line_id: str
    block_id: str
    page_no: int
    page_index: int
    block_order: int
    line_index: int
    bbox: tuple[float, float, float, float]
    text: str


def target_lines(project_id: str, *, library: Path | None = None) -> list[TargetLine]:
    """队列里的行：**与 `review_status.queue_items` 同一判据、同一份 marks**。

    2026-11-05 实测对账：早先按 `block_line.text` 自己扫，比队列多 1 行——
    那一行块的**当前文本**已经被人工改成与第二引擎一致（mark 消失），
    而行记录还是旧文本。所以这里改用 `divergence_index` 的 marks：
    块 include / 块类型 / 页 include / 版心内 / 整行页码噪声，全部与队列同源；
    `text` 取 mark 的当前文本（用户看到的），不是行记录的旧文本。
    """
    target_library = library if library is not None else library_module.default_library_dir()
    index = blocks_module.divergence_index(project_id, library=target_library)
    pages = library_module.list_pages(project_id, library=target_library)
    page_by_id = {page.page_id: page for page in pages}
    rows: list[TargetLine] = []
    for block in index.blocks:
        if not block.include:
            continue
        if block.block_type not in review_status.QUEUE_BLOCK_TYPES:
            continue
        page = page_by_id.get(block.page_id)
        if page is None or not page.include:
            continue
        divergence = index.by_block.get(block.block_id)
        if divergence is None:
            continue
        line_by_index = {
            line.line_index: line for line in index.lines_by_block.get(block.block_id, [])
        }
        for mark in divergence.marks:
            if mark.level not in SCORED_STATUSES:
                continue
            if review_status._is_page_number_mark(mark, line_by_index):
                continue
            if not index.inside(block):
                continue
            line = line_by_index.get(mark.line_index)
            if line is None or line.bbox is None:
                continue
            page_index = page.pdf_page_index if page.pdf_page_index is not None else page.page_no - 1
            rows.append(
                TargetLine(
                    line_id=line.line_id,
                    block_id=block.block_id,
                    page_no=page.page_no,
                    page_index=int(page_index),
                    block_order=int(block.order_index),
                    line_index=int(mark.line_index),
                    bbox=tuple(float(value) for value in line.bbox),
                    text=mark.current,
                )
            )
    rows.sort(key=lambda item: (item.page_no, item.block_order, item.line_index))
    return rows


def create_job(
    project_id: str,
    *,
    library: Path | None = None,
    config: JevConfig | None = None,
    runtime=None,
) -> jobs_module.JobRecord:
    """建一个 Jev 打分任务（按页一个单元，可暂停 / 取消 / 续跑）。

    三道前置检查，任一不过都**不建任务**（队列不动）：
    1. 有分歧行且都有第二引擎文本（否则提示"先跑第二引擎"）；
    2. 引擎 / 打分服务 / 模型文件 / 字体都在（否则列出缺什么）；
    3. 同一项目已有活跃任务（任务机制一次只跑一个）。
    """
    target_library = library if library is not None else library_module.default_library_dir()
    cfg = config or JevConfig.from_env()
    rows = target_lines(project_id, library=target_library)
    if not rows:
        raise JevUnavailable("这个项目没有可打分的分歧行：先跑第二引擎，让差异队列里出现汉字/标点差异")
    problems = probe(cfg, runtime=runtime)
    if problems:
        raise JevUnavailable("；".join(problems))
    directory = library_module.require_project_dir(project_id, library=target_library)
    if jobs_module.active_job(directory) is not None:
        raise jobs_module.JobError("已经有任务在跑，等它结束再建 Jev 打分任务")
    pages = sorted({item.page_no for item in rows})
    page_ids = {
        page.page_no: page.page_id
        for page in library_module.list_pages(project_id, library=target_library)
    }
    job = jobs_module.create_job(
        directory,
        pages=[(page_ids[no], no) for no in pages],
        params={
            "dpi": DEFAULT_DPI,
            "batch": cfg.batch_size,
            "threshold": DEFAULT_THRESHOLD,
            "model_dir": str(cfg.model_dir) if cfg.model_dir else None,
            "font": cfg.font_path,
        },
        job_type=JOB_TYPE_JEV,
    )
    return job


# ---------------------------------------------------------------- 渲染与打分


def candidate_png(text: str, size: tuple[int, int], font_path: str) -> bytes:
    """候选文本 → 同宽高白底 PNG（字号 / 起点按配方锁死）。"""
    width, height = size
    image = Image.new("RGB", (max(1, width), max(1, height)), (255, 255, 255))
    draw = ImageDraw.Draw(image)
    font_size = max(8, int(height * 0.72))
    try:
        font = ImageFont.truetype(font_path, font_size)
    except OSError as exc:  # pragma: no cover - 字体在探测阶段已经检查
        raise JevUnavailable(f"候选文本字体打不开：{font_path}（{exc}）") from exc
    draw.text((6, (height - font_size) // 2), text, fill=(0, 0, 0), font=font)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def crop_line(page_image: Image.Image, bbox: Sequence[float]) -> Image.Image:
    """按归一化 bbox 裁行图（**不扩边**）。"""
    width, height = page_image.size
    x0, y0, x1, y1 = (float(value) for value in bbox)
    box = (
        max(0, min(width - 1, int(x0 * width))),
        max(0, min(height - 1, int(y0 * height))),
        max(1, min(width, int(x1 * width))),
        max(1, min(height, int(y1 * height))),
    )
    return page_image.crop(box)


def _b64(png: bytes) -> str:
    return base64.b64encode(png).decode("ascii")


def score_batch(config: JevConfig, items: list[dict[str, str]]) -> list[float | None]:
    """POST /v1/score（一批 ≤32 条），返回每条的 `prob_1`（error 的条目给 None）。"""
    payload = json.dumps({"items": items}, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"{config.score_url}/v1/score",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=config.timeout) as response:
            data = json.loads(response.read())
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise JevUnavailable(f"Jev 打分请求失败：{exc}") from exc
    results = data.get("results") or []
    scores: list[float | None] = []
    for index in range(len(items)):
        item = results[index] if index < len(results) else None
        if not item or item.get("prob_1") is None:
            scores.append(None)
        else:
            scores.append(float(item["prob_1"]))
    return scores


# ---------------------------------------------------------------- 任务执行


def run_job(
    directory: Path,
    job: jobs_module.JobRecord,
    *,
    config: JevConfig | None = None,
    scorer: Callable[[JevConfig, list[dict[str, str]]], list[float | None]] | None = None,
    renderer: Callable[[Path, int, int], Image.Image] | None = None,
    should_continue: Callable[[], str] | None = None,
    log: Callable[[str], None] | None = None,
) -> recognition_module.JobOutcome:
    """逐页打分。**中断 / 失败时已写的分数保留**（不清列，也不回滚）。"""
    cfg = config or JevConfig.from_env()
    score = scorer or score_batch
    render_page = renderer or (lambda source, index, dpi: render_module.render_page_image(source, index, dpi=dpi))
    log = log or (lambda message: None)

    source = directory / library_module.SOURCE_DIR_NAME / library_module.SOURCE_FILE_NAME
    jobs_module.set_status(directory, job.job_id, jobs_module.STATUS_RUNNING)
    items = jobs_module.list_job_items(directory, job.job_id)
    page_nos = _page_nos(directory, [item.page_id for item in items])
    project_id = _project_id(directory)
    wanted_pages = set(page_nos.values())
    targets = [
        row for row in target_lines(project_id, library=directory.parent) if row.page_no in wanted_pages
    ]
    by_page: dict[int, list[TargetLine]] = {}
    for row in targets:
        by_page.setdefault(row.page_no, []).append(row)

    failed = False
    try:
        for item in items:
            if item.status not in ("queued", "failed"):
                continue
            page_no = page_nos.get(item.page_id)
            if page_no is None:
                continue
            rows = by_page.get(page_no, [])
            decision = should_continue() if should_continue else recognition_module.DECISION_RUN
            if decision != recognition_module.DECISION_RUN:
                if decision == recognition_module.DECISION_PAUSE:
                    jobs_module.set_status(directory, job.job_id, jobs_module.STATUS_PAUSED)
                return _outcome(directory, job.job_id)
            _mark_item(directory, item.item_id, "running")
            try:
                _score_page(directory, page_no, rows, source, cfg, score, render_page, log)
            except Exception as exc:  # 单页失败：记下来，继续下一页；最后任务标 failed
                failed = True
                _mark_item(directory, item.item_id, "failed", str(exc))
                log(f"page {page_no} jev failed")
                continue
            _mark_item(directory, item.item_id, "succeeded")
            jobs_module.update_progress(directory, job.job_id)
    finally:
        jobs_module.update_progress(directory, job.job_id)
    jobs_module.set_status(
        directory,
        job.job_id,
        jobs_module.STATUS_FAILED if failed else jobs_module.STATUS_SUCCEEDED,
    )
    return _outcome(directory, job.job_id)


def _score_page(
    directory: Path,
    page_no: int,
    rows: list[TargetLine],
    source: Path,
    config: JevConfig,
    scorer: Callable[[JevConfig, list[dict[str, str]]], list[float | None]],
    renderer: Callable[[Path, int, int], Image.Image],
    log: Callable[[str], None],
) -> None:
    if not rows:
        return
    page_index = rows[0].page_index
    image = renderer(source, page_index, DEFAULT_DPI)
    try:
        batch: list[TargetLine] = []
        for position in range(0, len(rows), config.batch_size):
            batch = rows[position:position + config.batch_size]
            payload = []
            for row in batch:
                crop = crop_line(image, row.bbox)
                payload.append({
                    "original_image": _b64(_png_bytes(crop)),
                    "render_image": _b64(candidate_png(row.text, crop.size, config.font_path)),
                    "ocr_text": row.text,
                })
            scores = scorer(config, payload)
            _write_scores(directory, batch, scores)
        log(f"page {page_no} jev {len(rows)} lines")
    finally:
        image.close()


def _png_bytes(image: Image.Image) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _write_scores(directory: Path, rows: list[TargetLine], scores: list[float | None]) -> None:
    with db_module.open_database(directory, apply_migrations=False) as conn:
        for row, score in zip(rows, scores):
            if score is None:
                continue
            conn.execute(
                "UPDATE block_line SET jev_score = ? WHERE line_id = ?", (score, row.line_id)
            )
        conn.commit()


# ---------------------------------------------------------------- 查询与清除


def scored_counts(project_id: str, *, library: Path | None = None) -> dict[str, int]:
    """`{"scored": n, "diffs": m}`：有分数的行数 / 分歧行总数（界面提示条用）。"""
    directory = library_module.require_project_dir(project_id, library=library)
    with db_module.open_database(directory, apply_migrations=False) as conn:
        scored = conn.execute(
            "SELECT COUNT(*) AS n FROM block_line WHERE jev_score IS NOT NULL"
        ).fetchone()["n"]
        # 列里只有三态（differs）；chars/punct 是现算的（见模块头）。
        diffs = conn.execute(
            "SELECT COUNT(*) AS n FROM block_line WHERE diff_status = 'differs'"
        ).fetchone()["n"]
    return {"scored": int(scored), "diffs": int(diffs)}


def clear_scores(project_id: str, *, library: Path | None = None, actor_name: str | None = None) -> int:
    """一键清除：清列 + 写一条 event（清完逐行回原顺序 = 查询侧不再有分数）。"""
    directory = library_module.require_project_dir(project_id, library=library)
    now = _now()
    batch_id = new_ulid()
    with db_module.open_database(directory, apply_migrations=False) as conn:
        scored = conn.execute(
            "SELECT COUNT(*) AS n FROM block_line WHERE jev_score IS NOT NULL"
        ).fetchone()["n"]
        if scored:
            conn.execute("UPDATE block_line SET jev_score = NULL WHERE jev_score IS NOT NULL")
            conn.execute(
                """
                INSERT INTO event (event_id, batch_id, entity_type, entity_id, action,
                                   before_json, after_json, actor, actor_name, package_id, created_at)
                VALUES (?, ?, 'project', ?, 'jev_priority_cleared', ?, '{}', 'user', ?, NULL, ?)
                """,
                (new_ulid(), batch_id, project_id, json.dumps({"scored": int(scored)}), actor_name, now),
            )
        conn.commit()
    return int(scored)


# ---------------------------------------------------------------- 小工具


def _now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _page_nos(directory: Path, page_ids: list[str]) -> dict[str, int]:
    if not page_ids:
        return {}
    with db_module.open_database(directory, apply_migrations=False) as conn:
        placeholders = ",".join("?" for _ in page_ids)
        rows = conn.execute(
            f"SELECT page_id, page_no FROM page WHERE page_id IN ({placeholders})", page_ids
        ).fetchall()
    return {row["page_id"]: int(row["page_no"]) for row in rows}


def _project_id(directory: Path) -> str:
    with db_module.open_database(directory, apply_migrations=False) as conn:
        row = conn.execute("SELECT project_id FROM project LIMIT 1").fetchone()
    return str(row["project_id"])


def _mark_item(directory: Path, item_id: str, status: str, message: str | None = None) -> None:
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE job_item SET status = ?, error_message = ? WHERE item_id = ?",
            (status, message, item_id),
        )
        if status == "running":
            conn.execute("UPDATE job_item SET attempts = attempts + 1 WHERE item_id = ?", (item_id,))
        conn.commit()


def _outcome(directory: Path, job_id: str) -> recognition_module.JobOutcome:
    return recognition_module.JobOutcome(
        job=jobs_module.get_job(directory, job_id),
        items=tuple(jobs_module.list_job_items(directory, job_id)),
    )


# ---------------------------------------------------------------- 排序（查询侧 opt-in）


def line_scores(project_id: str, *, library: Path | None = None) -> dict[tuple[str, int], float]:
    """`(block_id, line_index) → jev_score`（只含有分数的行）。"""
    directory = library_module.require_project_dir(project_id, library=library)
    with db_module.open_database(directory, apply_migrations=False) as conn:
        rows = conn.execute(
            "SELECT block_id, line_index, jev_score FROM block_line WHERE jev_score IS NOT NULL"
        ).fetchall()
    return {
        (str(row["block_id"]), int(row["line_index"])): float(row["jev_score"]) for row in rows
    }


def latest_job_status(project_id: str, *, library: Path | None = None) -> str | None:
    """最近一次 Jev 打分任务的状态（队列排序只在它 succeeded 时才允许开启）。"""
    directory = library_module.require_project_dir(project_id, library=library)
    try:
        found = jobs_module.list_jobs(directory, limit=50)
    except jobs_module.JobError:
        return None
    for job in found:
        if job.job_type == JOB_TYPE_JEV:
            return job.status
    return None


def sort_ready(project_id: str, *, library: Path | None = None) -> tuple[bool, str]:
    """现在能不能按 Jev 排序：**跑一半失败时不排**（队列退回原顺序）。

    分数在失败时会保留（下一轮续跑不用重算），但"队列被我改过顺序"这件事
    必须以"这一轮跑完了"为前提，否则用户看到的是一个半成品顺序。
    """
    status = latest_job_status(project_id, library=library)
    if status == jobs_module.STATUS_SUCCEEDED:
        return True, ""
    if status is None:
        return False, "还没有跑过 Jev 打分"
    return False, f"最近一次 Jev 打分没有跑完（{status}）"


def tier_key(
    score: float | None,
    *,
    page_no: int,
    block_order: int,
    line_index: int,
    threshold: float = DEFAULT_THRESHOLD,
) -> tuple[int, int, int, int]:
    """三档排序键：可疑（有分数且 ≤ 阈值）> 其余分歧行 > 无分歧，同档内按文流顺序。

    分数**只用于分档**，不参与档内排序（配方：同档按 页码 → 块序 → 行序）。
    「无分歧」这一档在审校队列里通常不出现（队列本身只收分歧行），保留它是为了让
    这个键在别的列表上也能用，语义不随调用点变。
    """
    if score is None:
        tier = 1  # 有分歧但没打分（旧数据 / 只跑了一半）
    elif score <= threshold:
        tier = 0
    else:
        tier = 1
    return (tier, page_no, block_order, line_index)
