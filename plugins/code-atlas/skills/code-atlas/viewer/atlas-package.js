/* Code Atlas ZIP v1/v2: data only; no extraction, scripts, network or dependencies. */
(function (root) {
  "use strict";
  const MAX_BYTES = 32 * 1024 * 1024, MAX_FILES = 512;
  const SEGMENT = "[a-z0-9]+(?:-[a-z0-9]+)*";
  const COUNTRY = new RegExp("^" + SEGMENT + "$"), ID = new RegExp("^" + SEGMENT + "(?:\\." + SEGMENT + "){0,2}$");
  const RULE_ID = new RegExp("^" + SEGMENT + "(?:\\." + SEGMENT + ")*$");
  const FILE = new RegExp("^(?:manifest\\.json|index\\.json|countries/" + SEGMENT + "\\.json)$");
  const fail = (message) => { throw new Error(message); };
  const check = (condition, message) => { if (!condition) fail(message); };
  const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const text = (value) => typeof value === "string" && value.trim().length > 0;
  const integer = (value) => Number.isSafeInteger(value) && value >= 0;
  const strings = (value) => Array.isArray(value) && value.every(text);
  const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
  const REPOSITORY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    table[i] = value >>> 0;
  }
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const value of bytes) crc = table[(crc ^ value) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  function parseJSON(bytes, name) {
    check(!(bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191), name + " 必須是無 BOM 的 UTF-8 JSON。");
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes), (key, value) => {
        if (["__proto__", "prototype", "constructor"].includes(key)) fail("不支援的 JSON 欄位：" + key);
        return value;
      });
    } catch (error) { fail(name + " 不是有效的 JSON：" + error.message); }
  }
  function readZip(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    check(bytes.byteLength >= 22 && bytes.byteLength <= MAX_BYTES, "請選擇 32 MiB 以內的地圖 ZIP。");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (offset) => view.getUint16(offset, true), u32 = (offset) => view.getUint32(offset, true);
    let end = bytes.length - 22;
    while (end >= Math.max(0, bytes.length - 65557) && u32(end) !== 0x06054b50) end--;
    check(end >= 0 && u32(end) === 0x06054b50 && end + 22 + u16(end + 20) === bytes.length, "ZIP 已損壞或格式不完整。");
    const count = u16(end + 10), size = u32(end + 12), start = u32(end + 16);
    check(u16(end + 4) === 0 && u16(end + 6) === 0 && u16(end + 8) === count && count >= 2 && count <= MAX_FILES,
      "地圖包必須是單一磁碟的 ZIP，且最多 512 個檔案。");
    check(start !== 0xffffffff && size !== 0xffffffff && start + size === end, "不支援 ZIP64 或不完整的 ZIP 索引。");
    const files = new Map(), ranges = [];
    let cursor = start;
    function extras(offset, length) {
      const finish = offset + length;
      while (offset < finish) {
        check(offset + 4 <= finish, "ZIP 額外欄位已損壞。");
        check(u16(offset) !== 1, "不支援 ZIP64。");
        offset += 4 + u16(offset + 2);
        check(offset <= finish, "ZIP 額外欄位已損壞。");
      }
    }
    for (let entry = 0; entry < count; entry++) {
      check(cursor + 46 <= end && u32(cursor) === 0x02014b50, "ZIP 檔案索引已損壞。");
      const flags = u16(cursor + 8), method = u16(cursor + 10), crc = u32(cursor + 16);
      const packed = u32(cursor + 20), length = u32(cursor + 24);
      const nameLength = u16(cursor + 28), extraLength = u16(cursor + 30), commentLength = u16(cursor + 32);
      const local = u32(cursor + 42), next = cursor + 46 + nameLength + extraLength + commentLength;
      check(next <= end && nameLength > 0, "ZIP 檔名或索引已損壞。");
      check((flags & ~0x800) === 0 && method === 0 && packed === length && length <= MAX_BYTES,
        "只支援 Code Atlas 匯出的未壓縮、未加密 ZIP（ZIP_STORED）。");
      check(u16(cursor + 34) === 0 && u16(cursor + 6) <= 20, "不支援多磁碟或 ZIP64 地圖包。");
      const attributes = u32(cursor + 38), kind = (attributes >>> 16) & 0xf000;
      check(!(attributes & 16) && (kind === 0 || kind === 0x8000), "地圖包不能包含目錄或符號連結。");
      const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
      check(FILE.test(name), "地圖包含有不支援的檔案：" + name + "。請使用 atlas export 產生地圖 ZIP。");
      check(!files.has(name), "ZIP 含有重複檔案：" + name);
      extras(cursor + 46 + nameLength, extraLength);
      check(local + 30 <= start && u32(local) === 0x04034b50, "ZIP 本地檔案標頭已損壞。");
      const localNameLength = u16(local + 26), localExtraLength = u16(local + 28), data = local + 30 + localNameLength + localExtraLength;
      check(data + length <= start && localNameLength === nameLength, "ZIP 檔案範圍不正確。");
      check(u16(local + 4) <= 20 && u16(local + 6) === flags && u16(local + 8) === method &&
        u32(local + 14) === crc && u32(local + 18) === packed && u32(local + 22) === length, "ZIP 前後索引不一致。");
      check(bytes.subarray(local + 30, local + 30 + localNameLength).every((value, i) => value === bytes[cursor + 46 + i]), "ZIP 前後檔名不一致。");
      extras(local + 30 + localNameLength, localExtraLength);
      const body = bytes.subarray(data, data + length);
      check(crc32(body) === crc, "ZIP 完整性檢查失敗：" + name);
      files.set(name, parseJSON(body, name));
      ranges.push([local, data + length]);
      cursor = next;
    }
    check(cursor === end, "ZIP 索引長度不一致。");
    ranges.sort((a, b) => a[0] - b[0]);
    let position = 0;
    for (const range of ranges) { check(range[0] === position, "ZIP 含有重疊或額外資料。"); position = range[1]; }
    check(position === start, "ZIP 含有額外資料。");
    return files;
  }
  function validatePackage(files) {
    const manifest = files.get("manifest.json"), index = files.get("index.json");
    check(object(manifest) && manifest.format === "code-atlas" && [1, 2].includes(manifest.version), "這不是 Code Atlas v1/v2 地圖包；分析報告 ZIP 無法匯入。");
    const multi = manifest.version === 2, repositoryIds = new Set(), partIds = new Set();
    const partKey = (repoId, name) => JSON.stringify([repoId, name]);
    function repositories(values) {
      check(Array.isArray(values) && values.length > 0, "多來源地圖必須有 repositories 清單。");
      const ids = new Set();
      values.forEach((repo) => {
        check(object(repo) && text(repo.id) && REPOSITORY_ID.test(repo.id) && text(repo.name) &&
          typeof repo.commit === "string" && COMMIT.test(repo.commit), "來源的 ID、名稱或版本格式不正確。");
        check(!ids.has(repo.id), "重複的來源 ID：" + repo.id); ids.add(repo.id);
      });
      return ids;
    }
    if (multi) {
      repositories(manifest.repositories).forEach((id) => repositoryIds.add(id));
      check(manifest.sourceCommit === undefined, "多來源地圖不能使用單一 sourceCommit。");
    } else check(typeof manifest.sourceCommit === "string" && COMMIT.test(manifest.sourceCommit), "地圖包的來源版本格式不正確。");
    check(text(manifest.projectName) &&
      text(manifest.generatedAt) && /^\d{4}-\d{2}-\d{2}T/.test(manifest.generatedAt) && Number.isFinite(Date.parse(manifest.generatedAt)), "地圖包的專案、來源版本或時間格式不正確。");
    check(strings(manifest.files) && new Set(manifest.files).size === manifest.files.length && !manifest.files.includes("manifest.json") &&
      manifest.files.length === files.size - 1 && manifest.files.every((name) => files.has(name)), "manifest 的檔案清單與 ZIP 不一致。");
    check(object(index) && index.version === manifest.version && ["projectName", "generatedAt"].every((key) => index[key] === manifest[key]), "地圖索引與 manifest 的版本或專案資料不一致。");
    if (multi) {
      repositories(index.repositories);
      check(index.sourceCommit === undefined && index.repositories.length === manifest.repositories.length &&
        index.repositories.every((repo) => manifest.repositories.some((source) => ["id", "name", "commit"].every((key) => source[key] === repo[key]))), "地圖索引與 manifest 的來源版本不一致。");
    } else check(index.sourceCommit === manifest.sourceCommit, "地圖索引與 manifest 的來源版本不一致。");
    function coverage(value) {
      check(object(value) && integer(value.total) && integer(value.covered) && value.covered <= value.total &&
        typeof value.percent === "number" && Number.isFinite(value.percent) && value.percent >= 0 && value.percent <= 100, "文件覆蓋率格式不正確。");
      const expectedPercent = value.total ? value.covered * 100 / value.total : 100;
      check(Math.abs(value.percent - expectedPercent) <= 0.0051, "文件覆蓋率與入口數量不一致。");
    }
    coverage(index.coverage);
    if (multi && index.coverageByRepository !== undefined) {
      check(object(index.coverageByRepository) && Object.keys(index.coverageByRepository).length === repositoryIds.size &&
        Object.keys(index.coverageByRepository).every((id) => repositoryIds.has(id)), "各來源覆蓋率的來源清單不一致。");
      const values = Object.values(index.coverageByRepository);
      values.forEach(coverage);
      check(["total", "covered"].every((key) => values.reduce((sum, entry) => sum + entry[key], 0) === index.coverage[key]), "各來源覆蓋率與整體入口數量不一致。");
    }
    check(strings(index.warnings) && Array.isArray(index.parts) && index.parts.every((part) => object(part) && text(part.name) && ["frontend", "backend", "generic"].includes(part.kind)) && integer(index.hiddenCount), "地圖索引的 warnings、parts 或 hiddenCount 格式不正確。");
    if (multi) index.parts.forEach((part) => {
      check(repositoryIds.has(part.repoId), "程式組成指向不存在的來源：" + part.repoId);
      const key = partKey(part.repoId, part.name);
      check(!partIds.has(key), "重複的來源程式組成：" + part.repoId + "/" + part.name); partIds.add(key);
    });
    check(Array.isArray(index.countries) && index.countries.length > 0 && index.countries.length === files.size - 2, "地圖包缺少國家或含有未列入索引的檔案。");
    const chunks = Object.create(null), ids = new Set(), references = [], ruleIds = new Set(), ruleReferences = [];
    // Both viewers must traverse the same hierarchy. Do not let an extra child
    // collection, resident ID or overview weight override the validated branch.
    function controls(value, allowed) {
      for (const key of ["id", "level", "type", "cities", "towns", "residents", "children", "townCount", "chunk"]) {
        check(!Object.prototype.hasOwnProperty.call(value, key) || allowed.includes(key), "此層級不允許 " + key + " 欄位。");
      }
    }
    function evidence(records) {
      check(Array.isArray(records), "程式位置必須是陣列。");
      records.forEach((record) => {
        check(object(record) && text(record.file) && !/^[\\/]|:|\\|[\x00-\x1f]/.test(record.file) &&
          !record.file.split("/").some((part) => ["", ".", ".."].includes(part)) && ["screen", "api", "logic", "data", "config"].includes(record.role), "程式位置必須是相對檔案路徑，且有正確的角色。");
        if (record.symbol !== undefined) check(text(record.symbol), "程式符號必須是非空文字。");
        if (record.line !== undefined) check(integer(record.line) && record.line > 0, "程式行號必須是正整數。");
        delete record.line; // Legacy packages may contain unstable line numbers; never persist them on import.
        if (multi) check(repositoryIds.has(record.repoId), "程式位置指向不存在的來源：" + record.repoId);
      });
    }
    function rules(values, register = true) {
      check(Array.isArray(values), "規則必須是陣列。");
      values.forEach((rule) => {
        if (text(rule)) return;
        check(object(rule) && Object.keys(rule).every((key) => ["id", "text", "status", "reason", "evidence", "dependsOn"].includes(key)) &&
          text(rule.id) && RULE_ID.test(rule.id) && text(rule.text) && ["confirmed", "uncertain"].includes(rule.status), "規則物件的 ID、文字、狀態或欄位不正確。");
        if (rule.reason !== undefined) check(text(rule.reason), "規則原因必須是非空文字。");
        if (rule.status === "uncertain") check(text(rule.reason), "待確認規則必須說明原因。");
        check(Array.isArray(rule.evidence) && rule.evidence.length > 0, "規則物件至少需要一筆程式證據。");
        evidence(rule.evidence);
        if (rule.dependsOn !== undefined) check(strings(rule.dependsOn) && rule.dependsOn.every((id) => RULE_ID.test(id)), "規則 dependsOn 必須是規則 ID 陣列。");
        if (register) {
          check(!ruleIds.has(rule.id), "重複的規則 ID：" + rule.id);
          ruleIds.add(rule.id); ruleReferences.push(...(rule.dependsOn || []));
        }
      });
    }
    function interfaces(values, field) {
      if (!multi) { check(strings(values), field + " 必須是文字陣列。"); return; }
      check(Array.isArray(values), field + " 必須是來源限定的入口陣列。");
      const seen = new Set();
      values.forEach((entry) => {
        check(object(entry) && text(entry.key) && text(entry.part) && repositoryIds.has(entry.repoId) &&
          partIds.has(partKey(entry.repoId, entry.part)), field + " 指向不存在的來源或程式組成，或缺少入口 key。");
        const key = JSON.stringify([entry.repoId, entry.part, entry.key]);
        check(!seen.has(key), field + " 含有重複的來源入口。"); seen.add(key);
      });
    }
    function node(value, level, depth, register = true) {
      check(object(value) && value.level === level && text(value.id) && ID.test(value.id) && value.id.split(".").length === depth && text(value.name) && text(value.summary), "國家、城市或鄉鎮的必要欄位不正確。");
      const allowed = level === "country" ? ["id", "level", "cities", ...(register ? [] : ["townCount", "chunk"])]
        : level === "city" ? ["id", "level", ...(register ? ["towns"] : ["townCount"])] : ["id", "level", "type", "residents"];
      controls(value, allowed);
      if (register) { check(!ids.has(value.id), "重複的節點 ID：" + value.id); ids.add(value.id); }
      for (const key of ["actors", "data", "dependsOn", "reads", "writes"]) {
        if (value[key] !== undefined) check(strings(value[key]), value.id + " 的 " + key + " 必須是文字陣列。");
      }
      if (value.rules !== undefined) {
        if (level !== "town") check(strings(value.rules), "規則物件只能放在鄉鎮或鎮民。");
        rules(value.rules, register);
      }
      for (const key of ["screens", "endpoints"]) if (value[key] !== undefined) interfaces(value[key], value.id + " 的 " + key);
      if (value.dependsOn) references.push(...value.dependsOn);
      if (value.evidence !== undefined) evidence(value.evidence);
      if (value.residents !== undefined) {
        check(level === "town" && Array.isArray(value.residents), "鎮民必須放在鄉鎮內。");
        const names = new Set();
        value.residents.forEach((resident) => {
          check(object(resident) && text(resident.name) && !names.has(resident.name), "鎮民名稱不可為空白或重複。");
          controls(resident, []);
          names.add(resident.name);
          if (resident.rules !== undefined) rules(resident.rules);
          if (resident.evidence !== undefined) evidence(resident.evidence);
        });
      }
    }
    for (const meta of index.countries) {
      node(meta, "country", 1, false);
      check(COUNTRY.test(meta.id) && meta.chunk === "countries/" + meta.id + ".json" && Array.isArray(meta.cities), "國家 chunk 路徑或城市清單不正確。");
      const country = files.get(meta.chunk);
      node(country, "country", 1);
      check(country.id === meta.id && country.name === meta.name && country.summary === meta.summary && Array.isArray(country.cities) &&
        country.cities.length === meta.cities.length && JSON.stringify(country.actors || []) === JSON.stringify(meta.actors || []), "國家概要與完整內容不一致。");
      let townCount = 0;
      country.cities.forEach((city, i) => {
        const brief = meta.cities[i];
        node(city, "city", 2); node(brief, "city", 2, false);
        check(city.id.startsWith(country.id + ".") && city.id === brief.id && city.name === brief.name && city.summary === brief.summary &&
          Array.isArray(city.towns) && brief.townCount === city.towns.length &&
          JSON.stringify(city.dependsOn || []) === JSON.stringify(brief.dependsOn || []), "城市概要與完整內容不一致。");
        townCount += city.towns.length;
        city.towns.forEach((town) => {
          node(town, "town", 3);
          check(["operation", "job", "rule", "uncovered"].includes(town.type) && Array.isArray(town.evidence) && town.evidence.length > 0, "鄉鎮必須有類型與程式位置。");
        });
      });
      check(meta.townCount === townCount, "國家的鄉鎮數與完整內容不一致。");
      chunks[country.id] = country;
    }
    check(references.every((id) => ids.has(id)), "dependsOn 指向不存在的節點。");
    check(ruleReferences.every((id) => ruleIds.has(id)), "規則 dependsOn 指向不存在的規則。");
    check([...ruleIds].every((id) => !ids.has(id)), "規則 ID 不可與節點 ID 重複。");
    return { manifest, index, chunks };
  }
  function parse(input) {
    try { return validatePackage(readZip(input)); }
    catch (error) { if (error instanceof RangeError) fail("地圖 ZIP 的資料範圍或結構不正確。"); throw error; }
  }
  function sourceLabel(id, metadata) {
    const repo = metadata?.repositories?.find((entry) => entry.id === id);
    return repo && repo.name !== id ? repo.name + " (" + id + ")" : id;
  }
  function referenceLabel(value, metadata) {
    return typeof value === "string" ? value : sourceLabel(value.repoId, metadata) + "/" + value.part + " · " + value.key;
  }
  function evidenceLocation(record, metadata) {
    return (record.repoId ? sourceLabel(record.repoId, metadata) + " / " : "") + record.file;
  }
  function repositoryVersions(metadata) {
    return metadata.repositories ? metadata.repositories.map((repo) => sourceLabel(repo.id, metadata) + " · " + repo.commit.slice(0, 8))
      : metadata.sourceCommit ? ["版本 " + metadata.sourceCommit.slice(0, 8)] : [];
  }
  function searchText(node, metadata) {
    const evidenceFields = (records) => (records || []).flatMap((entry) => [evidenceLocation(entry, metadata), entry.symbol]);
    const ruleFields = (rules) => (rules || []).flatMap((rule) => typeof rule === "string" ? [rule] :
      [rule.id, rule.text, rule.status, rule.status === "uncertain" ? "待確認" : "已確認", rule.reason, ...evidenceFields(rule.evidence)]);
    return [node.name, node.id, node.summary, ...(node.screens || []).map((entry) => referenceLabel(entry, metadata)),
      ...(node.endpoints || []).map((entry) => referenceLabel(entry, metadata)), ...ruleFields(node.rules), ...evidenceFields(node.evidence),
      ...(node.residents || []).flatMap((resident) => [resident.name, ...ruleFields(resident.rules), ...evidenceFields(resident.evidence)])]
      .filter(Boolean).join(" ").toLocaleLowerCase();
  }
  const ruleText = (rule) => typeof rule === "string" ? rule : rule.text;
  function evidenceGroups(node) {
    const groups = [];
    const add = (label, owner) => {
      if (owner.evidence?.length) groups.push({ label, records: owner.evidence });
      (owner.rules || []).forEach((rule) => {
        if (typeof rule !== "string" && rule.evidence?.length) groups.push({ label: label + " · 規則 " + rule.id, records: rule.evidence });
      });
    };
    add("鄉鎮 · " + node.name, node);
    (node.residents || []).forEach((resident) => add("鎮民 · " + resident.name, resident));
    return groups;
  }
  // Data names on a city: its listed data first, then names its towns read or write.
  // Names the city's own towns write come first (its main data); the rest follow. Each group keeps its authored order.
  function dataNames(city) {
    const towns = city.towns || [], written = new Set(towns.flatMap((town) => town.writes || []));
    const names = [...new Set([...(city.data || []), ...towns.flatMap((town) => [...(town.reads || []), ...(town.writes || [])])])];
    return [...names.filter((name) => written.has(name)), ...names.filter((name) => !written.has(name))];
  }
  // Every city using a data name, in map order. Names match exactly, so SalesOrder never
  // matches SalesOrder_Detail. A city that only lists the name has no town-level uses.
  function dataUsage(countries, name) {
    const usage = [];
    for (const country of countries) for (const city of country.cities || []) {
      const towns = (city.towns || []).map((town) => ({ town, reads: (town.reads || []).includes(name), writes: (town.writes || []).includes(name) }))
        .filter((use) => use.reads || use.writes);
      const listed = (city.data || []).includes(name);
      if (listed || towns.length) usage.push({ country, city, listed, towns });
    }
    return usage;
  }
  const display = Object.freeze({ sourceLabel, referenceLabel, evidenceLocation, repositoryVersions, searchText, ruleText, evidenceGroups, dataNames, dataUsage });
  const api = Object.freeze({ parse, crc32, MAX_BYTES, MAX_FILES, display });
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AtlasPackage = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
