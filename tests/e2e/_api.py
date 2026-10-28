"""QA 侧的两条真相来源：HTTP API 与项目 SQLite 库。

断言写法约定：**UI 显示的数字要与 API/库对上**，而不是各算各的。
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable

import httpx

TOKEN_HEADER = "X-B2T-Token"


class Api:
    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = httpx.Client(
            base_url=self.base_url,
            headers={TOKEN_HEADER: token},
            timeout=httpx.Timeout(120.0, connect=10.0),
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "Api":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def get(self, path: str, **params: Any) -> Any:
        response = self._client.get(path, params=params)
        response.raise_for_status()
        return response.json()

    def post(self, path: str, payload: Any | None = None) -> Any:
        response = self._client.post(path, json=payload)
        response.raise_for_status()
        return response.json()

    # ------------------------------------------------------------ 常用读取

    def app_info(self) -> dict:
        return self.get("/api/app/info")

    def summary(self, project_id: str) -> dict:
        return self.get(f"/api/projects/{project_id}/summary")

    def finish_summary(self, project_id: str) -> dict:
        return self.get(f"/api/projects/{project_id}/review/finish-summary")

    def pages(self, project_id: str) -> list[dict]:
        return self.get(f"/api/projects/{project_id}/pages")["pages"]

    def blocks(self, project_id: str, page_no: int) -> dict:
        return self.get(f"/api/projects/{project_id}/pages/{page_no}/blocks")

    def page_numbers(self, project_id: str) -> dict:
        return self.get(f"/api/projects/{project_id}/page-numbers/summary")

    def preview(self, project_id: str, options: dict | None = None) -> dict:
        return self.post(f"/api/projects/{project_id}/export/preview", options or {})

    def preflight(self, project_id: str) -> dict:
        return self.post(f"/api/projects/{project_id}/export/preflight", {})


class Store:
    """直接读项目库（只读连接）。用于核对"提交后库里真的变了"。"""

    def __init__(self, project_dir: Path) -> None:
        self.path = project_dir / "project.db"
        self._conn = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)
        self._conn.row_factory = sqlite3.Row

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
        return list(self._conn.execute(sql, tuple(params)))

    def block(self, block_id: str) -> dict | None:
        rows = self.query("SELECT * FROM block WHERE block_id = ?", (block_id,))
        return dict(rows[0]) if rows else None

    def blocks_of_page(self, page_no: int) -> list[dict]:
        rows = self.query(
            """
            SELECT b.* FROM block b JOIN page p ON p.page_id = b.page_id
            WHERE p.page_no = ? AND b.deleted_at IS NULL
            ORDER BY b.order_index
            """,
            (page_no,),
        )
        return [dict(row) for row in rows]

    def page(self, page_no: int) -> dict | None:
        rows = self.query("SELECT * FROM page WHERE page_no = ?", (page_no,))
        return dict(rows[0]) if rows else None

    def export_records(self) -> list[dict]:
        return [dict(row) for row in self.query("SELECT * FROM export_record ORDER BY rowid")]

    def undo_events(self, limit: int = 10) -> list[dict]:
        try:
            return [
                dict(row)
                for row in self.query(
                    "SELECT * FROM event WHERE kind LIKE '%undo%' ORDER BY rowid DESC LIMIT ?",
                    (limit,),
                )
            ]
        except sqlite3.OperationalError:
            return []


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def block_fingerprint(blocks: Iterable[dict]) -> str:
    """一组块的"字节指纹"：按 id 排序后把 id + 原文 + 状态拼起来做哈希。

    撤销断言用它：撤销后必须**逐字节**回到提交前，不只是"看起来一样"。
    刻意**不含** updated_at / revision 这类时间戳与计数：它们本来就会随每次写入变化，
    比它们只会制造假失败。比的是内容字段。
    """
    payload = [
        {
            "block_id": block["block_id"],
            "text": block["text"],
            "ocr_text": block["ocr_text"],
            "review_status": block["review_status"],
            "include": block["include"],
            "continues_to_next": block.get("continues_to_next"),
        }
        for block in sorted(blocks, key=lambda item: item["block_id"])
    ]
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
