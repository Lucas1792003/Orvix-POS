# Owner actions before the controlled canary (2026-10-16)

Private. One list, grouped by **where** you have to be. Tick in order inside each group; groups can run in parallel unless noted. Nothing here is done by the engineer; the engineer only needs the outputs named in *Send back*.

## A. Remote — any device with a browser (no physical access)
| # | Action | Send back | Details |
|---|---|---|---|
| A1 | Hosted delta check: run `tools/selfhost-migration/hosted-delta.sql` in the **hosted** Supabase SQL editor (read-only) | the single JSON result cell | [hosted-delta-check.md](hosted-delta-check.md) |
| A2 | Decide RC2: fix the four RC1 audit defects (D1 Dismiss deletes without confirmation, D2 stuck "syncing" entries block updates, D3 ID-map pruning, D4 owner-only override not enforced) before the canary — **recommended** — or canary RC1 with the checklist's mitigations | decision | [electron-compatibility.md](electron-compatibility.md), audit tests `audit/rc1/` |
| A3 | Approve the gateway log fix (L1: query strings incl. short-lived tokens and staff e-mail filters are logged today) — ideally in the same controlled gateway restart as Studio isolation | approval | [gateway-logging-review.md](gateway-logging-review.md), [studio-isolation.md](studio-isolation.md) |
| A4 | Remote-access decision for the canary devices (Tailscale Personal is non-commercial only; VPN app on Myanmar devices) — accept for the canary only, or choose another path | decision | [remote-access-architecture.md](remote-access-architecture.md) |
| A5 | Tailscale admin console: disable key expiry for the server node (it expires 2027-03-15) | "done" | [host-hardening-staged.md](host-hardening-staged.md) Stage 1 |
| A6 | Create the two Gmail accounts (sender + backup), the Google Cloud app **In production**, the Desktop OAuth client | the two addresses | [owner-setup-checklist.md](owner-setup-checklist.md) Parts 2–3 |
| A7 | Vercel: disconnect the Git integration; GitHub: branch protection for `main` | "done" | [vercel-github-controls.md](vercel-github-controls.md) |
| A8 | Decide on the 7 unlinked login accounts (keep / delete list) | decision | [qa-data-inventory.md](qa-data-inventory.md) C2 |
| A9 | Approvals still needed: canary per shop, Studio isolation + log fix, (later) 084, publishing the release, push/merge | approvals | [production-readiness-checklist.md](production-readiness-checklist.md) |

## B. At your Mac (physically, not over SSH)
| # | Action | Send back | Details |
|---|---|---|---|
| B1 | Generate the backup encryption key; prove the password-manager copy and the paper copy with `--verify-copy` | fingerprint + `owner-backup.pub.asc` | [owner-recovery-key.md](owner-recovery-key.md) §1 |
| B2 | Mint the Gmail send-only token on the Mac, copy it to the server yourself, run `--check` | "token installed, check ok" | [owner-setup-checklist.md](owner-setup-checklist.md) Part 4 |
| B3 | Test your own sign-in (password + authenticator) against the self-hosted backend with a dev build or the RC1 Mac build from the frozen folder | PASS/FAIL | [../next-phase/owner-totp-test.md](../next-phase/owner-totp-test.md) |

## C. At the server (home, physical access)
| # | Action | Send back | Details |
|---|---|---|---|
| C1 | Log in at the laptop's own keyboard/screen with the account password; run `sudo -v` | PASS/FAIL | [host-hardening-staged.md](host-hardening-staged.md) §3A Gate R |
| C2 | Add a second SSH key from another device you control; test it; remove the duplicate line | the new key's fingerprint | §3A |
| C3 | Router: Ethernet for the server, or disable Wi-Fi client isolation for it; check BIOS auto-power-on | what you changed | §3A, [host-reboot-hardening.md](host-reboot-hardening.md) |
| C4 | Be at the console for any later reboot / SSH / firewall stage (not part of the canary) | — | — |

## D. At each shop (physical access to the till and a phone) — only after A1, A2, A4 and a canary approval
| # | Action | Send back | Details |
|---|---|---|---|
| D1 | On the 1.0.15 till: confirm **0 actions waiting to sync**, then close the app (the 1.0.15 updater has no guard; 1.0.15 queue entries cannot be de-duplicated after the upgrade) | photo of the sidebar | [../../desktop-app/canary-1.0.16-checklist.md](../../desktop-app/canary-1.0.16-checklist.md) §0 |
| D2 | Install RC1 (or RC2) **from the frozen folder** on a USB stick — never from a download; SmartScreen warning expected | the version/backend/till-id photo | canary §1 |
| D3 | Fill the till register row (till id, versions, pending/quarantined counts, reconciliation) | the row | [till-register.csv](till-register.csv), [till-readiness-084.md](till-readiness-084.md) §2.1 |
| D4 | Run the canary with **CANARY**-tagged data only (no real sales, no real stock); never press **Dismiss** on the Sync page | the record table | canary checklist §2–§6 |
| D5 | Phone: Tailscale on (per A4), QR upload tests | results | canary §4 |

## Not part of the canary (later, separate approvals)
First real archive email and schedules; 084 (after every till is GO in `verify-till-readiness.sh`); host hardening stages + supervised reboot; publishing 1.0.16 as the latest release; real sales.
