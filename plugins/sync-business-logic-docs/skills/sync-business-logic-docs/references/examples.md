# Business Logic Diff Examples

These examples demonstrate how C# changes should be translated into minimal business-documentation updates.

The expected Markdown diff should reflect business behavior, not implementation details.

---

# Example 1 — Business Threshold Changed

## C# Diff

```diff
 public bool RequiresManagerApproval(Order order)
 {
-    return order.TotalAmount > 5000;
+    return order.TotalAmount >= 10000;
 }
```

## Existing Markdown

```markdown
## 高額訂單核准

* 訂單金額超過 5,000 元時，需要主管核准。
```

## Expected Business Interpretation

Before: 訂單金額 > 5,000 元需要主管核准。

After: 訂單金額 >= 10,000 元需要主管核准。

This is a business-impacting change because both the threshold and boundary condition changed.

## Expected Markdown Diff

```diff
 ## 高額訂單核准

-* 訂單金額超過 5,000 元時，需要主管核准。
+* 訂單金額達 10,000 元以上時，需要主管核准。

 ## 修訂紀錄

+- 2026-08-11
+  - [`abc1234`] 調整高額訂單主管核准門檻為 10,000 元以上。
```

## Rules Demonstrated

- Update only the affected business rule.
- Translate implementation conditions into business language.
- Preserve unrelated document sections.
- Record the business change in revision history.

---

# Example 2 — Permission Rule Added

## C# Diff

```diff
 public void CancelOrder(Order order, User user)
 {
+    if (!user.IsManager && order.Status == OrderStatus.Shipped)
+        throw new PermissionDeniedException();

     order.Cancel();
 }
```

## Existing Markdown

```markdown
## 訂單取消

* 使用者可取消尚未完成的訂單。
```

## Expected Business Interpretation

A new permission restriction exists: 已出貨訂單只有主管可以取消。

The document should describe the resulting permission rule rather than the exception class or property names.

## Expected Markdown Diff

```diff
 ## 訂單取消

 * 使用者可取消尚未完成的訂單。
+* 訂單已出貨後，只有主管可以取消訂單。

 ## 修訂紀錄

+- 2026-08-11
+  - [`def5678`] 新增已出貨訂單僅限主管取消的權限限制。
```

## Rules Demonstrated

- Permission changes are business-impacting.
- Do not expose implementation identifiers unless they are established domain terms.
- Add the new rule to the existing scenario instead of creating unnecessary sections.

---

# Example 3 — State Transition Changed

## C# Diff

```diff
 public void Approve(Order order)
 {
     if (order.Status != OrderStatus.Pending)
         throw new InvalidOperationException();

-    order.Status = OrderStatus.Approved;
+    order.Status = OrderStatus.AwaitingPayment;
 }
```

## Existing Markdown

```markdown
## 訂單核准

* 只有待處理中的訂單可以核准。
* 核准完成後，訂單狀態變更為「已核准」。
```

## Expected Business Interpretation

The eligibility rule remains unchanged. Only the resulting state transition changed.

Before: 待處理 → 已核准

After: 待處理 → 等待付款

## Expected Markdown Diff

```diff
 ## 訂單核准

 * 只有待處理中的訂單可以核准。
-* 核准完成後，訂單狀態變更為「已核准」。
+* 核准完成後，訂單進入「等待付款」狀態。

 ## 修訂紀錄

+- 2026-08-11
+  - [`789abcd`] 調整訂單核准後的流程，改為進入等待付款狀態。
```

## Rules Demonstrated

- Preserve unchanged rules inside the same section.
- Modify only the changed business outcome.
- State transitions are business logic.

---

# Example 4 — Technical-only Change

## C# Diff

```diff
 public async Task<Order> GetOrderAsync(Guid id)
 {
-    _logger.LogInformation("Loading order {OrderId}", id);
+    _logger.LogDebug("Loading order {OrderId}", id);

     return await _repository.GetAsync(id);
 }
```

## Existing Markdown

```markdown
## 訂單查詢

* 使用者可以依訂單編號查詢訂單。
```

## Expected Business Interpretation

There is no observable business-behavior change. The logging level changed from Information to Debug.

## Expected Markdown Diff

```diff
(no changes)
```

## Revision History

Do not add a revision-history entry.

## Synchronization State

If the entire committed source range was analyzed successfully, the document checkpoint may still advance.

## Rules Demonstrated

- Technical-only changes must not modify business documentation.
- No empty revision-history entry should be created.
- A checkpoint may advance after successful analysis even when the document does not change.

---

# Example 5 — Refactor Without Business Behavior Change

## C# Diff

```diff
-public bool CanCancel(Order order)
-{
-    return order.Status == OrderStatus.Pending
-        || order.Status == OrderStatus.Approved;
-}
+public bool CanCancel(Order order)
+{
+    return _cancellationPolicy.IsAllowed(order);
+}
```

Additional current code:

```csharp
public bool IsAllowed(Order order)
{
    return order.Status == OrderStatus.Pending
        || order.Status == OrderStatus.Approved;
}
```

## Existing Markdown

```markdown
## 訂單取消

* 待處理或已核准的訂單可以取消。
```

## Expected Business Interpretation

The implementation moved from the service into a policy object. The observable business rule remains unchanged.

## Expected Markdown Diff

```diff
(no changes)
```

## Revision History

Do not add a revision-history entry.

## Synchronization State

The checkpoint may advance after confirming that the business behavior remains equivalent.

## Rules Demonstrated

- Refactoring alone does not justify documentation changes.
- Diff text alone is insufficient.
- Follow direct dependencies when necessary to verify semantic equivalence.
- Document behavior, not class structure.
