# G11 — Migration 085 (PNG completion) + scoped delete-on-refusal (2026-10-16)

Private evidence. Owner approval: Option A ("support valid PNG uploads consistently"), deploy 085 under the established procedure; 084 stays undeployed until all tills are upgraded.

## Before
| Check | Result |
|---|---|
| Schema | 083 |
| Backups | base `20261016T075002Z` verified; recovery point `5/13000090` (`pre-085`); WAL failed=0 |
| Data | fingerprint identical to right after 083 |
| Local suites (merged tree) | harness 747/0; harness capped 083 672/0; Deno 94; vitest 972; tsc clean |
| Audit modelling production (083 + 085, **084 skipped** via `PHF_ISO_SKIP_MIGRATIONS=84`, new runner option) | 454 PASS / 0 FAIL / 2 low GAP (desktop byte check, closed by 084); 4 storage policies as production |
| Sweep dry run (production, read-only, script run from a temp dir, not installed) | 574 objects, **0 candidates, 0 to delete**; all 17 `temp/` objects are legacy-format historical files (16 without a session, 1 CANCELED 2026-06-13), kept by path pattern + 574-name allow-list |

## Deploy (UTC)
| Step | Result |
|---|---|
| 07:51 function first | previous copies in `~/fn-pre-085`; `phone-upload-token` + `phone-upload-page` rsynced (tree hash `df017358…` both sides); functions restarted, healthy, no boot errors; `functions-router.sh verify` 45/45; bad-token `complete` → 404 generic |
| 07:51 dry run | 085 on a throwaway restore of the fresh base: guard "current completion body is the 080 body"; "sessions/objects unchanged (557/574)"; fingerprint and user links identical |
| 07:52 migration 085 | `apply-migrations.sh --from 085 --to 085` (dry-run first); recovery point `5/15000058`; same NOTICEs; ledger 84 rows, max 085 (084 absent by design); anon executes 2 functions; 30 keyed RPCs |

## After
| Check | Result |
|---|---|
| Integrity | fingerprint differs only in migration history (83→84 rows, max 085); users/links, products, inventory, audit, auth, 574 objects + 17 orphans identical; `verify_objects` 574/574 |
| Audit at 085 (084 skipped) with production parity | **PARITY 085 PASS**; coverage 120/120; 454 PASS / 0 FAIL / 2 low GAP |
| Live suites | phase-f-staff 9/9, **phase-g4 15/15 + 1 skip** (PNG, malicious content, oversize, retries, concurrent completion, cross-org), phase-d 16/16, org-isolation 12/12, g2 4/4, g3 9/9 — all CLEAN |
| e2e full (deployed function + page) | **49 passed, 1 skipped** (the 084-only desktop case), 25.2 min; cleanup CLEAN |
| After all tests | fingerprint identical to right after 085 (tests left nothing) |
| Post backup | base `20261016T082808Z` verified; recovery point `5/1E000058` (`post-085`); backup-status OK; 10/10 healthy |

No unexpected data change, authorization failure or unresolved regression.
