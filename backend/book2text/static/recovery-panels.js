/**
 * 锁冲突 / 废纸篓 / 项目备份（片 7）—— `window.RecoveryPanels`
 *
 * 三个顶层 mask，各一个根：
 * - `#lock-conflict-mask`（7 个 id）：项目锁挡住删除/打开时的说明与强制接管；
 * - `#trash-panel`（4 个 id）：已删除项目的恢复 / 彻底删除；
 * - `#backups-mask`（6 个 id）：项目备份列表与整库恢复。
 * 入口按钮 `#trash-open`（项目库顶栏）与 `#backups-open`（页面 › ⋯）归各自的视图/外壳，
 * 接到导出的 openTrashPanel / openBackups；`showLockConflict(entry, lock, action)` 由 API 错误路径调。
 *
 * 状态随迁：lockConflictTarget · backupsData · backupSelected。
 * 写盘：GET /api/trash · POST /api/trash/{id}/restore · DELETE /api/trash/{id}?confirm=true ·
 *       GET /projects/{id}/backups · POST /backups/{name}/restore · DELETE 项目（force）· POST close。
 */

(function () {
  "use strict";

  let injected = {};
  let lockRoot = null;
  let trashRoot = null;
  let backupsRoot = null;
  const lPart = (id) => (lockRoot ? lockRoot.querySelector(`#${id}`) : null);
  const tPart = (id) => (trashRoot ? trashRoot.querySelector(`#${id}`) : null);
  const bPart = (id) => (backupsRoot ? backupsRoot.querySelector(`#${id}`) : null);

let lockConflictTarget = null;

function lockStampText(value) {
  if (!value) return "时间未知";
  const then = new Date(value);
  if (Number.isNaN(then.getTime())) return value.slice(0, 16);
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(then.getMonth() + 1)}-${pad(then.getDate())} ${pad(then.getHours())}:${pad(then.getMinutes())}`;
}

function lockSourceText(lock) {
  const host = lock.hostname || "未知主机";
  if (lock.host_note === "本机") return `${host}（本机）`;
  if (lock.host_note === "本机以前的名字") return `${host}（本机以前的名字）`;
  return `${host}（另一台电脑）`;
}

/** "12 天前" → "12 天"（写进"已经 N 天没有心跳"这种句子时不能带"前"）。 */
function lockSpanText(lock) {
  const text = String(lock.age_text || "").replace(/前$/, "");
  return text || "很久";
}

function lockStateText(lock) {
  if (!lock.expired) {
    return lock.host_note === "另一台电脑"
      ? "另一台电脑的心跳正常，它还在写这个项目"
      : `进程 ${lock.pid} 还在写这个项目`;
  }
  if (lock.host_note === "另一台电脑") {
    return `已经 ${lockSpanText(lock)}没有心跳，这把锁已过期`;
  }
  return `进程 ${lock.pid} 已不存在，这把锁已过期`;
}

/** 画"锁挡住操作"的对话框。`action` 是 "delete" 或 "open"。 */
function showLockConflict(entry, lock, action) {
  lockConflictTarget = { entry, lock, action };
  const expired = Boolean(lock && lock.expired);
  const force = lPart("lock-conflict-force");
  lPart("lock-conflict-error").hidden = true;
  lPart("lock-conflict-title").textContent = expired
    ? "这把锁已过期，可以直接接管"
    : "项目正被另一个窗口使用";
  lPart("lock-conflict-text").textContent = expired
    ? "锁的持有进程已经不在了，留着它只会一直挡住你。接管这把锁不会动项目里的任何数据。"
    : "同一个项目同时被两处写入可能损坏数据库，所以这里不能替你决定。";
  injected.fillDefinitionList(lPart("lock-conflict-facts"), [
    ["项目", `《${entry.name}》`],
    ["来源", lockSourceText(lock)],
    ["时间", `${lockStampText(lock.last_seen_at)}${lock.age_text ? `（${lock.age_text}）` : ""}`],
    ["状态", lockStateText(lock)],
  ]);
  const advice = lPart("lock-conflict-advice");
  if (action === "delete") {
    advice.textContent = expired
      ? "删除只是把项目移入废纸篓，数据仍在磁盘上，可以随时恢复。"
      : "先在那个窗口里关闭项目（或退出应用），再回来删除。";
  } else {
    advice.textContent = expired
      ? "确认那台电脑已经不再打开这个项目，再接管；接管后会以本机的锁继续。"
      : "如果那个窗口确实是你自己开的，请回那个窗口继续，别同时开两个。";
  }
  // 删除只对"过期锁"给强制；真占用一律不给。打开这条路本来就有「强制打开」。
  force.hidden = action === "open" ? false : !expired;
  force.textContent = action === "open" ? "强制打开" : "强制删除";
  injected.openModal("lock-conflict-mask");
}

async function confirmLockConflict() {
  const target = lockConflictTarget;
  if (!target) return;
  const button = lPart("lock-conflict-force");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = target.action === "open" ? "正在打开…" : "正在删除…";
  lPart("lock-conflict-error").hidden = true;
  try {
    if (target.action === "open") {
      injected.closeModal("lock-conflict-mask");
      await injected.libraryOpen(target.entry.project_id, { force: true });
    } else {
      await injected.apiJson(
        `/api/projects/${target.entry.project_id}?confirm=true&force=true`,
        { method: "DELETE" }
      );
      injected.closeModal("lock-conflict-mask");
      await injected.libraryEnter();
    }
  } catch (error) {
    injected.showError(lPart("lock-conflict-error"), error);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function closeLockConflict() {
  lockConflictTarget = null;
  injected.closeModal("lock-conflict-mask");
}

async function openTrashPanel() {
  tPart("trash-error").hidden = true;
  injected.openModal("trash-panel");
  await loadTrash();
}

async function loadTrash() {
  const list = tPart("trash-list");
  list.innerHTML = "";
  try {
    const data = await injected.apiJson("/api/trash");
    tPart("trash-empty").hidden = data.projects.length > 0;
    for (const entry of data.projects) {
      const row = document.createElement("li");
      row.className = "trash-row";
      const main = document.createElement("div");
      main.className = "trash-row__main";
      const name = document.createElement("div");
      name.className = "trash-row__name";
      name.textContent = `《${entry.name}》`;
      const meta = document.createElement("div");
      meta.className = "trash-row__meta";
      meta.textContent =
        `${entry.page_count} 页` +
        (entry.source_file_name ? ` · ${entry.source_file_name}` : "") +
        ` · 删除于 ${injected.formatMarginTime(entry.deleted_at) || "未知时间"}` +
        (entry.deleted_by ? ` · ${entry.deleted_by}` : "");
      main.append(name, meta);

      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "btn";
      restore.textContent = "恢复";
      restore.addEventListener("click", () => restoreTrashProject(entry));

      const purge = document.createElement("button");
      purge.type = "button";
      purge.className = "btn btn--danger";
      purge.textContent = "彻底删除";
      purge.addEventListener("click", () => purgeTrashProject(entry));

      row.append(main, restore, purge);
      list.append(row);
    }
  } catch (error) {
    injected.showError(tPart("trash-error"), error);
  }
}

async function restoreTrashProject(entry) {
  tPart("trash-error").hidden = true;
  try {
    await injected.apiJson(`/api/trash/${entry.project_id}/restore`, { method: "POST" });
    await loadTrash();
    await injected.libraryEnter();
  } catch (error) {
    injected.showError(tPart("trash-error"), error);
  }
}

async function purgeTrashProject(entry) {
  if (
    !window.confirm(
      `彻底删除《${entry.name}》？\n\n` +
        "项目文件夹会被真正删除，无法恢复。确认继续吗？"
    )
  ) {
    return;
  }
  tPart("trash-error").hidden = true;
  try {
    await injected.apiJson(`/api/trash/${entry.project_id}?confirm=true`, { method: "DELETE" });
    await loadTrash();
  } catch (error) {
    injected.showError(tPart("trash-error"), error);
  }
}

let backupsData = null;
let backupSelected = null;

async function openBackups() {
  backupSelected = null;
  bPart("backups-error").hidden = true;
  injected.openModal("backups-mask");
  await loadBackups();
}

async function loadBackups() {
  const list = bPart("backups-list");
  list.innerHTML = "";
  try {
    const data = await injected.apiJson(`/api/projects/${injected.getCurrentProject().project_id}/backups`);
    backupsData = data.backups || [];
  } catch (error) {
    injected.showError(bPart("backups-error"), error);
    return;
  }
  bPart("backups-foot").textContent = backupsData.length
    ? `共 ${backupsData.length} 份`
    : "这个项目还没有备份";
  bPart("backups-restore").disabled = true;
  for (const item of backupsData) {
    const row = document.createElement("li");
    row.className = "backup-row";
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "backup-pick";
    radio.value = item.name;
    radio.addEventListener("change", () => {
      backupSelected = item;
      bPart("backups-restore").disabled = false;
    });
    const main = document.createElement("div");
    main.className = "backup-row__main";
    const title = document.createElement("div");
    title.textContent = `${injected.formatMarginTime(item.created_at) || item.name} · ${injected.humanBytes(item.size)}`;
    const note = document.createElement("div");
    note.className = "muted";
    note.textContent = `${item.note} · ${item.name}`;
    main.append(title, note);
    row.append(radio, main);
    list.append(row);
  }
}

async function restoreSelectedBackup() {
  if (!backupSelected || !injected.getCurrentProject()) return;
  const projectId = injected.getCurrentProject().project_id;
  const ok = window.confirm(
    `用「${backupSelected.name}」覆盖当前项目库？\n\n` +
      "· 会丢掉这份备份之后的所有改动\n" +
      "· 恢复前会把当前库再备份一份（「恢复前的安全备份」）\n" +
      "· 恢复后会自动重新打开项目"
  );
  if (!ok) return;
  bPart("backups-error").hidden = true;
  const button = bPart("backups-restore");
  button.disabled = true;
  button.textContent = "正在恢复…";
  try {
    // 恢复要求没有写入方：先关项目
    await injected.apiJson(`/api/projects/${projectId}/close`, { method: "POST" }).catch(() => null);
    const data = await injected.apiJson(
      `/api/projects/${projectId}/backups/${encodeURIComponent(backupSelected.name)}/restore?confirm=true`,
      { method: "POST" }
    );
    injected.closeModal("backups-mask");
    await injected.libraryOpen(projectId);
    injected.libraryNotify({ kind: "warning", text: String(`已恢复备份 ${data.from}；恢复前的库另存为 ${data.safety_backup}`).trim() });
  } catch (error) {
    injected.showError(bPart("backups-error"), error);
  } finally {
    button.disabled = false;
    button.textContent = "恢复选中的备份";
  }
}

  let wired = false;
  function wireRecoveryPanels() {
    lPart("lock-conflict-close").addEventListener("click", closeLockConflict);
    lPart("lock-conflict-cancel").addEventListener("click", closeLockConflict);
    lPart("lock-conflict-force").addEventListener("click", confirmLockConflict);
    tPart("trash-close").addEventListener("click", () => injected.closeModal("trash-panel"));
    bPart("backups-close").addEventListener("click", () => injected.closeModal("backups-mask"));
    bPart("backups-cancel").addEventListener("click", () => injected.closeModal("backups-mask"));
    bPart("backups-restore").addEventListener("click", restoreSelectedBackup);
  }

  function init(deps) {
    injected = Object.assign({}, injected, deps || {});
    lockRoot = injected.lockRoot || null;
    trashRoot = injected.trashRoot || null;
    backupsRoot = injected.backupsRoot || null;
    if (!wired && lockRoot && trashRoot && backupsRoot) {
      wired = true;
      wireRecoveryPanels();
    }
    return api;
  }

  const api = {
    init,
    showLockConflict,
    openTrashPanel,
    openBackups,
  };
  window.RecoveryPanels = api;
})();
