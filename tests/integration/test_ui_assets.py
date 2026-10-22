"""界面资源（index.html / app.css / app.js）的服务约定。

这里只测**服务端**能保证的事：三份文件都带 `Cache-Control: no-cache`（每次回源确认，
文件没变时回 304），以及页面里引用的入口是存在的。

起因是一次真机事故（2026-10-15）：浏览器缓存着旧 `app.js`，配上新 `index.html` 之后，
项目库照旧渲染、点"新建项目"报 `Cannot set properties of null (setting 'hidden')`——
旧脚本引用的节点在新页面里已经没有了。用户只能强制刷新才好。
`no-cache` 让这种"半新半旧"不再可能发生。
"""

from __future__ import annotations

import re
from pathlib import Path

from fastapi.testclient import TestClient

from book2text import paths

STATIC_DIR = Path(paths.STATIC_DIR)


def test_index_page_is_served(client: TestClient) -> None:
    response = client.get("/")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "Book2Text" in response.text


def test_ui_assets_revalidate_every_time(client: TestClient) -> None:
    """三份界面文件都必须 `no-cache`：本地应用是就地升级的，不能拿旧的配新的。"""
    for path in ("/", "/static/app.js", "/static/app.css"):
        response = client.get(path)
        assert response.status_code == 200, path
        assert response.headers.get("cache-control") == "no-cache", path


def test_ui_assets_still_return_304_when_unchanged(client: TestClient) -> None:
    """`no-cache` 不等于每次都重传：带 ETag 回源、文件没变就 304。"""
    first = client.get("/static/app.js")
    etag = first.headers["etag"]
    again = client.get("/static/app.js", headers={"If-None-Match": etag})
    assert again.status_code == 304
    assert again.headers.get("cache-control") == "no-cache"


# ---------------------------------------------------------------- 三件套是否对得上

def _ids_used_by_script() -> set[str]:
    """`app.js` 里 `el("…")` 取过的所有 id。"""
    source = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    return set(re.findall(r'el\("([A-Za-z0-9_-]+)"\)', source))


def _ids_in_page() -> set[str]:
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    return set(re.findall(r'id="([A-Za-z0-9_-]+)"', page))


def test_script_only_touches_ids_that_exist() -> None:
    """脚本取用的 id 必须都能在页面里找到（动态创建的那几个除外）。

    这条是给"改界面时漏删一处引用"兜底的：少一个 id 就会在运行时报
    `Cannot set properties of null`，而那通常只在某个具体操作路径上才暴露出来。
    """
    dynamic = {"merge-footer"}   # renderMergeFooter 里按需创建
    missing = _ids_used_by_script() - _ids_in_page() - dynamic
    assert not missing, f"app.js 引用了页面里不存在的 id：{sorted(missing)}"


def test_page_skeleton_has_all_views_and_entry_points() -> None:
    """页面必须有四个视图容器与顶栏的两组内容（项目库 / 项目）。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    for element_id in (
        "view-library",
        "view-pages",
        "view-review",
        "view-merge",
        "topbar-library",
        "topbar-project",
        "view-tabs",
        "page-grid",
        "detail-blocks",
        "merge-pages",
        "task-drawer",
    ):
        assert f'id="{element_id}"' in page, element_id


def test_page_view_has_zoom_controls_and_readonly_block_overlay() -> None:
    """页面视图缩放 + 只读块框是第 38 号任务加的三个入口。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    for element_id in (
        "pages-zoom-out",
        "pages-zoom-in",
        "pages-zoom-label",
        "pages-overlay-toggle",
    ):
        assert f'id="{element_id}"' in page, element_id

    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    assert "PAGE_ZOOM_LEVELS" in script
    assert 'image: "thumb"' in script
    assert 'image: "view"' in script
    assert 'image: "zoom"' in script
    assert "page-overlay--readonly" in script

    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")
    assert ".page-grid--page" in css
    assert ".page-overlay--readonly" in css
    # 标签贴框内（不是负 top 浮在框外）
    assert "top: 2px; left: 2px" in css


def test_page_confirmation_type_picker_is_a_flat_list_with_new_types() -> None:
    """类型是常驻列表（不是下拉），新类型与新颜色类都在页面里。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    assert 'id="selection-types"' in page
    assert 'id="selection-type"' not in page
    assert "版权" in page and "前言" in page
    assert "前置（其他）" in page

    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    assert "PAGE_TYPE_ORDER" in script
    assert 'copyright: "版权"' in script
    assert 'foreword: "前言"' in script
    assert "混合" in script

    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")
    assert ".ptype--copyright" in css
    assert ".ptype--foreword" in css
    assert ".ptype__suggest" in css
    assert ".page-tile--ptype-copyright" in css
