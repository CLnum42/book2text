#!/usr/bin/env python3
"""PageTile 酸测试（§21.8）——**模块不存在时必须红，不许报绿**。

判据（D-109 口径，别改成网络请求数）：
    同一页同一档位的 `<img>.src` 赋值次数 = 1；observer 个数 = 1；
    一处 `invalidate` 后两处同时更新且只新增 1 次取图；release 一个不影响另一个；
    宿主全移除后注册表与 observer 回 0；移动宿主不释放、不重新取图。

分工（2026-10-29）：
- 本脚本判**前置**（文件在不在、API 在不在、接了没有），并把可数量的判据交给
  `tests/js/page-tile-acid.mjs`（Node + 最小 DOM，仓库不装 npm 依赖）；
- 退出码：0 全过 / 2 模块不存在 / 3 API 缺失 / 1 酸测试不过（逐条打红）。

为什么不数网络请求：`/pages/N/image` 带 `max-age=300`，第二次取图命中浏览器缓存、
网络 +0——**用网络数会把重复取图判成通过**（`pagetile-baseline.md` §1③④ 就是这么误判的）。

用法：
    .venv/bin/python scripts/acid_pagetile.py
    .venv/bin/python scripts/acid_pagetile.py --require-consumers   # 接入后：必须有 ≥2 个视图在用
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
STATIC = REPO / "backend" / "book2text" / "static"
MODULE = STATIC / "page-tile.js"
HARNESS = REPO / "tests" / "js" / "page-tile-acid.mjs"
CONSUMERS = ["index-view.js", "preview-view.js", "reading-view.js"]


def node_binary() -> str | None:
    for candidate in (shutil.which("node"), "/opt/homebrew/bin/node", "/usr/local/bin/node"):
        if candidate and Path(candidate).exists():
            return candidate
    found = Path.home() / ".local" / "bin" / "node"
    return str(found) if found.exists() else None


def main(argv: list[str]) -> int:
    if not MODULE.exists():
        print(f"[红] 模块不存在：{MODULE.relative_to(REPO)}")
        print("     酸测试没有对象——空跑不能算绿。")
        return 2

    source = MODULE.read_text(encoding="utf-8")
    missing = [
        needle
        for needle in ("window.PageTile", "invalidate", "release", "create")
        if needle not in source
    ]
    if missing:
        print(f"[红] API 缺失：{missing}")
        return 3

    # 服务模块不许认 id（§21.9 的 R3 变体；闸未上，这里先兜）
    literal_ids = re.findall(r'el\(\s*["\'][^"\']+["\']\s*\)|getElementById\(\s*["\']', source)
    if literal_ids:
        print(f"[红] 模块里出现 id 字面量查找：{literal_ids[:3]}")
        return 3

    consumers = [name for name in CONSUMERS if "PageTile" in (STATIC / name).read_text(encoding="utf-8")]
    if len(consumers) < 2:
        print(f"[待接入] 目前没有视图在用 PageTile（{consumers or '无'}）——本刀只交模块 + 单测。")
        if "--require-consumers" in argv:
            print("[红] 已接入模式下必须有 ≥2 个消费者")
            return 3

    node = node_binary()
    if not node:
        print("[红] 找不到 node——酸测试跑不起来就不能算过（fail closed）")
        return 3
    if not HARNESS.exists():
        print(f"[红] 缺酸测试驱动：{HARNESS.relative_to(REPO)}")
        return 3

    result = subprocess.run([node, str(HARNESS)], capture_output=True, text=True)
    payload = None
    for line in result.stdout.splitlines():
        if line.startswith("RESULT "):
            payload = json.loads(line[len("RESULT "):])
    if payload is None:
        print("[红] 酸测试驱动没有输出 RESULT（它自己崩了，与'判据不过'要分清）")
        print(result.stdout[-800:] or result.stderr[-800:])
        return 1

    for check in payload["checks"]:
        print(f"{'✔' if check['ok'] else '✖'} {check['name']}（{check['detail']}）")
    if not payload["ok"]:
        print("[1] 酸测试不过：模块存在理由不成立（唯一资源 / 唯一生命周期 / 唯一失效语义至少一条没做到）")
        return 1
    print("[0] 酸测试通过：同页 1 次取图 / 1 个 observer / 一次作废两处同步 / 无泄漏")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
