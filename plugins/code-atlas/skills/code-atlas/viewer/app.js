/* Offline viewer. Authored content is always inserted as text, never HTML. */
(async () => {
  "use strict";
  await (window.ATLAS_READY || Promise.resolve());
  const $ = (id) => document.getElementById(id);
  const index = window.ATLAS_INDEX;
  const display = window.AtlasPackage.display;
  if (document.body.classList.contains("atlas-empty")) return;
  const chunks = window.ATLAS_CHUNKS = window.ATLAS_CHUNKS || {};
  const pending = new Map();
  const levelNames = { country: "國家 · 系統", city: "城市 · 模組", town: "鄉鎮 · 功能", resident: "鎮民 · 規則項目" };
  const typeNames = { operation: "使用者操作", job: "背景作業", rule: "商業規則", uncovered: "尚未歸類" };
  const roleNames = { screen: "畫面", api: "API 入口", logic: "商業邏輯", data: "資料", config: "設定" };
  let countryId = null, focusId = null, tree = null, view = null, animation = null;
  let navigation = 0, searchVersion = 0, searchTimer = null;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function button(text, action, className) {
    const node = element("button", text, className);
    node.type = "button";
    node.addEventListener("click", action);
    return node;
  }
  function announce(text) { $("status").textContent = text; }
  function message(title, detail, retry) {
    const box = $("map-message");
    box.replaceChildren(element("h2", title), element("p", detail));
    if (retry) box.append(button("重新載入", retry, "quiet-button"));
    box.hidden = false;
  }
  function section(parent, title) {
    const node = element("section", null, "detail-section");
    node.append(element("h3", title));
    parent.append(node);
    return node;
  }
  function items(parent, values) {
    if (!values || !values.length) return;
    const list = element("ul");
    values.forEach((rule) => {
      const item = element("li", display.ruleText(rule));
      if (typeof rule !== "string") {
        item.dataset.ruleId = rule.id; item.tabIndex = -1;
        if (rule.status === "uncertain") {
          item.prepend(element("span", "待確認", "rule-status"));
          item.append(element("p", rule.reason, "rule-reason"));
        }
        if (rule.dependsOn?.length) {
          const links = element("div", "依據規則：", "rule-dependencies");
          rule.dependsOn.forEach((id) => links.append(button(id, () => locateRule(id), "rule-link")));
          item.append(links);
        }
      }
      list.append(item);
    });
    parent.append(list);
  }
  function evidence(parent, records) {
    (records || []).forEach((record) => {
      const item = element("div", null, "evidence");
      item.append(element("span", roleNames[record.role] || "程式位置", "evidence-label"));
      const location = display.evidenceLocation(record, index);
      item.append(element("code", location + (record.symbol ? "\n" + record.symbol : ""), "code-line"));
      parent.append(item);
    });
  }
  function allNodes(country) {
    const result = [country];
    (country.cities || []).forEach((city) => { result.push(city); result.push(...(city.towns || [])); });
    return result;
  }
  function findKnown(id) {
    for (const country of Object.values(chunks)) {
      const node = allNodes(country).find((candidate) => candidate.id === id);
      if (node) return { country, node };
    }
    return null;
  }
  function loadCountry(id) {
    if (chunks[id]) return Promise.resolve(chunks[id]);
    if (pending.has(id)) return pending.get(id);
    const meta = index.countries.find((country) => country.id === id);
    if (!meta) return Promise.reject(new Error("地圖中找不到這個國家。"));
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const fail = () => { script.remove(); pending.delete(id); reject(new Error("無法讀取「" + meta.name + "」的文件。請確認整個 build 資料夾都已保留。")); };
      script.src = meta.chunk;
      script.onload = () => {
        clearTimeout(timeout);
        if (!chunks[id]) { fail(); return; }
        pending.delete(id);
        resolve(chunks[id]);
      };
      script.onerror = () => { clearTimeout(timeout); fail(); };
      const timeout = setTimeout(fail, 10000);
      document.head.append(script);
    });
    pending.set(id, promise);
    return promise;
  }
  function makeTree(country) {
    const data = country || { id: "__atlas_root__", name: "專案全景", level: "world", cities: index.countries };
    return d3.pack().size([580, 580]).padding((node) => node.depth < 2 ? 17 : 7)(
      d3.hierarchy(data, (node) => node.cities || node.towns || node.residents)
        .sum((node) => (node.cities || node.towns || node.residents || []).length ? 0 : Math.max(1, node.townCount || 1))
        .sort((a, b) => b.value - a.value)
    );
  }
  function shortName(text, width) {
    const letters = Array.from(text || "");
    const length = Math.max(3, Math.floor(width / 17));
    return letters.length > length ? letters.slice(0, length - 1).join("") + "…" : text;
  }
  function countLabel(node) {
    if (node.data.level === "country") return (node.data.cities || []).length + " 個城市";
    if (node.data.level === "city") return (node.data.towns ? node.data.towns.length : node.data.townCount || 0) + " 個鄉鎮";
    if (node.data.level === "town") return (node.data.residents || []).length ? node.data.residents.length + " 位鎮民" : (typeNames[node.data.type] || "功能說明");
    return "";
  }
  function renderMap(nextFocus, reset) {
    const svg = d3.select("#map");
    const descendants = tree.descendants();
    const target = descendants.find((node) => node.data.id === nextFocus) || tree;
    // Scale the margin with the selected circle so tiny towns still fill the view.
    const diameter = Number.isFinite(target.r) && target.r > 0
      ? target.r * 2 * (1 + 38 / 580)
      : 1;
    const destination = [target.x, target.y, diameter];
    const targetScale = 580 / diameter;
    // Only the active branch is drawn. Full text lives in the keyboard-accessible list.
    const visible = descendants.filter((node) => {
      if (node === tree && !countryId) return false;
      if (node === target) return true;
      if (node.parent === target) return true;
      return node.parent && node.parent.parent === target && node.r * targetScale >= 11;
    });
    const groups = svg.selectAll("g.map-node").data(visible, (node) => node.data.id || "resident:" + node.parent.data.id + ":" + node.data.name);
    groups.exit().remove();
    const entered = groups.enter().append("g").attr("class", "map-node");
    entered.append("circle");
    entered.append("title");
    entered.append("text").attr("class", "node-name");
    entered.append("text").attr("class", "node-count");
    const merged = entered.merge(groups).order();
    merged.each(function(node) {
      const group = d3.select(this);
      const actionable = node.parent === target;
      const context = node !== target && node.parent !== target;
      const uncharted = (node.data.id || "").startsWith("uncharted") || countryId === "uncharted";
      const level = node.data.level || "resident";
      group.attr("class", "map-node" + (actionable ? " is-action" : "") + (context ? " is-context" : "") + (uncharted ? " is-uncharted" : ""));
      group.attr("role", actionable ? "button" : null).attr("tabindex", actionable ? 0 : null);
      group.attr("aria-label", actionable ? node.data.name + "，" + (levelNames[level] || "") : null);
      group.select("title").text(node.data.name || "");
      const fills = { country: "#e1efe8", city: "#c4ded3", town: "#edf5f0", resident: "#accdbd" };
      group.select("circle").attr("fill", uncharted ? (level === "town" ? "#fcf7ee" : "#efe1c9") : fills[level] || "#e1efe8")
        .attr("stroke", uncharted ? "#bd955d" : (node === target ? "#8eb5a4" : "#a5c7b7"));
      const showLabel = (actionable || (node === target && !node.children)) && node.r * targetScale > 21;
      const labelWidth = Math.max(40, node.r * targetScale * 1.5);
      group.select(".node-name").text(showLabel ? shortName(node.data.name, labelWidth) : "");
      group.select(".node-count").text(showLabel && node.r * targetScale > 48 ? countLabel(node) : "");
      group.on("click", actionable ? (event) => { event.stopPropagation(); activateNode(node); } : null);
      group.on("keydown", actionable ? (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activateNode(node); }
      } : null);
    });
    function draw(values) {
      const scale = 580 / values[2];
      merged.attr("transform", (node) => "translate(" + ((node.x - values[0]) * scale + 380) + "," + ((node.y - values[1]) * scale + 320) + ")");
      merged.select("circle").attr("r", (node) => Math.max(0, node.r * scale));
      merged.select(".node-name").attr("dy", (node) => node.r * targetScale > 48 && countLabel(node) ? -8 : 0)
        .style("font-size", (node) => node.r * targetScale < 65 ? "12px" : "17px");
      merged.select(".node-count").attr("dy", 18);
      view = values;
    }
    if (animation) cancelAnimationFrame(animation);
    if (reset || !view || reduced.matches) { draw(destination); return; }
    const interpolate = d3.interpolateZoom(view, destination);
    let start;
    function frame(time) {
      if (start === undefined) start = time;
      const progress = Math.min(1, (time - start) / 460);
      draw(interpolate(d3.easeCubicOut(progress)));
      if (progress < 1) animation = requestAnimationFrame(frame);
      else animation = null;
    }
    animation = requestAnimationFrame(frame);
  }
  function activateNode(node) {
    if (node.data.id) navigate(node.data.id);
    else {
      const target = [...$("detail-content").querySelectorAll("[data-resident]")].find((item) => item.dataset.resident === node.data.name);
      if (target) { target.scrollIntoView({ block: "center" }); target.focus({ preventScroll: true }); }
      announce("鎮民：" + node.data.name);
    }
  }
  async function locateRule(id) {
    const token = navigation;
    try {
      for (const country of index.countries) {
        const loaded = await loadCountry(country.id);
        if (token !== navigation) return;
        const owner = allNodes(loaded).find((node) => [...(node.rules || []), ...(node.residents || []).flatMap((item) => item.rules || [])]
          .some((rule) => typeof rule !== "string" && rule.id === id));
        if (!owner) continue;
        if (focusId !== owner.id) await navigate(owner.id);
        const target = [...$("detail-content").querySelectorAll("[data-rule-id]")].find((item) => item.dataset.ruleId === id);
        if (target) { target.scrollIntoView({ block: "center" }); target.focus({ preventScroll: true }); announce("已定位規則：" + id); }
        return;
      }
      announce("此地圖找不到規則：" + id);
    } catch (error) { message("無法定位規則", error.message, () => locateRule(id)); }
  }
  function renderBreadcrumbs(node) {
    const bar = $("breadcrumbs");
    bar.replaceChildren();
    const links = [{ id: null, name: "專案全景" }];
    if (node) {
      const country = chunks[countryId];
      links.push(country);
      if (node.level !== "country") {
        const city = country.cities.find((item) => item.id === node.id || item.towns.some((town) => town.id === node.id));
        if (city) links.push(city);
        if (node.level === "town") links.push(node);
      }
    }
    links.forEach((link, i) => {
      if (i) bar.append(element("span", "/", "crumb-divider"));
      const item = button(link.name, () => navigate(link.id));
      if (i === links.length - 1) item.setAttribute("aria-current", "location");
      bar.append(item);
    });
  }
  function nodeList(parent, nodes, title) {
    const block = section(parent, title);
    if (!nodes.length) { block.append(element("p", "這裡還沒有可顯示的項目。", "detail-empty")); return; }
    const list = element("div", null, "node-list");
    let shown = 0;
    const more = button("顯示更多", showMore, "quiet-button");
    function showMore() {
      nodes.slice(shown, shown + 60).forEach((node) => {
        const entry = button(null, () => navigate(node.id), "node-link");
        entry.append(element("span", node.name));
        const count = node.towns ? node.towns.length + " 鄉鎮" : node.cities ? node.cities.length + " 城市" : typeNames[node.type] || "查看";
        entry.append(element("small", count));
        list.append(entry);
      });
      shown += 60;
      more.hidden = shown >= nodes.length;
    }
    showMore(); block.append(list, more);
  }
  function renderDetails(node) {
    const panel = $("detail-content");
    panel.replaceChildren();
    const isWorld = !node;
    node = node || { name: "從全貌，走進細節。", summary: "每個圓是一段程式背後的業務。選一個國家，看看它的模組，再深入鄉鎮中的操作、規則與程式位置。" };
    const heading = element("div", null, "detail-heading");
    heading.append(element("h2", node.name)); panel.append(heading);
    const tag = isWorld ? "國家 → 城市 → 鄉鎮" : levelNames[node.level] || "功能說明";
    panel.append(element("span", tag, "level-tag" + ((node.id || "").startsWith("uncharted") ? " warning" : "")));
    if (node.level === "town") panel.append(element("h3", "功能流程"));
    panel.append(element("p", node.summary || "此項目的規則與程式位置如下。", "detail-summary"));
    if (isWorld) {
      const versions = display.repositoryVersions(index);
      if (versions.length) items(section(panel, "分析來源版本"), versions);
      nodeList(panel, index.countries, "探索國家");
      const block = section(panel, "文件覆蓋率");
      const coverage = index.coverage;
      block.append(element("p", coverage.covered + " / " + coverage.total + " 個 API 與畫面已歸類"));
      const track = element("div", null, "coverage-track");
      const fill = element("div", null, "coverage-fill");
      fill.style.width = Math.max(0, Math.min(100, coverage.percent)) + "%";
      track.append(fill); block.append(track);
      block.append(element("p", "未歸類項目收在「未開發地區」。覆蓋率依原始文件計算。" + (index.hiddenCount ? " 人工隱藏 " + index.hiddenCount + " 個節點，不影響覆蓋率。" : ""), "coverage-caption"));
      if (index.warnings.length) items(section(panel, "檢查提醒"), index.warnings);
      return;
    }
    if (node.cities) nodeList(panel, node.cities, "城市 · 模組");
    if (node.towns) nodeList(panel, node.towns, "鄉鎮 · 功能");
    if (node.actors && node.actors.length) items(section(panel, "使用角色"), node.actors);
    if (node.type) section(panel, "觸發方式").append(element("p", typeNames[node.type] || node.type));
    if (node.rules && node.rules.length) items(section(panel, node.level === "town" ? "共通商業規則" : "商業規則"), node.rules);
    else if (node.level === "town") section(panel, "共通商業規則").append(element("p", "此地圖尚未提供共通規則", "detail-empty"));
    if (node.residents && node.residents.length) {
      const block = section(panel, "鎮民 · 各自的規則");
      node.residents.forEach((resident) => {
        const item = element("div", null, "resident");
        item.dataset.resident = resident.name; item.tabIndex = -1;
        item.append(element("h4", resident.name)); items(item, resident.rules); block.append(item);
      });
    }
    let references = panel;
    if (node.level === "town") {
      references = element("details", null, "technical-reference");
      references.append(element("summary", "技術參考"));
      items(section(references, "Git 來源版本"), display.repositoryVersions(index));
      display.evidenceGroups(node).forEach((group) => evidence(section(references, group.label), group.records));
      panel.append(references);
    }
    [["screens", "相關畫面"], ["endpoints", "API 入口"], ["data", "資料與實體"]].forEach(([key, title]) => {
      if (!node[key] || !node[key].length) return;
      const block = section(references, title);
      node[key].forEach((value) => block.append(element("code", key === "data" ? value : display.referenceLabel(value, index), "code-line")));
    });
    if (node.level !== "town" && node.evidence && node.evidence.length) evidence(section(panel, "程式位置"), node.evidence);
    if (node.dependsOn && node.dependsOn.length) {
      const block = section(panel, "依賴關係");
      node.dependsOn.forEach((id) => block.append(button(findKnown(id)?.node.name || id, () => navigate(id), "node-link")));
    }
  }
  async function navigate(id, updateHash = true) {
    const token = ++navigation;
    $("search-results").hidden = true;
    $("map-message").hidden = true;
    $("globe").href = "index.html" + (id ? "#" + encodeURIComponent(id) : "");
    if (!id) {
      const reset = countryId !== null;
      countryId = focusId = null;
      tree = makeTree(null);
      renderMap(null, reset); renderBreadcrumbs(null); renderDetails(null);
      $("map-title").textContent = "專案全景";
      $("map-subtitle").textContent = "由系統開始，探索每一個功能。";
      $("map-count").textContent = index.countries.length + " 個國家 · " + index.countries.reduce((sum, country) => sum + country.cities.length, 0) + " 個城市";
      $("back").hidden = true;
      if (!index.countries.length) message("地圖準備好了，等待第一個國家。", "目前還沒有功能文件。新增國家與城市說明後，重新建置即可開始探索。");
      if (updateHash && location.hash) history.replaceState(null, "", location.pathname + location.search);
      announce("專案全景"); return;
    }
    try {
      let found = findKnown(id);
      if (!found) {
        const meta = index.countries.find((country) => country.id === id || country.cities.some((city) => city.id === id));
        message("正在展開地圖…", "讀取這個國家的功能文件。");
        if (meta) await loadCountry(meta.id);
        else {
          // Deep links and explicit search may refer to a moved town in another country.
          for (const country of index.countries) {
            await loadCountry(country.id);
            if (findKnown(id)) break;
          }
        }
        found = findKnown(id);
      }
      if (token !== navigation) return;
      if (!found) throw new Error("此節點不存在或已被隱藏。請回到全景，或重新搜尋。");
      const reset = countryId !== found.country.id;
      countryId = found.country.id; focusId = id;
      if (reset || !tree) tree = makeTree(found.country);
      $("map-message").hidden = true;
      renderMap(id, reset); renderBreadcrumbs(found.node); renderDetails(found.node);
      $("map-title").textContent = found.node.name;
      $("map-subtitle").textContent = levelNames[found.node.level] + (found.node.type ? " · " + (typeNames[found.node.type] || "") : "");
      const children = found.node.cities || found.node.towns || found.node.residents || [];
      $("map-count").textContent = found.node.level === "country" ? children.length + " 個城市" : found.node.level === "city" ? children.length + " 個鄉鎮" : children.length ? children.length + " 位鎮民" : "程式與商業規則，見功能說明";
      $("back").hidden = false;
      if (found.node.level === "country" && !children.length) message("這個國家還沒有城市", "可以回到全景探索其他系統，或補上這裡的模組文件。");
      if (found.node.level === "city" && !children.length) message("這個城市目前沒有可顯示的鄉鎮", "人工搬移或隱藏可能改變地圖的內容。可從麵包屑回到上一層。");
      if (updateHash && location.hash !== "#" + encodeURIComponent(id)) history.replaceState(null, "", "#" + encodeURIComponent(id));
      announce(found.node.name + "，" + levelNames[found.node.level]);
    } catch (error) {
      if (token !== navigation) return;
      message("地圖無法展開", error.message, () => navigate(id));
      announce(error.message);
    }
  }
  function goBack() {
    if (!focusId || !countryId) return navigate(null);
    const country = chunks[countryId];
    if (focusId === countryId) return navigate(null);
    const city = country.cities.find((candidate) => candidate.id === focusId || candidate.towns.some((town) => town.id === focusId));
    navigate(city && city.id !== focusId ? city.id : countryId);
  }
  async function search() {
    clearTimeout(searchTimer);
    const version = ++searchVersion;
    const query = $("search-input").value.trim().toLocaleLowerCase();
    const results = $("search-results");
    results.replaceChildren();
    if (!query) { results.hidden = true; announce("請輸入功能名稱或程式位置"); return; }
    results.hidden = false;
    results.append(element("p", "搜尋所有國家的功能文件…", "search-note"));
    try {
      await Promise.all(index.countries.map((country) => loadCountry(country.id)));
      if (version !== searchVersion) return;
      const matches = [];
      index.countries.forEach((meta) => {
        allNodes(chunks[meta.id]).forEach((node) => {
          if (display.searchText(node, index).includes(query)) matches.push({ node, country: meta });
        });
      });
      results.replaceChildren(element("p", matches.length ? "找到 " + matches.length + " 個項目" + (matches.length > 60 ? "，先顯示 60 個；可增加關鍵字縮小範圍。" : "") : "找不到符合的功能。試試模組名稱、API 路徑或程式檔名。", "search-note"));
      matches.slice(0, 60).forEach(({ node, country }) => {
        const result = button(null, () => { searchVersion++; navigate(node.id); }, "search-result");
        result.append(element("strong", node.name), element("small", country.name + " / " + (levelNames[node.level] || "功能")));
        results.append(result);
      });
      announce("搜尋找到 " + matches.length + " 個項目");
    } catch (error) {
      if (version !== searchVersion) return;
      results.replaceChildren(element("p", error.message, "search-note"), button("重試搜尋", search, "search-result"));
    }
  }
  if (!index || !window.d3) {
    message("地圖資料尚未就緒", "缺少地圖資料或本地 D3。請重新執行 build，並保留整個輸出資料夾。");
    $("detail-content").append(element("p", "目前無法讀取地圖。", "notice"));
    return;
  }
  $("project-name").textContent = index.projectName;
  document.title = index.projectName + " · Code Atlas";
  $("coverage").textContent = "文件覆蓋 " + index.coverage.percent + "% · " + index.coverage.covered + "/" + index.coverage.total;
  const date = new Date(index.generatedAt);
  $("build-time").textContent = "建置於 " + (Number.isNaN(date.getTime()) ? index.generatedAt : date.toLocaleString("zh-TW", { dateStyle: "medium", timeStyle: "short" }));
  $("home").addEventListener("click", () => navigate(null));
  document.querySelector(".skip-link").addEventListener("click", (event) => {
    event.preventDefault();
    $("details").focus({ preventScroll: true });
    $("details").scrollIntoView({ block: "start", behavior: "instant" });
  });
  $("back").addEventListener("click", goBack);
  $("coverage").addEventListener("click", () => navigate(index.countries.some((country) => country.id === "uncharted") ? "uncharted" : null));
  $("search-form").addEventListener("submit", (event) => { event.preventDefault(); search(); });
  $("search-input").addEventListener("input", () => { clearTimeout(searchTimer); searchVersion++; searchTimer = setTimeout(search, 240); });
  document.addEventListener("click", (event) => { if (!$("search-form").contains(event.target)) { $("search-results").hidden = true; searchVersion++; } });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const references = $("detail-content").querySelector(".technical-reference[open]");
    if (references) { event.preventDefault(); references.open = false; references.querySelector("summary").focus(); return; }
    if (!$("search-results").hidden) { $("search-results").hidden = true; searchVersion++; $("search-input").focus(); }
    else if (event.target.tagName !== "INPUT") goBack();
  });
  function hashTarget() {
    try { return decodeURIComponent(location.hash.slice(1)) || null; }
    catch { return null; }
  }
  window.addEventListener("hashchange", () => navigate(hashTarget(), false));
  navigate(hashTarget(), false);
})();
