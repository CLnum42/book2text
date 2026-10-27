"""识别一页并落库（说明书 5.3 的数据模型 + 5.4 的 R1 / R2）。

一次识别在数据库里留下五条记录，它们回答的是五个不同的问题：

====================  ==========================================================
``job``               这次操作是什么（谁发起、共几页、成没成）
``job_item``          任务里的这一页（状态、关联到哪次运行、失败原因）
``ocr_run``           哪个引擎、什么参数、耗时多久、原始输出存在哪
``block``             当前有效的块（文本、类型、坐标、审校状态）
``block_line``        块内每一行（行级坐标，供框选联动与按行比对）
====================  ==========================================================

**两条业务规则（说明书 5.4）**

- **R1 首次识别：** 页面没有 active run 时，运行成功后自动设为 active，并生成块。
- **R2 重新识别：** 页面已有 active run 时——
  没有任何人工成果（没确认过、没改过、没调整过结构）→ 直接替换：旧块**软删除**，
  新块入库，active run 换成新的；
  已有人工成果 → **只保存为待选结果**，不碰块、不换 active run
  （"系统绝不自动覆盖人工成果"）。页面的"有待选新结果"状态由 `blocks.py` 推导，
  采用 / 保留的对比界面属于 Phase 3（说明书 6.4）。

**两条入口，职责分开：**

- `create_ocr_job()`：在**服务进程**里建任务（校验页面、锁、引擎可用性），不做识别。
- `run_job()`：**在子进程里**逐页识别并落库（`book2text.worker` 调它），
  也可以在同进程里跑（测试用假引擎走的就是这条）。为什么要子进程见
  `core/jobs/executor.py`：峰值内存约 2.7 GB、要能取消、引擎崩了不该带走应用。

父子之间**只通过数据库交换状态**（任务状态就是控制信号：暂停就写 paused，
取消就写 cancelled），因此哪一边重启都不会丢进度。

**原始输出**写在 ``ocr_runs/<run_id>.json``：引擎给出的行（文本 + 归一化坐标 +
置信度）与引擎自己的元数据。它记录的是**适配器取到的输出**，不是引擎内部对象。
路径以**相对项目目录**的形式入库，整包拷贝到另一台机器仍然有效（说明书第 10 节）。
"""

from __future__ import annotations

import json
import math
import os
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from ..ocr.adapters import RapidOcrAdapter
from ..ocr.adapters.apple_vision import AppleVisionAdapter
from ..ocr import compare as compare_module
from ..ocr import text_layer as text_layer_module
from ..ocr.base import BBox, OcrEngine, OcrEngineError, OcrLine, OcrParams, OcrResult
from ..pdf import render
from ..storage import db as db_module
from ..storage.ulid import new_ulid
from ..structure import grouping
from . import blocks as blocks_module
from . import jobs as jobs_module
from . import lock as lock_module
from . import workflow as workflow_module
from .library import (
    OCR_RUNS_DIR_NAME,
    SOURCE_DIR_NAME,
    SOURCE_FILE_NAME,
    Page,
    ProjectError,
    default_library_dir,
    get_settings,
    list_pages,
    load_project,
    project_dir,
)

RAW_SCHEMA_ID = "book2text.ocr-run.v1"

# 识别用的渲染 DPI。说明书 8.2 要求"DPI 默认值由样本测试决定"——
# 40 页真书实测：200 DPI 的正文 CER 0.71%，300 DPI 是 0.94%（漏识 62 vs 94 字）。
# 机理是检测模型对输入尺寸敏感：同一行在 150/200/400 DPI 检出、在 250/300/500 漏掉。
# **这是单本书的结论**，换书 / 换扫描质量需要复核（见 docs/ocr-evaluation.md 6.6）。
DEFAULT_DPI = 200
DEFAULT_LANGUAGE = "ch"
MIN_DPI = 72
MAX_DPI = 600

# 识别设置（任务 54）：项目级默认值，建任务时读取并写进 job.params_json。
# 这里只放"用什么引擎 / 什么参数"，不放 UI 文案。
ENGINE_RAPIDOCR = "rapidocr"
ENGINE_APPLE_VISION = "apple_vision"
ENGINE_DUAL = "dual"
DEFAULT_ENGINE = ENGINE_RAPIDOCR
RECOGNITION_ENGINES = (ENGINE_RAPIDOCR, ENGINE_APPLE_VISION, ENGINE_DUAL)
# 界面上给的三个 DPI 档（接口仍接受 72–600 的任意值，与旧客户端兼容）
RECOGNITION_LANGUAGES = ("ch", "en", "mixed")
DUAL_STRATEGIES = ("mark", "candidates")
DEFAULT_DUAL_STRATEGY = "mark"


def adapter_for_engine(engine_id: str) -> OcrEngine:
    """引擎标识 → 适配器。``dual`` 的第一路固定是 RapidOCR，第二路见复核模块。"""
    if engine_id in (ENGINE_RAPIDOCR, ENGINE_DUAL):
        return RapidOcrAdapter()
    if engine_id == ENGINE_APPLE_VISION:
        return AppleVisionAdapter()
    raise ProjectError(
        f"未知的识别引擎：{engine_id!r}（可选：{'、'.join(RECOGNITION_ENGINES)}）"
    )


def recognition_settings(project_id: str, *, library: Path | None = None) -> dict[str, object]:
    """项目级识别设置 + 默认值（坏值退回默认，不让一个脏设置挡住识别）。"""
    settings = get_settings(project_id, library=library)
    engine = settings.get("recognition_engine")
    if engine not in RECOGNITION_ENGINES:
        engine = DEFAULT_ENGINE
    dpi = settings.get("recognition_dpi")
    if not isinstance(dpi, int) or isinstance(dpi, bool) or not MIN_DPI <= dpi <= MAX_DPI:
        dpi = DEFAULT_DPI
    language = settings.get("recognition_language")
    if language not in RECOGNITION_LANGUAGES:
        language = DEFAULT_LANGUAGE
    strategy = settings.get("dual_engine_strategy")
    if strategy not in DUAL_STRATEGIES:
        strategy = DEFAULT_DUAL_STRATEGY
    return {
        "recognition_engine": engine,
        "recognition_dpi": dpi,
        "recognition_language": language,
        "dual_engine_strategy": strategy,
    }

# 行图外扩比例（说明书 8.5：外扩约 2% 以保留笔画）
AUX_LINE_PADDING = 0.02

# 送 OCR 引擎的最小裁图边长（像素）。RapidOCR / ONNX Runtime 在退化的小图上会在
# native 层直接段错误（exit 139），Python 的 try/except 捕不到——只能在送进去之前挡掉。
# 真书第 34 页在裁图 A/B 实验里触发过一次；隔离复现时同一张图单独跑又正常，
# 所以这里按"最小尺寸 + RGB"做底线防护，不假装能修好引擎本身的崩溃。
CROP_MIN_PX = 8

ORIGIN_OCR = "ocr"
REVIEW_UNREVIEWED = "unreviewed"

# 失败原因的分类（写进 ocr_run.error_code 与 job_item.error_message）
ERROR_RENDER_FAILED = "render_failed"
ERROR_OCR_FAILED = "ocr_failed"
ERROR_PERSIST_FAILED = "persist_failed"


class EngineUnavailable(ProjectError):
    """OCR 引擎不可用。

    这是**服务器能力**问题，不是页面问题：调用方应据此提示安装依赖（说明书 1.6），
    因此单独成类，接口层映射成 503 而不是 400。
    """

    def __init__(self, reason: str) -> None:
        super().__init__(f"OCR 引擎不可用：{reason}。安装后重试：uv sync --group ocr-eval")
        self.reason = reason


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_run_result(directory: Path, run: blocks_module.RunRecord) -> dict:
    """读一次运行的原始输出（`ocr_runs/<run_id>.json`），给出它的块与行。

    R2 的"待选结果"不生成块，但用户对比之后要能**原样采用**他看过的那一份分组，
    因此文件里存了分段结果；早期没有这个字段（`blocks`）的运行退化为在这里重新分段。
    """
    if not run.raw_result_path:
        raise ProjectError(f"这次运行没有原始输出：{run.run_id}")
    path = directory / run.raw_result_path
    if not path.is_file():
        raise ProjectError(f"找不到原始输出文件：{run.raw_result_path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ProjectError(f"原始输出文件读不出来：{exc}") from exc

    lines = payload.get("lines") or []
    stored = payload.get("blocks")
    if stored:
        blocks = [
            {
                "order_index": int(item["order_index"]),
                "bbox": item.get("bbox"),
                "block_type": item.get("block_type") or "paragraph",
                "text": item.get("text") or "",
                "line_indexes": list(item.get("line_indexes") or []),
            }
            for item in stored
        ]
    else:
        # 早期文件没有分段结果：按当前规则重新分一次（可能与用户当时看到的略有出入）
        ocr_lines = [
            OcrLine(
                text=str(item.get("text", "")),
                bbox=BBox(*[float(value) for value in item["bbox"]]),
                confidence=item.get("confidence"),
            )
            for item in lines
            if item.get("bbox")
        ]
        layout = grouping.group_lines(ocr_lines)
        blocks = [
            {
                "order_index": block.order_index,
                "bbox": block.bbox.as_list() if block.bbox else None,
                "block_type": block.block_type,
                "text": block.text,
                "line_indexes": [index for index, line in enumerate(ocr_lines) if line in block.lines],
            }
            for block in layout.blocks
        ]
    return {
        "run_id": run.run_id,
        "engine_id": payload.get("engine_id") or run.engine_id,
        "engine_version": payload.get("engine_version") or run.engine_version,
        "page_no": payload.get("page_no"),
        "line_count": len(lines),
        "lines": lines,
        "blocks": blocks,
        "regrouped": not bool(stored),
    }


# ---------------------------------------------------------------- 建任务（服务进程）

# 批量识别的两种范围（说明书 6.3："选中页或全部纳入页；已有识别结果的页面默认跳过"）
SCOPE_UNRECOGNIZED = "unrecognized"
SCOPE_ALL = "all"
SCOPES = (SCOPE_UNRECOGNIZED, SCOPE_ALL)


# 已有**可用识别结果**的状态：说明书 6.3 说批量识别"已有识别结果的页面默认跳过"
STATUSES_WITH_RESULT = (
    blocks_module.STATUS_RECOGNIZED,
    blocks_module.STATUS_HAS_CANDIDATE,
)


def resolve_pages(
    project_id: str,
    *,
    library: Path | None = None,
    pages: Sequence[int] | None = None,
    scope: str | None = None,
    skip_recognized: bool = True,
) -> list[Page]:
    """把"要识别哪些页"解析成页面列表。

    - 显式页码：必须存在且已纳入（排除的页不参与识别，界面上也是这么说的）。
    - ``scope="unrecognized"``：全部纳入页里**没有可用识别结果**的（未识别或上次失败）。
    - ``scope="all"``：全部纳入页（重新识别，适用规则 R2）。
    - ``skip_recognized``：显式页码时是否跳过已识别的页（默认跳过，与说明书 6.3 一致；
      单页"重新识别"按钮会显式传 False）。
    """
    if (pages is None) == (scope is None):
        raise ProjectError("pages 与 scope 必须给出且只给出一个")
    if scope is not None and scope not in SCOPES:
        raise ProjectError(f"未知的范围：{scope!r}（可选：{'、'.join(SCOPES)}）")

    target_library = library if library is not None else default_library_dir()
    all_pages = list_pages(project_id, library=target_library)
    states = blocks_module.page_recognition_states(project_id, library=target_library)

    def usable_result(page: Page) -> bool:
        state = states.get(page.page_id)
        return state is not None and state.status in STATUSES_WITH_RESULT

    if scope is not None:
        selected = []
        for page in all_pages:
            if not page.include:
                continue
            if scope == SCOPE_ALL:
                selected.append(page)
                continue
            state = states.get(page.page_id)
            status = state.status if state else blocks_module.STATUS_UNRECOGNIZED
            if status in (blocks_module.STATUS_UNRECOGNIZED, blocks_module.STATUS_FAILED):
                selected.append(page)
        return selected

    by_no = {page.page_no: page for page in all_pages}
    selected = []
    for page_no in pages or ():
        page = by_no.get(page_no)
        if page is None:
            raise ProjectError(f"没有第 {page_no} 页")
        if not page.include:
            raise ProjectError(
                f"第 {page_no} 页不是「正文」类型，不参与识别。把类型改成「正文」再识别"
            )
        if skip_recognized and usable_result(page):
            continue
        selected.append(page)
    return selected


def create_ocr_job(
    project_id: str,
    *,
    library: Path | None = None,
    pages: Sequence[int] | None = None,
    scope: str | None = None,
    skip_recognized: bool = True,
    dpi: int | None = None,
    language: str | None = None,
    engine: str | None = None,
) -> jobs_module.JobRecord:
    """建一个识别任务（不执行）。执行由 `core/jobs/executor.py` 起子进程完成。

    **识别设置在这里真正生效**（任务 54）：``dpi`` / ``language`` / ``engine`` 没显式给时，
    读项目设置里用户选的默认值；三者都写进 `job.params_json`，子进程按它挑适配器与参数。
    显式参数仍然优先（接口 / 测试 / 旧客户端可以覆盖）。
    """
    target_library = library if library is not None else default_library_dir()
    directory = project_dir(target_library, project_id)

    # 识别要写数据库。若项目正被**另一个应用实例**打开（项目锁，说明书 7.6），
    # 这里拒绝，避免两个进程同时写同一个库。
    lock_status = lock_module.status(directory)
    if lock_status.held and not lock_status.mine:
        raise ProjectError(
            f"{lock_status.describe()}。识别会写入项目数据库，"
            "请先在那边关闭项目，或在本窗口用「强制打开」"
        )

    # 识别要写库，因此这里应用迁移（与读取路径相反，见 blocks.py 的说明）
    load_project(project_id, library=target_library)

    # 项目设置里的识别默认值：在锁检查之后读（不在别人正开着的库上跑迁移）
    settings = recognition_settings(project_id, library=target_library)
    engine_setting = engine or str(settings["recognition_engine"])
    if engine_setting not in RECOGNITION_ENGINES:
        raise ProjectError(
            f"未知的识别引擎：{engine_setting!r}（可选：{'、'.join(RECOGNITION_ENGINES)}）"
        )
    dpi = int(dpi if dpi is not None else settings["recognition_dpi"])
    language = str(language if language is not None else settings["recognition_language"])
    if not MIN_DPI <= dpi <= MAX_DPI:
        raise ProjectError(f"DPI 必须在 {MIN_DPI}–{MAX_DPI} 之间，收到 {dpi}")

    selected = resolve_pages(
        project_id,
        library=target_library,
        pages=pages,
        scope=scope,
        skip_recognized=skip_recognized,
    )
    if not selected:
        raise ProjectError(
            "没有需要识别的页面（已识别的页会跳过，排除的页不参与）"
            + ("——要去掉「跳过已识别的页」的勾选才会重新识别它们" if pages else "")
        )

    running = jobs_module.active_job(directory)
    if running is not None:
        raise ProjectError(
            f"已经有一个识别任务在进行中（{running.status}，"
            f"{running.done + running.failed}/{running.total}）。"
            "说明书 6.3 规定默认只跑 1 个 OCR 子进程：先暂停或取消它，再建新任务"
        )

    adapter = adapter_for_engine(engine_setting)
    available, reason = adapter.available()
    if not available:
        # 引擎不可用是环境问题，不该建出一个注定失败的任务
        raise EngineUnavailable(f"{engine_setting} 不可用：{reason}")

    params: dict[str, object] = {
        "dpi": dpi,
        "language": language,
        "engine_id": adapter.engine_id,
        # 项目设置的原值也记下来：任务载荷里能看出"这次是不是双引擎 / 选的哪个引擎"
        "engine_setting": engine_setting,
    }
    if engine_setting == ENGINE_DUAL:
        secondary = default_secondary_engine()
        second_ok, second_reason = secondary.available()
        if not second_ok:
            raise EngineUnavailable(
                f"双引擎比对需要第二引擎（{secondary.engine_id}）：{second_reason}"
            )
        params["secondary_engine_id"] = secondary.engine_id

    return jobs_module.create_job(
        directory,
        pages=[(page.page_id, page.page_no) for page in selected],
        params=params,
    )


# ---------------------------------------------------------------- 辅助识别（说明书 8.5 / R1b）

AUX_ENGINE_ID = "apple_vision"


def default_secondary_engine() -> OcrEngine:
    """按平台挑第二引擎（说明书 8.5 要求"独立血统"）。

    macOS 上是系统自带的 Apple Vision；Windows 的系统 OCR 还没实现（L-13）。
    """
    return AppleVisionAdapter()


# 批量复核的两种范围（说明书 8.5："可以随时对已识别的页面单独补跑或重跑"）
SCOPE_UNCHECKED = "unchecked"
AUX_SCOPES = (SCOPE_UNCHECKED, SCOPE_ALL)


def resolve_aux_pages(
    project_id: str,
    *,
    library: Path | None = None,
    pages: Sequence[int] | None = None,
    scope: str | None = None,
    skip_checked: bool = True,
) -> list[Page]:
    """把"要复核哪些页"解析成页面列表（说明书 8.5）。

    **只有已有第一引擎结果的页才能复核**——第二引擎读的是第一引擎切出的行图，
    没识别过就没有行可读，界面上要如实说清而不是建一个注定失败的任务。

    - 显式页码：必须存在、已纳入、且已有识别结果。
    - ``scope="unchecked"``：全部纳入页里**已识别但还没复核过**的。
    - ``scope="all"``：全部纳入页里已识别的（重新复核）。
    - ``skip_checked``：显式页码时是否跳过已复核的页（默认跳过；
      界面上的「重新复核这一页」会显式传 False）。
    """
    if (pages is None) == (scope is None):
        raise ProjectError("pages 与 scope 必须给出且只给出一个")
    if scope is not None and scope not in AUX_SCOPES:
        raise ProjectError(f"未知的范围：{scope!r}（可选：{'、'.join(AUX_SCOPES)}）")

    target_library = library if library is not None else default_library_dir()
    all_pages = list_pages(project_id, library=target_library)
    states = blocks_module.page_recognition_states(project_id, library=target_library)
    checked = blocks_module.pages_with_auxiliary_run(project_id, library=target_library)

    def has_result(page: Page) -> bool:
        state = states.get(page.page_id)
        return state is not None and state.status in STATUSES_WITH_RESULT

    if scope is not None:
        selected = []
        for page in all_pages:
            if not page.include or not has_result(page):
                continue
            if scope == SCOPE_UNCHECKED and page.page_id in checked:
                continue
            selected.append(page)
        return selected

    by_no = {page.page_no: page for page in all_pages}
    selected = []
    for page_no in pages or ():
        page = by_no.get(page_no)
        if page is None:
            raise ProjectError(f"没有第 {page_no} 页")
        if not page.include:
            raise ProjectError(
                f"第 {page_no} 页不是「正文」类型，不参与复核。把类型改成「正文」再复核"
            )
        if not has_result(page):
            raise ProjectError(
                f"第 {page_no} 页还没有第一引擎的识别结果——"
                "第二引擎读的是第一引擎切出的行图，先识别再复核"
            )
        if skip_checked and page.page_id in checked:
            continue
        selected.append(page)
    return selected


def create_auxiliary_job(
    project_id: str,
    *,
    library: Path | None = None,
    pages: Sequence[int] | None = None,
    scope: str | None = None,
    skip_checked: bool = True,
    engine: OcrEngine | None = None,
) -> jobs_module.JobRecord:
    """建一个第二引擎复核任务（不执行；说明书 8.5 / R1b）。

    与识别任务（`create_ocr_job`）形状完全一样：按页一个单元，因此**暂停 / 继续 /
    取消 / 重试失败页 / 中断恢复全都能用**（说明书 6.3 的那一套）。
    """
    target_library = library if library is not None else default_library_dir()
    directory = project_dir(target_library, project_id)

    lock_status = lock_module.status(directory)
    if lock_status.held and not lock_status.mine:
        raise ProjectError(
            f"{lock_status.describe()}。复核会写入项目数据库，"
            "请先在那边关闭项目，或在本窗口用「强制打开」"
        )

    load_project(project_id, library=target_library)

    selected = resolve_aux_pages(
        project_id,
        library=target_library,
        pages=pages,
        scope=scope,
        skip_checked=skip_checked,
    )
    if not selected:
        raise ProjectError(
            "没有需要复核的页面（已复核的页会跳过，未识别的页不参与）"
            + ("——要去掉「跳过已复核的页」的勾选才会重新复核它们" if pages else "")
        )

    running = jobs_module.active_job(directory)
    if running is not None:
        raise ProjectError(
            f"已经有一个任务在进行中（{running.status}，"
            f"{running.done + running.failed}/{running.total}）。"
            "说明书 6.3 规定默认只跑 1 个 OCR 子进程：先暂停或取消它，再建新任务"
        )

    secondary = engine or default_secondary_engine()
    # 任务 58：这些页都带文字层时不需要第二引擎——文字层本身就是某一版 OCR 的结果。
    # 只有真要去跑 Vision 的页才检查引擎可用性。
    needs_engine = any(not page.has_text_layer for page in selected)
    if needs_engine:
        available, reason = secondary.available()
        if not available:
            # 第二引擎不可用是环境问题（说明书 8.6：要明确显示"第二意见不可用"，
            # 也不能假装还在比对），不该建出一个注定失败的任务
            raise EngineUnavailable(f"第二引擎（{secondary.engine_id}）不可用：{reason}")

    return jobs_module.create_job(
        directory,
        pages=[(page.page_id, page.page_no) for page in selected],
        params={
            "engine_id": secondary.engine_id if needs_engine else TEXT_LAYER_ENGINE_ID,
            "scope": scope or "pages",
        },
        job_type=jobs_module.JOB_TYPE_AUXILIARY,
    )


def _current_line_text(block_text: str | None, line_index: int, fallback: str | None) -> str:
    """块里现在这一行的文本；行号对不上时退回行记录自己的 text。"""
    lines = (block_text or "").split("\n")
    if 0 <= line_index < len(lines):
        return lines[line_index]
    return fallback or ""


# 文字层当第二引擎时写进 ocr_run.engine_id 的标记（与真正的引擎区分开）
TEXT_LAYER_ENGINE_ID = "pdf_text_layer"
TEXT_LAYER_ENGINE_VERSION = "pdf-text-layer"


def _append_aux_result(results: list[dict], counts: dict, row, aux_text: str) -> None:
    """一条行级复核结果：比对状态 + 是否"已确认保留"（与原来的写法逐字一致）。"""
    status = (
        compare_module.compare_line(row["text"] or "", aux_text)
        if aux_text
        else compare_module.DIFFERS
    )
    counts[status] = counts.get(status, 0) + 1
    results.append(
        {
            "line_id": row["line_id"],
            "block_id": row["block_id"],
            "line_index": int(row["line_index"]),
            "text": row["text"] or "",
            "aux_text": aux_text,
            "diff_status": status,
            "ack_keep": bool(
                row["diff_ack"]
                and row["diff_ack_text"] is not None
                and _current_line_text(
                    row["block_text"], int(row["line_index"]), row["text"]
                )
                == row["diff_ack_text"]
            ),
        }
    )


def run_auxiliary(
    directory: Path,
    page_no: int,
    *,
    engine: OcrEngine | None = None,
    prefer_text_layer: bool = False,
) -> dict:
    """用第二引擎逐行复核一页（说明书 8.5 / R1b）。

    **按第一引擎切出的行图识别**（说明书 8.5 原话）：把每个 `BlockLine` 的 bbox
    外扩约 2% 裁成小图，交给第二引擎认这一行，然后与第一引擎的文本比对，
    结果写进 `BlockLine.aux_text` 与 `diff_status`。

    **不生成块**（说明书 8.5：第二引擎只作为行级候选）。辅助识别可以随时重跑，
    不影响 `Block.text`、审校状态与导出。
    """
    source = directory / SOURCE_DIR_NAME / SOURCE_FILE_NAME
    run_id = new_ulid()
    now = _now()

    with db_module.open_database(directory, apply_migrations=False) as conn:
        page = conn.execute("SELECT * FROM page WHERE page_no = ?", (page_no,)).fetchone()
        if page is None:
            raise ProjectError(f"没有第 {page_no} 页")
        active = conn.execute(
            "SELECT * FROM ocr_run WHERE run_id = ?", (page["active_run_id"],)
        ).fetchone()
        if active is None:
            raise ProjectError("这一页还没有第一引擎的结果，先识别再复核")
        lines = conn.execute(
            """
            SELECT l.line_id, l.block_id, l.line_index, l.bbox, l.text,
                   l.diff_ack, l.diff_ack_text, b.text AS block_text
            FROM block_line l JOIN block b ON b.block_id = l.block_id
            WHERE b.page_id = ? AND b.deleted_at IS NULL
            ORDER BY b.order_index, l.line_index
            """,
            (page["page_id"],),
        ).fetchall()
        if not lines:
            raise ProjectError("这一页没有可复核的行（块里没有行记录）")

        # 用第一引擎那次的 DPI 渲染：行框是那一次量出来的，换 DPI 就对不上了
        primary_params = json.loads(active["params_json"] or "{}")
        dpi = int(primary_params.get("dpi") or DEFAULT_DPI)

    # ---- 文字层优先（任务 58）--------------------------------------------
    # 可搜索 PDF 的文字层就是某一版 OCR 的结果（这本书是用户自己用 Apple Vision
    # 做的），拿它当第二意见，比再跑一遍同样的模型快几十分钟。
    text_lines: list[text_layer_module.TextLayerLine] = []
    # `prefer_text_layer`：生产任务（批量复核 / 单页复核）打开，有文字层就读文字层；
    # 显式注入引擎的调用（测试 / 诊断要指定"这一遍用谁"）默认不打开。
    if prefer_text_layer and page["has_text_layer"]:
        try:
            raw_lines = render.page_text_lines(source, page_no - 1) or []
        except render.PdfError:
            raw_lines = []
        text_lines = [text_layer_module.TextLayerLine(text, tuple(bbox)) for text, bbox in raw_lines]

    secondary = None
    if text_lines:
        engine_id = TEXT_LAYER_ENGINE_ID
        engine_version = TEXT_LAYER_ENGINE_VERSION
    else:
        secondary = engine or default_secondary_engine()
        available, reason = secondary.available()
        if not available:
            raise EngineUnavailable(f"第二引擎（{secondary.engine_id}）不可用：{reason}")
        engine_id = secondary.engine_id
        engine_version = secondary.version()

    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            """
            INSERT INTO ocr_run (
                run_id, page_id, run_type, engine_id, engine_version, params_json,
                status, created_at
            ) VALUES (?, ?, 'auxiliary', ?, ?, ?, 'running', ?)
            """,
            (
                run_id,
                page["page_id"],
                engine_id,
                engine_version,
                json.dumps(
                    {
                        "dpi": dpi,
                        "scope": "block_lines",
                        "source": "text_layer" if text_lines else "engine",
                    },
                    ensure_ascii=False,
                ),
                now,
            ),
        )
        conn.commit()

    results: list[dict] = []
    counts = {
        compare_module.IDENTICAL: 0,
        compare_module.FORMAT_ONLY_DIFFERS: 0,
        compare_module.DIFFERS: 0,
    }
    started_clock = datetime.now(timezone.utc)

    if text_lines:
        # 文字层当第二引擎：按阅读顺序 + 文本相似度配对，坐标只验证（见 ocr/text_layer.py）
        row_dicts = [
            {
                "text": row["text"] or "",
                "bbox": blocks_module.bbox_from_json(row["bbox"]),
            }
            for row in lines
        ]
        aux_texts = text_layer_module.align_rows(row_dicts, text_lines)
        for row, aux_text in zip(lines, aux_texts):
            _append_aux_result(results, counts, row, aux_text)
    else:
        try:
            image = render.render_page_image(source, page_no - 1, dpi=dpi)
        except render.PdfError as exc:
            _fail_auxiliary(directory, run_id, ERROR_RENDER_FAILED, str(exc))
            raise ProjectError(f"这一页渲染失败：{exc}") from exc
        try:
            for row in lines:
                bbox = blocks_module.bbox_from_json(row["bbox"])
                aux_text = ""
                if bbox is not None:
                    crop = _crop_line(image, blocks_module.BBox(*bbox))
                    if crop is not None:  # 退化 / 过小的行框不送引擎（native 崩溃风险）
                        try:
                            aux_text = _read_one_line(secondary, crop)
                        finally:
                            crop.close()
                _append_aux_result(results, counts, row, aux_text)
        finally:
            image.close()

    elapsed = (datetime.now(timezone.utc) - started_clock).total_seconds()
    raw_path = directory / OCR_RUNS_DIR_NAME / f"{run_id}.json"
    try:
        raw_path.write_text(
            json.dumps(
                {
                    "schema": RAW_SCHEMA_ID,
                    "run_id": run_id,
                    "run_type": "auxiliary",
                    "page_no": page_no,
                    "engine_id": engine_id,
                    "engine_version": engine_version,
                    "source": "text_layer" if text_lines else "engine",
                    "dpi": dpi,
                    "line_count": len(results),
                    "line_results": [
                        {
                            "block_id": item["block_id"],
                            "line_index": item["line_index"],
                            "text": item["text"],
                            "aux_text": item["aux_text"],
                            "diff_status": item["diff_status"],
                        }
                        for item in results
                    ],
                },
                ensure_ascii=False,
                indent=2,
                default=str,
            ),
            encoding="utf-8",
        )
    except OSError as exc:
        _fail_auxiliary(directory, run_id, ERROR_PERSIST_FAILED, f"写辅助识别输出失败：{exc}")
        raise ProjectError(f"写辅助识别输出失败：{exc}") from exc

    with db_module.open_database(directory, apply_migrations=False) as conn:
        for item in results:
            conn.execute(
                """
                UPDATE block_line
                SET aux_text = ?, diff_status = ?,
                    diff_ack = CASE WHEN ? THEN diff_ack ELSE NULL END,
                    diff_ack_text = CASE WHEN ? THEN diff_ack_text ELSE NULL END
                WHERE line_id = ?
                """,
                (
                    item["aux_text"],
                    item["diff_status"],
                    1 if item["ack_keep"] else 0,
                    1 if item["ack_keep"] else 0,
                    item["line_id"],
                ),
            )
        conn.execute(
            """
            UPDATE ocr_run SET status = 'succeeded', finished_at = ?, elapsed_seconds = ?,
                               raw_result_path = ?
            WHERE run_id = ?
            """,
            (_now(), round(elapsed, 3), f"{OCR_RUNS_DIR_NAME}/{run_id}.json", run_id),
        )
        conn.execute("UPDATE project SET updated_at = ?", (_now(),))
        conn.commit()

    return {
        "run_id": run_id,
        "engine_id": engine_id,
        "engine_version": engine_version,
        "source": "text_layer" if text_lines else "engine",
        "page_no": page_no,
        "dpi": dpi,
        "line_count": len(results),
        "identical": counts.get(compare_module.IDENTICAL, 0),
        "format_only_differs": counts.get(compare_module.FORMAT_ONLY_DIFFERS, 0),
        "differs": counts.get(compare_module.DIFFERS, 0),
        "elapsed_seconds": round(elapsed, 3),
        "raw_result_path": f"{OCR_RUNS_DIR_NAME}/{run_id}.json",
        "differences": [item for item in results if item["diff_status"] != compare_module.IDENTICAL],
    }


# ---------------------------------------------------------------- 框选区域局部识别

# 框选识别用 zoom 档渲染：与用户放大看到的画面同源（说明书 5.2 的归一化坐标）
REGION_DPI = 300
# 裁切时外扩约 2%（与第二引擎的行图同一口径，保留笔画）
REGION_PADDING = 0.02


def recognize_region(
    source: Path,
    page_index: int,
    bbox,
    *,
    engine: OcrEngine | None = None,
) -> dict:
    """框选一块区域**只识别这一块**（说明书 6.4 漏检补救的第一步）。

    **不落库：** 这个函数拿不到项目目录，也从不打开数据库——它只做
    "渲染 → 裁切 → 识别 → 坐标映射"。结果交给界面填进「框选新增块」的输入框，
    用户确认后才走现有的新增块接口。这样"局部重识别"不会产生第二份块、不会改
    任何行记录，也不会出现在任务历史里。

    坐标映射：裁图是整页 300 DPI 渲染图上的一个像素矩形 `(left, top, right, bottom)`；
    引擎返回的行框是**相对裁图**的 0–1 坐标。映射回整页：

        page_x0 = (left + line.x0 * (right - left)) / page_width
        page_y0 = (top + line.y0 * (bottom - top)) / page_height

    外扩的 2% 也会一起映射，所以返回的行框可能比自己框选的区域略大——这是对的，
    它对应的是"这一片纸面"，不是"用户拖的矩形"。
    """
    if len(bbox) != 4:
        raise ProjectError("框必须是 4 个数：x0, y0, x1, y1")
    try:
        x0, y0, x1, y1 = (float(value) for value in bbox)
    except (TypeError, ValueError) as exc:
        raise ProjectError("框的坐标必须是数字") from exc
    if not all(math.isfinite(value) for value in (x0, y0, x1, y1)):
        raise ProjectError("框的坐标必须是有限数字")
    if min(x0, y0, x1, y1) < 0 or max(x0, y0, x1, y1) > 1:
        raise ProjectError("框的坐标必须落在 0–1（相对页面显示方向）")
    if x1 - x0 <= 0 or y1 - y0 <= 0:
        raise ProjectError("框的宽和高都要大于 0")
    if x1 - x0 < 0.002 or y1 - y0 < 0.002:
        raise ProjectError("框太小了：横竖都至少要有千分之二")

    adapter: OcrEngine = engine if engine is not None else RapidOcrAdapter()
    available, reason = adapter.available()
    if not available:
        raise EngineUnavailable(reason)

    try:
        image = render.render_page_image(source, page_index, dpi=REGION_DPI)
    except render.PdfError as exc:
        raise ProjectError(f"这一页渲染失败：{exc}") from exc

    try:
        page_width, page_height = image.size
        expanded = blocks_module.BBox(x0, y0, x1, y1).expanded(REGION_PADDING)
        left = max(0, math.floor(expanded.x0 * page_width) - 2)
        top = max(0, math.floor(expanded.y0 * page_height) - 2)
        right = min(page_width, math.ceil(expanded.x1 * page_width) + 2)
        bottom = min(page_height, math.ceil(expanded.y1 * page_height) + 2)
        if right <= left or bottom <= top:  # pragma: no cover - 上面已经挡掉退化框
            raise ProjectError("框太小了，裁不出图")
        if right - left < CROP_MIN_PX or bottom - top < CROP_MIN_PX:
            raise ProjectError(
                f"框太小了：裁出来不足 {CROP_MIN_PX}×{CROP_MIN_PX} 像素，"
                "识别引擎在这种图上可能直接崩溃"
            )
        crop = image.crop((left, top, right, bottom))
        if crop.mode not in ("RGB", "L"):  # pragma: no cover - 渲染出来就是 RGB
            crop = crop.convert("RGB")
        crop_width, crop_height = right - left, bottom - top
        try:
            started = time.perf_counter()
            try:
                result = adapter.recognize(crop, OcrParams(dpi=REGION_DPI))
            except OcrEngineError as exc:
                raise ProjectError(f"识别失败：{exc}") from exc
            elapsed = time.perf_counter() - started
        finally:
            crop.close()
    finally:
        image.close()

    lines: list[dict] = []
    for line in result.lines:
        text = line.text or ""
        if not text.strip():
            continue
        lines.append(
            {
                "text": text,
                "bbox": [
                    round(min(max((left + line.bbox.x0 * crop_width) / page_width, 0.0), 1.0), 6),
                    round(min(max((top + line.bbox.y0 * crop_height) / page_height, 0.0), 1.0), 6),
                    round(min(max((left + line.bbox.x1 * crop_width) / page_width, 0.0), 1.0), 6),
                    round(min(max((top + line.bbox.y1 * crop_height) / page_height, 0.0), 1.0), 6),
                ],
                "confidence": line.confidence,
            }
        )
    # 阅读顺序：从上到下、从左到右
    lines.sort(key=lambda item: (round(item["bbox"][1], 3), item["bbox"][0]))
    return {
        "text": "\n".join(item["text"] for item in lines),
        "lines": lines,
        "engine_id": result.engine_id,
        "engine_version": result.engine_version,
        "dpi": REGION_DPI,
        "elapsed_seconds": round(elapsed, 3),
        "crop_bbox": [
            round(left / page_width, 6),
            round(top / page_height, 6),
            round(right / page_width, 6),
            round(bottom / page_height, 6),
        ],
    }


def _crop_line(image, bbox: blocks_module.BBox):
    """按行框裁一张小图（说明书 8.5：外扩约 2% 以保留笔画）。

    退化 / 过小的行框返回 None（调用方按"这一行没读出"处理），**不送 OCR 引擎**：
    见 `CROP_MIN_PX` 的说明，native 崩溃无法用异常兜住。
    """
    width, height = image.size
    expanded = bbox.expanded(AUX_LINE_PADDING)
    left = max(0, int(expanded.x0 * width) - 2)
    top = max(0, int(expanded.y0 * height) - 2)
    right = min(width, int(expanded.x1 * width) + 2)
    bottom = min(height, int(expanded.y1 * height) + 2)
    if right - left < CROP_MIN_PX or bottom - top < CROP_MIN_PX:
        return None
    crop = image.crop((left, top, right, bottom))
    if crop.mode not in ("RGB", "L"):  # pragma: no cover - 渲染出来就是 RGB
        crop = crop.convert("RGB")
    return crop


def _read_one_line(engine: OcrEngine, crop) -> str:
    """一张行图 → 一行文本。引擎可能返回多段（把一行拆开），取最长的那段。"""
    try:
        result = engine.recognize(crop, OcrParams(dpi=0))
    except OcrEngineError:
        return ""
    texts = [line.text.strip() for line in result.lines if line.text.strip()]
    if not texts:
        return ""
    return max(texts, key=len)


def _fail_auxiliary(directory: Path, run_id: str, error_code: str, message: str) -> None:
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            """
            UPDATE ocr_run SET status = 'failed', error_code = ?, error_message = ?, finished_at = ?
            WHERE run_id = ?
            """,
            (error_code, message, _now(), run_id),
        )
        conn.commit()


# ---------------------------------------------------------------- 跑任务（子进程）

# 执行循环的三种决定（由 should_continue() 返回）
DECISION_RUN = "run"          # 继续做下一页
DECISION_PAUSE = "pause"      # 任务被暂停：原地等着
DECISION_STOP = "stop"        # 任务被取消 / 已由别人结算 / 父进程已死：收工

# 暂停时轮询任务状态的间隔（秒）
PAUSE_POLL_SECONDS = 0.5


@dataclass(frozen=True)
class JobOutcome:
    """一次执行的结果。"""

    job: jobs_module.JobRecord
    items: tuple[jobs_module.JobItemRecord, ...]

    @property
    def failed_items(self) -> tuple[jobs_module.JobItemRecord, ...]:
        return tuple(item for item in self.items if item.status == jobs_module.ITEM_STATUS_FAILED)


def run_job(
    directory: Path,
    job_id: str,
    *,
    engine: OcrEngine | None = None,
    should_continue: Callable[[], str] | None = None,
    log: Callable[[str], None] | None = None,
) -> JobOutcome:
    """把这个任务里**还没成功**的页面逐页做完并落库。

    **按任务类型分派**（说明书 5.3 的 `job_type`）：识别任务用第一引擎逐页识别、
    生成块（R1 / R2）；复核任务用第二引擎逐页复核、只写行级候选（8.5 / R1b）。
    两种任务的执行方式、控制信号与结算规则完全一样，因此子进程入口
    （`book2text.worker`）不需要知道自己是哪一种——它只管调这个函数。

    ``engine`` / ``should_continue`` / ``log`` 都是注入点：生产代码用真引擎、
    读数据库判断该不该继续、把进度打到 stdout（由父进程收进项目日志）；
    测试用假引擎与脚本化的决定，走的是同一套落库路径。
    """
    job = jobs_module.get_job(directory, job_id)
    if job.status in jobs_module.TERMINAL_STATUSES:
        # 已经被别人结算（通常是父进程取消了它）——不该再动手
        return JobOutcome(job=job, items=tuple(jobs_module.list_job_items(directory, job_id)))

    jobs_module.set_status(directory, job_id, jobs_module.STATUS_RUNNING)

    # 任务类型决定这一趟做什么：识别（第一引擎，生成块）还是复核（第二引擎，只写行级候选）
    if job.job_type == jobs_module.JOB_TYPE_AUXILIARY:
        return _run_auxiliary_job(
            directory, job, engine=engine, should_continue=should_continue, log=log
        )
    if job.job_type == jobs_module.JOB_TYPE_LAYOUT:
        # 版面检测在独立模块里，复用同一套任务表 / 控制信号（任务 58）。
        from ..layout import detection as layout_detection

        return layout_detection.run_layout_job(
            directory, job.job_id, engine=engine, should_continue=should_continue, log=log
        )
    return _run_ocr_job(
        directory, job, engine=engine, should_continue=should_continue, log=log
    )


def _run_ocr_job(
    directory: Path,
    job: jobs_module.JobRecord,
    *,
    engine: OcrEngine | None,
    should_continue: Callable[[], str] | None,
    log: Callable[[str], None] | None,
) -> JobOutcome:
    """识别任务：第一引擎逐页识别、生成块（说明书 5.4 的 R1 / R2）。

    用哪个第一引擎来自 **job.params**（建任务时从项目设置写进来的 ``engine_setting``）。
    任务建好之后参数就固定了：识别中途改项目设置不会影响已经在跑的这次任务。
    ``engine`` 只给测试 / 局部重识别注入假引擎用；注入时忽略任务参数。
    """
    job_id = job.job_id
    engine_setting = str(job.params.get("engine_setting") or job.params.get("engine_id") or DEFAULT_ENGINE)
    adapter: OcrEngine = engine if engine is not None else adapter_for_engine(engine_setting)
    available, reason = adapter.available()
    if not available:
        _fail_job(directory, job_id, EngineUnavailable(reason))
        return JobOutcome(job=jobs_module.get_job(directory, job_id), items=tuple(
            jobs_module.list_job_items(directory, job_id)
        ))

    params = OcrParams(
        language=str(job.params.get("language", DEFAULT_LANGUAGE)),
        dpi=int(job.params.get("dpi", DEFAULT_DPI)),
    )
    engine_version = adapter.version()
    source = directory / SOURCE_DIR_NAME / SOURCE_FILE_NAME
    say = log if log is not None else (lambda message: None)

    say(f"job {job_id} start total={job.total} dpi={params.dpi} engine={adapter.engine_id}")

    # 双引擎比对（任务 54）：第一路每做完一页，紧接着用第二引擎对**这一页**做行级复核。
    # 为什么按页做：任务状态在循环结束时就会结算成"已完成"，如果比对放在循环之后，
    # 界面会先显示完成、第二引擎却还在跑（用户关掉应用就会丢第二路的结果）。
    # 只在生产路径（没有注入假引擎）且设置是 dual 时做；第二引擎不可用只记日志，
    # 不让第一路的成果失败。
    secondary: OcrEngine | None = None
    if engine is None and engine_setting == ENGINE_DUAL:
        candidate = default_secondary_engine()
        ok, reason = candidate.available()
        if ok:
            secondary = candidate
        else:
            say(f"dual compare skipped reason={reason[:60]}")
    dual_done = 0
    dual_failed = 0

    def run_one(item: jobs_module.JobItemRecord) -> None:
        nonlocal dual_done, dual_failed
        _run_item(
            directory=directory,
            source=source,
            page_no=item.page_no,
            page_id=item.page_id,
            item_id=item.item_id,
            adapter=adapter,
            params=params,
            engine_version=engine_version,
            log=say,
        )
        if secondary is None or not _item_succeeded(directory, item.item_id):
            return
        try:
            # 「双引擎比对」是用户在设置里显式选的第二条路：这里就用那个引擎，
            # 不拿文字层替代（文字层是批量复核那条路的省力办法）。
            run_auxiliary(directory, item.page_no, engine=secondary)
        except Exception as exc:  # noqa: BLE001 - 第二路失败不该让第一路失败
            dual_failed += 1
            say(f"dual compare failed page={item.page_no} err={type(exc).__name__}")
        else:
            dual_done += 1

    outcome = _run_job_loop(
        directory=directory,
        job_id=job_id,
        run_one=run_one,
        should_continue=should_continue,
        say=say,
    )
    if secondary is not None:
        say(f"dual compare pages={dual_done} failed={dual_failed} job={job_id}")
    _record_ocr_stage(directory, outcome, say)
    _auto_apply_after_job(directory, job_id, outcome, say)
    _auto_margin_after_job(directory, job_id, outcome, say)
    return outcome


def _record_ocr_stage(directory: Path, outcome: JobOutcome, say) -> None:
    """识别成功后把页面工作流记成 `已识别①`（任务 58，只记录不驱动流程）。

    失败页不记；状态索引写不进去只留一行日志，不影响任务结算。
    """
    page_ids = [
        item.page_id
        for item in outcome.items
        if item.status == jobs_module.ITEM_STATUS_SUCCEEDED
    ]
    if not page_ids:
        return
    try:
        workflow_module.record_stages(directory, page_ids, workflow_module.STAGE_OCR1_DONE)
    except Exception as exc:  # noqa: BLE001 - 索引失败不该让识别任务变成失败
        say(f"workflow_stage_failed {type(exc).__name__}")


def _item_succeeded(directory: Path, item_id: str) -> bool:
    """这一页的第一路是否真的成功（失败页不跑第二引擎）。"""
    with db_module.open_database(directory, apply_migrations=False) as conn:
        row = conn.execute(
            "SELECT status FROM job_item WHERE item_id = ?", (item_id,)
        ).fetchone()
    return bool(row and row["status"] == jobs_module.ITEM_STATUS_SUCCEEDED)


def _auto_margin_after_job(directory: Path, job_id: str, outcome: JobOutcome, say) -> None:
    """识别任务收尾：自动推算一次版心（任务 53）。

    **为什么在收尾、而且是"一次任务一次"：** 版心是一本书的页面几何，不是某一页的属性；
    每识别一页就重算会让框在识别过程中来回跳（用户看到的是闪烁，还可能误拖）。
    收尾时整本已有的 `block_line` 一起算，成本约 30ms（69 页实测），不值得增量维护。

    写入规则在 `margin_box.write_margin_suggestion`：没有手动版心才自动写入并标 ``auto``；
    已经手动设过就只更新"建议"，绝不覆盖当前值。

    自动应用高把握块类型**之前**还是之后？放在之后：块类型会影响推算
    （显式页眉 / 页脚 / 页码块整块跳过），先应用完再算更准。
    失败只写一行日志（不写路径、不写文本），不影响任务本身的结算。
    """
    from . import margin_box as margin_box_module

    succeeded = [
        item
        for item in outcome.items
        if item.page_no is not None and item.status == jobs_module.ITEM_STATUS_SUCCEEDED
    ]
    if not succeeded:
        return

    try:
        result = margin_box_module.write_margin_suggestion(
            directory.name,
            trigger="ocr_job",
            job_id=job_id,
            library=directory.parent,
        )
    except Exception as exc:  # noqa: BLE001 - 自动推算失败不该让任务变成失败
        say(f"margin_suggestion failed {type(exc).__name__}")
        return
    if result.get("suggestion"):
        say(
            "margin_suggestion "
            f"applied={1 if result['applied'] else 0} "
            f"pages={result['suggestion'].get('pages')}"
        )


def _auto_apply_after_job(directory: Path, job_id: str, outcome: JobOutcome, say) -> None:
    """识别任务收尾：项目开了"识别完成后自动应用高把握建议"就一次应用本任务认完的页。

    **为什么在这里：** 只有子进程真正知道"这一页做完了"；放在 API 轮询里做，
    用户关掉页面就不会应用，那就不算"服务端自动应用"了。
    失败只写一行日志（不写路径、不写文本），不影响任务本身的结算。
    """
    from . import auto_apply as auto_apply_module

    try:
        if not auto_apply_module.enabled(directory.name, library=directory.parent):
            return
    except Exception:  # noqa: BLE001 - 设置读不出来就当关闭
        return

    pages = [
        int(item.page_no)
        for item in outcome.items
        if item.page_no is not None and item.status == jobs_module.ITEM_STATUS_SUCCEEDED
    ]
    try:
        result = auto_apply_module.apply_for_job(directory, job_id, pages)
    except Exception as exc:  # noqa: BLE001 - 自动应用失败不该让任务变成失败
        say(f"auto_apply failed {type(exc).__name__}")
        return
    if result:
        say(f"auto_apply applied pages={result['pages']} blocks={result['blocks']}")


def _run_auxiliary_job(
    directory: Path,
    job: jobs_module.JobRecord,
    *,
    engine: OcrEngine | None,
    should_continue: Callable[[], str] | None,
    log: Callable[[str], None] | None,
) -> JobOutcome:
    """复核任务：第二引擎逐页复核，只写行级候选（说明书 8.5 / R1b）。

    每页的活儿与单页复核（`run_auxiliary`）**完全是同一个函数**——这里只负责
    把任务单元的状态接上，这样"暂停 / 取消 / 重试失败页"在两种任务上是同一套。
    """
    job_id = job.job_id
    secondary: OcrEngine = engine if engine is not None else default_secondary_engine()
    available, reason = secondary.available()
    if not available:
        _fail_job(directory, job_id, EngineUnavailable(f"第二引擎不可用：{reason}"))
        return JobOutcome(job=jobs_module.get_job(directory, job_id), items=tuple(
            jobs_module.list_job_items(directory, job_id)
        ))

    say = log if log is not None else (lambda message: None)
    say(f"job {job_id} start total={job.total} engine={secondary.engine_id} type=auxiliary")

    def run_one(item: jobs_module.JobItemRecord) -> None:
        _run_auxiliary_item(
            directory=directory,
            job_id=job_id,
            item=item,
            engine=secondary,
            log=say,
        )

    return _run_job_loop(
        directory=directory,
        job_id=job_id,
        run_one=run_one,
        should_continue=should_continue,
        say=say,
    )


def _run_job_loop(
    *,
    directory: Path,
    job_id: str,
    run_one: Callable[[jobs_module.JobItemRecord], None],
    should_continue: Callable[[], str] | None,
    say: Callable[[str], None],
) -> JobOutcome:
    """两种任务共用的执行循环：逐单元问一次"该不该继续"，然后做那一页。

    循环本身不认识"识别"还是"复核"——那是 `run_one` 的事。
    结算规则：没被停就按结果定成败（有任何一页失败即 failed，done / failed 说明细节）。
    """
    decide = should_continue if should_continue is not None else _status_decider(directory, job_id)

    stopped = False
    for item in jobs_module.pending_items(directory, job_id):
        decision = _wait_for_go(decide)
        if decision == DECISION_STOP:
            stopped = True
            break
        if item.page_no is None:
            # 单元指向的页面已经不在了（页面记录被删）：如实记失败，
            # 不要静默跳过——否则任务会显示"成功"却一页都没做。
            jobs_module.mark_item_failed(
                directory, item.item_id, "单元指向的页面不存在（页面记录可能已被删除）"
            )
            jobs_module.update_progress(directory, job_id)
            say(f"item {item.item_id} failed page_missing")
            continue
        run_one(item)
        jobs_module.update_progress(directory, job_id)

    job = jobs_module.get_job(directory, job_id)
    if not stopped:
        jobs_module.set_status(
            directory,
            job_id,
            jobs_module.STATUS_FAILED if job.failed else jobs_module.STATUS_SUCCEEDED,
        )
        job = jobs_module.get_job(directory, job_id)
    say(f"job {job_id} end status={job.status} done={job.done} failed={job.failed}")

    return JobOutcome(job=job, items=tuple(jobs_module.list_job_items(directory, job_id)))


def _run_auxiliary_item(
    *,
    directory: Path,
    job_id: str,
    item: jobs_module.JobItemRecord,
    engine: OcrEngine,
    log: Callable[[str], None],
) -> None:
    """复核任务里的一页：先记单元"正在做"，做完记成功与运行 id，失败记原因。

    "失败原因可见"（说明书 Phase 2 的验收）对复核任务同样成立：
    原因写进 `job_item.error_message`，界面在失败列表里显示。
    """
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE job_item SET status = 'running', attempts = attempts + 1 WHERE item_id = ?",
            (item.item_id,),
        )
        conn.commit()

    try:
        result = run_auxiliary(
            directory, item.page_no, engine=engine, prefer_text_layer=True
        )
    except (ProjectError, EngineUnavailable) as exc:
        jobs_module.mark_item_failed(directory, item.item_id, str(exc))
        log(f"page {item.page_no} failed auxiliary")
        return

    # 辅助运行记录已经由 run_auxiliary 结算成 succeeded，这里只把单元接上
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE job_item SET status = 'succeeded', run_id = ? WHERE item_id = ?",
            (result["run_id"], item.item_id),
        )
        conn.commit()
    log(
        f"page {item.page_no} checked lines={result['line_count']}"
        f" differs={result['differs']} {result['elapsed_seconds']}s"
    )


def _status_decider(directory: Path, job_id: str) -> Callable[[], str]:
    """默认的"该不该继续"判断：读数据库里这个任务的状态。

    任务状态本身就是控制信号——暂停写 paused、取消写 cancelled，
    子进程每次做下一页之前看一眼。这样父子之间不需要额外的管道协议。
    """

    def decide() -> str:
        status = jobs_module.get_job(directory, job_id).status
        if status == jobs_module.STATUS_PAUSED:
            return DECISION_PAUSE
        if status == jobs_module.STATUS_RUNNING:
            return DECISION_RUN
        return DECISION_STOP

    return decide


def _wait_for_go(decide: Callable[[], str]) -> str:
    """暂停时就地等，直到重新变成 run 或收到 stop。"""
    while True:
        decision = decide()
        if decision != DECISION_PAUSE:
            return decision
        time.sleep(PAUSE_POLL_SECONDS)


def _fail_job(directory: Path, job_id: str, error: Exception) -> None:
    """整个任务起不来（例如引擎不可用）：把所有还没做的单元标记失败并写明原因。"""
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            "UPDATE job_item SET status = 'failed', error_message = ?"
            " WHERE job_id = ? AND status IN ('queued', 'running')",
            (str(error), job_id),
        )
        conn.commit()
    jobs_module.update_progress(directory, job_id)
    jobs_module.set_status(directory, job_id, jobs_module.STATUS_FAILED)


def _run_item(
    *,
    directory: Path,
    source: Path,
    page_no: int,
    page_id: str,
    item_id: str,
    adapter: OcrEngine,
    params: OcrParams,
    engine_version: str,
    log: Callable[[str], None] = lambda message: None,
) -> str:
    """识别一页：先落一条 running 的运行记录，成功或失败都会把它结算掉。

    这样"失败原因可见"（说明书 Phase 2 的验收）不依赖界面：
    数据库里就躺着 error_code 与 error_message。
    日志只写页码、结果与耗时——**不写识别文本，也不写路径**（说明书 Phase 6 的日志规则）。
    """
    run_id = new_ulid()
    started = _now()
    started_clock = datetime.now(timezone.utc)

    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            """
            INSERT INTO ocr_run (
                run_id, page_id, run_type, engine_id, engine_version, params_json,
                status, created_at
            ) VALUES (?, ?, 'primary', ?, ?, ?, 'running', ?)
            """,
            (
                run_id,
                page_id,
                adapter.engine_id,
                engine_version,
                json.dumps({"dpi": params.dpi, "language": params.language}, ensure_ascii=False),
                started,
            ),
        )
        conn.execute(
            """
            UPDATE job_item SET status = 'running', run_id = ?, attempts = attempts + 1
            WHERE item_id = ?
            """,
            (run_id, item_id),
        )
        conn.commit()

    # 渲染：与界面显示、与 Phase 0 的门槛实测走同一个函数（含 /Rotate）
    try:
        image = render.render_page_image(source, page_no - 1, dpi=params.dpi)
    except render.PdfError as exc:
        log(f"page {page_no} failed render_failed")
        _fail_run(directory, run_id, item_id, ERROR_RENDER_FAILED, str(exc))
        return run_id

    try:
        result = adapter.recognize(image, params)
    except OcrEngineError as exc:
        log(f"page {page_no} failed ocr_failed")
        _fail_run(directory, run_id, item_id, ERROR_OCR_FAILED, str(exc))
        return run_id
    finally:
        image.close()

    layout = grouping.group_lines(result.lines)
    elapsed = (datetime.now(timezone.utc) - started_clock).total_seconds()

    raw_path = directory / OCR_RUNS_DIR_NAME / f"{run_id}.json"
    try:
        _write_raw_result(
            raw_path,
            run_id=run_id,
            page_id=page_id,
            page_no=page_no,
            result=result,
            params=params,
            engine_version=engine_version,
            total_elapsed=elapsed,
            layout=layout,
        )
    except OSError as exc:
        log(f"page {page_no} failed persist_failed")
        _fail_run(directory, run_id, item_id, ERROR_PERSIST_FAILED, f"写原始输出失败：{exc}")
        return run_id

    _persist_blocks(
        directory,
        page_id,
        run_id=run_id,
        item_id=item_id,
        layout=layout,
        elapsed=elapsed,
    )
    log(f"page {page_no} succeeded {elapsed:.1f}s blocks={len(layout.blocks)}")
    return run_id


def _fail_run(
    directory: Path, run_id: str, item_id: str, error_code: str, message: str
) -> None:
    with db_module.open_database(directory, apply_migrations=False) as conn:
        conn.execute(
            """
            UPDATE ocr_run SET status = 'failed', error_code = ?, error_message = ?, finished_at = ?
            WHERE run_id = ?
            """,
            (error_code, message, _now(), run_id),
        )
        conn.execute(
            "UPDATE job_item SET status = 'failed', error_message = ? WHERE item_id = ?",
            (message, item_id),
        )
        conn.commit()


# ---------------------------------------------------------------- 落块

def _has_human_results(conn, page_id: str) -> bool:
    """页面是否已有人工成果（说明书 R2）。

    凡"确认过 / 改过文本 / 不是 OCR 来源"的块都算：这三类分别对应
    ``review_status``、``text != ocr_text`` 与 ``origin``。
    """
    row = conn.execute(
        """
        SELECT COUNT(*) AS n FROM block
        WHERE page_id = ? AND deleted_at IS NULL
          AND (text <> ocr_text OR review_status <> ? OR origin <> ?)
        """,
        (page_id, REVIEW_UNREVIEWED, ORIGIN_OCR),
    ).fetchone()
    return int(row["n"]) > 0


def _persist_blocks(
    directory: Path,
    page_id: str,
    *,
    run_id: str,
    item_id: str,
    layout: grouping.PageLayout,
    elapsed: float,
) -> bool:
    """结算这次识别：块与行的写入、运行状态、active run、任务单元，**一个事务**。

    这几件事必须一起成功或一起失败——否则会出现"块进去了但 active run 没换"
    或"运行成功了但没块"这类半截状态（进程刚好在两步之间被杀就能撞上）。
    返回这次运行是否被采用（R1 / R2 的结论）。
    """
    now = _now()
    with db_module.open_database(directory, apply_migrations=False) as conn:
        active = conn.execute(
            "SELECT active_run_id FROM page WHERE page_id = ?", (page_id,)
        ).fetchone()
        has_active = active is not None and active["active_run_id"] is not None
        applied = not has_active or not _has_human_results(conn, page_id)

        if applied:
            # R1 / R2 的替换：旧块软删除（说明书 5.1：删除一律软删除）
            conn.execute(
                "UPDATE block SET deleted_at = ?, updated_at = ?"
                " WHERE page_id = ? AND deleted_at IS NULL",
                (now, now, page_id),
            )
            for block in layout.blocks:
                block_id = new_ulid()
                confidences = [
                    line.confidence for line in block.lines if line.confidence is not None
                ]
                text = block.text
                conn.execute(
                    """
                    INSERT INTO block (
                        block_id, page_id, origin_run_id, origin, order_index, bbox, block_type,
                        ocr_text, text, review_status, include, continues_to_next, confidence,
                        revision, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, 0, ?, ?)
                    """,
                    (
                        block_id,
                        page_id,
                        run_id,
                        ORIGIN_OCR,
                        block.order_index,
                        blocks_module.bbox_to_json(block.bbox),
                        block.block_type,
                        text,
                        text,
                        REVIEW_UNREVIEWED,
                        (sum(confidences) / len(confidences)) if confidences else None,
                        now,
                        now,
                    ),
                )
                conn.executemany(
                    """
                    INSERT INTO block_line (
                        line_id, block_id, line_index, bbox, text, word_boxes
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    [
                        (
                            new_ulid(),
                            block_id,
                            index,
                            blocks_module.bbox_to_json(line.bbox),
                            line.text,
                            _word_boxes_json(line),
                        )
                        for index, line in enumerate(block.lines)
                    ],
                )

        conn.execute(
            """
            UPDATE ocr_run
            SET status = 'succeeded', finished_at = ?, elapsed_seconds = ?, raw_result_path = ?
            WHERE run_id = ?
            """,
            (now, round(elapsed, 3), f"{OCR_RUNS_DIR_NAME}/{run_id}.json", run_id),
        )
        if applied:
            # R1 / R2：只有"采用"了这次运行才换 active_run_id
            conn.execute(
                "UPDATE page SET active_run_id = ? WHERE page_id = ?", (run_id, page_id)
            )
        conn.execute("UPDATE job_item SET status = 'succeeded' WHERE item_id = ?", (item_id,))
        conn.execute("UPDATE project SET updated_at = ?", (now,))
        conn.commit()
        return applied


# ---------------------------------------------------------------- 原始输出

def _word_boxes_json(line: OcrLine) -> str | None:
    """行内字 / 词框的 JSON（任务 59）；引擎没给就 NULL。

    结构与迁移 0021 的约定一致：``[{"text","bbox":[x0,y0,x1,y1],"confidence"}]``。
    """
    words = getattr(line, "words", ()) or ()
    if not words:
        return None
    return json.dumps(
        [
            {
                "text": word.text,
                "bbox": [
                    round(word.bbox.x0, 5),
                    round(word.bbox.y0, 5),
                    round(word.bbox.x1, 5),
                    round(word.bbox.y1, 5),
                ],
                "confidence": (
                    None if word.confidence is None else round(float(word.confidence), 4)
                ),
            }
            for word in words
        ],
        ensure_ascii=False,
    )


def _write_raw_result(
    path: Path,
    *,
    run_id: str,
    page_id: str,
    page_no: int,
    result: OcrResult,
    params: OcrParams,
    engine_version: str,
    total_elapsed: float,
    layout: grouping.PageLayout,
) -> None:
    """写 ``ocr_runs/<run_id>.json``（说明书 5.3 的 ``raw_result_path``）。"""
    line_index = {id(line): index for index, line in enumerate(result.lines)}
    payload = {
        "schema": RAW_SCHEMA_ID,
        "run_id": run_id,
        "page_id": page_id,
        "page_no": page_no,
        "engine_id": result.engine_id,
        "engine_version": engine_version,
        "params": {"dpi": params.dpi, "language": params.language},
        "image_width": result.image_width,
        "image_height": result.image_height,
        # 引擎自己报的耗时，与整页耗时（含渲染与落库）分开记
        "engine_elapsed_seconds": round(result.elapsed_seconds, 3),
        "total_elapsed_seconds": round(total_elapsed, 3),
        "line_count": len(result.lines),
        "lines": [
            {
                "index": index,
                "text": line.text,
                "bbox": line.bbox.as_list(),
                "confidence": line.confidence,
            }
            for index, line in enumerate(result.lines)
        ],
        # 分段当时的版面判断。块本身已入库（block / block_line），这里留下的是
        # **判断依据**："检测到疑似 N 栏，阅读顺序需人工确认"这类提示不该丢。
        "layout": {
            "block_count": len(layout.blocks),
            "column_count": layout.column_count,
            "reading_order_uncertain": layout.reading_order_uncertain,
            "notes": list(layout.notes),
        },
        # **分段结果本身**也留下：R2 的"待选结果"不生成块，但用户对比之后要能
        # 原样采用他看过的这一份分组（重新跑一次 grouping 未必得到同样的结果）。
        "blocks": [
            {
                "order_index": block.order_index,
                "bbox": block.bbox.as_list() if block.bbox else None,
                "block_type": block.block_type,
                "text": block.text,
                "line_indexes": [line_index[id(line)] for line in block.lines],
            }
            for block in layout.blocks
        ],
        "engine_raw": result.raw,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    # default=str：引擎元数据里可能有非 JSON 类型，宁可留字符串也不要写不下去
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=str), encoding="utf-8"
    )
