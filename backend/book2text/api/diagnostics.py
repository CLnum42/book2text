"""导出诊断日志（说明书 Phase 6 的"导出诊断日志"入口）。

**两条日志规则（说明书 Phase 6 原文）：** 不写识别文本内容、不写项目外的个人绝对路径。
这个模块的两条对应做法：

1. 报告里只有**数字与状态**：页数、块数、任务成败、引擎可用性、耗时……
   **一行识别文本都没有**（项目日志本身也不写文本，见 `worker.py` 与 `executor.py`）；
2. **路径一律脱敏**：家目录换成 `~`，项目库路径整个略去，项目目录只留项目 id。
   报告是给人贴到聊天窗口里求助用的，不该顺带把用户的名字与目录结构发出去。

报告是纯文本（`text/plain`），用户下载后自己决定发给谁——**应用不会自动上传任何东西**。
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .. import __version__
from ..core import platform as b2t_platform
from ..core.ocr import selfcheck
from ..core.pdf import render
from ..core.project import executor as executor_module
from ..core.project import library as project_library
from ..core import settings as settings_module
from ..core.project import stats as stats_module

# 每个项目最多带多少行任务日志（日志只含页码 / 状态 / 耗时）
LOG_TAIL_LINES = 60


def sanitize_path(text: str, *, home: Path | None = None) -> str:
    """把个人目录脱敏：家目录 → `~`。用于任何要写进报告的字符串。"""
    home_dir = home if home is not None else Path.home()
    return text.replace(str(home_dir), "~")


def _read_log_tail(path: Path, limit: int = LOG_TAIL_LINES) -> list[str]:
    """读任务日志的末尾若干行（日志里只有页码、状态与耗时，没有识别文本）。"""
    if not path.is_file():
        return []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    return [sanitize_path(line) for line in lines[-limit:]]


@dataclass(frozen=True)
class DiagnosticsReport:
    text: str
    file_name: str


def build_report(*, library: Path) -> DiagnosticsReport:
    """拼出诊断报告（纯文本、已脱敏）。"""
    library_dir = Path(library)
    now = datetime.now(timezone.utc).astimezone()
    settings = settings_module.load_settings(library_dir)
    supported, unsupported_reason = b2t_platform.is_supported_platform()

    lines: list[str] = [
        "Book2Text 诊断报告",
        "=" * 40,
        f"生成时间：{now.isoformat(timespec='seconds')}",
        f"版本：{__version__}",
        f"运行方式：{'打包运行（PyInstaller）' if getattr(sys, 'frozen', False) else '源码运行'}",
        f"平台：{b2t_platform.platform_label()}（{'受支持' if supported else '不受支持'}）",
        f"系统版本：{b2t_platform.os_version()}",
        f"Python：{b2t_platform.python_version()}",
        f"平台说明：{unsupported_reason or '—'}",
        "",
        "设置",
        "-" * 40,
        f"我的名字：{settings.user_name or '（未填写）'}",
        "项目库目录：<已略去：本机个人路径>",
        "",
        "PDF 后端",
        "-" * 40,
        f"pypdfium2 {render.backend_version()}（说明书 Phase 0 的库对比未完成，当前为暂用后端）",
        "",
        "引擎自检",
        "-" * 40,
    ]

    report = selfcheck.report()
    probes = list(report.get("probes") or [])
    lines.append(f"{report.get('available_count', 0)} / {report.get('total_count', len(probes))} 项可用")
    lines.append(f"识别当前用：{report.get('note', '')}")
    for probe in probes:
        state = "可用" if probe.get("available") else "不可用"
        version = probe.get("version") or "—"
        note = probe.get("note") or probe.get("reason") or ""
        lines.append(
            f"- [{probe.get('role', '?')}] {probe.get('label', probe.get('engine_id', '?'))}"
            f"：{state} · {version} · {sanitize_path(str(note))}"
        )

    lines += ["", "项目统计（只有数字，没有识别文本）", "-" * 40]
    try:
        projects = project_library.list_projects(library=library_dir)
    except project_library.ProjectError as exc:  # pragma: no cover - 项目库读不到
        projects = []
        lines.append(f"（项目库读不出来：{exc}）")

    if not projects:
        lines.append("（还没有项目）")
    for entry in projects:
        # 项目名可能是书名，但用户自己看得见、也知道自己在发什么；目录只留 id
        project = entry.project
        lines.append(f"\n■ {project.project_id}《{project.name}》")
        directory = project_library.project_dir(library_dir, project.project_id)
        try:
            stats = stats_module.project_summary(project.project_id, library=library_dir)
        except project_library.ProjectError as exc:
            lines.append(f"  统计读不出来：{exc}")
            continue
        pages, review, divergence, jobs = stats.pages, stats.review, stats.divergence, stats.jobs
        lines.append(
            f"  页面：{pages.total} 页（纳入 {pages.included} · 已识别 {pages.recognized}"
            f" · 未识别 {pages.unrecognized} · 失败 {pages.failed}）"
        )
        lines.append(
            f"  审校：块 {review.blocks}（已确认 {review.confirmed} · 未审 {review.unreviewed}"
            f" · 不确定 {review.uncertain} · 人工修改 {review.modified}）"
        )
        lines.append(
            f"  两路复核：已复核 {divergence.checked_pages} 页 / 比过 {divergence.compared_lines} 行"
            f" · 分歧 {divergence.diverging_lines}（汉字级 {divergence.chars} · 标点级 {divergence.punct}）"
        )
        lines.append(
            f"  任务：{jobs.total} 个（成功 {jobs.succeeded} · 失败 {jobs.failed}"
            f" · 取消 {jobs.cancelled} · 中断 {jobs.interrupted} · 进行中 {jobs.active}）"
        )
        log_dir = directory / executor_module.LOG_DIR_NAME
        log_files = sorted(log_dir.glob(f"{executor_module.LOG_PREFIX}*.log"))[-2:] if log_dir.is_dir() else []
        for log_path in log_files:
            lines.append(f"  —— {log_path.name} 末尾（只含页码与耗时，不含识别文本）——")
            tail = _read_log_tail(log_path)
            if tail:
                lines.extend(f"    {line}" for line in tail)
            else:
                lines.append("    （空）")

    lines += [
        "",
        "说明",
        "-" * 40,
        "本报告不含识别文本，不含项目外的个人绝对路径（家目录已替换为 ~）。",
        "任务日志本身也遵守同一规则：只写页号、状态与耗时（说明书 Phase 6）。",
        "本报告只在你点击导出时生成并下载到本机，应用不会自动上传任何内容。",
        "",
    ]

    stamp = now.strftime("%Y%m%d-%H%M")
    return DiagnosticsReport(text="\n".join(lines), file_name=f"book2text-diagnostics-{stamp}.txt")
