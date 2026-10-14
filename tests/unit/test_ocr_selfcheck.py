"""引擎自检模块测试。

重点验证说明书 8.1 的契约：``available() -> (是否可用, 不可用的原因)``，
即**不可用时必须能说出原因**。这条比"哪些引擎装了"更重要。
"""

from __future__ import annotations

import pytest

from book2text.core.ocr import selfcheck


def test_report_has_expected_shape() -> None:
    report = selfcheck.report()
    assert set(report) >= {
        "probes",
        "by_role",
        "available_count",
        "total_count",
        "python_executable",
        "note",
    }
    assert report["total_count"] == len(report["probes"])
    assert report["available_count"] <= report["total_count"]


def test_unavailable_probes_always_explain_why() -> None:
    """不可用必须带原因——这是自检接口存在的意义。"""
    for probe in selfcheck.probe_engines():
        if probe.available:
            assert probe.reason == "", f"{probe.engine_id} 可用但给了原因"
        else:
            assert probe.reason, f"{probe.engine_id} 不可用却没给原因"


def test_probes_cover_the_three_roles() -> None:
    roles = {probe.role for probe in selfcheck.probe_engines()}
    assert roles == {selfcheck.ROLE_PRIMARY, selfcheck.ROLE_LAYOUT, selfcheck.ROLE_SECONDARY}


def test_primary_role_offers_both_deployment_forms() -> None:
    """说明书 Phase 0 第 1 项要在 RapidOCR 与 PaddleOCR 之间实测选定。"""
    engine_ids = {probe.engine_id for probe in selfcheck.probe_primary_engines()}
    assert engine_ids == {"rapidocr", "paddleocr"}


def test_secondary_role_covers_platform_alternatives() -> None:
    """第二引擎按平台选：Apple Vision / Windows OCR / Tesseract 兜底。"""
    engine_ids = {probe.engine_id for probe in selfcheck.probe_secondary_engines()}
    assert engine_ids == {"apple_vision", "windows_ocr", "tesseract"}


def test_by_role_partitions_all_probes() -> None:
    report = selfcheck.report()
    grouped = sum(len(items) for items in report["by_role"].values())
    assert grouped == report["total_count"]


def test_probe_dict_is_json_friendly() -> None:
    import json

    payload = json.dumps(selfcheck.report(), ensure_ascii=False)
    assert "engine_id" in payload
