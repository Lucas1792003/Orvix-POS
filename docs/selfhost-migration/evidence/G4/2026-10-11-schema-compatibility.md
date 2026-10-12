# Evidence · Phase C Step 3 — Auth/Storage schema compatibility (hosted vs self-hosted)

Date: 2026-10-11 22:20 UTC. Method: read-only `information_schema.columns` and migration-table queries on both sides (hosted via `supabase db query --linked`, self-hosted via `psql` in the db container). No data read, no export.

## Inventory

| Side | Auth+storage base tables | Columns | auth.schema_migrations | storage.migrations |
|---|---|---|---|---|
| Hosted (GoTrue v2.195.0 platform build, storage-api v1.71.0) | 35 | 344 | 82 rows, latest `20260831180000` | 73 rows, latest `drop-bucketid-objname-index` |
| Self-hosted (`supabase/gotrue:v2.196.0`, `storage-api:v1.74.0`) | 33 | 331 | 77 rows, latest `20260625000000` | 70 rows, latest `validate-bucket-lifecycle-constraints` |

## Differences

| Kind | Object | Hosted rows today | Effect on restore | Handling |
|---|---|---|---|---|
| table only on hosted | `auth.mfa_recovery_code_sets` | 0 | `COPY` into missing table fails | exclude at dump time (`-x`) and drop in scrubber |
| table only on hosted | `auth.mfa_recovery_codes` | 0 | same | same |
| table only on hosted | `auth.scim_tokens` | 0 | same | same |
| table only on hosted | `auth.scim_users` | 0 | same | same |
| column only on hosted | `auth.one_time_tokens.expires_at` (nullable) | table has 0 rows | `COPY` column list mismatch | table already excluded (`-x auth.one_time_tokens`) |
| tables only on self-hosted | `storage.iceberg_namespaces`, `storage.iceberg_tables` | — | none (not restored) | — |
| common columns | 0 type or nullability mismatches across all common auth/storage tables | — | none | — |
| storage migrations only on hosted | `list-objects-with-versions`, `objects-delete-marker-index`, `drop-bucketid-objname-index` | — | index-only changes; storage rows are not restored (objects re-uploaded through the API) | — |

Hosted auth migrations absent from v2.196.0: `20260821000000`, `20260821010000`,
`20260824000000`, `20260824000001`, `20260831180000` (MFA recovery codes, SCIM,
one_time_tokens.expires_at). **GoTrue v2.197.0 (released, on Docker Hub) ships
exactly these five migrations** (verified from the supabase/auth tag tree: 75
migration files, the five above being the newest). So two valid options exist:

| Option | Parity | Deviation | Risk |
|---|---|---|---|
| A. Stay on v2.196.0, exclude the 4 empty tables + `one_time_tokens` at dump time | all populated tables identical | none from the release tag | none for today's data; recovery-codes/SCIM features unavailable (unused by the app) |
| B. Pin `supabase/gotrue:v2.197.0` in the override | exact schema parity with hosted | one image off the release tag | small: GoTrue runs 5 additional migrations on boot; not tested as part of `self-hosted/v0.8.2` |

Recommendation: **A** now (least customisation, tested set); revisit B when the
next upstream self-hosted release includes v2.197+.

## Decision

**Compatibility is established for this project's data.** Every table that
holds rows on hosted (`auth.users`, `identities`, `mfa_factors`,
`mfa_amr_claims`, `sessions`, `refresh_tokens`, plus empty-but-present tables)
exists on the self-hosted side with identical columns. The hosted-only objects
are all empty and are excluded from the dump; nothing is lost.

Stay on the pinned release (`self-hosted/v0.8.2`, GoTrue v2.196.0) rather than
bumping GoTrue alone: the stack's release tag is tested as a set, the app uses
none of the newer features (recovery codes, SCIM), and a newer GoTrue would run
its own migrations on first boot anyway. Re-evaluate at the next upstream
self-hosted release.

Rule for the export (runbook §3.2): add
`-x auth.mfa_recovery_code_sets -x auth.mfa_recovery_codes -x auth.scim_tokens -x auth.scim_users`
to the existing exclusions, and run `schema_compat.py` against the actual dump
before restore as a second gate.
