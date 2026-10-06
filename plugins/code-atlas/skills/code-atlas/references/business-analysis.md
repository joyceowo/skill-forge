# 商業邏輯盤點與更新

這一層服務「Skill → 文件 → 地圖 ZIP → 畫面縮放」：套件列出程式結構與待讀線索，代理讀取原始碼後才撰寫商業規則。語法候選不是商業規則，入口覆蓋率也不是商業邏輯完整率。

## 多語言盤點

使用執行 CLI 的同一個 Python 安裝 `<skill-root>/requirements-analysis.txt`，固定 ast-grep-py 版本；不要執行待分析專案的安裝腳本或應用程式。已有相依套件可離線分析；若環境限制安裝，保留文件、回報未解析範圍，不以文字比對假裝已完成語法分析。

`scan` 在原有入口 inventory 之外產生 `businessAnalysis`：

- `engine`：解析工具、版本與是否可用。
- `files`：各 Git 追蹤檔案的 `parsed`、`excluded`、`unsupported`、`error` 或 `unavailable` 狀態；排除檔案不讀內容。
- `candidates`：候選 `id`、檔案、語言、符號（可用時）、種類、指紋與語法錨點，多 Git 另有 `repoId`。不記來源行號或原始碼本文。

輸出示意（省略其他 inventory 欄位，ID／指紋必須使用實際 scan 結果）：

```json
{
  "businessAnalysis": {
    "engine": {"name": "ast-grep-py", "version": "0.45.3", "status": "available"},
    "files": [{"file": "src/Profile.tsx", "language": "tsx", "status": "parsed"}],
    "candidates": [{"id": "工具產生的候選識別碼", "file": "src/Profile.tsx", "language": "tsx", "kind": "condition", "fingerprint": "工具產生的指紋"}]
  }
}
```

語法樹可定位條件、計算、狀態變動及例外等線索；支援深度由實際 adapter 決定。框架入口、React hooks／表單函式、Python decorator／驗證宣告、自訂 API 包裝器、設定與 SQL 仍需沿呼叫關係讀取。跨前後端連結須核對實際路徑與來源，不能只靠同名函式配對。未支援的語言可人工建立可驗證的檔案證據，但必須在交付保留分析限制。

候選的 symbol 是語法作用域，不保證能直接作為 evidence。讀取來源後核對實際可定位的宣告；巢狀匿名／箭頭函式無法驗證時，引用可驗證的外層函式或元件，保留檔案來源，不編造方法名稱或行號。

## 核對候選

初次分析固定建立 `<atlas-dir>/rule-review.json`；更新時核對本次 scan 的候選，移除已不存在的舊候選紀錄、補查新候選，保留仍有效的判讀。

```json
{
  "version": 1,
  "reviews": [
    {"candidateId": "實際候選ID", "status": "documented", "ruleIds": ["member.profile.name.length"]},
    {"candidateId": "另一實際候選ID", "status": "not-business", "reason": "已讀此條件，只判斷元件是否掛載，未改變功能的商業結果。"},
    {"candidateId": "尚待核對的實際候選ID", "status": "uncertain", "reason": "依賴外部服務，現有來源未包含實際限制。"}
  ]
}
```

- `documented` 必須指向已寫入 nodes 的規則 ID；同一條規則可彙整多個候選，一個候選也可支援多條規則。
- `not-business` 與 `uncertain` 必須寫真實原因；不能批次把全部候選標為非商業或待確認來通過檢查。
- 尚未讀取的候選不標為完成。已查仍不確定的內容明確留下原因；已處理數包含這類判讀，不表示內容已確認。
- 工具檢查引用、重複與未處理候選；代理另外核對「條件、限制、計算、例外、狀態變更」是否反映程式。已有 review 時未處理候選不能 finish。舊資料無 review 的相容警告不代表新分析可略過這一步。
- 解析不可用或失敗時先解決／回報實際範圍，不聲稱商業邏輯全數涵蓋。任何完整性結論須一起附未解析檔案與待確認數。

## 穩定規則與來源

新分析的 `rules` 使用物件，舊字串仍可讀。規則 ID 是人工選定的穩定商業識別碼，不使用行號、陣列序號或內容 hash；修改文字、移動檔案、調整門檻時保留 ID。只有獨立新規則建立新 ID。

```json
{
  "id": "member.profile.name.length",
  "text": "姓名長度需為 2–50 字。",
  "status": "confirmed",
  "evidence": [{"file": "api/Member/Profile/MemberProfileService.cs", "symbol": "MemberProfileService.UpdateNameAsync", "role": "logic"}],
  "dependsOn": []
}
```

`uncertain` 規則加 `reason` 說明已查範圍與未確認部分，不把推測寫成確定事實。證據可多筆，設定與資料存取也是來源；多 Git 的每筆來源加 `repoId`。全圖規則 ID 不重複，`dependsOn` 指其他規則 ID；鄉鎮／城市本來的 dependsOn 仍指地圖節點，兩者分開。

來源只保存專案、檔案、函式／方法與角色，Git 版本統一由分析基準／ZIP 來源 metadata 保存；不儲存、不顯示來源行號。商業文字也不要手寫「第 N 行」。

## 增量核對

`finish` 保存規則索引與來源版本；`diff` 額外回報 `affectedRules`、`ruleChanges`、`ruleIndexAvailable`。來源檔案變更會保守列出其規則，依賴規則跟著列入；不是自動判斷商業意義是否改變。規則的新增／修改／刪除差異是文件相對已完成基準的變化。

先讀工作清單與實際 Git 變動，再重新 scan 受本輪版本影響的來源，核對新的候選與未引用檔案，不能只讀既有規則 evidence 而漏掉新增分支。來源改名時核對工具已改寫的引用，保留原 rule ID；方法改名、拆分或刪除需讀碼處理失效證據。變更共用設定／方法時，依來源與規則依賴重新檢查呼叫端；舊 state 無規則索引則先按檔案／鄉鎮清單核對並在 finish 建立新基準。

單純 export 不觸發重新分析；一般分析／更新請使用上述預設流程，不要求使用者另貼核對清單。
