"""PyInstaller 的入口脚本（打包时由 book2text.spec 使用）。

源码运行时入口是控制台脚本 `book2text`（见 pyproject 的 `[project.scripts]`）；
打包时需要**一个文件**作为入口，于是有了这个两行的转发。

注意：打包后的可执行文件**同时也当识别子进程用**
（`<可执行文件> --b2t-worker --project-dir … --job …`），
这条分派在 `book2text.main.main()` 里（见 WORKER_FLAG）。
"""

from __future__ import annotations

import sys

from book2text.main import main

if __name__ == "__main__":
    sys.exit(main())
