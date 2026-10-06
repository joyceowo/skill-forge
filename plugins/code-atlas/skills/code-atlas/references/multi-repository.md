# 同一工作區的多 Git 分析

將父資料夾當作工作區，Skill 安裝一次、共用 nodes，輸出一份可匯入的地圖 ZIP。每個來源保留自己的 Git 歷史及分析基準；repo 數量不限定兩個。國家／城市依業務劃分，同一流程可引用多個 repo 的證據，不按 repo 強制拆國家。

```text
my-system/
├─ web/                 # Git
├─ member-api/          # Git
├─ booking-api/         # Git
├─ shared-library/      # Git，可由代理補充沒有入口掃描器的程式證據
├─ .agents/skills/code-atlas/
└─ .atlas/              # 共用設定、文件、進度、基準與 ZIP
```

## 安裝、辨識與確認來源

在工具 repo 執行 `python install.py 'C:/work/my-system' --target codex`。於 Codex 開啟父資料夾，要求「使用 code-atlas 分析這裡的多個 Git，整合成一份地圖 ZIP」。安裝只複製 Skill，不會自行分析。

以安裝後的工具執行，命令中的 `<workspace>` 換成父資料夾絕對路徑：

```text
python "<workspace>/.agents/skills/code-atlas/scripts/atlas.py" init --project-root "<workspace>"
```

父層不是 Git 根目錄時，init 探查直接子目錄的 Git 根目錄；父層本身是 Git 時保留單 Git 預設。較深的來源、只納入部分專案，或父層本身也是 Git 時，明確指定每個來源：

```text
python "<skill-root>/scripts/atlas.py" init --project-root "<workspace>" --repository web=web --repository members=services/member-api --repository bookings=services/booking-api
```

`init` 不覆寫既有 config。首次確認 `repositories` 包含預期來源、各 `parts` 的 framework/path/pageDirs 正確，再 scan。不要因新資料夾出現就自動加入既有設定。不自動 clone、pull 或初始化 submodule；來源必須存在、位於工作區內、互不巢狀重疊。ID 要穩定，搬資料夾只改 path。

若某來源沒有支援的 manifest，工具會警告沒有入口掃描器；它仍是版本追蹤來源。代理可在排除規則外讀取已追蹤檔並撰寫 evidence，不能把「無掃描項目」說成「沒有業務功能」或「所有程式均已覆蓋」。

## 來源與引用格式

```json
{
  "version": 2,
  "projectRoot": "..",
  "projectName": "my-system",
  "language": "zh-Hant",
  "repositories": [
    {"id":"web","path":"web"},
    {"id":"members","path":"member-api"},
    {"id":"bookings","path":"booking-api"}
  ],
  "parts": [
    {"repoId":"web","name":"web","path":".","kind":"frontend","framework":"react","pageDirs":["src/pages"],"apiTargets":[{"repoId":"members","part":"api"},{"repoId":"bookings","part":"api"}]},
    {"repoId":"members","name":"api","path":".","kind":"backend","framework":"aspnetcore"},
    {"repoId":"bookings","name":"api","path":".","kind":"backend","framework":"fastapi"}
  ]
}
```

repository.path 相對父工作區；part.path、pageDirs、evidence.file 相對所屬 Git。part.name 在同 repo 內唯一，不同 repo 可同叫 api。前端 apiTargets 可限制候選後端；相同 method/path 有多個候選時要檢視歧義，不能任挑一個。

v2 鄉鎮引用必須保留來源及 part，實際 key 從 inventory 取得：

```json
{
  "screens": [{"repoId":"web","part":"web","key":"/member/profile"}],
  "endpoints": [{"repoId":"members","part":"api","key":"GET /api/member/profile"}],
  "evidence": [
    {"repoId":"web","file":"src/pages/Profile.tsx","symbol":"Profile","role":"screen"},
    {"repoId":"members","file":"Member/ProfileController.cs","symbol":"ProfileController","role":"api"}
  ]
}
```

這只是格式示意，不可直接當成其他專案的已驗證證據。居民 evidence 也必須有 repoId。相同檔名不代表同一份檔案；兩個來源的同名 API 不能互相抵消覆蓋率。API 配對只是查找線索，跨來源的業務關聯仍須讀實際程式確認。

## 分析、進度與更新

1. 對每個來源檢查乾淨且有已提交 HEAD，再執行 scan。讀 `inventory.repositories` 的所有 commit/sourceSnapshot；不要自行計算或手填工具快照。
2. 依主 Skill 建立三層文件並在每國 done 前核對業務內容；全部來源版本未變時，也須處理本輪分析／更新範圍內已發現的內容缺項。v2 progress 使用 `{version:2,mode:"init",repositories:<複製本輪 inventory.repositories>,countries:[...]}`；countries 的狀態仍為 pending/in-progress/done。未涵蓋原因也記 repoId 與 part。
3. 完成後 `validate → finish → export`，需要內建地圖網站時再 build。finish 要求全部來源、文件、進度一致才整批寫入 state；ZIP 包含每個來源的版本，不製造合併 SHA。
4. 更新時先 status，再 diff。diff 各自比較 `state.repositories[repoId].baseCommit`，合併工作清單；變更與改名包含 repoId。只改一個來源仍要檢視受影響的跨來源鄉鎮與依賴。
5. 比較基準需要明確覆寫時，使用可重複的 `--since-repo members=<完整SHA>`；未指定的來源繼續使用有效 state。`--since` 保留單 Git 用法，不能在多 Git 用一個 SHA 代表全部來源。任一來源缺基準或參數錯誤，先解決再進行文件改名。
6. 中斷恢復時比較完整來源集合與快照。任何來源換版／設定改變，保留並備份舊進度與文件，為新一輪將國家列為 pending；核對後未受影響者可標回 done，不必重寫。不能只替換版本欄位沿用舊完成狀態。
7. 重新 scan、核對文件、更新 progress，然後 validate、finish、export，產生新的整合 ZIP。30% 變更提示逐 repo 計算；跨 repo 搬檔視為刪除與新增，由代理確認。工具不自動修改原始碼或提交來源 Git。

新增／移除 repo 或改變 ID 映射前先備份，核對引用、依賴與人工 overrides。舊單 Git 文件轉 v2 時，明確映射舊來源、將 evidence／入口改成有來源的引用；先把舊 v1 progress 保存到備份目錄並移出 progress.json，再 scan，以新 inventory.repositories 建立全 pending 的 v2 progress，重新核對文件並分析新增來源。不要把舊 baseCommit 複製成新 repo 的基準，也不手改 state 繞過 finish。沒有可用基準時做完整分析；finish 驗證通過後才備份並取代舊 state。

## 開網站與匯入

```text
python "<skill-root>/scripts/atlas.py" export --project-root "<workspace>" --atlas-dir "<workspace>/.atlas"
python "<skill-root>/scripts/atlas.py" viewer --output "<viewer-directory>"
python -m http.server 8767 --bind 127.0.0.1 --directory "<viewer-directory>"
```

export 輸出示意：`{"archivePath":"…/.atlas/my-system.atlas.zip","repositories":[{"id":"web","name":"web","commit":"…"},{"id":"members","name":"members","commit":"…"},{"id":"bookings","name":"bookings","commit":"…"}],"coverage":{…}}`。以實際回傳路徑為準。

開啟 `http://127.0.0.1:8767/index.html`，點「匯入地圖 ZIP」選取該檔案。一份 ZIP 是一筆近期紀錄，地圖與證據顯示所屬來源；可三層縮放、搜尋、重開與刪除紀錄。舊 v1 ZIP 仍可讀。刪除紀錄不刪電腦上的 ZIP；勿將來源工作區當 HTTP 根目錄。

## 商業規則與候選

每條新規則使用穩定 id／text／status／evidence，來源需 repoId；規則 ID 跨來源仍全圖唯一，dependsOn 可引用另一來源的規則 ID。scan 的 businessAnalysis 逐來源列出已解析、未支援、排除與錯誤；rule-review 判讀與來源限定候選 ID 對應。步驟與完成核對沿用 [business-analysis.md](business-analysis.md)，不要只分析有入口的來源。來源不記行號；各 Git commit 集中在 repositories metadata。
