/**
 * Book2Text QA 浏览器驱动（ego-browser / Chromium）。
 *
 * 三条纪律（每条都对应一次真实误判）：
 * 1. **不许 sleep 当等待**：所有等待都是 waitForFunction 等一个可观测状态。
 * 2. **视口固定 1423×900 CSS px、dpr 2**：与用户机器一致，量出来的字号/清晰度才算数。
 * 3. **真实鼠标**：点击一律走 page.click / page.mouse.click（CDP Input.dispatchMouseEvent），
 *    不用 dispatchEvent 造合成事件。
 *
 * 由 Python 侧 `_browser.py` 传入 cfg，返回可 JSON 序列化的结果。
 */

const WAIT = 120000;

export async function run(cfg) {
  // ---- 不建/不动 space 的两条命令：必须在 taskSpace() 之前处理，
  //      否则 taskSpace(name) 会在名字不存在时**新建一个**，守卫本身就成了泄漏源。
  if (cfg.cmd === "list_spaces") {
    const spaces = await listTaskSpaces();
    return spaces
      .filter((space) => String(space.name || "").startsWith("b2t-qa-"))
      .map((space) => ({ id: space.id, name: space.name, ownership: space.ownership }));
  }
  if (cfg.cmd === "teardown") {
    const spaces = await listTaskSpaces();
    const mine = spaces
      .filter((space) => space.name === cfg.space)
      .map((space) => space.id);
    if (!mine.length) return { finished: false, reason: "no-space" };
    try {
      const task = await taskSpace(cfg.space);
      await task.finish({ keep: [] });
      return { finished: true, ids: mine };
    } catch (error) {
      return { finished: false, reason: String(error && error.message ? error.message : error) };
    }
  }
  const task = await taskSpace(cfg.space);
  const page = task.page("p1");
  const args = cfg.args || {};

  // 页面可能被一个原生 alert 挡住（提交失败时应用会 alert），此时连 CDP 都会挂。
  // recover 是所有命令之前的一步"急救"：先应答对话框，再重开页面。
  if (cfg.cmd === "recover") {
    await recover(page, cfg);
    return { recovered: true };
  }
  await setViewport(page, cfg);

  switch (cfg.cmd) {
    case "prepare":
      return await prepare(page, cfg);
    case "step":
      return await step(page, cfg, args.step);
    case "reading":
      return await reading(page, cfg);
    case "edit":
      return await edit(page, cfg, args);
    case "submit":
      return await submit(page, cfg);
    case "undo":
      return await undo(page, cfg);
    case "export":
      return await exportStep(page, cfg);
    case "page_sync":
      return await pageSync(page, cfg, args);
    case "highlight_probe":
      return await highlightProbe(page);
    case "next_probe":
      return await nextProbe(page);
    case "pin_guard":
      return await pinGuard(page, args);
    case "scroll_follow":
      return await scrollFollow(page, args);
    case "review_state":
      return await reviewState(page);
    case "label_watch":
      return await labelWatch(page);
    case "label_writes":
      return await labelWrites(page);
    case "reset_diag":
      return await resetDiag(page);
    case "stress_next":
      return await stressNext(page, args);
    case "perf_probe":
      return await perfProbe(page, args);
    case "task_metrics":
      return await taskMetrics(page, args);
    case "dock_probe":
      return await dockProbe(page, args);
    case "crop_probe":
      return await cropProbe(page, args);
    case "error_watch":
      return await errorWatch(page, args);
    case "crop_sizes":
      return await cropSizeProbe(page);
    case "punct_probe":
      return await punctProbe(page, args);
    case "handlers_probe":
      return await handlersProbe(page, args);
    case "click_sel":
      return await clickSel(page, args);
    case "interactions_probe":
      return await interactionsProbe(page, args);
    case "click_accept":
      return await clickAccept(page, args);
    case "l3_probe":
      return await l3Probe(page, args);
    case "l4_probe":
      return await l4Probe(page, args);
    case "goto_probe":
      return await gotoProbe(page, args);
    case "next_log":
      return await page.evaluate(() => window.__b2tNextLog || []);
    case "queue_end":
      return await queueEnd(page, cfg);
    case "images":
      return await measureImages(page, args);
    case "audit":
      return await auditMarks(page);
    case "inspect":
      return await page.evaluate(() => {
        const seg = document.querySelector('.reading-seg[data-seq="5"]');
        const clone = seg ? seg.cloneNode(true) : null;
        if (clone) clone.querySelectorAll(".reading-chip, .reading-fold, .reading-proof__pages, .reading-mark__hint").forEach((n) => n.remove());
        const data = typeof readingData !== "undefined" && readingData ? readingData : null;
        const segments = data && data.segments ? data.segments : [];
        return {
          domText: clone ? clone.textContent : null,
          domHtml: seg ? seg.innerHTML.slice(0, 1200) : null,
          dataText: segments.length > 4 ? segments[4].text : null,
          dataSeq: segments.length > 4 ? segments[4].seq : null,
          options: typeof readingOptions === "function" ? readingOptions() : null,
          previewSeg: data && data.preview ? (data.preview.segments || []).slice(0, 2) : null,
          draftChip: (document.getElementById("reading-draft-chip") || {}).innerText || "",
          localKeys: Object.keys(localStorage),
        };
      });
    case "dom":
      return await dom(page, args);
    case "close":
      await page.goto("about:blank");
      return { closed: true };
    default:
      throw new Error(`未知命令：${cfg.cmd}`);
  }
}

// ---------------------------------------------------------------- 基础工具

async function setViewport(page, cfg) {
  await page.cdp("Emulation.setDeviceMetricsOverride", {
    width: cfg.viewport.width,
    height: cfg.viewport.height,
    deviceScaleFactor: cfg.viewport.dpr,
    mobile: false,
  });
}

async function waitFor(page, fn, desc, timeout = WAIT, arg = undefined) {
  try {
    await page.waitForFunction(fn, arg, { timeout });
  } catch (error) {
    throw new Error(`等待超时：${desc}（${timeout}ms 内没等到可观测状态）`);
  }
}

async function recover(page, cfg) {
  await page.acceptDialog().catch(() => {});
  await page.goto("about:blank").catch(() => {});
  await setViewport(page, cfg);
  await page.goto(cfg.url).catch(() => {});
  await page.waitForTimeout(500);
}

async function dismissMasks(page) {
  const open = await page.evaluate(() =>
    [...document.querySelectorAll(".mask")].some(
      (mask) => !mask.hidden && mask.id !== "first-run-card"
    )
  );
  if (open) {
    await page.keyboard.press("Escape");
    await waitFor(
      page,
      () => ![...document.querySelectorAll(".mask")].some((mask) => !mask.hidden),
      "关闭遮罩对话框",
      15000
    );
  }
}

/**
 * 页图清晰度：比例 = img.naturalWidth ÷ (img CSS 宽 × dpr)，断言 ≥ 1.0。
 * 小于 1 = 图被放大显示，一定糊（用户为这个提过四次）。
 */
async function setIndexZoom(page, percent) {
  // 目录确认的缩放档：55% / 70% / 85% / 适合宽度。85% 是余量最薄的一档，必须常驻盯。
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const label = await page.evaluate(
      () => (document.getElementById("index-zoom-label") || {}).textContent || ""
    );
    if (label.trim() === `${percent}%`) return;
    const current = label.includes("适合") ? 100 : Number.parseInt(label, 10) || 100;
    const selector = current > percent ? "#index-zoom-out" : "#index-zoom-in";
    const disabled = await page.evaluate(
      (sel) => Boolean(document.querySelector(sel) && document.querySelector(sel).disabled),
      selector
    );
    if (disabled) {
      throw new Error(`无法把目录缩放调到 ${percent}%（当前「${label.trim()}」）`);
    }
    await page.click(selector, { label: `目录缩放 ${current > percent ? "减小" : "增大"}` });
    await waitFor(
      page,
      (before) => {
        const node = document.getElementById("index-zoom-label");
        return Boolean(node && node.textContent.trim() !== before);
      },
      `目录缩放离开「${label.trim()}」`,
      10000,
      label.trim()
    );
  }
  const finalLabel = await page.evaluate(
    () => (document.getElementById("index-zoom-label") || {}).textContent || ""
  );
  if (finalLabel.trim() !== `${percent}%`) {
    throw new Error(`目录缩放没到 ${percent}%（当前「${finalLabel.trim()}」）`);
  }
}

async function waitVisiblePageImages(page, container, tileSelector, where, scroll) {
  // 占位图（src=thumb）不算载入完成：必须 is-ready 且不再是 placeholder。
  await waitFor(
    page,
    (input) => {
      const scroller = document.querySelector(input.container);
      if (!scroller) return false;
      const cRect = scroller.getBoundingClientRect();
      const tiles = [...document.querySelectorAll(input.tile)].filter((tile) => {
        const rect = tile.getBoundingClientRect();
        return rect.bottom > cRect.top && rect.top < cRect.bottom;
      });
      if (!tiles.length) return false;
      return tiles.every((tile) => {
        const image = tile.querySelector("img");
        return Boolean(
          image &&
            image.complete &&
            image.naturalWidth > 0 &&
            image.classList.contains("is-ready") &&
            !image.dataset.placeholder
        );
      });
    },
    `可见页图载入完成（${where}/${scroll}）`,
    120000,
    { container, tile: tileSelector }
  );
}

async function scrollPageColumn(page, container, tileSelector, scroll) {
  return await page.evaluate(
    (input) => {
      const node = document.querySelector(input.container);
      if (!node) return -1;
      if (input.scroll === "top") {
        node.scrollTop = 0;
        return node.scrollTop;
      }
      const tiles = [...node.querySelectorAll(input.tile)];
      const target = tiles[Math.floor(tiles.length / 2)];
      if (target) {
        const top =
          target.getBoundingClientRect().top -
          node.getBoundingClientRect().top +
          node.scrollTop -
          node.clientHeight / 2 +
          target.clientHeight / 2;
        node.scrollTop = Math.max(0, top);
      }
      return node.scrollTop;
    },
    { container, tile: tileSelector, scroll }
  );
}

/** 读三方：当前差异项页（面板头） / 顶部页码 / 左栏 25% 可见页，并附同步日志。 */
async function pageSyncSnapshot(page) {
  const read = async () =>
    await page.evaluate(() => {
      const scroller = document.getElementById("reading-pdf-scroll");
      const labelText = (document.getElementById("reading-page-no") || {}).innerText || "";
      const match = labelText.match(/(\d+)/);
      const label = match ? Number(match[1]) : null;

      const visibleTiles = [];
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        for (const tile of scroller.querySelectorAll(".reading-page")) {
          const tileRect = tile.getBoundingClientRect();
          const overlap = Math.min(tileRect.bottom, rect.bottom) - Math.max(tileRect.top, rect.top);
          if (overlap > 0) {
            visibleTiles.push({
              page: Number(tile.dataset.pageNo),
              top: Math.round(tileRect.top - rect.top),
              height: Math.round(tileRect.height),
              overlap: Math.round(overlap),
            });
          }
        }
      }
      const dominant = visibleTiles.length
        ? visibleTiles.reduce((best, item) => (item.overlap > best.overlap ? item : best), visibleTiles[0])
        : null;

      const tileAt = (ratio) => {
        if (!scroller) return null;
        const rect = scroller.getBoundingClientRect();
        const anchor = rect.top + scroller.clientHeight * ratio;
        for (const tile of scroller.querySelectorAll(".reading-page")) {
          const tileRect = tile.getBoundingClientRect();
          if (tileRect.top <= anchor && tileRect.bottom > anchor) return Number(tile.dataset.pageNo);
        }
        return null;
      };

      const panelHead = document.querySelector(".reading-panel__head strong");
      let panelPage = null;
      if (panelHead) {
        const panelText = panelHead.textContent || "";
        const panelMatch = panelText.match(/第\s*(\d+)\s*页/);
        if (panelMatch) panelPage = Number(panelMatch[1]);
      }
      const panel = document.querySelector(".reading-panel");
      let panelVisible = false;
      if (panel) {
        const r = panel.getBoundingClientRect();
        panelVisible = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
      }
      const lineCurrent = document.querySelectorAll("#reading-stream .reading-line.is-current").length;
      const markCurrent = document.querySelectorAll("#reading-stream .reading-mark.is-current").length;
      const pdfBox = document.getElementById("reading-pdf-box");
      const pdfBoxes = pdfBox && !pdfBox.hidden ? pdfBox.querySelectorAll(".box").length : 0;
      const diffBoxes = document.querySelectorAll("#reading-diff-layer .box").length;

      const stream = document.getElementById("reading-stream");
      let anchorPage = null;
      let anchorKey = null;
      if (stream) {
        const sRect = stream.getBoundingClientRect();
        const anchorY = sRect.top + stream.clientHeight * 0.35;
        for (const item of stream.querySelectorAll(".reading-line")) {
          const r = item.getBoundingClientRect();
          if (r.bottom >= anchorY) {
            anchorPage = Number(item.dataset.page) || null;
            anchorKey = item.dataset.key || null;
            break;
          }
        }
      }
      const pinNow = window.__b2tPagePin || null;
      let panelLineIn = null;
      if (stream) {
        const panelEl = document.querySelector(".reading-panel");
        const pk = panelEl ? panelEl.dataset.key : null;
        const line = pk
          ? stream.querySelector(`.reading-line[data-key="${pk}"]`)
          : null;
        if (line) {
          const sRect = stream.getBoundingClientRect();
          const lr = line.getBoundingClientRect();
          panelLineIn = lr.bottom > sRect.top && lr.top < sRect.bottom;
        }
      }
      return {
        label,
        labelText: labelText.trim(),
        anchorPage,
        anchorKey,
        panelLineIn,
        settleKey: typeof readingJumpSettleKey !== "undefined" ? readingJumpSettleKey : "n/a",
        userSeq: typeof readingUserScrollSeq !== "undefined" ? readingUserScrollSeq : "n/a",
        programSeq: typeof readingProgramScrollSeq !== "undefined" ? readingProgramScrollSeq : "n/a",
        pin: pinNow ? { held: pinNow.held, escape: pinNow.escape } : null,
        panelPage,
        panelText: panelHead ? (panelHead.textContent || "").trim() : null,
        tilePage: tileAt(0.25),
        tileCenter: tileAt(0.5),
        tileDominant: dominant ? dominant.page : null,
        visibleTiles,
        scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        panelVisible,
        highlight: { lineCurrent, markCurrent, pdfBoxes, diffBoxes, any: lineCurrent + markCurrent + pdfBoxes + diffBoxes > 0 },
        sync: window.__b2tPageSync || null,
        syncLog: (window.__b2tPageSyncLog || []).slice(0, 5),
      };
    });

  let last = await read();
  let lastKey = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // 重渲染的瞬间 #reading-page-no 可能短暂不存在：这时候的"稳定"是假稳定，
    // 不能拿 null 去判三方；等到页码重新出现再说。
    if (last.label !== null) {
      const key = JSON.stringify([
        last.label, last.panelPage, last.tilePage, last.scrollTop, last.viewport,
      ]);
      if (key === lastKey) return last;
      lastKey = key;
    } else {
      lastKey = null;
    }
    await page.waitForTimeout(140);
    last = await read();
  }
  return last;
}

async function clickTreePage(page, pageNo) {
  // 左树只列"有差异的页"（这本书 356 行 / 662 页）。目标页没有差异时没有这一行，
  // 退到最近的、存在的一行，并在结果里如实记 requested / actual。
  const actual = await page.evaluate((wanted) => {
    const rows = [...document.querySelectorAll(".reading-tree__row[data-page]")].map((row) =>
      Number(row.dataset.page)
    );
    if (!rows.length) return null;
    if (rows.includes(wanted)) return wanted;
    const below = rows.filter((value) => value < wanted).sort((a, b) => b - a)[0];
    const above = rows.filter((value) => value > wanted).sort((a, b) => a - b)[0];
    if (below === undefined) return above ?? null;
    if (above === undefined) return below;
    return wanted - below <= above - wanted ? below : above;
  }, pageNo);
  if (actual === null) throw new Error("左树没有任何页行");
  const selector = `.reading-tree__row[data-page="${actual}"]`;
  await page.click(selector, { label: `点左树第 ${actual} 页` });
  await waitFor(
    page,
    (no) => {
      const node = document.getElementById("reading-page-no");
      return Boolean(node && node.textContent.replace(/\s+/g, "").includes(`第${no}页`));
    },
    `顶部页码变成第 ${actual} 页`,
    30000,
    actual
  );
  return { requested: pageNo, actual };
}

async function waitInvariantForLabel(page, label) {
  // 应用的 __b2tPageSync 在页码变化后 130ms 才核对；等它针对当前页码跑过一次，
  // 量到的才是"用户会看到的稳态"，而不是翻页瞬间。
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const sync = await page.evaluate(() => window.__b2tPageSync || null);
    if (sync && sync.label === label) return sync;
    await page.waitForTimeout(150);
  }
  return null;
}

async function dragPdfGrip(page, delta) {
  const box = await page.evaluate(() => {
    const grip = document.getElementById("reading-grip-pdf");
    if (!grip) return null;
    const rect = grip.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  if (!box) return false;
  await page.mouse.move(box.x, box.y, { label: "移到页列分隔条" });
  await page.mouse.down();
  await page.mouse.move(box.x + delta, box.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  return true;
}

async function wheelToPage(page, pageNo) {
  const box = await page.evaluate(() => {
    const scroller = document.getElementById("reading-pdf-scroll");
    const rect = scroller.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(box.x, box.y, { label: "移到页列上" });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const current = await page.evaluate(() => {
      const scroller = document.getElementById("reading-pdf-scroll");
      const rect = scroller.getBoundingClientRect();
      const anchor = rect.top + scroller.clientHeight * 0.25;
      for (const tile of scroller.querySelectorAll(".reading-page")) {
        const tileRect = tile.getBoundingClientRect();
        if (tileRect.top <= anchor && tileRect.bottom > anchor) return Number(tile.dataset.pageNo);
      }
      return null;
    });
    if (current !== null && Math.abs(current - pageNo) <= 1) break;
    const direction = current === null || current < pageNo ? 1 : -1;
    await page.mouse.wheel(0, direction * 900, { label: "滚页列" });
    await page.waitForTimeout(40);
  }
  // 让"左栏滚动 → 顶部页码"跟上（这是应用自身的同步，不是我们替它改）
  await waitFor(
    page,
    (no) => {
      const label = document.getElementById("reading-page-no");
      return Boolean(label && Math.abs(Number((label.textContent.match(/(\d+)/) || [0, 0])[1]) - no) <= 2);
    },
    "滚动后顶部页码跟上",
    30000,
    pageNo
  );
}

/**
 * 左右页同步的六条路径。返回顶部页码、左栏 25% 处的页、是否一致、应用不变量。
 * 全程真实鼠标（点树 / 滚轮 / 点按钮），不 dispatchEvent。
 */
async function clickMarkAt(page, label) {
  // `.reading-mark` 一屏有几十个（同一行可能多个词级 mark），选择器不唯一；
  // 用坐标点第一处"可见且在视口里"的 mark —— 仍然是真实鼠标。
  const point = await page.evaluate(async () => {
    const visible = () => {
      for (const mark of document.querySelectorAll("#reading-stream .reading-mark")) {
        const rect = mark.getBoundingClientRect();
        if (
          rect.width > 0 && rect.height > 0 &&
          rect.bottom > 0 && rect.top < window.innerHeight &&
          rect.right > 0 && rect.left < window.innerWidth
        ) {
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }
      }
      return null;
    };
    const found = visible();
    if (found) return found;
    // 视口里没有：把正文流里第一处差异滚到中间。
    // **不能对 mark 用 scrollIntoView**：它会去滚别的祖先（app.js 里也有同样的教训注释），
    // 正文流自己不动，于是"滚了但还是看不见"。直接改 #reading-stream.scrollTop。
    const first = document.querySelector("#reading-stream .reading-mark");
    if (!first) return null;
    const stream = document.getElementById("reading-stream");
    if (stream) {
      const offset =
        first.getBoundingClientRect().top -
        stream.getBoundingClientRect().top +
        stream.scrollTop -
        stream.clientHeight * 0.4;
      stream.scrollTop = Math.max(0, offset);
    } else {
      first.scrollIntoView({ block: "center", behavior: "auto" });
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    return visible();
  });
  if (!point) {
    // 别只说"没有标记"：把当时的选择器状态一起带出来，才能分清是探针没等到还是真的没铺。
    const diag = await page.evaluate(() => {
      const stream = document.getElementById("reading-stream");
      const label = (document.getElementById("reading-page-no") || {}).textContent || "";
      return {
        marks: document.querySelectorAll("#reading-stream .reading-mark").length,
        lines: document.querySelectorAll("#reading-stream .reading-line").length,
        segs: document.querySelectorAll("#reading-stream .reading-seg").length,
        filter: typeof readingFilter !== "undefined" ? readingFilter : "n/a",
        visibleSegments: typeof readingVisibleSegments === "function" ? readingVisibleSegments().length : "n/a",
        entries: typeof readingEntries !== "undefined" ? readingEntries.length : "n/a",
        panelKey: (document.querySelector(".reading-panel") || {}).dataset
          ? document.querySelector(".reading-panel").dataset.key || null
          : null,
        label: label.replace(/\s+/g, ""),
        scrollTop: stream ? Math.round(stream.scrollTop) : null,
        scrollHeight: stream ? Math.round(stream.scrollHeight) : null,
      };
    });
    throw new Error("正文流里没有可点的差异标记：" + JSON.stringify(diag));
  }
  await page.mouse.click(point.x, point.y, { label });
  await waitFor(
    page,
    () => Boolean(document.querySelector(".reading-panel__head strong")),
    "差异面板打开",
    30000
  );
}

async function ensurePanelOpen(page) {
  const open = await page.evaluate(() => Boolean(document.querySelector(".reading-panel__head strong")));
  if (open) return;
  await clickMarkAt(page, "点一处差异");
}

async function clickFirstMark(page) {
  // 跳页后 marks 是异步补窗口的：先等正文流里真的出现标记，再点。
  await waitFor(
    page,
    () => document.querySelectorAll("#reading-stream .reading-mark").length > 0,
    "正文流出现差异标记",
    20000
  ).catch(() => {});
  await clickMarkAt(page, "点一处差异");
}

/**
 * 左右页同步（三方）：当前差异项页 == 顶部页码 == 左栏 25% 可见页。
 * 只看前两个数会漏掉真正错的情况（面板第 13 页、顶部与左侧都是第 28 页）。
 */
async function pageSync(page, cfg, args) {
  const path = args.path || "open";
  await ensureReading(page);
  const before = await pageSyncSnapshot(page);
  let beforeTree = null;

  if (path === "open") {
    await page.click('button[data-workflow-step="pages"]', { label: "切到页面确认" });
    await waitFor(
      page,
      () => Boolean(document.getElementById("view-pages") && !document.getElementById("view-pages").hidden),
      "页面视图可见",
      30000
    );
    await page.click('button[data-workflow-step="review"]', { label: "重新进入正文审校" });
    await waitFor(
      page,
      () => Boolean(document.getElementById("view-reading") && !document.getElementById("view-reading").hidden),
      "阅读视图可见",
      60000
    );
    const snapshot = await pageSyncSnapshot(page);
    return { path, before, snapshot, screenshot: await screenshot(page, cfg, "pagesync-open") };
  }

  if (path === "tree") {
    beforeTree = await clickTreePage(page, args.page || 50);
    await clickFirstMark(page);
    const snapshot = await pageSyncSnapshot(page);
    return { path, before, beforeTree, snapshot, screenshot: await screenshot(page, cfg, "pagesync-tree") };
  }

  if (path === "next20") {
    const iterations = [];
    let previous = await page.evaluate(() => ({
      label: (document.getElementById("reading-page-no") || {}).textContent || "",
      panel: (document.querySelector(".reading-panel__head strong") || {}).textContent || "",
    }));
    for (let i = 0; i < 20; i += 1) {
      await page.click("#reading-next-unreviewed", { label: `下一处未审（第 ${i + 1} 次）` });
      // 同一页上可能有多处：页码不变但面板换了，所以两个都等
      const changed = await page
        .waitForFunction(
          (prev) => {
            const label = (document.getElementById("reading-page-no") || {}).textContent || "";
            const panel = (document.querySelector(".reading-panel__head strong") || {}).textContent || "";
            return label !== prev.label || panel !== prev.panel;
          },
          previous,
          { timeout: 15000 }
        )
        .then(() => true)
        .catch(() => false);
      // fetch / pending-open 分支里，面板可能在 marks/blocks 到达后才补开：
      // 等它真的出现在 DOM（最多 10 秒），别在"还没开"的那一瞬下结论。
      if (!changed) {
        await page
          .waitForFunction(
            () => Boolean(document.querySelector("#reading-stream .reading-panel")),
            undefined,
            { timeout: 10000 }
          )
          .catch(() => {});
      }
      const snapshot = await pageSyncSnapshot(page);
      // 高亮要连 key 一起验：只数 is-current 会把"高亮了别的行"判成通过。
      const highlightKey = await page.evaluate(() => {
        const panel = document.querySelector(".reading-panel");
        const key = panel ? panel.dataset.key || null : null;
        const node = key
          ? document.querySelector(`#reading-stream .reading-line[data-key="${key}"]`)
          : null;
        return {
          panelKey: key,
          targetExists: Boolean(node),
          targetCurrent: Boolean(node && node.classList.contains("is-current")),
          currentLines: document.querySelectorAll("#reading-stream .reading-line.is-current").length,
        };
      });
      // 通用防"被收掉"：等 500ms 再看一次，出现过的面板必须还在。
      await page.waitForTimeout(500);
      const snapshot2 = await pageSyncSnapshot(page);
      const logEntry = await page.evaluate(() => (window.__b2tNextLog || [])[0] || null);
      const progressed = Boolean(
        snapshot.labelText !== previous.label || (snapshot.panelText || "") !== (previous.panel || "")
      );
      const finished = /全部处理完|全部处理完毕|没有未审|都审完/.test(snapshot.labelText + " " + (snapshot.panelText || ""));
      if (finished) {
        iterations.push({ index: i + 1, stopped: true, finished: true, snapshot, snapshot2 });
        break;
      }
      // 没变化也记一条并继续：可能是一次慢加载，也可能就是"点了没反应"，都要暴露出来
      iterations.push({
        index: i + 1, changed, progressed, snapshot, snapshot2, logEntry, ...highlightKey,
      });
      previous = await page.evaluate(() => ({
        label: (document.getElementById("reading-page-no") || {}).textContent || "",
        panel: (document.querySelector(".reading-panel__head strong") || {}).textContent || "",
      }));
    }
    const nextLog = await page.evaluate(() => window.__b2tNextLog || []);
    const finalProgress = await page.evaluate(
      () => (document.getElementById("reading-progress-text") || {}).innerText || ""
    );
    return {
      path,
      before,
      iterations,
      nextLog: nextLog.slice(0, 20),
      finalProgress,
      snapshot: iterations.length ? iterations[iterations.length - 1].snapshot : await pageSyncSnapshot(page),
      screenshot: await screenshot(page, cfg, "pagesync-next20"),
    };
  }

  if (path === "scroll") {
    // 面板开着时，应用会以"当前差异项所在页"为准把页列拉回去（设计如此）。
    // 所以这里不追求滚到 120 页，而是滚几下后验证三方仍然一致。
    await ensurePanelOpen(page);
    const box = await page.evaluate(() => {
      const scroller = document.getElementById("reading-pdf-scroll");
      const rect = scroller.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await page.mouse.move(box.x, box.y, { label: "移到页列上" });
    for (let i = 0; i < 3; i += 1) {
      await page.mouse.wheel(0, 900, { label: "手动滚页列" });
      await page.waitForTimeout(200);
    }
    const snapshot = await pageSyncSnapshot(page);
    return { path, before, snapshot, screenshot: await screenshot(page, cfg, "pagesync-scroll") };
  }

  if (path === "resize") {
    await ensurePanelOpen(page);
    const itemBefore = await pageSyncSnapshot(page);
    const afterDrag = args.skipDrag
      ? null
      : ((await dragPdfGrip(page, args.dragDelta ?? -60)), await pageSyncSnapshot(page));
    await page.cdp("Emulation.setDeviceMetricsOverride", {
      width: 1180,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await page.waitForFunction(() => window.innerWidth === 1180, undefined, { timeout: 15000 });
    await page.waitForTimeout(500);
    const resized = await pageSyncSnapshot(page);
    await page.cdp("Emulation.setDeviceMetricsOverride", {
      width: cfg.viewport.width,
      height: cfg.viewport.height,
      deviceScaleFactor: cfg.viewport.dpr,
      mobile: false,
    });
    await page.waitForFunction((width) => window.innerWidth === width, cfg.viewport.width, { timeout: 15000 });
    return {
      path,
      before: itemBefore,
      afterDrag,
      snapshot: resized,
      restored: true,
      screenshot: await screenshot(page, cfg, "pagesync-resize"),
    };
  }

  if (path === "closepanel") {
    await ensurePanelOpen(page);
    const opened = await pageSyncSnapshot(page);
    await page.click(".reading-panel .icon-btn", { label: "关闭候选面板" });
    await waitFor(
      page,
      () => !document.querySelector(".reading-panel"),
      "面板已关闭",
      15000
    );
    // 滚一下 + 触发一次重绘（跳页会 renderReading reset），面板都不许自己冒回来
    const box = await page.evaluate(() => {
      const scroller = document.getElementById("reading-pdf-scroll");
      const rect = scroller.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await page.mouse.move(box.x, box.y, { label: "移到页列上" });
    await page.mouse.wheel(0, 700, { label: "滚一下" });
    // 触发一次重绘：切差异筛选会让 renderReading(reset) 重铺正文流（不跳页、不开面板）
    await page.selectOption("#reading-filter", "unacked");
    await page.waitForTimeout(300);
    await page.selectOption("#reading-filter", "all");
    await page.waitForTimeout(800);
    const after = await pageSyncSnapshot(page);
    const panelBack = await page.evaluate(() => Boolean(document.querySelector(".reading-panel")));
    return {
      path,
      before,
      opened,
      closeResult: { panelBack, after },
      screenshot: await screenshot(page, cfg, "pagesync-close"),
    };
  }

  if (path === "crosspage") {
    const target = await page.evaluate(() => {
      const segments = (typeof readingData !== "undefined" && readingData && readingData.segments) || [];
      for (const segment of segments) {
        const pages = [...new Set((segment.line_spans || []).map((span) => Number(span.page_no)))];
        if (pages.length < 2) continue;
        for (const span of segment.line_spans || []) {
          const key = `${span.block_id}:${span.line_index}`;
          if (typeof readingMarks !== "undefined" && readingMarks.has(key)) {
            return { key, page: Number(span.page_no), seq: segment.seq, pages };
          }
        }
      }
      return null;
    });
    if (!target) {
      // 窗口里没有跨页段的标记时，退一步：找任意跨页段的第一页，跳过去点该页第一处差异。
      const fallbackPage = await page.evaluate(() => {
        const segments = (typeof readingData !== "undefined" && readingData && readingData.segments) || [];
        const segment = segments.find((item) => new Set((item.line_spans || []).map((s) => s.page_no)).size > 1);
        return segment ? Number(segment.pages[0].page_no) : null;
      });
      if (!fallbackPage) return { path, before, skipped: true, reason: "没有跨页段" };
      beforeTree = await clickTreePage(page, fallbackPage);
      await clickFirstMark(page);
      const snapshot = await pageSyncSnapshot(page);
      return { path, before, beforeTree, snapshot, fallback: true, screenshot: await screenshot(page, cfg, "pagesync-crosspage") };
    }
    beforeTree = await clickTreePage(page, target.page);
    const selector = `.reading-mark[data-key="${target.key}"]`;
    const exists = await page.evaluate((sel) => Boolean(document.querySelector(sel)), selector);
    if (exists) {
      await page.click(selector, { label: "点跨页段的差异项" });
    } else {
      await clickFirstMark(page);
    }
    await waitFor(
      page,
      () => Boolean(document.querySelector(".reading-panel__head strong")),
      "差异面板打开（跨页项）",
      30000
    );
    const snapshot = await pageSyncSnapshot(page);
    return { path, before, beforeTree, target, snapshot, screenshot: await screenshot(page, cfg, "pagesync-crosspage") };
  }

  throw new Error(`未知的同步路径：${path}`);
}

async function measureImages(page, args) {
  const where = args.where || "review";
  const scroll = args.scroll || "top";
  const dpr = await page.evaluate(() => window.devicePixelRatio || 1);

  if (where === "index") {
    await dismissMasks(page);
    await page.click('button[data-workflow-step="index"]', { label: "进入目录确认" });
    await waitFor(
      page,
      () => {
        const view = document.getElementById("view-index");
        return Boolean(view && !view.hidden);
      },
      "目录确认视图可见",
      60000
    );
  } else {
    await ensureReading(page);
  }

  if (where === "index" && args.zoomPercent) {
    await setIndexZoom(page, args.zoomPercent);
    // 缩放变了，所需像素也变了；等可见图换到够清晰的档位再量。
    // 等不到也不在这里判死：后面三条底线会如实报 FAIL（比例/模糊/占位类）。
    await page
      .waitForFunction(
        () => {
          const scroller = document.getElementById("index-canvas");
          if (!scroller) return false;
          const cRect = scroller.getBoundingClientRect();
          const dpr = window.devicePixelRatio || 1;
          const tiles = [...document.querySelectorAll(".index-page")].filter((tile) => {
            const rect = tile.getBoundingClientRect();
            return rect.bottom > cRect.top && rect.top < cRect.bottom;
          });
          if (!tiles.length) return false;
          return tiles.every((tile) => {
            const image = tile.querySelector("img");
            if (!image || !image.classList.contains("is-ready") || !image.naturalWidth) return false;
            const width = image.getBoundingClientRect().width;
            return width > 0 && image.naturalWidth >= width * dpr * 0.99;
          });
        },
        undefined,
        { timeout: 15000 }
      )
      .catch(() => {});
  }

  const container = where === "index" ? "#index-canvas" : "#reading-pdf-scroll";
  const tileSelector = where === "index" ? ".index-page" : ".reading-page";

  // 审校视图的「跟随」会把正文流和页列绑在一起：脚本滚页列时会被正文流拽回去
  // （实测 top→middle 连着量时 scrollTop 会弹回 0）。量图时先关掉，它只影响联动，
  // 不影响页图本身的取档与渲染。
  if (where === "review") {
    const followOn = await page.evaluate(() => {
      const chip = document.getElementById("reading-follow-chip");
      return Boolean(chip && chip.classList.contains("is-on"));
    });
    if (followOn) {
      await page.click("#reading-follow-chip", { label: "关闭跟随" });
      await waitFor(
        page,
        () => {
          const chip = document.getElementById("reading-follow-chip");
          return Boolean(chip && !chip.classList.contains("is-on"));
        },
        "关闭阅读跟随",
        15000
      );
    }
  }

  if (scroll === "middle") {
    // 打开阅读流是异步的（662 页要拼整本预览）；它完成时会把页列滚回"当前页"。
    // 所以"滚到中间 → 等图 → 再确认位置还在中间"，站不住就重来，最多 5 次。
    let settled = false;
    let lastTop = -1;
    for (let attempt = 0; attempt < 5 && !settled; attempt += 1) {
      await scrollPageColumn(page, container, tileSelector, "middle");
      await page.waitForTimeout(350);
      lastTop = await page.evaluate(
        (sel) => (document.querySelector(sel) || {}).scrollTop || 0,
        container
      );
      if (!(lastTop > 100)) continue;
      await waitVisiblePageImages(page, container, tileSelector, where, scroll);
      lastTop = await page.evaluate(
        (sel) => (document.querySelector(sel) || {}).scrollTop || 0,
        container
      );
      settled = lastTop > 100;
    }
    if (!settled) {
      throw new Error(`页列滚不到中间（scrollTop=${lastTop}）：可能被"跟随/重新打开"拽回去了`);
    }
  } else {
    await scrollPageColumn(page, container, tileSelector, "top");
    await waitVisiblePageImages(page, container, tileSelector, where, scroll);
  }

  if (args.forcePlaceholderClass) {
    // 负向自检用：给第一张可见页图加回占位类（= 高清图 + CSS blur）。
    // 只改 QA 浏览器 DOM，不碰产品代码；比例仍应 ≥1.0，但 filter 会变成 blur。
    await page.evaluate((input) => {
      const scroller = document.querySelector(input.container);
      const cRect = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: 0 };
      const tile = [...document.querySelectorAll(input.tile)].find((item) => {
        const rect = item.getBoundingClientRect();
        return rect.bottom > cRect.top && rect.top < cRect.bottom;
      });
      const image = tile && tile.querySelector("img");
      if (image) image.classList.add("is-placeholder");
    }, { container, tile: tileSelector });
  }

  if (args.forceBlur) {
    // 负向自检用：给第一张可见页图加内联 blur（模拟"高清图 + 永久模糊"）。
    // 只改 QA 浏览器 DOM，不碰产品代码；分辨率应仍是 1.66 左右，filter 变成 blur。
    await page.evaluate((input) => {
      const scroller = document.querySelector(input.container);
      const cRect = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: 0 };
      const tile = [...document.querySelectorAll(input.tile)].find((item) => {
        const rect = item.getBoundingClientRect();
        return rect.bottom > cRect.top && rect.top < cRect.bottom;
      });
      const image = tile && tile.querySelector("img");
      if (image) image.style.filter = "blur(1.5px)";
    }, { container, tile: tileSelector });
  }

  if (args.forceSize) {
    // 负向自检用：把第一张可见页图人为换成低清档，断言必须能报 FAIL。
    // 只改 QA 浏览器里的这一张图，不碰产品代码与磁盘。
    await page.evaluate((input) => {
      const scroller = document.querySelector(input.container);
      const cRect = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: 0 };
      const tile = [...document.querySelectorAll(input.tile)].find((item) => {
        const rect = item.getBoundingClientRect();
        return rect.bottom > cRect.top && rect.top < cRect.bottom;
      });
      const image = tile && tile.querySelector("img");
      if (!image) return;
      const url = new URL(image.currentSrc || image.src, location.href);
      url.searchParams.set("size", input.forceSize);
      image.src = url.href;
    }, { container, tile: tileSelector, forceSize: args.forceSize });
    await waitFor(
      page,
      (input) => {
        const scroller = document.querySelector(input.container);
        const cRect = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: 0 };
        const tiles = [...document.querySelectorAll(input.tile)].filter((tile) => {
          const rect = tile.getBoundingClientRect();
          return rect.bottom > cRect.top && rect.top < cRect.bottom;
        });
        return tiles.some((tile) => {
          const image = tile.querySelector("img");
          return Boolean(
            image && image.complete && image.naturalWidth > 0 &&
            image.currentSrc.includes(`size=${input.forceSize}`)
          );
        });
      },
      `人为换成 ${args.forceSize} 档后的图载入完成`,
      60000,
      { container, tile: tileSelector, forceSize: args.forceSize }
    );
  }

  return await page.evaluate(
    (input) => {
      const scroller = document.querySelector(input.container);
      const cRect = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: 0 };
      const dpr = window.devicePixelRatio || 1;
      const rows = [];
      for (const tile of document.querySelectorAll(input.tile)) {
        const tileRect = tile.getBoundingClientRect();
        const visible = tileRect.bottom > cRect.top && tileRect.top < cRect.bottom;
        if (!visible) continue;
        const image = tile.querySelector("img");
        if (!image) continue;
        const rect = image.getBoundingClientRect();
        const cssWidth = rect.width > 1 ? rect.width : tileRect.width;
        const src = image.currentSrc || image.src || "";
        let size = "none";
        try {
          size = new URL(src, location.href).searchParams.get("size") || "none";
        } catch (error) {
          size = "?";
        }
        const ratio = image.naturalWidth > 0 && cssWidth > 0
          ? image.naturalWidth / (cssWidth * dpr)
          : 0;
        rows.push({
          where: input.where,
          scroll: input.scroll,
          page: Number(tile.dataset.pageNo || 0),
          size,
          naturalWidth: image.naturalWidth,
          cssWidth: Math.round(cssWidth * 10) / 10,
          dpr,
          ratio: Math.round(ratio * 1000) / 1000,
          filter: getComputedStyle(image).filter || "none",
          placeholderClass: image.classList.contains("is-placeholder"),
          classes: image.className,
          ready: image.classList.contains("is-ready"),
          placeholder: image.dataset.placeholder === "1",
          src: src.slice(0, 200),
        });
      }
      return {
        where: input.where,
        scroll: input.scroll,
        dpr,
        rows,
        scrollTop: scroller ? Math.round(scroller.scrollTop) : -1,
        scrollHeight: scroller ? Math.round(scroller.scrollHeight) : -1,
        totalTiles: document.querySelectorAll(input.tile).length,
      };
    },
    { container, tile: tileSelector, where, scroll }
  );
}

async function auditMarks(page) {
  // 量化「显示≠导出」里"占位空格"这类问题的全书规模：
  // 用应用自己的差异函数算一遍，统计"渲染时会出现空 mark"的行。
  return await page.evaluate(async () => {
    const token = new URLSearchParams(location.search).get("token") || "";
    const project = typeof currentProject !== "undefined" ? currentProject : null;
    if (!project) return { error: "没有打开项目" };
    const response = await fetch(`/api/projects/${project.project_id}/review/marks`, {
      headers: { "X-B2T-Token": token },
    });
    const data = await response.json();
    const marks = data.items || [];
    let empty = 0;
    const samples = [];
    for (const mark of marks) {
      const text = mark.current || "";
      const spans = computeCharSpans(text, mark.candidate || "");
      let cursor = 0;
      for (const span of spans) {
        const range = expandToWordRange(text, span.aStart, span.aEnd);
        if (range.start < cursor) {
          cursor = Math.max(cursor, range.end);
          continue;
        }
        if (!text.slice(range.start, range.end)) {
          empty += 1;
          if (samples.length < 5) {
            samples.push({ page: mark.page_no, text, candidate: mark.candidate });
          }
        }
        cursor = Math.max(cursor, range.end);
      }
    }
    return { marks: marks.length, empty, samples };
  });
}

async function dom(page, args) {
  const selector = args.selector || "#view-pages";
  return await page.evaluate((sel) => {
    const node = document.querySelector(sel);
    return {
      found: Boolean(node),
      text: node ? (node.innerText || "").slice(0, 8000) : "",
      html: node ? node.outerHTML.slice(0, 3000) : "",
    };
  }, selector);
}

async function screenshot(page, cfg, name) {
  const path = `${cfg.screenshots}/${name}.png`;
  await page.screenshot({ path });
  return path;
}

async function stepsSnapshot(page) {
  return await page.evaluate(() => {
    const steps = [...document.querySelectorAll("button[data-workflow-step]")].map((button) => ({
      id: button.dataset.workflowStep,
      text: (button.innerText || "").replace(/\s+/g, " ").trim(),
      title: button.title || "",
      classes: button.className,
      count: (button.querySelector(".workflow-step__count") || {}).textContent || "",
    }));
    const view =
      ["library", "pages", "index", "review", "reading", "preview", "merge"].find((name) => {
        const node = document.getElementById(`view-${name}`);
        return node && !node.hidden;
      }) || null;
    const texts = {};
    const ids = [
      "workflow-current", "page-summary", "setup-summary", "setup-progress",
      "rec-status-summary", "rec-status-metrics", "rec-summary",
      "margin-verdict-line", "margin-status", "margin-fit-text", "panel-margin-page",
      "index-meta", "index-page-no", "index-jump-status",
      "reading-progress-text", "reading-page-no", "reading-draft-chip",
      "export-preflight", "export-result", "export-result-meta",
    ];
    for (const id of ids) {
      const node = document.getElementById(id);
      if (node) texts[id] = (node.innerText || "").replace(/\s+/g, " ").trim().slice(0, 600);
    }
    return {
      view,
      workflowCurrent: (document.getElementById("workflow-current") || {}).textContent || "",
      bodyStep: document.body.dataset.workflowStep || null,
      steps,
      texts,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
      checkFails: window.__b2tTextCheckFails || 0,
      segCount: document.querySelectorAll("#reading-stream .reading-seg").length,
      treeRows: document.querySelectorAll("#reading-tree .reading-tree__row").length,
    };
  });
}

// ---------------------------------------------------------------- 打开项目

async function prepare(page, cfg) {
  await page.goto(cfg.url);
  // 本机 localStorage 会记住"未提交草稿 / 缩放"等。上一轮测试失败留下的草稿
  // 会让这一轮看到"显示≠导出"（草稿本来就没写进库），所以每次 prepare 都清一次。
  // 这是隔离测试环境的"新浏览器配置"，不是伪造用户操作。
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("b2t.")) localStorage.removeItem(key);
    }
  });
  await page.reload();
  // 页面级错误收集：**"删错声明"这类 bug 不会红在任何断言上**，只会在控制台里
  // 报 ReferenceError（树渲染不出来）。prepare 时就挂上收集器，smoke 结束再读。
  await page.evaluate(() => {
    // 网络记录器：冷启要数 preview → marks → tree 的调用（只记 URL，不改行为）
    if (!window.__b2tReqLog) {
      window.__b2tReqLog = [];
      const origFetch = window.fetch;
      window.fetch = function (...a) {
        try {
          const url = typeof a[0] === "string" ? a[0] : (a[0] && a[0].url) || "";
          window.__b2tReqLog.push({ url: String(url), at: Date.now() });
        } catch (error) { /* 记录失败不影响请求 */ }
        return origFetch.apply(this, a);
      };
    }
    window.__b2tErrors = window.__b2tErrors || [];
    if (!window.__b2tErrInstalled) {
      window.__b2tErrInstalled = true;
      window.addEventListener("error", (e) => {
        window.__b2tErrors.push({ kind: "error", msg: String(e.message || ""), src: String(e.filename || ""), line: e.lineno });
      });
      window.addEventListener("unhandledrejection", (e) => {
        window.__b2tErrors.push({ kind: "rejection", msg: String((e.reason && e.reason.message) || e.reason || "") });
      });
    }
  });
  await waitFor(
    page,
    () => {
      const list = document.getElementById("project-list");
      const error = document.getElementById("library-error");
      return Boolean(list && list.querySelectorAll("li.pcard").length > 0 && (!error || error.hidden));
    },
    "项目库加载出项目卡",
    60000
  );
  const card = `#project-list li.pcard[data-project-id="${cfg.projectId}"]`;
  await waitFor(page, (sel) => Boolean(document.querySelector(sel)), "找到目标项目卡", 30000, card);
  await page.click(`${card} .pcard__actions button.btn--pri`, { label: "打开项目" });
  await waitFor(
    page,
    () => {
      const nav = document.getElementById("workflow-steps");
      return Boolean(nav && !nav.hidden && nav.querySelectorAll("button[data-workflow-step]").length >= 6);
    },
    "工作流步骤条出现",
    180000
  );
  await waitFor(
    page,
    () => {
      const tile = document.querySelector('button[data-workflow-step="recognition"]');
      return Boolean(tile && /主引擎/.test(tile.title));
    },
    "步骤条数字（finish-summary）就绪",
    180000
  );
  const sanity = await page.evaluate(() => ({
    openProject: typeof openProject,
    showView: typeof showView,
    libraryCards: document.querySelectorAll("#project-list li.pcard").length,
  }));
  if (sanity.openProject !== "function" || sanity.showView !== "function" || sanity.libraryCards < 1) {
    throw new Error(`页面没有正常加载（疑似 JS 语法/运行时错误）：${JSON.stringify(sanity)}`);
  }
  const snapshot = await stepsSnapshot(page);
  snapshot.sanity = sanity;
  snapshot.screenshot = await screenshot(page, cfg, "prepare");
  snapshot.localStorageKeys = await page.evaluate(() => Object.keys(localStorage));
  return snapshot;
}

async function ensureProject(page) {
  const ready = await page.evaluate(() => {
    const nav = document.getElementById("workflow-steps");
    return Boolean(nav && !nav.hidden && nav.querySelectorAll("button[data-workflow-step]").length >= 6);
  });
  if (!ready) throw new Error("还没打开项目：先跑 `qa.py prepare`");
}

// ---------------------------------------------------------------- 单步

async function step(page, cfg, which) {
  if (!which) throw new Error("step 命令缺少 args.step");
  await ensureProject(page);
  await dismissMasks(page);
  await page.click(`button[data-workflow-step="${which}"]`, { label: `进入步骤 ${which}` });
  const expectedView = {
    pages: "pages",
    recognition: "pages",
    margin: "pages",
    index: "index",
    review: "reading",
    export: null, // 导出是对话框，不是视图
  }[which];

  await waitFor(
    page,
    (args) => {
      const [id, view] = args;
      const button = document.querySelector(`button[data-workflow-step="${id}"]`);
      if (!button || !button.classList.contains("is-current")) return false;
      if (id === "export") {
        const panel = document.getElementById("export-panel");
        return Boolean(panel && !panel.hidden);
      }
      const node = document.getElementById(`view-${view}`);
      return Boolean(node && !node.hidden);
    },
    `进入步骤 ${which}（视图 ${expectedView || "export"}）`,
    60000,
    [which, expectedView]
  );

  if (which === "review") {
    await waitFor(
      page,
      () => document.querySelectorAll("#reading-stream .reading-seg").length > 0,
      "阅读流渲染出段落",
      180000
    );
    await waitFor(
      page,
      () => {
        const text = document.getElementById("reading-progress-text");
        return Boolean(text && /已审/.test(text.innerText) && text.innerText !== "已审 0 / 0 字");
      },
      "阅读进度计数就绪",
      120000
    ).catch(() => {});
  }
  if (which === "export") {
    await waitFor(
      page,
      () => {
        const node = document.getElementById("export-preflight");
        return Boolean(node && (node.innerText || "").trim().length > 0);
      },
      "导出预检结果就绪",
      120000
    );
  }
  if (which === "pages" || which === "recognition" || which === "margin") {
    await waitFor(
      page,
      () => {
        const node = document.getElementById("page-summary");
        return Boolean(node && (node.innerText || "").trim().length > 0);
      },
      "页面摘要就绪",
      60000
    );
  }
  if (which === "index") {
    await waitFor(
      page,
      () => {
        const node = document.getElementById("index-meta");
        const text = node ? (node.innerText || "").trim() : "";
        return Boolean(text && !text.includes("正在"));
      },
      "目录视图数据就绪",
      60000
    );
  }

  const snapshot = await stepsSnapshot(page);
  snapshot.screenshot = await screenshot(page, cfg, `step-${which}`);
  return snapshot;
}

// ---------------------------------------------------------------- 阅读流

/**
 * 单次跳转的高亮验证：走 gotoReadingEntry（下一处未审），确认
 * 面板开了 + readingPanelKey 非空 + 目标行带 is-current（500ms 后）。
 */
async function highlightProbe(page, maxJumps = 28) {
  await ensureReading(page);
  const rows = [];
  for (let i = 0; i < maxJumps; i += 1) {
    await page.click("#reading-next-unreviewed", { label: `下一处未审 ${i + 1}` });
    await page
      .waitForFunction(
        () => {
          const head = document.querySelector(".reading-panel__head strong");
          const label = document.getElementById("reading-page-no");
          if (!head || !label) return false;
          const panel = Number(((head.textContent || "").match(/第\s*(\d+)\s*页/) || [0, 0])[1]) || null;
          const top = Number(((label.textContent || "").match(/(\d+)/) || [0, 0])[1]) || null;
          return panel !== null && top === panel;
        },
        undefined,
        { timeout: 4000 }
      )
      .catch(() => {});
    // 记 is-current 出现需要几帧（从点击后开始数，上限 120 帧）
    const frameInfo = await page.evaluate(async () => {
      return await new Promise((resolve) => {
        let frames = 0;
        const tick = () => {
          frames += 1;
          const panel = document.querySelector(".reading-panel");
          const key = panel ? panel.dataset.key : null;
          const target = key ? document.querySelector(`#reading-stream .reading-line[data-key="${key}"]`) : null;
          if (target && target.classList.contains("is-current")) return resolve({ frames, ok: true });
          if (frames >= 120) return resolve({ frames, ok: false });
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    });
    await page.waitForTimeout(200);
    const row = await page.evaluate((index) => {
      const panel = document.querySelector(".reading-panel");
      const head = document.querySelector(".reading-panel__head strong");
      const pageNo = head
        ? Number(((head.textContent || "").match(/第\s*(\d+)\s*页/) || [0, 0])[1]) || null
        : null;
      const key = panel ? panel.dataset.key || null : null;
      const currentLines = [...document.querySelectorAll("#reading-stream .reading-line.is-current")];
      const target = key ? document.querySelector(`#reading-stream .reading-line[data-key="${key}"]`) : null;
      const segCount = document.querySelectorAll("#reading-stream .reading-seg").length;
      return {
        index: index + 1,
        pageNo,
        panelOpen: Boolean(panel),
        panelKey: key,
        currentLines: currentLines.length,
        targetExists: Boolean(target),
        targetCurrent: Boolean(target && target.classList.contains("is-current")),
        targetClass: target ? target.className : null,
        readingRendered: typeof readingRendered !== "undefined" ? readingRendered : null,
        segCount,
        log0: (window.__b2tNextLog || [])[0] || null,
      };
    }, i);
    row.framesToCurrent = frameInfo.frames;
    row.frameTimeout = !frameInfo.ok;
    rows.push(row);
    if (row.pageNo !== null && row.pageNo >= 174) break;
  }
  return rows;
}

/**
 * 页码守卫三段探针（任务 88 第三版：只挡"跳转落位中"的写入）。
 *
 * 1. 跳转不漂：连按「下一处未审」直到进第 142 页；落位后 500ms 与 +1.5s 各测一次
 * 2. 滚一页要跟：面板开着滚到相邻页 143，顶部必须变成 143
 * 3. 滚多页继续跟：144 / 146；held 只在跳转那次涨、之后不涨，escape 必须为 0
 *
 * 每一段都记锚点行的 data-page 与 mark 是否存在——滚完要能分清"守卫挡了"还是"锚点没到"。
 */
async function pinGuard(page, args) {
  const target = args.targetPage || 142;
  const maxJumps = args.maxJumps || 240;
  await ensureReading(page);

  const read = () =>
    page.evaluate(() => {
      const stream = document.getElementById("reading-stream");
      if (!stream) return { error: "没有 #reading-stream" };
      const rect = stream.getBoundingClientRect();
      const labelNode = document.getElementById("reading-page-no");
      const label = labelNode
        ? Number(((labelNode.textContent || "").match(/(\d+)/) || [0, 0])[1]) || null
        : null;

      // 与应用 onReadingScroll 同一个锚点：正文流视口 35% 处那一行。
      const anchor = rect.top + stream.clientHeight * 0.35;
      let anchorLine = null;
      for (const item of stream.querySelectorAll(".reading-line")) {
        const r = item.getBoundingClientRect();
        if (r.bottom >= anchor) {
          anchorLine = {
            key: item.dataset.key || null,
            page: Number(item.dataset.page) || null,
            top: Math.round(r.top - rect.top),
            mark: Boolean(readingMarks.get(item.dataset.key)),
          };
          break;
        }
      }

      const panel = document.querySelector(".reading-panel");
      const panelKey = panel ? panel.dataset.key || null : null;
      const head = document.querySelector(".reading-panel__head strong");
      const panelPage = head
        ? Number(((head.textContent || "").match(/第\s*(\d+)\s*页/) || [0, 0])[1]) || null
        : null;
      const panelLine = panelKey
        ? stream.querySelector(`.reading-line[data-key="${panelKey}"]`)
        : null;
      let panelLineTop = null;
      let panelLineIn = false;
      if (panelLine) {
        const pr = panelLine.getBoundingClientRect();
        panelLineTop = Math.round(pr.top - rect.top);
        panelLineIn = pr.bottom > rect.top && pr.top < rect.bottom;
      }

      const scroller = document.getElementById("reading-pdf-scroll");
      let dominant = null;
      if (scroller) {
        const sRect = scroller.getBoundingClientRect();
        let best = null;
        for (const tile of scroller.querySelectorAll(".reading-page")) {
          const tr = tile.getBoundingClientRect();
          const overlap = Math.min(tr.bottom, sRect.bottom) - Math.max(tr.top, sRect.top);
          if (overlap > 0 && (!best || overlap > best.overlap)) {
            best = { page: Number(tile.dataset.pageNo), overlap };
          }
        }
        if (best) dominant = best.page;
      }

      const pin = window.__b2tPagePin || null;
      const settleKey = typeof readingJumpSettleKey !== "undefined" ? readingJumpSettleKey : "n/a";
      const settleTicks = typeof readingJumpSettleTicks !== "undefined" ? readingJumpSettleTicks : "n/a";
      return {
        scrollTop: Math.round(stream.scrollTop),
        maxScroll: Math.round(stream.scrollHeight - stream.clientHeight),
        label,
        labelText: labelNode ? labelNode.textContent.replace(/\s+/g, "") : null,
        anchorKey: anchorLine ? anchorLine.key : null,
        anchorPage: anchorLine ? anchorLine.page : null,
        anchorTop: anchorLine ? anchorLine.top : null,
        anchorMark: anchorLine ? anchorLine.mark : null,
        panelPage,
        panelKey,
        panelLineExists: Boolean(panelLine),
        panelLineTop,
        panelLineIn,
        dominant,
        panelVisible: Boolean(panel && panel.getBoundingClientRect().height > 0),
        currentLines: document.querySelectorAll("#reading-stream .reading-line.is-current").length,
        currentMarks: document.querySelectorAll("#reading-stream .reading-mark.is-current").length,
        settleKey,
        settleTicks,
        pin: pin ? { held: pin.held, escape: pin.escape } : null,
      };
    });

  // ---------------------------------------------------------------- 1. 跳转不漂
  let jumps = 0;
  let landing = null;
  const jumpRows = [];
  let prevPanel = null;
  while (jumps < maxJumps) {
    await page.click("#reading-next-unreviewed", { label: `下一处未审 ${jumps + 1}` });
    jumps += 1;
    // 只等"面板页变了"（最多 1.2s）：这是跳转真的推进了的可观测证据。
    // 不要在这里等 label==panel —— 守卫冻住页码时那一等就是 3 秒，几十次点击会把整个探针拖超时。
    await page
      .waitForFunction(
        (prev) => {
          const head = document.querySelector(".reading-panel__head strong");
          if (!head) return false;
          const panel = Number(((head.textContent || "").match(/第\s*(\d+)\s*页/) || [0, 0])[1]) || null;
          return panel !== null && panel !== prev;
        },
        prevPanel,
        { timeout: 1200 }
      )
      .catch(() => {});
    await page.waitForTimeout(120);
    const now = await read();
    prevPanel = now.panelPage;
    jumpRows.push({
      n: jumps,
      panelPage: now.panelPage,
      label: now.label,
      dominant: now.dominant,
      anchorPage: now.anchorPage,
      scrollTop: now.scrollTop,
      panelLineTop: now.panelLineTop,
      at: Date.now(),
    });
    if (now.panelPage === target) {
      landing = now;
      break;
    }
    // 已经越过目标页：这本队列是按页向前推进的，别再无意义地消耗
    if (now.panelPage !== null && now.panelPage > target) break;
  }
  if (!landing) {
    return { target, jumps, jumpRows, error: "没跳到目标页", last: await read() };
  }
  await page.waitForTimeout(500);
  const at500 = await read();
  await page.waitForTimeout(1500);
  const at1500 = await read();

  // ---------------------------------------------------------------- 2/3. 滚着跟
  const box = await page.evaluate(() => {
    const stream = document.getElementById("reading-stream");
    const rect = stream.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(box.x, box.y, { label: "移到正文流上" });

  const scrollToPage = async (wantPage) => {
    let last = await read();
    for (let i = 0; i < 60; i += 1) {
      if (last.anchorPage !== null && last.anchorPage >= wantPage) break;
      await page.mouse.wheel(0, 240, { label: `滚正文流到第 ${wantPage} 页` });
      await page.waitForTimeout(160);
      const next = await read();
      if (next.scrollTop === last.scrollTop) {
        last = next;
        break;
      }
      last = next;
    }
    // 等"顶部页码追上锚点"（应用自己写，最多 1.5s），再量稳态
    await page
      .waitForFunction(
        () => {
          const stream = document.getElementById("reading-stream");
          if (!stream) return false;
          const rect = stream.getBoundingClientRect();
          const anchor = rect.top + rect.height * 0.35;
          for (const item of stream.querySelectorAll(".reading-line")) {
            const r = item.getBoundingClientRect();
            if (r.bottom >= anchor) {
              const label = document.getElementById("reading-page-no");
              const top = label
                ? Number(((label.textContent || "").match(/(\d+)/) || [0, 0])[1]) || null
                : null;
              return top !== null && Math.abs(top - (Number(item.dataset.page) || 0)) <= 1;
            }
          }
          return false;
        },
        undefined,
        { timeout: 1500 }
      )
      .catch(() => {});
    await page.waitForTimeout(400);
    return await read();
  };

  const step143 = await scrollToPage(target + 1);
  const step144 = await scrollToPage(target + 2);
  const step146 = await scrollToPage(target + 4);

  return { target, jumps, jumpRows, landing, at500, at1500, step143, step144, step146 };
}

/**
 * 只记数据的"滚正文流"探针：面板开着，先上滚留出余量，再按 400px 往下滚，
 * 每步记 顶部 / 锚点行页 / 面板页 / 左栏主导 / pin。不做判定（DevLead 要用来定性）。
 */
async function scrollFollow(page, args) {
  const stepPx = args.step || 400;
  const steps = args.steps || 8;
  const upPx = args.up || 1600;
  await ensureReading(page);
  await ensurePanelOpen(page);
  await page.waitForTimeout(400);

  const read = () =>
    page.evaluate(() => {
      const stream = document.getElementById("reading-stream");
      const rect = stream.getBoundingClientRect();
      const labelNode = document.getElementById("reading-page-no");
      const label = labelNode
        ? Number(((labelNode.textContent || "").match(/(\d+)/) || [0, 0])[1]) || null
        : null;
      const anchor = rect.top + rect.height * 0.35;
      let anchorLine = null;
      for (const item of stream.querySelectorAll(".reading-line")) {
        const r = item.getBoundingClientRect();
        if (r.bottom >= anchor) {
          anchorLine = { key: item.dataset.key || null, page: Number(item.dataset.page) || null };
          break;
        }
      }
      const panel = document.querySelector(".reading-panel");
      const head = document.querySelector(".reading-panel__head strong");
      const panelPage = head
        ? Number(((head.textContent || "").match(/第\s*(\d+)\s*页/) || [0, 0])[1]) || null
        : null;
      const scroller = document.getElementById("reading-pdf-scroll");
      let dominant = null;
      if (scroller) {
        const sRect = scroller.getBoundingClientRect();
        let best = null;
        for (const tile of scroller.querySelectorAll(".reading-page")) {
          const tr = tile.getBoundingClientRect();
          const overlap = Math.min(tr.bottom, sRect.bottom) - Math.max(tr.top, sRect.top);
          if (overlap > 0 && (!best || overlap > best.overlap)) best = { page: Number(tile.dataset.pageNo) };
        }
        if (best) dominant = best.page;
      }
      const pin = window.__b2tPagePin || null;
      return {
        scrollTop: Math.round(stream.scrollTop),
        maxScroll: Math.round(stream.scrollHeight - stream.clientHeight),
        label,
        labelText: labelNode ? labelNode.textContent.replace(/\s+/g, "") : null,
        anchorPage: anchorLine ? anchorLine.page : null,
        anchorKey: anchorLine ? anchorLine.key : null,
        mark: anchorLine ? Boolean(readingMarks.get(anchorLine.key)) : null,
        panelPage,
        dominant,
        currentLines: document.querySelectorAll("#reading-stream .reading-line.is-current").length,
        pin: pin ? { held: pin.held, escape: pin.escape } : null,
        settleKey: typeof readingJumpSettleKey !== "undefined" ? readingJumpSettleKey : "n/a",
      };
    });

  const box = await page.evaluate(() => {
    const stream = document.getElementById("reading-stream");
    const rect = stream.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(box.x, box.y, { label: "移到正文流上" });

  const base = await read();
  if (upPx) {
    await page.mouse.wheel(0, -upPx, { label: `正文流上滚 ${upPx}px` });
    await page.waitForTimeout(400);
  }
  const afterUp = await read();
  const rows = [afterUp];
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, stepPx, { label: `正文流下滚 ${stepPx}px（第 ${i + 1} 次）` });
    await page.waitForTimeout(450);
    const row = await read();
    rows.push(row);
    if (row.scrollTop === rows[rows.length - 2].scrollTop) break;
  }
  return { base, rows, stepPx };
}

/** 审校视图的"数据层"状态：marks 窗口、mark 页范围、正文流片段数。定位 TRE E 路径没标记用。 */
async function reviewState(page) {
  return await page.evaluate(() => {
    const stream = document.getElementById("reading-stream");
    const pages = typeof readingMarks !== "undefined" ? [...readingMarks.values()].map((m) => m.page_no) : [];
    const label = (document.getElementById("reading-page-no") || {}).textContent || "";
    return {
      label: label.replace(/\s+/g, ""),
      filter: typeof readingFilter !== "undefined" ? readingFilter : "n/a",
      marksMapSize: typeof readingMarks !== "undefined" ? readingMarks.size : "n/a",
      markPages: pages.length ? [Math.min(...pages), Math.max(...pages)] : null,
      marksWindow: typeof readingMarksWindow !== "undefined" ? readingMarksWindow : "n/a",
      entries: typeof readingEntries !== "undefined" ? readingEntries.length : "n/a",
      visibleSegments: typeof readingVisibleSegments === "function" ? readingVisibleSegments().length : "n/a",
      segs: document.querySelectorAll("#reading-stream .reading-seg").length,
      lines: document.querySelectorAll("#reading-stream .reading-line").length,
      marksInDom: document.querySelectorAll("#reading-stream .reading-mark").length,
      panelKey: (document.querySelector(".reading-panel") || {}).dataset
        ? document.querySelector(".reading-panel").dataset.key || null
        : null,
      scrollTop: stream ? Math.round(stream.scrollTop) : null,
      scrollHeight: stream ? Math.round(stream.scrollHeight) : null,
    };
  });
}

/** 给 #reading-page-no 挂写入钩子：每次 textContent 被写都记调用栈与当时状态。 */
async function labelWatch(page) {
  return await page.evaluate(() => {
    if (window.__labelWatchInstalled) return { installed: true, reused: true };
    const node = document.getElementById("reading-page-no");
    if (!node) return { installed: false, reason: "没有 #reading-page-no" };
    const desc = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
    window.__labelWrites = [];
    Object.defineProperty(node, "textContent", {
      configurable: true,
      get() {
        return desc.get.call(this);
      },
      set(value) {
        const stream = document.getElementById("reading-stream");
        window.__labelWrites.push({
          value: String(value).replace(/\s+/g, ""),
          at: Date.now(),
          stack: (new Error().stack || "").split("\n").slice(1, 8).map((l) => l.trim()),
          pageNo: typeof readingPageNo !== "undefined" ? readingPageNo : null,
          driver: typeof readingSyncDriver !== "undefined" ? readingSyncDriver : null,
          until: typeof readingSyncUntil !== "undefined" ? Math.round(readingSyncUntil) : null,
          now: Math.round(performance.now()),
          settleKey: typeof readingJumpSettleKey !== "undefined" ? readingJumpSettleKey : null,
          userSeq: typeof readingUserScrollSeq !== "undefined" ? readingUserScrollSeq : null,
          programSeq: typeof readingProgramScrollSeq !== "undefined" ? readingProgramScrollSeq : null,
          pin: window.__b2tPagePin ? { held: window.__b2tPagePin.held, escape: window.__b2tPagePin.escape } : null,
          scrollTop: stream ? Math.round(stream.scrollTop) : null,
          scrollHeight: stream ? Math.round(stream.scrollHeight) : null,
        });
        if (window.__labelWrites.length > 400) window.__labelWrites.splice(0, 200);
        return desc.set.call(this, value);
      },
    });
    window.__labelWatchInstalled = true;
    return { installed: true };
  });
}

async function labelWrites(page) {
  return await page.evaluate(() => window.__labelWrites || []);
}

/** 重置诊断：读阅读态是"重开项目"还是"只重画流"。 */
async function resetDiag(page) {
  return await page.evaluate(() => {
    const segs = typeof readingData !== "undefined" && readingData && readingData.segments
      ? readingData.segments.length : null;
    const label = (document.getElementById("reading-page-no") || {}).textContent || "";
    return {
      resetDiag: true,
      readingProject: typeof readingProject !== "undefined" ? readingProject : "n/a",
      currentProjectId: typeof currentProject !== "undefined" && currentProject ? currentProject.project_id : "n/a",
      readingAutoJumpDone: typeof readingAutoJumpDone !== "undefined" ? readingAutoJumpDone : "n/a",
      readingDataSegments: segs,
      readingPanelKey: typeof readingPanelKey !== "undefined" ? readingPanelKey : "n/a",
      readingPendingPanelKey: typeof readingPendingPanelKey !== "undefined" ? readingPendingPanelKey : "n/a",
      readingPendingPanelEntry: typeof readingPendingPanelEntry !== "undefined" && readingPendingPanelEntry
        ? readingPendingPanelEntry.block_id : "n/a",
      panelInHost: Boolean(document.querySelector("#reading-panel-host .reading-panel")),
      panelHead: (document.querySelector(".reading-panel__head strong") || {}).textContent || null,
      label: label.replace(/\s+/g, ""),
      readingEntries: typeof readingEntries !== "undefined" ? readingEntries.length : "n/a",
      marksWindow: typeof readingMarksWindow !== "undefined" ? readingMarksWindow : "n/a",
      streamSegs: document.querySelectorAll("#reading-stream .reading-seg").length,
    };
  });
}

/**
 * 连按压力探针：一直按到 90+ 次或连续 3 次零推进，每步记
 *  - 主线程是否活着（rAF 心跳是否前进、performance.now 是否前进）
 *  - 点击是否到达元素（捕获阶段计数）
 *  - handler 是否写日志（__b2tNextLog 条目数）
 *  - 目标行是否在 readingEntries / DOM 里
 */
async function stressNext(page, args) {
  const maxPresses = args.presses || 120;
  const stallLimit = args.stalls || 3;
  await ensureReading(page);
  await page.evaluate(() => {
    window.__b2tClickHits = 0;
    window.__b2tRafCount = 0;
    const btn = document.getElementById("reading-next-unreviewed");
    if (btn && !btn.__b2tCounted) {
      btn.addEventListener("click", () => { window.__b2tClickHits += 1; }, true);
      btn.__b2tCounted = true;
    }
    const tick = () => { window.__b2tRafCount += 1; requestAnimationFrame(tick); };
    if (!window.__b2tRafStarted) { window.__b2tRafStarted = true; requestAnimationFrame(tick); }
  });

  const read = () =>
    page.evaluate(() => {
      const s = (el) => (document.getElementById(el) || {}).textContent || "";
      const panel = document.querySelector(".reading-panel");
      const head = document.querySelector(".reading-panel__head strong");
      const key = panel ? panel.dataset.key || null : null;
      const line = key
        ? document.querySelector(`#reading-stream .reading-line[data-key="${key}"]`)
        : null;
      const inEntries = key && typeof readingEntries !== "undefined"
        ? readingEntries.some((e) => `${e.block_id}:${e.line_index}` === key)
        : null;
      const inMarks = key && typeof readingMarks !== "undefined"
        ? readingMarks.has(key)
        : null;
      return {
        label: s("reading-page-no").replace(/\s+/g, ""),
        panelPage: head ? (head.textContent.match(/第\s*(\d+)\s*页/) || [])[1] || null : null,
        panelKey: key,
        targetExists: Boolean(line),
        targetInEntries: inEntries,
        targetInMarks: inMarks,
        currentLines: document.querySelectorAll("#reading-stream .reading-line.is-current").length,
        rafCount: window.__b2tRafCount || 0,
        clickHits: window.__b2tClickHits || 0,
        nextLogLen: (window.__b2tNextLog || []).length,
        nextLogAt: (window.__b2tNextLog || [])[0] ? window.__b2tNextLog[0].at : null,
        now: Math.round(performance.now()),
        entries: typeof readingEntries !== "undefined" ? readingEntries.length : null,
        marksWindow: typeof readingMarksWindow !== "undefined" ? readingMarksWindow : null,
        settleKey: typeof readingJumpSettleKey !== "undefined" ? readingJumpSettleKey : null,
      };
    });

  const rows = [];
  let stalls = 0;
  for (let i = 1; i <= maxPresses; i += 1) {
    const before = await read();
    let clickError = null;
    try {
      await page.click("#reading-next-unreviewed", { label: `下一处未审（压力 ${i}）` });
    } catch (error) {
      clickError = String(error).slice(0, 200);
    }
    await page.waitForTimeout(450);
    const after = await read();
    const advanced = after.label !== before.label || after.panelKey !== before.panelKey
      || after.panelPage !== before.panelPage;
    const row = {
      i,
      label: after.label,
      panelPage: after.panelPage,
      panelKey: after.panelKey,
      advanced,
      clickError,
      rafDelta: after.rafCount - before.rafCount,
      nowDelta: after.now - before.now,
      clickHits: after.clickHits,
      nextLogLen: after.nextLogLen,
      logAt: after.nextLogAt,
      targetExists: after.targetExists,
      targetInEntries: after.targetInEntries,
      targetInMarks: after.targetInMarks,
      currentLines: after.currentLines,
      entries: after.entries,
      marksWindow: after.marksWindow,
      settleKey: after.settleKey,
    };
    rows.push(row);
    if (!advanced) {
      stalls += 1;
      if (stalls >= stallLimit) break;
    } else {
      stalls = 0;
    }
  }
  return { rows, last: rows[rows.length - 1] };
}

/** 性能探针：idle 时测 1s 的 rAF 帧数（判断是否被后台节流）+ 长任务统计。 */
async function perfProbe(page, args) {
  const ms = args.ms || 1000;
  await page.evaluate(() => {
    window.__longTasks = window.__longTasks || [];
    if (!window.__longTaskObserver) {
      try {
        window.__longTaskObserver = new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__longTasks.push(Math.round(e.duration));
        });
        window.__longTaskObserver.observe({ entryTypes: ["longtask"] });
      } catch (error) {
        window.__longTaskObserver = null;
      }
    }
  });
  const idle = await page.evaluate(async (duration) => {
    let frames = 0;
    const start = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        frames += 1;
        if (performance.now() - start >= duration) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    return { frames, elapsed: Math.round(performance.now() - start), visibility: document.visibilityState };
  }, ms);
  // 长任务：清空后再按 10 次「下一处未审」
  const before = await page.evaluate(() => {
    window.__longTasks = [];
    return (window.__b2tNextLog || []).length;
  });
  for (let i = 0; i < 10; i += 1) {
    await page.click("#reading-next-unreviewed", { label: `性能采样 ${i + 1}` }).catch(() => {});
    await page.waitForTimeout(300);
  }
  const longTasks = await page.evaluate(() => window.__longTasks.slice(0, 40));
  return { idle, longTasks, visibility: idle.visibility, before };
}

/** 主线程工作量：CDP Performance.getMetrics，按 20 次点击取 TaskDuration 等增量。 */
async function taskMetrics(page, args) {
  const presses = args.presses || 20;
  const keys = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"];
  const readMetrics = async () => {
    const out = await page.cdp("Performance.getMetrics");
    const map = {};
    for (const item of (out && out.metrics) || []) map[item.name] = item.value;
    return map;
  };
  await page.cdp("Performance.enable");
  const before = await readMetrics();
  const logBefore = await page.evaluate(() => (window.__b2tNextLog || []).length);
  const atBefore = await page.evaluate(() => (window.__b2tNextLog || [])[0]
    ? window.__b2tNextLog[0].at : null);
  for (let i = 0; i < presses; i += 1) {
    await page.click("#reading-next-unreviewed", { label: `主线程采样 ${i + 1}` }).catch(() => {});
    await page.waitForTimeout(300);
  }
  const after = await readMetrics();
  const delta = {};
  for (const key of keys) delta[key] = Math.round(((after[key] || 0) - (before[key] || 0)) * 1000) / 1000;
  const afterLog = await page.evaluate(() => ({
    len: (window.__b2tNextLog || []).length,
    at: (window.__b2tNextLog || [])[0] ? window.__b2tNextLog[0].at : null,
  }));
  return { presses, delta, perPress: Object.fromEntries(
    Object.entries(delta).map(([k, v]) => [k, Math.round((v / presses) * 1000) / 1000])
  ), logBefore, atBefore, afterLog };
}

/** 任务 91 审校页改版：一次取全布局/下区/裁切/编辑态/进度的快照。 */
async function dockSnapshotRaw() {
  const rect = (sel) => {
    const node = document.querySelector(sel);
    if (!node) return null;
    const r = node.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const text = (sel) => {
    const node = document.querySelector(sel);
    return node ? (node.textContent || "").replace(/\s+/g, " ").trim() : null;
  };
  const cropEl = document.getElementById("reading-dock-crop");
  let crop = null;
  try {
    crop = cropEl && cropEl.dataset.crop ? JSON.parse(cropEl.dataset.crop) : null;
  } catch (error) {
    crop = { parseError: String(error) };
  }
  const dock = document.getElementById("reading-dock");
  const host = document.getElementById("reading-panel-host");
  const panel = document.querySelector(".reading-panel");
  const editingKey = typeof readingEditingKey !== "undefined" ? readingEditingKey : null;
  const editNode = editingKey
    ? document.querySelector(`#reading-stream .reading-line[data-key="${editingKey}"]`)
    : null;
  const cur = document.querySelector("#reading-stream .reading-line.is-current");
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    heights: {
      topbar: rect(".topbar"), toolbar: rect(".reading-toolbar"),
      split: rect("#reading-split"), dock: rect("#reading-dock"),
      dockGrip: rect("#reading-dock-grip"), host: rect("#reading-panel-host"),
      tree: rect("#reading-tree"), pdf: rect(".reading-pdf"),
      stream: rect("#reading-stream"), dockHidden: Boolean(dock && dock.hidden),
      hostParent: host && host.parentElement ? host.parentElement.id || host.parentElement.className : null,
    },
    dock: {
      where: text("#reading-dock-where"), level: text("#reading-dock-level"),
      count: text("#reading-dock-count"), hidden: Boolean(dock && dock.hidden),
      collapseTitle: (document.getElementById("reading-dock-collapse") || {}).title || null,
    },
    crop: { plan: (window.__b2tCropPlan || null), attr: crop, bg: cropEl ? cropEl.style.backgroundImage.slice(0, 80) : null },
    panel: {
      key: panel ? panel.dataset.key || null : null,
      page: text(".reading-panel__head strong"),
      candidate: text(".reading-panel__candidate"),
    },
    progress: text("#reading-progress-text"),
    label: text("#reading-page-no"),
    dominant: (() => {
      const sc = document.getElementById("reading-pdf-scroll");
      if (!sc) return null;
      const sr = sc.getBoundingClientRect();
      let best = null;
      for (const tile of sc.querySelectorAll(".reading-page")) {
        const tr = tile.getBoundingClientRect();
        const overlap = Math.min(tr.bottom, sr.bottom) - Math.max(tr.top, sr.top);
        if (overlap > 0 && (!best || overlap > best.overlap)) best = { page: Number(tile.dataset.pageNo), overlap };
      }
      return best ? best.page : null;
    })(),
    notice: text("#auto-apply-notice-text"),
    noticeHidden: (document.getElementById("auto-apply-notice") || {}).hidden ?? null,
    edit: {
      key: editingKey,
      nodeExists: Boolean(editNode),
      contenteditable: editNode ? editNode.getAttribute("contenteditable") : null,
      text: editNode ? editNode.textContent : null,
    },
    currentLine: cur ? cur.dataset.key || null : null,
    drafts: typeof readingDrafts !== "undefined" ? readingDrafts.size : null,
    inlineEdits: typeof readingInlineEdits !== "undefined" ? readingInlineEdits.size : null,
    entriesDone: typeof readingEntries !== "undefined"
      ? readingEntries.filter((e) => typeof readingEntryDone === "function" && readingEntryDone(e)).length
      : null,
    treeRail: rect("#reading-tree-rail"),
    splitClass: (document.getElementById("reading-split") || {}).className || null,
    splitStyle: (document.getElementById("reading-split") || {}).getAttribute
      ? document.getElementById("reading-split").getAttribute("style") : null,
    railExists: Boolean(document.getElementById("reading-tree-rail")),
    railHidden: (document.getElementById("reading-tree-rail") || {}).hidden ?? null,
    innerHeight: window.innerHeight,
    prefs: { dock: localStorage.getItem("b2t.readingDock.v1"), tree: localStorage.getItem("b2t.readingTree.v1") },
    shot: null,
  };
}

/** mode=snapshot：只读一次快照；mode=keys：按给定键序列，记录每次前后。 */
async function dockProbe(page, args) {
  const mode = args.mode || "snapshot";
  if (args.viewport) {
    await page.cdp("Emulation.setDeviceMetricsOverride", {
      width: args.viewport.w, height: args.viewport.h, deviceScaleFactor: 2, mobile: false,
    });
    await page.waitForTimeout(250);
  }
  if (mode === "grip") {
    const box = await page.evaluate(() => {
      const g = document.getElementById("reading-dock-grip");
      if (!g) return null;
      const r = g.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (!box) throw new Error("没有 #reading-dock-grip");
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    await page.mouse.move(box.x, box.y + (args.dy || 0), { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    return { snap: await page.evaluate(dockSnapshotRaw) };
  }
  if (mode === "grip_dblclick") {
    const box = await page.evaluate(() => {
      const g = document.getElementById("reading-dock-grip");
      if (!g) return null;
      const r = g.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.click(box.x, box.y, { clickCount: 1 });
    await page.mouse.click(box.x, box.y, { clickCount: 2 });
    await page.waitForTimeout(450);
    return { snap: await page.evaluate(dockSnapshotRaw) };
  }
  if (mode === "reload") {
    await page.reload();
    await page.waitForTimeout(1200);
    return { snap: await page.evaluate(dockSnapshotRaw) };
  }
  if (mode === "clear_prefs") {
    const removed = await page.evaluate(() => {
      const keys = ["b2t.readingDock.v1", "b2t.readingTree.v1"];
      const had = keys.map((k) => [k, localStorage.getItem(k)]);
      for (const k of keys) localStorage.removeItem(k);
      return had;
    });
    return { removed };
  }
  if (mode === "click_rail") {
    const box = await page.evaluate(() => {
      const rail = document.getElementById("reading-tree-rail");
      if (!rail || rail.hidden) return null;
      const r = rail.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + 40 };
    });
    if (!box) return { railClick: "no-rail" };
    await page.mouse.click(box.x, box.y, { label: "点左树窄条" });
    await page.waitForTimeout(500);
    return { railClick: "clicked", snap: await page.evaluate(dockSnapshotRaw) };
  }
  if (mode === "toggle_tree") {
    await page.click("#reading-tree-toggle", { label: "收起/展开左树" });
    await page.waitForTimeout(500);
    return { snap: await page.evaluate(dockSnapshotRaw) };
  }
  // dockSnapshotRaw 是自包含函数，直接交给 page.evaluate 序列化执行
  const read = async () => await page.evaluate(dockSnapshotRaw);
  if (mode === "snapshot") return { snap: await read() };
  const keys = args.keys || [{ key: "Enter" }];
  const rows = [];
  for (let i = 0; i < keys.length; i += 1) {
    const spec = keys[i];
    const before = await read();
    if (spec.modifiers) {
      for (const mod of spec.modifiers) await page.keyboard.down(mod);
    }
    await page.keyboard.press(spec.key);
    if (spec.modifiers) {
      for (const mod of spec.modifiers.slice().reverse()) await page.keyboard.up(mod);
    }
    await page.waitForTimeout(spec.wait || 700);
    const after = await read();
    rows.push({ i: i + 1, spec, before, after });
  }
  return { rows, snap: await read() };
}

/** B 组：连按下一处并采每条的裁窗数据（data-crop / plan / mark.bbox / 公式重算）。 */
async function cropProbe(page, args) {
  const n = args.n || 20;
  await ensureReading(page);
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    await page.click("#reading-next-unreviewed", { label: `采样第 ${i + 1} 条` }).catch(() => {});
    await page.waitForTimeout(850);
    const row = await page.evaluate(() => {
      const cropEl = document.getElementById("reading-dock-crop");
      let attr = null;
      try { attr = cropEl && cropEl.dataset.crop ? JSON.parse(cropEl.dataset.crop) : null; } catch (e) { attr = String(e); }
      const panel = document.querySelector(".reading-panel");
      const key = panel ? panel.dataset.key || null : null;
      const mark = key && typeof readingMarks !== "undefined" ? readingMarks.get(key) : null;
      const plan = window.__b2tCropPlan || null;
      let expected = null;
      if (plan && plan.gap) {
        const contentH = Math.max(60, (cropEl ? cropEl.clientHeight : 182) - 16);
        const pageRec = typeof readingPageRecord === "function" ? readingPageRecord(plan.pageNo) : null;
        const aspect = pageRec && pageRec.width_pt
          ? Number(pageRec.height_pt || 792) / Number(pageRec.width_pt || 612) : 792 / 612;
        expected = {
          contentH,
          aspect: Math.round(aspect * 10000) / 10000,
          w: (404 * plan.rows * plan.gap * aspect) / contentH,
          h: plan.rows * plan.gap,
        };
      }
      return {
        key,
        panelPage: panel ? (panel.querySelector(".reading-panel__head strong") || {}).textContent || null : null,
        level: panel ? (panel.querySelector(".reading-panel__head strong") || {}).textContent || null : null,
        cropAttr: attr,
        plan,
        markBbox: mark && mark.bbox ? mark.bbox : null,
        markLevel: mark ? mark.level : null,
        markPage: mark ? mark.page_no : null,
        expected,
        cropElHeight: cropEl ? cropEl.clientHeight : null,
        bg: cropEl ? cropEl.style.backgroundImage.slice(0, 60) : null,
        emptyText: cropEl ? (cropEl.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60) : null,
      };
    });
    rows.push({ i: i + 1, ...row });
  }
  return { rows };
}

/** 捕获页面 JS 错误（openReadingPanel 中途抛异常时，面板会挂上但裁图不画）。 */
async function errorWatch(page, args) {
  const mode = args.mode || "install";
  if (mode === "install") {
    const info = await page.evaluate(() => {
      window.__b2tErrors = window.__b2tErrors || [];
      if (!window.__b2tErrInstalled) {
        window.__b2tErrInstalled = true;
        window.addEventListener("error", (e) => {
          window.__b2tErrors.push({ kind: "error", msg: String(e.message || ""), src: String(e.filename || ""), line: e.lineno });
        });
        window.addEventListener("unhandledrejection", (e) => {
          window.__b2tErrors.push({ kind: "rejection", msg: String((e.reason && e.reason.message) || e.reason || "") });
        });
      }
      return { installed: true };
    });
    return info;
  }
  if (mode === "manual_paint") {
    const out = await page.evaluate(() => {
      const key = typeof readingPanelKey !== "undefined" ? readingPanelKey : null;
      const entry = key && typeof readingMarks !== "undefined" ? readingMarks.get(key) : null;
      let error = null;
      try {
        if (!entry) throw new Error("no entry for panel key " + key);
        readingCropPaint(entry);
      } catch (e) {
        error = String(e && e.stack ? e.stack : e);
      }
      const cropEl = document.getElementById("reading-dock-crop");
      let attr = null;
      try { attr = cropEl && cropEl.dataset.crop ? JSON.parse(cropEl.dataset.crop) : null; } catch (e) {}
      return { key, error, attr, plan: window.__b2tCropPlan || null };
    });
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => {
      const cropEl = document.getElementById("reading-dock-crop");
      try { return { attr: cropEl && cropEl.dataset.crop ? JSON.parse(cropEl.dataset.crop) : null }; } catch (e) { return {}; }
    });
    return { ...out, after };
  }
  return await page.evaluate(() => window.__b2tErrors || []);
}

/** B7：同一条目强制用 view/mid/zoom 三档重画裁窗，比较 data-crop 的 x0/y0/w/h。 */
async function cropSizeProbe(page) {
  return await page.evaluate(async () => {
    const key = typeof readingPanelKey !== "undefined" ? readingPanelKey : null;
    const entry = key && typeof readingMarks !== "undefined" ? readingMarks.get(key) : null;
    if (!entry) return { error: "no panel entry" };
    const orig = window.pageImageUrl;
    const out = {};
    for (const size of ["view", "mid", "zoom"]) {
      window.pageImageUrl = function (pg) { return orig(pg, size); };
      readingCropPaint(entry);
      const started = performance.now();
      let attr = null;
      while (performance.now() - started < 5000) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        const el = document.getElementById("reading-dock-crop");
        if (el && el.dataset.crop) {
          try { attr = JSON.parse(el.dataset.crop); } catch (error) { attr = null; }
          if (attr && attr.nw) break;
        }
      }
      out[size] = attr;
    }
    window.pageImageUrl = orig;
    return out;
  });
}

/**
 * 标点批量裁决探针：判一组之后，正文流是否真的重开（setReadingProject/Data/Marks 接没接上）。
 * 判据用三个客观信号：readingData 对象身份变了、正文流 DOM 被重建、marks 窗口重新加载。
 */
async function punctProbe(page, args) {
  const mode = args.mode || "decide";
  await ensureReading(page);

  const read = () =>
    page.evaluate(() => {
      const stream = document.getElementById("reading-stream");
      const data = typeof readingData !== "undefined" ? readingData : null;
      const progress = (document.getElementById("reading-progress-text") || {}).textContent || "";
      return {
        segs: stream ? stream.querySelectorAll(".reading-seg").length : 0,
        scrollTop: stream ? Math.round(stream.scrollTop) : null,
        progress: progress.replace(/\s+/g, " ").trim(),
        hasProbeMarker: Boolean(data && data.__probeMarker),
        segments: data && data.segments ? data.segments.length : null,
        marksWindow: typeof readingMarksWindow !== "undefined" ? readingMarksWindow : null,
        marksSize: typeof readingMarks !== "undefined" && readingMarks.size !== undefined
          ? readingMarks.size : null,
        project: typeof readingProject !== "undefined" ? readingProject : null,
        badge: (document.getElementById("reading-punct-count") || {}).textContent || null,
        modalHidden: (document.getElementById("punct-groups-mask") || {}).hidden ?? null,
        groups: document.querySelectorAll("#punct-groups-list > *").length,
        adoptButtons: document.querySelectorAll("#punct-groups-list .btn--pri").length,
        building: typeof readingBuilding !== "undefined" ? readingBuilding : null,
      };
    });

  const before = await read();
  // 给 readingData 打标记：重开之后拿到的是新对象，标记会消失
  await page.evaluate(() => {
    if (typeof readingData !== "undefined" && readingData) readingData.__probeMarker = 1;
    window.__punctStreamMutations = 0;
    window.__punctObserver = new MutationObserver((list) => {
      window.__punctStreamMutations += list.length;
    });
    const stream = document.getElementById("reading-stream");
    if (stream) window.__punctObserver.observe(stream, { childList: true, subtree: true });
  });

  await page.click("#reading-punct-open", { label: "打开标点分组" });
  await page.waitForFunction(
    () => {
      const mask = document.getElementById("punct-groups-mask");
      return Boolean(mask && !mask.hidden);
    },
    undefined,
    { timeout: 15000 }
  );
  await page.waitForTimeout(400);
  const opened = await read();

  if (mode === "open") {
    return { before, opened };
  }

  if (!opened.adoptButtons) {
    return { before, opened, error: "没有可判的标点分组（分组列表为空）" };
  }
  // 一组一个按钮，选择器必须收敛到"第一组"这一颗
  await page.click("#punct-groups-list > *:first-child .punct-group__actions .btn--pri",
                  { label: "全部采用候选（第一组）" });
  // 等"重开"的可观测结果：readingData 换对象 / 流 DOM 重建 / 进度变化
  // 等"重开完成"：readingData 换成**非空新对象**、正文流重新有几段。
  // 只看 marker 消失不够——`setReadingData(null)` 那一步也会让 marker 消失，
  // 如果 openReading() 没跑起来，会误判成"重开成功"（正文流其实是空的）。
  const started = Date.now();
  let after = await read();
  const timeline = [];
  while (Date.now() - started < 25000) {
    await page.waitForTimeout(300);
    after = await read();
    timeline.push({ ms: Date.now() - started, segs: after.segs, segments: after.segments,
                    hasProbeMarker: after.hasProbeMarker, progress: after.progress, badge: after.badge });
    if (after.segments !== null && !after.hasProbeMarker && after.segs > 0) break;
  }
  const mutations = await page.evaluate(() => {
    if (window.__punctObserver) window.__punctObserver.disconnect();
    return window.__punctStreamMutations || 0;
  });
  const errors = await page.evaluate(() => window.__b2tErrors || []);
  return { before, opened, after, mutations, errors, ms: Date.now() - started, timeline };
}

/**
 * 处理器接线探针（L1 第二笔：setupReading 搬进 reading-view.js 后，30 个绑定的东西还活着吗）。
 * 每个控件都要有"可观测效果"，不是"点了没报错"。
 */
async function handlersProbe(page, args) {
  await ensureReading(page);
  const rows = [];
  await page.dismissDialog().catch(() => {});
  const snap = () =>
    page.evaluate(() => {
      const label = (document.getElementById("reading-page-no") || {}).textContent || "";
      const m = label.match(/(\d+)/);
      const btn = (id) => document.getElementById(id) || {};
      return {
        page: m ? Number(m[1]) : null,
        panelKey: (document.querySelector(".reading-panel") || {}).dataset
          ? document.querySelector(".reading-panel").dataset.key || null : null,
        filter: btn("reading-filter").value || null,
        pendingClass: (document.getElementById("view-reading") || {}).className || "",
        view: typeof currentView !== "undefined" ? currentView : null,
        nextDisabled: btn("reading-next").disabled ?? null,
        prevDisabled: btn("reading-prev").disabled ?? null,
        submitDisabled: btn("reading-submit").disabled ?? null,
        notice: (document.getElementById("auto-apply-notice-text") || {}).textContent || "",
      };
    });
  const record = async (name, ok, detail) => rows.push({ name, ok, detail });

  // 1) 翻页：先看 disabled，再点能点的那一个
  try {
    const before = await snap();
    let after = before;
    if (!before.nextDisabled) {
      await page.click("#reading-next", { label: "下一页" });
      await page.waitForTimeout(800);
      after = await snap();
    }
    if (after.page === before.page && !after.prevDisabled) {
      await page.click("#reading-prev", { label: "上一页" });
      await page.waitForTimeout(800);
      after = await snap();
    }
    if (before.nextDisabled && before.prevDisabled) {
      await record("翻页 next/prev", true, "两个都 disabled（单页项目），N/A");
    } else {
      await record("翻页 next/prev", after.page !== before.page,
                   `${before.page} -> ${after.page}（nextDisabled=${before.nextDisabled}）`);
    }
  } catch (error) {
    await record("翻页 next/prev", false, String(error).slice(0, 160));
  }

  // 2) 过滤器
  try {
    const before = await snap();
    const options = await page.evaluate(() =>
      [...document.querySelectorAll("#reading-filter option")].map((o) => o.value));
    const nextValue = options.find((v) => v !== before.filter) || before.filter;
    await page.selectOption("#reading-filter", nextValue);
    await page.waitForTimeout(700);
    const after = await snap();
    await record("过滤器 select", after.filter === nextValue && after.filter !== before.filter,
                 `${before.filter} -> ${after.filter}`);
  } catch (error) {
    await record("过滤器 select", false, String(error).slice(0, 160));
  }

  // 3) 显示菜单 / 更多菜单
  for (const [name, btn, menu] of [
    ["显示菜单", "#reading-display-open", "#reading-display-menu"],
    ["更多菜单", "#reading-more-open", "#reading-more-menu"],
  ]) {
    try {
      await page.click(btn, { label: `打开${name}` });
      await page.waitForTimeout(300);
      const opened = await page.evaluate((sel) => {
        const m = document.querySelector(sel);
        return Boolean(m && !m.hidden);
      }, menu);
      await page.mouse.click(700, 300, { label: "点空白处" });
      await page.waitForTimeout(300);
      const closed = await page.evaluate((sel) => {
        const m = document.querySelector(sel);
        return Boolean(m && m.hidden);
      }, menu);
      await record(name, opened && closed, `打开=${opened} 点空白关=${closed}`);
    } catch (error) {
      await record(name, false, String(error).slice(0, 160));
    }
  }

  // 4) 待审红字开关：先开"显示"菜单，复选框在里面
  try {
    await page.click("#reading-display-open", { label: "打开显示菜单" });
    await page.waitForTimeout(300);
    const had = (await snap()).pendingClass.includes("hide-pending");
    await page.click("#reading-pending-toggle", { label: "切换待审红字" });
    await page.waitForTimeout(500);
    const has = (await snap()).pendingClass.includes("hide-pending");
    await page.click("#reading-pending-toggle", { label: "切回待审红字" });
    await page.waitForTimeout(300);
    await page.mouse.click(700, 300, { label: "关显示菜单" });
    await record("待审红字开关", had !== has, `hide-pending: ${had} -> ${has}`);
  } catch (error) {
    await record("待审红字开关", false, String(error).slice(0, 160));
  }

  // 5) 提交：0 草稿时 disabled 就是正确行为；有草稿才点
  try {
    const s0 = await snap();
    if (s0.submitDisabled) {
      await record("提交按钮", true, "disabled（当前 0 草稿，符合预期）");
    } else {
      await page.click("#reading-submit", { label: "提交" });
      await page.waitForTimeout(800);
      const after = await snap();
      await record("提交按钮", true, `notice=${(after.notice || "").slice(0, 60)}`);
    }
  } catch (error) {
    await record("提交按钮", false, String(error).slice(0, 160));
  }

  // 6) 撤销：点开会弹 confirm；dismiss 掉，不改数据，只证明处理器活着
  try {
    await page.click("#reading-more-open", { label: "打开更多" });
    await page.waitForTimeout(300);
    await page.click("#reading-undo", { label: "撤回上次提交" });
    await page.waitForTimeout(600);
    const dialog = await page.dismissDialog().then(() => true).catch(() => false);
    await page.mouse.click(700, 300, { label: "关更多菜单" });
    await page.waitForTimeout(300);
    await record("撤销按钮", dialog, dialog ? "点击后弹出确认框（处理器活着），已取消" : "点击后没有确认框");
  } catch (error) {
    await record("撤销按钮", false, String(error).slice(0, 160));
    await page.dismissDialog().catch(() => {});
  }

  // 7) 盲区出口
  try {
    const beforeView = (await snap()).view;
    await page.click("#reading-more-open", { label: "打开更多" });
    await page.waitForTimeout(300);
    await page.click("#reading-blindspot", { label: "可疑行" });
    await page.waitForTimeout(1200);
    const after = await snap();
    await record("盲区出口", after.view !== beforeView, `view ${beforeView} -> ${after.view}`);
  } catch (error) {
    await record("盲区出口", false, String(error).slice(0, 160));
    await page.dismissDialog().catch(() => {});
  }

  // 8) 键盘：Enter 跳下一处 / Esc 关面板
  try {
    await ensureReading(page);
    await page.click("#reading-next-unreviewed", { label: "打开一条" });
    await page.waitForTimeout(900);
    const b = await snap();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);
    const a = await snap();
    await record("键盘 Enter", Boolean(b.panelKey) && a.panelKey !== b.panelKey,
                 `${b.panelKey} -> ${a.panelKey}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
    const c = await snap();
    await record("键盘 Esc 关面板", c.panelKey === null, `panelKey ${a.panelKey} -> ${c.panelKey}`);
  } catch (error) {
    await record("键盘", false, String(error).slice(0, 160));
    await page.dismissDialog().catch(() => {});
  }
  return { rows };
}

/** 点一个选择器并回报前后状态（排查"按钮点了没反应"用）。 */
async function clickSel(page, args) {
  const read = () =>
    page.evaluate(() => {
      const label = (document.getElementById("reading-page-no") || {}).textContent || "";
      const scroller = document.getElementById("reading-pdf-scroll");
      return {
        label: label.replace(/\s+/g, ""),
        pageNo: typeof readingPageNo !== "undefined" ? readingPageNo : null,
        scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
        disabled: (document.querySelector(args_holder.selector) || {}).disabled ?? null,
      };
    });
  // 把 selector 传进页面作用域
  await page.evaluate((sel) => { window.__clickSelArg = sel; }, args.selector);
  const readWith = () =>
    page.evaluate(() => {
      const label = (document.getElementById("reading-page-no") || {}).textContent || "";
      const scroller = document.getElementById("reading-pdf-scroll");
      const node = document.querySelector(window.__clickSelArg);
      return {
        label: label.replace(/\s+/g, ""),
        pageNo: typeof readingPageNo !== "undefined" ? readingPageNo : null,
        scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
        disabled: node ? node.disabled : null,
      };
    });
  const before = await readWith();
  await page.click(args.selector, { label: args.label || args.selector });
  await page.waitForTimeout(args.wait || 900);
  const after = await readWith();
  return { before, after, changed: before.label !== after.label || before.pageNo !== after.pageNo };
}

/** L2：10 个交互逐项验证（每项都要可观测效果）。 */
async function interactionsProbe(page, args) {
  await ensureReading(page);
  const rows = [];
  const rec = (name, ok, detail) => rows.push({ name, ok, detail });
  const snap = () =>
    page.evaluate(() => {
      const label = (document.getElementById("reading-page-no") || {}).textContent || "";
      const m = label.match(/(\d+)/);
      const stream = document.getElementById("reading-stream");
      const scroller = document.getElementById("reading-pdf-scroll");
      const panel = document.querySelector(".reading-panel");
      const chip = document.getElementById("reading-follow-chip");
      return {
        label: m ? Number(m[1]) : null,
        pageNo: typeof readingPageNo !== "undefined" ? readingPageNo : null,
        scrollTop: stream ? Math.round(stream.scrollTop) : null,
        pdfTop: scroller ? Math.round(scroller.scrollTop) : null,
        segs: stream ? stream.querySelectorAll(".reading-seg").length : 0,
        entries: typeof readingEntries !== "undefined" ? readingEntries.length : null,
        filter: typeof readingFilter !== "undefined" ? readingFilter : null,
        drafts: typeof readingDrafts !== "undefined" ? readingDrafts.size : null,
        inlineEdits: typeof readingInlineEdits !== "undefined" ? readingInlineEdits.size : null,
        editing: typeof readingEditingKey !== "undefined" ? readingEditingKey : null,
        follow: typeof readingFollow !== "undefined" ? readingFollow : null,
        chipText: chip ? chip.textContent.replace(/\s+/g, "") : null,
        chipOn: chip ? chip.classList.contains("is-on") : null,
        hover: document.querySelectorAll("#reading-stream .reading-seg.is-hover").length,
        linked: document.querySelectorAll("#reading-pages .box.is-linked").length,
        panelKey: panel ? panel.dataset.key || null : null,
        progress: (document.getElementById("reading-progress-text") || {}).textContent || "",
      };
    });

  // 1) 过滤器：三个值下的条目数
  try {
    const counts = {};
    for (const value of ["all", "chars", "unacked"]) {
      const has = await page.evaluate((v) =>
        Boolean(document.querySelector(`#reading-filter option[value="${v}"]`)), value);
      if (!has) { counts[value] = "no-option"; continue; }
      await page.selectOption("#reading-filter", value);
      await page.waitForTimeout(800);
      const s = await snap();
      counts[value] = { entries: s.entries, segs: s.segs, filter: s.filter };
    }
    await page.selectOption("#reading-filter", "all");
    await page.waitForTimeout(500);
    const uniq = new Set(Object.values(counts).filter((v) => v !== "no-option")
      .map((v) => JSON.stringify(v)));
    await rec("1 过滤器", uniq.size > 1, JSON.stringify(counts));
  } catch (error) { await rec("1 过滤器", false, String(error).slice(0, 160)); }

  // 2) 翻页：label / readingPageNo / scrollTop 三者同步
  try {
    const b = await snap();
    await page.click("#reading-next", { label: "下一页" });
    await page.waitForTimeout(900);
    const a = await snap();
    const synced = a.label === a.pageNo && a.pageNo === b.pageNo + 1;
    await rec("2 翻页", synced,
              `before label/pageNo/pdfTop ${b.label}/${b.pageNo}/${b.pdfTop} -> after ${a.label}/${a.pageNo}/${a.pdfTop}`);
    await page.click("#reading-prev").catch(() => {});
    await page.waitForTimeout(600);
  } catch (error) { await rec("2 翻页", false, String(error).slice(0, 160)); }

  // 3) 进入编辑：点正文某行
  try {
    const point = await page.evaluate(() => {
      const line = document.querySelector("#reading-stream .reading-line");
      if (!line) return null;
      line.scrollIntoView({ block: "center" });
      const r = line.getBoundingClientRect();
      return { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2, key: line.dataset.key };
    });
    if (!point) throw new Error("正文流没有行");
    await page.mouse.click(point.x, point.y, { label: "点正文行进编辑" });
    await page.waitForTimeout(700);
    const s = await snap();
    const hasBox = await page.evaluate(() =>
      Boolean(document.querySelector('#reading-stream .reading-line[contenteditable]')));
    await rec("3 进入编辑", Boolean(s.editing) && hasBox, `editing=${s.editing} contenteditable=${hasBox}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  } catch (error) { await rec("3 进入编辑", false, String(error).slice(0, 160)); }

  // 4) 提交：造一个草稿再提交（先等面板真的打开，否则 Enter 不会落草稿）
  try {
    await ensureReading(page);
    await page.click("#reading-next-unreviewed", { label: "开一条" });
    await page.waitForFunction(
      () => Boolean(document.querySelector("#reading-panel-host .reading-panel")),
      undefined,
      { timeout: 10000 }
    );
    await page.waitForTimeout(400);
    // 焦点必须离开 select/input：文档级键盘处理器对 INPUT/TEXTAREA/SELECT 直接 return
    await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
    await page.keyboard.press("Enter");
    await page.waitForTimeout(900);
    let before = await snap();
    if (!before.drafts) {
      // 再按一次（第一次可能只是打开面板）
      await page.waitForFunction(
        () => Boolean(document.querySelector("#reading-panel-host .reading-panel")),
        undefined,
        { timeout: 8000 }
      );
      await page.keyboard.press("Enter");
      await page.waitForTimeout(900);
      before = await snap();
    }
    if (!before.drafts) throw new Error("按了两次 Enter 仍没有草稿");
    await page.click("#reading-submit", { label: "提交草稿" });
    await page.waitForTimeout(2500);
    const after = await snap();
    await rec("4 提交", after.drafts === 0 && after.progress !== before.progress,
              `drafts ${before.drafts}->${after.drafts}; 进度 ${before.progress} -> ${after.progress}`);
  } catch (error) { await rec("4 提交", false, String(error).slice(0, 160)); }

  // 5) 撤销
  try {
    const before = await snap();
    await page.click("#reading-more-open", { label: "打开更多" });
    await page.waitForTimeout(300);
    await page.click("#reading-undo", { label: "撤回上次提交" });
    // 点完**立刻**应答：对话框开着时任何 evaluate/waitForTimeout 都会失败
    const hadDialog = await page.acceptDialog().then(() => true).catch(() => false);
    await page.waitForTimeout(2500);
    const after = await snap();
    await rec("5 撤销", hadDialog && after.progress !== before.progress,
              `confirm=${hadDialog}; 进度 ${before.progress} -> ${after.progress}`);
  } catch (error) {
    await rec("5 撤销", false, String(error).slice(0, 160));
    await page.dismissDialog().catch(() => {});
  }

  // 6) 悬停：移到段落 → 高亮出现；移开 → 消失
  try {
    const seg = await page.evaluate(() => {
      // 只挑**当前视口内**的段落：第一个 seg 可能滚到屏幕外，elementFromPoint 会返回 null
      for (const node of document.querySelectorAll("#reading-stream .reading-seg")) {
        const r = node.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.top > 100 && r.bottom < window.innerHeight - 50
            && r.x > 700 && r.right < window.innerWidth - 20) {
          return { x: Math.round(r.x + 40), y: Math.round(r.y + Math.min(24, r.height / 2)) };
        }
      }
      return null;
    });
    if (!seg) throw new Error("没有段落");
    const under = await page.evaluate(({ x, y }) => {
      const node = document.elementFromPoint(x, y);
      const segNode = node && node.closest ? node.closest(".reading-seg") : null;
      return { tag: node ? node.tagName : null, inSeg: Boolean(segNode) };
    }, seg);
    if (!under.inSeg) throw new Error(`落点不在段落里：${JSON.stringify(under)}`);
    await page.mouse.move(seg.x - 60, seg.y, { label: "移到段落附近" });
    await page.waitForTimeout(200);
    await page.mouse.move(seg.x, seg.y, { label: "悬停段落" });
    await page.waitForTimeout(600);
    const on = await snap();
    const hoverSeq = await page.evaluate(() =>
      typeof readingHoveredSeq !== "undefined" ? readingHoveredSeq : null);
    await page.mouse.move(20, 400, { label: "移开" });
    await page.waitForTimeout(600);
    const off = await snap();
    const hoverSeqOff = await page.evaluate(() =>
      typeof readingHoveredSeq !== "undefined" ? readingHoveredSeq : null);
    await rec("6 悬停", hoverSeq !== null && hoverSeqOff === null,
              `hoveredSeq ${hoverSeq} -> ${hoverSeqOff}; hover 类 ${on.hover}->${off.hover}; linked ${on.linked}->${off.linked}`);
  } catch (error) { await rec("6 悬停", false, String(error).slice(0, 160)); }

  // 7) 跟随开关（chip + 菜单里的 toggle 都试）
  try {
    const b = await snap();
    await page.click("#reading-display-open", { label: "打开显示菜单" });
    await page.waitForTimeout(300);
    await page.click("#reading-follow-toggle", { label: "切换跟随" });
    await page.waitForTimeout(600);
    const a = await snap();
    await page.mouse.click(700, 300, { label: "关菜单" });
    await rec("7 跟随开关", b.follow !== a.follow && b.chipOn !== a.chipOn,
              `follow ${b.follow}->${a.follow}; chip ${b.chipText}->${a.chipText}`);
    // 切回去
    await page.click("#reading-display-open").catch(() => {});
    await page.waitForTimeout(250);
    await page.click("#reading-follow-toggle").catch(() => {});
    await page.mouse.click(700, 300).catch(() => {});
    await page.waitForTimeout(300);
  } catch (error) { await rec("7 跟随开关", false, String(error).slice(0, 160)); }

  // 8) 右栏滚一屏 → 顶部页码跟着变
  try {
    const b = await snap();
    const box = await page.evaluate(() => {
      const s = document.getElementById("reading-stream");
      const r = s.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(box.x, box.y, { label: "移到正文流" });
    await page.mouse.wheel(0, 1200, { label: "右栏滚一屏" });
    await page.waitForTimeout(900);
    const a = await snap();
    await rec("8 滚动同步", a.label !== b.label, `顶部 ${b.label} -> ${a.label}（scrollTop ${b.scrollTop}->${a.scrollTop}）`);
  } catch (error) { await rec("8 滚动同步", false, String(error).slice(0, 160)); }

  // 9) "用户动过"：wheel 之后 1 秒，滚动位置不被异步收尾抢走
  try {
    const before = await snap();
    await page.waitForTimeout(1200);
    const after = await snap();
    await rec("9 用户动过不抢位置", Math.abs((after.scrollTop || 0) - (before.scrollTop || 0)) < 30,
              `scrollTop ${before.scrollTop} -> ${after.scrollTop}`);
  } catch (error) { await rec("9 用户动过不抢位置", false, String(error).slice(0, 160)); }

  // 10) 左栏滚 → 正文跟到对应页
  try {
    const b = await snap();
    const box = await page.evaluate(() => {
      const s = document.getElementById("reading-pdf-scroll");
      const r = s.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(box.x, box.y, { label: "移到左栏" });
    await page.mouse.wheel(0, 900, { label: "左栏滚一屏" });
    await page.waitForTimeout(1200);
    const a = await snap();
    await rec("10 左右联动", a.label !== b.label || a.pdfTop !== b.pdfTop,
              `顶部 ${b.label}->${a.label}；pdfTop ${b.pdfTop}->${a.pdfTop}；正文 scrollTop ${b.scrollTop}->${a.scrollTop}`);
  } catch (error) { await rec("10 左右联动", false, String(error).slice(0, 160)); }

  return { rows, snap: await snap() };
}

/** 点一个会弹 confirm 的按钮：点完立刻应答，再回报状态。 */
async function clickAccept(page, args) {
  await page.click(args.selector, { label: args.label || args.selector });
  const accepted = await page.acceptDialog().then(() => true).catch(() => false);
  await page.waitForTimeout(args.wait || 2000);
  const snap = await page.evaluate(dockSnapshotRaw);
  return { accepted, snap };
}

/** L3：冷启 / 热启 / 用户动过不抢位置。 */
async function l3Probe(page, args) {
  const mode = args.mode || "cold";
  const installNet = () =>
    page.evaluate(() => {
      if (window.__b2tReqLog) return;
      window.__b2tReqLog = [];
      const orig = window.fetch;
      window.fetch = function (...a) {
        try {
          const url = typeof a[0] === "string" ? a[0] : (a[0] && a[0].url) || "";
          window.__b2tReqLog.push({ url: String(url), at: Date.now() });
        } catch (error) { /* 记录失败不影响请求 */ }
        return orig.apply(this, a);
      };
    });
  const readReqs = () => page.evaluate(() => window.__b2tReqLog || []);
  const clearReqs = () => page.evaluate(() => { window.__b2tReqLog = []; });
  const installMutations = () =>
    page.evaluate(() => {
      if (window.__b2tStreamMut !== undefined) { window.__b2tStreamMut = 0; return; }
      window.__b2tStreamMut = 0;
      const stream = document.getElementById("reading-stream");
      if (stream) {
        new MutationObserver((list) => { window.__b2tStreamMut += list.length; })
          .observe(stream, { childList: true, subtree: true });
      }
    });
  const readState = () =>
    page.evaluate(() => {
      const label = (document.getElementById("reading-page-no") || {}).textContent || "";
      const m = label.match(/(\d+)/);
      const stream = document.getElementById("reading-stream");
      const data = typeof readingData !== "undefined" ? readingData : null;
      return {
        label: m ? Number(m[1]) : null,
        pageNo: typeof readingPageNo !== "undefined" ? readingPageNo : null,
        scrollTop: stream ? Math.round(stream.scrollTop) : null,
        segs: stream ? stream.querySelectorAll(".reading-seg").length : 0,
        rendered: typeof readingRendered !== "undefined" ? readingRendered : null,
        segments: data && data.segments ? data.segments.length : null,
        project: typeof readingProject !== "undefined" ? readingProject : null,
        mut: window.__b2tStreamMut,
        reqCount: (window.__b2tReqLog || []).length,
      };
    });

  const stepTo = async (step) => {
    await page.click(`button[data-workflow-step="${step}"]`, { label: `切到 ${step}` });
    await page.waitForTimeout(900);
  };

  if (mode === "cold") {
    // prepare 已经装了网络记录器：直接看"打开项目 → 进审校"期间的请求
    await installNet();
    await installMutations();
    await page.evaluate(() => { if (window.__b2tStreamMut !== undefined) window.__b2tStreamMut = 0; });
    const onReading = await page.evaluate(() => {
      const v = document.getElementById("view-reading");
      return Boolean(v && !v.hidden);
    });
    if (!onReading) await stepTo("review");
    await page
      .waitForFunction(() => document.querySelectorAll("#reading-stream .reading-seg").length > 0,
                       undefined, { timeout: 60000 })
      .catch(() => {});
    await page.waitForTimeout(2500);
    const reqs = await readReqs();
    const st = await readState();
    const apis = reqs.map((r) => {
      const u = r.url.replace(/^https?:\/\/[^/]+/, "");
      if (u.includes("/preview")) return "preview";
      if (u.includes("/review/marks")) return "marks";
      if (u.includes("/review/tree")) return "tree";
      return u;
    });
    return { mode, apis, reqCount: reqs.length, state: st };
  }

  if (mode === "hot") {
    // 确保在审校页并已渲染
    await stepTo("review");
    await page.waitForTimeout(2000);
    await installNet();
    await installMutations();
    const before = await readState();
    await clearReqs();
    await page.evaluate(() => { window.__b2tStreamMut = 0; });
    await stepTo("pages");
    // 切走之后再清空：pages 视图自己的请求（blocks/suggestions）不算审校的新请求
    await clearReqs();
    await installMutations();
    await stepTo("review");
    await page.waitForTimeout(2500);
    const reqs = await readReqs();
    const after = await readState();
    return { mode, before, after, newRequests: reqs.length, requests: reqs.map((r) => r.url.replace(/^https?:\/\/[^/]+/, "")) };
  }

  if (mode === "moved") {
    await stepTo("review");
    await page.waitForTimeout(1500);
    const box = await page.evaluate(() => {
      const s = document.getElementById("reading-stream");
      const r = s.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(box.x, box.y, { label: "移到正文流" });
    await page.mouse.wheel(0, 1500, { label: "真实滚动" });
    await page.waitForTimeout(600);
    const afterWheel = await readState();
    // 等一轮异步收尾/补 marks 的时间，再看位置有没有被拽走
    await page.waitForTimeout(3000);
    const later = await readState();
    return { mode, afterWheel, later, stolenBy: (later.scrollTop || 0) - (afterWheel.scrollTop || 0) };
  }
  return { mode: "unknown" };
}

/** L4：下一处未审四分支 / 草稿恢复 / 视口变化 / 编辑态定时器。 */
async function l4Probe(page, args) {
  const mode = args.mode || "next";
  const read = () =>
    page.evaluate(() => {
      const label = (document.getElementById("reading-page-no") || {}).textContent || "";
      const m = label.match(/(\d+)/);
      const stream = document.getElementById("reading-stream");
      const segNodes = [...stream.querySelectorAll(".reading-seg")].slice(0, 12);
      const segs = segNodes.map((n) => {
        const r = n.getBoundingClientRect();
        return { top: Math.round(r.top), h: Math.round(r.height) };
      });
      const cs = getComputedStyle(stream);
      const lines = [...stream.querySelectorAll(".reading-line")].slice(0, 40);
      const rects = lines.map((n) => {
        const r = n.getBoundingClientRect();
        return { top: Math.round(r.top), h: Math.round(r.height) };
      });
      let overlaps = 0;
      for (let i = 1; i < rects.length; i += 1) {
        if (rects[i].top < rects[i - 1].top + rects[i - 1].h - 2) overlaps += 1;
      }
      return {
        label: m ? Number(m[1]) : null,
        pageNo: typeof readingPageNo !== "undefined" ? readingPageNo : null,
        panelKey: (document.querySelector(".reading-panel") || {}).dataset
          ? document.querySelector(".reading-panel").dataset.key || null : null,
        progress: (document.getElementById("reading-progress-text") || {}).textContent || "",
        notice: (document.getElementById("auto-apply-notice-text") || {}).textContent || "",
        drafts: typeof readingDrafts !== "undefined" ? readingDrafts.size : null,
        inline: typeof readingInlineEdits !== "undefined" ? readingInlineEdits.size : null,
        inlineMarks: document.querySelectorAll("#reading-stream .reading-line.is-inline-edited").length,
        segs: stream.querySelectorAll(".reading-seg").length,
        lineSample: rects.slice(0, 4),
        segsSample: segs.slice(0, 5),
        segOverlaps: (() => {
          let n = 0;
          for (let i = 1; i < segs.length; i += 1) {
            if (segs[i].top < segs[i - 1].top + segs[i - 1].h - 2) n += 1;
          }
          return n;
        })(),
        streamFont: cs.fontSize,
        streamLineHeight: cs.lineHeight,
        overlaps,
        scrollTop: Math.round(stream.scrollTop),
      };
    });

  if (mode === "next") {
    await ensureReading(page);
    const out = { clicks: [], emptyBranch: null, errorBranch: null };
    for (let i = 0; i < 20; i += 1) {
      await page.click("#reading-next-unreviewed", { label: `下一处 ${i + 1}` }).catch(() => {});
      await page.waitForTimeout(500);
      const st = await read();
      out.clicks.push({ i: i + 1, label: st.label, panelKey: st.panelKey, progress: st.progress });
    }
    // 空队列分支：让 next-lines 返回空
    await page.evaluate(() => {
      window.__origFetchL4 = window.fetch;
      window.fetch = function (url, opts) {
        if (String(url).includes("/review/next-lines")) {
          return Promise.resolve(new Response(JSON.stringify({ lines: [], total: 0, outside_stream: { count: 0, sample: [] } }), {
            status: 200, headers: { "Content-Type": "application/json" },
          }));
        }
        return window.__origFetchL4.apply(this, arguments);
      };
    });
    await page.click("#reading-next-unreviewed", { label: "空队列" }).catch(() => {});
    await page.waitForTimeout(800);
    out.emptyBranch = (await read()).notice;
    // 失败分支
    await page.evaluate(() => {
      window.fetch = function (url) {
        if (String(url).includes("/review/next-lines")) return Promise.reject(new Error("mock-network-down"));
        return window.__origFetchL4.apply(this, arguments);
      };
    });
    await page.click("#reading-next-unreviewed", { label: "请求失败" }).catch(() => {});
    await page.waitForTimeout(1000);
    out.errorBranch = (await read()).notice;
    // 恢复
    await page.evaluate(() => { if (window.__origFetchL4) window.fetch = window.__origFetchL4; });
    return out;
  }

  if (mode === "restore") {
    await ensureReading(page);
    const keys = await page.evaluate(() => {
      const data = typeof readingData !== "undefined" ? readingData : null;
      const segs = (data && data.segments) || [];
      const keys = [];
      for (const seg of segs) {
        for (const span of seg.line_spans || []) {
          keys.push(`${span.block_id}:${span.line_index}`);
          if (keys.length >= 2) break;
        }
        if (keys.length >= 2) break;
      }
      return keys;
    });
    if (keys.length < 2) return { error: "拿不到行 key" };
    await page.evaluate((ks) => {
      const pid = typeof currentProject !== "undefined" && currentProject ? currentProject.project_id : "";
      // 存储格式是 {"items":[{key,base,text,at}]}，不是 map（读实现 loadReadingInlineEdits）
      const items = ks.map((k) => ({ key: k, base: "", text: "QA草稿", at: Date.now() }));
      localStorage.setItem(`b2t.readingInline.${pid}`, JSON.stringify({ items }));
    }, keys);
    await page.reload();
    await page.waitForTimeout(2500);
    // 打开项目
    await page.evaluate((pid) => {
      const card = document.querySelector(`#project-list li.pcard[data-project-id="${pid}"]`);
      const btn = card && card.querySelector(".pcard__actions button.btn--pri");
      if (btn) btn.click();
    }, args.projectId || "b2t_ZAQHGH");
    // 恢复提示是 window.confirm：等它出现再接受
    let promptSeen = false;
    for (let i = 0; i < 30; i += 1) {
      await page.waitForTimeout(400);
      const accepted = await page.acceptDialog().then(() => true).catch(() => false);
      if (accepted) { promptSeen = true; break; }
    }
    await page.waitForTimeout(2500);
    const st = await read();
    return { keys, promptSeen, state: st };
  }

  if (mode === "resize") {
    await ensureReading(page);
    const before = await read();
    await page.cdp("Emulation.setDeviceMetricsOverride", {
      width: 1180, height: 800, deviceScaleFactor: 2, mobile: false,
    });
    await page.waitForTimeout(1500);
    const after = await read();
    // 恢复视口
    // 改完尺寸再滚一下：页码/滚动映射还应正常
    const box = await page.evaluate(() => {
      const s = document.getElementById("reading-stream");
      const r = s.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(box.x, box.y, { label: "移到正文流" });
    await page.mouse.wheel(0, 900, { label: "改尺寸后滚一屏" });
    await page.waitForTimeout(900);
    const afterWheel = await read();
    await page.cdp("Emulation.setDeviceMetricsOverride", {
      width: 1423, height: 900, deviceScaleFactor: 2, mobile: false,
    });
    await page.waitForTimeout(800);
    return { before, after, afterWheel };
  }

  if (mode === "edit") {
    await ensureReading(page);
    const point = await page.evaluate(() => {
      for (const node of document.querySelectorAll("#reading-stream .reading-line")) {
        const r = node.getBoundingClientRect();
        if (r.top > 100 && r.bottom < window.innerHeight - 50 && r.x > 700) {
          return { x: r.x + 30, y: r.y + r.height / 2, key: node.dataset.key };
        }
      }
      return null;
    });
    if (!point) return { error: "没有可见行" };
    await page.mouse.click(point.x, point.y, { label: "点行进编辑" });
    await page.waitForTimeout(500);
    const editing = await page.evaluate(() => typeof readingEditingKey !== "undefined" ? readingEditingKey : null);
    await page.keyboard.type("QA", { delay: 40 });
    await page.waitForTimeout(700);   // onInlineInput 的 350ms 防抖
    const st = await read();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    return { point, editing, state: st };
  }
  return { mode: "unknown" };
}

/** 破环：goto/jump 延迟到帧末后的居中与双滚风险。 */
async function gotoProbe(page, args) {
  const mode = args.mode || "next";
  const install = () =>
    page.evaluate(() => {
      if (window.__gotoSampler) return;
      window.__gotoSamples = [];
      const stream = document.getElementById("reading-stream");
      window.__gotoSampler = true;
      stream.addEventListener("scroll", () => {
        window.__gotoSamples.push({ t: Math.round(performance.now()), top: Math.round(stream.scrollTop) });
      }, { passive: true });
    });
  const clear = () => page.evaluate(() => { window.__gotoSamples = []; });
  const read = () =>
    page.evaluate(() => {
      const stream = document.getElementById("reading-stream");
      const sr = stream.getBoundingClientRect();
      const label = (document.getElementById("reading-page-no") || {}).textContent || "";
      const m = label.match(/(\d+)/);
      const line = document.querySelector("#reading-stream .reading-line.is-current");
      let centerDelta = null;
      let lineTop = null;
      if (line) {
        const lr = line.getBoundingClientRect();
        lineTop = Math.round(lr.top - sr.top);
        centerDelta = Math.round((lr.top + lr.height / 2) - (sr.top + sr.height / 2));
      }
      const samples = (window.__gotoSamples || []).slice();
      const tops = samples.map((s) => s.top);
      const distinct = [...new Set(tops)];
      return {
        label: m ? Number(m[1]) : null,
        pageNo: typeof readingPageNo !== "undefined" ? readingPageNo : null,
        panelKey: (document.querySelector(".reading-panel") || {}).dataset
          ? document.querySelector(".reading-panel").dataset.key || null : null,
        panelPage: (document.querySelector(".reading-panel__head strong") || {}).textContent || null,
        scrollTop: Math.round(stream.scrollTop),
        streamH: Math.round(sr.height),
        lineTop,
        centerDelta,
        centered: centerDelta !== null && Math.abs(centerDelta) <= sr.height * 0.25,
        scrollEvents: samples.length,
        distinctTops: distinct,
        samples: samples.slice(-12),
      };
    });

  await ensureReading(page);
  await install();
  const results = [];
  const doNext = async (tag) => {
    await clear();
    await page.click("#reading-next-unreviewed", { label: `${tag} 下一处` }).catch(() => {});
    await page.waitForTimeout(1400);
    results.push({ tag, ...(await read()) });
  };
  if (mode === "next") {
    for (let i = 1; i <= 3; i += 1) await doNext(`next${i}`);
    return { results };
  }
  if (mode === "tree") {
    // 点左树某一个有差异的页
    const pageNo = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".reading-tree__row[data-page]")];
      const pick = rows[Math.min(3, rows.length - 1)];
      return pick ? Number(pick.dataset.page) : null;
    });
    if (!pageNo) return { error: "左树没有页行" };
    await clear();
    await page.click(`.reading-tree__row[data-page="${pageNo}"]`, { label: "点左树页" });
    await page.waitForTimeout(1400);
    results.push({ tag: `tree p${pageNo}`, ...(await read()) });
    return { results };
  }
  if (mode === "panel") {
    // 点正文流里的一处差异标记（开面板），再点面板里的"原文"一行（走 gotoReadingEntry）
    await page.click("#reading-next-unreviewed").catch(() => {});
    await page.waitForTimeout(1200);
    const point = await page.evaluate(() => {
      for (const mark of document.querySelectorAll("#reading-stream .reading-mark")) {
        const r = mark.getBoundingClientRect();
        if (r.top > 120 && r.bottom < window.innerHeight - 80) return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
      return null;
    });
    if (!point) return { error: "没有可见的差异标记" };
    await clear();
    await page.mouse.click(point.x, point.y, { label: "点一处差异" });
    await page.waitForTimeout(1400);
    results.push({ tag: "panel-mark", ...(await read()) });
    return { results };
  }
  return { mode: "unknown" };
}

async function nextProbe(page) {
  await ensureReading(page);
  const rows = [];
  for (let i = 0; i < 20; i += 1) {
    await page.click("#reading-next-unreviewed", { label: `下一处未审 ${i + 1}` });
    // 等"顶部页码追上当前面板"（最多 3 秒），再等 300ms 看是否站住；
    // 只等 1 秒会把"还在跳"误判成"没同步"。
    await page
      .waitForFunction(
        () => {
          const head = document.querySelector(".reading-panel__head strong");
          const label = document.getElementById("reading-page-no");
          if (!head || !label) return false;
          const panel = Number(((head.textContent || "").match(/第\s*(\d+)\s*页/) || [0, 0])[1]) || null;
          const top = Number(((label.textContent || "").match(/(\d+)/) || [0, 0])[1]) || null;
          return panel !== null && top === panel;
        },
        undefined,
        { timeout: 3000 }
      )
      .catch(() => {});
    // 行高亮是"行进了渲染窗口"之后才有的：再给它最多 1.5 秒
    await page
      .waitForFunction(
        () => document.querySelectorAll("#reading-stream .reading-line.is-current, #reading-stream .reading-mark.is-current").length > 0,
        undefined,
        { timeout: 1500 }
      )
      .catch(() => {});
    await page.waitForTimeout(150);
    rows.push(await page.evaluate((index) => {
      const panel = document.querySelector(".reading-panel");
      const label = (document.getElementById("reading-page-no") || {}).textContent || "";
      const labelNo = Number((label.match(/(\d+)/) || [0, 0])[1]) || null;
      const head = document.querySelector(".reading-panel__head strong");
      const panelPage = head ? Number(((head.textContent || "").match(/第\s*(\d+)\s*页/) || [0, 0])[1]) || null : null;
      const scroller = document.getElementById("reading-pdf-scroll");
      let dominant = null;
      if (scroller) {
        const rect = scroller.getBoundingClientRect();
        const tiles = [...scroller.querySelectorAll(".reading-page")].map((tile) => {
          const r = tile.getBoundingClientRect();
          const overlap = Math.min(r.bottom, rect.bottom) - Math.max(r.top, rect.top);
          return { page: Number(tile.dataset.pageNo), overlap };
        }).filter((t) => t.overlap > 0);
        if (tiles.length) dominant = tiles.reduce((a, b) => (b.overlap > a.overlap ? b : a)).page;
      }
      const highlight = document.querySelectorAll("#reading-stream .reading-line.is-current, #reading-stream .reading-mark.is-current").length;
      const log = (window.__b2tNextLog || [])[0] || {};
      return {
        index: index + 1,
        label,
        labelNo,
        panelPage,
        dominant,
        threeWay: panelPage !== null && panelPage === labelNo && labelNo === dominant,
        highlight,
        panel: Boolean(panel),
        branch: log.branch || null,
        reason: log.reason || null,
        blocks: log.blocks ?? null,
        panelOpened: log.panelOpened ?? null,
        // 高亮要连 key 一起验：只数 is-current 会把"高亮了别的行"判成通过。
        panelKey: (document.querySelector(".reading-panel") || {}).dataset
          ? document.querySelector(".reading-panel").dataset.key || null
          : null,
        targetExists: Boolean(
          (document.querySelector(".reading-panel") || {}).dataset &&
          document.querySelector(`#reading-stream .reading-line[data-key="${document.querySelector(".reading-panel").dataset.key}"]`)
        ),
        targetCurrent: Boolean(
          (document.querySelector(".reading-panel") || {}).dataset &&
          (() => {
            const node = document.querySelector(`#reading-stream .reading-line[data-key="${document.querySelector(".reading-panel").dataset.key}"]`);
            return node && node.classList.contains("is-current");
          })()
        ),
        lineFound: log.lineFound ?? null,
        entryPage: log.entryPage ?? null,
        globalUnacked: log.globalUnacked ?? null,
        pagesWithCounts: log.pagesWithCounts ?? null,
        sample: log.sample ?? null,
        inReading: Boolean(document.getElementById("view-reading") && !document.getElementById("view-reading").hidden),
      };
    }, i));
  }
  return rows;
}

async function queueEnd(page, cfg) {
  // 队列已清空时不能等左树（没有行）；只确认在阅读视图。
  const visible = await page.evaluate(() => {
    const node = document.getElementById("view-reading");
    return Boolean(node && !node.hidden);
  });
  if (!visible) throw new Error("当前不在阅读视图");
  const snapshot = async () =>
    await page.evaluate(() => ({
      progress: (document.getElementById("reading-progress-text") || {}).innerText || "",
      button: (document.getElementById("reading-next-unreviewed") || {}).innerText || "",
      panel: Boolean(document.querySelector(".reading-panel")),
      toast: (document.querySelector(".toast, .notification, .app-toast") || {}).innerText || "",
    }));
  const before = await snapshot();
  await page.click("#reading-next-unreviewed", { label: "下一处未审（队列已空）" });
  // 等一个可观测变化：进度文案变了，或者出现了提示；两秒内没变化也继续看结果
  await page
    .waitForFunction(
      (text) => {
        const progress = (document.getElementById("reading-progress-text") || {}).innerText || "";
        const toast = (document.querySelector(".toast, .notification, .app-toast") || {}).innerText || "";
        return progress !== text || toast.length > 0;
      },
      before.progress,
      { timeout: 2500 }
    )
    .catch(() => {});
  const after = await snapshot();
  const message = [after.progress, after.toast].filter(Boolean).join(" | ");
  return {
    before,
    after,
    message,
    explicit: /全部处理完|全部处理完毕|没有未审|已经全部|都审完/.test(message),
    panelVisible: after.panel,
    buttonText: after.button,
  };
}

async function ensureReading(page) {
  await dismissMasks(page);
  const visible = await page.evaluate(() => {
    const node = document.getElementById("view-reading");
    return Boolean(node && !node.hidden);
  });
  if (!visible) {
    await page.click('button[data-workflow-step="review"]', { label: "进入正文审校" });
  }
  await waitFor(
    page,
    () => Boolean(document.getElementById("view-reading") && !document.getElementById("view-reading").hidden),
    "阅读视图可见",
    60000
  );
  await waitFor(
    page,
    () => document.querySelectorAll("#reading-stream .reading-seg").length > 0,
    "阅读流渲染出段落",
    180000
  );
  await waitFor(
    page,
    () => document.querySelectorAll("#reading-tree .reading-tree__row").length > 0,
    "左树页列表就绪",
    120000
  );
}

async function reading(page, cfg) {
  await ensureReading(page);
  const data = await page.evaluate(() => {
    const strip = (node) => {
      const clone = node.cloneNode(true);
      clone
        .querySelectorAll(".reading-chip, .reading-fold, .reading-proof__pages, .reading-mark__hint")
        .forEach((extra) => extra.remove());
      return clone.textContent || "";
    };
    const segments = [...document.querySelectorAll("#reading-stream .reading-seg")].map((node) => ({
      seq: Number(node.dataset.seq),
      pages: node.dataset.pages || "",
      text: strip(node),
    }));
    const rows = [...document.querySelectorAll("#reading-tree .reading-tree__row")].map((row) => ({
      page: Number(row.dataset.page),
      text: (row.innerText || "").replace(/\s+/g, " ").trim(),
    }));
    const head = document.querySelector("#reading-tree");
    return {
      segments,
      treeHead: head ? (head.innerText || "").split("\n")[0].trim() : "",
      rows,
      progress: (document.getElementById("reading-progress-text") || {}).innerText || "",
      pageNo: (document.getElementById("reading-page-no") || {}).innerText || "",
      draftChip: (document.getElementById("reading-draft-chip") || {}).innerText || "",
      submitText: (document.getElementById("reading-submit") || {}).innerText || "",
      options: typeof readingOptions === "function" ? readingOptions() : null,
      checkFails: window.__b2tTextCheckFails || 0,
    };
  });
  data.screenshot = await screenshot(page, cfg, "reading");
  return data;
}

// ---------------------------------------------------------------- 编辑 / 提交 / 撤销

async function edit(page, cfg, args) {
  await ensureReading(page);
  const count = Number(args.count || 2);
  const suffix = String(args.suffix || " QA");
  const candidates = await page.evaluate((n) => {
    const lines = [...document.querySelectorAll("#reading-stream .reading-line")].filter(
      (line) => !line.classList.contains("is-diff") && !line.querySelector("mark")
    );
    const picked = [];
    const seen = new Set();
    for (const line of lines) {
      const block = line.dataset.block;
      if (!block || seen.has(block)) continue;
      seen.add(block);
      const rect = line.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue;
      picked.push({
        key: line.dataset.key,
        block,
        line: line.dataset.line,
        page: line.dataset.page,
        base: line.dataset.baseText || "",
        x: rect.x + Math.min(rect.width / 2, 120),
        y: rect.y + rect.height / 2,
      });
      if (picked.length >= n) break;
    }
    return picked;
  }, count);
  if (candidates.length < count) {
    throw new Error(`可编辑的正文行不够：要 ${count}，只找到 ${candidates.length}`);
  }

  const edits = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const rect = await page.evaluate((key) => {
      const node = document.querySelector(`.reading-line[data-key="${key}"]`);
      if (!node) return null;
      const r = node.getBoundingClientRect();
      return { x: r.x + Math.min(r.width / 2, 120), y: r.y + r.height / 2 };
    }, candidate.key);
    if (!rect) throw new Error(`行不见了：${candidate.key}`);
    await page.mouse.click(rect.x, rect.y, { label: `点正文行 ${candidate.line}` });
    await waitFor(
      page,
      (key) => {
        const node = document.querySelector(`.reading-line[data-key="${key}"]`);
        return Boolean(node && node.classList.contains("is-editing"));
      },
      `行进入编辑态：${candidate.key}`,
      15000,
      candidate.key
    );
    await page.keyboard.press("Meta+A");
    await page.keyboard.type(`${candidate.base}${suffix}${i + 1}`);
    await page.keyboard.press("Escape");
    await waitFor(
      page,
      (key) => {
        const node = document.querySelector(`.reading-line[data-key="${key}"]`);
        if (!node || node.classList.contains("is-editing")) return false;
        const chip = document.getElementById("reading-draft-chip");
        return Boolean(chip && !chip.hidden && /未提交\s*[1-9]/.test(chip.innerText || ""));
      },
      `行保存为草稿（未提交计数增加）：${candidate.key}`,
      20000,
      candidate.key
    );
    const after = await page.evaluate((key) => {
      const node = document.querySelector(`.reading-line[data-key="${key}"]`);
      return node ? (node.innerText || "").replace(/草稿.*$/, "").trimEnd() : null;
    }, candidate.key);
    edits.push({
      ...candidate,
      expected: `${candidate.base}${suffix}${i + 1}`,
      after,
    });
  }

  const chip = await page.evaluate(
    () => (document.getElementById("reading-draft-chip") || {}).innerText || ""
  );
  return { edits, draftChip: chip, screenshot: await screenshot(page, cfg, "edited") };
}

async function submit(page, cfg) {
  await ensureReading(page);
  const before = await page.evaluate(() => ({
    chip: (document.getElementById("reading-draft-chip") || {}).innerText || "",
    submit: (document.getElementById("reading-submit") || {}).innerText || "",
    disabled: Boolean((document.getElementById("reading-submit") || {}).disabled),
  }));
  if (before.disabled) throw new Error(`没有可提交的草稿（按钮禁用）：${before.chip}`);
  const dialog = page.acceptDialog();
  await page.click("#reading-submit", { label: "提交草稿" });
  await dialog.catch(() => {});
  let cleared = false;
  let alertText = "";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await waitFor(
        page,
        () => {
          const chip = document.getElementById("reading-draft-chip");
          const button = document.getElementById("reading-submit");
          const hidden = !chip || chip.hidden || !/未提交\s*[1-9]/.test(chip.innerText || "");
          return hidden && Boolean(button && button.disabled);
        },
        "草稿清空、提交按钮禁用",
        15000
      );
      cleared = true;
      break;
    } catch (error) {
      // 可能的第二个对话框：部分条目提交失败时应用会 alert（此时页面被原生弹窗挡住）。
      const handled = await page.acceptDialog().catch(() => null);
      alertText = String(handled || "") || alertText;
    }
  }
  if (!cleared) {
    throw new Error(`提交后草稿没有清空（可能有失败弹窗：${alertText || "未捕获到文本"}）`);
  }
  return {
    before,
    after: await page.evaluate(() => ({
      chip: (document.getElementById("reading-draft-chip") || {}).innerText || "",
      submit: (document.getElementById("reading-submit") || {}).innerText || "",
      progress: (document.getElementById("reading-progress-text") || {}).innerText || "",
    })),
    screenshot: await screenshot(page, cfg, "submitted"),
  };
}

async function undo(page, cfg) {
  await ensureReading(page);
  await page.evaluate(() => {
    window.__qaMutations = 0;
    const stream = document.getElementById("reading-stream");
    const observer = new MutationObserver(() => {
      window.__qaMutations += 1;
    });
    observer.observe(stream, { childList: true, subtree: true });
    window.__qaObserver = observer;
  });
  await page.click("#reading-more-open", { label: "打开更多菜单" });
  await waitFor(
    page,
    () => {
      const menu = document.getElementById("reading-more-menu");
      return Boolean(menu && !menu.hidden);
    },
    "更多菜单展开",
    15000
  );
  const dialog = page.acceptDialog();
  await page.click("#reading-undo", { label: "撤回上次提交" });
  await dialog.catch(() => {});
  // 撤销是否成功以**库**为准（Python 侧轮询指纹）。这里只等界面别停在旧内容：
  // 有重渲染就等它稳定，没有也不硬判失败——DOM 变更数不是撤销的判据。
  let mutated = false;
  try {
    await waitFor(page, () => (window.__qaMutations || 0) > 20, "阅读流重新渲染", 20000);
    mutated = true;
  } catch (error) {
    // 可能弹了「没有可撤销的操作」之类的 alert；应答掉，让后续检查能跑
    await page.acceptDialog().catch(() => {});
  }
  return {
    mutated,
    progress: await page.evaluate(
      () => (document.getElementById("reading-progress-text") || {}).innerText || ""
    ),
    screenshot: await screenshot(page, cfg, "undone"),
  };
}

// ---------------------------------------------------------------- 导出

async function exportStep(page, cfg) {
  const snapshot = await step(page, cfg, "export");
  const previewButton = await page.evaluate(() => {
    const button = document.getElementById("export-preview-btn");
    return Boolean(button && !button.disabled);
  });
  if (!previewButton) {
    return { ...snapshot, preview: null, note: "预览按钮不可用" };
  }
  await page.click("#export-preview-btn", { label: "打开导出预览" });
  await waitFor(
    page,
    () => {
      const node = document.getElementById("compare-segments");
      const meta = document.getElementById("compare-meta");
      return Boolean((node && (node.innerText || "").trim()) || (meta && (meta.innerText || "").trim()));
    },
    "导出预览渲染",
    180000
  );
  const preview = await page.evaluate(() => ({
    compareMeta: (document.getElementById("compare-meta") || {}).innerText || "",
    segments: document.querySelectorAll("#compare-segments .compare-seg, #compare-segments li").length,
    text: (document.getElementById("compare-segments") || {}).innerText || "",
  }));
  await page.click("#export-btn", { label: "执行导出" });
  await waitFor(
    page,
    () => {
      const result = document.getElementById("export-result");
      const meta = document.getElementById("export-result-meta");
      return Boolean(result && !result.hidden && meta && (meta.innerText || "").trim());
    },
    "导出结果出现",
    180000
  );
  const written = await page.evaluate(() => ({
    meta: (document.getElementById("export-result-meta") || {}).innerText || "",
    files: [...document.querySelectorAll("#export-files li")].map((item) =>
      (item.innerText || "").replace(/\s*下载\s*$/, "").trim()
    ),
    error: (document.getElementById("export-error") || {}).innerText || "",
  }));
  return {
    ...snapshot,
    preview,
    written,
    screenshot: await screenshot(page, cfg, "export-result"),
  };
}
