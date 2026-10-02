# Sync Business Logic Docs

從 C# 原始碼與 Git 歷史建立、稽核及同步業務邏輯文件的 Codex 技能。

## 能力

- 初次建立文件時，完整盤點業務入口、規則及獨立分支。
- 追蹤影響可觀察結果的直接相依實作，避免僅憑方法名稱推測規則。
- 建立可信的完整稽核基準後，依 Git 提交差異增量更新文件。
- 分別追蹤 `last_processed_commit` 與 `last_full_audit_commit`。
- 保留文件的主要語言，僅為已確認的領域名詞、狀態及代碼建立中英對照。

技能包含操作指引與模板，不需要額外 MCP 伺服器或服務帳號。執行時需能讀取目標 C# 原始碼與 Git 歷史，並在要求同步時寫入目標文件。

## 使用方式

從市集安裝後，在目標 C# 專案的新聊天中選取技能，並提供來源範圍與文件位置，例如：

```text
請使用 sync-business-logic-docs，將 src/Order/ 的 C# 業務規則同步到
docs/business/order.md。先做完整覆蓋稽核，再建立同步檢查點。
```

也可使用來源與文件映射：

```yaml
version: 1
subsystems:
  Order:
    source:
      - src/Order/**/*.cs
    document: docs/business/order.md
```

將映射放在目標專案的 `.ai/business-logic-map.yaml`。首次使用時，同步狀態可從下列空白設定開始，成功完成稽核後由技能填入真實提交：

```yaml
version: 1
documents: {}
```

同步狀態放在 `.ai/business-logic-state.yaml`。套件中的狀態模板含有示範文件路徑及 `REPLACE_WITH_COMMIT_SHA`，不可將這些值當成有效基準；未提交的變更也不應推進提交檢查點。

## 套件內容

- [技能指引](skills/sync-business-logic-docs/SKILL.md)
- [完整稽核流程](skills/sync-business-logic-docs/references/coverage-audit.md)
- [語意差異範例](skills/sync-business-logic-docs/references/examples.md)
- [來源映射模板](skills/sync-business-logic-docs/assets/business-logic-map.yaml)
- [同步狀態模板](skills/sync-business-logic-docs/assets/business-logic-state.yaml)

本外掛將現有 `sync-business-logic-docs` 技能的六個檔案原樣打包。技能不會自動提交、推送或改寫 Git 歷史。
