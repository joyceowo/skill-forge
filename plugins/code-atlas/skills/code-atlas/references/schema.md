# 資料格式

`.atlas/` 目錄裡每個檔案的格式。範例見 `examples/member/`。

以下原有範例是單 Git v1。多 Git v2 的建立與完整例子見 [multi-repository.md](multi-repository.md)，差異如下；國家／城市／鄉鎮的階層和 ID 規則不變。

| v2 資料 | 欄位與邊界 |
|---|---|
| config | `version:2`；`repositories:[{id,path,name?}]`；parts 加 `repoId`，name 在同來源內唯一；前端可設 `apiTargets:[{repoId,part}]` |
| 路徑 | repository.path 相對共同工作區；parts.path、pageDirs、evidence.file 相對所屬 Git，不能越界或交疊來源 |
| inventory | `version:2`；`repositories:{ID:{commit,sourceSnapshot}}` 代替 commit/sourceSnapshot；items 加 repoId；pairedWith 為 `{repoId,part,key}` |
| 入口 | 鄉鎮 endpoints/screens 為 `{repoId,part,key}` 陣列；不能使用未限定來源的字串 |
| 證據 | 鄉鎮及居民 evidence 加 repoId；file/symbol/role 保留，不輸出來源行號 |
| progress | `version:2`、mode、`repositories`（取自本輪 inventory）、countries；來源或快照改變須重新確認完成狀態 |
| state | `version:2`、`repositories:{ID:{baseCommit,branch,sourceSnapshot}}`、analyzedAt、documentsSnapshot；只由 finish 寫入 |
| validate | 保留 aggregate coverage，新增 `coverageByRepository:{ID:{total,covered,percent}}`；無入口來源為 total=0、covered=0、percent=100，不代表程式分析完整 |
| build/export | metadata 與 manifest 使用 `version:2`、`repositories:[{id,name,commit}]`，不使用假合併 sourceCommit |

repoId 允許英數字開頭，後續英數字、`_`、`-`；不能是 `__proto__`、`prototype`、`constructor`。設定中的來源集合必須與 inventory／progress／state 一致；加入或移除來源要重新檢視文件與基準。未知來源、來源外檔案及錯誤 part 引用不可通過驗證。

## 目錄與負責者

```
.atlas/
├─ config.json      人工（init 產生初稿）
├─ glossary.json    AI 新增、人工可修改
├─ state.json       腳本（finish 時寫入）
├─ progress.json    AI（照 SKILL.md 步驟更新）
├─ rule-review.json AI（核對當次語法候選）
├─ overrides.json   人工（AI 只讀，不可寫）
├─ nodes/           AI（唯一要寫說明的地方）
│  └─ <國家 ID>/
│     ├─ _country.json
│     └─ <城市 ID 最後一段>.json
├─ inventory.json   腳本（scan 產生，可重產）
└─ build/           腳本（build 產生，可重產）
```

## 共通規則

- 編碼 UTF-8，縮排 2 個空白。
- 檔案路徑一律相對於專案根目錄，用 `/` 分隔：`react/src/pages/Home.tsx`。
- ID 格式：每一段是小寫英文、數字、連字號（`[a-z0-9]+(-[a-z0-9]+)*`），層級之間用 `.` 串接。
  - 國家：`member`（1 段）
  - 城市：`member.points`（2 段）
  - 鄉鎮：`member.points.accrue`（3 段）
- 保留的國家 ID：`infra`（基礎設施）、`uncharted`（未開發地區，只由 build 產生，不可手寫）。
- API 寫法：`"<HTTP 方法> <路徑>"`，方法大寫，路徑以 `/` 開頭，參數寫成 `{名稱}`、不加型別限制，結尾不加 `/`：
  `"PUT /api/knowledge/data-center/datasets/{id}/access"`。
  方法是 `GET`、`POST`、`PUT`、`PATCH`、`DELETE`、`HEAD`、`OPTIONS` 之一；從程式判斷不出方法時（例如 Django 沒有限制 method 的 view）寫 `ANY`。

## config.json

```json
{
  "version": 1,
  "projectRoot": "..",
  "language": "zh-Hant",
  "parts": [
    {
      "name": "web",
      "path": "web",
      "kind": "frontend",
      "framework": "react",
      "apiPrefix": "",
      "pageDirs": ["web/src/pages"]
    },
    { "name": "api", "path": "api", "kind": "backend", "framework": "aspnetcore" }
  ],
  "exclude": ["**/.env*", "**/*secrets*", "**/*.pfx", "**/Migrations/**"]
}
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `version` | ✅ | 格式版本，目前是 `1` |
| `projectRoot` | ✅ | 專案根目錄。相對路徑以 `.atlas/` 為基準；`.atlas` 放在專案外時用絕對路徑 |
| `projectName` | | 非空白的地圖顯示名稱；省略時沿用來源根目錄名稱。build／export 都使用此值 |
| `language` | ✅ | 說明文字的語言，預設 `zh-Hant` |
| `parts` | ✅ | 專案的組成部分，至少 1 個。只有 frontend 是純前端、只有 backend 是純後端、兩種都有是前後端 |
| `parts[].name` | ✅ | 顯示名稱，不可重複 |
| `parts[].path` | ✅ | 這部分的根目錄（相對於 projectRoot，可以是 `.`） |
| `parts[].kind` | ✅ | `frontend`、`backend` 或 `generic`；無框架清單的來源使用 generic |
| `parts[].framework` | ✅ | `react`、`vue`、`aspnetcore`、`fastapi`、`flask`、`django`；generic part 使用 `generic` |
| `parts[].apiPrefix` | | 前端：axios instance 的 `baseURL` 無法靜態解析，或以空字串初始化後由 runtime interceptor 設定時，要加在 API 呼叫前面的前綴。非空的固定 `baseURL` 優先使用，不會再加上 apiPrefix |
| `parts[].pageDirs` | | 前端：放頁面元件的目錄；這些目錄裡的元件會被當成畫面 |
| `exclude` | | 不分析的檔案（glob）。機密檔、自動產生的程式、測試都應該排除 |

## glossary.json

```json
{
  "terms": {
    "Member": "會員",
    "Tier": "會員等級",
    "Point": "點數"
  }
}
```

英文詞 → 說明裡固定使用的中文詞。遇到新的業務詞彙時，先加進來再使用，讓每次分析的用詞一致。

## state.json（腳本寫入）

```json
{
  "version": 1,
  "baseCommit": "09a196a3f1c2...",
  "branch": "main",
  "analyzedAt": "2026-10-02T22:30:00+08:00"
}
```

`baseCommit` 是地圖目前對應的程式版本。`diff` 會拿它和 HEAD 比較。只有 `finish` 成功才寫入；驗證、盤點版本／指紋、未提交檔案或 progress 檢查失敗時保留舊基準。Detached HEAD 的 branch 為 `(detached)`。

`finish` 另外寫入 `documentsSnapshot`（SHA-256 文件指紋），涵蓋 config、inventory、nodes、overrides、progress 與 rule-review，以及 `ruleIndex` 規則基準。`export` 必須與完成時一致，這些檔案被改動或舊 state 沒有指紋時需重新 `finish`，不可手動補值。舊 state 仍可用於 `status`／`diff`。可攜 ZIP 資料格式見 [package.md](package.md)。

## progress.json（AI 更新）

```json
{
  "mode": "init",
  "sourceCommit": "09a196a3f1c2...",
  "countries": [
    { "id": "member", "status": "done" },
    { "id": "order", "status": "in-progress" },
    { "id": "infra", "status": "pending" }
  ]
}
```

- `mode`：`init`（初次分析）或 `update`（增量更新）。
- `status`：`pending`、`in-progress`、`done`。中斷後從第一個不是 `done` 的國家接著做。
- `sourceCommit`：本輪檢視的完整 Git HEAD。恢復時必須仍是相同版本；不同版本先重新列工作清單，不沿用舊 done。
- 可選 `uncoveredReasons`：`[{"kind":"endpoint","key":"GET /health","reason":"尚待確認的具體原因"}]`。只記錄確實無法分類的理由，不會提高 coverage，也不代替文件。
- 手工文件可沒有 progress；若存在，`finish` 要求 `sourceCommit` 等於 HEAD、所有 countries 都為 done。不要手動改 state 來跳過檢查。

## nodes/&lt;國家&gt;/_country.json

```json
{
  "id": "member",
  "name": "會員系統",
  "summary": "（寫給 SA 的說明）",
  "actors": ["會員", "客服人員"],
  "cities": ["member.profile", "member.level", "member.points"]
}
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `id` | ✅ | 國家 ID（1 段），必須和資料夾名稱相同 |
| `name` | ✅ | 業務名稱 |
| `summary` | ✅ | SA 說明，寫法見 `writing.md` |
| `actors` | | 使用這個系統的角色 |
| `cities` | ✅ | 城市 ID，順序就是畫面上的順序；必須和資料夾裡的城市檔一一對應 |

## nodes/&lt;國家&gt;/&lt;城市&gt;.json

檔名是城市 ID 的最後一段：`member.points` → `nodes/member/points.json`。

```json
{
  "id": "member.points",
  "name": "點數系統",
  "summary": "（寫給 SD 的說明）",
  "data": ["MemberPoints", "PointTransactions"],
  "dependsOn": ["member.level"],
  "towns": [
    {
      "id": "member.points.redeem",
      "name": "點數扣除",
      "type": "operation",
      "summary": "（寫給 PG 的說明）",
      "rules": ["1 點折抵 1 元"],
      "screens": ["/checkout"],
      "endpoints": ["POST /api/points/redeem"],
      "reads": ["MemberPoints"],
      "writes": ["PointTransactions"],
      "evidence": [
        { "file": "web/src/pages/checkout/Checkout.tsx", "symbol": "Checkout", "role": "screen" },
        { "file": "api/Points/PointsController.cs", "symbol": "PointsController.Redeem", "role": "api" }
      ],
      "dependsOn": []
    }
  ]
}
```

城市欄位：

| 欄位 | 必填 | 說明 |
|---|---|---|
| `id` | ✅ | 城市 ID（2 段），第一段必須是所屬國家 |
| `name` | ✅ | 業務名稱 |
| `summary` | ✅ | SD 說明 |
| `data` | | 主要的資料表或實體名稱；網站把它和鄉鎮的 `reads`／`writes` 合併成可點的資料名稱，本城市有鄉鎮寫入的排在前面 |
| `dependsOn` | | 依賴的其他城市或國家 ID |
| `towns` | ✅ | 鄉鎮，至少 1 個 |

鄉鎮欄位：

| 欄位 | 必填 | 說明 |
|---|---|---|
| `id` | ✅ | 鄉鎮 ID（3 段）。建立時前兩段等於城市 ID；之後搬到別的城市時保留原 ID |
| `name` | ✅ | 業務名稱，用動詞或業務名詞：「點數扣除」「等級權益」 |
| `type` | ✅ | `operation`（使用者操作）、`job`（排程或事件觸發的背景作業）、`rule`（有獨立程式的業務規則） |
| `summary` | ✅ | PG 說明 |
| `rules` | | 共通商業規則；新分析使用下方規則物件，舊字串陣列保留讀取相容 |
| `residents` | | 鎮民：鄉鎮裡各自有規則的欄位、選項或類別，見下方 |
| `screens` | | 相關畫面：前端路由（以 `/` 開頭）或頁面檔案路徑 |
| `endpoints` | | 相關 API，格式見「共通規則」 |
| `evidence` | ✅ | 程式位置，至少 1 筆 |
| `evidence[].file` | ✅ | 檔案路徑 |
| `evidence[].symbol` | | 類別、方法、函式或元件名稱；方法寫成 `類別.方法`。不儲存行號；build 只驗證來源，不增加 line |
| `evidence[].role` | ✅ | `screen`（畫面）、`api`（API 進入點）、`logic`（商業邏輯）、`data`（資料存取或實體）、`config`（設定） |
| `reads` | | 從程式查到此鄉鎮讀取的資料表或實體名稱，與城市 `data` 同一寫法；不可空白或重複 |
| `writes` | | 此鄉鎮新增、修改或刪除的資料表或實體名稱；規則同 `reads`。查不到實際名稱時不填 |
| `dependsOn` | | 依賴的其他節點 ID（任何層級） |

### 商業規則物件

鄉鎮與鎮民的 `rules` 均接受舊字串及以下新物件；新分析使用物件。舊字串沒有逐條追蹤能力，工具聚合回報此限制，不自動從文字或陣列序號捏造永久 ID。

| 欄位 | 必填 | 說明 |
|---|---|---|
| `id` | ✅ | 全圖唯一的穩定小寫點分 ID；每段可用連字號，不限段數，內容改寫與來源移動時保留 |
| `text` | ✅ | 純商業文字，包含實際條件與數值，不夾 API、檔案或行號 |
| `status` | ✅ | `confirmed` 或 `uncertain` |
| `reason` | uncertain 時 | 已查範圍與尚待確認原因 |
| `evidence` | ✅ | 至少一筆來源，規則可有多個來源；欄位同鄉鎮 evidence，v2 需 repoId |
| `dependsOn` | | 其他規則 ID 陣列，與地圖節點的 dependsOn 分開驗證 |

```json
{"id":"member.profile.name.length","text":"姓名長度需為 2–50 字","status":"confirmed","evidence":[{"file":"api/Member/Profile/MemberProfileService.cs","symbol":"MemberProfileService.UpdateNameAsync","role":"logic"}],"dependsOn":[]}
```

Git 版本集中保存在 state／ZIP metadata，不在每條規則重複。規則 ID 不含位置或內容 hash；檔案、方法改名需依 Git 變更核對證據。來源一律不儲存行號。

鎮民欄位（`residents[]`）：

```json
{
  "name": "生日",
  "rules": ["只能修改一次", "不可晚於今天"],
  "evidence": [
    { "file": "api/Member/Profile/MemberProfileService.cs", "symbol": "MemberProfileService.UpdateBirthdayAsync", "role": "logic" }
  ]
}
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `name` | ✅ | 項目名稱，同一個鄉鎮裡不可重複 |
| `rules` | | 這個項目專屬的規則 |
| `evidence` | | 這個項目專屬的程式位置，格式和鄉鎮的 `evidence` 相同 |

鎮民沒有 ID，不能被 `dependsOn` 或 `overrides` 指到。

## overrides.json（人工維護，AI 不可寫）

```json
{
  "rename": { "member.points": "會員點數" },
  "summary": { "member": "人工改寫的 SA 說明" },
  "move": { "member.points.redeem": "member.checkout" },
  "hide": ["infra.samples"]
}
```

| 欄位 | 說明 |
|---|---|
| `rename` | 節點 ID → 新名稱 |
| `summary` | 節點 ID → 取代 AI 寫的說明 |
| `move` | 鄉鎮 ID → 新的城市 ID（ID 不變） |
| `hide` | 不顯示在畫面上的節點 ID |

build 時才套用，所以重新分析不會蓋掉人工修正。

## inventory.json（scan 產生）

```json
{
  "version": 1,
  "commit": "09a196a3f1c2...",
  "items": [
    {
      "kind": "endpoint",
      "key": "POST /api/points/redeem",
      "part": "api",
      "file": "api/Points/PointsController.cs",
      "line": 31,
      "symbol": "PointsController.Redeem",
      "source": "aspnet-attribute"
    },
    {
      "kind": "api-call",
      "key": "POST /api/points/redeem",
      "part": "web",
      "file": "web/src/lib/api/points.ts",
      "line": 12,
      "source": "fetch",
      "pairedWith": "POST /api/points/redeem"
    }
  ]
}
```

| `kind` | `key` 的內容 | 需要被鄉鎮涵蓋 |
|---|---|---|
| `endpoint` | `"<方法> <路徑>"` | ✅（鄉鎮的 `endpoints`） |
| `route` | 前端路由路徑 | ✅（鄉鎮的 `screens`） |
| `page` | 頁面檔案路徑 | ✅（鄉鎮的 `screens` 或 `evidence`） |
| `api-call` | `"<方法> <路徑>"`（已加上 apiPrefix） | 不需要，用來把前端和後端配對 |

`source` 記錄是用哪一種規則抽出來的（例如 `aspnet-attribute`、`abp-conventional`、`fastapi`、`tanstack-router`、`fetch`），方便除錯。

`line` 是目前原始碼的 1-based 行號。掃描讀取 Git 追蹤檔案的目前內容；`commit` 記錄 HEAD，未建立第一筆提交時為空字串，不表示未提交內容已進入版本歷史。

`scan` 另寫入 `sourceSnapshot`（SHA-256 字串）：包括 parts／exclude 設定及全部未排除的 Git 追蹤檔案內容，略過指定 atlas 目錄。掃描前後的指紋及 HEAD 不同時拒絕保存；`finish` 再比對，避免掃描髒程式後還原檔案卻將文件標為對應 HEAD。舊 inventory 沒有此欄位仍可 validate／build，但需重新 scan 才能 finish。

## 更新命令輸出

- `diff`：`baseCommit`、`headCommit`、`upToDate`、`changes`（status／path／改名時的 oldPath）、`affectedTowns`（id／文件／原因／鎮民）、`worklist`、`renamedDocuments`、`changeRatio`、`recommendFullAnalysis`、`warnings`。超過 30% 建議全量檢視。改名會先備份、只改受影響文件的 evidence.file 與檔案型 screens，不改 ID 或 overrides。
- `diff --since <commit>`：覆寫本次比較起點，並不寫 state；無效基準、無 HEAD 或未提交來源變更會失敗。
- `finish`：`state`、`coverage`、`uncharted`、`warnings`；成功才保存 state.json。未覆蓋項目仍是警告，不等同證據錯誤。
- `manualRenames`：diff 中新舊路徑相互重疊、未自動套用的改名清單；需核對目前程式與文件後逐筆處理，重跑不會再次套用而誤連證據。
- `status`：唯讀回傳 headCommit／baseCommit、baseValid、upToDate、dirtyFiles、changedFiles、inventoryCurrent、valid／errors、coverage、progress 和 warnings。`upToDate` 表示該專案範圍沒有差異或未提交檔案，仍需一起檢查盤點是否過期、驗證結果與進度。

diff／finish 只忽略指定 atlas 目錄內的生成或文件變更；不會自行忽略其他未提交／未追蹤檔案。不完整的分析應先完成，再呼叫 finish。

## validate 的命令輸出

```json
{
  "valid": true,
  "errors": [],
  "warnings": ["1 inventory item(s) are uncharted"],
  "coverage": { "total": 17, "covered": 16, "percent": 94.12 },
  "uncharted": []
}
```

上例省略 `uncharted` 的項目內容；實際輸出保留未涵蓋的 inventory 項目。`endpoint` 以鄉鎮的 endpoints 判斷，`route` 以 screens 判斷，`page` 以 screens 或鄉鎮／鎮民 evidence 的檔案判斷，api-call 不計入分母。API 參數名稱、型別限制與前端參數寫法會正規化後比對。

- 錯誤會使 `valid` 為 false 並以非 0 退出；未涵蓋項目是警告。
- 缺少或無效 inventory 不能算通過；有效但為空的 inventory 覆蓋率為 100%（0／0）。
- 沒有 nodes 或國家沒有城市，可建置為空狀態；已建立的城市仍需至少一個鄉鎮。
- `overrides` 的目標必須存在，搬移只能從鄉鎮到城市。隱藏只影響畫面，覆蓋率仍依原始文件計算。
- `validate` 唯讀；`build` 先驗證來源存在，再輸出不含來源行號的 evidence。候選與規則也不保存來源行號；入口 inventory 的 line 僅是掃描內部資料，不進入地圖來源。

## 產物與備份

`init` 拒絕覆寫已有的 config。重新產生 JSON 前將舊檔存至同目錄 `.backups/`；build 完整產生暫存畫面後才替換既有 build，舊畫面保留在 `build.backup-<識別碼>/`。人工維護的 overrides 不由任何命令建立或修改。

畫面共用同一份資料：`build/index.html` 是以 viewer/globe.html 產生的預設地球儀畫面，`build/globe.html` 為相容入口，`build/classic.html` 保留圓形包覆圖。概要在 `build/data/index.js`（國家與城市的名稱、說明、功能數；城市的 `dependsOn` 和國家的 `actors` 有值時才寫入，讓全景畫得出依賴線），國家內容在 `build/data/chunks/<國家 ID>.js`。透過本地 script 載入支援 `file://`，不需伺服器。查詢各國功能時可能載入其他國家分塊，初次全景只需概要。

## 商業邏輯候選與核對紀錄

`inventory.businessAnalysis` 保存 engine、Git 檔案狀態、無行號的語法候選；`rule-review.json` 保存代理對候選的 documented／not-business／uncertain 判讀。詳細格式、輸出示意與語意界線見 [business-analysis.md](business-analysis.md)。新版 `finish` 保存規則索引；`diff` 的 `affectedRules`／`ruleChanges` 是核對起點，不會自行修改商業文字。規則新增／修改／刪除指文件相對已完成基準的變化，來源檔案變動則保守列出相關規則。依賴傳遞只依已記錄的關係，未知呼叫鏈仍由代理補查。
