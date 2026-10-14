"""OCR 引擎自检（说明书 Phase 0 第 4 项要求）。

只做**可用性探测**，不做识别：列出第一引擎、版面组件、第二引擎各自是否可用、
版本、以及不可用的原因。接口形状对齐说明书 8.1 的
``available() -> (bool, str)``（是否可用 + 不可用的原因）。

本模块**不安装**任何 OCR 依赖，只如实报告当前环境：没装就说没装，
装了就说装了——"当前用哪个引擎"由识别代码决定（见 `core/project/recognition.py`）。
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from importlib.metadata import PackageNotFoundError, version as _package_version
from importlib.util import find_spec

from .. import platform as b2t_platform

# 说明书第 10 节：Windows 侧的自检路径目前**没有在 Windows 上运行过**。
# 任何涉及 Windows 的结论在被实测前都必须带上这个标记。
UNVERIFIED_ON_WINDOWS = "本项未在 Windows 上验证过"

ROLE_PRIMARY = "primary"
ROLE_LAYOUT = "layout"
ROLE_SECONDARY = "secondary"


@dataclass(frozen=True)
class EngineProbe:
    role: str
    engine_id: str
    label: str
    available: bool
    version: str | None
    reason: str          # 不可用原因；可用时为空字符串
    note: str = ""       # 平台限制、未验证标记等

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


def _module_installed(module_name: str) -> bool:
    try:
        return find_spec(module_name) is not None
    except (ImportError, ValueError):
        return False


def _distribution_version(distribution_name: str) -> str | None:
    try:
        return _package_version(distribution_name)
    except (PackageNotFoundError, ValueError):
        return None


def _probe_package(
    *,
    role: str,
    engine_id: str,
    label: str,
    module_name: str,
    distribution_name: str,
    note: str = "",
) -> EngineProbe:
    """探测一个以 Python 包形式提供的引擎。"""
    if not _module_installed(module_name):
        return EngineProbe(
            role=role,
            engine_id=engine_id,
            label=label,
            available=False,
            version=None,
            reason=f"未安装（Python 包 {module_name}）",
            note=note,
        )
    return EngineProbe(
        role=role,
        engine_id=engine_id,
        label=label,
        available=True,
        version=_distribution_version(distribution_name),
        reason="",
        note=note,
    )


# --------------------------------------------------------------------------
# 第一引擎：PP-OCR 系列（说明书 8.4）
# --------------------------------------------------------------------------

def _probe_any_package(
    *,
    role: str,
    engine_id: str,
    label: str,
    candidates: list[tuple[str, str]],
    note: str = "",
) -> EngineProbe:
    """探测一个引擎的多个候选发行版，取第一个已安装的。

    RapidOCR 有两个互不兼容的发行版：``rapidocr``（3.x，导入名就是 ``rapidocr``）
    与 ``rapidocr_onnxruntime``（1.x）。只探其中一个会把另一种误报成"未安装"。
    """
    missing: list[str] = []
    for module_name, distribution_name in candidates:
        if _module_installed(module_name):
            return EngineProbe(
                role=role,
                engine_id=engine_id,
                label=label,
                available=True,
                version=_distribution_version(distribution_name),
                reason="",
                note=note,
            )
        missing.append(module_name)
    return EngineProbe(
        role=role,
        engine_id=engine_id,
        label=label,
        available=False,
        version=None,
        reason="未安装（候选 Python 包：" + "、".join(missing) + "）",
        note=note,
    )


def probe_primary_engines() -> list[EngineProbe]:
    """第一引擎的两种部署形态：RapidOCR（ONNX）与 PaddleOCR。

    说明书 Phase 0 第 1 项要求在两者间实测选定；这里只报告是否已安装。
    macOS arm64 上的实测结论见 docs/ocr-evaluation.md。
    """
    has_backend = _module_installed("onnxruntime")
    rapidocr_note = (
        "推理后端 onnxruntime 已安装"
        if has_backend
        else "注意：推理后端（onnxruntime）未安装，装好才能实际推理"
    )
    return [
        _probe_any_package(
            role=ROLE_PRIMARY,
            engine_id="rapidocr",
            label="RapidOCR（ONNX 部署形态）",
            candidates=[
                ("rapidocr", "rapidocr"),
                ("rapidocr_onnxruntime", "rapidocr_onnxruntime"),
            ],
            note=rapidocr_note,
        ),
        _probe_package(
            role=ROLE_PRIMARY,
            engine_id="paddleocr",
            label="PaddleOCR（官方部署形态）",
            module_name="paddleocr",
            distribution_name="paddleocr",
        ),
    ]


# --------------------------------------------------------------------------
# 版面组件（可选增强，说明书 8.4）
# --------------------------------------------------------------------------

def probe_layout_engines() -> list[EngineProbe]:
    """只接版面检测模型，不使用 PP-StructureV3 端到端解析作为主路径。"""
    return [
        _probe_package(
            role=ROLE_LAYOUT,
            engine_id="rapid_layout",
            label="RapidLayout（版面检测）",
            module_name="rapid_layout",
            distribution_name="rapid_layout",
        ),
        _probe_package(
            role=ROLE_LAYOUT,
            engine_id="pp_doclayout",
            label="PP-DocLayout（版面检测）",
            module_name="paddlex",
            distribution_name="paddlex",
        ),
    ]


# --------------------------------------------------------------------------
# 第二引擎：按平台选择（说明书 8.4、8.6）
# --------------------------------------------------------------------------

def _probe_apple_vision() -> EngineProbe:
    """macOS：Apple Vision 框架（需要 pyobjc）。"""
    common = dict(
        role=ROLE_SECONDARY,
        engine_id="apple_vision",
        label="Apple Vision（macOS 系统 OCR）",
    )
    if not b2t_platform.is_macos():
        return EngineProbe(
            **common,
            available=False,
            version=None,
            reason=f"仅 macOS 可用（当前平台：{b2t_platform.platform_label()}）",
            note="",
        )

    has_vision = _module_installed("Vision")
    has_quartz = _module_installed("Quartz")
    if not has_vision or not has_quartz:
        missing = [
            name
            for name, present in (("Vision", has_vision), ("Quartz", has_quartz))
            if not present
        ]
        packages = "、".join(
            {
                "Vision": "pyobjc-framework-Vision",
                "Quartz": "pyobjc-framework-Quartz",
            }[name]
            for name in missing
        )
        return EngineProbe(
            **common,
            available=False,
            version=None,
            reason=f"未安装 pyobjc 组件：{packages}",
            note="pyobjc 为平台专属依赖，需用环境标记 sys_platform == 'darwin'",
        )

    return EngineProbe(
        **common,
        available=True,
        version=_distribution_version("pyobjc-framework-Vision"),
        reason="",
        note="实测它弱于第一引擎（40 页真书：整页 CER 2.16% vs 1.08%；"
        "被标出的分歧里约八成是它自己的错），候选只作参考——见 docs/ocr-evaluation.md 第 9 节",
    )


def _probe_windows_ocr() -> EngineProbe:
    """Windows：系统自带 OCR。必须把「语言包缺失」明确报出来。"""
    common = dict(
        role=ROLE_SECONDARY,
        engine_id="windows_ocr",
        label="Windows 系统 OCR",
    )
    if not b2t_platform.is_windows():
        return EngineProbe(
            **common,
            available=False,
            version=None,
            reason=f"仅 Windows 可用（当前平台：{b2t_platform.platform_label()}）",
            note="",
        )

    # 以下路径在 macOS 上无法执行，属未验证代码。
    if not (_module_installed("winsdk") or _module_installed("winrt")):
        return EngineProbe(
            **common,
            available=False,
            version=None,
            reason="未安装 Windows Runtime 绑定（winsdk 或 winrt）",
            note=UNVERIFIED_ON_WINDOWS,
        )

    try:  # pragma: no cover - 无法在 macOS 上覆盖
        from winsdk.windows.media.ocr import OcrEngine  # type: ignore[import-not-found]
        from winsdk.windows.globalization import Language  # type: ignore[import-not-found]

        languages = list(OcrEngine.get_available_recognizer_languages())
        tags = [str(language.language_tag) for language in languages]
        if not tags:
            return EngineProbe(
                **common,
                available=False,
                version=None,
                reason="系统 OCR 可用，但未安装任何识别语言包（请在"
                       "「设置 → 时间和语言 → 语言」中为中文、英文添加语言包）",
                note=UNVERIFIED_ON_WINDOWS,
            )
        has_chinese = any(tag.lower().startswith("zh") for tag in tags)
        has_english = any(tag.lower().startswith("en") for tag in tags)
        missing = [
            name
            for name, present in (("中文", has_chinese), ("英文", has_english))
            if not present
        ]
        note = f"可用语言包：{', '.join(tags)}；{UNVERIFIED_ON_WINDOWS}"
        if missing:
            note += f"；缺少语言包：{'、'.join(missing)}"
        return EngineProbe(
            **common,
            available=True,
            version=None,
            reason="",
            note=note,
        )
    except Exception as exc:  # pragma: no cover
        return EngineProbe(
            **common,
            available=False,
            version=None,
            reason=f"调用 Windows OCR 失败：{exc}",
            note=UNVERIFIED_ON_WINDOWS,
        )


def _probe_tesseract() -> EngineProbe:
    """兜底：Tesseract（需要外部可执行文件 + pytesseract）。"""
    common = dict(
        role=ROLE_SECONDARY,
        engine_id="tesseract",
        label="Tesseract（兜底）",
    )
    executable = shutil.which("tesseract")
    if executable is None:
        return EngineProbe(
            **common,
            available=False,
            version=None,
            reason="未找到 tesseract 可执行文件（未安装或不在 PATH 中）",
            note="",
        )
    try:
        completed = subprocess.run(  # noqa: S603 - 参数为常量
            [executable, "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        first_line = (completed.stdout or completed.stderr).splitlines()
        version_text = first_line[0].strip() if first_line else None
    except (OSError, subprocess.SubprocessError) as exc:
        return EngineProbe(
            **common,
            available=False,
            version=None,
            reason=f"调用 tesseract 失败：{exc}",
            note="",
        )

    if not _module_installed("pytesseract"):
        return EngineProbe(
            **common,
            available=False,
            version=version_text,
            reason="已安装 tesseract，但缺少 Python 包 pytesseract",
            note="",
        )

    return EngineProbe(
        **common,
        available=True,
        version=version_text,
        reason="",
        note="中文识别需要额外的语言数据文件（chi_sim）",
    )


def probe_secondary_engines() -> list[EngineProbe]:
    """第二引擎：只需要独立血统与低假分歧，不要求跨平台一致（说明书 8.4）。"""
    return [_probe_apple_vision(), _probe_windows_ocr(), _probe_tesseract()]


# --------------------------------------------------------------------------
# 汇总
# --------------------------------------------------------------------------

def probe_engines() -> list[EngineProbe]:
    return (
        probe_primary_engines()
        + probe_layout_engines()
        + probe_secondary_engines()
    )


def report() -> dict[str, object]:
    """给 ``GET /api/app/info`` 用的自检报告。"""
    probes = probe_engines()
    by_role: dict[str, list[dict[str, object]]] = {
        ROLE_PRIMARY: [],
        ROLE_LAYOUT: [],
        ROLE_SECONDARY: [],
    }
    for probe in probes:
        by_role.setdefault(probe.role, []).append(probe.to_dict())

    available = [probe for probe in probes if probe.available]
    return {
        "probes": [probe.to_dict() for probe in probes],
        "by_role": by_role,
        "available_count": len(available),
        "total_count": len(probes),
        "python_executable": sys.executable,
        # 如实说明这份报告的性质：它测的是**当前这台机器**的环境，不是选型结论
        "note": (
            "此处报告的是当前环境里各引擎的可用状态，不是选型结论。"
            + (
                f"识别当前用 {available[0].engine_id}。"
                if available and available[0].role == ROLE_PRIMARY
                else "未安装第一引擎依赖，识别会返回 503（uv sync --group ocr-eval）。"
            )
        ),
    }
