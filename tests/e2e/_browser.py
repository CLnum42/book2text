"""浏览器侧：把一条命令交给 ego-browser 执行，收回 JSON。

为什么要绕一层 Node：真实鼠标事件必须走 CDP `Input.dispatchMouseEvent`。
ego-browser（团队已有的工具）封装了这一层，并且支持 `page.cdp(...)` 改视口。
Python 只负责写 task JSON / 读 result JSON，逻辑全在 `browser/driver.mjs`。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

EGO = shutil.which("ego-browser") or str(Path.home() / ".local" / "bin" / "ego-browser")
DRIVER = Path(__file__).resolve().parent / "browser" / "driver.mjs"


class BrowserError(RuntimeError):
    pass


def ensure_available() -> None:
    if not Path(EGO).exists():
        raise BrowserError(
            "找不到 ego-browser。它是团队统一的浏览器驱动；装好 ego lite 后重试。"
        )


def run(
    state: dict[str, Any],
    cmd: str,
    args: dict[str, Any] | None = None,
    *,
    timeout: float = 300.0,
) -> Any:
    ensure_available()
    run_dir = Path(state["run_dir"])
    payload = {
        "cmd": cmd,
        "args": args or {},
        "space": state["space"],
        "url": state["url"],
        "projectId": state.get("project_id") or "",
        "viewport": {"width": 1423, "height": 900, "dpr": 2},
        "screenshots": state["screenshots"],
    }
    task_path = run_dir / f"task-{cmd}.json"
    task_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    result_path = run_dir / f"result-{cmd}.json"
    result_path.unlink(missing_ok=True)
    boot_path = run_dir / f"boot-{cmd}.mjs"
    boot_path.write_text(
        "\n".join(
            [
                'const fs = await import("node:fs/promises");',
                "let result;",
                "try {",
                f'  const {{ run }} = await import({json.dumps(DRIVER.as_uri())});',
                f'  const cfg = JSON.parse(await fs.readFile({json.dumps(str(task_path))}, "utf8"));',
                "  result = { ok: true, data: await run(cfg) };",
                "} catch (error) {",
                "  result = { ok: false, error: String((error && error.stack) || error) };",
                "}",
                f"await fs.writeFile({json.dumps(str(result_path))}, JSON.stringify(result));",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    env = os.environ.copy()
    env["PATH"] = f"{Path.home() / '.local' / 'bin'}:{env.get('PATH', '')}"
    completed = subprocess.run(
        [EGO, "nodejs"],
        input=boot_path.read_text(encoding="utf-8"),
        text=True,
        capture_output=True,
        cwd=str(Path(__file__).resolve().parents[2]),
        env=env,
        timeout=timeout,
    )
    if not result_path.is_file():
        raise BrowserError(
            "浏览器命令没有产出结果文件。\n"
            f"命令：{cmd}\nstdout:\n{completed.stdout[-3000:]}\nstderr:\n{completed.stderr[-3000:]}"
        )
    result = json.loads(result_path.read_text())
    if not result.get("ok"):
        raise BrowserError(f"浏览器命令 {cmd} 失败：\n{result.get('error')}")
    return result["data"]
