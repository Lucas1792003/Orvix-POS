# Production-readiness checklist — Shwe Pha Lar POS on the self-hosted backend

Private. Created 2026-10-15, updated 2026-10-16. One list; every item has an owner, a state and the evidence that closes it. **Nothing on this list is executed by the engineer without the owner's explicit approval for that item.** Supersedes the ordering in [`../next-phase/release-checklist.md`](../next-phase/release-checklist.md) where they differ; that file keeps the detailed release mechanics (version, rollback build, pre-release, promotion).

States: **DONE** (verified, evidence linked) · **READY** (prepared and tested, waiting for approval) · **OWNER** (needs the owner's own action) · **OPEN** (work or decision outstanding).

## A. Backend state (server)
| # | Item | State | Evidence |
|---|---|---|---|
| A1 | Schema 081 live; hosted data restored; 574 images + 17 orphans verified | DONE | [G7](../evidence/G7/2026-10-13-081-and-email-install.md), [G8](../evidence/G8/2026-10-13-staff-qr-signup.md) |
| A2 | Public sign-up closed (`DISABLE_SIGNUP=true`), staff created server-side (`staff-admin`) | DONE | G8; live suite phase-f-staff 9/9 |
| A3 | Phone page on the backend origin + router allow-list, upgrade-safe (`functions-router.sh status/apply/verify`) | DONE | G8; [phone-qr-origin.md §6](phone-qr-origin.md); live verify 45/45 |
| A4 | Obsolete `rotate-audit-log` / `weekly-sales-report` removed; no cron | DONE | status.md |
| A5 | QA cleanup (exact approved rows) | DONE | [qa-cleanup-manifest.md §7](qa-cleanup-manifest.md) |
| A6 | Migration 082 (close admin auth-link path) + marker-writing `staff-admin` | DONE 2026-10-16 05:31 UTC | [G9](../evidence/G9/2026-10-16-migration-082.md); audit at 082 395/0/0, parity 1872/1872 |
| A6b | Org-isolation security audit (disposable stack, schema parity with production) | DONE 2026-10-16: 081 = 390 PASS / 0 FAIL / 4 GAP (G1–G4 admin auth-linking, closed by 082); 082 = 395 / 0 / 0; coverage gate 119/119; parity 1870/1870 | [org-isolation-security-audit.md](org-isolation-security-audit.md) |
| A6c | G5 migration 083 (image bucket: JPEG/PNG/WebP, 5 MiB; validated phone completion with magic-byte + markup check; completion RPC service-role only) | READY — needs separate deployment approval; order: phone-upload-token → phone-upload-page → restart functions → 083; update `src/live` suites that call completion as anon first | [migration-083-g5.md](migration-083-g5.md); harness 672/0, audit at 083 0 FAIL with 2 low GAPs (desktop byte check) |
| A6d | Studio is served on the same tailnet origin as the API and phone page (HTTP basic auth). Must be removed from or blocked on any public/tunnel origin; consider moving it off the shared origin and the optional storage response-header rule | OPEN — decision | read-only probe 2026-10-16: `/`, `/project/default` → 401 Basic |
| A6e | Follow-ups from G5: desktop uploads through the validated flow (then drop staff direct-write), sweep abandoned phone uploads | OPEN | migration-083-g5.md |
| A7 | Review 7 orphan auth accounts (no app user; can never be linked after 082) — keep or delete | OWNER | [qa-data-inventory.md C2](qa-data-inventory.md), migration-082.md |
| A8 | Owner's own migrated TOTP factor tested on the self-hosted backend | OWNER | [owner-totp-test.md](../next-phase/owner-totp-test.md) |
| A9 | Version handshake `app_backend_info()` (proposed 083) so a client refuses writes on a wrong/older backend | OPEN — decision | [electron-compatibility.md](electron-compatibility.md) |

## B. Encrypted off-server backup and restoration
| # | Item | State | Evidence |
|---|---|---|---|
| B1 | Local tier: hourly dumps, daily verified base, WAL archiving, weekly restore test, PITR drill | DONE | backup-status OK; G6 DR drill 123/0 |
| B2 | Email tier (Gmail API, `gmail.send` only) installed **disabled** | DONE | G8; suite 340/0 |
| B3 | Owner key generated on the Mac; password-manager copy and paper copy each proven with `--verify-copy` | OWNER | [owner-setup-checklist.md Part 1](owner-setup-checklist.md) |
| B4 | Sender + backup Gmail accounts, Cloud app "In production", token minted and installed by the owner; `--check` ok | OWNER | owner-setup-checklist.md Parts 2–4 |
| B5 | Configure `backup.env` (still disabled); synthetic single-part + multipart self-tests delivered; owner downloads, unpacks, decrypts, go-live checks (inbox not spam, SPF/DKIM pass, all parts) | READY after B3–B4 — approval | [email-backup-design.md §10 D–E](email-backup-design.md) |
| B6 | **Restoration from an emailed archive**: full disposable restore on the owner's Mac from received mails (restore runbook §2–§4) | OPEN — after B5 | [restore-from-email.md](restore-from-email.md) |
| B7 | First real archive, then schedules (weekly archive, daily report) | approval after B6 | §10 F–G |
| B8 | Until B7: **every backup is on one disk** — accepted risk recorded by the owner | OWNER | — |

## C. Remote-access compliance ($0 target, no domain)
| # | Item | State | Evidence |
|---|---|---|---|
| C1 | Tailscale Personal is non-commercial only; tills/phones in Myanmar would need a VPN app (2025 Cybersecurity Law, DPI blocking) | OPEN — owner decision | [free-tier-compliance.md](free-tier-compliance.md), [remote-access-architecture.md](remote-access-architecture.md) |
| C2 | Options: (a) paid Tailscale (~$192/yr; still a VPN app), (b) domain ~$10–15/yr + Cloudflare Tunnel (no VPN app; public API → requires A2 ✔, A6, D-stages), (c) per-shop LAN server (breaks shared catalogue) | OPEN — owner decision | same |
| C3 | Reachability test from both shops for the chosen path (≥ 1 week) | OPEN | per-shop checklist in wireguard-feasibility.md |
| C4 | Backend not exposed publicly until A2, A6 and D3–D5 are verified | rule | owner instruction 2026-10-13 |

## D. Server hardening (no change without the recovery gate)
| # | Item | State | Evidence |
|---|---|---|---|
| D1 | Gate R: owner logs in at the physical console + `sudo -v`; second SSH key from another device added and tested; duplicate key line removed | OWNER | [host-hardening-staged.md §3A](host-hardening-staged.md) |
| D2 | Tailscale node key expiry disabled; tailnet policy (tills/phones → server:443 only) | approval after D1 | Stage 1 |
| D3 | SSH key-only, AllowUsers, no root (10-min auto-rollback) | approval after D1 | Stage 2 |
| D4 | ufw default-deny + DOCKER-USER rules / rebinding Docker ports (auto-rollback) | approval after D1 | Stage 3 |
| D5 | Wi-Fi client isolation / Ethernet for the server (gives a LAN fallback path) | OWNER (router) | §3A |
| D6 | Controlled reboot on the new kernel with someone at the console | approval | [host-reboot-hardening.md](host-reboot-hardening.md) |

## E. Code, tests and repository
| # | Item | State | Evidence |
|---|---|---|---|
| E1 | Unit / type checks / function tests / DB harness green | DONE (re-run before release) | vitest 936, functions 64, harness 647/0 (capped 081: 601/0) |
| E2 | Full e2e suite green in one run | DONE 2026-10-16: 44/44 normal ×2 + reverse ×1, cleanup CLEAN each; one earlier D300 failure unexplained (desktop modal closed; diagnostics added, 7 later D300 passes) | [app-bugfixes.md](app-bugfixes.md) |
| E3 | Barcode-loss-on-product-save bug and upload-poll stall fixed | DONE (client-only; ships with 1.0.16) | app-bugfixes.md; 44 new unit tests |
| E4 | Sanitized publication branch updated with all publishable changes; scans + fresh-clone tests | DONE 2026-10-16: 16 commits on main, unpushed; 0 private identifiers in tree/added lines/messages; 0 private commits reachable; fresh clone: tsc clean, vitest 936, functions 64, harness 647/0, build guards refuse bad config. Tolerated: generic `~/shwephala-migration/<ts>/` path in 13 lines of the first 12 commits' history (not in the tree) | coordinator scan + sync report |
| E5 | Vercel Git integration disconnected; GitHub Pages workflow absent on the publication branch; main branch protection | OWNER (dashboards) | [vercel-github-controls.md](vercel-github-controls.md) |
| E6 | Push branch / PR / merge (as Lucas1792003) | approval | release-checklist Phase 4 |

## F. Desktop release and real-device canary
| # | Item | State | Evidence |
|---|---|---|---|
| F1 | Version bump to 1.0.16; remove/set aside the stale local `release/` builds that also say 1.0.15 | OPEN | electron-compatibility.md |
| F2 | Build with `build:electron` (guard: https backend + phone origin), `--publish never`; bundle checks (host pin, no hosted ref, no signUp, no service key) | READY | electron-compatibility.md |
| F3 | Updater guard: don't install an update while sales are pending (proposed) | OPEN — decision | electron-compatibility.md |
| F4 | Windows SmartScreen / unsigned installer accepted ($0; no code-signing cert) | OWNER | cost-research.md |
| F5 | **Real-device canary** on one till per shop + one phone each, 8 checks: backend label + version; owner TOTP login + create/deactivate a CASHIER; staff-admin "not installed" message (dev build only); phone upload via QR after > 60 s; offline sale → restart → Export pending → reconnect drains once; pending entry survives a local 1.0.17 test installer; v1.0.15 machine sees "no update"; zero `*.supabase.co` requests | OPEN — after A6, C-decision, F1–F4 | electron-compatibility.md §canary |
| F6 | No real shop sales until F5 passes on both shops and B7 is live | rule | owner instruction |
| F7 | Pre-release → canary → promotion; rollback plan (never v1.0.15 on a till with newer local data; never redirect a till to hosted) | approval | release-checklist Phases 5–7; emergency-recovery-runbook.md |
