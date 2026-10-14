"""ULID 测试（说明书 5.1：实体 ID 用 ULID，可排序、跨平台）。"""

from __future__ import annotations

from datetime import timezone

import pytest

from book2text.core.storage import ulid

FIXED_MS = 1_700_000_000_000       # 2023-11-14T22:13:20Z


def test_length_and_alphabet() -> None:
    value = ulid.new_ulid()
    assert len(value) == 26
    assert all(char in ulid._ALPHABET for char in value)
    # 不含易混字符
    assert not any(char in value for char in "ILOU")


def test_is_valid_ulid() -> None:
    assert ulid.is_valid_ulid(ulid.new_ulid()) is True
    assert ulid.is_valid_ulid("") is False
    assert ulid.is_valid_ulid("too-short") is False
    assert ulid.is_valid_ulid("0" * 25) is False
    assert ulid.is_valid_ulid("I" * 26) is False, "I 不在 Crockford 字典里"


def test_lexicographic_order_follows_time() -> None:
    """说明书要求"可排序"——字典序必须等于时间序。"""
    earlier = ulid.new_ulid(timestamp_ms=FIXED_MS)
    later = ulid.new_ulid(timestamp_ms=FIXED_MS + 1)
    much_later = ulid.new_ulid(timestamp_ms=FIXED_MS + 100_000)
    assert earlier < later < much_later


def test_monotonic_within_the_same_millisecond() -> None:
    """同一毫秒内连续生成也要保持有序，否则同批数据的排序不稳定。"""
    values = [ulid.new_ulid(timestamp_ms=FIXED_MS) for _ in range(50)]
    assert len(set(values)) == 50, "同一毫秒内不应重复"
    assert values == sorted(values)


def test_timestamp_round_trip() -> None:
    value = ulid.new_ulid(timestamp_ms=FIXED_MS)
    moment = ulid.timestamp_of(value)
    assert moment.tzinfo is timezone.utc
    assert int(moment.timestamp() * 1000) == FIXED_MS


def test_timestamp_of_rejects_invalid() -> None:
    with pytest.raises(ValueError):
        ulid.timestamp_of("not-a-ulid")


def test_rejects_out_of_range_timestamp() -> None:
    with pytest.raises(ValueError):
        ulid.new_ulid(timestamp_ms=1 << 48)
    with pytest.raises(ValueError):
        ulid.new_ulid(timestamp_ms=-1)


def test_ids_are_unique_across_calls() -> None:
    values = {ulid.new_ulid() for _ in range(200)}
    assert len(values) == 200
