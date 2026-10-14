"""ULID 生成（说明书 5.1：所有实体有稳定 ID，ULID 字符串，可排序、跨平台）。

ULID = 48 位毫秒时间戳 + 80 位随机数，用 Crockford Base32 编码成 26 个字符。
选择自己实现而不是引入依赖，是因为规格很小（本文件不到百行）、
且 ID 生成属于"不能出错但也不值得为它引包"的基础设施。

**字典序 = 时间序：** 26 个字符按字典序排列即按时间排列，这是 ULID 的核心性质，
数据库里可以直接按 ID 排序取最新。

**同毫秒内单调递增：** 同一毫秒内连续生成时，随机部分按上次结果 +1，
因此同一毫秒内生成的 ID 也保持有序。这避免了"同一毫秒内排序不稳定"。
"""

from __future__ import annotations

import os
import time
from datetime import datetime, timezone

# Crockford Base32：去掉了容易混淆的 I、L、O、U
_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_DECODE = {char: index for index, char in enumerate(_ALPHABET)}

TIME_CHARS = 10          # 48 位时间戳 → 10 个字符
RANDOM_CHARS = 16        # 80 位随机数 → 16 个字符
ULID_LENGTH = TIME_CHARS + RANDOM_CHARS

_MAX_TIME = (1 << 48) - 1
_MAX_RANDOM = (1 << 80) - 1

# 上一毫秒与上一随机数，用于同毫秒内单调递增。进程内全局，够用。
_last_time_ms = -1
_last_random = 0


def _encode(value: int, length: int) -> str:
    chars = []
    for _ in range(length):
        chars.append(_ALPHABET[value & 0x1F])
        value >>= 5
    return "".join(reversed(chars))


def _decode(text: str) -> int:
    value = 0
    for char in text:
        try:
            digit = _DECODE[char.upper()]
        except KeyError:
            raise ValueError(f"不是合法的 Crockford Base32 字符：{char!r}") from None
        value = (value << 5) | digit
    return value


def new_ulid(*, timestamp_ms: int | None = None) -> str:
    """生成一个新 ULID。

    ``timestamp_ms`` 可显式传入，便于测试；缺省取当前时间。
    """
    global _last_time_ms, _last_random

    now = int(time.time() * 1000) if timestamp_ms is None else timestamp_ms
    if not 0 <= now <= _MAX_TIME:
        raise ValueError(f"时间戳超出 48 位范围：{now}")

    if now == _last_time_ms:
        # 同一毫秒：随机部分 +1，保证单调
        random_part = (_last_random + 1) & _MAX_RANDOM
        if random_part == 0:  # 溢出则借用下一毫秒
            now += 1
            random_part = int.from_bytes(os.urandom(10), "big") & _MAX_RANDOM
    else:
        random_part = int.from_bytes(os.urandom(10), "big") & _MAX_RANDOM

    _last_time_ms, _last_random = now, random_part
    return _encode(now, TIME_CHARS) + _encode(random_part, RANDOM_CHARS)


def is_valid_ulid(value: str) -> bool:
    if not isinstance(value, str) or len(value) != ULID_LENGTH:
        return False
    try:
        _decode(value)
    except ValueError:
        return False
    return True


def timestamp_of(value: str) -> datetime:
    """取出 ULID 里的时间戳（UTC）。"""
    if not is_valid_ulid(value):
        raise ValueError(f"不是合法的 ULID：{value!r}")
    millis = _decode(value[:TIME_CHARS])
    return datetime.fromtimestamp(millis / 1000, tz=timezone.utc)
