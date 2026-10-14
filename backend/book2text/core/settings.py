"""应用设置（说明书 Phase 6 的"首次运行环境检查（含填写我的名字）"）。

当前只有一项：**我的名字**。它写进审校事件的 `actor_name`（说明书 5.3 的协作字段），
所以协作阶段（Phase 5）拿到结果包时能看出"这一处是谁改的"。

**存在项目库里**（`<项目库>/.settings.json`），不写在应用目录里：

- 打包成 `.app` / `.exe` 之后，应用目录是只读的（macOS 上还会带签名校验），写不进去；
- 放在项目库里随项目库一起搬走，换台机器名字还在；
- 它是**用户可见、可备份**的一个小 JSON 文件，没有藏起来的魔法。

首次运行（设置文件不存在）时 `first_run` 为真，界面据此显示"环境检查 + 填写我的名字"。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

SETTINGS_FILE_NAME = ".settings.json"
MAX_NAME_LENGTH = 50


@dataclass(frozen=True)
class Settings:
    """应用设置。`first_run` 不落盘，由"文件在不在"推导。"""

    user_name: str = ""
    first_run: bool = False

    def to_dict(self) -> dict[str, object]:
        return {"user_name": self.user_name, "first_run": self.first_run}


def settings_path(library: Path) -> Path:
    return Path(library) / SETTINGS_FILE_NAME


def load_settings(library: Path) -> Settings:
    """读设置；文件不存在或读坏了一律当作"没有设置"（并视为首次运行）。

    读坏了不报错：设置丢了不该挡住用应用——界面会再问一次名字而已。
    """
    path = settings_path(library)
    if not path.is_file():
        return Settings(first_run=True)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return Settings(first_run=True)
    name = payload.get("user_name")
    if not isinstance(name, str):
        return Settings(first_run=False)
    return Settings(user_name=name.strip()[:MAX_NAME_LENGTH], first_run=False)


def save_settings(library: Path, *, user_name: str) -> Settings:
    """写设置（原子写：先写临时文件再替换，避免中途断电写出半个 JSON）。"""
    target_library = Path(library)
    target_library.mkdir(parents=True, exist_ok=True)
    name = (user_name or "").strip()[:MAX_NAME_LENGTH]
    path = settings_path(target_library)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(
        json.dumps({"user_name": name}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    os.replace(temporary, path)
    return Settings(user_name=name, first_run=False)
