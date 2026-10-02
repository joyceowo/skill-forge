# Coverage Audit Reference

Use this reference when auditing a large C# service, correcting a document suspected of omissions, or establishing `last_full_audit_commit`.

## Contents

- Source-surface inventory
- Coverage ledger
- Dependency closure
- Primary-language documentation and bilingual terms
- Behavior-result distinctions
- Checkpoint example

## Source-surface inventory

Start with mapped files, then enumerate observable entry points before reading only the most prominent save or validation method.

Example inventory:

```text
OrderController
  GetOrders
  GetOrder
  SaveOrder
  SubmitOrder
  WithdrawOrder
  CancelOrder
  ImportDetails
  GetShippingStatus
  SyncShippingStatus

OrderService
  list permissions and visible actions
  total calculation
  save validation and normalization
  change restrictions
  version selection
  submission transitions
  ERP synchronization
  dashboard aggregation
```

Also inspect request-model required attributes, enums and constants, validators, and direct dependencies that control these outcomes.

Do not treat repository calls as automatically technical. Inspect a repository or stored-procedure contract when its result determines eligibility, totals, available actions, state transitions, or externally visible data.

## Coverage ledger

Create an internal row for every public entry point and every independent business decision branch:

| Rule ID | Condition | Result type | Actual result | Disposition | Document section or owner |
|---|---|---|---|---|---|
| `GetOrders.visible-actions` | User role and order status | Authorize | Selects visible actions | documented-here | 訂單查詢與權限 |
| `RequiresApproval.low-price` | Price below approval floor | Reject | Submit is blocked pending approval | delegated | pricing-approval.md |
| `Configure.dto-copy` | Equivalent DTO fields | — | No business decision | technical-only | — |
| `RunStatusProcedure.status-effect` | Unknown | Transition | May change order state | unresolved | inspect before completion |

Include source evidence for each business row. A method-level row does not cover a method with several conditions or outcomes. Count an entry point as complete only after every branch is classified. Do not complete a full audit while any required row is unresolved.

For delegated behavior, document both layers:

- authoritative document: full pricing rule;
- consuming document: submitting an order is rejected when pricing approval is still required, with a cross-reference to the pricing document.

## Dependency closure

Follow dependencies based on behavioral effect, not project layer.

Read the dependency implementation when code does any of the following:

- branches on its result;
- copies its result into a business field;
- converts its exception into a business response;
- uses it to calculate an amount or limit;
- uses it to choose visible actions or status transitions;
- sends or synchronizes business state externally.

Stop after the business condition and result are established confidently.

The ledger and source inventory are audit artifacts. Report their counts in the completion summary, but never copy them into the business document as a `Source coverage` section unless the user explicitly requests that section.

## Primary-language documentation and bilingual terms

Use the existing document or repository convention as the primary language. Translate established terms, not the document. Do not duplicate complete headings, sentences, paragraphs, table cells, or revision-history entries in another language unless explicitly requested.

Prefer a compact lookup table near the beginning of documents with many codes:

```markdown
## 名詞與狀態對照

| 中文名稱 | English / Code | 說明 |
|---|---|---|
| 業務訂單 | Sales Order, SO | 業務建立並送入 ERP 的訂單。 |
| 組織代碼 | Organization Code, ORG Code | 決定訂單所屬組織。 |
| 待作廢 | Pending Cancellation, `pending_cancel` | 等待 ERP 完成作廢。 |
```

After the table or first-use mapping establishes a term, use the primary-language term alone in normal prose.

Retain acronyms when their expansion is not established. For example, write `PM 最低單價（PM Lowest Price）` rather than inventing what `PM` stands for.

Do not infer that a customer-code prefix represents a country unless executable source or authoritative configuration proves it. Prefer `客戶代碼以 00100 開頭` over `美國客戶` when only the prefix is known.

## Behavior-result distinctions

Document these differently:

```text
Reject:
  使用者輸入無效倉別時，訂單儲存失敗。

Normalize:
  EXW 訂單的貨運承攬商會固定清空。

Default:
  匯入明細未填 BIOS 類型時，系統帶入一般類型。

Preserve:
  已部分出貨的明細即使傳入新單價，仍保留原單價。

Calculate:
  訂單總額為（單價＋運費單價－折扣單價）×數量。

Authorize:
  只有填單人或授權區域使用者可編輯與送出。

Synchronize:
  系統取得 ERP 明細狀態後更新本地狀態，再重新計算單頭狀態。
```

Avoid flattening these into vague statements such as `欄位必須正確`.

During reconciliation, keep every independently testable condition and result as a separate atomic rule. Do not replace detailed import, query, defaulting, authorization, or synchronization flows with a one-line method summary. Retain a valid legacy rule unless current source proves it was removed, duplicated, or delegated to an authoritative document.

## Checkpoint example

Assume commit `A` received a complete audit and commits `B` through `D` were processed incrementally:

```yaml
last_processed_commit: "D"
last_full_audit_commit: "A"
```

This means all changes through `D` were analyzed, while the last complete source-surface reconciliation occurred at `A`.

After a new successful full audit at `D`:

```yaml
last_processed_commit: "D"
last_full_audit_commit: "D"
```

A missing `last_full_audit_commit` requires Coverage Audit Mode before the document can be treated as coverage-complete. Write it only after every public entry point and independent business branch has a non-unresolved ledger row and every documented-here row maps to an actual section.
