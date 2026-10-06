# Code Atlas

將單一 Git 專案或同一工作區的多個 Git 專案，整理成繁體中文商業邏輯文件與可匯入的地圖 ZIP。Codex 與 Claude Code 共用同一份 Skill、腳本、參考文件與 viewer。

## 地圖與商業邏輯

地圖採用 **國家 > 城市 > 鄉鎮** 三層縮放：國家是業務系統，城市是業務能力，鄉鎮是一個操作、背景作業或獨立規則。同一畫面或流程內各欄位的規則放在鄉鎮的鎮民（`residents`）；前後端屬於同一功能時，合併到同一鄉鎮。

分析與更新預設包含商業流程、共通規則、鎮民專屬規則、讀寫資料及程式證據，不需在每次提示中重複要求。代理讀取實際程式並判斷業務邊界；腳本協助盤點、比較 Git 差異、驗證、建置與匯出。語法盤點與入口覆蓋檢查不等於商業邏輯完整，未支援、解析失敗或待確認事項需要在交付時說明。

多 Git 模式以父資料夾為工作區，共用一份 `.atlas` 與 ZIP，每個來源保留自己的 Git 版本與證據。來源數量與技術框架不限於前端／後端兩個專案；地圖依業務劃分，不按 Git 儲存庫強制拆國家。已有基準時可依各來源 Git 變更更新受影響文件，保留節點 ID 與人工修正。

## 安裝與呼叫

完整市集設定見[市集安裝說明](../../README.md#從-github-安裝)。以下 GitHub 指令適用於 Code Atlas 已發布至市集遠端分支之後；本機封裝建立完成不代表已提交或推送到 GitHub。平台格式依據 [Codex Plugins](https://developers.openai.com/plugins/build/plugins) 與 [Claude Code Plugin Marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)。

### Codex

```powershell
codex plugin marketplace add https://github.com/joyceowo/skill-forge.git --ref main
codex plugin add code-atlas@skill-forge
```

安裝後開啟目標專案或多 Git 的父工作區，在新聊天的技能選單選取 **Code Atlas**，或輸入：

```text
請使用 $code-atlas 分析目前專案，整理國家、城市、鄉鎮與鎮民，
完成商業邏輯文件並交付可匯入的地圖 ZIP 與 viewer。
```

### Claude Code

```powershell
claude plugin marketplace add https://github.com/joyceowo/skill-forge.git
claude plugin install code-atlas@skill-forge
```

在目標專案的 Claude Code 工作階段呼叫：

```text
/code-atlas:code-atlas 分析目前專案，完成商業邏輯文件並交付可匯入的地圖 ZIP 與 viewer。
```

兩個平台都可以要求多 Git 整合或更新，例如：

```text
使用 code-atlas 分析這個父資料夾中的 web、member-api 與 booking-api Git，
依業務整合成一份地圖 ZIP；每個來源保留各自版本與程式證據。
```

```text
使用 code-atlas 依各來源 Git 變更更新目前 .atlas，
補齊受影響的商業邏輯後重新驗證並匯出 ZIP。
```

尚未發布的本機版本，請依[Code Atlas 本機驗證與使用](../../README.md#code-atlas-安裝與使用)檢查；Claude Code 可用 `claude --plugin-dir ./plugins/code-atlas` 載入這份本機外掛。

## 執行需求與路徑

- Python 3.10+ 與 Git，且代理可以讀取目標專案與其 Git 歷史、寫入指定的文件輸出目錄。
- 分析商業邏輯候選需安裝 [requirements-analysis.txt](skills/code-atlas/requirements-analysis.txt) 的固定依賴：`ast-grep-py==0.45.3`。其餘 CLI、ZIP 匯出與 viewer 建立使用 Python 標準函式庫；viewer 與 ZIP 閱讀本身不需要 Python 套件。
- 來源 Git 必須已有提交。分析／更新前先檢查未提交程式變更；Skill 不會為消除檢查而自行 stash、reset 或提交來源。
- `<skill-root>` 指已安裝 Skill 中包含 `SKILL.md` 的資料夾；`<project-root>` 是目標 Git 根目錄或多 Git 的父工作區；`<atlas-dir>` 預設為目標的 `.atlas`。將下列角括號替換成實際絕對路徑。

使用執行工具的同一個 Python 安裝依賴：

```text
python -m pip install -r "<skill-root>/requirements-analysis.txt"
python "<skill-root>/scripts/atlas.py" status --project-root "<project-root>" --atlas-dir "<atlas-dir>"
```

本外掛透過 marketplace 安裝，封裝中沒有 `install.py` 或 `tests/fixtures/`。保留的多 Git 參考文件提到的 `install.py` 是原 Code Atlas 開發 checkout 的安裝方式；上述 marketplace 安裝不需要它。小型開發驗證資料取自原開發 checkout 的 `tests/fixtures/`，應複製到隔離目錄再試跑。

## 完整輸出：Skill → 文件 → ZIP → viewer

1. 代理依 [SKILL.md](skills/code-atlas/SKILL.md) 執行 `init` 與 `scan`，沿實際程式建立 `.atlas/nodes/` 的三層文件、規則、鎮民與證據，並保存進度及候選核對結果。既有設定與完成基準需沿用，不重跑初始化覆寫。
2. 文件完成後先執行 `validate`，處理錯誤、警告、未涵蓋入口與待確認候選；通過基準檢查後依序 `finish`、`build`、`export`。命令會回傳實際輸出路徑，不能用一般 Markdown 分析壓縮檔取代地圖 ZIP。

```text
python "<skill-root>/scripts/atlas.py" validate --project-root "<project-root>" --atlas-dir "<atlas-dir>"
python "<skill-root>/scripts/atlas.py" finish --project-root "<project-root>" --atlas-dir "<atlas-dir>"
python "<skill-root>/scripts/atlas.py" build --project-root "<project-root>" --atlas-dir "<atlas-dir>"
python "<skill-root>/scripts/atlas.py" export --project-root "<project-root>" --atlas-dir "<atlas-dir>"
```

輸出示意：

```json
{"indexPath":"<atlas-dir>/build/index.html"}
{"archivePath":"<atlas-dir>/<projectName>.atlas.zip","projectName":"<projectName>"}
```

以上僅示意部分欄位，以工具回傳的 `indexPath`、`archivePath` 為準。ZIP 包含地圖 JSON 與來源版本 metadata；匯出要求正式鄉鎮、完成基準及一致的來源／文件指紋。

3. 建立可獨立匯入 ZIP 的 viewer，再以專用輸出目錄提供網站。`<viewer-dir>` 使用獨立資料夾，不要將原始碼工作區當 HTTP 根目錄。

```text
python "<skill-root>/scripts/atlas.py" viewer --output "<viewer-dir>"
python -m http.server 8767 --bind 127.0.0.1 --directory "<viewer-dir>"
```

viewer 命令輸出示意：`{"indexPath":"<viewer-dir>/index.html"}`。開啟 `http://127.0.0.1:8767/index.html`，點「匯入地圖 ZIP」，選取實際 `archivePath`，操作國家 > 城市 > 鄉鎮並檢查商業邏輯與程式證據。viewer 保存最近 10 份成功匯入的地圖，可從「近期載入」重開或刪除；刪除瀏覽器紀錄不會刪除電腦 ZIP。保持相同網站來源與目錄，刷新後可恢復紀錄，地球儀與圓形檢視共用資料。

交付需分別說明檔案產生、工具驗證與實際畫面操作結果，附上國家／城市／鄉鎮數、入口覆蓋率、候選核對與待確認範圍。多 Git 的設定、進度與版本格式見[多 Git 流程](skills/code-atlas/references/multi-repository.md)。

## 套件與來源

- [技能指引](skills/code-atlas/SKILL.md)
- [文件 schema](skills/code-atlas/references/schema.md)、[商業邏輯分析](skills/code-atlas/references/business-analysis.md)、[撰寫規則](skills/code-atlas/references/writing.md)
- [地圖 ZIP 契約](skills/code-atlas/references/package.md)
- [工具入口](skills/code-atlas/scripts/atlas.py)與[viewer 範本](skills/code-atlas/viewer/index.html)

此 `1.0.0` 外掛完整複製 Code Atlas 已提交版本 `d8939d5257be092369579025a72a3911c19e88e3` 中 `skill/code-atlas/` 的 51 個檔案，來源內容未修改；另加兩個 host manifest、本頁與 Codex UI metadata。`.codex-plugin/plugin.json` 與 `.claude-plugin/plugin.json` 共用名稱、版本、描述與技能來源，`agents/openai.yaml` 提供 Codex 顯示資訊，Claude Code 從共用 `skills/` 載入。

這是完整副本，不會自動同步 Code Atlas 開發 checkout 或個人技能目錄。後續來源更新需另行核對、封裝與驗證，再同步更新兩份外掛版本。
