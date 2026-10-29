#!/usr/bin/env python3
"""PageTile 酸测试（§21.8）——**模块不存在时必须红，不许报绿**。

判据（契约 §21.8）：两个消费者同时持同一页 → 一处 `invalidate(pageNo)` →
两处同时更新，且这一页**只发一次**图请求。

用法：
    .venv/bin/python scripts/acid_pagetile.py           # 跑全部门
    .venv/bin/python scripts/acid_pagetile.py --baseline # 只打印今天的基线数

退出码：0 全过 / 2 模块不存在 / 3 API 缺失 / 4 浏览器段未实现（当前）
"契约到了"不等于"对象到了"——所以先判文件，别让空跑变成绿。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

STATIC = Path(__file__).resolve().parent.parent / "backend" / "book2text" / "static"
MODULE = STATIC / "page-tile.js"
CONSUMERS = ["index-view.js", "preview-view.js", "reading-view.js"]


def main() -> int:
    if not MODULE.exists():
        print(f"[红] 模块不存在：{MODULE.relative_to(STATIC.parent.parent.parent)}")
        print("     酸测试没有对象。等 page-tile.js 落盘（DevLead 的活），不要自己写。")
        return 2
    src = MODULE.read_text(encoding="utf-8")
    missing = [needle for needle in ("window.PageTile", "invalidate") if needle not in src]
    if missing:
        print(f"[红] API 缺失：{missing}")
        return 3
    consumers = [name for name in CONSUMERS if "PageTile" in (STATIC / name).read_text(encoding="utf-8")]
    if len(consumers) < 2:
        print(f"[红] 消费者不足 2 个：{consumers}")
        return 3
    print(f"[待补] 静态门通过（模块存在、API 在、消费者 {consumers}），但浏览器段未实现。")
    print("       浏览器段要量的三个数：同页同档位请求数（今天基线=2）、invalidate 后两处更新、只发一次请求。")
    return 4


if __name__ == "__main__":
    sys.exit(main())
