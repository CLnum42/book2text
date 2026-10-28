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
      tree: rect("#reading-tree"), pdf: rect("#reading-pdf-column"),
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
