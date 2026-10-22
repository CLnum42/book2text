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
    # 第 42 号任务：横幅式标签已撤掉，默认只有颜色 + 极小顺序号，文字进悬停卡片
    assert ".page-overlay .box__label" in css
    assert ".box__label-hint" in css
    assert "box__badge" not in css


def test_block_frames_work_in_all_zoom_levels_and_default_to_on() -> None:
    """第 44 号任务：四档都能画块框、默认开、网格只画色框、每帧限量。"""
    script = _script()
    # 新存储键 + 没存过就是开（老用户 v1 存着 "0" 也不受影响）
    assert "b2t.pagesOverlay.v2." in script
    assert 'return stored === null ? true : stored === "1"' in script
    # 四档都可用：不再用 zoom >= 2 挡住开关
    assert 'el("pages-overlay-toggle").disabled = false' in script
    toggle = _function_body("togglePageBlocksOverlay")
    assert "pageZoomIndex" not in toggle
    # 网格 / 大网格只画色框；单列 / 单页才建顺序号
    render = _function_body("renderPageBlocks")
    assert "const showDetails = pageZoomIndex >= 2" in render
    assert "if (showDetails)" in render
    # 每帧 3 页 + 在途请求上限（第 46 号任务从 3 提到 6）；滚动位置缓存，不再每帧量 267 个矩形
    assert "PAGE_OVERLAY_FRAME_LIMIT = 3" in script
    assert "PAGE_BLOCK_FETCH_LIMIT = 6" in script
    assert "pageTileMetrics" in script
    assert "function pumpOverlayRender(" in script

    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")
    order_rule = css[css.index(".page-overlay .box__order {"):]
    order_rule = order_rule[: order_rule.index("}")]
    assert "font-size: 11px" in order_rule
    assert "opacity: .72" in order_rule
    assert "rgba(255, 255, 255, .82)" in order_rule


def test_block_frame_default_has_no_type_text_and_hover_card_is_placed_outside() -> None:
    """块框默认不遮字：只有颜色 + 顺序号；类型 / 把握 / 采用 / 页码进悬停卡片。

    静态约定 + 真浏览器验收（见开发日志任务 42）：顺序号与卡片的位置由
    `findOrderSpot` / `findLabelSpot` 按块框与行框找空位，不是写死 top/left。
    """
    script = _script()
    for name in (
        "buildBoxOrder",
        "buildBoxLabel",
        "findOrderSpot",
        "findLabelSpot",
        "layoutOverlayAnnotations",
        "scheduleOverlayLayout",
    ):
        assert f"function {name}(" in script, name

    # 默认顺序号只有数字；类型文字只进悬停卡片
    assert "order.textContent = String(index + 1)" in script
    assert "box.append(buildBoxOrder(index));" in script
    assert "box.append(buildBoxLabel(block, index, suggestion));" in script
    # 审校视图与页面视图共用同一套
    assert "box.append(buildBoxLabel(block, index, null));" in script
    # 页码提示只在卡片里
    assert "pageNumber.classList.add(\"box__label-hint\")" in script
    # 「采用」按钮阻止拖动 / 冒泡，避免点按钮时挪框
    assert "adoptBlockSuggestion(suggestion);" in script

    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")
    assert ".page-overlay .box__order" in css
    assert ".box__label-head" in css
    # 悬停 / 选中才显示；同一时刻只显示一张
    assert ".page-overlay .box:hover .box__label" in css
    assert ".page-overlay:hover .box--active:not(:hover) .box__label" in css
    # 页面视图只给块框本身开 pointer-events，点击冒泡到 tile，选页不变
    assert ".page-overlay--readonly.page-overlay--labeled .box { pointer-events: auto; }" in css


def test_page_confirmation_type_picker_has_exactly_five_types_and_no_include_switch() -> None:
    """页面类型收成五类（2026-10-22 用户拍板）；界面上不再有纳入 / 排除按钮。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    assert 'id="selection-types"' in page
    assert 'id="selection-type"' not in page
    for label in ("正文", "正文排除", "目录", "前置", "后置"):
        assert label in page, label
    assert 'id="selection-include"' not in page
    assert 'id="selection-exclude"' not in page
    # 导出与筛选的选择器也只有五类
    assert 'name="export-page-type"' in page
    for value in ("body", "body_excluded", "toc", "front", "back"):
        assert f'name="export-page-type" value="{value}"' in page, value

    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    assert "PAGE_TYPE_ORDER" in script
    for key, label in (
        ("body", "正文"),
        ("body_excluded", "正文排除"),
        ("toc", "目录"),
        ("front", "前置"),
        ("back", "后置"),
    ):
        assert f'{key}: "{label}"' in script, key
    # 旧的十类不该再出现在前端类型表 / 排序里
    assert "PAGE_TYPE_ORDER = [\"body\", \"body_excluded\", \"toc\", \"front\", \"back\"]" in script
    assert "混合" in script
    # 没有"直接设 include"的界面入口
    assert "patchSelectedPages({ include:" not in script

    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")
    assert ".ptype--body_excluded" in css
    assert ".ptype--back" in css
    assert ".ptype--copyright" not in css
    assert ".ptype__suggest" in css


def test_page_layout_panel_and_filter_are_present() -> None:
    """第 45 号任务：整页版面确认面板 + “版面未确认”筛选 + 旁批类型。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    for element_id in ("layout-panel", "layout-panel-status", "layout-confirm"):
        assert f'id="{element_id}"' in page, element_id
    assert page.count('value="layout_unconfirmed"') == 2, "页面视图与审校视图都要有筛选"
    assert 'id="suggestion-apply-all"' in page

    script = _script()
    assert "function renderLayoutPanel(" in script
    assert "function confirmPageLayout(" in script
    assert "layout_unconfirmed" in script
    assert 'margin_note: "旁批"' in script

    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")
    assert ".box--type-margin_note" in css
    assert ".layout-panel" in css


# ---------------------------------------------------------------- 任务 41：建议徽章 / 抽屉

def _script() -> str:
    return (STATIC_DIR / "app.js").read_text(encoding="utf-8")


def _function_body(name: str) -> str:
    """截取 `function name(...) { ... }` 的源码，直到下一个顶层函数或分隔线。

    只用于"这个函数里有没有调用某个入口"这类静态约定：界面没有 JS 测试运行器，
    真正的行为验收在真浏览器里做（见开发日志任务 41）。
    """
    source = _script()
    match = re.search(rf"\n(?:async )?function {name}\(", source)
    assert match, f"app.js 里没有 function {name}("
    start = match.start()
    rest = source[match.end():]
    end = re.search(r"\n(?:async )?function [A-Za-z0-9_]+\(|\n// -{10,}", rest)
    return source[start: match.end() + (end.start() if end else len(rest))]


def _strip_js_comments(text: str) -> str:
    """去掉 `//` 行注释：注释里说明"以前这里会 openTaskDrawer()"不算调用。"""
    return "\n".join(line.split("//")[0] for line in text.splitlines())


def test_block_type_suggestions_are_wired_to_the_existing_patch() -> None:
    """建议进审校视图：块头徽章 + 采用（走 PATCH block_type）+ 只对 high 批量。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    assert 'id="suggestion-apply-all"' in page

    script = _script()
    assert "/block-suggestions" in script
    assert "detailSuggestionByBlock" in script
    assert "blockSuggestionBadge" in script
    assert "adoptBlockSuggestion" in script
    assert "adoptAllHighSuggestions" in script
    # 批量采用只拿 high；review 必须逐条点
    assert 'suggestionHighList()' in script
    assert 'item.confidence === "high"' in script
    # 书眉里的页码只展示，不自动拆块 / 改文本
    assert "含页码" in script
    assert "review-suggest__pagenum" in script

    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")
    assert ".review-suggest" in css
    assert ".review-suggest__pagenum" in css
    assert ".review-suggest--heading" in css


def test_page_view_suggestion_mark_only_counts_high_and_only_seen_pages() -> None:
    """页面视图角标：只在算过的可见页出现、只数 high，且不为 267 页一次性拉取。"""
    script = _script()
    assert "page-tile__suggest" in script
    assert "ensurePageSuggestion" in script
    assert "PAGE_SUGGESTION_CONCURRENCY" in script
    assert "PAGE_SUGGESTION_CACHE_LIMIT" in script
    assert "建议 ${high.length}" in script
    # 网格档滚动停下来才扫；大图档在可见性循环里扫
    assert "scheduleSuggestionScan" in script
    assert "scanVisiblePageSuggestions" in script

    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")
    assert ".page-tile__suggest" in css


def test_task_drawer_does_not_reopen_itself_while_a_task_runs() -> None:
    """抽屉只由用户操作打开；轮询 renderTask 不许开抽屉；失败只主动提示一次。

    这是一条静态约定：界面没有 JS 测试运行器，真实行为在真浏览器里复现过
    （关掉抽屉后任务跑到 2/3 都没再弹；见开发日志任务 41）。
    """
    render_task = _strip_js_comments(_function_body("renderTask"))
    assert "openTaskDrawer" not in render_task
    assert "drawer-status" in render_task  # 确认截到的是 renderTask 的本体

    poll_task = _function_body("pollTask")
    assert "announceTaskFailure(data.job)" in poll_task
    assert "openTaskDrawer()" in poll_task  # 只在失败提示的分支里

    announce = _function_body("announceTaskFailure")
    assert "taskFailureAnnouncedFor" in announce
    assert "openTaskDrawer" not in announce
    assert 'job.status === "failed"' in announce
    assert 'job.status === "interrupted"' in announce

    script = _script()
    # 显式打开只剩这几处：启动任务（3 处）、点 pill、最近任务里的「查看」
    assert script.count("openTaskDrawer();") >= 3
    assert 'el("task-chip").addEventListener("click"' in script



# ---------------------------------------------------------------- 任务 46：块框实时性


def test_block_frames_refresh_as_pages_finish_and_prefetch_while_scrolling() -> None:
    """第 46 号任务：识别到哪框出现在哪；滚动停下不再等一轮网络。

    界面没有 JS 测试运行器，这里是静态约定；真实行为在今天真浏览器里量过
    （见开发日志任务 46 的前后数字）。
    """
    script = _script()

    # 1) 先查清"块框不出现"的真因：瓷砖位置在隐藏视图里被量成 0，
    #    267 页全被判成可见。现在宁可量不出来就不记，等视图可见再量。
    capture = _function_body("capturePageTileMetrics")
    assert "getBoundingClientRect().height <= 0" in capture
    assert "pageTileMetrics = null" in capture
    # 切回页面视图时强制重量
    show_view = _function_body("showView")
    assert "pageTileMetrics = null" in show_view

    # 2) 识别完成 → 当场作废旧块并重画（页面视图）/ 重载（审校视图）
    poll = _function_body("pollTask")
    assert "collectNewlySucceededPages(data)" in poll
    assert "refreshRecognizedPages(donePages)" in poll
    collect = _function_body("collectNewlySucceededPages")
    assert 'item.status !== "succeeded"' in collect
    assert "taskRefreshedPages" in collect  # 每页只处理一次，轮询不重复重拉
    refresh = _function_body("refreshRecognizedPages")
    assert "forgetPageBlocks(pageNo)" in refresh
    assert "queueOverlayRender(pageNo)" in refresh
    # 审校视图：正在看的那一页重新载入（先落库再重绘，别盖掉没存完的输入）
    reload_detail = _function_body("reloadDetailAfterRecognition")
    assert "flushPendingSave()" in reload_detail
    assert "loadPageDetail(pageNo, { forceSuggestions: true })" in reload_detail
    # 在途请求晚到也不能把旧块写回缓存
    assert "pageBlockVersions" in script
    fetch = _function_body("fetchPageBlocks")
    assert "pageBlockVersions.get(key) || 0) !== version" in fetch

    # 3) 提前预取 + 并发 / 缓存上限
    assert "PAGE_BLOCK_CACHE_LIMIT = 80" in script
    assert "PAGE_BLOCK_PREFETCH_LIMIT = 4" in script
    assert "PAGE_BLOCK_PREFETCH_BURST = 8" in script
    assert "function pumpPageBlockPrefetch(" in script
    visibility = _function_body("updatePageVisibility")
    assert "prefetchBand" in visibility
    assert "pumpPageBlockPrefetch(prefetchCandidates)" in visibility
    # 只为已识别的页预取，不为整本未识别页发空请求
    prefetch = _function_body("pumpPageBlockPrefetch")
    assert 'recognitionOf(page).status !== "recognized"' in prefetch
    # 有缓存就这一帧画，不等下一个 rAF
    assert "drawnSynchronously" in visibility

    # 4) 网格档滚动停下的扫描更快，且不再为 267 个瓷砖各量一次矩形
    assert "setTimeout(scanVisiblePageSuggestions, 60)" in script
    scan = _function_body("scanVisiblePageSuggestions")
    assert "pageTileMetrics" in scan
    assert "byTile" in scan


# ---------------------------------------------------------------- 任务 47：拆分 / 批量拆页码

def test_split_page_number_and_batch_split_are_wired() -> None:
    """单块「把页码拆出去」+ 批量预览/执行，都沿用现有编辑与撤销机制。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    for element_id in (
        "split-page-numbers",
        "split-batch-panel",
        "split-batch-apply",
        "split-batch-summary",
        "split-batch-list",
        "split-batch-scope",
    ):
        assert f'id="{element_id}"' in page, element_id

    script = _script()
    # 单块：菜单项只在"这块真的贴着块首 / 块尾有页码候选"时出现，点了才拆
    assert "function pageNumberSplitHint(" in script
    assert '`把页码 ${numberHint.text} 拆出去`' in script
    assert "/split-page-number" in script
    # 批量：先 dry_run 预览、再 dry_run: false 执行；范围是选中页 / 全部正文页
    assert "function openSplitBatchPanel(" in script
    assert "function renderSplitBatchPreview(" in script
    assert "dry_run: true" in script and "dry_run: false" in script
    assert "/split-page-numbers" in script
    assert "pages_affected" in script
    # 拆完 / 撤销后页面视图的块框缓存与建议都要作废（否则还显示拆分前的框）
    assert "forgetPageBlocks(detailPageNo)" in script

    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")
    assert ".split-batch-list" in css


# ---------------------------------------------------------------- 任务 48：全库采用建议

def test_full_library_suggestion_apply_and_auto_apply_switch_are_wired() -> None:
    """「全库采用高把握建议」与「识别完成后自动应用」两个入口。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    for element_id in (
        "apply-high-suggestions",
        "auto-apply-suggestions",
        "auto-apply-status",
        "suggestion-apply-panel",
        "suggestion-apply-summary",
        "suggestion-apply-run",
        "review-apply-all",
        "auto-apply-notice",
        "auto-apply-undo",
    ):
        assert f'id="{element_id}"' in page, element_id

    script = _script()
    # 先扫描（dry_run）再应用；两个视图都能打开同一个对话框
    assert "/suggestions/apply" in script
    assert "dry_run: true" in script and "dry_run: false" in script
    assert 'el("review-apply-all").addEventListener' in script
    # 项目级设置与自动应用记录
    assert "/settings" in script
    assert "auto_apply_high_suggestions" in script
    assert "/auto-apply" in script
    assert "undoAutoApply" in script
    # 任务收尾时查"这一趟有没有新的自动应用"
    poll = _function_body("pollTask")
    assert "loadAutoApplyStatus({ announce: true, jobId: data.job.job_id })" in poll

    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")
    assert ".suggestion-type" in css


# ---------------------------------------------------------------- 任务 49：漏行 + 框选识别

def test_ink_gap_hint_and_region_recognition_are_wired() -> None:
    """漏行提示条 + 图上的候选框 → 框选面板「识别这块」。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    for element_id in (
        "ink-gap-bar",
        "ink-gap-text",
        "ink-gap-toggle",
        "detail-ink-gaps",
        "box-select-recognize",
        "box-select-status",
    ):
        assert f'id="{element_id}"' in page, element_id

    script = _script()
    assert "loadInkGaps" in script and "/ink-gaps" in script
    assert "startRegionRecognition" in script
    assert "recognizeBoxRegion" in script and "/recognize-region" in script
    # 识别结果进"框选新增块"的输入框：不直接落库，用户确认后才创建
    assert 'el("box-select-text").value = data.text' in script
    # 进审校页就会查一次漏行
    assert "loadInkGaps(pageNo)" in script

    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")
    assert ".ink-gap-bar" in css
    assert ".ink-gap " in css or ".ink-gap {" in css
