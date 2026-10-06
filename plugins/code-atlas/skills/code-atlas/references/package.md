# Code Atlas 地圖 ZIP v1／v2 契約

本格式供 `export` 匯出與 viewer 匯入共用。分析 Markdown ZIP 不符合本契約。

## v2 多 Git 的差異

v1 以下原有格式繼續支援。多 Git 使用 version=2，沿用相同 ZIP 容器、檔名、限制及節點結構：

- manifest/index 都以 `repositories:[{id,name,commit}]` 代替 sourceCommit，完整來源清單與版本必须一致；commit 仍是各來源真實的 40 或 64 位小寫 hex SHA，ID 唯一。
- index.parts 增加 repoId；name 在同 repo 內唯一。index 可含 coverageByRepository，必須列出全部來源，各 total/covered 總和與 aggregate coverage 相同。
- 鄉鎮 endpoints/screens 改為 `{repoId,part,key}` 陣列；evidence／居民 evidence 加 repoId，file 相對所屬 Git。來源引用必须存在，入口的 part 必須在該來源內。
- country/city/town 的業務結構、ID、居民與依賴不按 Git 拆分。uncharted 的入口也保留來源。
- export 要求每個來源乾淨且 HEAD／inventory／state 基準與快照一致、進度完整；回傳 repositories 陣列。一個來源不通過就不發布混合版本。
- viewer 保留 v1 近期資料，同一 v2 ZIP 算一筆紀錄，顯示每個來源的版本；搜尋包含來源與證據。純資料包不含原始碼、來源絕對路徑或 Git 認證。

## v1 與共用封包規則

- ZIP_STORED（method 0）、非加密、非 ZIP64；最大 32 MiB、最多 512 個檔案；不含目錄項目、重複項目、其他檔案或可執行程式。
- UTF-8 JSON（無 BOM）；檔名只允許 manifest.json、index.json、countries/<country-id>.json；country ID 為 `[a-z0-9]+(?:-[a-z0-9]+)*`，包括工具產生的 uncharted。
- manifest.json：`{"format":"code-atlas","version":1,"projectName":"enterprise-ai2","sourceCommit":"40或64位小寫hex Git commit","generatedAt":"ISO時間","files":["index.json","countries/data.json"]}`。files 不包含 manifest 自己，須與其餘 ZIP entry 完全一致。
- index.json 沿用 build 的概要資料：version=1、projectName、generatedAt、sourceCommit、coverage（total/covered/percent）、warnings、parts、hiddenCount、countries。名稱／時間／commit 與 manifest 一致；country.chunk 指向 countries/<id>.json。
- countries/<id>.json 沿用 build 的完整 country 物件：level=country，cities 內 level=city，towns 內 level=town，包含原有 summary/rules/residents/screens/endpoints/dependsOn/evidence 及可選的 reads/writes（資料名稱文字陣列），新規則包含穩定 ID、確認狀態及逐條來源（無 line）。index 概要的 ID、名稱、city 清單及 townCount 要與完整資料一致。
- 節點 ID 在整包唯一；country 一段、city 兩段，town 三段（搬移仍保留 ID）；所有 dependsOn 指向現存節點；允許工具產生的 uncovered 鄉鎮。文字以 textContent 呈現，資料包不能執行 JS 或提供 script URL。
- 保留 evidence 的相對檔案路徑、symbol、role（多 Git 加 repoId，不含 line）；不包含原始碼、config、projectRoot 或環境設定。來源核對在 export 時完成；匯入只驗證封包與資料結構，不宣稱讀過來源。
- export 要求正式 nodes 非空、文件有效、HEAD 乾淨、inventory 最新、state.baseCommit=HEAD，progress 若存在必須同版本且全 done；未覆蓋項目保留真實數據與未開發地區，不假造 100%。
- 成功輸出含 archivePath、projectName、sourceCommit、countries/cities/towns、coverage、backupPath。預設檔名 <projectName>.atlas.zip；明確 --output 可指定路徑。失敗不破壞既有 ZIP。

viewer 在瀏覽器本機保存最近 10 筆成功匯入的包（含原檔名、專案、來源版本、最近載入時間及資料）。同一包重匯移到最前；第 11 筆移除最舊紀錄。使用者可重新開啟或刪除單筆，刪除只影響瀏覽器紀錄，不刪磁碟 ZIP；刪除目前項目回到內建圖或空白匯入頁。依 viewer 所在目錄隔離，globe/classic 共用，刷新保留；保存失敗明確報錯且保留目前圖，不宣稱成功。

實作所有權：Python worker 可實作 exporter／viewer 命令並更新測試；viewer worker 實作 parser、啟動、近期管理。共用資產固定為 viewer/atlas-package.js、viewer/atlas-library.js、viewer/atlas-library.css，Python build/viewer 打包三檔。根代理維護本契約與其他文件，變更契約先協調。

規則物件為現有 v1／v2 的資料延伸，需新版查看器；新版查看器也接受舊文字規則與舊 ZIP 行號，匯入後移除來源 line，不再顯示或保存於近期資料。原 ZIP 檔案不被改寫。候選清單、rule-review 與原始碼不放入 ZIP。
