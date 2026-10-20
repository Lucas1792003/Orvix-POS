# Migration 087 verification (disposable resources only)

Runs the real migration (`supabase/migrations/087_recovery_hold.sql`) and its rollback through the real runner
(`deploy/lucashome/apply-migrations.sh`, test mode), together with the real witness authority and gate
(`tools/recovery-authority`).

Everything runs on a disposable loopback stack (`tools/security-audit`, 085 → 086 → 087 with synthetic tenants) and on
throwaway containers named `zz-m087*`. Nothing contacts lucashome, hosted Supabase or any real backup.

```sh
tools/m087-verify/run.sh                     # every part, fresh stack, teardown
tools/m087-verify/run.sh mytag               # results in tools/m087-verify/results/mytag/ (git-ignored)
PARTS="x1" tools/m087-verify/run.sh t        # one part (x2 creates the 087 state that browser/legacy/compat/x3 use)
KEEP=1 ...                                   # leave the stack up
UPSTREAM_ENVOY_DIR=<dir with the pinned upstream lds.template.yaml, envoy.yaml, cds.yaml, docker-entrypoint.sh>
```

| Part | What it checks |
|---|---|
| `x2` | Coverage gate, held install, owner-only approval, tills, legacy closure, multi-tenant isolation, committed hold, HIGH-1, M1–M4, privileges and DDL bypasses, decisions, restart, Envoy 429/CORS, rollback and re-apply. |
| `browser` | Chromium: a 429 is readable through the maintenance listener and the upstream Envoy; a wildcard-CORS negative control. |
| `legacy` | Every client generation's real error handling against the captured 429s. The verbatim legacy source is materialised from git objects at run time and never stored here. |
| `compat` | 086's live SQL suite with 087 installed. One failure is expected and accepted, and only that one: FS.10's cleanup DELETE of a ledger row is refused by 087's ledger protection (M3) after FS.10's assertions pass. |
| `x3` | Restores of the real migration on the real database image. |
| `x1` | Restore matrix on plain PostgreSQL. |
| `archive` | The rolled-back archive allow-list (`archive/archive-allowlist.py`, v87.x): 087 rolled back (≥ 2 real archives, the first with x2's live evidence); each of 51 single deviations (object kinds, owners, table / column / schema / type privileges, grantors, default privileges, triggers, rules, policies, inheritance, publications, outside dependencies, extension membership, forged or incomplete archives, role attributes, other databases) must refuse the re-install naming itself with **nothing applied** (a fingerprint of everything 087 changes is identical before and after); then the archives are unchanged (`archive/inventory.sql`), the re-install commits held, a further rollback and re-install work, and the archived evidence is untouched. Runs last (it leaves 087 re-installed, without x2's lease and tills). Refuses connection strings, any container but `phf-iso-db` on loopback, and pre-existing resources of its own (`zz_m087_*`, extension `tcn`, database `zz_m087_other`); removes only those. |

Requirements: those of `tools/security-audit` and `tools/m086-verify`, plus OpenSSL 3 (Ed25519) and Playwright's Chromium.

Secrets stay in the stack's temp directory and are never printed. JWTs are redacted from logs.

**Cleanup:** the runner removes every container and volume it created, by exact name (`phf-iso-*`, `zz-m087*`), and never
runs a Docker prune.

`sql/test-helpers.sql` contains test-only stand-ins (a release without an epoch change, as 088 will do, and a witness forger).
They are never part of 087; test G4 checks that the migration ships none.
