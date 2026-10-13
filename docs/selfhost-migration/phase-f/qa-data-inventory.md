# Pre-release QA-data inventory (read-only, 2026-10-13)

Private. Source: read-only SQL on the self-hosted database at schema 081 (`scratchpad/qa-audit*.sql`), after the last e2e cleanup reported CLEAN. **Nothing was deleted.** Every "candidate" below needs an explicit owner decision before any removal (owner rule: preserve real migrated business data and audit history).

## 1. QA tenant from automated tests — none left
| Marker | Rows |
|---|---|
| organizations `org-qa*` | 0 |
| auth users `@qa.invalid` | 0 |
| auth audit entries mentioning `@qa.invalid` | 0 |
| storage objects under QA paths | 0 |
| sales / sale_items / refunds / shifts / purchase orders / supplier payments / stock transfers / reprint logs / idempotency keys | 0 each |
| expenses | no expenses table exists in the schema (the app has no expense feature) |

## 2. Real migrated business data — keep
| Data | Rows | Note |
|---|---|---|
| organization / shop / business profile | 1 / 1 / 1 | `org-shwe-pha-lar` |
| products / units / unit prices | 539 / 931 / 956 | no product name matches test patterns |
| brands / categories / suppliers | 176 / 23 / 4 | supplier names are real trading names; no test-like names |
| price levels | 3 | |
| storage objects | 574 (incl. 17 orphans) | verified 574/574 |
| completed upload sessions | 556 | history behind product images |
| ADMIN app user | 1 | owner, 2 verified TOTP factors |
| audit_logs | 81 | 60 product creates, 16 product edits, 1 category create, 2 supplier payments, 1 shift opened, 1 shift closed (2026-07-03 … 2026-08-25). Keep: audit history. The shift/payment records they describe no longer exist (removed on hosted before the export). 2 entries have an actor that no longer exists |

## 3. Candidates for owner review (synthetic or stale) — not deleted
| # | Data | Rows | Evidence | Suggested action (needs approval) |
|---|---|---|---|---|
| C1 | inventory_movements, all `ADJUSTMENT`, 2026-06-10 09:01–10:18 UTC, products "sunday coffee" ×3 and "premier 3in1" ×2 | 5 | 2 have reason `Testing`; all within one hour on the first setup day; current inventory is **0 units in all 18 rows**, so these movements no longer describe stock | delete the 5 rows **or** keep as history; if real stock is entered later, start from a clean count |
| C2 | auth users with **no app user row** | 7 | created 2026-06-10 … 2026-08-25; email domains: `shwephala.com` ×2, `shwephalar.com` ×1, `gmail.com` ×3, `gmaill.com` ×1 (typo domain); none has MFA; one last signed in 2026-08-24, the rest only on their creation day. They can authenticate but have no app role, so RLS gives them nothing | owner identifies each (list by email privately in Studio or SQL); delete leftovers via GoTrue admin API after approval |
| C3 | CASHIER and MANAGER app users (`shwephalar.com`) | 2 | created 2026-06-10, last sign-in 2026-06-10 / 2026-06-12 | owner confirms whether these are real staff logins or setup tests; if tests: deactivate rather than delete (audit references) |
| C4 | admin_login_codes (emailed 2FA codes) | 15 | all expired, newest 2026-06-15; ephemeral | safe to purge (no history value) |
| C5 | upload sessions not completed | 22 | 20 CANCELED, 1 EXPIRED, 1 PENDING (2026-08-17, long expired) | optional housekeeping; harmless to keep |

## 4. Before release
1. Owner reviews C1–C5 and approves a precise delete list (by id).
2. Fresh verified base backup + LSN, then delete in one transaction, then re-run this inventory and the fingerprint (business tables other than the approved rows must be unchanged; storage 574/574).
3. Re-run `npm run e2e:cleanup` → CLEAN after the last QA run before the release build.
