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
    // 滚到"整列中间"那一页，而不是 scrollTop = 一半高度：
    // 页图还没载入时 scrollHeight 可能不足，直接设一半会落回顶部（实测发生过）。
    // 打开阅读流是异步的（662 页要拼整本预览）；它完成时会把页列滚回"当前页"。
    // 所以这里反复"滚到中间 → 确认位置站住了"，不是 sleep 一次就信。
    const stuck = await page.evaluate(async (input) => {
      const node = document.querySelector(input.container);
      if (!node) return -1;
      for (let attempt = 0; attempt < 12; attempt += 1) {
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
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (node.scrollTop > 100) return node.scrollTop;
      }
      return node.scrollTop;
    }, { container, tile: tileSelector });
    if (!(stuck > 100)) {
      throw new Error(`页列滚不到中间（scrollTop=${stuck}）：可能被"跟随/重新打开"拽回去了`);
    }
  } else if (scroll === "top") {
    await page.evaluate((sel) => {
      const node = document.querySelector(sel);
      if (node) node.scrollTop = 0;
    }, container);
  }

  // 等"当前可见的页块"都载入完成（占位 thumb 不算完成：必须 is-ready）。
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
  const snapshot = await stepsSnapshot(page);
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
