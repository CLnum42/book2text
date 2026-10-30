"""生成器守卫的回归测试：**给注入 getter 赋值**（含复合赋值）必须红。

来由（2026-10-30 刀 5 真事故）：`suggestionScanQueued += 1` 被生成器改写成
`injected.getSuggestionScanQueued() += 1` —— 语法合法、node 闸绿、pytest 全绿，
真跑到就抛（赋值给函数调用的结果）。旧守卫只匹配 `injected.getX() =`，**整类漏掉**：
`+=` `-=` `*=` `/=` `%=` 一条都抓不到。

这条守的是一**类**，不是这一个：凡"读 getter 的返回值再写回去"的写法都该走 setter。
"""
from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(os.environ.get("B2T_ROOT", Path(__file__).resolve().parents[2]))
BUILD_VIEW = Path(os.environ.get("B2T_BUILD_VIEW", ROOT / "docs" / "refactor" / "evidence" / "build_view.py"))


@pytest.fixture(scope="module")
def bv():
    spec = importlib.util.spec_from_file_location("_b2t_build_view", BUILD_VIEW)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _rules(**over):
    base = dict(
        SET_BLOCKS=[],
        SET_REWRITES={},
        SETTERS=[],
        IDENT=[],
        IDENT_FULL=[],
        CAPABILITIES=[],
        MOVED_STATES=[],
    )
    base.update(over)
    return SimpleNamespace(**base)


@pytest.mark.parametrize("line", [
    "injected.getX() = 1;",
    "injected.getX() += 1;",
    "injected.getX() -= 1;",
    "injected.getX() *= 2;",
    "injected.getX() /= 2;",
    "injected.getX() %= 2;",
])
def test_getter_assignment_is_red_包括复合赋值(bv, line):
    module = f"function f() {{\n  {line}\n}}\n"
    problems = bv.anti_checks(module, "", _rules())
    assert any("给注入 getter 赋值" in p or "给 getter 赋值" in p for p in problems), (
        f"「{line.strip()}」应判红（getter 是函数，赋给它的返回值会抛），实际：{problems}"
    )


@pytest.mark.parametrize("line", [
    "injected.setX(injected.getX() + 1);",     # 正确形态：setter 包住读
    "if (injected.getX() > 0) { return; }",    # 比较不是赋值
    "injected.getX() === 1;",                  # 严格比较
    "injected.getX() == 1;",                   # 宽松比较
    "const n = injected.getX();",              # 读
])
def test_getter_read_and_compare_are_green(bv, line):
    """反例齐一遍：比较/读都不是赋值，判红就是"反的"（会逼人把正确写法撤回去）。"""
    module = f"function f() {{\n  {line}\n}}\n"
    problems = bv.anti_checks(module, "", _rules())
    assert not [p for p in problems if "给注入 getter 赋值" in p or "给 getter 赋值" in p], (
        f"「{line.strip()}」不该判红，实际：{problems}"
    )
