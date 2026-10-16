# lucashome — risks and open decisions

Opened 2026-10-12 from the migration audit and phase reports. Full register: [`../selfhost-migration/03-risk-register.md`](../selfhost-migration/03-risk-register.md). Owner/approval items with state and evidence: [`../selfhost-migration/phase-f/production-readiness-checklist.md`](../selfhost-migration/phase-f/production-readiness-checklist.md) (the master list since 2026-10-15).

## Open, added 2026-10-13 … 2026-10-16

### Remote access for the shops is not compliant yet (checklist C1–C3)
Tailscale Personal is non-commercial only, and tills/phones in Myanmar would need a VPN app; there is no domain. Options: paid Tailscale, a ~$10–15/yr domain + Cloudflare Tunnel (public API → needs Studio isolation and hardening first, rule C4), or per-shop LAN server. **Decision: owner.** [`../selfhost-migration/phase-f/remote-access-architecture.md`](../selfhost-migration/phase-f/remote-access-architecture.md), [`free-tier-compliance.md`](../selfhost-migration/phase-f/free-tier-compliance.md).

### Studio on the same origin as the API and phone page (A6d)
Basic auth only (verified 401 without it, 2026-10-16). Isolation prepared and tested locally (58/0), not applied: [`studio-isolation.md`](../selfhost-migration/phase-f/studio-isolation.md). Must be closed before any public/tunnel exposure.

### Desktop uploads are not byte-validated until 084 (low; audit G5 residual, 2 low GAPs at 083/085)
Staff can still write to `product-images` directly (type/size limited by the 083 bucket rule, bytes unchecked). Fix: migration 084 (prepared) — **only after every till runs the validated-upload client**, otherwise old clients lose image upload. [`g5-followups.md`](../selfhost-migration/phase-f/g5-followups.md).

### Abandoned phone uploads stay public until the sweep is scheduled (low)
An object for a session that never completed (phone closed, expired/cancelled) stays at `org/<org>/temp/<session>`. Since 085's function build, RPC refusals delete their object; the dry run of 2026-10-16 found 0 candidates. Sweep prepared, not scheduled (g5-followups.md §2.5).

### 7 auth accounts with no app user (A7)
Created 2026-06-10…08-25; they can sign in but get nothing from RLS, and since 082 can never be linked. **Decision: owner** keeps or deletes ([`qa-data-inventory.md` C2](../selfhost-migration/phase-f/qa-data-inventory.md)).

### No version handshake between client and backend (A9)
A client cannot detect a wrong/older backend before writing. Proposal `app_backend_info()` in [`electron-compatibility.md`](../selfhost-migration/phase-f/electron-compatibility.md) §5 (it was labelled "proposed 083"; that number is now taken by G5). **Decision: owner.**

### RESOLVED 2026-10-16 (082 applied) — admin could link any auth account (audit gaps G1–G4, critical)
`create_app_user` with an arbitrary `p_auth_id` and direct `users.auth_id` writes. Closed by 082 (audit 395/0/0) — [G9](../selfhost-migration/evidence/G9/2026-10-16-migration-082.md).

### RESOLVED 2026-10-16 (083 + 085 applied) — public image bucket accepted any type and size (audit G5, medium)
083: bucket JPEG/PNG/WebP ≤ 5 MiB, validated phone completion, completion RPC service-role only, nosniff/CSP-sandbox/inline headers on public reads ([G10](../selfhost-migration/evidence/G10/2026-10-16-migration-083-headers.md)). 085: PNG accepted consistently and refused uploads deleted ([`migration-085-png.md`](../selfhost-migration/phase-f/migration-085-png.md)). Residual: the desktop item above.

## Release blockers

### RESOLVED 2026-10-13 (migrations 074–076 applied) — Migrations 074–076 not applied, client already depends on 076
The committed client's `/setup` calls `bootstrap_first_admin()` (076). Applied 2026-10-13 00:48 UTC after owner approval; see [`status.md`](status.md).

### RESOLVED 2026-10-13 (077 applied) — New organizations cannot sell (no price level)
A console-created org has no price level; `complete_sale` (072) looks up the default only within the caller's org → "No active price level available". Found by the live two-org suite 2026-10-12. **Decision:** approve a migration (077) seeding a default price level on org creation, or add it to the console.

### Owner has not yet verified the migrated TOTP factor
Procedure: [`../selfhost-migration/phase-g/owner-totp-verification.md`](../selfhost-migration/phase-g/owner-totp-verification.md). Required before production readiness. Still open 2026-10-16 (checklist A8; current procedure [`../selfhost-migration/next-phase/owner-totp-test.md`](../selfhost-migration/next-phase/owner-totp-test.md)).

### Single disk, no offsite copy
Every backup is on the same NVMe. Phase F scripts are ready but disabled. **Decision:** owner creates R2 bucket + token, `age` keypair, healthchecks project ([`../../deploy/lucashome/backup/OFFSITE-ENABLE.md`](../../deploy/lucashome/backup/OFFSITE-ENABLE.md)). **Superseded 2026-10-13:** owner chose the email tier; installed disabled 2026-10-13 18:46 UTC, still waiting on the owner's backup key and Google sender setup ([`owner-setup-checklist.md`](../selfhost-migration/phase-f/owner-setup-checklist.md); checklist B3–B8). Still open as of 2026-10-16.

### RESOLVED 2026-10-13 (`phone-upload-token` JIT deployed, G5) — Phone-upload signed URLs live only 60 s (found 2026-10-13) — owner decided 2026-10-13: keep 60 s; investigate a fresh token right before upload instead
**Confirmed live 2026-10-13:** measured token expiry 60 s; an upload at t+50 s succeeded, at t+65 s storage returned `400 InvalidJWT "exp" claim timestamp check failed`. With the current client (token minted once when the desktop modal opens) **phone upload fails whenever the photo is sent more than 60 s after the QR appears** — a real defect. Server already supports re-issuing a token for a live PENDING session (proved live). A client-only fix is prototyped (desktop re-issues every 30 s while PENDING; phone re-reads the token right before transfer) with 14 unit tests — **uncommitted, not yet UI-tested, awaiting owner review**. **Superseded 2026-10-13:** just-in-time issuance through a new Edge Function `phone-upload-token` (no refresh loop, storage stays at 60 s); verified in the real UI at 30/65/120/300 s plus stale-token, double-tap, race, lost-response, expired and cancelled cases. Function not deployed yet; awaiting owner approval. See [`../selfhost-migration/phase-g/phone-upload-jit.md`](../selfhost-migration/phase-g/phone-upload-jit.md).
`UPLOAD_SIGNED_URL_EXPIRATION_TIME` is unset in the storage container (checked read-only: `docker compose exec -T storage printenv …` → unset), so storage-api v1.74 uses its 60 s default. A phone upload started more than a minute after the token is issued fails. Tokens cannot be revoked once issued. **Decision:** set it to 600 (the session length) in `docker-compose.override.yml` (stack config change + storage container recreate — needs approval); trade-off: a leaked token stays usable up to 10 min instead of 1. See [`../selfhost-migration/phase-g/upload-security-and-077.md`](../selfhost-migration/phase-g/upload-security-and-077.md).

### RESOLVED 2026-10-13 (078–079 applied) — Upload security fixes prepared as 078–079, not applied
Org-scoped upload paths, path-based authorization for the 574 legacy objects (no move/rename), tokens only for live own-org sessions, completion URL must match the session path, attach-token rollback fix. Harness 467/0. Client change (org-scoped path builder) is on the branch; either deploy order is safe.

### 17 storage objects nobody but service_role can manage — owner decided 2026-10-13: preserve all; inventory in [`orphan-objects.md`](orphan-objects.md)
16 `temp/` objects with no session row and 1 `products/` object whose product no longer exists (from the hosted snapshot). Not referenced by any product. **Decision:** delete via the Storage API as service_role, or leave. 2026-10-16: the abandoned-upload sweep is built never to touch them (path pattern + allow-list of all 574 migrated names).

### RESOLVED 2026-10-13 (080 applied) — Upload completion checks the path suffix, not the host (found 2026-10-13)
079 requires the submitted public URL to end with the session's exact object path, so another session's URL is rejected, but a URL on a different host ending in that path is not. A phone-token holder could make the desktop store an external image URL. Fix options: compare against the server's public URL prefix, or have the desktop build the URL itself from `storagePath`. Not applied. **Confirmed live 2026-10-13:** `https://example.invalid/storage/v1/object/public/product-images/<session path>` was accepted and returned to the desktop poll; completion also does not check that the object exists.

### RESOLVED 2026-10-13 04:09 UTC (080 applied, `app_config` row set) — Upload completion URL: fix prepared as 080, not applied (2026-10-13)
Server derives the public URL from a service-role-only `app_config` row and the session path, ignores the client host, requires the object to exist; harness 519/0. After applying, the `supabase_public_url` row must be set or phone completion is refused (fail-closed). See [`../selfhost-migration/phase-g/migration-080.md`](../selfhost-migration/phase-g/migration-080.md).

### RESOLVED 2026-10-13 (deployed, G5) — Phone-upload JIT edge function prepared, not deployed (2026-10-13)
`phone-upload-token` signs a fresh 60 s token right before each upload; real-UI uploads at 30/65/120/300 s pass, expired/cancelled refused. Needs deploying into `volumes/functions/` before the new client ships. See [`../selfhost-migration/phase-g/phone-upload-jit.md`](../selfhost-migration/phase-g/phone-upload-jit.md).

## Host and availability

- **Pending reboot since 2026-10-08** (kernel updates); the reboot/persistence test (gate G3) has never run. Needs an approved maintenance window.
- Laptop on Wi-Fi, residential ISP, 3 of 5 boots before 2026-09-02 ended in a crash; no UPS daemon (battery only).
- Firewall state unknown (`ufw.conf ENABLED=no`), sshd on all interfaces, fail2ban absent — hardening list in [`../selfhost-migration/10-go-no-go-checklist.md`](../selfhost-migration/10-go-no-go-checklist.md). 2026-10-13: staged procedure with dead-man rollbacks and a recovery gate (Gate R: console login + second SSH key) prepared, nothing executed — [`host-hardening-staged.md`](../selfhost-migration/phase-f/host-hardening-staged.md); still open 2026-10-16.
- Stale root-owned listener on `100.95.109.83:443` (old Tailscale IP) — clears on `tailscaled` restart; harmless so far.
- Shares the host with minecraft, open-webui, ollama, a public playit tunnel and a Funnel-exposed app; swap ≈2 GB in steady use.

## Security, lower severity

- RESOLVED 2026-10-13 (078 applied) — Migrated 574 product images have no storage owner → no org can manage them through the API (public reads fine).
- RESOLVED 2026-10-13 (078–079 applied) — Uploads are not path-scoped by org (org A can add a file under org B's product folder).
- Studio reachable by every tailnet device (basic auth only) — restrict via Tailscale ACLs before tills join. See the Studio item at the top (2026-10-16).
- RESOLVED 2026-10-13 (079 applied) — `attach_product_image_upload_session_token` loses its EXPIRED mark (still rejects). Still true: signed upload tokens are not revocable (storage-api design) — mitigated by JIT 60 s tokens.
- RESOLVED 2026-10-13 (076) — two simultaneous first-time setups on a fresh install.

## Decided

- **2026-10-12** — JWT lifetime stays 1 h; offline window 12 h writes / 24 h reads from last authenticated contact (owner).
- **2026-10-12** — `rotate-audit-log` stays off; audit rows retained (owner).
- **2026-10-12** — anon keeps the two phone-upload functions for now (owner; security checks 19/19 passed). Superseded 2026-10-16: since 083 anon executes only `app_setup_needed` and `get_product_image_upload_session_by_token`; completion runs as service role inside `phone-upload-token`.
- **2026-10-13** — offsite channel = email (Gmail API send-only), no domain, owner does the key + Google setup; no public exposure (owner, G8).
- **2026-10-16** — 084 held back until all tills run the validated-upload client; 085 applied without it (rollout order in g5-followups.md §4; 085 is independent of 084, migration-085-png.md §5).
