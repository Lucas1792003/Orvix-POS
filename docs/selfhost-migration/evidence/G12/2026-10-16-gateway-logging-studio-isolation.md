# G12 — Gateway access-log fix + Studio isolation (2026-10-16, 10:30–10:40 UTC)

Private evidence. Owner approval: "controlled deployment of the gateway logging fix together with Studio isolation".

## Before
| Check | Result |
|---|---|
| Live file hashes | `lds.template.yaml` `a635a7aa` (= tested), `docker-compose.override.yml` `f3d56b05` (upstream Studio block) |
| Backups | `~/maint-20261016-gw/` (0700): `docker-compose.override.yml.before` `f3d56b05`, `lds.template.yaml.before-UNSAFE-query-logging-DO-NOT-RESTORE` `a635a7aa`, `lds.minimal-log.yaml` `e1f64a0c`, `SHA256SUMS`; plus the script's own `lds.template.yaml.pre-studio-isolation.20261016T103646Z` (`e1f64a0c`, minimal logging) |
| Existing gateway log (counts only; nothing copied) | container since 2026-10-16 06:37 UTC; json-file 20 MB × 5; readable by root/docker group only; 20,873 access lines; 204 with `?token=` (60 s signed upload tokens), 89 with `?apikey=` (public anon key, realtime), 27 with e-mail filter values, 0 with `access_token=`. Discarded with the old container at the controlled restart |
| Rehearsal | staged combined file `e6b1414e` (minimal log + Studio isolation) validated on a temporary gateway (127.0.0.1:18001): 25/25; test gateway removed |

## Apply
1. `envoy_access_log_minimal.py apply` → live template `e1f64a0c` (in place; no restart).
2. `studio-isolation.sh apply --yes` → template `e6b1414e`, override `35fc5129` (Studio `127.0.0.1:54323:3000`); Studio recreated, then `api-gw` recreated; built-in verify **28/28**.

## After (from the Mac over the tailnet, and on the server)
| Check | Result |
|---|---|
| Health | 10/10 healthy |
| Studio on the shared origin | `/`, `/project/default`, `/api/platform/profile`, `/api/platform/pg-meta/default/tables`, `/api/v1/projects`, `/dashboard` → **404, no auth challenge** |
| Studio admin route | listener only `127.0.0.1:54323`; via `ssh -N -L 127.0.0.1:54323:127.0.0.1:54323 lucashome` → 307 (Studio's normal redirect); `http://<tailnet name>:54323/` → unreachable (000) |
| POS routes | rest/auth admin/staff-admin/phone-upload-token without auth → 401; anon REST read 200; auth health 200; public signup 422; `functions-router.sh verify` **45/45** |
| Phone uploads / images | phone page 200 `text/html`; public image 200 with nosniff, CSP sandbox, inline; signed URL issued + downloaded 200 |
| New log format | probe `…/logprobe.webp?token=<marker>&email=eq.<marker>` logged as 1 line with **no query string**; 0 `?token=` lines since restart; `verify-till-readiness.sh` parses the new format (620 records; coverage starts now) |
| Data | business fingerprint identical to post-085; 574/574 images |
| Backup | base `20261016T103855Z` verified; recovery point `5/3A000090` (`post-gateway-studio-maint`); backup-status OK |

## Revert (tested on a copy, not executed)
`~/studio-isolation/studio-isolation.sh revert --yes` restores the upstream Studio routes and removes the loopback port **while keeping the minimal log format**: `studio_isolation.py revert` on the live file → `e1f64a0c` (minimal). The only copy with the old query-logging format is named `…before-UNSAFE-query-logging-DO-NOT-RESTORE`; restoring the old log format needs a separate owner decision.
