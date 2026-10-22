# Recovery V1 — Step 5: recovery activation and device trust (design)

Status: LOCAL IMPLEMENTATION, provisional (branch `ws/recovery-activation`). Not applied to any real database.
Owner policy decisions (P-2, P-6, P-8, production offline limits, key custody) are NOT made here; every new control has a
safe unconfigured state.

Script 2 showed four gaps. This step closes them in the database (the enforcement boundary) and wires the till and
Control to it:

| Gap (Script 2) | Step 5 |
|---|---|
| V1 enforced organization state only; any client (also an old one) could sell once an org was ACTIVE; the app had no device-trust source, so a V1 till could never sell | §1 owner-approved device enrollment; every ledger operation must carry a signature by an ACTIVE enrolled device key, verified **in PostgreSQL** |
| nothing could reopen an organization | §2 owner-signed, incident-bound reopening after a recorded reconciliation |
| offline exposure was per capability only (30 × 20,000 MMK/hour per cashier) | §3 aggregate org / shop / device budgets reserved atomically at issuance; device-bound capabilities; verified surrender |
| Control had no recovery interface | §4 narrow operator functions (`orvix_recovery_operator`), Control as courier and viewer only |

## 0. Threat model and trust anchors

* **Owner**: holds RSA owner keys OFFLINE. The server stores only public keys. Production custody is NOT established
  (deployment prerequisite); local tests use the synthetic signer `tools/recovery-v1/owner/owner-sim.mjs`, whose keys live
  in a temp directory the database never sees.
* **Owner-key anchor**: the install transaction records the fingerprint of the install key (or an explicit "none") in
  `recovery_v1.owner_anchor` (one row, immutable). A key is *trusted* only if it is that anchor or was enrolled by a signed
  `enroll-owner-key` authorization of a trusted key (re-verified on use). Inserting an `owner_keys` row by hand therefore
  grants nothing.
* **Infrastructure** (DB superuser, service role, Control operators, app ADMINs) can contain an incident (restrict,
  suspend, revoke) but cannot create trust: device enrollment, device reinstatement and reopening each need an owner
  signature that the database verifies at use.
* A DB superuser can still rewrite functions (detected: catalog pins quarantine every org). Trust-conferring rows are
  verified when written AND at use: an enrollment, reinstatement or reopening counts only if its owner authorization was
  accepted by this database (single-use nonce row, time stamped by the database) inside its validity window, and the key is
  judged as of that instant (reviews 2/3/4). What remains for a superuser: submitting a GENUINE, unused, unexpired owner
  authorization itself (equivalent to any submitter), forging non-trust tables, or replacing the verifier (caught by pins).
* Scoped owner keys (one organization) authorize only that organization's device and reopening documents and policies; they
  never authorize migrations, global policy, other scopes or the retirement of a wider key (review 4).

## 1. Device trust

### 1.1 Identity (till)
* Request-signing key: **RSA-2048, RSASSA-PKCS1-v1_5/SHA-256**, generated with WebCrypto `extractable: false`, kept in the
  device vault (IndexedDB, structured clone). RSA because PostgreSQL verifies it with the existing exact `rsa_verify`
  (~1.5 ms); ECDSA verification in PL/pgSQL is not practical.
* Evidence key: the existing ECDSA P-256 key (journal evidence), bound to the same enrollment (`evidencePublicKey`).
* **Honest limit**: `extractable:false` stops app code from exporting the key; Chromium still serialises it into the
  profile's IndexedDB on disk. It is NOT hardware-bound or OS-keychain-protected: copying the profile clones the device.
  Electron offers `safeStorage` (OS keychain encryption) but no non-exportable signing API; Secure Enclave / TPM signing
  needs a native module and a signed app (deployment prerequisite). Mitigation in software: a per-device request counter
  (§1.4) makes a clone or a rolled-back profile collide with counters the server already saw (refused + logged).
* `deviceId` = `till-<uuid>`, generated once with the key; a re-enrollment after loss or revocation is a NEW identity.

### 1.2 Enrollment protocol
1. Till → `recovery_v1_device_request_enrollment(request_text, device_sig)`: the request
   `{"protocol":"orvix-device-enrollment-request-v1","requestId","orgId","shopId","deviceId","publicKey":{"n","e"},
   "keyFingerprint","evidencePublicKey","requestNonce","requestedAt","replacesEnrollmentId"}` signed by the new key
   (proof of possession). Server checks the caller belongs to the org and may operate the shop, the key (≥2048 bits,
   e = 65537), fingerprint, clock window (±10 min), that the key fingerprint was never revoked, and stores it PENDING.
   The till shows a short code (first 16 hex of the fingerprint) for out-of-band comparison by the owner.
2. Owner (offline) reviews the request and signs an `enroll-device` owner authorization:
   `{"scope":orgId,"ownerId", "device":{"requestId","orgId","shopId","deviceId","keyFingerprint","requestNonce","notAfter",
   "replacesEnrollmentId"}}` plus the standard envelope (protocol, purpose, keyId, nonce, target database / system id /
   install time, issuedAt, expiresAt ≤ 7 days).
3. Anyone of the org (ADMIN, the device's own cashier) or a recovery operator (Control) submits it to
   `recovery_v1_device_approve(auth, sig)`. The database verifies the owner signature with a trusted key whose scope covers
   the org, the single-use nonce, the target, and that the authorization matches the stored request field by field.
   A replacement must name the replaced enrollment in BOTH the device's request and the owner's authorization.
4. The till fetches `recovery_v1_device_status(...)` and verifies the owner signature itself against owner-key
   fingerprints pinned on the till (provisioned out of band: Electron `owner-trust.json` / E2E env; never taken from the
   server). No pinned anchor ⇒ the till never considers itself trusted ("trust anchor not provisioned").

### 1.3 State (computed and re-verified at every use)
`ACTIVE | PENDING | SUSPENDED | REVOKED | REPLACED | EXPIRED | INVALID`. `INVALID` = the stored enrollment does not
verify (forged or edited row). Revocation (ADMIN, operator, or the existing per-device revocation) is immediate and
permanent for that key and device id. Suspension is reversible only by an owner `device-reinstate` authorization.

### 1.4 Every financial operation is device-signed (server-enforced)
Header `x-orvix-device: {"v":1,"enrollmentId","counter","sig"}`; signature over
`orvix-device-request-v1\n<enrollmentId>\n<orgId>\n<shopId>\n<idempotencyKey>\n<rpc>\n<counter>`.
* `guard_ledger` (every keyed financial RPC inserts its ledger row) verifies it: enrollment ACTIVE, org match, caller in
  the org, RSA signature, and records `(enrollment, counter, key, txid)` in `device_counters` (a counter reused for a
  different key = clone / rollback ⇒ refused).
* `guard_write` refuses any write to a money table (`sales, sale_items, sale_payments, cash_movements, refund_lines,
  refund_payouts, refund_void_requests, shifts`) unless this transaction has a verified device operation, and the row's
  shop equals the device's shop. Keyless or old-client paths therefore fail closed. Catalog, purchasing and stock
  tables remain governed by organization state and RLS only (documented limit).
* The device context is read from a table keyed by `txid_current()`, never from a session setting.
* The signature binds key, rpc, org, shop, device, counter and the OFFLINE MARKER (`<capabilityId>:<deviceSeq>` or `online`):
  removing the x-orvix-offline header invalidates the signature (review 2). It does not bind the arguments (a party holding
  both the cashier's session and an unspent header could substitute arguments; documented).
* LIMIT (review 2): the device key lives in the till profile. Whoever controls that profile can sign anything, including
  marking an offline sale as online. Offline limits therefore bind honest tills and anyone WITHOUT the key; a compromised
  till is contained by revocation and by the reconciliation facts, not prevented. Counters detect exact counter reuse
  (a clone or rolled-back profile that re-signs a recorded counter), not every rollback.
* A device belongs to ONE shop: an ADMIN's head-office device can move money only in its own shop (fails closed; owner
  decision whether org-wide admin devices should exist — review 1, H2).

## 2. Organization reopening

* `recovery_v1.incidents` (insert-only): one per departure from ACTIVE (install = incident 1 per org). `org_state` carries
  `incident_id`, `recovery_epoch`, `reopen_id`.
* `RESTRICTED → RECONCILING` (ADMIN / operator, existing transition). `recovery_v1_reconciliation_report(org)` computes
  deterministic facts and **blockers** and stores the report (digest = sha256 of the facts).
  Blockers: `integrity:*` (hard), `ledger_in_flight` (hard), `offline_operations_possibly_unsynced`,
  `refund_requests_pending`, `payment_mismatch`, `device_evidence_missing`, `evidence_slot_conflicts`,
  `checkpoint_slot_conflicts`, `no_trusted_device`.
* Owner signs `reopen-organization`: `{"scope","ownerId","reopen":{"orgId","incidentId","recoveryEpoch","fromState":
  "RECONCILING","toState":"ACTIVE","reportDigest","decision":"verified"|"limited","acceptedBlockers","uncertainties",
  "witnessRequired","checkpointHashes","backupManifestSha256","recoveredAsOf"}}`.
* `recovery_v1_reopen(auth, sig)` verifies the signature, scope, nonce, target, incident and epoch, current state =
  `fromState`, recomputes the facts (digest must equal the signed one AND a stored report), refuses hard blockers,
  `verified` needs zero blockers, `limited` must list exactly the open blockers and state uncertainties (shown to every
  till), and with `witnessRequired` every named checkpoint must be stored for the org. Then ACTIVE + audit.
* Enforcement: a trigger on `org_state` refuses any change to ACTIVE outside this function's transaction; `guard_write`
  and `status` require the ACTIVE state to reference a reopening of the CURRENT incident whose owner signature verifies
  (once per transaction). A superuser `UPDATE ... SET state='ACTIVE'` is refused, and a forged row fails verification.
* A restored or copied database stays QUARANTINED (identity / timeline pins): reopening never repairs that; a restore
  is never an authorization.

## 3. Aggregate offline exposure

* Policy (owner-signed `offline-policy`) gains `orgBudgetMmk`, `shopBudgetMmk`, `deviceBudgetMmk`. **Unconfigured
  (NULL) ⇒ no capability is issued** (`offline_budget_not_configured`). The test-defaults install option carries
  clearly labelled SYNTHETIC budgets.
* Issuance needs a device-signed request from an ACTIVE enrollment of that shop; the capability binds the enrollment.
  Under an org-level advisory lock the server computes **outstanding exposure** = Σ `max_amount_mmk` of capabilities of
  the current offline epoch that are not surrendered, not past their sync deadline and whose device is not revoked, per
  org, shop and device, and issues `min(policy per-capability, remaining device, remaining shop, remaining org)`
  (refused at 0). Re-delivery cannot reset anything (server rows), a restart or reinstall cannot either.
* Sync (`offline_problem`): the operation's device signature must come from the capability's enrollment (fixes device
  substitution and renamed-device bypass); stale epoch, deadline, count, value and surrender are enforced as before.
* A **verified surrender** (device-signed `{capabilityId, opsRecorded, amountRecordedMmk}` equal to the synced usage) stops
  acceptance at once; the reservation itself lasts until the capability's EXPIRY (a till could still hand goods over under it).
  Revoked devices' and older epochs' capabilities also keep counting (until the sync deadline / expiry) — reviews 1/2.
* Limit: a disconnected till cannot coordinate with others, so global safety comes from advance allocation. A
  compromised or rolled-back till can hand over goods beyond its allocation; the server will not ACCEPT more than the
  allocation (excess is held for review), and counters expose rollback.

* Reconciliation counts every enrollment in service when the incident began (also if suspended, revoked or expired since):
  containment never erases an unreported till or the unsynced operations it attested (reviews 1/3). Attestations only move
  forward in time.
* Operational limit: while V1 is installed no NEW organization can be created (its first rows are refused): onboarding needs a
  separate, owner-authorized path (not implemented).

## 4. Control

POS side: `recovery_v1.operator_*` functions granted to `orvix_recovery_operator` (organization recovery overview,
device requests and enrollments, submit owner authorizations, revoke / suspend, start reconciliation, report, audit
history). They return recovery metadata and counts only — never sales, payments or customer rows. Control (separate repo,
new worktree) adds `control.api_pos_recovery_*` wrappers (session, role, step-up for revoke / reopen submission, audit
chain) and a "POS recovery" page; it carries owner-signed documents, it never creates them. Without the POS hook or
without an owner authorization the page shows the transition as blocked.
