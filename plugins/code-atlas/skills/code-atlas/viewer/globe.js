/* Code Atlas · layered architecture globe.
   One camera drives a canvas world (stars, a dot-matrix planet, the ground below orbit) and the DOM layers on top.
   Orbit → country is a dive (turn, zoom, ground fades in); country → city → town zooms the clicked tile to fill the stage. */
(async () => {
  "use strict";

  // The library selects an imported/recent package before any data is read.
  const initialTheme = (() => { try { return new URLSearchParams(location.search).get("theme") || localStorage.getItem("atlas-v2-theme"); } catch { return "light"; } })();
  document.documentElement.dataset.theme = initialTheme === "dark" ? "dark" : "light";
  await (window.ATLAS_READY || Promise.resolve());
  const index = window.ATLAS_INDEX;
  if (document.body.classList.contains("atlas-empty") || !index || !window.d3) {
    const theme = document.getElementById("theme-toggle");
    const paintEmptyTheme = () => {
      const dark = document.documentElement.dataset.theme === "dark";
      theme.textContent = dark ? "日間" : "夜間";
      theme.setAttribute("aria-pressed", String(dark));
      document.querySelector('meta[name="theme-color"]').content = dark ? "#02050b" : "#f2f6fa";
    };
    theme.addEventListener("click", () => {
      const name = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = name;
      try { localStorage.setItem("atlas-v2-theme", name); } catch { /* storage is optional */ }
      paintEmptyTheme();
    });
    paintEmptyTheme();
    if (!document.body.classList.contains("atlas-empty")) {
      const box = document.getElementById("stage-message");
      box.textContent = "地圖資料尚未就緒。請重新建置，並保留完整的輸出資料夾。"; box.hidden = false;
    }
    return;
  }
  const DATA = { project: index.projectName, countries: index.countries, coverage: index.coverage || { total: 0, covered: 0 }, builtAt: index.generatedAt };
  const display = window.AtlasPackage.display;
  const chunks = window.ATLAS_CHUNKS = window.ATLAS_CHUNKS || {};
  const pending = new Map();
  const GRID_LIMIT = 48, PAGE = 120;
  let navigation = 0, searchVersion = 0;
  // City ID → the data name chosen there: the city map marks the towns using it and the panel lists every user.
  const dataFocus = new Map(), TITLE_DATA_LIMIT = 8, CITY_PAGE = 30;
  let dataVersion = 0;
  const TAU = Math.PI * 2, DEG = Math.PI / 180;
  const $ = (id) => document.getElementById(id);
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let reduced = motion.matches;
  motion.addEventListener?.("change", (event) => { reduced = event.matches; kick(); });

  const LEVELS = ["orbit", "country", "city", "town"];
  const LEVEL_NAME = { orbit: "軌道", country: "國家", city: "城市", town: "鄉鎮" };
  const LEVEL_EN = { orbit: "ORBIT", country: "SYSTEM", city: "MODULE", town: "FEATURE" };
  const ALTITUDE = { orbit: 20000, country: 1200, city: 120, town: 8 };
  const TYPE_NAME = { operation: "使用者操作", job: "背景作業", rule: "商業規則", uncovered: "尚未歸類" };

  /* ---------- helpers ---------- */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, reduced ? 0 : ms));
  const pad2 = (index) => String(index + 1).padStart(2, "0"); // 0-based index → "01"
  const two = (n) => String(n).padStart(2, "0");
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  const ease = {
    inOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    out: (t) => 1 - Math.pow(1 - t, 4),
    in: (t) => t * t * t,
    linear: (t) => t,
  };
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  // Summaries mark identifiers with backticks; render them as <code> without innerHTML.
  function rich(node, text) {
    for (const part of String(text || "").split(/(`[^`]+`)/)) {
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) node.append(el("code", null, part.slice(1, -1)));
      else if (part) node.append(part);
    }
    return node;
  }
  function button(className, label, onClick) {
    const b = el("button", className, label);
    b.type = "button";
    // The second click of a double-click must not drill one level further.
    if (onClick) b.addEventListener("click", (event) => { if (event.detail <= 1) onClick(event); });
    return b;
  }
  function svgEl(tag, attrs) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const key in attrs) node.setAttribute(key, attrs[key]);
    return node;
  }
  function store(key, value) {
    try { if (value === undefined) return localStorage.getItem(key); localStorage.setItem(key, value); } catch { /* private mode: keep defaults */ }
    return null;
  }

  /* ---------- data ---------- */
  const HUES = [166, 40, 352, 258, 198, 88, 318, 24, 140, 282, 56, 214];
  const nodes = new Map();
  const root = { id: "", level: "orbit", name: DATA.project, children: [], hue: 196, kind: "system" };
  nodes.set("", root);
  DATA.countries.forEach((c, ci) => {
    const hue = c.id === "infra" ? 210 : c.id === "uncharted" ? 40 : HUES[ci % HUES.length];
    const country = { id: c.id, level: "country", name: c.name, data: c, parent: root, children: [], hue, kind: c.id === "infra" || c.id === "uncharted" ? c.id : "system", index: ci };
    country.country = country;
    root.children.push(country); nodes.set(c.id, country);
    (c.cities || []).forEach((k, ki) => {
      const city = { id: k.id, level: "city", name: k.name, data: k, parent: country, country, children: [], hue, kind: country.kind, index: ki };
      country.children.push(city); nodes.set(k.id, city);
    });
  });
  function register(data) {
    const country = nodes.get(data.id);
    if (!country) return;
    country.data = data; country.name = data.name;
    for (const raw of data.cities || []) {
      const city = nodes.get(raw.id);
      if (!city || city.country !== country) continue;
      city.data = raw; city.name = raw.name; city.geometryReady = false;
      city.children = (raw.towns || []).map((t, ti) => {
        const town = { id: t.id, level: "town", name: t.name, data: t, parent: city, country, children: [], hue: country.hue, kind: country.kind, index: ti };
        nodes.set(t.id, town); return town;
      });
    }
  }
  Object.values(chunks).forEach(register);
  function loadCountry(id) {
    if (chunks[id]) {
      // A timed-out script can still execute after removal. Synchronize its cached data
      // before retrying, without replacing already registered node/geometry objects.
      if (nodes.get(id)?.data !== chunks[id]) { register(chunks[id]); rebuildDependencies(); }
      return Promise.resolve(chunks[id]);
    }
    if (pending.has(id)) return pending.get(id);
    const meta = index.countries.find((country) => country.id === id);
    if (!meta) return Promise.reject(new Error("地圖中找不到這個國家。"));
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      let settled = false;
      const fail = () => {
        if (settled) return; settled = true; clearTimeout(timeout); script.remove(); pending.delete(id);
        reject(new Error("無法讀取「" + meta.name + "」的文件。請確認整個輸出資料夾都已保留。"));
      };
      script.src = meta.chunk;
      script.onload = () => {
        if (settled) return;
        if (!chunks[id]) { fail(); return; }
        settled = true; clearTimeout(timeout); pending.delete(id); register(chunks[id]); rebuildDependencies(); resolve(chunks[id]);
      };
      script.onerror = fail;
      const timeout = setTimeout(fail, 10000);
      document.head.append(script);
    });
    pending.set(id, promise); return promise;
  }
  function tally(node) {
    const out = { countries: 0, cities: 0, towns: 0, residents: 0 };
    (function walk(n) {
      if (n.level === "country") out.countries++;
      if (n.level === "city") { out.cities++; if (!chunks[n.country.id]) out.towns += n.data.townCount || 0; }
      if (n.level === "town") { out.towns++; out.residents += (n.data.residents || []).length; }
      n.children.forEach(walk);
    })(node);
    return out;
  }
  const ancestors = (node) => { const list = []; for (let n = node; n; n = n.parent) list.unshift(n); return list; };
  const satOf = (node) => (node.kind === "infra" ? 12 : node.kind === "uncharted" ? 70 : 50);
  // HSL lightness is not perceived lightness: lift blues/violets, hold back yellow-greens so systems read equally bright.
  const bump = (h, at, width) => Math.exp(-(((((h - at + 540) % 360) - 180) / width) ** 2));
  const toneOf = (h) => 60 - 6 * bump(h, 95, 42) + 7 * bump(h, 262, 38) + 3 * bump(h, 222, 22) - 3 * bump(h, 165, 24);

  const usedBy = new Map();
  function rebuildDependencies() {
    usedBy.clear();
    for (const n of nodes.values()) for (const dep of n.data?.dependsOn || []) {
      if (!usedBy.has(dep)) usedBy.set(dep, []);
      usedBy.get(dep).push(n.id);
    }
  }
  rebuildDependencies();
  function dependencyNode(id) {
    if (nodes.has(id)) return nodes.get(id);
    const country = nodes.get(id.split(".")[0]);
    return { id, name: id, country: country?.country || { name: "尚未載入" }, hue: country?.hue || 196, level: "town" };
  }
  function relationsOf(node) {
    const out = [], seen = new Set();
    for (const id of node.data.dependsOn || []) {
      seen.add(id); out.push({ node: dependencyNode(id), label: "依賴", dir: "out" });
    }
    for (const id of usedBy.get(node.id) || []) {
      if (seen.has(id)) { const relation = out.find((r) => r.node.id === id); relation.dir = "both"; relation.label = "互相依賴"; }
      else { seen.add(id); out.push({ node: dependencyNode(id), label: "被依賴", dir: "in" }); }
    }
    return out;
  }
  const countryRoutes = [];
  {
    const seen = new Set();
    for (const n of nodes.values()) {
      if (n.level !== "city") continue;
      for (const dep of n.data.dependsOn || []) {
        const target = nodes.get(dep);
        if (!target || target.country === n.country) continue;
        const key = n.country.id + ">" + target.country.id;
        if (seen.has(key)) continue;
        seen.add(key);
        countryRoutes.push({ from: n.country.index, to: target.country.index, phase: seen.size * 0.37 });
      }
    }
  }

  /* ---------- sphere geometry ---------- */
  const vec = (lon, lat) => { const l = lon * DEG, p = lat * DEG; return [Math.sin(l) * Math.cos(p), Math.sin(p), Math.cos(l) * Math.cos(p)]; };
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const arc = (a, b) => Math.acos(clamp(dot3(a, b), -1, 1));
  const lonLat = (v) => [Math.atan2(v[0], v[2]) / DEG, Math.asin(clamp(v[1], -1, 1)) / DEG];
  function hashString(s) { let h = 2166136261; for (const ch of s) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function hash3(i, j, k) { let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(k, 1440662683); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  // Keep the production weighted Voronoi geography; the same polygons drive dots, maps and hit testing.
  const chart = d3.geoAzimuthalEquidistant().scale(1).translate([0, 0]);
  const weight = (n) => 1 + Math.sqrt(Math.max(1, n));
  const makeTerritory = (polygon) => {
    const plane = Array.from(polygon, (p) => [p[0], p[1]]);
    const xs = plane.map((p) => p[0]), ys = plane.map((p) => p[1]);
    const center = chart.invert(d3.polygonCentroid(plane));
    return { plane, center: vec(...center), bounds: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
  };
  const contains = (entry, p) => entry && p[0] >= entry.bounds[0] && p[1] >= entry.bounds[1] && p[0] <= entry.bounds[2] && p[1] <= entry.bounds[3] && d3.polygonContains(entry.plane, p);
  function seeded(text) {
    let seed = hashString(text);
    return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  }
  function buildWorld() {
    if (!root.children.length) return;
    const raw = root.children.map((c) => weight(tally(c).towns) * (c.kind === "uncharted" ? .5 : 1));
    const floor = Math.max(...raw) * .16;
    const hierarchy = d3.hierarchy({ children: root.children.map((country, i) => {
      const total = Math.max(raw[i], floor);
      const ws = country.children.map((city) => weight(city.data.townCount ?? city.children.length));
      const cw = ws.map((w) => Math.max(w, Math.max(...ws) * .2));
      const sum = cw.reduce((a, b) => a + b, 0);
      return country.children.length ? { node: country, children: country.children.map((city, j) => ({ node: city, value: total * cw[j] / sum })) } : { node: country, value: total };
    }) }).sum((d) => d.children ? 0 : d.value);
    const clip = d3.range(120).map((i) => [1.02 * Math.cos(i / 120 * TAU), 1.02 * Math.sin(i / 120 * TAU)]);
    try {
      d3.voronoiTreemap().clip(clip).prng(seeded(index.projectName + ":" + root.children.length)).maxIterationCount(120).convergenceRatio(.005)(hierarchy);
      if (hierarchy.descendants().some((n) => n.depth && !n.polygon)) throw new Error("incomplete layout");
    } catch {
      const half = 1.02 / Math.SQRT2;
      d3.treemap().size([half * 2, half * 2]).paddingInner(.015)(hierarchy);
      hierarchy.each((n) => { n.polygon = [[n.x0-half,n.y0-half],[n.x1-half,n.y0-half],[n.x1-half,n.y1-half],[n.x0-half,n.y1-half]]; });
    }
    hierarchy.descendants().forEach((n) => { if (n.depth) n.data.node.territory = makeTerritory(n.polygon); });
  }
  buildWorld();
  const terr = root.children.map((country) => {
    const center = country.territory.center, seeds = country.children.map((city) => city.territory.center);
    return { country, center, centroid: center, cityCentroids: seeds.slice(), seeds: seeds.length ? seeds : [center] };
  });
  function landAt(p) {
    const q = chart(lonLat(p));
    for (let i = 0; i < terr.length; i++) {
      const country = terr[i].country;
      if (!contains(country.territory, q)) continue;
      const k = country.children.findIndex((city) => contains(city.territory, q));
      return { t: i, k: Math.max(0, k) };
    }
    return null;
  }

  /* ---------- themes: light (default, 清楚清新) and night ---------- */
  const THEMES = {
    light: {
      bg: "#f2f6fa", star: "#6c8bab", starBright: "#3d6a96", starAlpha: 0.3,
      halo: ["rgba(105, 165, 228, .24)", "rgba(105, 165, 228, .08)", "rgba(105, 165, 228, 0)"],
      ocean: ["#ffffff", "#e5effa", "#b8cfe6"], grat: [40, 90, 140], gratAlpha: 0.11,
      night: ["rgba(40, 70, 110, 0)", "rgba(40, 70, 110, .05)", "rgba(40, 70, 110, .2)"], glare: "rgba(255, 255, 255, .6)",
      rim: ["rgba(255, 255, 255, 1)", "rgba(170, 200, 232, .7)", "rgba(100, 140, 190, .55)"], floor: "rgba(40, 75, 120, .16)",
      ring: "rgba(55, 95, 145, .45)", satellite: "#0a7fc0", satGlow: "rgba(10, 127, 192, .45)",
      route: "rgba(66, 102, 148, .8)", routeHot: "#dc6f2a", pulse: "#0a7fc0", pulseHot: "#dc6f2a",
      dotSat: (s) => Math.min(80, s + 12), dotTone: -14, hotTone: -8, dim: 0.28,
      // Flat map below orbit: pastel provinces, white-ish sea, faded neighbours. [saturation factor, lightness, coast delta]
      // [saturation factor, lightness]; borders: [colour, width], coast lightness for the system in focus.
      map: { ocean: "#e8f0f8", limb: "rgba(110, 160, 220, .55)", hover: "rgba(20, 60, 110, .12)", veil: "rgba(246, 249, 252, .62)", nb: [0.42, 90], sib: [0.55, 88],
        focusL: [82, 74, 87, 70, 78, 85], districtL: [76, 84, 71, 87, 80, 73],
        // A chosen city data name: towns using it keep a clear tone, the rest fade toward the sea.
        unused: [0.15, 94], usedL: (l) => Math.min(l, 78),
        province: ["rgba(255, 255, 255, .95)", 1.8], faint: ["rgba(60, 90, 130, .2)", 1], coast: [42, 1.6] },
    },
    dark: {
      bg: "#02050b", star: "#a9c6e8", starBright: "#dff4ff", starAlpha: 1,
      halo: ["rgba(120, 200, 255, .34)", "rgba(80, 150, 255, .12)", "rgba(40, 80, 200, 0)"],
      ocean: ["#16375f", "#0a1c37", "#030915"], grat: [150, 200, 255], gratAlpha: 0.05,
      night: ["rgba(2, 5, 11, 0)", "rgba(2, 5, 11, .12)", "rgba(2, 5, 11, .74)"], glare: "rgba(190, 230, 255, .08)",
      rim: ["rgba(170, 230, 255, .9)", "rgba(120, 190, 255, .22)", "rgba(90, 140, 255, .04)"], floor: null,
      ring: "rgba(170, 215, 255, .32)", satellite: "#e9f7ff", satGlow: "rgba(143, 227, 255, .9)",
      route: "rgba(196, 228, 255, .85)", routeHot: "#ffe2a8", pulse: "#f2f9ff", pulseHot: "#fff3d6",
      dotSat: (s) => s, dotTone: 0, hotTone: 12, dim: 0.3,
      map: { ocean: "#0a1526", limb: "rgba(143, 227, 255, .5)", hover: "rgba(255, 255, 255, .1)", veil: "rgba(6, 12, 24, .55)", nb: [0.3, 17], sib: [0.35, 20],
        focusL: [32, 26, 38, 22, 29, 35], districtL: [35, 28, 41, 24, 32, 38],
        unused: [0.2, 13], usedL: (l) => Math.max(l, 30),
        province: ["rgba(4, 8, 18, .9)", 1.8], faint: ["rgba(170, 200, 240, .16)", 1], coast: [68, 1.5] },
    },
  };
  // ?theme=dark|light wins (handy for sharing a link), then the viewer's last choice, then light.
  const askedTheme = new URLSearchParams(location.search).get("theme");
  let themeName = (askedTheme in THEMES ? askedTheme : store("atlas-v2-theme")) === "dark" ? "dark" : "light";
  let T = THEMES[themeName];

  const groups = [];
  function paintGroups() {
    for (const g of groups) {
      const s = T.dotSat(g.s), l = g.l + T.dotTone;
      g.color = `hsl(${g.h} ${s}% ${l}%)`;
      g.hot = `hsl(${g.h} ${Math.min(100, s + 10)}% ${clamp(l + T.hotTone, 20, 86)}%)`;
    }
  }
  const DOTS = (() => {
    const N = 26000, golden = Math.PI * (3 - Math.sqrt(5));
    const xs = [], ys = [], zs = [], gs = [], seeds = [];
    const groupIndex = new Map();
    const sums = terr.map((t) => ({ all: [0, 0, 0], cities: t.seeds.map(() => [0, 0, 0]) }));
    terr.forEach((t, ti) => t.seeds.forEach((_, k) => {
      const kind = t.country.kind, h = t.country.hue, s = satOf(t.country), l = (kind === "infra" ? 60 : kind === "uncharted" ? 58 : toneOf(h)) + [0, 9, -6, 13][k % 4];
      groupIndex.set(ti + ":" + k, groups.length);
      groups.push({ t: ti, k, h, s, l, idx: [] });
    }));
    paintGroups();
    for (let i = 0; i < N; i++) {
      const y = 1 - ((i + 0.5) * 2) / N, rad = Math.sqrt(1 - y * y), th = i * golden;
      const p = [Math.cos(th) * rad, y, Math.sin(th) * rad];
      if (p[2] < -0.35) continue; // every territory lives on the front half
      const hit = landAt(p);
      if (!hit || hit.k < 0) continue;
      if (terr[hit.t].country.kind === "uncharted" && i % 2) continue;
      const g = groupIndex.get(hit.t + ":" + hit.k);
      groups[g].idx.push(xs.length);
      xs.push(p[0]); ys.push(p[1]); zs.push(p[2]); gs.push(g); seeds.push(hash3(i, 7, 13));
      const sum = sums[hit.t];
      for (let a = 0; a < 3; a++) { sum.all[a] += p[a]; sum.cities[hit.k][a] += p[a]; }
    }
    terr.forEach((t, ti) => {
      t.cityCentroids = t.seeds.slice();
      t.centroidLL = lonLat(t.centroid);
    });
    return { x: Float32Array.from(xs), y: Float32Array.from(ys), z: Float32Array.from(zs), g: Uint32Array.from(gs), seed: Float32Array.from(seeds), count: xs.length };
  })();

  const dotPoint = (i) => [DOTS.x[i], DOTS.y[i], DOTS.z[i]];
  function ensureTownGeometry(country) {
    for (const city of country.children) {
      if (city.geometryReady) continue;
      city.geometryReady = true;
      if (!city.children.length) continue;
      // Dense modules use the paged card view; no invisible thousands of Voronoi cells are computed.
      if (city.children.length <= GRID_LIMIT) {
        const h = d3.hierarchy({ children: city.children.map((town) => ({ node: town, value: weight((town.data.residents || []).length) })) }).sum((n) => n.value || 0);
        try {
          d3.voronoiTreemap().clip(city.territory.plane).prng(rng(hashString(city.id))).maxIterationCount(100).convergenceRatio(.01)(h);
          if (h.leaves().some((n) => !n.polygon)) throw new Error("incomplete town layout");
          h.leaves().forEach((n) => { n.data.node.territory = makeTerritory(n.polygon); });
        } catch { /* A deterministic nearest-seed subdivision below keeps degenerate regions usable. */ }
      }
      const random = rng(hashString(city.id)), [x0,y0,x1,y1] = city.territory.bounds;
      city.children.forEach((town) => {
        let q = d3.polygonCentroid(city.territory.plane);
        if (!town.territory) for (let i = 0; i < 100; i++) { const candidate = [x0 + random() * (x1-x0), y0 + random() * (y1-y0)]; if (contains(city.territory, candidate)) { q = candidate; break; } }
        town.seed = town.territory?.center || vec(...chart.invert(q)); town.dots = [];
      });
      const group = groups.find((g) => g.t === country.index && g.k === city.index);
      for (const i of group?.idx || []) { const k = townAt(dotPoint(i), city); if (k >= 0) city.children[k].dots.push(i); }
    }
  }
  function townAt(p, city) {
    if (!city?.children.length || city.children.length > GRID_LIMIT) return -1;
    const q = chart(lonLat(p));
    let best = 0, bd = Infinity;
    for (let j = 0; j < city.children.length; j++) {
      const town = city.children[j];
      if (contains(town.territory, q)) return j;
      const d = arc(p, town.seed || city.territory.center);
      if (d < bd) { bd = d; best = j; }
    }
    return best;
  }

  // Routes lift off the surface like flight paths between system centroids.
  const routeCurves = countryRoutes.map((route) => {
    const a = terr[route.from].centroid, b = terr[route.to].centroid, ang = arc(a, b), pts = [];
    for (let i = 0; i <= 48; i++) {
      const t = i / 48, s = Math.sin(ang);
      const k1 = Math.sin((1 - t) * ang) / s, k2 = Math.sin(t * ang) / s, lift = 1 + Math.sin(Math.PI * t) * ang * 0.22;
      pts.push([0, 1, 2].map((j) => (a[j] * k1 + b[j] * k2) * lift));
    }
    return { ...route, pts };
  });

  /* ---------- camera and canvas ---------- */
  const canvas = $("sky"), ctx = canvas.getContext("2d");
  const stage = $("stage"), layersEl = $("layers");
  let W = 0, H = 0, dpr = 1, quality = 1;
  // ground: 0 shows the planet, 1 hands the view to the flat map layer underneath the DOM labels.
  const cam = { lon: -2, lat: 14, zoom: 1, ground: 0, intro: 1, cx: 0, cy: 0, alt: ALTITUDE.orbit };
  const view = { R0: 280, cx: 0, cy: 0 };
  const pointer = { x: 0.5, y: 0.5, tx: 0, ty: 0, sx: 0, sy: 0 };
  let M = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let hoverT = -1, targetT = 0, keyboardOrbit = false, dragging = null;
  let sway = 0, swayAmp = 0, idleSince = performance.now();
  let stars = [];

  function rotation(lon, lat) {
    const l = lon * DEG, p = lat * DEG, cl = Math.cos(l), sl = Math.sin(l), cp = Math.cos(p), sp = Math.sin(p);
    return [cl, 0, -sl, -sp * sl, cp, -sp * cl, cp * sl, sp, cp * cl];
  }
  const R = () => view.R0 * cam.zoom;
  function project(v, out = {}) {
    const x = M[0] * v[0] + M[1] * v[1] + M[2] * v[2], y = M[3] * v[0] + M[4] * v[1] + M[5] * v[2], z = M[6] * v[0] + M[7] * v[1] + M[8] * v[2];
    const r = R();
    out.x = cam.cx + r * x; out.y = cam.cy - r * y; out.z = z; out.d = Math.hypot(x, y);
    return out;
  }
  function unproject(px, py) {
    const r = R(), x = (px - cam.cx) / r, y = (cam.cy - py) / r, r2 = x * x + y * y;
    if (r2 > 1) return null;
    const z = Math.sqrt(1 - r2);
    return [M[0] * x + M[3] * y + M[6] * z, M[1] * x + M[4] * y + M[7] * z, M[2] * x + M[5] * y + M[8] * z];
  }
  const pickTerritory = (px, py) => { const p = unproject(px, py); const hit = p && landAt(p); return hit ? hit.t : -1; };

  function resize() {
    W = innerWidth; H = innerHeight;
    dpr = Math.min(2, window.devicePixelRatio || 1) * (quality < 1 ? 0.75 : 1);
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const r = rng(42), n = Math.min(520, Math.round((W * H) / 3200));
    stars = Array.from({ length: n }, () => ({ x: r() * W, y: r() * H, s: r() < 0.08 ? 1.6 : r() < 0.4 ? 1.1 : 0.7, a: 0.25 + r() * 0.65, tw: 0.0006 + r() * 0.0018, ph: r() * TAU, depth: 0.3 + r() * 0.7 }));
  }

  function drawStars(now) {
    const fade = 1 - cam.ground * 0.55;
    const ox = -(cam.lon * 1.4) - pointer.sx * 14, oy = cam.lat * 1.2 - pointer.sy * 10;
    for (const s of stars) {
      const tw = reduced ? 1 : 0.72 + 0.28 * Math.sin(now * s.tw + s.ph);
      const x = (((s.x + ox * s.depth) % W) + W) % W, y = (((s.y + oy * s.depth) % H) + H) % H;
      ctx.globalAlpha = s.a * tw * fade * T.starAlpha;
      ctx.fillStyle = s.s > 1.5 ? T.starBright : T.star;
      ctx.fillRect(x, y, s.s, s.s);
    }
    ctx.globalAlpha = 1;
  }

  const P = {};
  function drawPlanet(now, alpha) {
    const r = R(), cx = cam.cx, cy = cam.cy;
    if (alpha <= 0.001) return;
    ctx.save();
    ctx.globalAlpha = alpha * clamp(cam.intro * 1.6, 0, 1);
    // In daylight the planet floats over a soft shadow, like an object on paper.
    if (T.floor) {
      ctx.save();
      ctx.translate(cx, cy + r * 1.17);
      ctx.scale(1, 0.11);
      const floor = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.82);
      floor.addColorStop(0, T.floor); floor.addColorStop(1, "rgba(40, 75, 120, 0)");
      ctx.fillStyle = floor;
      ctx.beginPath(); ctx.arc(0, 0, r * 0.82, 0, TAU); ctx.fill();
      ctx.restore();
    }
    // Halo on the far side of the sphere, then the ocean with a lit upper-left.
    const halo = ctx.createRadialGradient(cx, cy, r * 0.94, cx, cy, r * 1.34);
    halo.addColorStop(0, T.halo[0]); halo.addColorStop(0.22, T.halo[1]); halo.addColorStop(1, T.halo[2]);
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.34, 0, TAU); ctx.fill();
    drawOrbitRing(now, false);
    const ocean = ctx.createRadialGradient(cx - r * 0.38, cy - r * 0.42, r * 0.04, cx, cy, r);
    ocean.addColorStop(0, T.ocean[0]); ocean.addColorStop(0.5, T.ocean[1]); ocean.addColorStop(1, T.ocean[2]);
    ctx.fillStyle = ocean;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.fill();

    // Graticule: faint, thicker as the camera nears the surface.
    ctx.strokeStyle = `rgba(${T.grat.join(", ")}, ${T.gratAlpha + Math.min(0.08, (cam.zoom - 1) * 0.02)})`;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let lon = -180; lon < 180; lon += 20) graticuleLine((t) => vec(lon, -80 + t * 160));
    for (let lat = -60; lat <= 60; lat += 20) graticuleLine((t) => vec(-180 + t * 360, lat));
    ctx.stroke();

    // Land dots, one fill per module so each module keeps its shade of the system hue.
    const base = clamp(r * 0.0062, 1.05, 10), step = quality < 1 ? 2 : 1;
    const intro = cam.intro;
    for (const g of groups) {
      const dim = hoverT >= 0 && g.t !== hoverT;
      ctx.globalAlpha = alpha * (dim ? T.dim : 1);
      ctx.fillStyle = hoverT === g.t ? g.hot : g.color;
      ctx.beginPath();
      const idx = g.idx;
      for (let j = 0; j < idx.length; j += step) {
        const i = idx[j];
        const x = M[0] * DOTS.x[i] + M[1] * DOTS.y[i] + M[2] * DOTS.z[i];
        const z = M[6] * DOTS.x[i] + M[7] * DOTS.y[i] + M[8] * DOTS.z[i];
        if (z <= 0.02) continue;
        if (intro < 1 && intro < ((x + 1) / 2) * 0.7 + DOTS.seed[i] * 0.3) continue;
        const y = M[3] * DOTS.x[i] + M[4] * DOTS.y[i] + M[5] * DOTS.z[i];
        const px = cx + r * x, py = cy - r * y, rr = base * (0.42 + 0.58 * z);
        if (px < -rr || px > W + rr || py < -rr || py > H + rr) continue;
        ctx.moveTo(px + rr, py);
        ctx.arc(px, py, rr, 0, TAU);
      }
      ctx.fill();
    }
    ctx.globalAlpha = alpha;

    // Night side and rim light give the sphere volume without textures.
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();
    const night = ctx.createRadialGradient(cx - r * 0.5, cy - r * 0.55, r * 0.15, cx + r * 0.25, cy + r * 0.3, r * 1.3);
    night.addColorStop(0, T.night[0]); night.addColorStop(0.55, T.night[1]); night.addColorStop(1, T.night[2]);
    ctx.fillStyle = night;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    const glare = ctx.createRadialGradient(cx - r * 0.42, cy - r * 0.48, 0, cx - r * 0.42, cy - r * 0.48, r * 0.7);
    glare.addColorStop(0, T.glare); glare.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.fillStyle = glare;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
    const rim = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    rim.addColorStop(0, T.rim[0]); rim.addColorStop(0.5, T.rim[1]); rim.addColorStop(1, T.rim[2]);
    ctx.strokeStyle = rim; ctx.lineWidth = themeName === "dark" ? 1.4 : 2;
    ctx.beginPath(); ctx.arc(cx, cy, r - 0.7, 0, TAU); ctx.stroke();

    drawOrbitRing(now, true);
    drawRoutes(now, alpha);
    ctx.restore();
  }
  // A tilted orbit with one satellite: its far half passes behind the planet, the near half in front.
  function drawOrbitRing(now, front) {
    const r = R(), base = ctx.globalAlpha, tilt = -0.21, rx = r * 1.24, ry = r * 0.27;
    ctx.save();
    ctx.globalAlpha = base * (front ? 0.55 : 0.8);
    ctx.strokeStyle = T.ring;
    ctx.lineWidth = 1;
    ctx.setLineDash([1.5, 6]);
    ctx.beginPath();
    ctx.ellipse(cam.cx, cam.cy, rx, ry, tilt, front ? 0 : Math.PI, front ? Math.PI : TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    const a = reduced ? 0.9 : (now * 0.00011) % TAU;
    if ((a < Math.PI) === front) {
      const ex = Math.cos(a) * rx, ey = Math.sin(a) * ry;
      const x = cam.cx + ex * Math.cos(tilt) - ey * Math.sin(tilt), y = cam.cy + ex * Math.sin(tilt) + ey * Math.cos(tilt);
      ctx.globalAlpha = base;
      ctx.fillStyle = T.satellite;
      ctx.shadowColor = T.satGlow;
      ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(x, y, 2.2, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }
  function graticuleLine(at) {
    let pen = false;
    for (let i = 0; i <= 64; i++) {
      project(at(i / 64), P);
      if (P.z <= 0) { pen = false; continue; }
      if (pen) ctx.lineTo(P.x, P.y); else { ctx.moveTo(P.x, P.y); pen = true; }
    }
  }
  function drawRoutes(now, alpha) {
    if (cam.intro < 0.9) return;
    for (const route of routeCurves) {
      const hot = hoverT >= 0 && (route.from === hoverT || route.to === hoverT);
      const dim = hoverT >= 0 && !hot;
      ctx.globalAlpha = alpha * (dim ? 0.12 : hot ? 1 : 0.5) * clamp((cam.intro - 0.9) * 10, 0, 1);
      // Routes are cool light trails; warm gold is kept for the one being inspected.
      ctx.strokeStyle = hot ? T.routeHot : T.route;
      ctx.lineWidth = hot ? 1.8 : 1.1;
      ctx.setLineDash(hot ? [] : [3, 5]);
      ctx.beginPath();
      let pen = false;
      const seen = [];
      for (const p of route.pts) {
        project(p, P);
        const visible = P.z > 0 || P.d > 1;
        seen.push(visible ? [P.x, P.y] : null);
        if (!visible) { pen = false; continue; }
        if (pen) ctx.lineTo(P.x, P.y); else { ctx.moveTo(P.x, P.y); pen = true; }
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (reduced || dim) continue;
      // A light pulse runs from the dependent system to the one it uses.
      const head = ((now * 0.00018 + route.phase) % 1) * (seen.length - 1);
      for (let k = 0; k < 6; k++) {
        const at = seen[Math.max(0, Math.floor(head) - k * 2)];
        if (!at) continue;
        ctx.globalAlpha = alpha * (1 - k / 6) * (hot ? 1 : 0.8);
        ctx.fillStyle = hot ? T.pulseHot : T.pulse;
        ctx.beginPath(); ctx.arc(at[0], at[1], Math.max(0.6, 2.4 - k * 0.35), 0, TAU); ctx.fill();
      }
    }
    ctx.globalAlpha = alpha;
  }

  /* ---------- tweens and the frame loop ---------- */
  const tweens = new Set();
  let raf = 0, lastFrame = 0, frameCost = 0, slowFrames = 0, hudAt = 0;
  function tween(dur, apply, easing = ease.inOut, delay = 0) {
    return new Promise((resolve) => {
      if (reduced || dur <= 0) { apply(1); resolve(); kick(); return; }
      const tw = { start: performance.now() + delay, dur, apply, easing, resolve };
      tw.timer = setTimeout(() => endTween(tw), delay + dur + 600); // rAF pauses in background tabs
      tweens.add(tw);
      kick();
    });
  }
  function endTween(tw) { if (!tweens.delete(tw)) return; clearTimeout(tw.timer); tw.apply(1); tw.resolve(); kick(); }
  function shortLon(from, to) { let d = ((to - from + 540) % 360) - 180; return from + d; }
  function animateCam(target, dur, easing, delay) {
    const from = {};
    for (const key in target) from[key] = cam[key];
    if ("lon" in target) target = { ...target, lon: shortLon(from.lon, target.lon) };
    return tween(dur, (t) => { for (const key in target) cam[key] = lerp(from[key], target[key], t); }, easing, delay);
  }
  function kick() { if (!raf) raf = requestAnimationFrame(frame); }
  function ambient() { return cam.ground < 1 && !reduced && !document.hidden; }
  function frame(now) {
    raf = 0;
    const dt = lastFrame ? Math.min(64, now - lastFrame) : 16;
    lastFrame = now;
    for (const tw of [...tweens]) {
      if (now < tw.start) continue;
      const p = Math.min(1, (now - tw.start) / tw.dur);
      tw.apply(tw.easing(p));
      if (p >= 1) endTween(tw);
    }
    // Idle sway keeps the planet alive; any interaction settles it.
    const settled = !dragging && hoverT < 0 && !keyboardOrbit && now - idleSince > 2200 && current === root && !busy;
    swayAmp = lerp(swayAmp, settled && !reduced ? 1 : 0, 0.02);
    if (!reduced) sway += dt;
    // Pointer tilt and recentring belong to orbit only; below orbit the camera must sit exactly on the map.
    const orbiting = current === root && !busy;
    pointer.sx = lerp(pointer.sx, orbiting ? pointer.tx : 0, 0.06);
    pointer.sy = lerp(pointer.sy, orbiting ? pointer.ty : 0, 0.06);
    if (orbiting) { cam.cx = lerp(cam.cx, view.cx, 0.12); cam.cy = lerp(cam.cy, view.cy, 0.12); }
    const lon = cam.lon + Math.sin(sway * 0.00016) * 9 * swayAmp + pointer.sx * 3;
    const lat = clamp(cam.lat + pointer.sy * -2.4, -75, 75);
    M = rotation(lon, lat);

    // Resizing clears the canvas, so reduce quality before drawing this frame.
    if (quality === 1 && frameCost > 14 && ++slowFrames > 90) { quality = 0.5; resize(); }
    const t0 = performance.now();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = T.bg; ctx.fillRect(0, 0, W, H);
    drawStars(now);
    if (cam.ground < 1) drawPlanet(now, 1 - cam.ground);
    placeOrbitLabels();
    if (now - hudAt > 120 && (orbiting || tweens.size)) { hudAt = now; renderHud(); }
    // Like the GitHub globe: drop resolution and dot density when frames run long.
    frameCost = lerp(frameCost, performance.now() - t0, 0.1);

    const moving = Math.abs(pointer.sx) + Math.abs(pointer.sy) > 0.002 && cam.ground < 1 || orbiting && (Math.abs(pointer.sx - pointer.tx) > 0.002 || Math.abs(pointer.sy - pointer.ty) > 0.002 || Math.abs(cam.cx - view.cx) > 0.5 || Math.abs(cam.cy - view.cy) > 0.5);
    if (tweens.size || ambient() || moving) kick(); else lastFrame = 0;
  }

  /* ---------- orbit labels, hover, reticle ---------- */
  const labelsEl = $("orbit-labels"), reticle = $("reticle");
  const orbitLabels = terr.map((t, ti) => {
    const c = t.country, s = tally(c);
    const b = button("olabel" + (c.kind === "uncharted" ? " is-uncharted" : ""), null, () => go(c.id));
    b.style.setProperty("--h", c.hue);
    b.append(el("span", "ring"), el("span", "name", c.name), el("span", "meta", `${two(s.cities)} 模組 · ${two(s.towns)} 功能`));
    b.setAttribute("aria-label", `${c.name}，${s.cities} 個模組、${s.towns} 個功能，降落`);
    b.addEventListener("mouseenter", () => setHover(ti));
    b.addEventListener("mouseleave", () => setHover(-1));
    b.addEventListener("focus", () => setHover(ti));
    b.addEventListener("blur", () => setHover(-1));
    labelsEl.append(b);
    return { el: b, size: null };
  });
  let cityLabels = [];
  function setHover(ti) {
    if (hoverT === ti) return;
    hoverT = ti;
    idleSince = performance.now();
    cityLabels.forEach((l) => l.el.remove());
    cityLabels = [];
    if (ti >= 0 && current === root && !busy) {
      terr[ti].country.children.forEach((city, k) => {
        const label = el("span", "clabel", city.name);
        label.style.setProperty("--h", city.hue);
        labelsEl.append(label);
        cityLabels.push({ el: label, k });
      });
    }
    orbitLabels.forEach((l, i) => { l.el.classList.toggle("is-hot", i === ti); l.el.classList.toggle("is-dim", ti >= 0 && i !== ti); });
    stage.classList.toggle("is-pointing", ti >= 0);
    updateDock();
    kick();
  }
  let labelsVisible = null;
  function placeOrbitLabels() {
    const visible = current === root && cam.ground < 0.05 && cam.intro > 0.6 && !busy;
    if (visible !== labelsVisible) {
      labelsVisible = visible;
      labelsEl.classList.toggle("is-hidden", !visible);
      labelsEl.inert = !visible || (narrow() && !collapsed); // hidden labels must not catch Tab on the surface
    }
    if (cam.ground >= 1) return;
    let front = -1, bestZ = -2;
    const boxes = orbitLabels.map((l, i) => {
      project(terr[i].centroid, P);
      if (P.z > bestZ) { bestZ = P.z; front = i; }
      if (!l.size) l.size = [l.el.offsetWidth, l.el.offsetHeight];
      const back = P.z < 0.2;
      if (back !== l.back) { l.back = back; l.el.classList.toggle("is-back", back); l.el.tabIndex = back ? -1 : 0; }
      // The ring's centre sits 15px in from the plate's edge (border + padding + half the ring).
      const flip = P.x - 15 + l.size[0] > W - 8;
      if (flip !== l.flip) { l.flip = flip; l.el.classList.toggle("is-flip", flip); }
      return { l, z: P.z, x: flip ? P.x - l.size[0] + 15 : P.x - 15, y: P.y - l.size[1] / 2, w: l.size[0], h: l.size[1] };
    });
    // Front labels keep their spot; ones behind them step down until they no longer overlap.
    const placed = [];
    boxes.sort((a, b) => b.z - a.z).forEach((box) => {
      if (box.z >= 0.2) for (let n = 0; n < 4; n++) {
        const hit = placed.find((o) => box.x < o.x + o.w - 6 && box.x + box.w - 6 > o.x && box.y < o.y + o.h && box.y + box.h > o.y);
        if (!hit) break;
        box.y = hit.y + hit.h + 2;
      }
      if (box.z >= 0.2) placed.push(box);
      // Whole pixels only: text drawn at fractional offsets is resampled and looks blurred.
      box.l.el.style.transform = `translate(${Math.round(box.x)}px, ${Math.round(box.y)}px)`;
    });
    for (const label of cityLabels) {
      project(terr[hoverT]?.cityCentroids[label.k] || [0, 0, 1], P);
      label.el.style.transform = `translate(${Math.round(P.x - 12)}px, ${Math.round(P.y + 10)}px)`;
      label.el.style.opacity = P.z > 0.15 ? "" : "0";
    }
    if (front !== targetT && front >= 0) { targetT = front; updateDock(); }
    reticle.style.left = cam.cx + "px";
    reticle.style.top = cam.cy + "px";
    reticle.classList.toggle("is-on", keyboardOrbit && visible);
  }

  /* ---------- layout ---------- */
  const inspector = $("inspector");
  const narrow = () => innerWidth <= 860;
  // Remembered per layout: phones default to a collapsed sheet, desktops to an open panel.
  const collapseKey = () => (narrow() ? "atlas-v2-collapsed-narrow" : "atlas-v2-collapsed-wide");
  let collapsed = store(collapseKey()) ? store(collapseKey()) === "1" : narrow();
  // The panel grows with the screen; the wide reading mode is for long business logic and is the default on a town.
  // Its width is computed here (not measured) so maps are laid out for the final width while the panel animates.
  let wideChoice = store("atlas-v2-wide"); // "1", "0", or null = follow the level
  const isWide = () => !narrow() && (wideChoice ? wideChoice === "1" : current.level === "town");
  const panelWidth = () => (isWide() ? clamp(W * 0.48, 560, 980) : clamp(W * 0.3, 380, 600));
  const headerBottom = () => document.querySelector(".masthead").getBoundingClientRect().bottom;
  const panelBox = () => ({ left: W - 20 - panelWidth(), right: W - 20, top: headerBottom() + 18, bottom: H - 20 });
  function applyPanelWidth() {
    inspector.classList.toggle("is-wide", isWide());
    inspector.style.width = narrow() ? "" : panelWidth() + "px";
    const wideButton = inspector.querySelector(".insp-wide");
    if (wideButton) { wideButton.setAttribute("aria-pressed", String(isWide())); wideButton.setAttribute("aria-label", isWide() ? "收窄說明" : "展開閱讀"); wideButton.title = isWide() ? "收窄說明" : "展開閱讀"; }
  }
  function toggleWide() {
    wideChoice = isWide() ? "0" : "1";
    store("atlas-v2-wide", wideChoice);
    applyPanelWidth();
    layout();
    rebuild();
  }
  function freeArea() {
    const insp = inspector.getBoundingClientRect();
    if (narrow()) return { left: 0, right: W, top: headerBottom() + 16, bottom: H - (collapsed ? insp.height + 16 : 90) };
    const right = collapsed ? W - 16 : panelBox().left - 16;
    return { left: 0, right, top: headerBottom() + 12, bottom: H };
  }
  function layout() {
    document.documentElement.style.setProperty("--header-bottom", Math.ceil(headerBottom()) + "px");
    const fa = freeArea();
    $("titleblock").style.maxWidth = narrow() ? "" : Math.max(220, fa.right - 144) + "px";
    const tb = $("titleblock").getBoundingClientRect();
    const w = fa.right - fa.left, h = fa.bottom - fa.top;
    if (narrow()) {
      const top = tb.bottom + 16, avail = Math.max(160, fa.bottom - 70 - top);
      view.R0 = clamp(Math.min(w * 0.4, avail * 0.46), 90, 420);
      view.cx = w / 2;
      view.cy = top + avail / 2 + 10;
    } else {
      // Sit right of and below the title so the headline never covers the planet.
      view.R0 = clamp(Math.min(w * 0.3, h * 0.345), 140, 460);
      view.cx = fa.left + w * 0.6;
      view.cy = fa.top + h * 0.565;
    }
    stage.style.setProperty("--free-cx", (narrow() ? W / 2 : (fa.left + fa.right) / 2 + 30) + "px");
    stage.style.setProperty("--sheet-head", (collapsed ? inspector.getBoundingClientRect().height : 0) + "px");
    if (!cam.cx) { cam.cx = view.cx; cam.cy = view.cy; }
    kick();
  }
  function contentRect() {
    const fa = freeArea(), tb = $("titleblock").getBoundingClientRect(), insp = inspector.getBoundingClientRect();
    if (narrow()) {
      const top = tb.bottom + 16, bottom = fa.bottom - 72;
      // A window can briefly be 0×0 (e.g. an embedding pane still opening); a non-positive width would invert the map scale.
      return { x: 16, y: top, w: Math.max(1, W - 32), h: Math.max(220, bottom - top) };
    }
    const top = Math.max(tb.bottom + 34, collapsed ? insp.bottom + 20 : 0), left = 146;
    const right = collapsed ? W - 28 : fa.right - 8;
    return { x: left, y: top, w: Math.max(260, right - left), h: Math.max(240, H - 108 - top) };
  }

  /* ---------- surface maps: the planet's geography, laid flat at each level ---------- */
  // Every surface view of a system shares one projection centred on that system, so moving between its levels
  // is an exact zoom (scale k = sB / sA plus an offset), and the dive from orbit lands on the very same shapes.
  let currentLayer = null;
  // A hex grid samples the planet; regions paint as flat fills and borders are thin lines along the shared cell edges.
  const HEX = 8, ROW = (HEX * Math.sqrt(3)) / 2, HEX_R = HEX / Math.sqrt(3);
  const EDGE_PTS = [-90, -30, 30, 90, 150, 210].map((a) => [Math.cos(a * DEG) * HEX_R, Math.sin(a * DEG) * HEX_R]);
  const cityOf = (node) => (node.level === "city" ? node : node.level === "town" ? node.parent : null);
  function focusDots(node) {
    const t = node.country.index;
    if (node.level === "country") return groups.filter((g) => g.t === t).flatMap((g) => g.idx);
    if (node.level === "city") return groups.find((g) => g.t === t && g.k === node.index)?.idx || [];
    return node.dots || [];
  }
  function viewFor(node, rect = contentRect()) {
    const t = terr[node.country.index], lon = t.centroidLL[0], lat = clamp(t.centroidLL[1], -60, 60), m = rotation(lon, lat);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const dots = focusDots(node), pts = node.territory ? node.territory.plane.map((p) => vec(...chart.invert(p))) : dots.length ? dots.map(dotPoint) : [node.seed || t.centroid];
    for (const p of pts) {
      const x = m[0] * p[0] + m[1] * p[1] + m[2] * p[2], y = m[3] * p[0] + m[4] * p[1] + m[5] * p[2];
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    // A town shows its district with the neighbouring districts around it; higher levels fit their outline.
    const pad = node.level === "town" ? 2.2 : 1.14, minSpan = node.level === "town" ? 0.06 : 0.12;
    const bw = Math.max(minSpan, (maxX - minX) * pad), bh = Math.max(minSpan, (maxY - minY) * pad);
    const s = Math.min(rect.w / bw, rect.h / bh);
    return { m, lon, lat, s, ox: rect.x + rect.w / 2 - (s * (minX + maxX)) / 2, oy: rect.y + rect.h / 2 + (s * (minY + maxY)) / 2, country: node.country.index };
  }
  function fromView(v, X, Y) {
    const x = (X - v.ox) / v.s, y = (v.oy - Y) / v.s, r2 = x * x + y * y;
    if (r2 >= 1) return null;
    const z = Math.sqrt(1 - r2), m = v.m;
    return [m[0] * x + m[3] * y + m[6] * z, m[1] * x + m[4] * y + m[7] * z, m[2] * x + m[5] * y + m[8] * z];
  }
  // What a point on a surface map belongs to, seen from `node`: a child to descend into, a sibling module or a neighbouring system.
  function nodeAt(v, node, X, Y) {
    const p = fromView(v, X, Y), hit = p && landAt(p);
    if (!hit) return null;
    const country = terr[hit.t].country;
    if (country !== node.country) return country;
    if (hit.k < 0) return null;
    const city = country.children[hit.k];
    if (!city) return null;
    if (node.level === "country" || city !== cityOf(node)) return city;
    const town = city.children[townAt(p, city)];
    return town === node ? null : town;
  }

  function buildLayer(node, v = viewFor(node)) {
    const layer = el("div", "layer");
    layer.dataset.id = node.id;
    layer.view = v;
    layersEl.append(layer);
    try {
      if (node.level !== "town" && (node.children.length > GRID_LIMIT || !node.children.length)) buildGrid(node, layer);
      else buildMap(node, layer, v);
      if (node.level === "town") buildTown(node, layer, contentRect());
    } catch (error) {
      // Labels are measured in the DOM, so the layer is attached first; a failed build must not linger behind the message or a retry.
      layer.remove();
      throw error;
    }
    return layer;
  }

  function buildMap(node, layer, v) {
    const P = T.map, level = node.level, focusT = node.country.index, focusCity = cityOf(node), focusJ = level === "town" ? node.index : -1;
    const dataName = level === "city" ? dataFocus.get(node.id) : null, dataUse = dataName ? townUses(node, dataName) : null;
    // The map reaches past the screen edge (MARGIN) so a shrinking zoom or a late window resize never shows a bare edge.
    const ratio = Math.min(2, window.devicePixelRatio || 1), MARGIN = 120, FW = W + MARGIN * 2, FH = H + MARGIN * 2;
    const sized = (c) => {
      c.width = Math.round(FW * ratio); c.height = Math.round(FH * ratio);
      Object.assign(c.style, { width: FW + "px", height: FH + "px", left: -MARGIN + "px", top: -MARGIN + "px" });
      c.setAttribute("aria-hidden", "true");
      return c;
    };
    const canvas = sized(el("canvas", "map" + (level === "town" ? " is-backdrop" : ""))), hover = sized(el("canvas", "map-hover"));
    layer.append(canvas, hover);

    // 1. Sample a hex grid across the screen and ask the planet what lies under each cell.
    const cols = Math.ceil(FW / HEX) + 3, rows = Math.ceil(FH / ROW) + 3;
    const grid = new Int32Array(cols * rows).fill(-1), cells = [];
    for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
      const x = (q - 1) * HEX + (r % 2 ? HEX / 2 : 0) - MARGIN, y = (r - 1) * ROW - MARGIN, p = fromView(v, x, y);
      if (!p) continue;
      const hit = landAt(p);
      // The thin channel between two systems reads as sea, so neighbouring coasts stay apart.
      const land = hit && hit.k >= 0;
      const cell = { x, y, r, q, t: land ? hit.t : -2, k: land ? hit.k : -1, j: -1, id: null };
      if (cell.t === focusT) {
        const city = node.country.children[cell.k];
        cell.j = townAt(p, city);
        cell.id = !city ? node.country.id : level === "country" || city !== focusCity || cell.j < 0 ? city.id : city.children[cell.j].id;
      } else if (cell.t >= 0) cell.id = terr[cell.t].country.id;
      grid[r * cols + q] = cells.length;
      cells.push(cell);
    }
    // 2. Flat fills: one colour per region, so labels sit on a calm background.
    const hsl = (h, s, l) => `hsl(${h} ${s.toFixed(1)}% ${clamp(l, 4, 97).toFixed(1)}%)`;
    function colour(c) {
      if (c.t === -2) return P.ocean;
      const country = terr[c.t].country, h = country.hue, s = satOf(country) + 6;
      if (c.t !== focusT) return hsl(h, s * P.nb[0], P.nb[1]);
      if (level === "country") return hsl(h, s, P.focusL[c.k % 6]);
      if (country.children[c.k] !== focusCity) return hsl(h, s * P.sib[0], P.sib[1]);
      if (level === "town" && c.j !== focusJ) return hsl(h, s * 0.75, P.sib[1] - 4);
      if (dataUse) return dataUse.has(focusCity.children[c.j]?.id) ? hsl(h, s, P.usedL(P.districtL[c.j % 6])) : hsl(h, s * P.unused[0], P.unused[1]);
      return hsl(h, s, P.districtL[c.j % 6]);
    }
    // 3. Borders: thin lines along the cell edges where two regions meet.
    //    "province" separates the children being chosen; "coast" outlines the area in focus; "faint" outlines everything else.
    const at2 = (r, q) => (r < 0 || q < 0 || r >= rows || q >= cols ? null : cells[grid[r * cols + q]] || null);
    const inFocusCity = (c) => c.t === focusT && node.country.children[c.k] === focusCity;
    function borderKind(a, b) {
      if (a.t === b.t && a.k === b.k && a.j === b.j) return null;
      const aFocus = a.t === focusT, bFocus = b.t === focusT;
      if (a.t !== b.t) return aFocus || bFocus ? "coast" : "faint";
      if (!aFocus) return null;
      if (level === "country") return "province";
      const aCity = inFocusCity(a), bCity = inFocusCity(b);
      if (aCity !== bCity) return "coast";
      if (aCity) return "province";
      return a.k !== b.k ? "faint" : null;
    }
    const segments = { faint: [], province: [], coast: [] };
    for (const c of cells) {
      const odd = c.r % 2;
      // Each shared edge once: right, lower-right and lower-left neighbours (corner indices of the pointy-top hex).
      for (const [o, i, j] of [[at2(c.r, c.q + 1), 1, 2], [at2(c.r + 1, c.q + odd), 2, 3], [at2(c.r + 1, c.q - 1 + odd), 3, 4]]) {
        const kind = o && borderKind(c, o);
        if (kind) segments[kind].push([c.x + EDGE_PTS[i][0], c.y + EDGE_PTS[i][1], c.x + EDGE_PTS[j][0], c.y + EDGE_PTS[j][1]]);
      }
    }
    const lines = { faint: smoothPath(segments.faint), province: smoothPath(segments.province), coast: smoothPath(segments.coast) };
    // 4. Paint fills, then borders, then the planet's limb where the map curves away.
    const byColour = new Map();
    for (const c of cells) {
      const key = colour(c);
      if (!byColour.has(key)) byColour.set(key, []);
      byColour.get(key).push(c);
    }
    // Fills are plain cell rectangles on a half-resolution canvas, scaled up: the scaling softens the stair-steps and the
    // smoothed borders on top keep edges crisp. (Hex Path2D fills took ~1 s for 26k cells; rectangles take ~15 ms.)
    const FILL = 0.5, fill = document.createElement("canvas"), f = fill.getContext("2d");
    fill.width = Math.ceil(FW * FILL); fill.height = Math.ceil(FH * FILL);
    byColour.forEach((list, key) => { f.fillStyle = key; for (const c of list) cellRect(f, c, FILL, MARGIN); });
    const g = canvas.getContext("2d");
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.drawImage(fill, 0, 0, canvas.width, canvas.height);
    g.setTransform(ratio, 0, 0, ratio, MARGIN * ratio, MARGIN * ratio);
    g.lineJoin = g.lineCap = "round";
    const focusHue = node.country.hue, focusSat = satOf(node.country) + 6;
    [["faint", P.faint[0], P.faint[1]], ["province", P.province[0], P.province[1]], ["coast", hsl(focusHue, focusSat, P.coast[0]), P.coast[1]]].forEach(([kind, colour2, width]) => {
      g.strokeStyle = colour2; g.lineWidth = width; g.stroke(lines[kind]);
    });
    g.strokeStyle = P.limb; g.lineWidth = 1.5;
    g.beginPath(); g.arc(v.ox, v.oy, v.s, 0, TAU); g.stroke();
    layer.mapCells = cells;
    layer.hoverCanvas = hover;
    layer.mapMargin = MARGIN;
    if (level === "town") return;

    // 5. Labels sit where each region's visible, uncovered cells are centred (the panel and title hide the rest).
    const avoid = [$("titleblock"), $("dock"), $("rail"), $("hud"), ...(narrow() ? [inspector] : [])].map((e) => e.getBoundingClientRect()).filter((r) => r.width);
    if (!narrow() && !collapsed) avoid.push(panelBox());
    const covered = (x, y) => y < 70 || avoid.some((r) => x > r.left && x < r.right && y > r.top && y < r.bottom);
    const sums = new Map();
    for (const c of cells) {
      if (!c.id || c.x < 0 || c.y < 0 || c.x > W || c.y > H || covered(c.x, c.y)) continue;
      if (!sums.has(c.id)) sums.set(c.id, { x: 0, y: 0, n: 0 });
      const s = sums.get(c.id);
      s.x += c.x; s.y += c.y; s.n++;
    }
    const centre = (id) => { const s = sums.get(id); return s && s.n ? [s.x / s.n, s.y / s.n, s.n] : null; };
    const placed = [], pos = new Map();
    const overlaps = (b, list) => list.some((o) => b.left < o.right + 4 && b.right + 4 > o.left && b.top < o.bottom + 2 && b.bottom + 2 > o.top);
    // Labels are centred on their region, kept on screen and placed on whole pixels.
    function put(elm, x, y, required) {
      layer.append(elm);
      const w = elm.offsetWidth, h = elm.offsetHeight;
      const left = clamp(x - w / 2, 8, W - 8 - w);
      elm.style.left = Math.round(left) + "px"; elm.style.top = Math.round(y - h / 2) + "px";
      const b = elm.getBoundingClientRect();
      if (!required && (overlaps(b, placed) || overlaps(b, avoid))) return false;
      placed.push(b);
      return true;
    }
    // A city's features as one stack of names hanging from its label (below, or above when that has more room),
    // kept clear of the title, dock and panel. Names past the room left are counted in a final "+N" that enters the city.
    // The stack follows the label in the DOM, so Tab goes from a city into its own features.
    function addCallout(city, label) {
      const box = el("div", "map-callout");
      box.dataset.city = city.id;
      box.setAttribute("role", "group");
      box.setAttribute("aria-label", city.name + "的功能");
      const pins = city.children.slice(0, GRID_LIMIT).map((town) => {
        const pin = button("map-pin", null, () => go(town.id));
        pin.dataset.id = town.id;
        pin.dataset.type = town.data.type;
        pin.style.setProperty("--h", town.hue);
        pin.append(el("span", null, town.name));
        pin.setAttribute("aria-label", `${town.name}，${TYPE_NAME[town.data.type]}，進入`);
        return pin;
      });
      const more = button("map-pin is-more", null, () => go(city.id));
      more.dataset.id = city.id;
      more.style.setProperty("--h", city.hue);
      more.append(el("span", null, "+" + city.children.length + " 個功能")); // widest it can read, so the measured width holds
      box.append(...pins, more);
      label.after(box);
      const GAP = 4, BRIDGE = 6, row = (pins[0] || more).offsetHeight + GAP, width = box.offsetWidth, l = label.getBoundingClientRect();
      const panel = !narrow() && !collapsed ? panelBox() : null, right = Math.min(W - 8, panel ? panel.left - 8 : W);
      const left = Math.round(clamp(l.left + l.width / 2 - width / 2, 8, right - width));
      const across = avoid.filter((r) => r.right > left && r.left < left + width);
      // The dock slides sideways with the panel (and may still be moving during a rebuild), so its top is a floor for every stack.
      const dock = $("dock").getBoundingClientRect(), floor = dock.width ? Math.min(H - 8, dock.top - 8) : H - 8;
      const below = Math.min(floor, ...across.map((r) => (r.bottom > l.bottom ? r.top : Infinity))) - l.bottom;
      const above = l.top - Math.max(headerBottom() + 8, ...across.map((r) => (r.top < l.top ? r.bottom : -Infinity)));
      const fits = (room) => Math.floor((room - BRIDGE + GAP) / row);
      const total = city.children.length, down = fits(below) >= total || fits(below) >= fits(above);
      const rows = Math.min(total, fits(down ? below : above));
      if (rows < 1) { box.remove(); return; }
      const shown = Math.min(pins.length, rows < total ? rows - 1 : rows);
      pins.slice(shown).forEach((pin) => pin.remove());
      if (shown < total) {
        more.firstChild.textContent = (shown ? "+" : "") + (total - shown) + " 個功能";
        more.setAttribute("aria-label", `${city.name}${shown ? "還有" : "有"} ${total - shown} 個功能，進入模組查看`);
      } else more.remove();
      box.classList.add(down ? "is-below" : "is-above");
      box.style.left = left + "px";
      box.style.top = Math.round(down ? l.bottom - BRIDGE : l.top + BRIDGE - box.offsetHeight) + "px";
      // Labels under the open stack step aside while it is shown.
      const b = box.getBoundingClientRect();
      box.dataset.covers = [...layer.querySelectorAll(".map-label")].filter((o) => o !== label && overlaps(o.getBoundingClientRect(), [b])).map((o) => o.dataset.id).join(" ");
    }
    const children = level === "country" ? node.children : focusCity.children, labelOf = new Map();
    children.forEach((child, i) => {
      const p = centre(child.id);
      if (!p) return;
      const s = tally(child), d = child.data;
      const b = button("map-label is-major", null, () => go(child.id));
      b.dataset.id = child.id;
      b.style.setProperty("--h", child.hue);
      b.style.setProperty("--i", i);
      // A system map names only its cities and their size; counts of residents stay in the panel.
      if (level === "country") b.append(el("span", "name", child.name), el("span", "meta", `${s.towns} 功能`));
      else {
        const type = el("span", "type-dot", TYPE_NAME[d.type] || "");
        type.dataset.type = d.type;
        const use = dataUse?.get(child.id);
        const meta = use ? accessLabel(use) : [(d.residents || []).length && `${d.residents.length} 鎮民`, (d.rules || []).length && `${d.rules.length} 規則`].filter(Boolean).join(" · ");
        b.append(type, el("span", "name", child.name), el("span", "meta", meta || "說明"));
        if (dataUse) b.classList.add(use ? "is-used" : "is-dimmed");
      }
      const useNote = dataUse?.has(child.id) ? `，${accessLabel(dataUse.get(child.id))} ${dataName}` : "";
      b.setAttribute("aria-label", `${child.name}，${LEVEL_NAME[child.level]}${useNote}，進入`);
      put(b, p[0], p[1], true);
      pos.set(child.id, p);
      labelOf.set(child.id, b);
    });
    // Sibling modules (on a module map) and neighbouring systems: faded, still one click away.
    const others = [...(level === "city" ? node.country.children.filter((c) => c !== node) : []), ...root.children.filter((c) => c !== node.country)];
    for (const other of others) {
      const p = centre(other.id);
      if (!p || p[2] < 25) continue;
      const b = button("map-label is-other", null, () => go(other.id));
      b.dataset.id = other.id;
      b.style.setProperty("--h", other.hue);
      const kind = other.level === "country" ? "鄰近系統" : "同系統模組";
      b.append(el("span", "name", other.name), el("span", "meta", kind));
      b.setAttribute("aria-label", `前往${kind}：${other.name}`);
      if (put(b, p[0], p[1], false)) pos.set(other.id, p); else b.remove();
    }
    // A system map names only its cities; a city's features appear while it is in focus (setMapHover).
    if (level === "country") {
      layer.focusT = focusT;
      layer.cityOf = new Map();
      layer.townIndex = new Map();
      for (const city of node.children) {
        layer.cityOf.set(city.id, city.id);
        for (const town of city.children) { layer.cityOf.set(town.id, city.id); layer.townIndex.set(town.id, town.index); }
        if (city.children.length && labelOf.has(city.id)) addCallout(city, labelOf.get(city.id));
      }
    }
    const anchor = (target) => {
      if (pos.has(target.id)) return;
      const p = target.territory?.center || target.seed || target.parent?.territory?.center;
      if (!p) return;
      const m = v.m, x = m[0]*p[0]+m[1]*p[1]+m[2]*p[2], y = m[3]*p[0]+m[4]*p[1]+m[5]*p[2];
      pos.set(target.id, [v.ox+v.s*x, v.oy-v.s*y]);
    };
    const pairs = [];
    for (const [source, target] of linkEnds(node)) {
      anchor(source); anchor(target);
      if (pos.has(source.id) && pos.has(target.id)) pairs.push([source.id, target.id]);
    }
    drawLinks(layer, node, pairs, pos);

    // Moving between the map, its labels and a city's stack hands the focus straight over: clearing it in between
    // would hide the stack under the pointer (or the name about to take keyboard focus).
    let wait = 0, next = null;
    function point(id, patient) {
      // The pointer may cross a neighbour on its way from a city to that city's stack, so leaving waits a moment.
      const open = layer.cityOf?.get(layer.hoverId);
      if (patient && open && layer.cityOf.get(id) !== open) {
        next = id;
        wait ||= setTimeout(() => { wait = 0; setMapHover(layer, next); }, 160);
        return;
      }
      clearTimeout(wait); wait = 0;
      setMapHover(layer, id);
    }
    const release = (event) => {
      const to = event.relatedTarget;
      if (!(to && layer.contains(to) && to.closest(".map, .map-label, .map-callout"))) point(null);
    };
    canvas.addEventListener("pointermove", (event) => point(nodeAt(v, node, event.clientX, event.clientY)?.id || null, true));
    canvas.addEventListener("pointerleave", release);
    canvas.addEventListener("click", (event) => { if (event.detail > 1) return; const n = nodeAt(v, node, event.clientX, event.clientY); if (n) go(n.id); });
    layer.querySelectorAll(".map-label, .map-pin").forEach((b) => {
      b.addEventListener("mouseenter", () => point(b.dataset.id));
      b.addEventListener("mouseleave", release);
      b.addEventListener("focus", () => point(b.dataset.id));
      b.addEventListener("blur", release);
    });
    layer.querySelectorAll(".map-callout").forEach((box) => {
      box.addEventListener("mouseenter", () => point(layer.cityOf.get(layer.hoverId) === box.dataset.city ? layer.hoverId : box.dataset.city));
      box.addEventListener("mouseleave", release);
    });
  }
  // Dependency arrows as drawn: a system map joins its cities (its features are not on show there), a module map joins
  // its own features. Loaded targets use actual parents (moved IDs), while unknown town targets can still terminate at
  // their known index city/country.
  function linkEnds(node) {
    const level = node.level, ends = [];
    const visualTarget = (id) => {
      let target = nodes.get(id);
      if (!target) target = [...nodes.values()].filter((n) => (n.level === "city" || n.level === "country") && id.startsWith(n.id + ".")).sort((a,b) => b.id.length-a.id.length)[0];
      if (!target) return null;
      if (target.country !== node.country) return target.country;
      if (target.level === "town" && (level === "country" || target.parent !== node)) return target.parent;
      return target;
    };
    const sources = level === "country" ? node.children.flatMap((city) => [city, ...city.children]) : [node, ...node.children];
    for (const source of sources) for (const id of source.data.dependsOn || []) {
      const from = level === "country" && source.level === "town" ? source.parent : source, target = visualTarget(id);
      if (target && from.id !== target.id) ends.push([from, target]);
    }
    return ends;
  }
  // Join cell-edge segments into continuous borders and round off the hex zigzag (two passes of Chaikin's corner cutting).
  function smoothPath(segs) {
    const path = new Path2D(), key = (x, y) => Math.round(x * 8) + "," + Math.round(y * 8), ends = new Map();
    segs.forEach((s, i) => { for (const k of [key(s[0], s[1]), key(s[2], s[3])]) { if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); } });
    const used = new Uint8Array(segs.length);
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      let pts = [[segs[i][0], segs[i][1]], [segs[i][2], segs[i][3]]];
      for (const atTail of [true, false]) {
        for (;;) {
          const end = atTail ? pts[pts.length - 1] : pts[0], k = key(end[0], end[1]);
          const next = (ends.get(k) || []).find((j) => !used[j]);
          if (next === undefined) break;
          used[next] = 1;
          const s = segs[next], other = key(s[0], s[1]) === k ? [s[2], s[3]] : [s[0], s[1]];
          if (atTail) pts.push(other); else pts.unshift(other);
        }
      }
      const closed = pts.length > 3 && key(...pts[0]) === key(...pts[pts.length - 1]);
      if (closed) pts.pop();
      for (let n = 0; n < 2; n++) pts = relax(pts, closed);
      pts = chaikin(pts, closed);
      path.moveTo(pts[0][0], pts[0][1]);
      for (let p = 1; p < pts.length; p++) path.lineTo(pts[p][0], pts[p][1]);
      if (closed) path.closePath();
    }
    return path;
  }
  // A 1-2-1 average cancels the hex grid's two-edge zigzag exactly; open ends stay put so borders still meet at junctions.
  function relax(pts, closed) {
    const n = pts.length;
    if (n < 3) return pts;
    return pts.map((p, i) => {
      if (!closed && (i === 0 || i === n - 1)) return p;
      const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
      return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4];
    });
  }
  function chaikin(pts, closed) {
    if (pts.length < 3) return pts;
    const out = closed ? [] : [pts[0]], n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    if (!closed) out.push(pts[n - 1]);
    return out;
  }
  // Offset rows of rectangles tile the plane like the hex grid they sample. Edges snap to whole device pixels
  // (draw with an identity transform): fractional edges leave faint anti-aliased seams between rows.
  function cellRect(g, c, scale, margin) {
    const x0 = Math.floor((c.x - HEX / 2 + margin) * scale), x1 = Math.ceil((c.x + HEX / 2 + margin) * scale);
    const y0 = Math.floor((c.y - ROW / 2 + margin) * scale), y1 = Math.ceil((c.y + ROW / 2 + margin) * scale);
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  function drawLinks(layer, node, pairs, pos) {
    if (!pairs.length) return;
    // A system map keeps its arrows out of sight until a city is in focus.
    const svg = svgEl("svg", { class: "links" + (node.level === "country" ? " is-quiet" : ""), width: W, height: H, "aria-hidden": "true" });
    const defs = svgEl("defs", {}), marker = svgEl("marker", { id: "arrow-" + node.id.replace(/\W/g, "-"), viewBox: "0 0 10 10", refX: 8, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" });
    marker.append(svgEl("path", { d: "M0 1.5 9 5 0 8.5z", fill: "context-stroke" }));
    defs.append(marker);
    svg.append(defs);
    const seen = new Set();
    for (const [a, b] of pairs) {
      if (seen.has(a + ">" + b)) continue;
      seen.add(a + ">" + b);
      const [ax, ay] = pos.get(a), [bx, by] = pos.get(b);
      const mx = (ax + bx) / 2, my = (ay + by) / 2, len = Math.hypot(bx - ax, by - ay) || 1, bend = Math.min(120, len * 0.28);
      const path = svgEl("path", { class: "link", d: `M${ax} ${ay} Q${mx + ((by - ay) / len) * bend} ${my - ((bx - ax) / len) * bend} ${bx} ${by}`, "marker-end": `url(#${marker.id})` });
      path.dataset.from = a; path.dataset.to = b;
      svg.append(path);
    }
    layer.querySelector(".map-hover").after(svg);
  }
  function setMapHover(layer, id) {
    if (layer !== currentLayer || layer.hoverId === id) return;
    layer.hoverId = id;
    // On a system map, pointing at a city or one of its features puts the whole city in focus: its stack of features
    // opens, the other cities fade, and a pointed feature's own district is marked on the map.
    const city = layer.cityOf?.get(id) || null, hot = city || id, district = layer.townIndex?.get(id);
    const c = layer.hoverCanvas, g = c.getContext("2d"), m = layer.mapMargin, ratio = c.width / (W + m * 2);
    g.clearRect(0, 0, c.width, c.height);
    if (hot) {
      g.fillStyle = T.map.hover;
      for (const cell of layer.mapCells) if (cell.id === hot) cellRect(g, cell, ratio, m);
      if (district !== undefined) for (const cell of layer.mapCells) if (cell.id === hot && cell.j === district) cellRect(g, cell, ratio, m);
    }
    if (city) {
      g.fillStyle = T.map.veil;
      for (const cell of layer.mapCells) if (cell.t === layer.focusT && cell.id !== city) cellRect(g, cell, ratio, m);
    }
    layer.querySelectorAll(".map-label, .map-pin").forEach((b) => b.classList.toggle("is-hot", b.dataset.id === id));
    if (layer.cityOf) {
      let covers = [];
      layer.querySelectorAll(".map-callout").forEach((box) => {
        box.classList.toggle("is-shown", box.dataset.city === city);
        if (box.dataset.city === city) covers = (box.dataset.covers || "").split(" ");
      });
      layer.querySelectorAll(".map-label").forEach((b) => {
        b.classList.toggle("is-faded", !!city && b.classList.contains("is-major") && b.dataset.id !== city);
        b.classList.toggle("is-covered", covers.includes(b.dataset.id));
      });
    }
    const svg = layer.querySelector(".links");
    if (svg) {
      svg.classList.toggle("has-hot", !!hot);
      svg.querySelectorAll(".link").forEach((p) => p.classList.toggle("is-hot", !!hot && (p.dataset.from === hot || p.dataset.to === hot)));
    }
    layer.classList.toggle("is-pointing", !!id);
  }

  let showRelations = false, selectedResident = -1, residentPage = 0, relationPage = 0;
  const gridBatches = new Map();
  function buildGrid(node, layer) {
    layer.classList.add("is-grid");
    const rect = contentRect(), box = el("div", "dense-grid");
    Object.assign(box.style, { left: Math.round(rect.x) + "px", top: Math.round(rect.y) + "px", width: Math.round(rect.w) + "px", height: Math.round(rect.h) + "px" });
    box.tabIndex = 0;
    box.setAttribute("aria-label", node.name + "，功能清單");
    if (!node.children.length) box.append(el("p", "note", "目前沒有可顯示的項目。可返回上一層繼續探索。"));
    else box.append(el("p", "grid-note", "這裡有 " + node.children.length + " 個項目，分批顯示，每批 " + PAGE + " 個。所有項目都可搜尋或直接開啟。"));
    const list = el("div", "dense-items");
    let shown = 0;
    const more = button("load-more", "顯示更多", () => appendPage(true));
    const dataUse = node.level === "city" && dataFocus.has(node.id) ? townUses(node, dataFocus.get(node.id)) : null;
    function appendPage(focus) {
      const batch = node.children.slice(shown, shown + PAGE);
      for (const child of batch) {
        const b = button("dense-card", null, () => go(child.id)), use = dataUse?.get(child.id);
        b.dataset.id = child.id;
        b.style.setProperty("--h", child.hue);
        if (dataUse) b.classList.add(use ? "is-used" : "is-dimmed");
        b.append(el("strong", null, child.name), el("small", null, use ? accessLabel(use) : child.level === "city" ? tally(child).towns + " 功能" : TYPE_NAME[child.data.type] || "功能"));
        list.append(b);
      }
      shown += batch.length;
      more.hidden = shown >= node.children.length;
      more.textContent = "顯示更多（" + shown + " / " + node.children.length + "）";
      if (focus) list.children[shown - batch.length]?.focus({ preventScroll: true });
    }
    box.append(list, more); layer.append(box);
    const pages = gridBatches.get(node.id) || 1; for (let i=0; i<pages; i++) appendPage(false);
    more.addEventListener("click", () => gridBatches.set(node.id, Math.ceil(shown / PAGE)));
  }
  function scrollReaderTo(target, alignment = "nearest") {
    const reader = $("insp-body"), viewport = reader.getBoundingClientRect(), box = target.getBoundingClientRect();
    let delta = 0;
    if (alignment === "center" && box.height < viewport.height) delta = (box.top + box.bottom - viewport.top - viewport.bottom) / 2;
    else if (box.top < viewport.top || box.height > viewport.height) delta = box.top - viewport.top - 8;
    else if (box.bottom > viewport.bottom) delta = box.bottom - viewport.bottom + 8;
    if (delta) reader.scrollTo({ top: reader.scrollTop + delta, behavior: reduced ? "auto" : "smooth" });
    target.focus({ preventScroll: true });
  }
  function revealSection(id) {
    if (collapsed) setCollapsed(false);
    const target = document.getElementById(id);
    if (target) scrollReaderTo(target);
  }
  function openTechnical() {
    if (collapsed) setCollapsed(false);
    const details = document.getElementById("technical-reference");
    if (details) { details.open = true; revealSection("technical-toggle"); }
  }
  async function toggleRelations() {
    if (showRelations) { showRelations = false; rebuild(); return; }
    const token = navigation, town = current;
    const box = $("stage-message");
    box.replaceChildren(el("p", null, "正在載入跨系統關聯…")); box.hidden = false;
    try {
      await Promise.all(root.children.map((country) => loadCountry(country.id)));
      if (token !== navigation || current !== town) return;
      box.hidden = true; showRelations = true; relationPage = 0; if (narrow() && !collapsed) setCollapsed(true); else rebuild();
      const count = inspector.querySelector(".stats span:last-child b"); if (count) count.textContent = two(relationsOf(town).length);
      inspector.querySelector(".partial-relations")?.remove();
    } catch (error) {
      if (token === navigation) showMessage("無法載入完整關聯", error.message, toggleRelations);
    }
  }
  function buildTown(node, layer, rect) {
    // A wide inspector can leave less than the general map's minimum width.
    // Keep the whole compact ring in the actual free area, including its labels.
    const right = Math.min(rect.x + rect.w, narrow() ? W - 16 : freeArea().right - 8);
    const left = Math.min(rect.x, Math.max(16, right - 260));
    rect = { ...rect, x: left, w: right - left };
    const d = node.data, residents = d.residents || [], rules = d.rules || [], relations = relationsOf(node);
    if (residents.length > GRID_LIMIT) { buildResidentGrid(node, layer, rect); return; }
    const town = el("div", "town" + (rect.w < 620 ? " is-compact" : ""));
    town.style.setProperty("--h", node.hue);
    const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2 - 6;
    const compact = rect.w < 600, pageSize = compact ? 4 : 8;
    residentPage = Math.min(residentPage, Math.max(0, Math.ceil(residents.length / pageSize) - 1));
    const sats = residents.slice(residentPage * pageSize, (residentPage + 1) * pageSize);
    const ringR = clamp(Math.min(rect.w * .28, rect.h * .32), 72, 205), coreR = clamp(ringR * .46, 50, 86);
    const svg = svgEl("svg", { class: "town-svg", width: W, height: H, "aria-hidden": "true" });
    svg.append(svgEl("circle", { class: "town-ring", cx, cy, r: ringR })); town.append(svg);
    sats.forEach((sat, local) => {
      const k = residentPage * pageSize + local, a = (-90 + local * 360 / Math.max(1, sats.length)) * DEG;
      const x = Math.round(cx + Math.cos(a) * ringR), y = Math.round(cy + Math.sin(a) * ringR);
      svg.append(svgEl("line", { class: "town-spoke", x1: cx + Math.cos(a) * coreR, y1: cy + Math.sin(a) * coreR, x2: x, y2: y, "data-k": k }));
      const b = button("sat" + (Math.cos(a) < -.15 ? " is-left" : "") + (Math.sin(a) < -.5 ? " is-top" : ""), null, () => selectResident(k));
      b.dataset.resident = String(k); b.title = sat.name;
      b.style.left = Math.round(x) + "px"; b.style.top = Math.round(y) + "px";
      const card = el("span", "sat-card");
      card.append(el("b", null, sat.name), el("small", null, "鎮民 · " + (sat.rules || []).length + " 條規則"));
      b.setAttribute("aria-pressed", String(selectedResident === k));
      b.setAttribute("aria-label", "定位鎮民 " + sat.name + " 的規則");
      b.append(el("span", "sat-dot"), card); town.append(b);
    });
    const core = button("town-core", null, () => revealSection("business-logic"));
    core.style.left = Math.round(cx) + "px"; core.style.top = Math.round(cy) + "px";
    core.style.width = core.style.height = Math.round(coreR) * 2 + "px";
    const type = el("span", "type-dot", TYPE_NAME[d.type] || "功能"); type.dataset.type = d.type;
    const name = el("strong", null, node.name);
    name.style.fontSize = clamp((coreR * 2 - 30) / Math.max(4, [...node.name].length), 13, 20) + "px";
    core.append(type, name, el("small", null, residents.length + " 鎮民 · " + rules.length + " 共通規則"));
    core.setAttribute("aria-label", "閱讀 " + node.name + " 的商業邏輯"); town.append(core);
    const controls = el("div", "town-controls");
    controls.style.left = Math.round(cx) + "px"; controls.style.top = Math.round(rect.y + rect.h - (compact ? 66 : 26)) + "px";
    if (residents.length > pageSize) {
      const prev = button("town-page", "上一批鎮民", () => { residentPage--; rebuild(); }); prev.disabled = !residentPage;
      const next = button("town-page", "下一批鎮民", () => { residentPage++; rebuild(); }); next.disabled = (residentPage + 1) * pageSize >= residents.length;
      controls.append(prev, el("span", null, (residentPage + 1) + " / " + Math.ceil(residents.length / pageSize)), next);
    }
    const relToggle = button("rel-toggle", (showRelations ? "收起關聯" : "列出關聯") + " " + relations.length, toggleRelations);
    relToggle.setAttribute("aria-pressed", String(showRelations));
    const read = button("town-page", "商業邏輯", () => revealSection("business-logic"));
    controls.append(read, relToggle, button("town-page", "技術參考", openTechnical)); town.append(controls);
    if (showRelations) {
      const listMode = compact || relations.length > 6;
      const relationBox = el("div", listMode ? "relation-list" : "relation-ring");
      if (listMode) {
        Object.assign(relationBox.style, { left: Math.round(rect.x) + "px", top: Math.round(rect.y) + "px", width: Math.round(rect.w) + "px", maxHeight: Math.max(130, rect.h - 80) + "px" });
        relationBox.append(button("relation-close", "收起關聯", toggleRelations));
      }
      const shown = relations.slice(relationPage * PAGE, (relationPage + 1) * PAGE);
      shown.forEach((rel, j) => {
        const b = button(listMode ? "relation-item" : "rel", null, () => go(rel.node.id));
        b.style.setProperty("--h", rel.node.hue);
        b.append(el("b", null, rel.node.name), el("small", null, rel.label + " · " + rel.node.country.name));
        if (!listMode) {
          const a = (-90 + j * 360 / shown.length) * DEG, rr = Math.min(ringR + 100, rect.w / 2 - 65);
          const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
          b.style.left = Math.round(x) + "px"; b.style.top = Math.round(y) + "px";
          svg.append(svgEl("path", { class: "town-rel-line", d: `M${cx} ${cy} Q${cx + (x-cx)*.6} ${y} ${x} ${y}` }));
        }
        relationBox.append(b);
      });
      if (!relations.length) relationBox.append(el("p", "note", "目前沒有可顯示的關聯。"));
      if ((relationPage + 1) * PAGE < relations.length) relationBox.append(button("load-more", "下一批關聯", () => { relationPage++; rebuild(); }));
      if (relationPage) relationBox.append(button("load-more", "上一批關聯", () => { relationPage--; rebuild(); }));
      town.append(relationBox);
    }
    if (rect.w >= 700 && rect.h >= 420) {
      [["畫面", (d.screens || []).length], ["API", (d.endpoints || []).length], ["程式來源", display.evidenceGroups(d).reduce((n,g) => n+g.records.length,0)], ["規則", rules.length + residents.reduce((n,r) => n+(r.rules || []).length,0)]].forEach(([label, count], i) => {
        const plate = button("plate" + (i % 2 ? " is-right" : ""), null, i === 3 ? () => revealSection("business-logic") : openTechnical);
        plate.style.left = Math.round(i % 2 ? rect.x + rect.w - 130 : rect.x) + "px";
        plate.style.top = Math.round(i < 2 ? rect.y : rect.y + rect.h - 110) + "px";
        plate.append(el("span", null, label), el("b", null, two(count))); town.append(plate);
      });
    }
    layer.append(town);
    if (town.classList.contains("is-compact")) placeCompactResidents(town, rect, { x: cx, y: cy, radius: coreR });
    snapToPixels(town.querySelectorAll(town.classList.contains("is-compact") ? ".rel, .plate" : ".sat, .rel, .plate"));
  }
  function placeCompactResidents(town, rect, core) {
    const right = rect.x + rect.w, bottom = rect.y + rect.h;
    town.querySelectorAll(".sat").forEach((sat) => {
      const card = sat.querySelector(".sat-card"), x = parseFloat(sat.style.left), y = parseFloat(sat.style.top);
      // Even widths keep the card centred on the fixed, whole-pixel dot without
      // shifting its spoke endpoint. Wrap the metadata when space is narrow.
      const maxWidth = Math.max(24, Math.floor(Math.min(140, 2 * (x - rect.x), 2 * (right - x)) / 2) * 2);
      card.style.maxWidth = maxWidth + "px";
      card.style.maxHeight = Math.floor(rect.h) + "px";
      card.style.width = Math.min(maxWidth, Math.ceil(card.getBoundingClientRect().width / 2) * 2) + "px";
      const box = card.getBoundingClientRect(), above = sat.classList.contains("is-top");
      const left = Math.round(clamp(x - box.width / 2, rect.x, right - box.width));
      let top = above ? y - 18 - box.height : y + 18;
      // Side residents can otherwise overlap the central function on a small ring.
      if (left < core.x + core.radius && left + box.width > core.x - core.radius && top < core.y + core.radius && top + box.height > core.y - core.radius) {
        top = above ? core.y - core.radius - 10 - box.height : core.y + core.radius + 10;
      }
      top = Math.round(clamp(top, rect.y, bottom - box.height));
      card.style.left = (left - x + 11) + "px";
      card.style.top = (top - y + 11) + "px";
    });
  }
  function buildResidentGrid(node, layer, rect) {
    const residents = node.data.residents || [], relations = relationsOf(node);
    const box = el("div", "dense-grid resident-grid");
    Object.assign(box.style, { left: Math.round(rect.x) + "px", top: Math.round(rect.y) + "px", width: Math.round(rect.w) + "px", height: Math.round(rect.h) + "px" });
    box.tabIndex = 0; box.setAttribute("aria-label", "鎮民定位清單");
    box.append(el("h2", null, "鎮民"), el("p", "grid-note", residents.length + " 位鎮民，選擇名稱即可閱讀右側規則。"));
    const controls = el("div", "grid-controls"), rel = button("town-page rel-toggle", (showRelations ? "收起關聯" : "列出關聯") + " " + relations.length, toggleRelations);
    rel.setAttribute("aria-pressed", String(showRelations));
    controls.append(button("town-page", "商業邏輯", () => revealSection("business-logic")), rel, button("town-page", "技術參考", openTechnical)); box.append(controls);
    if (showRelations) {
      const links = el("div", "dense-relations");
      relations.slice(relationPage*PAGE, (relationPage+1)*PAGE).forEach((r) => {
        const b = button("relation-item", null, () => go(r.node.id)); b.append(el("b", null, r.node.name), el("small", null, r.label + " · " + r.node.country.name)); links.append(b);
      });
      if (!relations.length) links.append(el("p", "note", "目前沒有可顯示的關聯。"));
      if (relationPage) links.append(button("load-more", "上一批關聯", () => { relationPage--; rebuild(); }));
      if ((relationPage+1)*PAGE < relations.length) links.append(button("load-more", "下一批關聯", () => { relationPage++; rebuild(); }));
      box.append(links);
    }
    const list = el("div", "dense-items"); let shown = 0;
    const more = button("load-more", "顯示更多鎮民", () => append(true));
    function append(focus) {
      let first;
      residents.slice(shown, shown+PAGE).forEach((r, i) => {
        const k = shown+i, b = button("dense-card resident-choice", null, () => selectResident(k));
        b.dataset.resident = String(k); b.setAttribute("aria-pressed", String(selectedResident === k));
        b.append(el("strong", null, r.name), el("small", null, (r.rules || []).length + " 條規則")); list.append(b); first ||= b;
      });
      shown = Math.min(residents.length, shown+PAGE); more.hidden = shown >= residents.length;
      if (focus) first?.focus({ preventScroll: true });
    }
    box.append(list,more); layer.append(box);
    const key = "residents:" + node.id, pages = gridBatches.get(key) || 1; for (let i=0; i<pages; i++) append(false);
    more.addEventListener("click", () => gridBatches.set(key, Math.ceil(shown / PAGE)));
  }
  // Nudge positioned labels so their glyphs land on whole pixels (percentage transforms often leave a half pixel).
  function snapToPixels(list) {
    const moves = [...list].map((node) => { const b = node.getBoundingClientRect(); return [node, Math.round(b.left) - b.left, Math.round(b.top) - b.top]; });
    for (const [node, dx, dy] of moves) {
      if (dx) node.style.left = (parseFloat(node.style.left) || 0) + dx + "px";
      if (dy) node.style.top = (parseFloat(node.style.top) || 0) + dy + "px";
    }
  }
  function selectResident(k, reveal = true) {
    selectedResident = k;
    currentLayer?.querySelectorAll(".sat, .resident-choice").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.resident) === k)));
    currentLayer?.querySelectorAll(".town-spoke").forEach((line) => line.classList.toggle("is-hot", Number(line.dataset.k) === k));
    document.querySelectorAll(".resident-card").forEach((card) => card.classList.toggle("is-selected", Number(card.dataset.resident) === k));
    if (reveal && k >= 0) { document.querySelector(".resident-list")?.ensureResident?.(k); revealSection("resident-" + k); }
  }
  // Re-render the current surface (resize, theme, panel, relation ring) without animation, keeping keyboard focus.
  let needsRebuild = false;
  function rebuild() {
    if (busy) { needsRebuild = true; return; }
    if (!currentLayer || current === root) return;
    const focused = document.activeElement, layerHadFocus = currentLayer.contains(focused);
    const oldGrid = currentLayer.querySelector(".dense-grid"), gridScroll = oldGrid?.scrollTop || 0;
    const focusKey = layerHadFocus ? focused.dataset.id || (focused.classList.contains("town-page") ? "control:" + focused.textContent : null) || (focused.classList.contains("rel-toggle") ? "rel-toggle" : focused.dataset.resident !== undefined ? "sat:" + focused.dataset.resident : null) : null;
    const fresh = buildLayer(current);
    currentLayer.remove();
    currentLayer = fresh;
    syncCam(fresh.view);
    const freshGrid = fresh.querySelector(".dense-grid"); if (freshGrid) freshGrid.scrollTop = gridScroll;
    if (current.level === "town" && selectedResident >= 0) selectResident(selectedResident, false);
    if (focusKey) {
      const target = focusKey.startsWith("control:") ? [...fresh.querySelectorAll(".town-page")].find((b) => b.textContent === focusKey.slice(8)) : focusKey === "rel-toggle" ? fresh.querySelector(".rel-toggle") : focusKey.startsWith("sat:") ? fresh.querySelector(`[data-resident="${Number(focusKey.slice(4))}"]`) : fresh.querySelector(`[data-id="${CSS.escape(focusKey)}"]`);
      // A feature's name lives in its city's stack, which opens before it can take focus again.
      if (target?.closest(".map-callout")) setMapHover(fresh, target.dataset.id);
      target?.focus({ preventScroll: true });
    }
  }
  // Below orbit the hidden planet camera follows the map view, so climbing back to orbit starts from the same picture.
  function syncCam(v) { Object.assign(cam, { lon: v.lon, lat: v.lat, zoom: v.s / view.R0, cx: v.ox, cy: v.oy }); }

  /* ---------- chrome: title, crumbs, rail, readouts, dock, inspector ---------- */
  const titleblock = $("titleblock");
  function setChrome(node) {
    const level = node.level, s = tally(node), app = $("app");
    app.style.setProperty("--h", node.hue);
    stage.classList.toggle("is-orbit", level === "orbit");
    document.title = (level === "orbit" ? "" : node.name + " · ") + "Code Atlas · 架構地圖";

    const crumbs = $("crumbs");
    crumbs.replaceChildren();
    ancestors(node).forEach((n, i, all) => {
      if (i) crumbs.append(el("span", "sep", "/"));
      const b = button(null, n.level === "orbit" ? "軌道" : n.name, () => go(n.id));
      b.title = n.level === "orbit" ? "軌道" : n.name;
      if (i === all.length - 1) b.setAttribute("aria-current", "location");
      crumbs.append(b);
    });
    const eyebrow = $("eyebrow");
    eyebrow.textContent = level === "orbit" ? "軌道全景 · ORBIT" : level === "country" ? `國家 · SYSTEM ${pad2(node.index)}` : level === "city" ? `城市 · MODULE ${pad2(node.index)}` : `鄉鎮 · ${TYPE_NAME[node.data.type] || "FEATURE"}`;
    $("view-title").textContent = level === "orbit" ? DATA.project : node.name;
    const sub = $("subtitle");
    sub.replaceChildren();
    const stat = (n, label) => { const span = el("span"); span.append(el("b", null, String(n)), " " + label); sub.append(span); };
    if (level === "orbit") { stat(s.countries, "系統"); stat(s.cities, "模組"); stat(s.towns, "功能"); stat(Math.round(DATA.coverage.total ? DATA.coverage.covered / DATA.coverage.total * 100 : 0) + "%", "文件覆蓋"); }
    else if (level === "country") { stat(s.cities, "模組"); stat(s.towns, "功能"); if (s.residents) stat(s.residents, "鎮民"); }
    else if (level === "city") {
      stat(s.towns, "功能"); if (s.residents) stat(s.residents, "鎮民");
      const names = display.dataNames(node.data);
      if (names.length) {
        const group = el("span", "data-chips");
        group.setAttribute("role", "group"); group.setAttribute("aria-label", "資料：點名稱查看哪些功能用到");
        group.append(el("small", null, "資料"));
        names.slice(0, TITLE_DATA_LIMIT).forEach((name) => group.append(dataChip(name, node)));
        if (names.length > TITLE_DATA_LIMIT) {
          // Long lists stay compact until asked; the rest then join the title in place.
          const rest = button("data-chip is-more", "+" + (names.length - TITLE_DATA_LIMIT), () => {
            const more = names.slice(TITLE_DATA_LIMIT).map((name) => dataChip(name, node));
            rest.replaceWith(...more); more[0].focus();
          });
          rest.setAttribute("aria-label", "顯示其餘 " + (names.length - TITLE_DATA_LIMIT) + " 項資料");
          group.append(rest);
        }
        sub.append(group);
      }
    }
    else { const d = node.data; if ((d.residents || []).length) stat(d.residents.length, "鎮民"); if ((d.rules || []).length) stat(d.rules.length, "規則"); if ((d.endpoints || []).length) stat(d.endpoints.length, "API"); }
    titleblock.classList.remove("is-swap");
    void titleblock.offsetWidth;
    titleblock.classList.add("is-swap");

    renderRail(level, node.hue);
    const fromAlt = cam.alt, toAlt = ALTITUDE[level];
    tween(1100, (t) => { cam.alt = lerp(fromAlt, toAlt, t); renderHud(); }, ease.out);
    renderInspector(node);
    applyPanelWidth();
    layout();
    updateDock(node);
    const levelKeys = level === "town" ? [(node.data.residents || []).length && "Tab 選擇鎮民", "R 列出關聯"] : ["點地圖或 Tab 選擇", "Enter 進入"];
    const stepKey = siblingOf(node, 1) && `← → 切換${LEVEL_NAME[level]}`;
    $("keys").textContent = level === "orbit" ? "拖曳或 ← → ↑ ↓ 旋轉 · Enter 降落 · / 搜尋" : [...levelKeys, stepKey, "Esc 返回", "/ 搜尋"].filter(Boolean).join(" · ");
    $("status").textContent = level === "orbit" ? "回到軌道全景" : `已進入${LEVEL_NAME[level]}：${node.name}`;
  }
  const needle = el("span", "rail-needle");
  function renderRail(level, hue) {
    const rail = $("rail");
    rail.querySelectorAll(".rail-stop").forEach((stop) => stop.remove());
    rail.style.setProperty("--h", hue);
    const path = ancestors(current), depth = LEVELS.indexOf(level);
    LEVELS.forEach((lv, i) => {
      const target = path[i];
      const b = button("rail-stop", null, () => target && go(target.id));
      b.append(el("i"), el("span", null, LEVEL_NAME[lv]), el("small", null, fmt(ALTITUDE[lv]) + " KM"));
      b.disabled = i > depth || !target;
      if (i === depth) b.setAttribute("aria-current", "step");
      b.setAttribute("aria-label", `${LEVEL_NAME[lv]}${target && i < depth ? "，" + (target.level === "orbit" ? "軌道全景" : target.name) : ""}`);
      rail.insertBefore(b, needle.parentNode === rail ? needle : null);
    });
    // The needle stays in the DOM so it glides between stops instead of restarting.
    if (needle.parentNode !== rail) rail.append(needle);
    requestAnimationFrame(() => { const stop = rail.children[depth]; if (stop) needle.style.transform = `translateY(${stop.offsetTop + stop.querySelector("i").offsetTop}px)`; });
  }
  function renderHud() {
    const [lon, lat] = [((cam.lon + 540) % 360) - 180, cam.lat];
    $("hud").replaceChildren();
    const a = el("span"); a.append("ALT ", el("b", null, fmt(cam.alt) + " KM"));
    const b = el("span"); b.append(el("b", null, `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? "N" : "S"}  ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? "E" : "W"}`));
    $("hud").append(a, b);
  }
  function updateDock(node = current) {
    const main = $("dock-main"), key = $("dock-key"), label = $("dock-label");
    if (node === root) {
      const t = terr[hoverT >= 0 ? hoverT : targetT];
      key.textContent = "Enter";
      label.textContent = t ? `降落到 ${t.country.name}` : "降落";
      main.setAttribute("aria-label", label.textContent);
    } else {
      key.textContent = "Esc";
      label.textContent = `返回 ${node.parent === root ? "軌道" : node.parent.name}`;
      main.setAttribute("aria-label", label.textContent + "（上一層）");
    }
    const childCount = node.level === "city" && !chunks[node.country.id] ? node.data.townCount || 0 : node.children.length;
    $("zoom-out").disabled = node === root;
    $("zoom-in").disabled = node.level === "town" || childCount === 0;
    main.disabled = node === root && childCount === 0;
  }

  // The pager sits in the panel's sticky header row, so it stays put while stepping and on a collapsed phone sheet.
  let pagerFocus = null;
  function renderPager(node) {
    const list = node.parent?.children || [], i = list.findIndex((n) => n.id === node.id);
    if (list.length < 2 || i < 0) return null;
    const noun = LEVEL_NAME[node.level], pager = el("nav", "pager");
    pager.setAttribute("aria-label", "切換" + noun);
    const step = (dir, path) => {
      const label = `${dir < 0 ? "上一個" : "下一個"}${noun}：${siblingOf(node, dir).name}`;
      const b = button("pager-step", null, () => {
        const hadFocus = document.activeElement === b;
        keyboardNav = false;
        const target = goSibling(dir);
        // The header is rebuilt for the new place; keep focus on the same control for repeated presses.
        if (target && hadFocus) pagerFocus = { dir, id: target.id };
      });
      b.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${path}"/></svg>`;
      b.setAttribute("aria-label", label); b.title = label + (dir < 0 ? "（←）" : "（→）");
      b.dataset.step = String(dir);
      return b;
    };
    pager.append(step(-1, "m9.5 3.5-4.5 4.5 4.5 4.5"), el("span", "pager-count", `${pad2(i)} / ${String(list.length).padStart(2, "0")}`), step(1, "m6.5 3.5 4.5 4.5-4.5 4.5"));
    return pager;
  }

  function renderInspector(node) {
    const head = $("insp-head"), body = $("insp-body"), s = tally(node), d = node.data || {};
    dataVersion++; // A data lookup still loading belongs to the panel being replaced.
    inspector.style.setProperty("--h", node.hue);
    head.tabIndex = 0; head.setAttribute("aria-label", "節點標題與資訊");
    head.replaceChildren();
    body.replaceChildren();
    const row = el("div", "insp-row");
    const chip = el("span", "level-chip" + (node.kind === "uncharted" ? " is-warning" : ""), node.level === "orbit" ? "軌道 · ORBIT" : `${LEVEL_NAME[node.level]} · ${LEVEL_EN[node.level]}`);
    const toggle = button("insp-toggle", null, () => setCollapsed(!collapsed));
    toggle.setAttribute("aria-controls", "insp-body");
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", collapsed ? "展開說明" : "收合說明");
    toggle.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg>';
    const wide = button("insp-toggle insp-wide", null, toggleWide);
    wide.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3H3v3M10 3h3v3M6 13H3v-3M10 13h3v-3"/></svg>';
    const actions = el("div", "insp-actions");
    actions.append(wide, toggle);
    const pager = renderPager(node);
    row.append(...(pager ? [chip, pager] : [chip]), actions);
    head.append(row, el("h2", null, node.level === "orbit" ? DATA.project : node.name));
    if (pager && pagerFocus?.id === node.id) pager.querySelector(`[data-step="${pagerFocus.dir}"]`)?.focus({ preventScroll: true });
    pagerFocus = null;
    const metaText = node.level === "orbit" ? `${s.countries} 系統 · ${s.cities} 模組 · ${s.towns} 功能` : node.level === "town" ? `${node.country.name} › ${node.parent.name}` : node.level === "city" ? `${node.country.name} · ${s.towns} 功能` : `${s.cities} 模組 · ${s.towns} 功能`;
    head.append(el("p", "insp-meta", metaText));
    const stats = el("div", "stats");
    const statCell = (n, label) => { const span = el("span"); span.append(el("b", null, String(n).padStart(2, "0")), label); stats.append(span); };
    if (node.level === "orbit") { statCell(s.countries, "系統"); statCell(s.cities, "模組"); statCell(s.towns, "功能"); }
    else if (node.level === "country") { statCell(s.cities, "模組"); statCell(s.towns, "功能"); statCell(s.residents, "鎮民"); }
    else if (node.level === "city") { statCell(s.towns, "功能"); statCell(s.residents, "鎮民"); statCell((d.dependsOn || []).length, "依賴"); }
    else { statCell((d.residents || []).length, "鎮民"); statCell((d.rules || []).length, "規則"); statCell(relationsOf(node).length, "關聯"); }
    head.append(stats);

    const section = (title, extra, parent = body) => { const sec = el("section", "insp-section"), h = el("h3", null, title); if (extra) h.append(el("small", null, extra)); sec.append(h); parent.append(sec); return sec; };
    const nodeLink = (n, prefix, small) => {
      const b = button("node-link", null, () => go(n.id)); b.style.setProperty("--h", n.hue);
      b.append(el("i", null, prefix), el("span", null, n.name), el("small", null, small || "")); return b;
    };
    function nodeList(parent, values, describe) {
      let shown = 0;
      const more = button("load-more", "顯示更多", () => append(true));
      parent.append(more);
      function append(focus) {
        let first;
        values.slice(shown, shown + PAGE).forEach((n, i) => { const row = nodeLink(n, pad2(shown+i), describe(n)); first ||= row; parent.insertBefore(row, more); });
        shown += PAGE; more.hidden = shown >= values.length;
        if (focus) first?.focus({ preventScroll: true });
      }
      append(false);
    }
    if (node === root) {
      body.append(el("p", "insp-summary", "由外而內：系統 → 模組 → 功能 → 鎮民。點星球上的領土降落；拖曳轉動星球，Esc 回上一層。"));
      const coverage = DATA.coverage, cov = section("文件覆蓋", coverage.covered + " / " + coverage.total), bar = el("div", "coverage"), fill = el("i");
      fill.style.width = clamp(coverage.total ? coverage.covered / coverage.total * 100 : 0, 0, 100) + "%";
      bar.append(fill); cov.append(bar, el("p", "note", (coverage.total - coverage.covered) + " 個入口尚未歸類。"));
      const sys = section("系統", s.countries + " 個");
      nodeList(sys, root.children, (n) => tally(n).cities + " 模組 · " + tally(n).towns + " 功能");
      if (index.parts?.length) {
        const sec = section("程式組成"), chips = el("div", "chips");
        index.parts.forEach((part) => chips.append(el("span", null, (part.repoId ? display.sourceLabel(part.repoId, index) + " / " : "") + part.name + " · " + part.kind))); sec.append(chips);
      }
      if (index.warnings?.length) { const sec = section("檢查提醒"), ul = el("ul"); index.warnings.forEach((warning) => ul.append(el("li", null, warning))); sec.append(ul); }
      addVersions(section("分析來源版本"));
    } else if (node.level === "city" && dataFocus.has(node.id)) {
      renderDataUsage(body, section, node, dataFocus.get(node.id));
    } else if (node.level !== "town") {
      body.append(rich(el("p", "insp-summary"), d.summary));
      if (d.actors?.length) { const sec = section("使用角色"), chips = el("div", "chips"); d.actors.forEach((value) => chips.append(el("span", null, value))); sec.append(chips); }
      const names = node.level === "city" ? display.dataNames(d) : d.data || [];
      if (names.length) {
        const sec = section(node.level === "city" ? "資料" : "資料與實體", node.level === "city" ? "點名稱查看誰用到" : null), chips = el("div", "chips");
        names.forEach((value) => chips.append(node.level === "city" ? dataChip(value, node) : el("span", null, value))); sec.append(chips);
      }
      nodeList(section(node.level === "country" ? "模組" : "功能", node.children.length + " 個"), node.children, (n) => n.level === "city" ? tally(n).towns + " 功能" : TYPE_NAME[n.data.type] || "功能");
      const descendants = (n) => [n, ...n.children.flatMap(descendants)];
      const scope = new Set(descendants(node).map((n) => n.id)), out = new Set(), incoming = new Set();
      for (const n of descendants(node)) for (const id of n.data?.dependsOn || []) if (!scope.has(id)) out.add(id);
      for (const n of nodes.values()) if (!scope.has(n.id) && (n.data?.dependsOn || []).some((id) => scope.has(id))) incoming.add(n.id);
      for (const [label, ids] of [["依賴", out], ["被依賴", incoming]]) if (ids.size) {
        const sec = section(label); nodeList(sec, [...ids].map(dependencyNode), (n) => n.country.name);
      }
      if (Object.keys(chunks).length < root.children.length) body.append(el("p", "note", "鄉鎮層級的依賴只計入已開啟的系統；城市層級完整。"));
    } else {
      const business = section("商業邏輯"); business.id = "business-logic"; business.tabIndex = -1;
      business.append(el("h4", null, "流程與修改入口"), rich(el("p", "insp-summary"), d.summary));
      const common = section("共通商業規則");
      if (d.rules?.length) renderRules(common, d.rules); else common.append(el("p", "note", "此地圖尚未提供共通規則"));
      if (d.residents?.length) {
        const sec = section("鎮民 · 各自的規則", d.residents.length + " 位"), list = el("div", "resident-list");
        let shown = 0;
        const more = button("load-more", "顯示更多鎮民", () => appendResidents(PAGE, true));
        function appendResidents(count, focus) {
          let first;
          d.residents.slice(shown, shown + count).forEach((r, local) => {
            const k = shown + local, card = el("section", "resident-card" + (k === selectedResident ? " is-selected" : ""));
            card.id = "resident-" + k; card.dataset.resident = String(k); card.tabIndex = -1;
            card.append(el("h4", null, r.name)); renderRules(card, r.rules || []); list.append(card); first ||= card;
          });
          shown = Math.min(d.residents.length, shown + count); more.hidden = shown >= d.residents.length;
          if (focus) first?.focus({ preventScroll: true });
        }
        sec.append(list, more); appendResidents(Math.max(PAGE, selectedResident + 1), false);
        list.ensureResident = (k) => { if (k >= shown) appendResidents(k - shown + 1, false); };
      }
      if (Object.keys(chunks).length < root.children.length) body.append(el("p", "note partial-relations", "關聯中的鄉鎮層級只計入已開啟的系統；列出關聯時會載入其他系統。"));
      const tech = el("details", "tech-ref"); tech.id = "technical-reference";
      const toggle = el("summary", "tech-title", "技術參考"); toggle.id = "technical-toggle";
      const grid = el("div", "tech-grid"); tech.append(toggle, grid); body.append(tech);
      addVersions(section("Git 來源版本", null, grid));
      for (const [label, entries] of [["畫面", d.screens], ["API 入口", d.endpoints]]) if (entries?.length) {
        const sec = section(label, entries.length + " 個", grid);
        entries.forEach((entry) => { const row = el("div", "code-line"); row.append(el("code", null, display.referenceLabel(entry,index))); sec.append(row); });
      }
      const groups = display.evidenceGroups(d);
      for (const group of groups) {
        const sec = section(group.label, null, grid);
        group.records.forEach((record) => {
          const row = el("div", "code-line"); row.append(el("code", null, display.evidenceLocation(record,index)), el("small", null, [record.role, record.symbol].filter(Boolean).join(" · "))); sec.append(row);
        });
      }
      if (!groups.length) grid.append(el("p", "note", "此地圖尚未提供程式證據。"));
    }
    body.append(el("p", "insp-foot", "建置於 " + (DATA.builtAt || "—")));
    body.scrollTop = 0;
    applySheetState();
  }
  const accessLabel = (use) => [use.reads && "讀取", use.writes && "寫入"].filter(Boolean).join(" · ");
  // Town ID → use for one loaded city. Null when none of its towns records reads/writes,
  // so an older map that only lists city data is not shown as "nobody uses it".
  function townUses(city, name) {
    const towns = city.data.towns || [];
    if (!towns.some((town) => town.reads?.length || town.writes?.length)) return null;
    return new Map((display.dataUsage([{ cities: [city.data] }], name)[0]?.towns || []).map((use) => [use.town.id, use]));
  }
  function dataChip(name, city) {
    const chip = button("data-chip", name, () => toggleData(name, city));
    chip.dataset.name = name; chip.title = name;
    chip.setAttribute("aria-pressed", String(dataFocus.get(city.id) === name));
    return chip;
  }
  // Choosing a name marks its towns on this city's map and swaps the panel to its users; choosing it again restores the city.
  function toggleData(name, city) {
    if (current !== city) return; // A chip clicked while the map is moving away.
    const opening = dataFocus.get(city.id) !== name, fromPanel = inspector.contains(document.activeElement);
    if (opening) dataFocus.set(city.id, name); else dataFocus.delete(city.id);
    $("subtitle").querySelectorAll(".data-chip[data-name]").forEach((chip) => chip.setAttribute("aria-pressed", String(chip.dataset.name === dataFocus.get(city.id))));
    renderInspector(city);
    if (collapsed) setCollapsed(false); else rebuild(); // Expanding the panel already rebuilds the map.
    const target = fromPanel && (opening ? $("insp-body").querySelector(".data-close") : $("insp-body").querySelector(`.data-chip[data-name="${CSS.escape(name)}"]`));
    if (target) scrollReaderTo(target);
  }
  function renderDataUsage(body, section, node, name) {
    const version = dataVersion, here = display.dataUsage([{ cities: [node.data] }], name)[0];
    const summary = el("p", "note"), head = el("div", "data-head");
    head.append(el("p", "data-eyebrow", "資料 · DATA"), el("h3", "data-title", "誰用到 " + name), summary, button("data-close", "返回城市說明", () => toggleData(name, node)));
    body.append(head);
    const useRow = (use, hue, onClick) => {
      const b = button("node-link data-use", null, onClick); b.style.setProperty("--h", hue);
      b.append(el("span", null, use.town.name), el("small", null, accessLabel(use))); return b;
    };
    const localCount = here?.towns.length || 0, local = section("本城市 · " + node.name, localCount ? localCount + " 個功能" : null);
    if (localCount) here.towns.forEach((use) => local.append(useRow(use, node.hue, () => go(use.town.id))));
    else local.append(el("p", "note", !here?.listed ? "本城市沒有功能讀取或寫入這項資料。" : townUses(node, name) ? "本城市列出這項資料，但沒有功能標明讀取或寫入它。"
      : "本城市列出這項資料，但這份地圖的功能還沒有標明讀寫；用新版 Skill 更新地圖後即可列出。"));
    const others = section("其他城市也用到"), status = el("p", "note", "正在查詢所有系統…");
    others.append(status);
    summary.textContent = `本城市 ${localCount} 個功能 · 正在查詢其他城市…`;
    Promise.all(root.children.map((country) => loadCountry(country.id))).then(() => {
      if (version !== dataVersion) return;
      const all = display.dataUsage(root.children.map((country) => chunks[country.id]).filter(Boolean), name);
      // Cities of the same system come first; the rest keep map order.
      const rest = all.filter((entry) => entry.city.id !== node.id).sort((a, b) => Number(b.country.id === node.country.id) - Number(a.country.id === node.country.id));
      summary.textContent = `${all.reduce((n, entry) => n + entry.towns.length, 0)} 個功能 · ${all.length} 個城市`;
      $("status").textContent = name + "：" + summary.textContent;
      if (!rest.length) { status.textContent = "其他城市沒有用到 " + name + "。"; return; }
      status.remove();
      let shown = 0;
      const more = button("load-more", "顯示更多城市", () => append(true));
      others.append(more);
      function append(focus) {
        let first;
        rest.slice(shown, shown + CITY_PAGE).forEach((entry) => {
          const group = el("div", "data-city"), hue = nodes.get(entry.city.id)?.hue ?? node.hue;
          const open = (id) => { dataFocus.set(entry.city.id, name); go(id); };
          const link = button("node-link data-city-link", null, () => open(entry.city.id)); link.style.setProperty("--h", hue);
          link.append(el("span", null, entry.city.name), el("small", null, entry.country.name + " · " + (entry.towns.length ? entry.towns.length + " 個功能" : "未標明功能")));
          group.append(link, ...entry.towns.map((use) => useRow(use, hue, () => open(use.town.id))));
          others.insertBefore(group, more); first ||= link;
        });
        shown = Math.min(rest.length, shown + CITY_PAGE);
        more.hidden = shown >= rest.length; more.textContent = `顯示更多城市（${shown} / ${rest.length}）`;
        if (focus) first?.focus({ preventScroll: true });
      }
      append(false);
    }, (error) => {
      if (version !== dataVersion) return;
      summary.textContent = `本城市 ${localCount} 個功能 · 其他城市尚未查完`;
      status.textContent = error.message;
      others.append(button("load-more", "重試", () => renderInspector(current)));
    });
  }
  function addVersions(parent) {
    const versions = display.repositoryVersions(index);
    versions.forEach((value) => parent.append(el("p", "note", value)));
    if (!versions.length) parent.append(el("p", "note", "此地圖尚未提供 Git 版本。"));
  }
  function renderRules(parent, rules) {
    const list = el("ul", "business-rules");
    for (const rule of rules) {
      const item = rich(el("li"), display.ruleText(rule));
      if (typeof rule !== "string") {
        item.dataset.ruleId = rule.id; item.tabIndex = -1;
        if (rule.status === "uncertain") { item.prepend(el("span", "rule-status", "待確認")); item.append(el("p", "rule-reason", rule.reason)); }
        if (rule.dependsOn?.length) {
          const deps = el("div", "rule-dependencies", "依據規則：");
          rule.dependsOn.forEach((id) => deps.append(button("rule-link", id, () => locateRule(id)))); item.append(deps);
        }
      }
      list.append(item);
    }
    parent.append(list);
  }
  async function locateRule(id) {
    const token = navigation;
    try {
      for (const country of root.children) {
        await loadCountry(country.id);
        if (token !== navigation) return;
        const owner = [...nodes.values()].find((n) => n.level === "town" && [...(n.data.rules || []), ...(n.data.residents || []).flatMap((r) => r.rules || [])].some((r) => typeof r !== "string" && r.id === id));
        if (!owner) continue;
        if (current !== owner) await go(owner.id);
        if (current !== owner) return;
        if (collapsed) setCollapsed(false);
        const k = (owner.data.residents || []).findIndex((r) => (r.rules || []).some((rule) => typeof rule !== "string" && rule.id === id));
        if (k >= 0) document.querySelector(".resident-list")?.ensureResident?.(k);
        const target = [...inspector.querySelectorAll("[data-rule-id]")].find((item) => item.dataset.ruleId === id);
        if (target) { scrollReaderTo(target, "center"); $("status").textContent = "已定位規則：" + id; }
        return;
      }
      $("status").textContent = "此地圖找不到規則：" + id;
    } catch (error) { showMessage("無法定位規則", error.message, () => locateRule(id)); }
  }
  // On phones the open sheet covers the dock, so the dock also leaves the tab order.
  function applySheetState() {
    const toggle = inspector.querySelector(".insp-toggle:not(.insp-wide)");
    if (collapsed && $("insp-body").contains(document.activeElement)) toggle?.focus({ preventScroll: true });
    if (toggle) { toggle.setAttribute("aria-expanded", String(!collapsed)); toggle.setAttribute("aria-label", collapsed ? "展開說明" : "收合說明"); }
    const sheetOpen = narrow() && !collapsed;
    inspector.classList.toggle("is-collapsed", collapsed);
    $("app").classList.toggle("is-sheet-open", sheetOpen);
    $("dock").inert = sheetOpen;
    layersEl.inert = sheetOpen;
    labelsEl.inert = sheetOpen || current !== root;
  }
  function setCollapsed(value) {
    collapsed = value;
    store(collapseKey(), value ? "1" : "0");
    applySheetState();
    layout();
    rebuild();
  }

  /* ---------- navigation ---------- */
  let current = root, busy = false, queued = null, keyboardNav = false;
  const depthOf = (n) => LEVELS.indexOf(n.level);
  const hashOf = (n) => n === root ? "" : "#" + encodeURIComponent(n.id);
  function showMessage(title, detail, retry) {
    const box = $("stage-message"); box.replaceChildren(el("h2", null, title), el("p", null, detail));
    if (retry) box.append(button("load-more", "重試", retry));
    box.append(button("load-more", "回到全景", () => go(""))); box.hidden = false;
    $("status").textContent = detail;
  }
  async function resolveTarget(id, token) {
    if (!id) return root;
    const known = nodes.get(id), country = known?.country || nodes.get(id.split(".")[0]);
    if (country?.level === "country") await loadCountry(country.id);
    if (token !== navigation) return null;
    // A moved town keeps its historic ID, so its prefix is only the first place to look.
    if (!nodes.has(id)) for (const candidate of root.children) {
      await loadCountry(candidate.id);
      if (token !== navigation) return null;
      if (nodes.has(id)) break;
    }
    const target = nodes.get(id);
    if (!target) throw new Error("此節點不存在或已被隱藏。請回到全景，或重新搜尋。");
    ensureTownGeometry(target.country);
    return target;
  }
  async function go(id, opts = {}) {
    id ||= "";
    const token = ++navigation;
    closeSearch();
    if (busy) {
      queued?.resolve?.(false);
      return new Promise((resolve) => { queued = { id, opts, resolve }; });
    }
    const box = $("stage-message");
    box.replaceChildren(el("p", null, "正在載入功能文件…")); box.hidden = !id;
    let target;
    try { target = await resolveTarget(id, token); }
    catch (error) { if (token === navigation) showMessage("地圖無法展開", error.message, () => go(id, opts)); return; }
    if (token !== navigation || !target) return;
    box.hidden = true;
    if (target === current && !opts.force) {
      if (!opts.fromHistory && location.hash !== hashOf(target)) history.pushState(null, "", hashOf(target) || location.pathname + location.search);
      return true;
    }
    busy = true; stage.classList.add("is-busy");
    const from = current;
    showRelations = from.level === "town" && target.level === "town" ? showRelations : false;
    selectedResident = -1; residentPage = 0; relationPage = 0;
    current = target;
    if (!opts.fromHistory && location.hash !== hashOf(target)) history.pushState(null, "", hashOf(target) || location.pathname + location.search);
    $("classic").href = "classic.html" + hashOf(target);
    try {
      if (opts.initial || from === target) {
        currentLayer?.remove(); currentLayer = null;
        setChrome(target); layout();
        if (target !== root) { cam.ground = 1; currentLayer = buildLayer(target); syncCam(currentLayer.view); }
        else { cam.ground = 0; cam.cx = view.cx; cam.cy = view.cy; cam.zoom = 1; }
      } else if (from === root) await dive(target);
      else if (target === root) await ascend(from);
      else await travel(from, target);
    } catch (error) {
      showMessage("地圖無法顯示", error.message, () => go(target.id, { force: true, initial: true }));
    } finally { busy = false; stage.classList.remove("is-busy"); }
    if (keyboardNav) $("view-title").focus({ preventScroll: true });
    keyboardNav = false; idleSince = performance.now(); kick();
    if (queued) { const q = queued; queued = null; const done = await go(q.id, q.opts); q.resolve?.(done); }
    else if (needsRebuild) { needsRebuild = false; rebuild(); }
    return current === target;
  }

  function enterLayer(layer) {
    if (reduced) return;
    layer.classList.add("is-entering");
    // Wait for delayed entrances too, excluding ambient flows that never finish.
    // Cancellation settles as well, so focus/hover cannot replay a finished fade.
    const entrances = layer.getAnimations({ subtree: true }).filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime));
    Promise.allSettled(entrances.map((animation) => animation.finished)).then(() => layer.classList.remove("is-entering"));
  }

  // Orbit → surface: the planet turns and zooms until it matches the map exactly, then the map takes over.
  async function dive(target) {
    setHover(-1);
    keyboardOrbit = false;
    // Fold the idle sway and pointer tilt into the camera so the planet lands exactly where the map is drawn.
    cam.lon += Math.sin(sway * 0.00016) * 9 * swayAmp + pointer.sx * 3;
    cam.lat = clamp(cam.lat - pointer.sy * 2.4, -75, 75);
    swayAmp = 0; pointer.sx = pointer.sy = 0;
    // The panel may change width with the level; keep the planet's on-screen size while the layout updates.
    const radius = R();
    setChrome(target);
    cam.zoom = radius / view.R0;
    const v = viewFor(target), dur = 1250;
    const turn = animateCam({ lon: v.lon, lat: v.lat }, dur - 150, ease.inOut);
    const move = animateCam({ cx: v.ox, cy: v.oy, zoom: v.s / view.R0 }, dur, ease.inOut);
    await wait(dur - 420);
    const layer = buildLayer(target, v);
    enterLayer(layer);
    currentLayer = layer;
    const land = animateCam({ ground: 1 }, 520, ease.out);
    if (!reduced) layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 520, easing: "ease-out" });
    await Promise.all([turn, move, land]);
    syncCam(v);
  }

  // Surface → orbit: the map hands back to the planet at the same scale, then the camera pulls away.
  async function ascend(from) {
    const old = currentLayer;
    setChrome(root);
    if (old) syncCam(old.view);
    currentLayer = null;
    const fade = animateCam({ ground: 0 }, 420, ease.out);
    if (old) {
      old.inert = true;
      old.classList.add("is-leaving");
      if (!reduced) await settle(old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 420, easing: "ease-in", fill: "forwards" }), 420);
      old.remove();
    }
    await Promise.all([fade, animateCam({ zoom: 1, lat: 14, cx: view.cx, cy: view.cy }, 1250, ease.inOut)]);
  }

  // Surface → surface. Inside one system the maps share a projection, so the old map scales into the new one exactly.
  async function travel(from, target) {
    const old = currentLayer;
    setChrome(target);
    const v = viewFor(target);
    syncCam(v);
    const layer = buildLayer(target, v);
    enterLayer(layer);
    currentLayer = layer;
    if (old) { old.inert = true; old.classList.add("is-leaving"); }
    const dur = 820, easing = "cubic-bezier(.65, 0, .25, 1)";
    if (!reduced && old && old.view.country === v.country) {
      const A = old.view, k = v.s / A.s, tx = v.ox - k * A.ox, ty = v.oy - k * A.oy;
      const forward = `translate(${tx}px, ${ty}px) scale(${k})`, back = `translate(${-tx / k}px, ${-ty / k}px) scale(${1 / k})`;
      // The two maps overlap through the middle of the zoom so the ground never blinks.
      old.animate([{ transform: "none", opacity: 1 }, { opacity: 1, offset: 0.5 }, { transform: forward, opacity: 0 }], { duration: dur, easing, fill: "forwards" });
      await settle(layer.animate([{ transform: back, opacity: 0 }, { opacity: 1, offset: 0.45 }, { transform: "none", opacity: 1 }], { duration: dur, easing }), dur);
    } else if (!reduced && old) {
      old.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 380, easing: "ease-in", fill: "forwards" });
      await settle(layer.animate([{ opacity: 0, transform: "scale(1.04)", transformOrigin: "50% 50%" }, { opacity: 1, transform: "none", transformOrigin: "50% 50%" }], { duration: 640, easing: "cubic-bezier(.16, 1, .3, 1)" }), 640);
    }
    old?.remove();
  }
  const settle = (animation, ms) => Promise.race([animation.finished.catch(() => {}), new Promise((r) => setTimeout(r, ms + 250))]);
  const goUp = () => { if (current !== root) go(current.parent.id); };
  function goDown() {
    if (current === root) { const t = terr[hoverT >= 0 ? hoverT : targetT]; if (t) go(t.country.id); return; }
    if (current.level === "town") return;
    const focused = document.activeElement?.closest?.(".map-label.is-major, .map-pin")?.dataset.id;
    const pick = focused || currentLayer?.hoverId || currentLayer?.querySelector(".map-label.is-major, .dense-card")?.dataset.id || current.children[0]?.id;
    if (pick) go(pick);
  }
  // Previous / next on the same level: wraps inside one parent, in the order of the parent's list.
  // IDs, not identities, because a re-registered chunk replaces its town objects.
  function siblingOf(node, step) {
    const list = node.parent?.children || [], i = list.findIndex((n) => n.id === node.id);
    return list.length > 1 && i >= 0 ? list[(i + step + list.length) % list.length] : null;
  }
  // A quick second step continues from the queued destination rather than repeating it.
  function goSibling(step) {
    const target = siblingOf((queued && nodes.get(queued.id)) || current, step);
    if (target) go(target.id);
    return target;
  }

  /* ---------- search ---------- */
  const searchInput = $("search-input"), results = $("search-results");
  let searchTimer = 0, restoringSearchFocus = false;
  function closeSearch(restoreFocus = false) {
    clearTimeout(searchTimer); results.hidden = true; searchVersion++;
    if (restoreFocus) {
      restoringSearchFocus = true;
      try { searchInput.focus({ preventScroll: true }); }
      finally { restoringSearchFocus = false; }
    }
  }
  async function runSearch() {
    clearTimeout(searchTimer);
    const version = ++searchVersion, q = searchInput.value.trim().toLocaleLowerCase();
    results.replaceChildren();
    if (!q) { results.hidden = true; return false; }
    results.hidden = false; results.append(el("p", "search-note", "搜尋所有系統的功能文件…"));
    try {
      await Promise.all(root.children.map((country) => loadCountry(country.id)));
      if (version !== searchVersion) return false;
      const matches = [...nodes.values()].filter((n) => n !== root && display.searchText(n.data, index).includes(q));
      matches.sort((a,b) => Number(b.name.toLocaleLowerCase().includes(q)) - Number(a.name.toLocaleLowerCase().includes(q)) || depthOf(b)-depthOf(a));
      results.replaceChildren(el("p", "search-note", matches.length ? "找到 " + matches.length + " 個項目" + (matches.length > 60 ? "，先顯示 60 個；可增加關鍵字縮小範圍。" : "") : "找不到符合的功能。試試模組名稱、API 路徑或程式檔名。"));
      matches.slice(0,60).forEach((node) => {
        const b = button("search-hit", null, () => { keyboardNav = true; go(node.id); searchInput.blur(); });
        b.style.setProperty("--h", node.hue);
        b.append(el("strong", null, node.name), el("small", null, ancestors(node).slice(1,-1).map((n)=>n.name).join(" › ") + " · " + LEVEL_NAME[node.level]));
        results.append(b);
      });
      $("status").textContent = "搜尋找到 " + matches.length + " 個項目";
      return true;
    } catch (error) {
      if (version !== searchVersion) return false;
      results.replaceChildren(el("p", "search-note", error.message), button("search-hit", "重試搜尋", runSearch)); return false;
    }
  }
  searchInput.addEventListener("input", () => { searchVersion++; clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 160); });
  searchInput.addEventListener("focus", () => { if (!restoringSearchFocus) runSearch(); });
  searchInput.addEventListener("keydown", async (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); results.querySelector(".search-hit")?.focus(); }
    if (event.key === "Enter") { event.preventDefault(); if (await runSearch()) results.querySelector(".search-hit")?.click(); }
  });
  results.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const list = [...results.querySelectorAll(".search-hit")], i = list.indexOf(document.activeElement);
    if (event.key === "ArrowUp" && i <= 0) { searchInput.focus(); return; }
    list[clamp(i + (event.key === "ArrowDown" ? 1 : -1), 0, list.length - 1)]?.focus();
  });
  $("search-form").addEventListener("submit", (event) => event.preventDefault());
  // Tabbing out of the search closes its results instead of leaving them floating over the map.
  $("search-form").addEventListener("focusout", (event) => { if (!$("search-form").contains(event.relatedTarget)) closeSearch(); });
  document.addEventListener("pointerdown", (event) => { if (!$("search-form").contains(event.target)) closeSearch(); });

  /* ---------- theme toggle ---------- */
  const themeButton = $("theme-toggle");
  const ICON_MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>';
  const ICON_SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>';
  function applyTheme(name, rerender) {
    themeName = name;
    T = THEMES[name];
    document.documentElement.dataset.theme = name;
    document.querySelector('meta[name="theme-color"]').content = T.bg;
    const dark = name === "dark";
    themeButton.innerHTML = (dark ? ICON_SUN : ICON_MOON) + `<span>${dark ? "日間" : "夜間"}</span>`;
    themeButton.setAttribute("aria-pressed", String(dark));
    themeButton.setAttribute("aria-label", dark ? "夜間配色，切換為日間" : "日間配色，切換為夜間");
    paintGroups();
    if (rerender) { rebuild(); kick(); }
  }
  themeButton.addEventListener("click", () => { applyTheme(themeName === "dark" ? "light" : "dark", true); store("atlas-v2-theme", themeName); });

  /* ---------- input ---------- */
  $("home").addEventListener("click", () => go(""));
  $("zoom-out").addEventListener("click", goUp);
  $("zoom-in").addEventListener("click", goDown);
  $("dock-main").addEventListener("click", () => (current === root ? goDown() : goUp()));

  stage.addEventListener("pointerdown", (event) => {
    if (current !== root || busy || event.button !== 0 || event.target.closest("button, a")) return;
    dragging = { x: event.clientX, y: event.clientY, lon: cam.lon, lat: cam.lat, moved: 0, id: event.pointerId };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add("is-dragging");
    keyboardOrbit = false;
  });
  stage.addEventListener("pointermove", (event) => {
    pointer.tx = (event.clientX / W - 0.5) * 2;
    pointer.ty = (event.clientY / H - 0.5) * 2;
    if (current !== root || busy) { kick(); return; }
    if (dragging) {
      const dx = event.clientX - dragging.x, dy = event.clientY - dragging.y, k = 57.3 / R();
      dragging.moved = Math.max(dragging.moved, Math.hypot(dx, dy));
      cam.lon = dragging.lon - dx * k;
      cam.lat = clamp(dragging.lat + dy * k, -70, 70);
      idleSince = performance.now();
    } else if (!event.target.closest("button")) setHover(pickTerritory(event.clientX, event.clientY));
    kick();
  });
  const endDrag = (event) => {
    if (!dragging) return;
    const click = dragging.moved < 5;
    stage.classList.remove("is-dragging");
    try { stage.releasePointerCapture(dragging.id); } catch { /* already released */ }
    dragging = null;
    if (click && event.type === "pointerup") { const t = pickTerritory(event.clientX, event.clientY); if (t >= 0) go(terr[t].country.id); }
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener("pointerleave", () => { if (!dragging && current === root) setHover(-1); pointer.tx = 0; pointer.ty = 0; kick(); });

  // Wheel forward lands on what is under the pointer; backward climbs one level.
  let wheelLock = 0;
  stage.addEventListener("wheel", (event) => {
    if (currentLayer?.classList.contains("is-grid") || event.target.closest(".dense-grid, .relation-list") || event.ctrlKey || Math.abs(event.deltaY) < 4) return;
    if (current.level === "town" && event.deltaY < 0) return;
    event.preventDefault();
    const now = performance.now();
    if (busy || now < wheelLock) return;
    wheelLock = now + 650;
    if (event.deltaY > 0) { goUp(); return; }
    if (current === root) { const t = pickTerritory(event.clientX, event.clientY); const country = terr[t >= 0 ? t : targetT]?.country; if (country) go(country.id); return; }
    const label = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-id]");
    const under = label?.dataset.id || (currentLayer && current.level !== "town" ? nodeAt(currentLayer.view, current, event.clientX, event.clientY)?.id : null);
    if (under) go(under);
  }, { passive: false });

  document.addEventListener("keydown", (event) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
    if (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey) { event.preventDefault(); searchInput.focus(); return; }
    if (event.key === "Escape") {
      const technical = $("technical-reference");
      if (technical?.open) { event.preventDefault(); technical.open = false; $("technical-toggle")?.focus({ preventScroll: true }); return; }
      if (!results.hidden) { const inSearch = $("search-form").contains(document.activeElement); event.preventDefault(); closeSearch(inSearch); return; }
      if (!typing) { keyboardNav = true; goUp(); }
      return;
    }
    if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
    const onControl = event.target.closest?.("button, a");
    if (current === root && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && !onControl) {
      event.preventDefault();
      keyboardOrbit = true;
      idleSince = performance.now();
      const dl = event.key === "ArrowLeft" ? -12 : event.key === "ArrowRight" ? 12 : 0, dp = event.key === "ArrowUp" ? 10 : event.key === "ArrowDown" ? -10 : 0;
      animateCam({ lon: cam.lon + dl, lat: clamp(cam.lat + dp, -60, 60) }, 320, ease.out);
      return;
    }
    // Below orbit, left/right step through the same level. A held key moves once instead of racing through the list.
    if (current !== root && (event.key === "ArrowLeft" || event.key === "ArrowRight") && !event.shiftKey && !event.target.closest?.("#search-form")) {
      event.preventDefault();
      if (!event.repeat) { keyboardNav = true; goSibling(event.key === "ArrowLeft" ? -1 : 1); }
      return;
    }
    if (event.key === "Enter" && current === root && !onControl) { event.preventDefault(); keyboardNav = true; goDown(); return; }
    if (event.key === "+" || event.key === "=") { keyboardNav = true; goDown(); return; }
    if (event.key === "-" || event.key === "_") { keyboardNav = true; goUp(); return; }
    if ((event.key === "r" || event.key === "R") && current.level === "town") { toggleRelations(); }
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Tab") keyboardNav = true; }, true);
  document.addEventListener("pointerdown", () => { keyboardNav = false; }, true);

  function idFromHash() {
    try { return decodeURIComponent(location.hash.slice(1)); }
    catch { return location.hash.slice(1); }
  }
  const followHistory = () => { const id = idFromHash(); if (id !== current.id || busy) go(id, { fromHistory: true }); };
  window.addEventListener("popstate", followHistory);
  window.addEventListener("hashchange", followHistory);
  document.querySelector(".skip-link").addEventListener("click", (event) => {
    event.preventDefault();
    if (collapsed) setCollapsed(false);
    inspector.focus({ preventScroll: true });
  });
  let resizeTimer = 0, wasNarrow = narrow();
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      // Crossing the breakpoint switches between the side panel and the bottom sheet, each with its own remembered state.
      if (narrow() !== wasNarrow) { wasNarrow = narrow(); collapsed = store(collapseKey()) ? store(collapseKey()) === "1" : wasNarrow; applySheetState(); }
      resize(); applyPanelWidth(); layout(); orbitLabels.forEach((l) => (l.size = null)); rebuild(); renderRail(current.level, current.hue);
    }, 120);
  });
  document.addEventListener("visibilitychange", kick);

  /* ---------- start ---------- */
  $("project-name").textContent = DATA.project;
  applyTheme(themeName, false); resize(); setChrome(root); layout();
  cam.cx = view.cx; cam.cy = view.cy;
  const startId = idFromHash();
  if (startId) await go(startId, { fromHistory: true, initial: true });
  else if (!reduced) {
    cam.intro = 0; cam.zoom = .82;
    tween(2400, (t) => { cam.intro = t; }, ease.linear, 250);
    animateCam({ zoom: 1 }, 2200, ease.out, 100);
  }
  if (!root.children.length) showMessage("軌道上還沒有系統", "目前還沒有功能文件。新增國家與城市說明後，重新建置即可開始探索。");
  renderHud(); kick();
})();
