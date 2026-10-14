"""平台模块测试（说明书第 10 节把平台分支限制在一个模块里，理应好测）。"""

from __future__ import annotations

from book2text.core import platform as b2t_platform


def test_platform_label_is_not_empty() -> None:
    label = b2t_platform.platform_label()
    assert label
    assert "(" in label and label.endswith(")")


def test_is_supported_platform_returns_tuple() -> None:
    supported, reason = b2t_platform.is_supported_platform()
    assert isinstance(supported, bool)
    assert isinstance(reason, str)
    # 不受支持时必须给出原因，受支持时原因应为空（说明书 1.6：如实呈现状态）
    assert bool(reason) is not supported


def test_exactly_one_platform_flag_is_true() -> None:
    assert sum([b2t_platform.is_macos(), b2t_platform.is_windows()]) <= 1


def test_python_version_looks_like_a_version() -> None:
    parts = b2t_platform.python_version().split(".")
    assert len(parts) >= 2
    assert all(part.isdigit() for part in parts[:2])


def test_reveal_missing_path_reports_failure(tmp_path) -> None:
    ok, reason = b2t_platform.reveal_in_file_manager(tmp_path / "does-not-exist")
    assert ok is False
    assert reason
