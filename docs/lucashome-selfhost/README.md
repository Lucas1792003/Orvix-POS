# lucashome — self-hosted Supabase backend

Self-hosted Supabase (`supabase/supabase` tag `self-hosted/v0.8.2`, commit `564eab8a`) on the home server `lucashome`, serving the POS over Tailscale only. Intended production backend once the release gates in [`roadmap.md`](roadmap.md) pass; hosted ([`../hosted-supabase/`](../hosted-supabase/)) is the fallback.

| File | Answers |
|---|---|
| [`status.md`](status.md) | What is running, schema version, data counts, backup state — verified |
| [`access.md`](access.md) | How to reach the box, the stack, the database, Studio; where secrets live |
| [`incidents.md`](incidents.md) | Breakages and near-misses on this stack |
| [`risks.md`](risks.md) | Open exposure and owner decisions |
| [`roadmap.md`](roadmap.md) | Migration phases done and what is next |

Engineering detail (plan, runbook, evidence per gate) lives in the repo: [`../selfhost-migration/MIGRATION-PLAN.md`](../selfhost-migration/MIGRATION-PLAN.md) and [`../selfhost-migration/evidence/`](../selfhost-migration/evidence/). Deployment manifest: [`../../deploy/lucashome/README.md`](../../deploy/lucashome/README.md).
