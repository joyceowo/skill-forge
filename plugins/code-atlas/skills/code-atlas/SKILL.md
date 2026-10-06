---
name: code-atlas
description: 分析單一 Git 或同一工作區的多個 Git 專案，整合成國家、城市、鄉鎮三層的繁體中文功能文件與地圖 ZIP；或依各來源 Git 變更更新地圖。適用於程式盤點、跨專案業務歸類與文件同步，不用於修改應用程式功能。
---

# Code Atlas

讀程式，將技術結構整理成業務地圖：**Skill → `.atlas/nodes/` 文件 → 地圖 ZIP → 網站匯入 → 三層縮放画面**。
腳本負責多語言盤點、差異、驗證及建置；代理負責從原始程式判斷業務邊界與撰寫說明。
分析與更新預設包含鄉鎮的業務流程、共通規則、鎮民專屬規則、讀寫的資料及程式證據，不需使用者另行要求。

## 開始與路徑

- 使用者提供的是包含多個 Git 的父資料夾時，先讀 [多 Git 整合流程](references/multi-repository.md)。父層作為 `<project-root>`，共用一份 `.atlas`；來源不限定前端／後端，也不限定兩個。以下單 Git 範例的 HEAD／commit／sourceCommit 在 v2 必須替換成完整的 `repositories` 版本集合，不能用其中一個 Git 代表全部來源。
- 以本檔所在目錄為 `<skill-root>`；工具入口是相鄰的 `scripts/atlas.py`，安裝位置可以不同，不依賴目前工作目錄。
- 確定使用者要分析的 Git 專案 `<project-root>`；`<atlas-dir>` 預設是該專案的 `.atlas`，也可指定專案外的目錄。整輪命令固定使用同一組絕對路徑。
- 使用 Python 3.10+ 與 Git；商業邏輯候選盤點使用相鄰 `requirements-analysis.txt` 中固定版本的 ast-grep-py。先確認同一個 Python 能載入套件，缺少時以 `python -m pip install -r "<skill-root>/requirements-analysis.txt"` 安裝；其餘 CLI 與 ZIP 工具使用標準函式庫，不需啟動被分析的應用程式。
- 初次寫文件前讀 [schema.md](references/schema.md) 與 [rules.md](references/rules.md)；撰寫說明時讀 [writing.md](references/writing.md)；分析候選、核對規則及增量更新前讀 [business-analysis.md](references/business-analysis.md)。需要格式範例時看 [會員系統範例](references/examples/member/README.md)，不能把範例的功能或規則當成待分析專案的事實。
- 先檢查既有 `config.json`、`state.json`、`progress.json`、`glossary.json`、`nodes/`、`overrides.json`。有設定就沿用，不重跑 `init` 覆寫；有進度先走「恢復工作」，有已完成基準且要同步程式則走「增量更新」。

命令格式如下；將角括號替換成實際絕對路徑，每次查看退出碼與輸出：

```text
python "<skill-root>/scripts/atlas.py" status --project-root "<project-root>" --atlas-dir "<atlas-dir>"
```

`status` 用來確認文件基準、目前 HEAD 與待辦狀態，不代表已完成分析。尚未建立設定時先檢查 Git，再執行 `init`。

## 工作邊界

- 不為了產生地圖修改原始程式。只依實際程式、設定及可查證的呼叫關係寫文件；無法判斷的用途明記「用途待確認」，不要補出不存在的權限、交易、排程或資料表。
- 內容核對限於使用者要求的分析／更新範圍。單純匯出既有地圖時遵循 export 的基準與驗證要求，不因此強迫重新分析全案。
- 只讀取設定排除範圍以外的檔案；不讀秘密設定、憑證，不把密碼、金鑰、真實個資放進文件。`scan` 只盤點 Git 已追蹤檔案；未追蹤不等於已盤點。
- `overrides.json` 是人工維護，代理只讀。`state.json` 只由 `finish` 寫；不要手填或提前推進 `baseCommit`。`inventory.json` 只由 `scan` 產生，不改輸出來迎合文件。
- 修改既有文件前保留備份；增量編輯保留無關節點的內容、排序及格式，不整批重寫。ID 一旦建立就保留，改名稱只改 `name`；搬移鄉鎮也保留 ID。
- 程式有未提交變更時先停止分析並說明檔案，不自行 stash、reset 或提交來消除檢查。文件輸出目錄內的進度與文件修改不等於程式變動；依工具的檢查結果處理。

## 初次分析

### 1. 建立設定與盤點

確認 Git 有已提交的 HEAD，記下 `git -C "<project-root>" rev-parse HEAD` 的完整結果。執行：

```text
python "<skill-root>/scripts/atlas.py" init --project-root "<project-root>" --atlas-dir "<atlas-dir>"
python "<skill-root>/scripts/atlas.py" scan --project-root "<project-root>" --atlas-dir "<atlas-dir>"
```

`init` 建立 `config.json`；檢查 `parts` 是否符合純前端、純後端或前後端專案，`pageDirs` 是否包含實際頁面。可設定 `projectName` 作為地圖與 ZIP 顯示名稱，特別是隔離副本目錄名稱與專案不同時。偵測有誤時備份後修正設定並重新 `scan`。固定 axios `baseURL` 由掃描器處理；只有執行時才決定的前綴需要設定 `apiPrefix`。

`scan` 產生 `inventory.json`，這一步把程式入口變成後續文件的盤點清單。讀取其 `items`、`businessAnalysis`、`commit` 和警告；確認 `commit` 等於本輪 HEAD。不要手填工具產生的來源快照。依 business-analysis 檢查全部檔案狀態與候選；解析失敗、未支援、排除範圍不能默默略過，也不把入口覆蓋率當成商業邏輯完整率。

### 2. 規劃業務邊界並保存進度

結合 inventory 與原始程式，沿「畫面／呼叫端 → API → 邏輯 → 資料」讀取相關檔案；另找排程、事件處理與獨立規則，因為它們不一定有 API 入口。

- 國家是業務系統，城市是業務能力，鄉鎮是一個操作、背景作業或獨立規則。不要把 Controller／Service／Repository 當成城市。
- 同畫面或流程的姓名、生日、地址等各自規則，放同一鄉鎮的 `residents`；只有觸發、角色或流程不同時才拆鄉鎮。
- 前後端屬同一功能就放同一鄉鎮；`api-call.pairedWith` 是查找線索，仍需讀取程式確認。純前端不虛構後端、純後端不虛構畫面。
- 共用機制、健康檢查等可歸入 `infra`；`uncharted` 是工具產生的未開發地區，不手寫這個國家。

依實際邊界建立 `<atlas-dir>/progress.json`，例如：

```json
{
  "mode": "init",
  "sourceCommit": "本輪完整的 HEAD commit hash",
  "countries": [
    { "id": "member", "status": "pending" },
    { "id": "infra", "status": "pending" }
  ]
}
```

範例 ID 只示範格式，應換成專案實際國家；`sourceCommit` 必須寫真實 hash。保留 `glossary.json` 現有詞彙，有新業務用語才補充。

### 3. 一次完成一個國家

將該國狀態改為 `in-progress` 並保存，再依 schema 建立 `nodes/<國家>/_country.json` 與各城市 JSON。城市檔包含其全部鄉鎮；國家 `cities` 必須對應實際城市檔。

國家說明寫給 SA、城市寫給 SD、鄉鎮寫給 PG。每個鄉鎮依 [writing.md](references/writing.md) 從程式整理 `summary` 的純商業流程（觸發、處理、結果）、`rules` 的共通條件／限制／計算／例外／狀態變更，以及 `residents` 各自的規則與證據；只寫實際存在的內容。每個鄉鎮至少一筆可定位的 `evidence`；鎮民有獨立來源時附在自己的 `evidence`。新規則使用有穩定 `id`、`text`、`status`、`evidence` 的物件，規則間依賴用 `dependsOn`。不儲存或顯示來源行號，API／符號／檔案只放技術來源，不混進商業正文。`screens`、`endpoints` 使用 inventory 的實際鍵值；型態與必要欄位依 schema。沿資料存取程式查到鄉鎮實際讀取或寫入的資料表／實體時，寫入 `reads`／`writes`，名稱與城市 `data` 同一寫法；網站在城市點資料名稱，會以完全相同的名稱列出所有讀寫它的功能與城市。只經抽象介面而查不到實際名稱時不填，記入待確認，不從類別名稱猜。

完成一國時先做 writing 的「內容完成核對」，確認各鄉鎮不只列出 API／檔名，流程、已查得的規則及證據都有寫入；逐一在 `rule-review.json` 核對本國候選並對應規則 ID，保留非商業判讀原因與待確認事項；再檢查檔案可解析、城市清單完整，才標記 `done` 並保存 `progress.json`。經閱讀相關程式確認沒有共通規則可記錄時，`rules` 可空，不為過關補造規則。尚未完成的國家保留 `pending`；不要只在聊天中記進度。跨國依賴在所有相關國家完成後一起驗證。

### 4. 驗證、建立基準、產生畫面

```text
python "<skill-root>/scripts/atlas.py" validate --project-root "<project-root>" --atlas-dir "<atlas-dir>"
```

修正所有 `errors`，逐條處理 `warnings`，讀取 `coverage`、`uncharted` 與 `businessReview`。未處理候選須補查；已判讀但不確定的規則使用 `status: "uncertain"` 與 `reason`，交付明示待確認，不宣稱完整。覆蓋率計算 endpoint、route、page；api-call 用來配對，不是另一份必須覆蓋的入口。
工具的格式、證據定位與入口覆蓋檢查通過，不等於業務內容完整；不能取代標記 `done` 前的內容核對。

未涵蓋的功能應補入合適鄉鎮。確實需要保留待確認項目時，在 `progress.json` 的 `uncoveredReasons` 記下每筆 `{ "kind": "endpoint", "key": "GET /health", "reason": "實際保留原因" }`，並以最新 uncharted 同步這份清單；不要用範例原因、刪除 inventory 項目或宣稱 100%。`validate.valid` 不等於覆蓋率 100%。

確認 HEAD 與 `progress.sourceCommit`、本次 inventory 的 commit 一致，所有已規劃國家都是 `done`，再依序執行：

```text
python "<skill-root>/scripts/atlas.py" finish --project-root "<project-root>" --atlas-dir "<atlas-dir>"
python "<skill-root>/scripts/atlas.py" build --project-root "<project-root>" --atlas-dir "<atlas-dir>"
python "<skill-root>/scripts/atlas.py" export --project-root "<project-root>" --atlas-dir "<atlas-dir>"
```

`finish` 在檢查通過後保存基準；存在 progress 時會檢查同一 HEAD 與全部 done。若回報 inventory 來源快照缺少或不符，重新 scan 並確認文件仍正確，再驗證，不手補快照。

`export` 只接受有正式鄉鎮且完成基準、来源與文件指紋一致的分析。它套用人工 overrides、保留無行號的來源及版本 metadata，產生純 JSON 的 `<projectName>.atlas.zip`，回傳 `archivePath`；可用 `--output` 指定檔案。不要用一般壓縮工具打包原始碼、Markdown 報告或 build 資料夾來取代地圖 ZIP。文件或設定修改後重新驗證與 finish，舊版 state 缺文件指紋也要重新 finish。完整契約见 [package.md](references/package.md)。

需要可匯入的獨立網站時，執行 `python "<skill-root>/scripts/atlas.py" viewer --output "<viewer-dir>"`，再以 `python -m http.server 8767 --bind 127.0.0.1 --directory "<viewer-dir>"` 提供該目錄。開啟 `http://127.0.0.1:8767/index.html`，點「匯入地圖 ZIP」選擇剛產生的檔案，確認三層與程式證據。網站會保存最近 10 份成功匯入的地圖，能從「近期載入」重開或刪除；只移除瀏覽器紀錄，不刪電腦 ZIP。保持同一網站來源與目錄可在刷新後恢復，切換地球儀／圓形也共用資料。不要將整個原始碼目錄設為 HTTP 根目錄。

`build` 把文件與人工修正轉成畫面，輸出會包含 `indexPath`，例如 `{"indexPath":"…/.atlas/build/index.html"}`。依回傳路徑開啟，不直接開 skill 的畫面範本。確認可由國家進城市、鄉鎮，再返回；抽查說明及程式位置。環境若禁止 `file://`，如實回報未完成該協定的驗證，不繞過限制或把其他協定的成功當成直接開檔通過。

## 恢復工作

先讀 `progress.json`、目前 nodes、inventory 與 `status`，再比較 `git rev-parse HEAD` 和 `progress.sourceCommit`。

- **同一 HEAD**：保留已核對完整的 `done` 國家；本輪分析／更新範圍內已發現內容缺口的國家改回 `in-progress`，只補缺項，不能因 HEAD 相同或舊 `done` 略過。核對原有 `in-progress` 國家的實際檔案，從尚缺的城市／鄉鎮接續，不把整國覆寫重做。若只剩 build 失敗，保留驗證合格的文件，修正建置問題後重試 build。
- **HEAD 已改變，或舊進度沒有 sourceCommit**：不能把舊 `done` 當成本輪完成。保留現有文件，重新盤點變更；有可信 state 就走增量更新，沒有就重新檢視初次分析範圍並建立本輪進度。不要僅把 sourceCommit 改成新 HEAD 後繼續 finish。
- **需要中斷**：先保存本輪 sourceCommit、各國狀態與已有文件；交接時列出目前國家、未完成項目、未涵蓋原因和失敗命令。未完成前不執行 finish。同一步連續兩次失敗，停下該步，記錄原因並重訂做法，不反覆重跑。

## 增量更新

1. 讀取既有 state、progress、config、glossary 與人工 overrides。先執行 `status`，再執行：

   ```text
   python "<skill-root>/scripts/atlas.py" diff --project-root "<project-root>" --atlas-dir "<atlas-dir>"
   ```

   `diff` 比較文件基準到 HEAD，回傳 `changes`、`affectedTowns`、`worklist` 與是否建議完整重新檢視。它可能備份並修正改名檔案的 evidence／畫面檔案路徑；先讀取其結果與更新後文件，不再手動重做同一批改名。若有 `manualRenames`，表示改名的新舊路徑重疊，工具為了安全重跑而未自動修改；閱讀實際程式與各節點目前路徑後，逐筆核對再更新，不能盲目重套改名表。節點 ID 與 overrides 保持不變。

2. 若有未提交程式變更，停止並報告。基準 commit 不存在時，請使用者指定可信的基準，再以 `diff --since <commit>` 執行；或依使用者選擇完整重新檢視，不猜一個 commit，也不手改 state。變更多於 30% 時說明工具建議與影響，保留既有文件，不能因此自動全量覆寫。

3. 即使 HEAD 沒變，也先依 writing 的內容完成核對辨識本輪分析／更新範圍內的既有文件缺口；`diff` 為空不代表流程與規則已完整。確認程式無變更、內容已完整且沒有未完成文件工作時，才回報已是最新，不改 nodes。否則建立 `mode: "update"` 的 progress，記錄此次 HEAD；只把需處理的國家標為 pending／in-progress，補已查證缺項並保留其餘內容、ID 與 overrides。

4. 以 `worklist`、`affectedTowns`、`affectedRules` 和 `ruleChanges` 為起點，讀改動與既有 evidence，更新受影響鄉鎮；保留規則 ID，核對來源／規則依賴；有可查證的共用規則或呼叫鏈影響時，才擴大到相關節點並記錄理由。新增入口可能尚無鄉鎮，依業務先歸現有城市。程式刪除時確認是否還有其他證據；整個功能消失才刪鄉鎮，空城市也同步移除國家清單與相關依賴。刪改前保留備份。

5. 同國完成即保存 checkpoint。鄉鎮變更後只在確有影響時更新城市摘要，再視需要更新國家摘要；不改未受影響節點的文字或 ID。人工 overrides 若指向已不存在節點，回報精確衝突供人工處理，不偷偷移除或改寫 overrides。

6. 重新 `scan`，對照新 inventory 補查新增、刪除、改名後的入口與商業規則候選，重新核對 rule-review，不只比對舊規則以免漏掉新增條件，再依初次分析的收尾步驟 `validate → finish → build`。對漏列但經新盤點確認的功能，補入工作清單後才改文件；保存每筆仍未涵蓋的原因。HEAD 在中途改變時，改走恢復工作檢查，不在混合版本上 finish。

## 小型試跑與交付

開發或驗證這個 skill 時，先將 `tests/fixtures/` 的小專案複製到隔離目錄，在副本 `git init`、追蹤並提交來源，再用專案外的 atlas-dir 跑完整流程。不要直接修改 fixtures 或拿標準答案當分析結果；先用 member-system，再試純前端 vue-app、純後端 fastapi-app。大型真實專案（例如 enterprise-ai2）留待小型流程驗證後，且須在使用者授權範圍內另行安排。

交付時簡述歸類方式、國家／城市／鄉鎮數、實際驗證結果、入口覆蓋率、候選核對數、未解析與待確認範圍，附 `archivePath`、`indexPath`／實際網站網址，以及「匯入地圖 ZIP → 選檔 → 三層縮放 → 近期載入／刪除」步驟。明確區分「檔案已產生」「工具驗證通過」「畫面實際操作通過」；未跑的環境或互動不算通過。
