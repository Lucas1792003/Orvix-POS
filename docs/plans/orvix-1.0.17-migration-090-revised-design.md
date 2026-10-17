# Migration 090: revised design (refund line model)

| | |
|---|---|
| Status | **Design only.** No migration file exists. Implementation belongs to Batch 1-db, which is not authorised. |
| Date | 2026-10-16 |
| Supersedes | The 090 row of the master plan v2 §6.2, and the database security plan (P1) §4.1 rule "`net_line_total_mmk` NOT NULL after backfill" |
| Companion | Batch 1-code client rules in `src/features/sales/refundMath.ts` (client-side only) |

## 1. The defect being designed out

The plan adds `sale_items.net_line_total_mmk` in 090 and makes it NOT NULL after the backfill. Only the `complete_sale` extension in **095** writes it.

Between 090 and 095, `complete_sale` (072) inserts sale items without the column. So **every sale fails** from 090 onwards in three places:
- on the harness at each level from 090 to 094;
- in production during the G5 window, after the 090 stop point;
- on any till that rings up a sale while the schema sits at 090–094.

Offline sales replayed in that window fail too. They become conflicts, not lost sales, but they still need owner work.

## 2. Compatibility requirements

| Actor during 086 → 099 | Must keep working |
|---|---|
| `complete_sale` 072 (unchanged until 095) | inserts lines without a net amount |
| RC3 / 1.0.16 tills, including queued `create_refund_void_request` | request shape v1, `items: [{productId, qtyUnits, amountMmk}]`, with amounts at the **pre-discount** line total |
| 1.0.17 Batch 1-code client | the same v1 shape, but with **net** amounts and **base-unit** quantities |
| `approve_void_request` | requires `sales.status = 'NORMAL'` |
| Reports and old clients | read `sales.status ∈ {NORMAL, VOID, REFUNDED}` |

## 3. Design

### 3.1 Net amounts are derived, and the stored value is a cache

- `sale_items.net_line_total_mmk integer NULL CHECK (net_line_total_mmk >= 0)`, **nullable in 090**.
- The 090 backfill fills every existing row, using the allocation in 3.2. It asserts Σ per sale = `sales.total_mmk`, or an exception list for legacy rows where Σ lines < total. Those rows get net = line total and are listed in the migration output.
- `app_sale_net_lines(p_sale_id text) RETURNS TABLE (sale_item_id text, net_mmk integer)`:
  - `STABLE`, `SECURITY DEFINER`, org-checked;
  - returns the stored value where present, otherwise computes it with 3.2;
  - every 090 refund function reads net amounts **only** through it. A sale written by 072 after 090 is therefore refundable correctly with no stored value.
- **095** starts writing the column in `complete_sale`. It backfills rows inserted between 090 and 095, then enforces NOT NULL through `ADD CONSTRAINT … CHECK (net_line_total_mmk IS NOT NULL) NOT VALID; VALIDATE CONSTRAINT …`. A pre-check lists any NULL rows and aborts. NOT NULL never exists while 072 is the engine.
- Rejected alternative, a deferred constraint trigger that computes nets at commit: it is correct, but it adds a commit-time trigger on the hottest table for a cache.

### 3.2 Allocation rule (identical on client and server)

1. D = max(0, Σ `line_total_mmk` − `sales.total_mmk`).
2. Each line's share is ⌊D × line ÷ Σ⌋, computed in `bigint`/`numeric`.
3. The leftover goes one MMK at a time to the largest remainders. **Ties go by `sale_items.id COLLATE "C"` ascending**, which is code-point order and matches the JavaScript client.
   - **Non-ASCII ids (review correction).** `COLLATE "C"` compares UTF-8 bytes, which is Unicode **code-point** order. The JavaScript client's `<` compares **UTF-16 code units**. The two agree for every string without characters above U+FFFF; they can disagree only when such a character is compared with one in U+E000–U+FFFF.
   - Every id the system generates today is ASCII (`item-<hex>`), so the orders are identical in practice. To keep it a guarantee rather than an observation:
     - the 090 pre-check lists any `sale_items.id` outside printable ASCII (`id !~ '^[ -~]+$'`) and aborts if one exists;
     - the client's tie-break moves to an explicit code-point comparison in the 090 client batch, or earlier if a non-ASCII id ever appears;
     - harness t27 and `refundMath.test.ts` share a vector with ids that differ only in a supplementary-plane character, so a mismatch fails a test, not a refund.
4. Net = line − share.

This is pinned by harness t27 and by the client test `refundMath.test.ts` (same vectors).

### 3.3 Refund amount

- **Partial:** a refund of q of a line's Q **base** units pays `round(net::numeric * q / Q)::integer`.
  - **Always in `numeric` (review correction).** With all-integer operands, `net * q / Q` is integer division in Postgres and truncates, so the cast is mandatory. The harness pins it with a case where truncation and rounding differ (net 1,000, q 2, Q 3: 667, not 666).
  - Postgres `round(numeric)` rounds half away from zero. For the non-negative values here that is the same as JavaScript `Math.round` (half up).
- **Last units:** the request that takes the line's last units pays `net − Σ previously approved amounts`, clamped to ≥ 0.
- **The server computes the authoritative amount.** The client's `amountMmk` is kept as `client_amount_mmk` for audit and never used for payout.
  - A v1 request whose client amount is **higher** than the server amount is approved at the **server amount**, with an audit note. This covers RC3 queued requests with gross amounts.
  - Refusing them instead (alternative) would strand RC3 requests. Flag this for G2-a.

### 3.4 Line identity

- **Request v2:** `items: [{saleItemId, qtyUnits}]`, with `qtyUnits` in base units. Amounts are server-computed.
- **v1 stays accepted:** a `productId` that maps to exactly one line resolves to it. A `productId` on several lines is refused with `OX105 REFUND_LINE_AMBIGUOUS` (P0001 fallback per U-01).
  - This replaces today's non-strict `SELECT … INTO` on `(sale_id, product_id)`.
- Request items are validated at **request time** (`create_refund_void_request` v2): the line exists, there is enough quantity remaining, and the request is not empty. Today they are only stored.

### 3.5 Caps

- **Per line:** Σ approved quantity ≤ Q, and Σ approved amount ≤ net.
- **Per sale:** Σ approved ≤ `total_mmk`. Legacy gross approvals count at their stored amounts.
- **Per payment method:** Σ ≤ paid via that method (088).
- **Duplicates:** at most one pending PARTIAL per sale, through a **partial unique index** on `(sale_id) WHERE type='PARTIAL' AND status='REQUESTED'`, which replaces the racy check.

- **Existing duplicate pending requests (review correction).** `CREATE UNIQUE INDEX` fails if the race the index is meant to stop has already happened. 090 therefore starts with a read-only pre-check listing every `sale_id` with more than one `REQUESTED` PARTIAL request (with request ids, creators and amounts) and **aborts** if there is one. Nothing is rejected or merged automatically.
  - Resolution is a separate, owner-approved data step through the normal reject path, so it is audited: keep the oldest and reject the others with reason "duplicate pending request (pre-090)", or the owner chooses.
  - 090 then runs unchanged. The pre-check is also run read-only before the G5 window, so the window is not spent on it.

### 3.6 Sale status (unchanged meaning)

- `sales.status` becomes `REFUNDED` on the first approved refund, **exactly as today**. Leaving it `NORMAL` would let `approve_void_request` void a partially refunded sale (double payout), and RC3 clients rely on it.
- New `sales.refunded_total_mmk integer NOT NULL DEFAULT 0` (backfilled), plus `refund_state` derived in `get_refundable_lines` (`NONE | PARTIAL | FULL`).
- This drops the plan's `status_before_090` backup, because status semantics are unchanged.

### 3.7 Cash attribution

- Refund cash leaves through a `refund_payouts` row and, for cash, a `cash_movements REFUND_OUT` row (089) **in the shift where it is paid out** (`p_shift_id`, an open shift required: `OX106`).
- `close_shift` v2 (089) uses movements only. Legacy refunds before 090 keep the current rule (the original sale's shift) through `LEGACY_*` movements written by the 089 backfill.

### 3.8 Self-approval

- An ADMIN may approve their own refund only with `app_admin_assurance() = aal2` (086) and a reason. Spike U-1 verified that aal2 survives token refresh.
- Every other self-approval stays refused.
- Until G7-a the code path exists, but the owner's TOTP (A8) gates real use.

### 3.9 Approval screen once the server computes payouts (review M3)

- **Until 090 is applied** (Batch 1-code), the Approvals page computes the net amount on the client and **disables Approve** for a request asking more than the customer paid net, typically one raised by an older app version at the pre-discount line total. That is right while the server pays whatever was requested.
- **From 090** the server computes the payout itself (3.3) and approves an old over-amount request at the **server amount**. The client must then stop rejecting such requests on its own arithmetic:
  - A read-only `preview_refund_request(p_request_id)` (or the same data in `get_refundable_lines`) returns the server's payout per line, the total, and the requested amount.
  - The Approvals page shows **"Will pay X MMK (requested Y MMK)"** when they differ, and keeps Approve **enabled**. The approver sees exactly what will be paid.
  - The client switches on server capability (`app_backend_info().schema_version >= 90`, or the preview function existing), not on its own app version. The same build is then correct on both sides of the migration.
  - The client-side excess check stays only as a fallback when the preview cannot be read (offline, error): it then shows the warning **without** blocking, since the server is authoritative.
- **Tests:** an e2e on the disposable stack at 090 approves a legacy gross request and shows the server amount. A unit test checks the capability switch.

## 4. Order and dependencies

- **Prerequisites:** 090 needs 086 (assurance, `app_require_org` kinds), 088 (method caps) and 089 (cash movements).
- **What doesn't change:** 090 changes no `complete_sale` body.
- **Stop point:** G5 can stop after 090 with sales working.

New harness tests:
- **t27b:** at max-migration 090, `complete_sale` (072) with a 20% cart discount, then a refund through the 090 functions. The amount is net, and nothing is NULL-blocked.
- **t27c:** an RC3-shape v1 request with a gross amount is approved at the server amount.
- **t27d:** a v1 request for an ambiguous product is refused with `OX105`.
- **t32 extension:** an RC3 client at 090.
- **t47:** order independence. Unchanged.

## 5. Rollback

- **Forward-only bodies.** Reverting 090's functions to the 070 bodies works because the column is nullable and status semantics are unchanged.
- **Indexes and audit columns** (`client_amount_mmk`, `refunded_total_mmk`) can stay after a revert.
- **PITR to the pre-090 LSN** stays valid until the first post-090 refund.

## 6. Owner decisions this design needs

- **D-07:** the refund revenue date.
- **D-08:** the payout method and ADMIN override.
- **G2-a:** approving gross RC3 amounts at the server amount (3.3), versus refusing them. This also decides the Approvals screen behaviour in 3.9.
- **Before G5:** how existing duplicate pending refund requests are resolved, if the 3.5 pre-check finds any.
