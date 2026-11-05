"""项目质量统计（说明书 8.5 的「分歧率写入项目的质量统计」+ 第 13.4 节的质量指标）。

这是**读模型**：所有数字都来自项目数据库的实时聚合，不新增存储、不写任何东西。

说明书 13.4 列了九项指标，这里**如实分三类**，不把算不出来的也算成算得出来的：

- **算得出来（本模块）**：页面识别概况、审校进度、人工修改率、不确定块数、
  两路复核的分歧率、任务失败率。
- **需要人工金标准（离线测量）**：CER / WER、捕获率、"一致但都错"——
  见 `docs/ocr-evaluation.md` 第 6–8 节，产品里**不算，也不假装算**。
- **目前没有采集**：每页平均审校时间、恢复成功率——连同原因列在 `NOT_MEASURED` 里。

**分歧率的口径**（说明书 8.5 / 8.7）：分母是**两边都有文本、能比的行**
（一致 + 仅格式差异 + 汉字级 + 标点级），分子是其中的实质分歧行（汉字级 + 标点级）。
"第二引擎没读出来"的行不进分母——它没提供关于原文的信息，算进去只会把比率冲淡；
这些行数另行单独列出，让人看得出"有多少行其实没比成"。
行数按**块里现在的文本**逐行现算（与界面上标出来的分歧同源）；行结构被人工改过的块
（`stale_blocks`）不参与，因为那几行的行号已经对不上了。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from . import blocks as blocks_module
from . import jobs as jobs_module
from .library import default_library_dir, list_pages, load_project, project_dir

# 产品里算不出来的指标：如实列出来并写明原因（说明书 1.7：不得把未验证的当成已验证）
NOT_MEASURED = (
    {
        "name": "CER / WER",
        "reason": "需要人工校对的金标准，属于离线测量（docs/ocr-evaluation.md 第 6–7 节）",
    },
    {
        "name": "捕获率、一致但都错",
        "reason": "同样需要金标准（docs/ocr-evaluation.md 第 8 节）；产品里只报分歧率",
    },
    {
        "name": "每页平均审校时间",
        "reason": "事件表有时间戳，但没有「审校会话」这一概念，现在算不出有意义的数字",
    },
    {
        "name": "恢复成功率",
        "reason": "中断后成功续跑的统计未采集（任务表只记终态）",
    },
)


@dataclass(frozen=True)
class PagesSummary:
    """页面与识别概况。"""

    total: int = 0
    included: int = 0
    recognized: int = 0
    unrecognized: int = 0
    failed: int = 0
    has_candidate: int = 0
    # 带文字层的页数：有文字层的页做第二引擎复核时直接读文字层，不跑 OCR（任务 58）
    text_layer_pages: int = 0

    def to_dict(self) -> dict[str, object]:
        return {
            "total": self.total,
            "included": self.included,
            "recognized": self.recognized,
            "unrecognized": self.unrecognized,
            "failed": self.failed,
            "has_candidate": self.has_candidate,
            "text_layer_pages": self.text_layer_pages,
        }


@dataclass(frozen=True)
class ReviewSummary:
    """审校进度与人工修改率（说明书 13.4 的「人工修改率」）。"""

    blocks: int = 0
    included: int = 0
    confirmed: int = 0
    unreviewed: int = 0
    uncertain: int = 0
    modified: int = 0

    @property
    def modified_rate(self) -> float:
        """改过的块占纳入块的比例；没有纳入块时是 0。"""
        return round(self.modified / self.included, 4) if self.included else 0.0

    def to_dict(self) -> dict[str, object]:
        return {
            "blocks": self.blocks,
            "included": self.included,
            "confirmed": self.confirmed,
            "unreviewed": self.unreviewed,
            "uncertain": self.uncertain,
            "modified": self.modified,
            "modified_rate": self.modified_rate,
        }


@dataclass(frozen=True)
class DivergenceSummary:
    """两路复核的分歧率（说明书 8.5）。"""

    checked_pages: int = 0
    needs_recheck_pages: int = 0
    unchecked_pages: int = 0
    body_pages: int = 0
    total_pages: int = 0
    identical: int = 0
    format_only: int = 0
    chars: int = 0
    punct: int = 0
    empty: int = 0
    stale_blocks: int = 0

    @property
    def compared_lines(self) -> int:
        """两边都有文本、能比的行数（分歧率的分母）。"""
        return self.identical + self.format_only + self.chars + self.punct

    @property
    def checked_lines(self) -> int:
        """复核过的行数（含第二引擎没读出文本的那几行）。"""
        return self.compared_lines + self.empty

    @property
    def diverging_lines(self) -> int:
        """实质分歧行（分歧率的分子）。"""
        return self.chars + self.punct

    @property
    def diverging_rate(self) -> float:
        return (
            round(self.diverging_lines / self.compared_lines, 4)
            if self.compared_lines
            else 0.0
        )

    @property
    def checked_page_rate(self) -> float:
        return (
            round(self.checked_pages / self.total_pages, 4) if self.total_pages else 0.0
        )

    def to_dict(self) -> dict[str, object]:
        return {
            "checked_pages": self.checked_pages,
            # 三态：已复核且有效 / 需重算 / 未复核 —— 三者之和 = body_pages
            "needs_recheck_pages": self.needs_recheck_pages,
            "unchecked_pages": self.unchecked_pages,
            "body_pages": self.body_pages,
            "total_pages": self.total_pages,
            "checked_page_rate": self.checked_page_rate,
            "checked_lines": self.checked_lines,
            "compared_lines": self.compared_lines,
            "identical": self.identical,
            "format_only": self.format_only,
            "chars": self.chars,
            "punct": self.punct,
            "empty": self.empty,
            "stale_blocks": self.stale_blocks,
            "diverging_lines": self.diverging_lines,
            "diverging_rate": self.diverging_rate,
        }


@dataclass(frozen=True)
class JobsSummary:
    """任务成败（说明书 13.4 的「任务失败率」）。"""

    total: int = 0
    succeeded: int = 0
    failed: int = 0
    cancelled: int = 0
    interrupted: int = 0
    active: int = 0

    @property
    def finished(self) -> int:
        """已经有结论的任务（成功 / 失败）——取消与中断不算成败。"""
        return self.succeeded + self.failed

    @property
    def failure_rate(self) -> float:
        return round(self.failed / self.finished, 4) if self.finished else 0.0

    def to_dict(self) -> dict[str, object]:
        return {
            "total": self.total,
            "succeeded": self.succeeded,
            "failed": self.failed,
            "cancelled": self.cancelled,
            "interrupted": self.interrupted,
            "active": self.active,
            "finished": self.finished,
            "failure_rate": self.failure_rate,
        }


@dataclass(frozen=True)
class ProjectSummary:
    """一次拿全项目摘要（说明书第 11 节的 `GET /projects/{id}/summary`）。"""

    project_id: str
    name: str
    pages: PagesSummary
    review: ReviewSummary
    divergence: DivergenceSummary
    jobs: JobsSummary

    def to_dict(self) -> dict[str, object]:
        return {
            "project_id": self.project_id,
            "name": self.name,
            "pages": self.pages.to_dict(),
            "review": self.review.to_dict(),
            "divergence": self.divergence.to_dict(),
            "jobs": self.jobs.to_dict(),
            "not_measured": list(NOT_MEASURED),
        }


# 页面状态里计入概况的四种（排队中 / 识别中不算——它们是过程中的状态）
_COUNTED_STATUSES = (
    blocks_module.STATUS_RECOGNIZED,
    blocks_module.STATUS_UNRECOGNIZED,
    blocks_module.STATUS_FAILED,
    blocks_module.STATUS_HAS_CANDIDATE,
)


def project_summary(project_id: str, *, library: Path | None = None) -> ProjectSummary:
    """汇总一个项目的质量统计。

    **不写任何东西**：读的是页记录、块（经 `page_review_states`）、
    复核记录（经 `page_divergences`，与界面上标出来的分歧同源）与任务表。
    """
    target_library = library if library is not None else default_library_dir()
    project = load_project(project_id, library=target_library)
    pages = list_pages(project_id, library=target_library)
    states = blocks_module.page_recognition_states(project_id, library=target_library)
    reviews = blocks_module.page_review_states(project_id, library=target_library)
    divergences = blocks_module.page_divergences(project_id, library=target_library)
    job_counts = jobs_module.count_by_status(project_dir(target_library, project_id))
    # 任务 72：红色「N 个任务失败」只算**还没被补救**的——补跑成功的失败记录
    # 留在历史里（审计要看），但不能再占着红字（用户看到的是一个永远修不掉的数）。
    # 注意：**不要往 job_counts 里加键**——下面的 total 是 `sum(job_counts.values())`。
    failed_total = job_counts.get(jobs_module.STATUS_FAILED, 0)
    job_counts[jobs_module.STATUS_FAILED] = jobs_module.unresolved_failed_jobs(
        project_dir(target_library, project_id)
    )

    page_counts = dict.fromkeys(_COUNTED_STATUSES, 0)
    for page in pages:
        state = states.get(page.page_id)
        status = state.status if state else blocks_module.STATUS_UNRECOGNIZED
        if status in page_counts:
            page_counts[status] += 1

    return ProjectSummary(
        project_id=project_id,
        name=project.name,
        pages=PagesSummary(
            total=len(pages),
            included=sum(1 for page in pages if page.include),
            recognized=page_counts[blocks_module.STATUS_RECOGNIZED],
            unrecognized=page_counts[blocks_module.STATUS_UNRECOGNIZED],
            failed=page_counts[blocks_module.STATUS_FAILED],
            has_candidate=page_counts[blocks_module.STATUS_HAS_CANDIDATE],
            text_layer_pages=sum(1 for page in pages if page.has_text_layer),
        ),
        review=ReviewSummary(
            blocks=sum(item.block_count for item in reviews.values()),
            included=sum(item.included for item in reviews.values()),
            confirmed=sum(item.confirmed for item in reviews.values()),
            unreviewed=sum(item.unreviewed for item in reviews.values()),
            uncertain=sum(item.uncertain for item in reviews.values()),
            modified=sum(item.modified for item in reviews.values()),
        ),
        divergence=DivergenceSummary(
            # 2026-11-05：三态按**正文页**算，与 review_status 的 engine.checked 同源（都用
            # divergence_index 的 checked/needs_recheck），否则两个「已复核页数」会打架。
            checked_pages=sum(
                1
                for page in pages
                if page.include
                and (divergences.get(page.page_id) or None)
                and divergences[page.page_id].checked
            ),
            needs_recheck_pages=sum(
                1
                for page in pages
                if page.include
                and (divergences.get(page.page_id) or None)
                and divergences[page.page_id].needs_recheck
            ),
            unchecked_pages=sum(
                1
                for page in pages
                if page.include
                and not (
                    (divergences.get(page.page_id) or None)
                    and (
                        divergences[page.page_id].checked
                        or divergences[page.page_id].needs_recheck
                    )
                )
            ),
            body_pages=sum(1 for page in pages if page.include),
            total_pages=len(pages),
            identical=sum(item.identical for item in divergences.values()),
            format_only=sum(item.format_only for item in divergences.values()),
            chars=sum(item.chars for item in divergences.values()),
            punct=sum(item.punct for item in divergences.values()),
            empty=sum(item.empty for item in divergences.values()),
            stale_blocks=sum(item.stale_blocks for item in divergences.values()),
        ),
        jobs=JobsSummary(
            total=sum(job_counts.values()),
            succeeded=job_counts.get(jobs_module.STATUS_SUCCEEDED, 0),
            failed=job_counts.get(jobs_module.STATUS_FAILED, 0),
            cancelled=job_counts.get(jobs_module.STATUS_CANCELLED, 0),
            interrupted=job_counts.get(jobs_module.STATUS_INTERRUPTED, 0),
            active=sum(job_counts.get(status, 0) for status in jobs_module.ACTIVE_STATUSES),
        ),
    )
