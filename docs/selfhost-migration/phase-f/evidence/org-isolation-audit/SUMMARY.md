# Org-isolation security audit — summary

Generated 2026-10-16T05:15:12.719Z · results dir `/Users/waiyan/Projects/personal/ShwePhaLa/.claude/worktrees/agent-a6c2ff2a83ac4f14d/tools/security-audit/results/20261016T051406Z`

Schema parity (live 081 vs disposable 081): run (see parity/ and each m*/parity.txt)

## Migration 81

Coverage gate: **PASS** — 119/119 items mapped, 0 hard gaps (org-scoped tables 30, storage policies 4, API functions 69, service-role definer 9, edge functions 6).

| area | PASS | FAIL | GAP | SKIP | INFO |
|---|--:|--:|--:|--:|--:|
| seed | 1 | 0 | 0 | 0 | 0 |
| tables | 212 | 0 | 0 | 0 | 0 |
| rpcs | 36 | 0 | 0 | 0 | 0 |
| storage | 18 | 0 | 0 | 0 | 3 |
| phone | 10 | 0 | 0 | 0 | 0 |
| functions | 28 | 0 | 0 | 0 | 2 |
| authlink | 1 | 0 | 4 | 0 | 0 |
| authz | 49 | 0 | 0 | 0 | 0 |
| helpers | 34 | 0 | 0 | 0 | 2 |
| errors | 1 | 0 | 0 | 0 | 0 |
| **total** | **390** | **0** | **4** | **0** | **7** |

### Gaps at 81

- **[critical]** create_app_user cannot link an orphan auth account — at migration 81: linking SUCCEEDED (gap) (status 200)
- **[critical]** create_app_user cannot link a platform admin's login account — at migration 81: linking SUCCEEDED (gap) (status 200)
- **[critical]** direct users INSERT cannot set auth_id (client) — at migration 81: insert SET auth_id (gap) (status 201)
- **[critical]** direct users UPDATE cannot change auth_id (client) — at migration 81: update CHANGED auth_id (gap) (status 200)

## Migration 82

Coverage gate: **PASS** — 119/119 items mapped, 0 hard gaps (org-scoped tables 30, storage policies 4, API functions 69, service-role definer 9, edge functions 6).

| area | PASS | FAIL | GAP | SKIP | INFO |
|---|--:|--:|--:|--:|--:|
| seed | 1 | 0 | 0 | 0 | 0 |
| tables | 212 | 0 | 0 | 0 | 0 |
| rpcs | 36 | 0 | 0 | 0 | 0 |
| storage | 18 | 0 | 0 | 0 | 3 |
| phone | 10 | 0 | 0 | 0 | 0 |
| functions | 28 | 0 | 0 | 0 | 2 |
| authlink | 6 | 0 | 0 | 0 | 0 |
| authz | 49 | 0 | 0 | 0 | 0 |
| helpers | 34 | 0 | 0 | 0 | 2 |
| errors | 1 | 0 | 0 | 0 | 0 |
| **total** | **395** | **0** | **0** | **0** | **7** |

## What the top migration closes

- create_app_user cannot link an orphan auth account: 81 = GAP → 82 = PASS
- create_app_user cannot link a platform admin's login account: 81 = GAP → 82 = PASS
- direct users INSERT cannot set auth_id (client): 81 = GAP → 82 = PASS
- direct users UPDATE cannot change auth_id (client): 81 = GAP → 82 = PASS

