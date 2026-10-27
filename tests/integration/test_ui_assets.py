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
        "workflow-steps",
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
    assert "details = pageZoomIndex >= 2" in render, "目录确认可以强制显示序号"
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
    assert "PAGE_TYPE_ORDER = [\"front\", \"toc\", \"body\", \"body_excluded\", \"back\"]" in script
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


def test_margin_view_is_wired_to_the_page_view() -> None:
    """版心视图（任务 50 / 36B）：开关、面板、拖拽把手都必须真的接上。

    静态约定测试，防止"页面里加了按钮、脚本里忘了监听"这种半截改动。
    任务 36B 起版心分区只有"看四边 / 重置为本页自动 / 撤销"三件事：
    没有模式选择卡片，也没有折叠的「检测」按钮，进这一步自动拟合未定的页。
    """
    page_html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    styles = (STATIC_DIR / "app.css").read_text(encoding="utf-8")

    for element_id in (
        "pages-margin-toggle",
        "margin-panel",
        "panel-margin-settings",
        "margin-page-state",
        "margin-page-actions",
        "margin-edges",
        "margin-basis",
        "margin-next",
        "margin-detect-hint",
        "margin-fit-progress",
    ):
        assert f'id="{element_id}"' in page_html, element_id

    # 检测入口不占版心步主位，挪进右上角「⋯」；检测计划单独一个对话框
    assert 'id="margin-detect-missing"' not in page_html
    assert 'id="layout-detect-open"' in page_html
    assert 'id="layout-detect-mask"' in page_html
    # 没有检测行时不许说"已自动拟合"：文案按这一页的真实状态出
    assert "版心已自动拟合；拖动四边调整，不改也算已定" not in script
    assert "这一页还没有可用的正文行（识别行 / 检测行都没有），版心暂时生成不了" in script

    # 模式选择卡片已经拿掉：页面上不许再出现这四个来源按钮
    assert 'id="margin-modes"' not in page_html
    assert 'id="margin-batch-modes"' not in page_html
    assert "renderMarginModeButtons" not in script

    # 四边 + 四角共 8 个把手；拖动要吸附到行边界（复用 nearestEdge）
    assert "page-margin__handle--${edge}" in script
    assert '"nw", "ne", "sw", "se"' in script
    assert "nearestEdge(" in script
    # 按项目记住开关；不写项目数据库
    assert "b2t.pagesMargin.v1." in script
    # 批量重置走三态接口；自动拟合走 fit-all（带 only_missing）
    assert "margin-box/pages" in script
    assert "/margin-box/fit-all" in script
    assert "only_missing: true" in script
    # 拖动松手写一次库，并标 custom（自动拟合不会覆盖它）
    assert 'margin_box_mode: "custom"' in script
    assert "function undoMarginEdit(" in script
    assert "page-margin__box" in styles
    assert ".margin-step__actions" in styles


def test_export_margin_judgement_and_optional_notes_are_wired() -> None:
    """导出面板：按版心判定（项目设置）与「同时导出注释」必须真的接上。"""
    page_html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")

    assert 'id="export-margin-judgement"' in page_html
    assert 'id="export-include-notes"' in page_html
    assert "按版心判定正文" in page_html
    assert "同时导出注释" in page_html

    # 设置项与导出选项都要进请求；预检要显示版心两层的数字
    assert "margin_box_judgement" in script
    assert "include_notes" in script
    assert "margin_judgement" in script
    assert "margin_blocks" in script
    assert "margin_notes" in script


def test_page_suggestion_badge_counts_only_high_confidence() -> None:
    """页面视图「建议 N」只数 high——脚注 / 旁批永远 review，不会污染它。"""
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    assert 'item.confidence === "high"' in script
    assert "paintTileSuggestionMark" in script


def test_review_view_shows_margin_and_filters_blocks() -> None:
    """任务 53：审校视图显示版心、默认只列版心内的块，且"隐藏"不等于"不可操作"。

    静态约定测试：脚本里必须真的调用了这些路径，页面里必须有对应节点。
    真实几何 / 过滤在真浏览器验收里；这里防止"加了个按钮但没接上"。
    """
    page_html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    styles = (STATIC_DIR / "app.css").read_text(encoding="utf-8")

    for element_id in (
        "detail-margin",
        "review-margin-toggle",
        "review-filter",
        "review-filter-note",
    ):
        assert f'id="{element_id}"' in page_html, element_id
    assert 'data-margin-filter="pending"' in page_html
    assert 'data-margin-filter="inside"' in page_html
    assert 'data-margin-filter="outside"' in page_html
    assert 'data-margin-filter="all"' in page_html

    # 任务 61：默认「待处理」；开关按项目记住且默认开
    assert 'let reviewBlockFilter = "pending";' in script
    assert "function blockNeedsReview(" in script
    assert "function pendingPageReasons(" in script
    assert "/review/pending" in script
    assert "review-auto-pass" in page_html
    assert "review-auto-revoke" in page_html
    assert "/auto-pass" in script
    assert "/auto-pass/revoke" in script
    assert "b2t.reviewMargin.v1." in script
    assert '!== "0"' in script

    # 判定与过滤用中心点（与导出的第一层同口径）；没有版心时不隐藏任何块
    assert "function blockInsideMargin(" in script
    assert "function reviewMarginSplit(" in script
    assert "if (!box) return true;" in script

    # 被过滤挡住的块要能通过"全部"重新出现（框选新增 / 撤销聚焦的兜底）
    assert "function ensureBlockListed(" in script
    assert "ensureBlockListed(" in script

    # 自动推算版心的来源 / 时间 / 建议直接显示
    assert "margin_box_source" in script
    assert "margin_box_suggestion" in script
    assert "function marginSourceText(" in script
    # 任务 34：审校默认只算版心内；版心外的差异在页头 / 过滤条写"未计入"
    assert "function blockCountedInMargin(" in script
    assert "处差异未计入" in script
    assert "整页都计入" in script

    # 审校原图上的版心只读（没有把手）；版心外的框变淡 / 虚线
    assert "page-margin--review" in styles
    assert ".box--outside-margin" in styles
    assert ".review-filter {" in styles


def test_right_panel_has_four_ordered_collapsible_sections() -> None:
    """任务 54：右栏固定四分区，顺序不再变；页码设置只放说明，不放按钮。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")

    order = [
        "panel-page-settings",
        "panel-margin-settings",
        "panel-pagenum-settings",
        "panel-recognition-settings",
    ]
    positions = [page.index(f'id="{name}"') for name in order]
    assert positions == sorted(positions), "四分区顺序必须是 页面类型 → 版心 → 页码 → 识别"
    for title in ("页面类型", "版心", "页码（可跳过）", "识别设置"):
        assert title in page, title
    # 任务 64：手风琴一次只开一个，默认由 JS 选第一个未完成的分区；不写死 open。
    for name in order:
        assert f'id="{name}" open' not in page, name
    assert "b2t.panel.accordion.v1." in script
    assert "function initPanelAccordion(" in script
    assert "function firstUnfinishedPanel(" in script
    # 页码（任务 55/64）有真实入口和"可跳过 / 未定位也能导出"说明
    pagenum = page[positions[2]:positions[3]]
    assert 'id="page-number-open"' in pagenum
    assert "未定位也能导出" in pagenum
    assert "下一刀" not in pagenum

    # 五类按自然顺序排列
    assert 'PAGE_TYPE_ORDER = ["front", "toc", "body", "body_excluded", "back"]' in script


def test_recognition_settings_are_wired_to_project_settings() -> None:
    """识别设置必须真接上：控件 id、PATCH settings、以及不可用引擎的置灰逻辑。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")

    for element_id in (
        "rec-engine",
        "rec-dpi",
        "rec-language",
        "rec-dual-strategy",
        "rec-engine-note",
        "rec-summary",
        "rec-status",
    ):
        assert f'id="{element_id}"' in page, element_id
    for value in ("rapidocr", "apple_vision", "dual"):
        assert f'value="{value}"' in page, value
    for dpi in ("150", "200", "300"):
        assert f'name="rec-dpi" value="{dpi}"' in page, dpi

    # 设置写服务端；不可用引擎置灰（Windows 上 Apple Vision / 双引擎）
    assert "function patchRecognitionSetting(" in script
    assert '"/settings"' in script or "}/settings`" in script
    assert "function renderRecognitionSettings(" in script
    assert "option.disabled = needsVision && !visionOk" in script
    assert "function setupRecognitionSettings(" in script
    # 双引擎不自动采用、策略只影响显示
    assert "不会自动采用" in page
    assert "function divergenceCandidatesOn(" in script
    assert 'dual_engine_strategy === "candidates"' in script


def test_page_number_panel_is_wired() -> None:
    """任务 55：页码模板入口、候选列表、采用、异常分组都必须真的接上。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    styles = (STATIC_DIR / "app.css").read_text(encoding="utf-8")

    for element_id in (
        "page-number-summary",
        "page-number-open",
        "page-number-panel",
        "page-number-close",
        "page-number-templates",
        "page-number-template-count",
        "page-number-apply",
        "page-number-result",
        "page-number-mapping",
        "page-number-anomalies",
        "page-number-done",
    ):
        if element_id == "page-number-apply":
            # 采用按钮在每张模板卡里动态创建，不是页面固定节点
            continue
        assert f'id="{element_id}"' in page, element_id

    assert "/page-numbers" in script
    assert "/page-numbers/apply" in script
    assert "function renderPageNumberAnomalies(" in script
    assert "function adoptPageNumberTemplate(" in script
    assert "offset_break" in script and "no_candidate" in script
    assert "not_recognized" in script
    assert "未定位" in page
    assert ".pn-template" in styles and ".pn-mapping" in styles


def test_page_number_review_and_range_templates_are_wired() -> None:
    """任务 56：页码审校对话框、逐页手动映射、第二套页码范围都要真的接上。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    styles = (STATIC_DIR / "app.css").read_text(encoding="utf-8")

    for element_id in (
        "page-number-review-open",
        "page-number-review-panel",
        "page-number-review-close",
        "page-number-review-meta",
        "page-number-review-filters",
        "page-number-review-issues",
        "page-number-review-table",
        "page-number-review-assignments",
        "page-number-review-done",
    ):
        assert f'id="{element_id}"' in page, element_id

    # 手动映射、移除范围、按范围采用模板
    assert "/page-numbers/manual" in script
    assert "/page-numbers/ranges/remove" in script
    assert 'body: JSON.stringify({ template, range })' in script
    assert "function renderPageNumberReview(" in script
    assert "PN_ANOMALY_LABELS" in script and "duplicate" in script
    assert "page-number-review-table li[data-page-no=" in script
    assert ".pn-table" in styles and ".pn-issue-list" in styles


def test_layout_detection_and_workflow_filter_are_wired() -> None:
    """任务 58：版面检测入口、工作流筛选与角标都要真的接上（静态约定）。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")

    for element_id in (
        "filter-workflow",
        "layout-panel",
        "panel-layout-blocks",
        "layout-block-status",
        "layout-block-confirm",
        "layout-detect-open",
    ):
        assert f'id="{element_id}"' in page, element_id

    assert "/jobs/layout" in script
    assert "/workflow" in script
    assert "function loadWorkflow(" in script
    assert "function workflowChip(" in script
    assert "startLayoutDetection" in script
    assert 'layout: "版面检测"' in script
    # 检测入口在「⋯」里：先看计划（几页 / 大概多久）再决定跑不跑
    assert "function openLayoutDetectDialog(" in script
    assert "/layout/plan" in script
    assert "function refreshMarginDetectHint(" in script
    assert "prepare: true" in script
    # 版面块确认搬到「页面确认」步（不再是版心分区里的折叠项）
    assert "function renderLayoutBlocks(" in script
    assert "function confirmLayoutFromPanel(" in script
    assert "/layout/confirm" in script
    # 工作流筛选有"已检测（未识别）"这一档
    assert 'value="detected"' in page
    assert '"已检测 · 未识别"' in script
    # 任务完成后要刷新工作流状态（识别 → 已识别①；检测 → 已检测）
    poll = _function_body("pollTask")
    assert "loadWorkflow" in poll


def test_review_diff_queue_is_wired_for_local_adoption() -> None:
    """任务 65：页内差异队列、键位、局部更新、页头收敛都真的接上。

    静态约定测试：队列 DOM / 快捷键 / "采纳不整页重载"的实现方式 / 队列模式隐藏差异条。
    """
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    styles = (STATIC_DIR / "app.css").read_text(encoding="utf-8")

    for element_id in (
        "diff-queue",
        "diff-queue-toggle",
        "diff-queue-position",
        "diff-queue-meta",
        "diff-queue-text",
        "diff-queue-dots",
        "queue-adopt",
        "queue-keep",
        "queue-prev",
        "review-footer-count",
        "review-more-menu",
    ):
        assert f'id="{element_id}"' in page, element_id

    assert "function initDiffQueue(" in script
    assert "function adoptQueueCurrent(" in script
    assert "function applyQueueAckLocally(" in script
    assert "/diff-ack" in script
    assert "function ackQueueLine(" in script
    assert 'ackQueueLine(block, item.lineIndex, "kept")' in script
    assert "function renderReviewHeadline(" in script
    # 采纳路径不能调用整页重载（否则滚动位置与列表都会丢）
    start = script.index("async function adoptQueueCurrent(")
    end = script.index("function keepQueueCurrent(", start)
    adopt_body = script[start:end]
    assert "loadPageDetail(" not in adopt_body
    assert "renderReviewBlocks(" not in adopt_body
    # 键位：Enter / Space 采纳，⌫ 保留，← 回上一处
    assert 'event.key === "Enter" || event.key === " "' in script
    assert 'event.key === "Backspace"' in script
    assert 'event.key === "ArrowLeft"' in script
    # 队列打开时块内差异条隐藏
    assert "body.queue-mode .diff-strip" in styles


def test_finish_panel_and_batch_actions_are_wired() -> None:
    """任务 66：收尾面板六状态、两个批量动作、入口与真实进度都接上。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")

    for element_id in (
        "finish-open",
        "finish-open-review",
        "finish-drawer",
        "finish-close",
        "finish-row-page-type",
        "finish-row-margin",
        "finish-row-layout",
        "finish-row-pagenum",
        "finish-row-review",
        "finish-row-engine",
        "finish-confirm-layout",
        "finish-auto-pass",
        "finish-layout-progress",
        "finish-auto-progress",
        "finish-bottom-note",
        "finish-start-review",
        "finish-export",
    ):
        assert f'id="{element_id}"' in page, element_id

    assert "/review/finish-summary" in script
    assert "/review/auto-pass" in script
    assert "/review/auto-pass/revoke" in script
    # 批量版面确认走已有的批量接口，发 page_numbers（不是循环单页请求）
    assert "page_numbers: chunk" in script
    assert "layout/confirm" in script
    # 停止 / 续跑
    assert "finishLayoutStop" in script and "finishLayoutRemaining" in script
    assert "finishAutoStop" in script and "finishAutoRemaining" in script


def test_trash_select_all_and_margin_visual_are_wired() -> None:
    """任务 35：废纸篓、全选 / 取消全选 / 点空白取消、版心视觉都真的接上。"""
    page_html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    styles = (STATIC_DIR / "app.css").read_text(encoding="utf-8")

    for element_id in (
        "trash-open",
        "trash-panel",
        "trash-list",
        "trash-empty",
        "trash-error",
        "selection-select-all",
        "selection-clear",
    ):
        assert f'id="{element_id}"' in page_html, element_id

    assert "/api/trash" in script
    assert "confirm=true" in script
    assert "function deleteProject(" in script
    assert "function loadTrash(" in script
    assert "restoreTrashProject(" in script
    assert "purgeTrashProject(" in script
    assert "移入废纸篓" in script
    assert "无法恢复" in script

    # 全选 / 取消 / ⌘A / Esc / 点空白取消
    assert "function selectAllVisiblePages(" in script
    assert "function clearPageSelection(" in script
    assert 'event.key.toLowerCase() === "a"' in script
    assert 'event.key === "Escape"' in script
    assert 'event.target.closest(".page-tile")' in script
    assert "不在当前筛选" in script

    # 版心视觉：1px 边框 + 更深的版心外灰度
    assert "border: 1px solid #0b5f58;" in styles
    assert "rgba(15, 18, 24, .34)" in styles
    assert "rgba(15, 18, 24, .30)" in styles
    # 把手还在（改细不能把拖动弄丢）
    assert ".page-margin__handle" in styles


def test_workflow_step_shell_is_wired() -> None:
    """任务 36A：五步步骤条 + 分页器搬家 + 旧三标签删除。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    styles = (STATIC_DIR / "app.css").read_text(encoding="utf-8")

    for element_id in (
        "workflow-steps",
        "workflow-current",
        "review-toolbar",
        "review-pager",
        "review-prev",
        "review-next",
        "review-jump",
    ):
        assert f'id="{element_id}"' in page, element_id

    # 旧导航删除，没有残留
    assert 'id="view-tabs"' not in page
    assert 'id="export-open"' not in page
    assert ".tabs {" not in styles

    # 五步与判定来源
    for label in ("页面确认", "版心确认", "文字识别", "正文审校", "文件导出"):
        assert label in script, label
    for name in (
        "function stepProgress(",
        "function syncWorkflowSteps(",
        "function goToWorkflowStep(",
        "function openExportPanel(",
    ):
        assert name in script, name
    # 完成判定只读收尾面板 / 质量统计 / 导出记录
    assert "finishSummary" in script
    assert "projectSummary" in script
    assert "projectExports" in script
    assert "page_type" in script
    assert "undetermined" in script
    assert "engine.complete" in script
    assert "needs_human" in script

    # 三档响应式
    assert "@media (max-width: 1319px)" in styles
    assert "@media (max-width: 1119px)" in styles
    assert "workflow-step__short" in styles
    assert "workflow-current" in styles
    # 分页器在工作区工具条里
    assert ".workspace-toolbar" in styles


def test_workflow_steps_scope_the_right_panel() -> None:
    """任务 36B：右栏按步骤只显示本步分区；版心步没有模式选择，进来自动拟合。

    静态约定测试抓"这一步不该出现的东西"：页面确认看到版面块、版心确认只有版心、
    文字识别只有状态；这三件事各自由哪段脚本接线，也必须真的存在。
    """
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")

    # 分区节点：页面确认步的「版面块」、文字识别步的「识别状态」
    for element_id in (
        "panel-layout-blocks",
        "layout-block-status",
        "layout-block-suggestions",
        "layout-block-apply-all",
        "layout-block-confirm",
        "panel-recognition-status",
        "rec-status-metrics",
    ):
        assert f'id="{element_id}"' in page, element_id

    # 按步显示分区的接线
    assert "function renderStepPanels(" in script
    for panel in (
        "panel-page-settings",
        "panel-layout-blocks",
        "panel-margin-settings",
        "panel-recognition-status",
        "panel-recognition-settings",
    ):
        assert f'group("{panel}"' in script, panel
    # body 上带步骤，CSS 据此只放本步的开关（块框 / 版心不同时出现）
    assert "document.body.dataset.workflowStep" in script
    assert 'data-workflow-step="margin"' in css
    assert 'data-workflow-step="pages"' in css

    # 版心步：进来自动拟合未定的页；只碰 auto 且没有框的页
    assert "function ensureMarginFitted(" in script
    assert "function marginUndeterminedPages(" in script
    assert "function marginPagesWithoutLines(" in script
    assert "function pageLayoutLines(" in script
    # 有行可拟合 = 检测行 + 识别行（刀 1：没有检测行也能用 OCR 行拟合）
    assert "function pageHasFitLines(" in script
    assert "function pageTextLines(" in script
    # 不再由前端按"检测行数"预筛：后端回退识别行，无文字的页单独报 no_text
    assert "pageLayoutLines(page) > 0 && !marginFitTried.has(page.page_no)" not in script
    assert 'Number(data.no_text || 0)' in script
    assert "function marginFitSummaryText(" in script
    assert "页没有文字（插图 / 空白），跳过" in script
    assert "页还没有可用的正文行，版心未定" in script
    # 面板只剩三个动作（重置 / 撤销 / 下一页），模式卡片已经删除
    assert 'el("margin-page-actions")' in script
    assert "function undoMarginEdit(" in script
    assert "confirmLayoutFromPanel" in script

    # 切步骤不动缩放：只有用户没手动改过缩放时，才在从别的视图进版心步时给整页档
    assert "let pageZoomTouched = false;" in script
    assert 'if (!pageZoomTouched && id === "margin"' in script
    assert "pageZoomTouched = true;" in script

    # 文字识别步只读：状态数字来自 finish-summary / summary，不在右栏做裁决
    assert "function renderRecognitionStatus(" in script
    assert "finishSummary.engine" in script or "finishSummary && finishSummary.engine" in script


def test_page_index_step_is_wired() -> None:
    """任务 37（C 刀）：第 4 步「目录确认」= 页码跳转索引，自动绿、零人工。

    静态约定：步骤条里有第 4 步、视图与索引列表的节点真实存在、
    跳转 / 翻页 / 缺页码标注的接线都在，没有"加了按钮忘了监听"。
    """
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")

    for element_id in (
        "view-index",
        "index-list",
        "index-meta",
        "index-empty",
        "index-jump-input",
        "index-jump-go",
        "index-jump-status",
        "index-page-no",
        "index-printed",
        "index-prev",
        "index-next",
        "index-zoom-label",
        "index-canvas",
        "index-pages",
    ):
        assert f'id="{element_id}"' in page, element_id

    # 六步：目录确认排在文字识别与正文审校之间
    assert '{ id: "index", label: "目录确认", short: "目录" }' in script
    assert 'PAGE_WORKFLOW_STEPS = ["pages", "recognition", "margin", "index"]' in script

    # 生成 / 跳转 / 翻页 / 高亮 / 缺页码
    assert "function openPageIndex(" in script
    assert "function jumpToPrintedPage(" in script
    assert "function stepIndexPage(" in script
    assert "function highlightIndexRow(" in script
    assert "INDEX_ZOOM_SCALES" in script
    assert "/page-index" in script
    # 完成判定读收尾面板的 index 字段，不在前端另算
    assert 'const ix = fs.index || {};' in script
    assert 'Boolean(ix.complete)' in script
    assert "未识别页码" in script
    # 版心步的"下一步"按这一页的真实状态说，不按步骤顺序说
    assert "版心已按本页正文行生成；拖动四边调整，不改也算已定" in script
    # 兜底与"没有行"各有自己的说法，不许混成一句"已拟合"
    assert "版心是本页正文行的包围盒（兜底）" in script
    assert "这一页还没有可用的正文行（识别行 / 检测行都没有），版心暂时生成不了" in script
    # 只有 PDF 页序时：说明条 + 跳转停用 + 步骤条不绿（complete 由后端给）
    assert "function indexIsPageOrderOnly(" in script
    assert "尚未识别：下面只有 PDF 页序" in script
    assert "function syncIndexJumpState(" in script
    assert "is-page-order" in script
    assert ".index-notice" in css

    assert ".index-row.is-current" in css
    assert ".index-split" in css


def test_result_preview_step_is_wired_to_export_assembly() -> None:
    """任务 38（D 刀）：结果预览 = 导出结果的实时副本，且没有完成态。

    静态约定：第 6 步在审校与导出之间、用同一份 /export/preview、段/跨页/排除
    三类信息都有落点；步骤样式是 plain（不绿不灰），完成判定里没有它。
    """
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")

    for element_id in (
        "view-preview",
        "preview-pages",
        "preview-page-no",
        "preview-page-printed",
        "preview-prev",
        "preview-next",
        "preview-meta",
        "preview-segs",
        "preview-scroll",
        "preview-only-span",
        "preview-note",
        # 任务 47（J 刀）：版心 / 块框 / 缩放与页面视图、目录确认共用同一份状态
        "preview-margin-toggle",
        "preview-overlay-toggle",
        "preview-zoom-out",
        "preview-zoom-in",
        "preview-zoom-label",
    ):
        assert f'id="{element_id}"' in page, element_id

    # L 刀：正文审校吸收结果预览，步骤 7 → 6（预览不再是一个步骤）
    assert '{ id: "review", label: "正文审校", short: "审校" }' in script
    assert '{ id: "preview", label: "结果预览"' not in script
    assert 'const WORKFLOW_STEPS = [' in script
    assert 'const VIEWS = ["library", "pages", "index", "review", "reading", "preview", "merge"];' in script
    # 连续正文流视图（阅读审校）存在
    assert 'id="view-reading"' in page
    assert "function openReading(" in script

    # 与导出共用同一份组装：只调 /export/preview，不另写合并逻辑
    assert "function openPreview(" in script
    assert "/export/preview" in script
    assert "exportOptions()" in script
    # 段边界 / 跨页段 / 排掉了什么
    assert "function buildPreviewSegment(" in script
    assert "跨页续" in script
    assert "版心外排除" in script
    assert "previewVisibleSegments" in script
    # 没有完成态：预览不在页面步里，也没有 is-done 判定
    assert 'PAGE_WORKFLOW_STEPS = ["pages", "recognition", "margin", "index"]' in script
    assert "结果预览不设完成态" in script


def test_result_preview_reuses_page_renderers_and_follows_segments() -> None:
    """任务 47（J 刀）：预览左边复用版心 / 块框渲染，段落与页面双向联动。

    静态约定：
    - 左边连续页条调用 `paintTileMargin` / `renderPageBlocks`（不另写一套画框）；
    - 开关与缩放沿用 `pagesMarginOn` / `pagesOverlayOn` / `pageZoomIndex`；
    - 段落 → 块用 `block_ids` + 后端块框 bbox，跨页段两页都标；
    - 右栏 1139 段不逐段挂监听（事件代理 + rAF 节流）。
    """
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")

    # 左边不是裸图：页块里带版心 / 块框 / 命中层
    assert 'class="preview-pages" id="preview-pages"' in page
    assert "preview-margin-toggle" in page and "preview-overlay-toggle" in page
    assert "preview-page__hits" in script

    # 复用同一套渲染函数与同一份开关 / 缩放状态
    assert "function paintPreviewTile(" in script
    assert "paintTileMargin(tile, page)" in script
    assert "renderPageBlocks(tile, blocks" in script
    assert "pagesMarginOn = true" in script and "pagesOverlayOn = true" in script
    assert "INDEX_ZOOM_SCALES" in script

    # 段 → 块：用现成的 block_ids + bbox，不猜字符位置
    assert "segment.block_ids" in script
    assert "function highlightPreviewSegment(" in script
    assert "function drawPreviewHits(" in script
    assert "function scrollPreviewLeftToSegment(" in script
    assert "function scrollPreviewLeftToPage(" in script

    # 双向联动：右栏滚动驱动左边、左栏滚动驱动右边，但不同时反推
    assert "function onPreviewScroll(" in script
    assert "function onPreviewLeftScroll(" in script
    assert "previewSyncDriver" in script and "markPreviewDriver" in script

    # 事件代理 + 一帧一次：不给 1139 段逐个挂监听
    assert 'el("preview-segs").addEventListener("pointerover", onPreviewSegHover)' in script
    assert 'el("preview-segs").addEventListener("click", onPreviewSegClick)' in script
    builder = script[script.index("function buildPreviewSegment("):script.index("// ---------------------------------------------------------------- 联动：段 ↔ 页")]
    assert "addEventListener" not in builder

    # 浅绿用青绿，不是审校那三色
    assert "--preview-hit-line" in css and "--preview-hit-bg" in css
    assert ".preview-seg.is-current" in css
    assert ".preview-page__hit" in css
    assert ".preview-junction" in css


def test_toolbar_filters_and_tools_are_placed_per_step() -> None:
    """任务 39（E 刀）：功能归位——三个按钮搬家，筛选条按步骤只留该步的。

    静态约定：结构工具在版心步的右栏（版心外分组），质量统计 / 任务包在工具条 ⋯；
    页面确认 / 版心确认 / 文字识别 三个步骤的筛选条由 CSS 按 body 步骤属性收敛。
    """
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")

    # ⋯ 菜单：诊断（质量统计）/ 协作（任务包）
    assert 'id="page-more"' in page
    assert 'id="page-more-menu"' in page
    menu_start = page.index('id="page-more-menu"')
    assert page.index('id="stats-open"') > menu_start
    assert page.index('id="assign-list-toggle"') > menu_start
    assert "function setupPageMore(" in script
    # 筛选条是 overflow-x:auto，菜单用 fixed 定位才不会被裁掉
    assert "page.style.top" in script or "menu.style.top" in script
    assert "position: fixed" in css and ".page-more {" in css

    # 结构工具搬到版心步右栏的「版心外」分组
    margin_start = page.index('id="panel-margin-settings"')
    assert page.index('id="structure-open"') > margin_start
    assert "margin-outside" in page and ".margin-outside" in css
    assert "版心外的书眉 / 页脚 / 页码" in page

    # 筛选条按步骤收敛（页面确认 / 版心确认 / 文字识别）
    assert 'id="page-filters"' in page
    for cls in ("fitem--type", "fitem--recognition", "fitem--workflow", "fitem--triage",
                "fitem--only-included", "fitem--range"):
        assert cls in page, cls
    assert 'body[data-workflow-step="margin"] #page-filters' in css
    assert 'body[data-workflow-step="pages"] .filterbar .fitem--recognition' in css
    assert 'body[data-workflow-step="recognition"] .filterbar .fitem--type' in css


def test_cleanup_actions_are_wired_into_the_finish_panel() -> None:
    """任务 41：收尾面板里的两件批量数据清理（F1 延续 / F2 家具块），都能撤销。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")

    for element_id in (
        "finish-cleanup",
        "cleanup-continuation-run",
        "cleanup-continuation-status",
        "cleanup-furniture-run",
        "cleanup-furniture-status",
        "cleanup-undo",
    ):
        assert f'id="{element_id}"' in page, element_id

    assert "function runContinuationCleanup(" in script
    assert "function runFurnitureCleanup(" in script
    assert "function undoLastCleanup(" in script
    assert "/cleanup/continuations" in script
    assert "/cleanup/furniture" in script
    # 先给计划、确认后才写；撤销走同一个撤销栈
    assert "window.confirm(" in script
    assert "/undo" in script
    assert "整批可撤销" in script or "可撤销" in script


def test_continuation_review_entry_and_panel_are_wired() -> None:
    """任务 42 / 43（G 刀）：第三桶有入口；面板左右分栏、键盘优先、判完自动跳。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    styles = (STATIC_DIR / "app.css").read_text(encoding="utf-8")

    for element_id in (
        "review-continuations",
        "cleanup-continuation-review-open",
        "cleanup-continuation-review-status",
        "continuation-panel",
        "continuation-viewer",
        "continuation-scroll",
        "continuation-pages",
        "continuation-progress",
        "continuation-state",
        "continuation-evidence",
        "continuation-continue",
        "continuation-end",
        "continuation-revert",
        "continuation-prev",
        "continuation-next",
        "continuation-zoom-in",
        "continuation-zoom-fit",
        "continuation-zoom-out",
        "continuation-complete",
        "continuation-error",
        "continuation-close",
        "continuation-done",
    ):
        assert f'id="{element_id}"' in page, element_id

    # 两个方向 + 撤销 + 自动跳下一条
    assert "function openContinuationReview(" in script
    assert "function renderContinuationPanel(" in script
    assert "function markContinuation(" in script
    assert "function revertContinuation(" in script
    assert "function advanceContinuation(" in script
    assert "function centerContinuationJunction(" in script
    assert "function onContinuationKeydown(" in script
    assert "/cleanup/continuations/pending" in script
    assert "/cleanup/continuations/resolve" in script
    assert "/cleanup/continuations/reopen" in script
    # 任务 48（K1）：按钮文案按用户原话缩短，面板只留两行原文
    assert "合成一段<kbd>1</kbd>" in page
    assert "分成两段<kbd>2</kbd>" in page
    assert "走满程度" not in script
    assert "首行缩进" not in script
    # 连按不丢：写库期间的按键进队列
    assert "pendingDecisions" in script
    # 键盘：1 / 2 / Z / ↑ / ↓
    for key in ('key === "1"', 'key === "2"', 'key === "z" || key === "Z"', 'key === "ArrowDown"', 'key === "ArrowUp"'):
        assert key in script, key
    # 交界两行的坐标（后端给 last_bbox / next_bbox）
    assert "last_bbox" in script and "next_bbox" in script
    assert "continuation-line" in script
    assert "第 ${entry.page_no} 页 / 第 ${entry.next_page_no} 页" in script

    # 审校完成判定仍读后端 complete（已含第三桶）
    assert "Boolean(r.complete)" in script
    assert "continuation_pending" in script

    # 左栏滚动、右栏按钮固定不滚
    assert ".continuation-scroll" in styles
    assert ".continuation-side" in styles
    assert ".continuation-line" in styles
    assert "overflow: auto" in styles


def test_confirm_page_refreshes_finish_counts() -> None:
    """任务 42 走查：确认一页之后，收尾面板 / 步骤条的计数必须跟着动。

    394 页的循环里最显眼的反馈就是这些计数；确认完不刷新，用户会以为没生效。
    刷新是后台的（不 await），翻页不等 1–2 秒的聚合。
    """
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    start = script.index("async function confirmCurrentPage(")
    block = script[start : script.index("\n}\n", start)]
    assert "loadFinishSummary({ silent: true })" in block
    assert "await loadFinishSummary" not in block, "刷新不能挡住翻页"


def test_review_pauses_page_grid_prefetch() -> None:
    """任务 43：审校按键不能被页面视图的缩略图 / 角标预取拖慢。

    页面视图一次会排上百个 `size=thumb` 与 `block-suggestions`；切到审校后
    还在后台跑的话，一次按键要等几秒（实测第 370 页 13 键 40.5 秒）。
    离开页面视图要停掉：缩略图清 src、建议与块数据预取看 currentView。
    回到页面视图必须能把缩略图重新挂上（否则用户看到一片空白）。
    """
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")

    assert "function pausePageThumbnails(" in script
    pause = script[script.index("function pausePageThumbnails(") :]
    pause = pause[: pause.index("\n}\n")]
    assert 'removeAttribute("src")' in pause

    assert 'if (target !== "pages" && currentProject) pausePageThumbnails();' in script
    # 回来时由 applyPageZoom 重新挂 src（页面视图分支里调用）
    assert "applyPageZoom();" in script

    for name in ("function pumpPageSuggestionQueue(", "function pumpPageBlockPrefetch("):
        start = script.index(name)
        block = script[start : script.index("\n}\n", start)]
        assert 'currentView !== "pages"' in block, name

    # 批量确认版面后，已经打开的审校页页头要跟着刷新
    start = script.index("async function finishRunLayout(")
    block = script[start : script.index("\n}\n", start)]
    assert "loadPageDetail(detailPageNo" in block

    # 页面打开不等建议 / 漏行：先渲染，队列处理完再补算（否则按键和全库统计抢 CPU）
    start = script.index("async function loadPageDetail(")
    block = script[start : script.index("\n}\n", start)]
    assert "queueHasPendingItems()" in block
    assert "pendingPageAux = pageNo" in block
    assert "function queueHasPendingItems(" in script
    assert "function runPageAux(" in script
    start = script.index("function renderDiffQueue(")
    block = script[start : script.index("\n}\n", start)]
    assert "pendingPageAux === queuePageNo" in block


def test_review_workspace_v2_is_wired() -> None:
    """任务 45（H 刀）：左树、三色整行差异、逐字文本面板、三档三栏、默认关版心/块框。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")

    for element_id in (
        "review-split",
        "review-tree",
        "review-tree-list",
        "review-tree-scroll",
        "review-tree-filter",
        "review-tree-stats",
        "review-tree-rail",
        "review-drawer-toggle",
        "toggle-diff-marks",
        "toggle-overlay",
        "review-margin-toggle",
        "detail-diff-layer",
    ):
        assert f'id="{element_id}"' in page, element_id

    # 树：每页计数、条目懒加载、当前页展开、只看未完成、裁决后只改计数
    assert "function ensureReviewTree(" in script
    assert "/review/tree" in script
    assert "function renderReviewTree(" in script
    assert "function updateReviewTreeAfterAck(" in script
    assert "function setReviewTreeOnlyTodo(" in script
    assert "function syncReviewTreeToPage(" in script
    assert "function openTreeItem(" in script
    assert "function stepReviewDiff(" in script
    assert 'event.key === "["' in script

    # 页面上是整行色块（用 block_line.bbox），不是字符盒；逐字对比在右栏
    assert "blockCountedInMargin(block, pageRecord)" in script
    assert "bbox[1] * rect.height" in script
    assert "markPixelRange(" not in script  # 旧的字符级估算已删
    assert "function diffCompareLines(" in script
    assert "diff-char" in script
    assert "diff-mark--done" in script
    assert "diff-mark__end" in script
    assert 'diffMarksMode = "all"' in script

    # 进审校默认关版心 / 块框
    assert "setReviewOverlay(false)" in script
    assert "setReviewMargin(false)" in script
    toggle_overlay = page.split('id="toggle-overlay"')[1][:120]
    assert "is-on" not in toggle_overlay
    assert 'id="detail-overlay" hidden' in page

    # 三色变量 + 三栏断点 + 628 预算
    for token in (
        "--diff-todo-bg",
        "--diff-done-bg",
        "--diff-cur-bg",
        ".review-tree",
        ".diff-mark--done",
        ".diff-mark__end",
        "@media (max-width: 1319px)",
        "@media (max-width: 1119px)",
        "@media (max-height: 700px)",
    ):
        assert token in css, token


def test_index_view_reuses_page_rendering() -> None:
    """任务 46（I 刀）：目录确认右侧和页面视图同一套渲染，不是裸图。

    - 版心 + 块框（同一套 paintTileMargin / renderPageBlocks）；
    - 两个开关与页面视图共用 pagesMarginOn / pagesOverlayOn；
    - 缩放共用 pageZoomIndex；
    - 选中页首行加淡蓝框；
    - 块数据按当前页懒加载。
    """
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")

    for element_id in (
        "index-pages",
        "index-canvas",
        "index-margin-toggle",
        "index-overlay-toggle",
    ):
        assert f'id="{element_id}"' in page, element_id

    assert "function paintIndexDecorations(" in script
    assert "paintTileMargin(tile, page)" in script
    assert "renderPageBlocks(tile, blocks" in script
    assert "function loadIndexBlocks(" in script
    assert "function drawIndexFirstLine(" in script
    assert "function toggleIndexOverlay(" in script
    assert "function toggleIndexMargin(" in script
    assert "syncIndexToggles()" in script
    assert "pageZoomTouched = true;" in script
    # 默认开：进入目录确认时打开版心与块框
    assert "pagesMarginOn = true;" in script
    assert "pagesOverlayOn = true;" in script
    # 版心 / 块框两栏同一个状态变量
    assert "pagesMarginOn" in script and "pagesOverlayOn" in script
    assert ".index-page" in css and ".index-firstline" in css


def test_page_index_scrolls_continuously_with_lazy_pages() -> None:
    """任务 48（K1）：目录确认右边改成连续多页，按需加载、右边滚左边跟着亮。

    - 页列容器 `#index-pages` + 页块（不是单页 #index-page）；
    - 图 / 块只给视口附近 ±3 页：IntersectionObserver + 上限；
    - 右边滚 → 当前页变化 → 列表高亮并滚进可视区（反向同步）；
    - 缩放作用在整个页列上。
    """
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")

    assert 'id="index-pages"' in page
    assert "function buildIndexPages(" in script
    assert "IntersectionObserver" in script
    assert "rootMargin" in script and "INDEX_NEAR_MARGIN" in script
    # 只给附近页挂图 / 块，滚出去清掉，图有上限
    assert "function loadIndexTile(" in script
    assert "function clearIndexTile(" in script
    assert "function trimIndexImages(" in script
    assert "INDEX_IMAGE_LIMIT" in script
    assert "function ensureIndexImage(" in script
    assert "function ensureIndexBlocks(" in script
    # 页列里的每一页都调用同一套渲染
    assert "function paintIndexTile(" in script
    # 只有视口里的页画装饰：near 只取数据、visible 才画
    assert "function observeIndexTiles(" in script
    assert "indexVisibleObserver" in script
    assert "function clearIndexDecorations(" in script
    # 页图按距离排队、一次解一张，并有同时挂载上限
    assert "function pumpIndexImages(" in script
    assert "indexImageQueue" in script
    assert "image.decode()" in script
    # 右边滚 → 左边同步（当前行居中）
    assert 'el("index-canvas").addEventListener("scroll", onIndexScroll' in script
    assert "function updateIndexActiveFromScroll(" in script
    assert "function ensureIndexRowVisible(" in script
    assert "highlightIndexRow(true)" in script
    # 点列表 = 滚过去，不是换一页
    assert "function scrollIndexToPage(" in script
    assert "openIndexPage(Number(row.dataset.pageNo)" in script
    # 缩放作用在整个页列上
    assert "for (const tile of indexTiles.values()) tile.style.width" in script
    assert ".index-pages" in css and ".index-page" in css


def test_orthography_cleanup_is_wired() -> None:
    """任务 49（M 刀）：括号 / 引号规范化的入口与「引号不配平」清单。

    静态约定：收尾面板有「字符规范化」行（先只读分析、确认后整批写库），
    另有独立的「引号不配平」清单，不混进普通差异队列。
    """
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")

    for element_id in (
        "cleanup-orthography-run",
        "cleanup-orthography-review",
        "cleanup-orthography-status",
        "orthography-panel",
        "orthography-list",
        "orthography-meta",
        "orthography-close",
        "orthography-done",
    ):
        assert f'id="{element_id}"' in page, element_id

    assert "function runOrthographyCleanup(" in script
    assert "function openOrthographyPanel(" in script
    assert "/cleanup/orthography" in script
    assert "/cleanup/orthography/unbalanced" in script
    # 行文本 + 第二引擎 + diff 重算（先分析、确认后写库，另写回滚文件）
    assert "function runLinesCleanup(" in script
    assert "/cleanup/orthography/lines" in script
    assert "回滚文件" in page or "回滚文件" in script
    assert "cleanup-lines-run" in page and "cleanup-lines-status" in page
    # 自动修引号可能改错的孤儿：清单里优先看
    assert "orthography-row__suspect" in page or "orthography-row__suspect" in script
    assert "自动修可能改错" in script
    # 先分析再写库：确认框里写清楚改多少块 / 字，且可撤销
    assert "window.confirm(" in script
    assert "整批可撤销" in script
    # 不硬配：清单只提示、跳到审校页
    assert "不整本硬配" in page
    assert "看原文" in script
    assert ".orthography-row" in css and ".modal--orthography" in css


def test_reading_view_is_wired_for_merge() -> None:
    """L 刀：正文审校＝连续正文流（步骤 6），草稿先落 localStorage、提交才写库。"""
    page = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    script = (STATIC_DIR / "app.js").read_text(encoding="utf-8")
    css = (STATIC_DIR / "app.css").read_text(encoding="utf-8")

    for element_id in (
        "view-reading",
        "reading-stream",
        "reading-tree",
        "reading-next-unreviewed",
        "reading-progress-text",
        "reading-progress-fill",
        "reading-draft-chip",
        "reading-filter",
        "reading-submit",
        "reading-undo",
        "reading-image",
        "reading-follow",
        "reading-proof",
        "reading-blindspot",
        "reading-pdf-box",
    ):
        assert f'id="{element_id}"' in page, element_id

    assert "function openReading(" in script
    assert "function buildReadingSegment(" in script
    assert "function gotoNextUnreviewed(" in script
    assert "function submitReadingDrafts(" in script
    assert "b2t.readingDrafts." in script
    assert "/review/marks" in script
    assert "/review/submit-drafts" in script
    assert "line_spans" in script
    assert "computeCharSpans(" in script
    # 三处队列口径统一：树 / 顶栏 / finish-summary 都读同一个统计
    assert "queue_items(" in (STATIC_DIR / ".." / ".." / ".." / "backend" / "book2text" / "core" / "project" / "review_status.py").read_text(encoding="utf-8")
    # L3：跟随 / 成稿 / 定向补审入口
    assert "function setReadingFollow(" in script
    assert "function toggleReadingProof(" in script
    assert "is-proof" in css
    assert "reading-proof__pages" in css
    assert "下一处未审" in page
    assert "window.confirm(" in script
    assert ".reading-mark" in css and ".reading-panel" in css
    assert ".reading-line.is-draft" in css
