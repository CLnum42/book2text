"""逐字节验证：index 视图迁移（任务 94 · Slice I1）。

证明三件事：
1. **41 个函数 + 23 个状态 + 1 个常量表**：正变换后与基线逐字节相同，逆变换逐字节还原；
2. 每个函数在模块里只定义一次，模块对外只露一个接口对象、4 个键；
3. 段外残留为 0（app.js 不再有 index 子树的顶层声明 / `el("index-…")`）。

原像默认取 `HEAD`（app.js 尚未被本刀改动）。换基线：`B2T_BASELINE=<sha>`。
只读 `git show`，不读工作区里被改过的文件。

退出码 0 = 全过；1 = 有失败（打印首个差异与全部失败项）。
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import rules  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
REL = "backend/book2text/static/app.js"
CANDIDATES = [
    os.path.join(ROOT, "backend", "book2text", "static", "index-view.js"),
    "/tmp/b2t-index/index-view.js",
]
APP_CANDIDATES = [
    os.path.join(ROOT, "backend", "book2text", "static", "app.js"),
    "/tmp/b2t-index/app.js",
]
# 允许露的调试埋点（R6：出现即登记进 WINDOW_HOOK_EXCEPTIONS）
HOOKS = {"__b2tIndexMetrics", "__b2tIndexBlocksMs", "__b2tIndexTops"}

SEG_A, SEG_B = 8179, 9343
# 搬走但**有据可查的两处改写**：
#   openPageIndex   —— 加载分支的 DOM 写点换位
#   setupPageIndex  —— 两处清晰度档入口改走 applyImageQuality()（换档要取图，不归 refresh）
REWRITTEN = {"openPageIndex", "setupPageIndex"}


def baseline_text():
    sha = os.environ.get("B2T_BASELINE", "55a7616")  # Slice I1 之前最后一版
    return subprocess.check_output(
        ["git", "-C", ROOT, "show", "%s:%s" % (sha, REL)]
    ).decode("utf-8")


def slice_fn(lines, name):
    """按函数名取原像（列 0 的 `function` / `async function` 到第一个 `}`）。"""
    pat = re.compile(r"^(?:async\s+)?function\s+%s\s*\(" % re.escape(name))
    start = None
    for i, ln in enumerate(lines):
        if pat.match(ln):
            start = i
            break
    if start is None:
        return None
    for j in range(start, len(lines)):
        if lines[j] == "}":
            return "\n".join(lines[start:j + 1])
    return None


def rewrite_expected(want, name):
    """改写后的样子（必须与 build.py 的 rewrite_moved 一致）。"""
    if name == "setupPageIndex":
        a = "    injected.setImageQuality(order[(order.indexOf(injected.getImageQualityMode()) + 1) % order.length]);"
        b = "      if (radio.checked) injected.setImageQuality(radio.value);"
        assert a in want and b in want, "setupPageIndex 的两个档位入口不在变换结果里"
        return want.replace(a, a.replace("injected.setImageQuality(", "applyImageQuality(")) \
                   .replace(b, b.replace("injected.setImageQuality(", "applyImageQuality("))
    old = """  syncIndexToggles();
  if (!injected.getPageIndexData() || injected.getPageIndexProject() !== injected.getProject().project_id) {
    await injected.loadPageIndex();
  } else {
    renderPageIndex();
  }"""
    new = """  syncIndexToggles();
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
  }"""
    assert old in want, "openPageIndex 的原像块不在变换结果里"
    return want.replace(old, new)


def main():
    base = baseline_text().split("\n")
    seg = base[SEG_A - 1:SEG_B]

    if not any(os.path.exists(p) for p in CANDIDATES):
        print("找不到 index-view.js")
        return 1
    mod_path = next(p for p in CANDIDATES if os.path.exists(p))
    module = open(mod_path, encoding="utf-8").read()

    # 段内顶层声明（列 0）
    fns, sts = [], []
    for ln in seg:
        m = re.match(r"^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)", ln)
        if m:
            fns.append(m.group(1))
            continue
        m = re.match(r"^(?:let|const|var)\s+([A-Za-z_$][\w$]*)", ln)
        if m:
            sts.append(m.group(1))
    # 留段外的（见 build.py 的 STAY）
    stay_fns = {"loadPageIndex", "loadIndexBlocks", "clearImagePlaceholder",
                "loadImageQuality", "setImageQuality", "syncImageQualityUi"}
    stay_sts = {"pageIndexData", "pageIndexProject", "pageIndexLoading",
                "INDEX_ZOOM_SCALES", "INDEX_IMAGE_WINDOW"}
    moved_fns = [n for n in fns if n not in stay_fns]
    moved_sts = [n for n in sts if n not in stay_sts]

    fails = []

    # ---- 1. 函数逐字节 ------------------------------------------------
    exact = 0
    for name in moved_fns:
        src = slice_fn(seg, name)
        if src is None:
            fails.append("基线里找不到函数体：%s" % name)
            continue
        want = rules.forward(src)
        if name in REWRITTEN:
            # 只许在这一处不同：加载分支的 DOM 写点换位
            rewritten = rewrite_expected(want, name)
            if module.count(rewritten) != 1:
                fails.append("改写后的 %s 不在模块里（或不止一处）" % name)
            elif rules.backward(rewritten) == src:
                fails.append("改写的 %s 逆变换后居然还原了——说明改写没生效" % name)
            else:
                exact += 1
            continue
        got_n = module.count(want)
        if got_n != 1:
            if got_n == 0:
                fails.append("正变换后不逐字节相同：%s" % name)
            else:
                fails.append("模块里出现 %d 次：%s" % (got_n, name))
            continue
        # 逆变换还原
        back = rules.backward(want)
        if back != src:
            fails.append("逆变换未还原：%s" % name)
            continue
        exact += 1

    # ---- 2. 状态与常量逐字节 ------------------------------------------
    state_ok = 0
    for name in moved_sts:
        line = next((ln for ln in seg if re.match(
            r"^(?:let|const|var)\s+%s\b" % re.escape(name), ln)), None)
        if line is None:
            fails.append("基线里找不到状态声明：%s" % name)
            continue
        if module.count(line) != 1:
            fails.append("状态声明不逐字节相同或重复：%s" % name)
            continue
        state_ok += 1

    # ---- 3. 接口面 ----------------------------------------------------
    ifaces = re.findall(r"(?m)^\s*window\.([A-Za-z_$][\w$]*)\s*=", rules.strip_code(module))
    apis = [n for n in ifaces if not n.startswith("__b2t")]
    hooks = sorted(n for n in ifaces if n.startswith("__b2t"))
    if apis != ["IndexView"]:
        fails.append("模块露出的接口对象不是恰好 IndexView：%s" % apis)
    if set(hooks) != HOOKS:
        fails.append("模块露的调试埋点不是约定的 3 个：%s" % hooks)
    block = re.search(r"window\.IndexView\s*=\s*\{(.*?)\};", module, re.S)
    keys = []
    if block:
        keys = [k.strip() for k in block.group(1).split(",") if k.strip()]
    if keys != ["init", "enter", "refresh"]:
        fails.append("IndexView 的键不是 init/enter/refresh：%s" % keys)

    # ---- 4. R3：模块不碰别的子树的 id ---------------------------------
    own = set(re.findall(r'el\("([a-z-]+)"\)', module))
    foreign = sorted(k for k in own if not k.startswith("index-"))
    if foreign:
        fails.append("模块用了不属于本视图的 id：%s" % foreign)

    # ---- 5. 段外残留 --------------------------------------------------
    app_path = next(p for p in APP_CANDIDATES if os.path.exists(p))
    app = open(app_path, encoding="utf-8").read()
    acode = rules.strip_code(app)
    print("被测 app.js：%s" % app_path)

    # 5a. 搬走的东西不许再在 app.js 里声明（列 0 顶层）
    for name in moved_fns + moved_sts:
        if re.search(r"(?m)^(?:async\s+)?(?:function|let|const|var)\s+%s\b" % re.escape(name), app):
            fails.append("app.js 里还声明着已搬走的 %s" % name)
    # 5b. 搬走的函数不许再被 app.js 裸调（回引用只能走 window.IndexView）
    for name in moved_fns:
        if name in {"init", "enter", "refresh"}:
            continue
        if re.search(r"(?<![\w$.])%s\s*\(" % re.escape(name), acode):
            fails.append("app.js 还在裸调已搬走的 %s()" % name)
    # 5c. R3：app.js 不许碰目录子树的 id
    if re.search(r'el\("index-[a-z-]+"\)', app):
        fails.append('app.js 里还有 el("index-…")（R3）')
    # 5d. 接缝必须在：两个入口 + 五个 refresh 点
    if app.count("window.IndexView?.enter()") != 1:
        fails.append("showView 的 IndexView.enter() 接缝数不对")
    # 4 处页面视图戳 + boot 档位初始化 + 预览 deps 的 lambda = 6
    # （清晰度档变化不走 refresh()——它要取图，走模块内 applyImageQuality，见 Chief 条件 ①）
    if app.count("window.IndexView?.refresh()") != 6:
        fails.append("IndexView.refresh() 接缝不是 6 个：%d" % app.count("window.IndexView?.refresh()"))
    if "refresh({" in app or "refresh({ " in app:
        fails.append("refresh() 被塞了参数包（§20.6 否决）")
    if app.count("window.IndexView?.init(") != 1:
        fails.append("boot 的 IndexView.init() 接缝数不对")


    print("函数逐字节（正变换 1 次命中 + 逆变换还原）：%d/%d" % (exact, len(moved_fns)))
    print("其中改写 2 处：%s（加载分支 DOM 写点换位 + 两处清晰度档入口改走 applyImageQuality，见 build.py rewrite_moved）" % sorted(REWRITTEN))
    print("状态 / 常量声明逐字节：%d/%d" % (state_ok, len(moved_sts)))
    print("接口：%s" % (keys,))
    print("模块自己的 id：%d 个（%s…）" % (len(own), sorted(own)[0] if own else "-"))
    if fails:
        print("\n失败 %d 项：" % len(fails))
        for f in fails[:20]:
            print("  -", f)
        return 1
    print("\n全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
