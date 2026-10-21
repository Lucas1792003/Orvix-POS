# Review: PostgreSQL security and tenant isolation (correction pass)

Date: 2026-10-21. Four independent rounds were run, each by a fresh reviewer, on private throwaway clusters. Final verdict: **conditional GO (round 4)**. Its conditions were six doc statements and one install bypass, and all were met (see round 4). No CRITICAL or HIGH finding is open.

## Round 1: NO-GO
- **H1.** Migration 087 applied after V1 ran unrestricted. 087 disables every event trigger before it runs, so V1's DDL event trigger could not stop it.
- **H2.** The install acknowledgement worked only inside one transaction. A plain `psql -f` created almost everything, and session- or database-level settings satisfied it.
- **H3.** The resolver missed cross-organization references: several `*_by` columns, `product_costs.product_id`, `audit_logs.entity_id`, and refund item JSON.
- **MEDIUM.**
  - Dangling references let rows be re-linked later.
  - Unauthenticated, unbounded writes to the immutable audit were possible.
  - Onboarding closes and errors are masked while V1 is installed.

**Fixes:**
- A runtime `integrity_problem()` check runs on every guarded write and status read; the real 087 is proven incompatible in the harness.
- The installer is psql-driven and transactional.
- `*_by` columns are resolved generically, and entity and item resolution was added.
- Dangling references and row identity changes are refused.
- An app user is required before any audit write, and inputs are capped.

## Round 2: NO-GO
- **HIGH.** The dangling rule broke product and unit creation once PCOST-A is installed, because PCOST-A writes cost rows before their parent.
- **MEDIUM.** A client that ignores psql meta-commands could still create objects without the acknowledgement.
- **MEDIUM.** Authenticated users could flood the audit, and the applied path was not capped.
- **LOW.** Some audit entity types and supplier-payment references were unresolved, and a performance cost was measured.

**Fixes:**
- PCOST-A parent ids are exempt from the dangling check (their `org_id` is still checked), with positive tests for creating a product and a unit with a cost.
- `BEGIN` is now the first statement.
- A rate limit was added and the applied path is capped.
- More entity and reference types are resolved.
- Limits and performance are documented.

## Round 3: NO-GO
- **HIGH.** The exemption reopened a single-transaction forward-reference relink: a cost row written first for a future id, then the parent created in another ACTIVE organization.
- **MEDIUM.** A client running each statement on its own connection could install partially.
- **MEDIUM.** Damaged journal records were dropped from the export.
- **LOW.** One user could use up another's transition quota.

**Fixes:**
- A parent now also resolves the organizations of existing cost rows that name it.
- The whole install runs as one call of a session-temporary function.
- The transition quota is per user, with an index.
- Damaged journal records are exported as markers.

## Round 4: conditional GO
- **CLOSED.**
  - Single-transaction forward references in every direction.
  - The transition quota.
  - Install equivalence: the catalog snapshot of the function-based install matches direct statements.
  - Normal creation with a cost works.
- **PARTIAL (LOW).** A stored acknowledgement setting could satisfy the install check. Closed after the review: the acknowledgement is now the installer function's argument, and the harness re-ran green with all four install-refusal cases.
- **New LOW items, documented as known limits in `tools/recovery-v1/db/README.md`:**
  - **N1:** a two-session cost-row race (needs the other organization's random id).
  - **N2:** stale unit-cost product ids.
  - Transition quota overshoot under concurrency.
  - Some vanished or unattributed journal rows are dropped without a marker.
  - Only the top-level `orgId` is checked on damaged journal rows.
- **Six doc statements corrected:**
  - the SQL header's "can never satisfy";
  - the README's cost forward-reference claim;
  - the README's quota overshoot wording;
  - the device-witness doc's journal export claims;
  - the adapter test count (8/8);
  - the phase-d totals (450 vs 446 checks).

## Final harness results
| Configuration | Result |
|---|---|
| Stage 085 | 102/0 |
| Stage 086 | 102/0 |
| Stage 086 + PFIN-A/B, PCOST-A, PSAFE-A | 115/0 |

All three refuse the install in all four no-acknowledgement cases. At stage 086, the real 087 is incompatible (every guarded write refused, status QUARANTINED). In the phase-d regression, every guarded-only difference is still a refusal: 428 pass / 18 fail guarded against 445 / 5 unguarded.
