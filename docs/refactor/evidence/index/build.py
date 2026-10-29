"""生成 index-view.js + 改写后的 app.js（任务 94 · Slice I1）。

默认**只写 /tmp**，加 `--write` 才落到仓库。所有边界都带断言：行不对就停，不静默。

用法：
  python3 docs/refactor/evidence/index/build.py            # 产出到 /tmp/b2t-index/
  python3 docs/refactor/evidence/index/build.py --write    # 写入 backend/book2text/static/
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rules  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
STATIC = os.path.join(ROOT, "backend", "book2text", "static")
OUT = "/tmp/b2t-index"

# ---- 段边界（app.js 1-based，含两端）----------------------------------------
SEG_A, SEG_B = 8179, 9343
# 原段落头注释（8179–8193）整段丢弃：模块有自己的文件头，重复留着就是讲两遍故事。
DROP = [(8179, 8193)]
# 留在 app.js 的：页码索引缓存 / 共享常量 / 三个纯数据服务 / 图片清晰度簇
STAY = [
    (8194, 8196),   # pageIndexData / pageIndexProject / pageIndexLoading
    (8199, 8199),   # INDEX_ZOOM_SCALES
    (8204, 8205),   # INDEX_IMAGE_WINDOW
    (8231, 8252),   # loadPageIndex
    (8805, 8814),   # clearImagePlaceholder
    (9085, 9117),   # loadImageQuality / setImageQuality / syncImageQualityUi
    (9180, 9194),   # loadIndexBlocks
]

HEADER = '''/**
 * 目录确认视图模块（任务 94 · Slice I1：整段迁入）
 *
 * **经典脚本，不是 ES module**：`<script src="/static/index-view.js">` 在 app.js 之前加载，
 * 靠 `window.IndexView` 对外暴露（R6：一个文件只露一个接口对象）。`type="module"` 默认
 * deferred，会改 boot 时序——这个仓库一半 bug 是时序问题，拆的时候不动它。
 *
 * 用户要的是"394 页扫描件一眼看过去，能确认页码排得对不对"。所以这一屏是**连续页列**：
 * 页块只是固定宽高比的占位空壳（滚动高度靠它），图和块数据只给视口附近加载，
 * 滚出去的页立刻清掉版心 / 块框 / 首行框，离得远的页再把 img 的 src 摘掉。
 * 版心 / 块框 / 首行框与页面视图、预览共用同一套画法（`paintTileMargin` / `renderPageBlocks`），
 * 缩放四档也共用 `pageZoomIndex`——**一份状态，三个视图**，不许各写一套。
 *
 * **Slice I1（2026-10-29）**：41 个函数 + 23 个状态整段从 app.js 迁入，函数体**逐字节未改**，
 * 只把 app.js 的 25 个顶层符号 + 2 个页面视图 DOM 句柄换成 `injected.xxx`：
 *   状态 getter 6（project / detailPageNo / pageZoomIndex / pagesMarginOn / pagesOverlayOn / imageQualityMode）
 *   状态 setter 5（pageZoomIndex / pageZoomTouched / pagesMarginOn / pagesOverlayOn / imageQuality）
 *   isActive 1、共享常量 3、页面渲染服务 4、块缓存服务 4、页面开关服务 4、
 *   普通服务 6（apiJson / goToWorkflowStep / loadPageIndex / loadIndexBlocks /
 *   clearImagePlaceholder / setImageQuality）、跨子树句柄 2。
 * `el` 不进 deps（模块自带一行，§20.4）。
 *
 * **留在 app.js 的一小撮**（它们不是"目录视图的实现"，是别人的依赖）：
 * - 页码索引缓存 `pageIndexData / pageIndexProject`——预览也在读；
 * - `loadPageIndex` / `loadIndexBlocks` / `clearImagePlaceholder`——三个纯数据服务，
 *   阅读左栏与预览都在调；前两者**不碰任何 DOM**（I1 把 DOM 写点搬进了本模块）；
 * - `imageQualityMode` + localStorage + 设置面板 radio——页面视图 / 审校 / 预览都读这个档位。
 *
 * **接口 3 个**：`init(deps) / enter() / refresh()`（§20.6 签字 4 个，2026-10-29 实测后删 `exit` 降到 3）。
 * `refresh` 是 §20.1 允许的**业务方法**，5 个真实调用点
 * （页面视图切版心 ×2、切块框叠加层 ×2、boot 里清晰度档位初始化后 ×1）——原代码在前 4 处
 * 由外壳 `if (currentView === "index")` 替模块判断"我现在在不在"，`refresh` 把
 * 这个守卫搬回模块自己（§20「模块不许读 currentView」）。
 * **没有参数包**：守卫留在 `paintIndexDecorations()` 自己身上（它本来就有），
 * 写一次就够（§20.6 明确否决 `refresh({toggles:false})` 这类配置项化入口）。
 * **语义写死**（Chief 条件 ①）：`refresh()` 只重画装饰与开关态，不做数据加载、不做全量重建；
 * 换清晰度档要取图，所以走模块内的 `applyImageQuality()`，不走 `refresh()`。
 * `getCurrent` 按需——没有调用方，不加。
 *
 * **本模块不提供 `exit()`（2026-10-29 裁决，别补回来）**：`enter()` 幂等——监听只绑新元素、
 * 观察器非空即复用（本模块实测 3 轮 `showView` 来回切，新增 IO 0 次）。三个模块当初都导出了 `exit`，
 * 而 `showView` 从不调用它，是**永不执行的导出**（`.exit(` 全仓库 0 命中）。
 * 实测（真浏览器，按「元素 × 事件类型」数活着的处理函数）：重复 `enter()` 不重复绑、不重建观察器。
 * **将来若要断观察器**（已知缺口：切走视图后隐藏元素仍会回调，见 `docs/known-limitations.md` L-108），
 * 那时再引入 `exit()`，并附等价性证据与真实调用点。
 */
(function () {
  "use strict";

  /** 注入面：boot() 一次传齐；缺键时保持搬走前的语义（读不到就 no-op / 空值）。 */
  let injected = {};

  const el = (id) => document.getElementById(id);

'''


def cut(lines, a, b):
    """1-based inclusive -> list of lines."""
    return lines[a - 1:b]


def main():
    app_path = os.path.join(STATIC, "app.js")
    sha = os.environ.get("B2T_BASELINE", "55a7616")  # Slice I1 之前最后一版
    raw = subprocess.check_output(
        ["git", "-C", ROOT, "show", "%s:backend/book2text/static/app.js" % sha]
    ).decode("utf-8").split("\n")
    print("原像：B2T_BASELINE=%s" % sha)

    # ---- 边界断言：行不对就停 -------------------------------------------
    assert raw[8178].startswith("// ---------------------------------------------------------------- 目录确认"), raw[8178]
    assert raw[8193] == "let pageIndexData = null;", raw[8193]
    assert raw[8230].startswith("async function loadPageIndex()"), raw[8230]
    assert raw[8251] == "}", raw[8251]
    assert raw[9084].startswith("function loadImageQuality()"), raw[9084]
    assert raw[9116] == "}", raw[9116]
    assert raw[9179].startswith("/**"), raw[9179]
    assert raw[9180].startswith("async function loadIndexBlocks"), raw[9180]
    assert raw[9193] == "}", raw[9193]
    assert raw[9342] == "}", raw[9342]

    seg = cut(raw, SEG_A, SEG_B)
    stay_idx = set()
    for a, b in STAY:
        for k in range(a, b + 1):
            stay_idx.add(k - SEG_A)
    drop_idx = set()
    for a, b in DROP:
        for k in range(a, b + 1):
            drop_idx.add(k - SEG_A)
    body_lines = [ln for i, ln in enumerate(seg) if i not in stay_idx and i not in drop_idx]
    body = "\n".join(body_lines)

    # ---- 留在 app.js 的那一小撮 -----------------------------------------
    stay_text = "\n".join(
        ln for i, ln in enumerate(seg) if i in stay_idx
    )
    stay_text = rewrite_stay(stay_text)

    # ---- 变换 + 自检 -----------------------------------------------------
    moved = rules.forward(body)
    moved = rewrite_moved(moved)
    problems = residue(moved)
    if problems:
        print("!! 变换后仍有未映射的接缝标识符：")
        for p in problems:
            print("   ", p)
        return 1

    module = HEADER + moved.rstrip("\n") + "\n\n" + INTERFACE
    # 只从**代码区**抽键（文件头注释里写作 `injected.xxx`，不能算注入键）
    keys = sorted(set(re.findall(r"injected\.([A-Za-z_$][\w$]*)", rules.strip_code(module))))
    missing = set(keys) - rules.EXPECTED_KEYS   # 用了但没登记
    unused = rules.EXPECTED_KEYS - set(keys)    # 登记了但没用

    # ---- app.js ----------------------------------------------------------
    section_head = '''// ---------------------------------------------------------------- 目录确认（页码跳转索引，任务 37 / 任务 48 / 任务 94 · Slice I1）
//
// 目录视图的 41 个函数 + 23 个状态已整段搬进 `index-view.js`（任务 94 · Slice I1）。
// 这里只剩**别人也在用的那一小撮**：页码索引缓存（预览在读）+ 三个纯数据服务
// （`loadPageIndex` / `loadIndexBlocks` / `clearImagePlaceholder`，都不碰 DOM）
// + 图片清晰度档位（页面视图 / 审校 / 预览都读 `imageQualityMode`）。
// 接缝：showView → `IndexView.enter()`；`IndexView.refresh()` 5 处（页面视图切版心 / 块框 ×4、
// boot 档位初始化后 ×1，另有预览 deps 里的一个 lambda 由外壳顺带调）；boot → `IndexView.init(deps)`。
// `refresh()` **不收参数**（§20.6）、**不做数据加载**（Chief 条件 ①）；换清晰度档走模块内
// `applyImageQuality()`（要取图），两个入口都在本模块里。
// 设计说明与函数实现见该文件头部。

'''
    new_app = raw[:SEG_A - 1] + section_head.split("\n")[:-1] + stay_text.split("\n") + raw[SEG_B:]
    # 丢弃的段落头（DROP）不进新 app.js；上面 section_head 就是它的替身
    new_app = patch_app(new_app)

    os.makedirs(OUT, exist_ok=True)
    open(os.path.join(OUT, "index-view.js"), "w", encoding="utf-8").write(module)
    open(os.path.join(OUT, "app.js"), "w", encoding="utf-8").write("\n".join(new_app))

    print("module  : %d 行 / injected 键 %d" % (module.count("\n") + 1, len(keys)))
    print("app.js  : %d 行 -> %d 行 (净减 %d)" % (len(raw), len(new_app), len(raw) - len(new_app)))
    print("moved   : %d 行 -> 变换后 %d 行" % (len(body_lines), moved.count("\n") + 1))
    if missing:
        print("!! 注入面缺键（脚本用了但没登记进 EXPECTED_KEYS）：", sorted(missing))
    if unused:
        print("!! 注入面多键（登记了但脚本没用）：", sorted(unused))
    print("injected keys:", ", ".join(keys))

    if "--write" in sys.argv:
        open(os.path.join(STATIC, "index-view.js"), "w", encoding="utf-8").write(module)
        open(app_path, "w", encoding="utf-8").write("\n".join(new_app))
        print("written to", STATIC)
    else:
        print("dry-run ->", OUT)
    return 0 if not (missing or unused) else 1


INTERFACE = '''  // ---------------------------------------------------------------- 对外接口

  /** 清晰度按钮的文字（原 `syncImageQualityUi` 里写 `#index-quality` 的那两行）。**纯文字**。 */
  function syncImageQualityButton() {
    const label = IMAGE_QUALITY_LABELS[injected.getImageQualityMode()] || "自动";
    const button = el("index-quality");
    if (button) button.textContent = `清晰度：${label}`;
  }

  /**
   * 用户改了清晰度档（原 `setImageQuality` 的前半段在 app.js，后半段在这里）。
   *
   * **这条路径不归 `refresh()`**：Chief 把 `refresh()` 的语义写死成"只重画装饰与开关态，
   * 不做数据加载"，而换档要作废已取页图并按新档重取（那是取图）。所以它挂在"用户改了档"
   * 这两个入口上（`#index-quality` 按钮 / 设置面板 radio），两者都在本模块里。
   * 也没有 `refresh({ quality: true })` 那种参数包（§20.6 已否决）。
   */
  function applyImageQuality(mode) {
    injected.setImageQuality(mode);
    syncImageQualityButton();
    // **只在本视图可见时**探查档位：`pageProfileFor` 要量瓷砖的 CSS 宽，隐藏时量到的是估算值
    // （`measureCssWidth` 的最后一条兜底），会算出一个假档位、白作废一遍图。
    // 隐藏期间改了档也没关系：进视图时 `openPageIndex → applyIndexZoom → refreshIndexImageProfiles`
    // 会按当时的真档位重算并作废。
    if (injected.isActive()) refreshIndexImageProfiles();
  }

  /** boot() 调一次：注入依赖 + 绑 #view-index 的事件（原 `setupPageIndex()` 原样搬入）。 */
  const init = (deps) => {
    injected = { ...injected, ...(deps || {}) };
    setupPageIndex();
  };

  /** 进入目录确认（原 `openPageIndex()`；有缓存用缓存，没有就生成一次）。 */
  const enter = () => openPageIndex();

  /**
   * **语义写死（Chief 批准 A 时的条件 ①）**：
   *   **只重画装饰与开关态。不做数据加载、不做全量重建、不读 `currentView`。**
   * 具体就三件，多一件都算超出契约：
   * - `syncIndexToggles()`：两个开关按钮按 `pagesMarginOn / pagesOverlayOn` 重摆 `is-on`
   *   （无条件，对应原 `togglePageBlocksOverlay` / `toggleMarginView` 里的显式调用）；
   * - `syncImageQualityButton()`：清晰度按钮的**文字**（纯文字，不取图）；
   * - `paintIndexDecorations()`：**自己守 active**（它开头就是
   *   `if (!project || !isActive() || !indexTiles.size) return;`），所以这里不写
   *   `active ? … : …` 的 ternary——守卫写一次就够，写两处迟早对不上。
   * **换清晰度档会取图，所以它不在 `refresh()` 里**，在 `applyImageQuality()`（见上）。
   */
  const refresh = () => {
    syncIndexToggles();
    syncImageQualityButton();
    paintIndexDecorations();
  };

  // 任务 94（2026-10-29 裁决）：**不导出 `exit`**。原来这里有一个"撤掉两帧 rAF"的 `exit`，
  // 但 `showView` 从不调用它（`.exit(` 全仓库 0 个调用点）——永不执行的导出会让棘轮松一格。
  // 实测重复 `enter()` 不重复绑监听、观察器 0 次重建（`observeIndexTiles` 认 `indexObserver` 非空就复用），
  // 所以今天不需要"离开时清理"这个口子。将来真要断观察器，再立一个有真实调用点的导出（§20.1）。
  window.IndexView = {
    init,
    enter,
    refresh,
  };
})();
'''


def rewrite_moved(text):
    """搬进去的代码里有两处要跟着搬动重新落位（不是语义改动，是 DOM 写点换位）。"""
    old = '''  syncIndexToggles();
  if (!injected.getPageIndexData() || injected.getPageIndexProject() !== injected.getProject().project_id) {
    await injected.loadPageIndex();
  } else {
    renderPageIndex();
  }'''
    new = '''  syncIndexToggles();
  if (!injected.getPageIndexData() || injected.getPageIndexProject() !== injected.getProject().project_id) {
    // 加载期间的"正在生成 / 清空列表 / 藏起空态"原本长在 app.js 的 `loadPageIndex` 里，
    // 那是三个 DOM 写点（R3：目录子树的 id 归本模块），随 Slice I1 搬到这里。
    // **时点不变**：仍在 await 之前，且加载没在跑的时候才写（原来 busy 早退时一个字都不写）。
    if (!injected.getPageIndexLoading()) {
      el("index-meta").textContent = "正在生成页码索引…";
      el("index-list").innerHTML = "";
      el("index-empty").hidden = true;
    }
    const result = await injected.loadPageIndex();
    if (result.status === "ok") renderPageIndex();
    else if (result.status === "error") {
      el("index-meta").textContent = `页码索引读取失败：${result.message}`;
    }
  } else {
    renderPageIndex();
  }'''
    assert old in text, "openPageIndex 的加载分支不匹配"
    text = text.replace(old, new)

    # 两处档位入口（清晰度按钮 / 设置面板 radio）改走 applyImageQuality。
    # 理由：Chief 把 refresh() 的语义写死成"只重画装饰与开关态，**不做数据加载**"，
    # 而档位变化要作废页图并重取（那是取图）。所以它归"用户改了档"这条路径，
    # 不归 refresh()。两处入口本来就在本模块里（按钮在目录子树上，radio 的监听也随 setupPageIndex 搬进来了）。
    old = "    injected.setImageQuality(order[(order.indexOf(injected.getImageQualityMode()) + 1) % order.length]);"
    assert text.count(old) == 1, "清晰度按钮入口不匹配"
    text = text.replace(old, "    applyImageQuality(order[(order.indexOf(injected.getImageQualityMode()) + 1) % order.length]);")

    old = "      if (radio.checked) injected.setImageQuality(radio.value);"
    assert text.count(old) == 1, "设置面板 radio 入口不匹配"
    text = text.replace(old, "      if (radio.checked) applyImageQuality(radio.value);")
    assert "injected.setImageQuality(" not in text, "还有没改到的档位入口"
    return text


def residue(text):
    """变换后：还有没有 app.js 顶层符号裸着？"""
    code = rules.strip_code(text)
    declared = set()
    for m in re.finditer(r'(?m)^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)', code):
        declared.add(m.group(1))
    for m in re.finditer(r'(?m)^\s*(?:let|const|var)\s+([A-Za-z_$][\w$]*)', code):
        declared.add(m.group(1))
    for m in re.finditer(r'function\s*[\w$]*\s*\(([^)]*)\)', code):
        for p in m.group(1).split(","):
            p = p.strip().split("=")[0].strip()
            if re.fullmatch(r'[A-Za-z_$][\w$]*', p or ""):
                declared.add(p)
    for m in re.finditer(r'\b(?:let|const|var)\s+([A-Za-z_$][\w$]*)', code):
        declared.add(m.group(1))
    bad = []
    for name in rules.STAY_DECLS:
        for m in re.finditer(r'(?<![\w$.])' + re.escape(name) + r'\b', code):
            if name in declared:
                continue
            bad.append("%s @ %d" % (name, m.start()))
            break
    return bad


def rewrite_stay(text):
    """留在 app.js 的三个函数要改写：DOM 写点搬进模块、返回值带上失败原因。"""
    # 1) loadPageIndex：不碰 DOM、不渲染；返回 { status }，让调用方决定怎么显示。
    old = '''async function loadPageIndex() {
  if (!currentProject || pageIndexLoading) return;
  pageIndexLoading = true;
  pageIndexData = null;
  pageIndexProject = null;
  el("index-meta").textContent = "正在生成页码索引…";
  el("index-list").innerHTML = "";
  el("index-empty").hidden = true;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/page-index`
    );
    pageIndexData = data;
    pageIndexProject = currentProject.project_id;
  } catch (error) {
    el("index-meta").textContent = `页码索引读取失败：${error.message || "未知错误"}`;
    return;
  } finally {
    pageIndexLoading = false;
  }
  renderPageIndex();
}'''
    new = '''async function loadPageIndex() {
  if (!currentProject || pageIndexLoading) return { status: "busy" };
  pageIndexLoading = true;
  pageIndexData = null;
  pageIndexProject = null;
  try {
    const data = await apiJson(
      `/api/projects/${currentProject.project_id}/page-index`
    );
    pageIndexData = data;
    pageIndexProject = currentProject.project_id;
    return { status: "ok" };
  } catch (error) {
    return { status: "error", message: error.message || "未知错误" };
  } finally {
    pageIndexLoading = false;
  }
}'''
    assert old in text, "loadPageIndex 原像不匹配"
    text = text.replace(old, new)

    # 2) setImageQuality：页图缓存归目录视图模块，这里只把"档位变了"告诉它。
    old = '''function setImageQuality(mode) {
  if (!["auto", "standard", "high"].includes(mode)) return;
  imageQualityMode = mode;
  localStorage.setItem("b2t.imageQuality", mode);
  syncImageQualityUi();
  // 档位变了：把已经取过的页图作废，按新档重取（标准 → 高清时才会真的重取）
  indexImageProfile = "";
  indexLoadedImages.clear();
  for (const tile of indexTiles.values()) {
    const image = tile.querySelector("img");
    if (!image) continue;
    delete image.dataset.src;
    delete image.dataset.pending;
    image.removeAttribute("src");
  }
  for (const visible of indexVisiblePages) ensureIndexImage(visible);
  if (indexCurrentPage) ensureIndexImage(indexCurrentPage);
  // 其它视图（页面视图 / 审校左栏）下次取图时会读到新的档位
}'''
    new = '''function setImageQuality(mode) {
  if (!["auto", "standard", "high"].includes(mode)) return;
  imageQualityMode = mode;
  localStorage.setItem("b2t.imageQuality", mode);
  syncImageQualityUi();
  // 档位变了：把已经取过的页图作废，按新档重取（标准 → 高清时才会真的重取）。
  // 页图缓存与两个档位入口（`#index-quality` 按钮 / 设置面板 radio）都归目录视图模块，
  // 由它的 `applyImageQuality()` 负责"作废已取页图并按新档重取"。这里只是状态与设置面板。
  // 其它视图（页面视图 / 审校左栏）下次取图时会读到新的档位。
}'''
    assert old in text, "setImageQuality 原像不匹配"
    text = text.replace(old, new)

    # 3) syncImageQualityUi：按钮文字归模块，这里只管设置面板的三档 radio。
    old = '''function syncImageQualityUi() {
  const label = IMAGE_QUALITY_LABELS[imageQualityMode] || "自动";
  const button = el("index-quality");
  if (button) button.textContent = `清晰度：${label}`;
  for (const radio of document.querySelectorAll('input[name="reading-quality"]')) {
    radio.checked = radio.value === imageQualityMode;
  }
}'''
    new = '''function syncImageQualityUi() {
  // `#index-quality` 按钮的文字归目录视图模块（它自己在 refresh() 里同步，R3 不越界）；
  // 这里只管设置面板里的三档 radio——那是外壳的 DOM。
  for (const radio of document.querySelectorAll('input[name="reading-quality"]')) {
    radio.checked = radio.value === imageQualityMode;
  }
}'''
    assert old in text, "syncImageQualityUi 原像不匹配"
    text = text.replace(old, new)
    return text


def patch_app(lines):
    text = "\n".join(lines)

    # showView：进目录确认走模块入口
    old = '''  if (target === "index" && currentProject) {
    queueAfterSteps(() => hydrateView("index"));
    openPageIndex();
  }'''
    new = '''  if (target === "index" && currentProject) {
    // 任务 94 Slice I1：进目录确认只有一条路（§20.1）——模块内的 openPageIndex 由 enter 负责
    queueAfterSteps(() => hydrateView("index"));
    window.IndexView?.enter();
  }'''
    assert old in text, "showView 接缝不匹配"
    text = text.replace(old, new)

    # 页面视图切块框叠加层 / 切版心：syncIndexToggles() + 守卫重画（两处）
    old = '''  syncIndexToggles();
  if (currentView === "index") paintIndexDecorations();
'''
    n = text.count(old)
    assert n == 2, "togglePageBlocksOverlay / toggleMarginView 接缝数不对：%d" % n
    text = text.replace(old, "  window.IndexView?.refresh();\n")

    # 版心步骤前进 / 后退：只剩守卫重画（缩进不同，按行匹配；两处）
    text, n = re.subn(
        r'(?m)^(\s*)if \(currentView === "index"\) paintIndexDecorations\(\);$',
        r'\1window.IndexView?.refresh();',
        text,
    )
    assert n == 2, "syncStepToggles 接缝数不对：%d" % n

    # boot：setupPageIndex() 换成模块 init
    old = "  setupPageIndex();\n"
    assert text.count(old) == 1, "boot 里的 setupPageIndex 调用数不对"
    text = text.replace(old, "")

    old = '''  window.PreviewView?.init({'''
    assert text.count(old) == 1
    new = '''  // 任务 94 Slice I1：目录确认视图模块初始化。deps 只给**句柄**（状态 getter/setter +
  // 仍留在 app.js 的纯数据服务），不注入值；模块不许把 getter 的返回值缓存到模块级变量（§13 / §20.4）。
  window.IndexView?.init({
    isActive: () => currentView === "index",
    getProject: () => currentProject,
    getDetailPageNo: () => detailPageNo,
    // 图片清晰度档位：外壳持有（页面视图 / 审校 / 预览都读），模块只读 + 走外壳 setter 改
    getImageQualityMode: () => imageQualityMode,
    setImageQuality: (mode) => setImageQuality(mode),
    // 缩放四档（三步共用）
    getPageZoomIndex: () => pageZoomIndex,
    setPageZoomIndex: (value) => { pageZoomIndex = value; return value; },
    setPageZoomTouched: (value) => { pageZoomTouched = value; return value; },
    // 版心 / 块框开关（三步共用）
    getPagesMarginOn: () => pagesMarginOn,
    setPagesMarginOn: (value) => { pagesMarginOn = value; return value; },
    getPagesOverlayOn: () => pagesOverlayOn,
    setPagesOverlayOn: (value) => { pagesOverlayOn = value; return value; },
    savePageMarginPreference: (...args) => savePageMarginPreference(...args),
    savePageOverlayPreference: (...args) => savePageOverlayPreference(...args),
    togglePageBlocksOverlay: (...args) => togglePageBlocksOverlay(...args),
    toggleMarginView: (...args) => toggleMarginView(...args),
    // R3：页面视图的 DOM 句柄（模块不碰 #view-pages 的 id）
    getPagesMarginToggle: () => el("pages-margin-toggle"),
    getPagesOverlayToggle: () => el("pages-overlay-toggle"),
    // 页码索引缓存（预览也在读同一份）
    getPageIndexData: () => pageIndexData,
    getPageIndexProject: () => pageIndexProject,
    getPageIndexLoading: () => pageIndexLoading,
    loadPageIndex: (...args) => loadPageIndex(...args),
    // 页面渲染的共用叶子函数（页面视图、预览、目录三处一套）
    pageImageUrl: (...args) => pageImageUrl(...args),
    pageProfileFor: (...args) => pageProfileFor(...args),
    blockCountedInMargin: (...args) => blockCountedInMargin(...args),
    clearPageBlocks: (...args) => clearPageBlocks(...args),
    clearTileMargin: (...args) => clearTileMargin(...args),
    paintTileMargin: (...args) => paintTileMargin(...args),
    renderPageBlocks: (...args) => renderPageBlocks(...args),
    loadIndexBlocks: (...args) => loadIndexBlocks(...args),
    clearImagePlaceholder: (...args) => clearImagePlaceholder(...args),
    // 导航
    goToWorkflowStep: (...args) => goToWorkflowStep(...args),
    // 常量
    zoomScales: INDEX_ZOOM_SCALES,
    imageWindow: INDEX_IMAGE_WINDOW,
  });
  window.PreviewView?.init({'''
    text = text.replace(old, new)

    # boot 里的清晰度初始化之后：按钮文字归模块，壳初始化完要喊它一声
    old = "  loadImageQuality();\n  syncImageQualityUi();\n"
    assert text.count(old) == 1, "boot 里的 clearImageQuality 初始化不匹配"
    text = text.replace(
        old,
        "  loadImageQuality();\n  syncImageQualityUi();\n  // 任务 94 Slice I1：#index-quality 的按钮文字归目录视图模块，\n"
        "  // 外壳把档位读出来之后喊它一声（原来那两行由 syncImageQualityUi 直接写，R3 不越界了）。\n"
        "  window.IndexView?.refresh();\n",
    )

    # 预览的 syncIndexToggles 依赖：现在由模块的 refresh 兜（预览不引别的视图，R2）
    old = "    syncIndexToggles: (...args) => syncIndexToggles(...args),\n"
    assert text.count(old) == 1, "预览 deps 里的 syncIndexToggles 不匹配"
    text = text.replace(old, "    syncIndexToggles: () => window.IndexView?.refresh(),\n")

    return text.split("\n")


if __name__ == "__main__":
    sys.exit(main())
