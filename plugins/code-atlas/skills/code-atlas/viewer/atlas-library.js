/* Shared, directory-scoped local library. A committed import is opened on a fresh page. */
(() => {
  "use strict";
  const builtin = window.ATLAS_INDEX;
  const namespace = new URL(".", location.href).href;
  const MAX_RECENT = 10;
  let db = null, state = { entries: [], activeId: null }, busy = false;
  const make = (tag, content, className) => {
    const item = document.createElement(tag);
    if (content !== undefined) item.textContent = content;
    if (className) item.className = className;
    return item;
  };
  const button = (label, action, className = "atlas-button") => {
    const item = make("button", label, className);
    item.type = "button";
    item.addEventListener("click", action);
    return item;
  };
  const toolbar = document.querySelector(".topbar, .toolbar");
  const controls = make("div", undefined, "atlas-controls");
  const input = make("input");
  input.type = "file"; input.accept = ".zip,application/zip"; input.id = "atlas-zip-input"; input.hidden = true;
  input.setAttribute("aria-label", "選擇地圖 ZIP");
  const importButton = button("匯入地圖 ZIP", () => input.click(), "atlas-button atlas-primary");
  importButton.id = "atlas-import";
  const recentButton = button("近期載入", () => { renderRecent(); dialog.showModal(); });
  recentButton.id = "atlas-recent";
  recentButton.setAttribute("aria-haspopup", "dialog");
  controls.append(importButton, recentButton, input);
  toolbar.append(controls);
  const notice = make("p", "", "atlas-notice");
  notice.id = "atlas-library-status"; notice.setAttribute("role", "status"); notice.setAttribute("aria-live", "polite"); notice.hidden = true;
  toolbar.append(notice);
  const dialog = make("dialog", undefined, "atlas-dialog");
  dialog.id = "atlas-library-dialog"; dialog.setAttribute("aria-labelledby", "atlas-library-title");
  const heading = make("div", undefined, "atlas-dialog-heading");
  const title = make("h2", "近期載入"); title.id = "atlas-library-title";
  const close = button("關閉", () => dialog.close()); close.setAttribute("aria-label", "關閉近期載入");
  heading.append(title, close);
  const hint = make("p", "最近 10 份地圖保存在這個瀏覽器。刪除紀錄不會刪除電腦上的 ZIP 檔。", "atlas-library-hint");
  const list = make("ul", undefined, "atlas-recent-list");
  const dialogNotice = make("p", "", "atlas-dialog-notice"); dialogNotice.setAttribute("role", "status"); dialogNotice.hidden = true;
  const reset = button("回到內建地圖", () => run(async () => { await change((next) => { next.activeId = null; }); reload(); }));
  reset.hidden = true;
  dialog.append(heading, hint, list, dialogNotice, reset);
  document.body.append(dialog);
  dialog.addEventListener("keydown", (event) => event.stopPropagation());
  dialog.addEventListener("cancel", (event) => event.stopPropagation());
  dialog.addEventListener("close", () => recentButton.focus());
  function message(content, error = false) {
    notice.textContent = content; notice.hidden = !content; notice.classList.toggle("is-error", error);
    dialogNotice.textContent = content; dialogNotice.hidden = !content; dialogNotice.classList.toggle("is-error", error);
  }
  function setBusy(value) {
    busy = value;
    importButton.disabled = value; input.disabled = value; recentButton.disabled = value;
    dialog.querySelectorAll("button").forEach((item) => { item.disabled = value; });
    importButton.textContent = value ? "處理中…" : "匯入地圖 ZIP";
    controls.setAttribute("aria-busy", String(value));
  }
  async function run(action) {
    if (busy) return;
    setBusy(true); message("");
    try { await action(); }
    catch (error) { message(error.message || "無法載入地圖，原本的地圖已保留。", true); }
    finally { setBusy(false); input.value = ""; }
  }
  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error("這個瀏覽器無法保存地圖。請使用允許網站儲存空間的瀏覽器。")); return; }
      let request;
      try { request = indexedDB.open("code-atlas-library-v1:" + namespace, 1); }
      catch { reject(new Error("無法開啟本機地圖儲存空間，請檢查瀏覽器的網站儲存設定。")); return; }
      request.onupgradeneeded = () => request.result.createObjectStore("library");
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(new Error("無法開啟本機地圖儲存空間，請檢查瀏覽器的網站儲存設定。"));
      request.onblocked = () => reject(new Error("地圖儲存空間暫時被其他視窗占用。關閉其他 Code Atlas 視窗後再試。"));
    });
  }
  function read() {
    return new Promise((resolve, reject) => {
      const tx = db.transaction("library", "readonly"), request = tx.objectStore("library").get("state");
      tx.oncomplete = () => resolve(request.result || { entries: [], activeId: null });
      tx.onerror = tx.onabort = () => reject(new Error("無法讀取近期地圖。"));
    });
  }
  function stripLegacyLines(value) {
    if (!value || typeof value !== "object") return false;
    let changed = false;
    if (Array.isArray(value.evidence)) value.evidence.forEach((record) => {
      if (record && typeof record === "object" && Object.hasOwn(record, "line")) {
        delete record.line; changed = true;
      }
    });
    Object.values(value).forEach((child) => { if (stripLegacyLines(child)) changed = true; });
    return changed;
  }
  function change(action) {
    if (!db) return Promise.reject(new Error("無法保存地圖，請允許瀏覽器儲存空間後重新整理。原本的地圖已保留。"));
    return new Promise((resolve, reject) => {
      const tx = db.transaction("library", "readwrite"), store = tx.objectStore("library"), request = store.get("state");
      let next, failure;
      request.onsuccess = () => {
        try { next = request.result || { entries: [], activeId: null }; action(next); store.put(next, "state"); }
        catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => { state = next; resolve(); };
      tx.onerror = tx.onabort = () => reject(failure || new Error("無法保存地圖，可能是瀏覽器空間不足或禁止儲存。原本的地圖與近期紀錄已保留。"));
    });
  }
  function reload() {
    // Discard the previous map's deep link, pending loads, registry and animations together.
    history.replaceState(null, "", location.pathname + location.search);
    location.reload();
  }
  function renderRecent() {
    list.replaceChildren();
    if (!state.entries.length) list.append(make("li", "尚未載入任何地圖。先選擇一份 Code Atlas 地圖 ZIP。", "atlas-no-recent"));
    state.entries.forEach((entry) => {
      const row = make("li", undefined, "atlas-recent-item");
      const information = make("div", undefined, "atlas-recent-info");
      information.append(make("strong", entry.document.manifest.projectName));
      if (entry.id === state.activeId) information.append(make("span", "目前開啟", "atlas-current"));
      information.append(make("span", entry.filename, "atlas-filename"));
      const when = new Date(entry.loadedAt).toLocaleString("zh-TW", { dateStyle: "short", timeStyle: "short" });
      information.append(make("small", "最近載入 " + when));
      AtlasPackage.display.repositoryVersions(entry.document.manifest).forEach((version) => information.append(make("small", version)));
      const actions = make("div", undefined, "atlas-recent-actions");
      const reopen = button("開啟", () => run(async () => {
        await change((next) => {
          const found = next.entries.find((item) => item.id === entry.id);
          if (!found) throw new Error("這份地圖已在其他視窗刪除，請重新匯入 ZIP。");
          found.loadedAt = new Date().toISOString();
          next.entries = [found, ...next.entries.filter((item) => item.id !== entry.id)]; next.activeId = entry.id;
        });
        reload();
      }));
      reopen.setAttribute("aria-label", "開啟 " + entry.document.manifest.projectName + "，" + entry.filename);
      const remove = button("刪除", () => run(async () => {
        let wasActive = false;
        await change((next) => {
          wasActive = next.activeId === entry.id;
          next.entries = next.entries.filter((item) => item.id !== entry.id);
          if (wasActive) next.activeId = null;
        });
        if (wasActive || state.activeId !== (window.ATLAS_ACTIVE_ID || null)) reload();
        else { renderRecent(); message("已刪除近期紀錄。電腦上的 ZIP 檔仍保留。"); close.focus(); }
      }));
      remove.setAttribute("aria-label", "刪除 " + entry.document.manifest.projectName + "，" + entry.filename);
      actions.append(reopen, remove); row.append(information, actions); list.append(row);
    });
    reset.hidden = !state.activeId;
    reset.textContent = builtin?.countries?.length ? "回到內建地圖" : "回到匯入頁";
  }
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (!file) return;
    run(async () => {
      if (!window.AtlasPackage) throw new Error("缺少地圖讀取工具，請保留完整 viewer 資料夾。");
      if (file.size > AtlasPackage.MAX_BYTES) throw new Error("請選擇 32 MiB 以內的地圖 ZIP。");
      message("正在檢查並保存地圖…");
      const bytes = await file.arrayBuffer(), document = AtlasPackage.parse(bytes);
      if (!window.crypto?.subtle) throw new Error("此瀏覽器無法核對地圖，請透過本機網站或 HTTPS 開啟 Code Atlas。");
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const id = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
      await change((next) => {
        next.entries = [{ id, filename: file.name, loadedAt: new Date().toISOString(), document }, ...next.entries.filter((entry) => entry.id !== id)].slice(0, MAX_RECENT);
        next.activeId = id;
      });
      reload();
    });
  });
  function welcome() {
    document.body.classList.add("atlas-empty");
    const area = make("section", undefined, "atlas-welcome");
    area.setAttribute("aria-labelledby", "atlas-welcome-title");
    const title = make("h1", "讓程式的全貌，成為一張地圖"); title.id = "atlas-welcome-title";
    area.append(make("p", "CODE ATLAS", "atlas-welcome-eyebrow"), title,
      make("p", "匯入 Skill 產生的地圖 ZIP，從國家走進城市，再深入每個鄉鎮的功能與規則。"),
      button("選擇地圖 ZIP", () => input.click(), "atlas-button atlas-primary"),
      make("p", "不需解壓縮。地圖只保存在這個瀏覽器，之後可從「近期載入」重新開啟或刪除。", "atlas-library-hint"));
    toolbar.parentElement.insertBefore(area, toolbar.nextSibling);
  }
  setBusy(true);
  window.ATLAS_READY = (async () => {
    try {
      db = await openDatabase(); state = await read();
      // Earlier viewer versions stored generated line numbers. Migrate all recent
      // maps, including inactive ones, before restoring a map into either viewer.
      if (stripLegacyLines(state)) {
        try { await change((next) => { stripLegacyLines(next); }); }
        catch { message("已隱藏舊行號，但無法更新近期紀錄。原地圖仍可閱讀；請允許儲存空間後重新整理。", true); }
      }
      const active = state.entries.find((entry) => entry.id === state.activeId);
      if (active) { window.ATLAS_INDEX = active.document.index; window.ATLAS_CHUNKS = active.document.chunks; window.ATLAS_ACTIVE_ID = active.id; }
    } catch (error) { message(error.message, true); }
    if (!window.ATLAS_INDEX) window.ATLAS_INDEX = { version: 1, projectName: "Code Atlas", generatedAt: new Date().toISOString(), countries: [], parts: [], warnings: [], hiddenCount: 0, coverage: { total: 0, covered: 0, percent: 100 } };
    renderRecent();
    if (!window.ATLAS_INDEX.countries.length) welcome();
    setBusy(false);
  })();
})();
