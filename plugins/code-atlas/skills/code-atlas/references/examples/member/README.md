# 範例：會員系統

一份完整的 `.atlas/` 範例，示範格式和三層說明的寫法。

- 1 個國家：會員系統
- 3 個城市：會員資料、會員等級、點數系統
- 7 個鄉鎮，其中 2 個有鎮民（「個人資料修改」的姓名、生日、地址；「等級權益」的一般會員、VIP）

範例中的檔案路徑對應一個虛構的前後端專案：`web/`（React）＋ `api/`（ASP.NET Core）。
code-atlas 的測試會用 `tests/fixtures/member-system/` 建出這個專案，用來驗證 scan、validate、build。
