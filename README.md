# Skill Forge

透過 GitHub 安裝到 Codex 的技能市集。技能以外掛（plugin）為安裝單位，每個外掛包含自己的 `SKILL.md`、參考文件及資源。

GitHub 儲存庫：[joyceowo/skill-forge](https://github.com/joyceowo/skill-forge)。市集顯示名稱為 **Skill Forge**，識別碼為 `skill-forge`。

## 已收錄的技能

| 外掛／技能 | 版本 | 用途 |
| --- | --- | --- |
| [sync-business-logic-docs](plugins/sync-business-logic-docs/README.md) | 1.0.0 | 從 C# 與 Git 歷史建立、稽核及增量同步業務邏輯 Markdown 文件。 |
| [code-atlas](plugins/code-atlas/README.md) | 1.0.0 | 將單一或多個 Git 專案整理成三層商業地圖、鎮民規則文件與可匯入的地圖 ZIP。 |

## Code Atlas 安裝與使用

Code Atlas 的完整流程是 **Skill → 商業邏輯文件 → 地圖 ZIP → viewer 匯入 → 國家／城市／鄉鎮縮放**。此版本包含分析腳本、參考文件、離線 viewer 與 D3 授權；使用方式與 Python 套件需求見 [Code Atlas 說明](plugins/code-atlas/README.md)。

登錄市集並安裝 Code Atlas：

```powershell
# Codex
codex plugin marketplace add https://github.com/joyceowo/skill-forge.git --ref main
codex plugin add code-atlas@skill-forge
# Claude Code
claude plugin marketplace add https://github.com/joyceowo/skill-forge.git
claude plugin install code-atlas@skill-forge
```

從 GitHub 安裝必須等這個版本推送後才會取得；本機版本可先用以下方式載入（將路徑替換成自己的）：

```powershell
codex plugin marketplace add 'C:/path/to/skill-forge'
codex plugin add code-atlas@skill-forge
claude --plugin-dir 'C:/path/to/skill-forge/plugins/code-atlas'
```

在目標 Git 專案開啟新聊天後，請 Codex「使用 code-atlas 分析目前專案，產生商業邏輯文件並匯出地圖 ZIP」；Claude Code 使用 `/code-atlas:code-atlas` 加上相同要求。單一功能中的欄位或選項放在鎮民，商業流程、規則及程式證據是預設內容。

更新時，Codex 先執行 `codex plugin marketplace upgrade skill-forge`，再執行 `codex plugin add code-atlas@skill-forge`；Claude Code 先執行 `claude plugin marketplace update skill-forge`，再執行 `claude plugin update code-atlas@skill-forge`。本機市集直接讀取來源目錄；GitHub 市集更新讀取已推送的版本。完成後重新開啟工作階段。

## 從 GitHub 安裝

需要支援 `codex plugin` 的 Codex CLI。本專案建立時以 `codex-cli 0.160.0` 檢查指令格式。

在任何目錄執行以下指令，不必先手動複製本專案：

```powershell
codex plugin marketplace add https://github.com/joyceowo/skill-forge.git --ref main
codex plugin add sync-business-logic-docs@skill-forge
```

第一個指令從 GitHub 的 `main` 分支取得並登錄市集，第二個指令安裝其中的技能外掛。若儲存庫為私人儲存庫，使用者需具備 GitHub 存取權，並先設定 Git 驗證。

安裝後在 Codex 開啟新聊天，於技能選單搜尋 **Sync Business Logic Docs**，或輸入：

```text
請使用 sync-business-logic-docs，稽核這個 C# 專案的業務規則，並同步 docs/business/ 下的文件。
```

可用下列指令確認市集與外掛狀態：

```powershell
codex plugin marketplace list
codex plugin list
```

## 更新已安裝的技能

```powershell
codex plugin marketplace upgrade skill-forge
codex plugin add sync-business-logic-docs@skill-forge
```

先更新 GitHub 市集快照，再安裝該快照中的外掛版本，最後開啟新聊天。

## 目錄結構

```text
skill-forge/
├── .agents/plugins/marketplace.json
├── README.md
└── plugins/
    └── sync-business-logic-docs/
        ├── .codex-plugin/plugin.json
        ├── README.md
        └── skills/sync-business-logic-docs/
            ├── SKILL.md
            ├── agents/openai.yaml
            ├── assets/
            │   ├── business-logic-map.yaml
            │   └── business-logic-state.yaml
            └── references/
                ├── coverage-audit.md
                └── examples.md
```

市集中的 `source.path`（例如 `./plugins/sync-business-logic-docs`）相對於儲存庫根目錄，而非 `.agents/plugins/`。項目的 `source.source: "local"` 表示外掛位於下載的儲存庫內；整個市集仍由上述 GitHub URL 安裝與更新。

## 維護與擴充

1. 新增 `plugins/<外掛名稱>/.codex-plugin/plugin.json`，並將技能放入該外掛的 `skills/<技能名稱>/SKILL.md`。
2. 在市集的 `plugins` 陣列尾端加入對應外掛，保留 `source`、`policy.installation`、`policy.authentication` 與 `category`。
3. 檢查外掛名稱、資料夾名稱與來源路徑一致，所有參考文件與資源均位於套件內。
4. 發布外掛更新時，更新 `.codex-plugin/plugin.json` 中的版本，將變更提交並推送到 GitHub 的 `main` 分支，再依上方更新指令驗證安裝。

請編輯此專案中的來源檔案；Codex 的安裝快取由安裝指令管理。這份技能目前是原始技能的完整副本，不會自動與個人技能目錄雙向同步。

分享市集時提供本儲存庫的 GitHub 連結與上方兩個安裝指令即可。
