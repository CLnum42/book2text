"""`count_checks` 的 SET_REWRITES 判据：**数改写后的行**，不是旧行。

旧实现是"反的"：正确改写 → 旧行 0 次 → 判红（拦下做对的）；没改写 → 旧行还在 → 判绿（放过没做的）。
这比"永远绿"更危险：它拦下正确改动，人就会去删检查或加 `--no-verify`。
代码在 `1b2c503` 已修（改为数改写后的行 + 加"旧行在模块里必须 0 次"的反证）；
本文件把三个方向钉成回归 —— 刀 9 再改同一个函数时，改回旧形态会立刻红。
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


def _rewrite_rules():
    return SimpleNamespace(
        SET_BLOCKS=[],
        SET_REWRITES={"x = !x;": "injected.setX(!injected.getX());"},
        SETTERS=[("x", "setX")],
        IDENT=[],
        IDENT_FULL=[],
        CAPABILITIES=[],
        MOVED_STATES=[],
    )


BODY = "function f() {\n  x = !x;\n}\n"
OK = "function f() {\n  injected.setX(!injected.getX());\n}\n"
NOT_REWRITTEN = "function f() {\n  x = !x;\n}\n"
REWRITTEN_TWICE = "function f() {\n  injected.setX(!injected.getX());\n  injected.setX(!injected.getX());\n}\n"


def test_set_rewrites_正确改写必须绿(bv):
    """B 类失效的正面：做对了必须绿（旧实现会在这里判红）。"""
    assert bv.count_checks(OK, BODY, _rewrite_rules()) == []


def test_set_rewrites_未改写必须红(bv):
    problems = bv.count_checks(NOT_REWRITTEN, BODY, _rewrite_rules())
    assert problems, "没改写却判绿 —— 旧实现的另一半失效（放过没做的）"
    assert "SET_REWRITES" in problems[0]


def test_set_rewrites_改写两次必须红(bv):
    problems = bv.count_checks(REWRITTEN_TWICE, BODY, _rewrite_rules())
    assert problems, "同一写点被改写两次（模块里两份）必须红"
    assert "SET_REWRITES" in problems[0]


def test_set_rewrites_旧行残留在模块里必须红(bv):
    """改写了一半：新行在、旧行也在 —— 同一个写点两份，必须红。"""
    both = "function f() {\n  injected.setX(!injected.getX());\n  x = !x;\n}\n"
    problems = bv.count_checks(both, BODY, _rewrite_rules())
    assert any("旧行仍在" in p for p in problems), f"旧行残留应判红，实际：{problems}"
