# Code Atlas marketplace 計畫

使用者已於 2026-10-06 確認開始。目標：將 Code Atlas 完整 Skill 封裝至 Skill Forge，供 Codex 與 Claude Code 安裝。

來源固定為 code-atlas commit `d8939d5257be092369579025a72a3911c19e88e3`，不納入來源工作區未提交的 viewer 修改。

## 步驟與驗證

- [x] Explorer 核對來源與封裝邊界：完整 `skill/code-atlas/` 共 51 個檔案；執行時資源、D3 與授權均內附。主代理再以封裝後 SHA-256、相對引用與 CLI 驗證。
- [x] Worker 建立 `plugins/code-atlas/`：共用 Skill、Codex／Claude manifests、Codex Skill 顯示資訊、外掛 README；不改原始分析行為。證明：來源逐檔一致、Skill validator、兩個 host 名稱／版本／來源一致。
- [x] 主代理加入兩邊 marketplace 與根 README 安裝入口。證明：現有 `validate-marketplace.mjs` 通過、CLI help 核對指令、Markdown 相對連結存在。
- [x] 主代理在隔離目錄驗證：以封裝的 CLI 跑既有 fixture 與完整 `init → scan → validate → finish → build → export`，驗證 viewer 生成及離線資源。所有來源／測試均使用固定 commit，不讀來源未提交程式。
- [x] Reviewer 只讀審查封裝、文件及提交範圍；主代理自行核對主要結論。證明：缺漏修正後，實際提交樹重跑封裝與 CLI 檢查。
- [x] 本次提交範圍已隔離為新增外掛與市集／文件新增部分，保留兩個 repo 的其他工作；全部驗證通過後自動建立 Git commit。證明：59 個 staged 檔案、基線還原比對、Reviewer 與實際提交樹核對。

## 既有變更與提交界線

skill-forge 原先 README、sync-business-logic-docs manifests／README 有修改，Claude marketplace、sync 外掛 Claude manifest 與 scripts 為未追蹤檔案。修改前已在隔離暫存目錄備份受影響的三個檔案。

根 README 以 HEAD 加本次新增內容暫存，原先 README 的改動留在工作區。新納入版控的 Claude marketplace 只提交 Code Atlas 項目；原先未提交的 sync-business-logic-docs 項目仍留在工作區，不將相關 Claude manifest 或 validator 一起提交。原 repo `PLAN.md` 不修改。

## 驗證紀錄與限制

- 現有市集一致性檢查在新增前通過（sync-business-logic-docs 工作區版本 1.1.0）。
- 此環境目前未找到 Claude Code CLI；不能宣稱完成 Claude 實際載入驗收。
- 不安裝到使用者真實 Codex 設定／快取；必要時用隔離的設定與快取核對 host 載入。

## 驗證環境重訂

建立隔離 venv 的 ensurepip 失敗；改用 pip --target 的第二次準備也失敗，查明此環境預設 PIP_NO_INDEX，不反覆重試套件安裝。改用來源專案既有 `work/business-analysis-deps` 與 `work/skill-validation-deps`，只讀取既有驗證套件，以 child process 的 PYTHONPATH 引用，不新增 repo 依賴或修改全域 Python。

## Worker metadata 重訂

首輪 orchestration JavaScript 的 Markdown 反引號未跳脫，shell 未執行；第二輪封裝建檔成功，但 Skill metadata generator 用 cp950 讀 UTF-8 SKILL 失敗。Worker 停止重跑整段封裝，改為只補 metadata，以 `python -X utf8` 與明確 `--name code-atlas` 執行 generator，保留已複製的 51 個來源檔案 bytes；主代理另核對結果。

## QA 腳本與 sandbox 調整

完整 fixture CLI 的 init、scan、validate、finish、build、export、viewer 全部通過；資源 QA 首輪把 inline SVG favicon 的 xmlns URL 誤判為遠端資源，修正 QA 為區分 data URI。第二輪讀取 elevated 流程產物被 sandbox 拒絕，停止以 default 重試，改以相同隔離範圍的 elevated 只讀檢查，不改封裝程式。Node --test 首輪遭 sandbox 的 child-process spawn EPERM；改用 elevated 原命令核對，保留所有錯誤輸出，不將後續成功命令的退出碼當作首輪通過。


## 完成驗證

- Skill Creator quick_validate：`Skill is valid!`；51 個來源檔案逐檔 SHA-256／bytes 與固定來源 commit 相同，Skill 共 52 檔（加 metadata），外掛共 55 檔。
- 兩份 manifest 共用欄位、UI metadata、相對連結、17 個 Python 語法與 6 個 JSON 格式全部通過；既有工作區市集一致性檢查通過。
- Codex 真實 CLI 在隔離的 child-process home 登錄市集、列出並安裝 `code-atlas@skill-forge` 1.0.0 成功；安裝快取 51 個來源檔案完整保留。未變更使用者真實 Codex 設定／快取。
- 使用封裝後 CLI 在隔離 fixture 完成 init → scan → validate → finish → build → export → viewer，實際 ZIP reader 能讀取 Python ZIP；兩種 viewer 產物的資源均本機或 inline，fixture Git 保持乾淨。
- 已封裝 Skill 的隔離回歸測試：Python 167/167（305.595 秒）、Node ZIP／匯入與儲存測試 40/40、viewer 回歸 24/24，均無 skip 或 fail。
- fixture 沿用既有範例文件，入口覆蓋 16/17（94.12%）；GET /health 未歸類，並保留 5 個既有範圍警告（2 unsupported 檔、66 未核對候選、缺 rule-review、20 legacy 文字規則、1 uncharted 入口）。這輪驗證封裝及工具行為，不宣稱對 fixture 重新完成完整商業分析。
- Reviewer 獨立核對來源、引用、manifests、市集與 staged diff，無阻擋問題；主代理對實際 staged archive 再查完整性、CLI、文件 anchors 與未提交內容還原比對，全部通過。
- git diff --cached --check 除原樣附帶 vendor 外通過；完整檢查回報 vendor 原版的 5 處空白格式，來源 bytes 一致，保留上游程式不額外重排。

## 文件與交付界線

根 README 新增 Code Atlas 表格項目、雙平台安裝／更新與本機載入方式；plugin README 記錄完整用法、需求與固定來源版本。此任務只封裝既有 Skill，未改分析、API、schema 或畫面行為，不需新增 DESIGN／API／schema 文件。

Claude Code CLI 未安裝，未執行官方 validate 或實際載入；viewer 未進行新一輪人工瀏覽器操作，不將資源與回歸測試冒稱畫面實測。遠端 GitHub 尚未推送，GitHub 安裝需等版本發布；可先依根 README 使用本機市集。

既有 README 改動與 Claude sync entry 仍留工作區；sync 1.1.0 修改、sync Claude manifest 和 validator 未暫存。原 code-atlas 工作區未編輯；驗證始終固定使用 d8939d5，即使其他工作階段推進來源 HEAD 也不混入本次封裝。
