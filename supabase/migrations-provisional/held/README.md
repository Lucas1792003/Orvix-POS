# HELD: PFIN-C (refund cap). Not part of the PFIN-A/B checkpoint

| Id | File | What | Touches 087-guarded tables | Depends on |
|---|---|---|---|---|
| PFIN-C | `PFIN-C_refund_net_paid_cap.sql` (+ `PFIN-C.rollback.sql`) | BEFORE INSERT / UPDATE triggers: an approved partial refund can never exceed what the customer paid after discounts (per product, and per sale) | yes (triggers) | PFIN-B (`fin_sale_line_net`, `fin_items`) |

Tests: `supabase/tests/fin/held/c01_refund_cap.sql` and `c02_under_087.sql`. They run only with
`FIN_WITH_HELD=1 supabase/tests/fin/run.sh`. PFIN-C is applied to the already-populated database after f05. The test
proves that existing over-refunds are not re-checked, and that the PFIN-B rollback refuses while PFIN-C is installed.

The defect, the reason it is a trigger and not an edit of `approve_refund_request` (086 pins that body), the 086
classification of its refusal, and its rollout constraint are all in the header of `PFIN-C_refund_net_paid_cap.sql`.

Open decisions before it can ship:

| # | Decision | What the file does |
|---|---|---|
| P-2 | Per-unit refund pricing (may 1 of 10 units be refunded at more than a tenth of the line?) | enforces only the hard cap: cumulative ≤ net paid per product, Σ ≤ sale total |
| P-6 | When to ship it, and whether it is folded into 090's approve v2. RC3 / 1.0.16 tills ask for pre-cart-discount amounts, so their requests on cart-discounted sales would be refused, and those clients cannot re-enter a lower amount | apply only once every till runs the fin-ui refund math |
