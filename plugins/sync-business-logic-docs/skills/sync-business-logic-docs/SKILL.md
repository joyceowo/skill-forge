---
name: sync-business-logic-docs
description: Extract, audit, and incrementally synchronize business-logic documentation from C# source code and Git history, using the repository's primary language with bilingual mappings only for established domain terms. Use when creating or updating business Markdown from C#, checking rule and branch coverage across controllers, services, validators, models, repositories, and direct dependencies, detecting business-impacting changes between Git revisions, maintaining per-document synchronization checkpoints, or performing a full coverage audit before trusting an existing baseline.
---

# Sync Business Logic Documentation

Synchronize business documentation with implemented C# behavior.

Treat current executable source as the authority for implemented behavior. Use Git diff to locate changes, not as the sole source of business meaning.

Produce documentation that is:

- complete enough for business and AI lookup;
- written in the repository's primary language, with bilingual mappings only for established domain terms;
- explicit about rejection, normalization, defaults, calculations, permissions, state transitions, and integrations;
- incremental and reviewable after a trusted full-coverage baseline exists;
- supported by source evidence without invented product intent.

# Repository Configuration

Prefer:

```text
.ai/
├── business-logic-map.yaml
└── business-logic-state.yaml
```

Copy starting templates from `assets/` when these files do not exist.

## Mapping

Use `.ai/business-logic-map.yaml` to map source scopes to documents:

```yaml
version: 1

subsystems:
  Order:
    source:
      - src/Order/**/*.cs
    document: docs/business/order.md
```

Resolve the target document in this order:

1. User-specified document.
2. Explicit mapping.
3. A unique mapping supported by namespace, directory, subsystem, and filename.

Do not modify a document when mapping remains ambiguous.

Expand every configured glob before analysis. Report configured patterns that match no files.

## Synchronization State

Maintain state per document:

```yaml
version: 1

documents:
  docs/business/order.md:
    last_processed_commit: "a8f30c7"
    last_full_audit_commit: "73bc219"
```

Interpret the checkpoints separately:

- `last_processed_commit`: all relevant committed changes through this commit were analyzed.
- `last_full_audit_commit`: at this commit, the complete mapped source surface and required direct dependencies were inventoried, classified, reconciled with the document, and validated.

Incremental synchronization normally advances only `last_processed_commit`.

Advance `last_full_audit_commit` only after Coverage Audit Mode succeeds. A missing `last_full_audit_commit` means the document does not yet have a trusted full-coverage baseline, even if `last_processed_commit` exists.

Do not store repository-specific commit hashes in the skill itself.

# Git Safety

Allow read-only Git operations needed for analysis.

Do not automatically commit, push, reset, rebase, switch branches, rewrite history, or force-update refs.

Persistent checkpoints must refer to real commits. Never use a checkpoint to represent staged or working-tree changes.

# Select an Operating Mode

Select the mode independently for each document.

## Coverage Audit Mode

Use Coverage Audit Mode when:

- `last_full_audit_commit` is missing;
- the user requests a complete audit, completeness check, re-baseline, or coverage review;
- mappings or documentation scope changed materially;
- the skill's coverage requirements changed and an older baseline is not trustworthy;
- evidence suggests existing documentation omitted unchanged behavior.

Coverage Audit Mode reconciles the complete current implementation, not only a Git diff.

For each mapped document:

1. Expand and read the mapped source set.
2. Build a source-surface inventory.
3. Follow business-relevant direct dependencies.
4. Classify every entry point and business decision branch in a coverage ledger.
5. Reconcile all confirmed business behavior with the document.
6. Validate terminology, behavior semantics, coverage, and the Markdown diff.
7. Record current committed `HEAD` as both checkpoints only after every required item is resolved.

Do not claim full coverage or write `last_full_audit_commit` when the inventory is incomplete.

Read `references/coverage-audit.md` before auditing a large service, a document suspected of omissions, or a source set with delegated business rules.

## Bootstrap Mode

Use when the target document has no `last_processed_commit` or is new.

Bootstrap includes Coverage Audit Mode. Do not guess which historical commit an existing document represents.

Read current mapped source and the existing document, preserve correct content, add or correct only evidence-backed behavior, validate, then establish current committed `HEAD` as both checkpoints.

## Incremental Mode

Use only when both checkpoints exist and the stored `last_processed_commit` is valid.

Set:

```text
base   = last_processed_commit
target = HEAD
```

Locate changes with:

```bash
git diff --name-status --find-renames <base>..<target> -- '*.cs'
git diff --find-renames --unified=20 <base>..<target> -- '*.cs'
```

Inspect the changed source plus enough current and previous context to establish semantic business behavior. When analysis and validation succeed, advance `last_processed_commit` only.

Incremental Mode does not prove that unchanged legacy behavior is fully documented.

## Explicit Range Mode

Use a user-provided range such as `main...HEAD` or `abc123..def456` instead of the stored base.

Do not change persistent checkpoints unless the requested target is intended as the new baseline and all applicable validation succeeds. An explicit range alone never advances `last_full_audit_commit`.

## Baseline Reconciliation

Before incremental use, verify:

```bash
git cat-file -e <last_processed_commit>^{commit}
git merge-base --is-ancestor <last_processed_commit> HEAD
```

If the commit is missing or not an ancestor, enter Coverage Audit Mode, reconcile current behavior, and report the re-baseline.

## Uncommitted Changes

Analyze staged or working-tree changes when requested. Update documentation only when requested. Do not advance either checkpoint for uncommitted work.

# Build the Source-Surface Inventory

Coverage Audit Mode must inventory at least:

- controller actions, endpoints, handlers, and public use-case entry points;
- public service methods and business-relevant private helpers;
- validators and data-annotation requirements;
- enums, constants, status values, and configured business codes;
- calculations and derived fields;
- permission and action-visibility decisions;
- repository, policy, helper, or external-service results that control observable outcomes;
- workflows for query, create, save, submit, approve, reject, withdraw, cancel, import, export, synchronize, and report behavior when present.

Do not assume only validation and persistence methods are business logic. Query visibility, button eligibility, version selection, defaulting, enrichment, totals, reporting, and synchronization can be business behavior.

Maintain an internal, rule-level coverage ledger. A method-level row is insufficient when the method contains multiple business outcomes:

```yaml
- rule_id: OrderService.GetOrders.visible-actions
  symbol: OrderService.GetOrders
  condition: user role and order status
  result_type: Authorize
  result: selects visible actions
  disposition: documented-here
  section: 訂單查詢與權限

- rule_id: PricingPolicy.RequiresApproval.low-price
  disposition: delegated
  document: docs/business/pricing.md

- rule_id: OrderMappings.Configure.dto-copy
  disposition: technical-only

- rule_id: OrderRepository.RunStatusProcedure.status-effect
  disposition: unresolved
```

Allowed dispositions are:

- `documented-here`
- `delegated`
- `technical-only`
- `unresolved`

Every entry point and independent business branch must receive a disposition. Record the branch condition, result type, actual result, source evidence, and document section or owner. Treat an entry point as covered only when all of its branches are classified. `delegated` requires a valid target document plus a concise effect summary in the consuming document when the behavior affects that subsystem. Any `unresolved` item blocks full-audit completion.

The coverage ledger is an analysis artifact. Do not persist it unless the user requests an audit report. Never add a `Source coverage`, source-file list, method inventory, or coverage-ledger section to the business document unless the user explicitly requests it there.

# Follow Business-Relevant Dependencies

Follow a direct dependency when its return value, mutation, exception, or configuration controls an externally observable result.

Inspect the implementation of delegated validators, policies, domain services, repository procedures, helpers, and external integrations as needed. A method name or comment alone is not enough evidence.

Stop following dependencies when additional code cannot change the established business interpretation. Do not recursively inspect unrelated infrastructure.

When a rule belongs to another mapped document:

1. Keep detailed ownership in the authoritative document.
2. Record the consuming effect in the current document.
3. Add a clear cross-reference when practical.
4. Do not silently omit the behavior from both documents.

# Classify Changes and Behavior

Classify source changes internally as:

- `Business-impacting`
- `Technical-only`
- `Uncertain`

Business-impacting behavior includes validation, permissions, thresholds, calculations, eligibility, data visibility, defaults, normalization, status transitions, workflow decisions, rejection conditions, and external interactions that alter observable outcomes.

Technical-only changes commonly include logging, telemetry, formatting, dependency wiring, comments, and behavior-preserving refactors. Infrastructure code is not automatically technical-only.

Read additional context for `Uncertain` items. Do not guess.

For every business rule, identify its result type:

```text
Required      missing input is rejected
Reject        input or action is refused
Normalize     input is cleared, overwritten, or canonicalized
Default       an absent value receives a default
Preserve      an attempted change is ignored and the old value remains
Calculate     a value is derived from other values
Enrich        names, prices, inventory, or related data are added
Authorize     permissions or visible actions are selected
Transition    business or ERP status changes
Synchronize   state is exchanged with another system
```

Document the actual result. Do not describe `Preserve` as `Reject`, or a forced `Normalize` as a validation requirement.

# Analyze Semantic Business Behavior

For each relevant item:

1. Read the containing method or class.
2. Inspect request models and validation attributes when they affect required fields.
3. Follow direct dependencies required for the decision.
4. Compare previous and current implementation when processing a Git change.
5. Determine condition, boundary, action, resulting state, and failure behavior.
6. Distinguish executable behavior from comments or intended design.

Use Git for previous source when needed:

```bash
git show <base>:path/to/File.cs
```

Before editing, form a semantic business diff:

```yaml
before: 訂單金額超過 5,000 元時需要主管核准。
after: 訂單金額達 10,000 元以上時需要主管核准。
document: docs/business/order.md
section: 高額訂單核准
```

Do not write this intermediate representation unless requested.

# Primary-language Documentation and Bilingual Terms

Infer the document's primary language from the existing document, repository convention, and user request. Write headings, sentences, tables, and revision history in that primary language. For the current zh-TW convention, keep the prose Chinese.

Make only established domain terms, acronyms, statuses, and exact codes searchable in both Chinese and English. Do not mirror a complete heading, sentence, paragraph, table cell, or revision-history entry in a second language unless the user explicitly requests full translation.

At first meaningful use, prefer:

```text
中文名稱（English Name, `code`）
```

Examples:

```text
組織代碼（Organization Code, ORG Code）
嘜頭（Shipping Mark）
待作廢（Pending Cancellation, `pending_cancel`）
```

For documents with many codes or statuses, add a terminology table near the beginning:

```markdown
## 名詞與狀態對照

| 中文名稱 | English / Code | 說明 |
|---|---|---|
| 業務訂單 | Sales Order, SO | 業務建立並送入 ERP 的訂單。 |
```

Terminology and status tables are allowed even when scenario sections otherwise use Gauge-style lists.

Preserve exact API, ERP, enum, database, status, and configuration identifiers when they improve retrieval. Put literal values in backticks.

Do not invent an English expansion or business meaning. In particular, do not translate a customer-code prefix, variable name, or implementation nickname into a country, organization, or customer category without supporting evidence. Report unresolved terminology when necessary.

Use one canonical translation consistently. Establish a mapping at first meaningful use or in the terminology table, then use the primary-language term alone unless ambiguity requires the English name or literal code again.

# Write Business Documentation

Describe:

```text
What happens
When it happens
Under which business condition
What result, state, calculation, default, or rejection occurs
```

Avoid unnecessary class, method, variable, repository, framework, and implementation names. Keep exact identifiers that are established domain terms or materially improve AI lookup.

Use Gauge-style scenario sections:

```markdown
# 訂單

## 高額訂單核准

* 訂單金額達 100,000 元以上時，需要主管權限才能核准。
```

Keep `## 修訂紀錄` or the repository's established equivalent at the end.

# Update Existing Documents

In Incremental Mode, keep diffs minimal:

- modify only affected scenarios;
- add a new scenario near related behavior;
- remove a rule only after confirming it no longer exists;
- leave documentation unchanged for behavior-preserving moves or refactors;
- preserve unrelated wording and ordering.

In Coverage Audit Mode, completeness takes priority over minimal diff. Preserve correct content, but add missing workflows and correct unsupported inference. Do not perform unrelated stylistic rewriting.

Perform lossless reconciliation: keep each independent condition and outcome as an atomic rule. Do not compress multiple branches into vague summaries such as `相關欄位會經過驗證` or `系統會依設定處理`. Remove a previously documented rule only with source evidence that the behavior was removed, is a duplicate, or is authoritatively documented elsewhere.

When a target document is new, moved, or remapped, search for the prior mapped path and similarly named legacy documents before writing. Reconcile their still-valid rules with current source. If a likely predecessor cannot be inspected, report possible content loss and do not establish a full-audit checkpoint.

When source conflicts with documentation, confirm with sufficient context, update only the conflicting behavior, and preserve unrelated content.

# Revision History

When business-document content changes, add concise business summaries using the target commit's short SHA:

```markdown
## 修訂紀錄

- 2026-08-12
  - [`a8f30c7`] 補充訂單查詢權限與 ERP 出貨狀態同步流程。
```

Merge entries under the same date. Do not record implementation-only work or add an entry when the business document did not change.

For uncommitted analysis, do not imply that a commit contains the documentation change. Follow the repository's convention or report that revision history was not advanced.

# Persist State Last

Update state only after analysis, document editing, and validation succeed.

## Incremental success

Advance `last_processed_commit` after the complete committed range was analyzed, including when all changes were technical-only. Leave `last_full_audit_commit` unchanged.

## Coverage-audit success

Set both checkpoints to the audited committed target:

```yaml
last_processed_commit: "<target-commit>"
last_full_audit_commit: "<target-commit>"
```

## Never advance an affected checkpoint when

- analysis failed or relevant source was unreadable;
- mapping or terminology ambiguity affects correctness;
- an inventory item or business impact remains unresolved;
- required direct dependencies were not inspected;
- document editing or validation failed;
- the analyzed range or coverage inventory is incomplete;
- the target includes uncommitted work.

Failure for one document must not falsely mark that document synchronized. Treat documents independently.

# Validate

Review the smallest applicable diff, for example:

```bash
git diff -- docs/business/order.md .ai/business-logic-state.yaml
```

Verify:

- every added or changed rule has source evidence;
- required, rejected, normalized, defaulted, preserved, calculated, enriched, authorized, transitioned, and synchronized behavior is described accurately;
- the primary language is preserved and only canonical terms or literal codes are bilingual;
- no customer prefix, variable, comment, TODO, dead code, or identifier was turned into unsupported business meaning;
- unrelated sections were preserved;
- revision history matches actual document changes;
- checkpoints refer to real committed revisions and were updated last.

For Coverage Audit Mode also verify:

- all configured source patterns were expanded;
- all required entry points and relevant helpers were inventoried;
- every inventory item has a non-`unresolved` disposition;
- every public entry point and independent business branch has a rule-level ledger row;
- delegated behavior has an owner and consuming-effect summary;
- query, permission, calculation, defaulting, versioning, reporting, and integration flows were not skipped merely because they are not validations;
- document coverage is proportionate to the business surface.

If the document is small relative to a large business service, re-check for omitted workflows before writing `last_full_audit_commit`.

# New Documents and No-change Results

For a new document, run Bootstrap Mode, create confirmed Gauge-style scenarios, add terminology mappings when useful, add revision history, validate, and then establish both checkpoints.

When an incremental range contains only technical changes, do not modify business documentation or revision history. Advance only `last_processed_commit` after complete analysis.

# Completion Summary

Report:

```text
Mode:
Git range or audited target:
Coverage inventory:
Business-impacting behavior:
Updated documents:
Technical-only changes skipped:
last_processed_commit advanced:
last_full_audit_commit advanced:
Warnings or unresolved items:
```

Do not dump large source diffs unless requested.

# Completion Checklist

Before finishing, confirm:

- the correct mode was selected per document;
- stored commits were validated before incremental use;
- Coverage Audit Mode was used when `last_full_audit_commit` was missing;
- Git diff was used only as a locator;
- required source surface and dependencies were inspected;
- every coverage item was classified when auditing;
- semantic behavior and result types were understood before editing;
- prose uses the primary language and bilingual terminology is evidence-backed;
- documentation and revision history were validated;
- state was updated last and no unresolved work was marked complete;
- no Git history was rewritten or published without explicit instruction.

# References

Read `references/examples.md` for focused semantic-diff examples.

Read `references/coverage-audit.md` for a large-service coverage workflow, rule-level coverage-ledger example, bilingual-terminology boundaries, and checkpoint behavior.
