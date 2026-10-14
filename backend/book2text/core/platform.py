"""平台相关代码集中在此模块（说明书第 10 节）。

其他模块**不得**直接判断 `sys.platform` / `os.name`，需要平台差异时从这里取。
目前只有三类分支：打开文件管理器、打开浏览器、平台支持性判断。
"""

from __future__ import annotations

import platform as _platform_module
import subprocess
import sys
from pathlib import Path

# 说明书第 10 节：只支持 macOS Apple Silicon（arm64）与 Windows x64。
_APPLE_SILICON_ARCHES = {"arm64", "aarch64"}


def is_macos() -> bool:
    return sys.platform == "darwin"


def is_windows() -> bool:
    return sys.platform == "win32"


def machine_arch() -> str:
    return _platform_module.machine().lower()


def python_version() -> str:
    return _platform_module.python_version()


def os_version() -> str:
    return _platform_module.platform()


def platform_label() -> str:
    """供界面显示的平台说明，例如 ``macOS (arm64)`` 或 ``Windows (x64)``。"""
    if is_macos():
        return f"macOS ({machine_arch()})"
    if is_windows():
        return f"Windows ({'x64' if _is_64bit() else 'x86'})"
    return f"{_platform_module.system()} ({machine_arch()})"


def _is_64bit() -> bool:
    return sys.maxsize > 2**32


def is_supported_platform() -> tuple[bool, str]:
    """返回 ``(是否受支持, 不受支持的原因)``。

    不受支持时**不阻止启动**：说明书 1.6 要求如实呈现状态，
    让开发者能在非目标平台上查看诊断信息，而不是看到一个失败退出。
    """
    if is_macos():
        if machine_arch() in _APPLE_SILICON_ARCHES:
            return True, ""
        return False, f"不支持 Intel Mac（当前架构：{machine_arch()}）"
    if is_windows():
        if _is_64bit():
            return True, ""
        return False, "不支持 32 位 Windows"
    return False, f"未支持的操作系统：{_platform_module.system()}"


def documents_dir() -> Path:
    """用户的"文稿 / 文档"目录。

    说明书 12.1 规定默认项目库就在这个目录下。

    **已知限制（Windows）：** 若用户把"文档"目录重定向到 OneDrive，
    这个按惯例拼接的路径可能不存在。届时需要在设置里手填项目库路径
    （说明书 4.5 已允许"在设置中输入其他项目文件夹路径"）。
    """
    return Path.home() / "Documents"


def reveal_in_file_manager(path: Path) -> tuple[bool, str]:
    """在系统文件管理器中定位文件（macOS Finder / Windows 资源管理器）。

    说明书 4.5 指定的少数平台分支之一。
    """
    target = Path(path)
    if not target.exists():
        return False, f"路径不存在：{target}"
    if is_macos():
        command = ["open", "-R", str(target)]
    elif is_windows():
        command = ["explorer", "/select,", str(target)]
    else:
        return False, f"暂不支持在 {_platform_module.system()} 上打开文件管理器"
    try:
        subprocess.Popen(command)  # noqa: S603 - 参数为常量 + 已知路径
    except OSError as exc:
        return False, f"调用系统命令失败：{exc}"
    return True, ""


def open_in_browser(url: str) -> tuple[bool, str]:
    """用系统默认浏览器打开 URL。"""
    try:
        if is_macos():
            subprocess.Popen(["open", url])  # noqa: S603
        elif is_windows():
            import os

            os.startfile(url)  # type: ignore[attr-defined]  # noqa: S606
        else:
            import webbrowser

            if not webbrowser.open(url):
                return False, "无法调用系统浏览器"
    except OSError as exc:
        return False, f"调用系统浏览器失败：{exc}"
    return True, ""
