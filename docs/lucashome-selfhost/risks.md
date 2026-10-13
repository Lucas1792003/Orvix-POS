# lucashome — risks and open decisions

Opened 2026-10-12 from the migration audit and phase reports. Full register: [`../selfhost-migration/03-risk-register.md`](../selfhost-migration/03-risk-register.md).

## Release blockers

### RESOLVED 2026-10-13 (migrations 074–076 applied) — Migrations 074–076 not applied, client already depends on 076
The committed client's `/setup` calls `bootstrap_first_admin()` (076). Applied 2026-10-13 00:48 UTC after owner approval; see [`status.md`](status.md).

### RESOLVED 2026-10-13 (077 applied) — New organizations cannot sell (no price level)
A console-created org has no price level; `complete_sale` (072) looks up the default only within the caller's org → "No active price level available". Found by the live two-org suite 2026-10-12. **Decision:** approve a migration (077) seeding a default price level on org creation, or add it to the console.

### Owner has not yet verified the migrated TOTP factor
Procedure: [`../selfhost-migration/phase-g/owner-totp-verification.md`](../selfhost-migration/phase-g/owner-totp-verification.md). Required before production readiness.

### Single disk, no offsite copy
Every backup is on the same NVMe. Phase F scripts are ready but disabled. **Decision:** owner creates R2 bucket + token, `age` keypair, healthchecks project ([`../../deploy/lucashome/backup/OFFSITE-ENABLE.md`](../../deploy/lucashome/backup/OFFSITE-ENABLE.md)).

### Phone-upload signed URLs live only 60 s (found 2026-10-13) — owner decided 2026-10-13: keep 60 s; investigate a fresh token right before upload instead
**Confirmed live 2026-10-13:** measured token expiry 60 s; an upload at t+50 s succeeded, at t+65 s storage returned `400 InvalidJWT "exp" claim timestamp check failed`. With the current client (token minted once when the desktop modal opens) **phone upload fails whenever the photo is sent more than 60 s after the QR appears** — a real defect. Server already supports re-issuing a token for a live PENDING session (proved live). A client-only fix is prototyped (desktop re-issues every 30 s while PENDING; phone re-reads the token right before transfer) with 14 unit tests — **uncommitted, not yet UI-tested, awaiting owner review**. **Superseded 2026-10-13:** just-in-time issuance through a new Edge Function `phone-upload-token` (no refresh loop, storage stays at 60 s); verified in the real UI at 30/65/120/300 s plus stale-token, double-tap, race, lost-response, expired and cancelled cases. Function not deployed yet; awaiting owner approval. See [`../selfhost-migration/phase-g/phone-upload-jit.md`](../selfhost-migration/phase-g/phone-upload-jit.md).
`UPLOAD_SIGNED_URL_EXPIRATION_TIME` is unset in the storage container (checked read-only: `docker compose exec -T storage printenv …` → unset), so storage-api v1.74 uses its 60 s default. A phone upload started more than a minute after the token is issued fails. Tokens cannot be revoked once issued. **Decision:** set it to 600 (the session length) in `docker-compose.override.yml` (stack config change + storage container recreate — needs approval); trade-off: a leaked token stays usable up to 10 min instead of 1. See [`../selfhost-migration/phase-g/upload-security-and-077.md`](../selfhost-migration/phase-g/upload-security-and-077.md).

### RESOLVED 2026-10-13 (078–079 applied) — Upload security fixes prepared as 078–079, not applied
Org-scoped upload paths, path-based authorization for the 574 legacy objects (no move/rename), tokens only for live own-org sessions, completion URL must match the session path, attach-token rollback fix. Harness 467/0. Client change (org-scoped path builder) is on the branch; either deploy order is safe.

### 17 storage objects nobody but service_role can manage — owner decided 2026-10-13: preserve all; inventory in [`orphan-objects.md`](orphan-objects.md)
16 `temp/` objects with no session row and 1 `products/` object whose product no longer exists (from the hosted snapshot). Not referenced by any product. **Decision:** delete via the Storage API as service_role, or leave.

### Upload completion checks the path suffix, not the host (found 2026-10-13)
079 requires the submitted public URL to end with the session's exact object path, so another session's URL is rejected, but a URL on a different host ending in that path is not. A phone-token holder could make the desktop store an external image URL. Fix options: compare against the server's public URL prefix, or have the desktop build the URL itself from `storagePath`. Not applied. **Confirmed live 2026-10-13:** `https://example.invalid/storage/v1/object/public/product-images/<session path>` was accepted and returned to the desktop poll; completion also does not check that the object exists.

### Upload completion URL: fix prepared as 080, not applied (2026-10-13)
Server derives the public URL from a service-role-only `app_config` row and the session path, ignores the client host, requires the object to exist; harness 519/0. After applying, the `supabase_public_url` row must be set or phone completion is refused (fail-closed). See [`../selfhost-migration/phase-g/migration-080.md`](../selfhost-migration/phase-g/migration-080.md).

### Phone-upload JIT edge function prepared, not deployed (2026-10-13)
`phone-upload-token` signs a fresh 60 s token right before each upload; real-UI uploads at 30/65/120/300 s pass, expired/cancelled refused. Needs deploying into `volumes/functions/` before the new client ships. See [`../selfhost-migration/phase-g/phone-upload-jit.md`](../selfhost-migration/phase-g/phone-upload-jit.md).

## Host and availability

- **Pending reboot since 2026-10-08** (kernel updates); the reboot/persistence test (gate G3) has never run. Needs an approved maintenance window.
- Laptop on Wi-Fi, residential ISP, 3 of 5 boots before 2026-09-02 ended in a crash; no UPS daemon (battery only).
- Firewall state unknown (`ufw.conf ENABLED=no`), sshd on all interfaces, fail2ban absent — hardening list in [`../selfhost-migration/10-go-no-go-checklist.md`](../selfhost-migration/10-go-no-go-checklist.md).
- Stale root-owned listener on `100.95.109.83:443` (old Tailscale IP) — clears on `tailscaled` restart; harmless so far.
- Shares the host with minecraft, open-webui, ollama, a public playit tunnel and a Funnel-exposed app; swap ≈2 GB in steady use.

## Security, lower severity

- Migrated 574 product images have no storage owner → no org can manage them through the API (public reads fine). Fix prepared in 078 (path-based authorization), not applied.
- Uploads are not path-scoped by org (org A can add a file under org B's product folder). Fix prepared in 078–079 + client path builder, not applied.
- Studio reachable by every tailnet device (basic auth only) — restrict via Tailscale ACLs before tills join.
- `attach_product_image_upload_session_token` loses its EXPIRED mark (still rejects) — fixed in 079, not applied. Signed upload tokens are not revocable (storage-api design) — see the 60 s item above.
- RESOLVED 2026-10-13 (076) — two simultaneous first-time setups on a fresh install.

## Decided

- **2026-10-12** — JWT lifetime stays 1 h; offline window 12 h writes / 24 h reads from last authenticated contact (owner).
- **2026-10-12** — `rotate-audit-log` stays off; audit rows retained (owner).
- **2026-10-12** — anon keeps the two phone-upload functions for now (owner; security checks 19/19 passed).
