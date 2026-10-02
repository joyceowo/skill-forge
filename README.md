# Skill Forge

可加入 Codex 的技能市集。技能以外掛（plugin）為安裝單位，每個外掛包含自己的 `SKILL.md`、參考文件及資源。

市集顯示名稱為 **Skill Forge**；市集識別碼沿用建立工具的預設值 `personal`。來源路徑相對於專案根目錄，因此可將整個專案放入 Git 後分享。

## 已收錄的技能

| 外掛／技能 | 版本 | 用途 |
| --- | --- | --- |
| [sync-business-logic-docs](plugins/sync-business-logic-docs/README.md) | 1.0.0 | 從 C# 與 Git 歷史建立、稽核及增量同步業務邏輯 Markdown 文件。 |

## 加入 Codex

需要支援 `codex plugin` 的 Codex CLI。本專案建立時以 `codex-cli 0.160.0` 檢查指令格式。

在本專案根目錄執行：

```powershell
codex plugin marketplace add .
codex plugin add sync-business-logic-docs@personal
```

也可以在任何位置指定完整路徑：

```powershell
codex plugin marketplace add 'C:\Joyce\Git\vscode\skill-forge'
codex plugin add sync-business-logic-docs@personal
```

第一個指令登錄本機市集，第二個指令安裝外掛。若另一台電腦已有不同的 `personal` 市集，先為這份尚未登錄的副本設定不衝突的市集 `name`，並相應調整安裝指令的 `@personal`；不要覆蓋既有市集。

安裝後在 Codex 開啟新聊天，於技能選單搜尋 **Sync Business Logic Docs**，或輸入：

```text
請使用 sync-business-logic-docs，稽核這個 C# 專案的業務規則，並同步 docs/business/ 下的文件。
```

可用下列指令確認市集與外掛狀態：

```powershell
codex plugin marketplace list
codex plugin list
```

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

市集中的 `source.path`（例如 `./plugins/sync-business-logic-docs`）相對於專案根目錄，而非 `.agents/plugins/`。

## 維護與擴充

1. 新增 `plugins/<外掛名稱>/.codex-plugin/plugin.json`，並將技能放入該外掛的 `skills/<技能名稱>/SKILL.md`。
2. 在市集的 `plugins` 陣列尾端加入對應外掛，保留 `source`、`policy.installation`、`policy.authentication` 與 `category`。
3. 檢查外掛名稱、資料夾名稱與來源路徑一致，所有參考文件與資源均位於套件內。
4. 修改已安裝的外掛時，使用 Codex `plugin-creator` 的 `update_plugin_cachebuster.py` 為來源套件產生版本快取識別碼，再重新執行 `codex plugin add <外掛名稱>@personal`，並以新聊天載入。

請編輯此專案中的來源檔案；Codex 的安裝快取由安裝指令管理。這份技能目前是原始技能的完整副本，不會自動與個人技能目錄雙向同步。

本機使用不需要 Git 遠端。未來若要透過 Git 分享，將整個專案推送到自己的儲存庫，再以實際儲存庫來源執行 `codex plugin marketplace add`。
