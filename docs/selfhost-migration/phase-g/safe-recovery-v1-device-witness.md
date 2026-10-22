# Safe Recovery V1: device evidence and checkpoint interfaces

This is a local prototype on `ws/recovery-v1`. Nothing here enrolls real owner
keys, creates a production witness, authorizes reopening, applies a migration,
changes Control, or reconstructs missing financial content. Production is NO-GO.

## Implemented integration

`src/recovery/canonical.ts` defines versioned deterministic JSON and platform
ECDSA P-256/SHA-256 signing. Object keys sort by UTF-16 code units; arrays retain
order; numbers use ECMAScript JSON encoding; strings are not Unicode normalized.
Undefined, sparse arrays, nonfinite numbers, BigInt and nonplain objects are
rejected. This canonical form is not PostgreSQL `jsonb::text`. SHA-256 digests
are lowercase hex; signatures are raw 64-byte `r || s` (not DER) in low-S form, encoded as canonical base64; any other encoding of the same bytes is refused.

`deviceVault.ts` retains a structured-cloned, nonexportable WebCrypto private
CryptoKey in the separate `orvix-recovery-device-v1` IndexedDB database. Keys do
not appear in JSON, server records, logs, exports or backups. Only an explicitly
named synthetic enrollment helper is implemented. No enrollment happens on
first operation, profile repair, reinstall, missing-key load or recovery.

`opJournal.ts` still owns the original business operation journal and stable
idempotency key. Its mutable observations point to separate immutable signed
snapshots under `rv1:evidence:`. Existing outbox and online-only journal paths
share this hook. Envelope signatures bind organization, shop, enrolled device
and key, operation UUID, RPC type, exact canonical payload hash, complete
observation hash, device/key sequence, previous event hash and actor/epoch/backend
enrollment context. A signed observation says what this device saw; a signed
`committed` reply is a claim observed from the server, not independent proof of
the server actually committing correct business state.

The journal and signed snapshot/head writes share one IndexedDB transaction.
WebCrypto and separate vault reads use `Dexie.waitFor`; the final journal write
uses a transaction-bound table so a rejected separate vault read cannot cause
an out-of-transaction write. Concurrent writers serialize. A disk failure rolls
back the outbox/journal/evidence together. Losing a signer does not discard a
surviving committed reply: the journal records it as an unsigned later
observation, and previous signed evidence remains byte-identical.

`idempotentRpc.ts` signs the exact transmitted arguments after provisional
references have resolved. Exact retries reuse the same signed transmission and
financial key. A changed transmission under that identity fails closed. Initial
intent and resolved transmission are separate signed observations; mapping a
provisional shift identifier never silently rewrites the original intent.

`client.ts` discovers `recovery_v1_status`, remembers positive capability
durably, rejects malformed/wrong-tenant replies, and never falls back to legacy
behavior after V1 has been positively detected. An explicit missing-function
reply before detection preserves existing 085/086/087 behavior; that is legacy
compatibility and supplies no V1 guarantees. Until detection, existing legacy
offline rules still apply: an offline device cannot know a server-side incident
has just begun. The server/database restriction is therefore essential.

Review round 2: ECDSA signatures are produced and accepted only in low-S form AND canonical base64 (`canonical.ts`). WebCrypto accepts both the high-S twin and non-canonical base64 of the same signature. Evidence and receipt hashes include the signature string, so either could otherwise let a third party re-encode an honest record into a "fork". When an independent trust source is configured but a journal observation cannot be signed, the record carries `deviceEvidenceGap` (reason, returned per capture). The gap is then visible, not indistinguishable from a legacy unsigned record. Owner exports never drop damaged evidence or receipts silently. A damaged evidence or receipt record is exported with field-based redaction only when it still parses as an object and EVERY organization field present (`orgId`, `envelope.body.orgId`, `body.checkpoint.orgId`) is exactly the exporting organization. Anything else is exported as key, size and a non-cryptographic fingerprint only: unparseable, conflicting, null or non-string fields, or another organization. Damaged journal records are handled as follows:

- A record whose top-level `orgId` is this organization is exported as redacted contents. Only the top-level field is checked, so nested fields naming another organization are not.
- One naming another organization is left out, as for well-formed records.
- Anything else is exported as a key, size and fingerprint marker.

Two cases are still dropped without a marker:

- well-formed journal records whose `orgId` is missing or not a string;
- vanished-row records (`opjv:`) that are unparseable, unattributed or incomplete. This filter predates V1.

The originals stay on the device.

Correction pass (P0): before detection, a FAILED status request (network error,
timeout, HTTP 5xx, Tailscale down while the OS reports online) is a communication
failure, not an answer. The client treats it as legacy-unknown, so the sale is
saved and queued exactly as on an 085 server. The failure is remembered in
memory for 30 seconds so an unreachable server does not stall every sale. It is
never persisted as "absent", and it never marks the server as recovery-aware.
Only a positive, well-formed status reply for the caller's organization marks a
backend as recovery-aware (durable, per backend origin). After that, every
failure, timeout, 5xx and missing function (downgrade) blocks NEW financial
operations before anything is saved or sent. A malformed 200 reply is never a
legacy signal and quarantines. Regression tests: `src/recovery/offlineCompat.test.ts`.
The pre-fix code failed four of them; the log is in `/Users/waiyan/Projects/personal/Orvix/artifacts/recovery-v1-prefix-offline-regression.log` and `docs/recovery-v1/evidence/correction-pass/prefix-client-offlineCompat.log`.

Correction pass (P2): at the per-attempt send boundary, a communication failure, a verified non-ACTIVE state or an unavailable device authorization returns the existing `RECOVERY` hold. Nothing was sent. The outbox holds EVERY `RECOVERY` failure before it looks at `retryable` (outbox.ts, 087 branch), so the entry stays `pending` with its original key, arguments and journal. It is re-checked about every 5 minutes and never re-keyed. Online-only operations stay unresolved with their key. This covers contradictory local evidence (`EvidenceIntegrityError`), a post-detection missing function and a malformed reply, which are marked `retryable:false` but are also held and re-checked rather than turned into a conflict. Nothing is sent while any of these persist. The earlier review finding that a status failure produced a conflict was overstated for these paths. The journal may record a send attempt for a blocked attempt (the attempt is journaled before the V1 check); that overstates uncertainty, never hides it.

**UNRESOLVED PRODUCTION BLOCKER (owner, 2026-10-21): Orvix is offline-first.** Refusing offline sales permanently after a till merely detects V1 is not approved as final production behaviour; a healthy ACTIVE organization must keep a safe offline-selling capability. The behaviour below is a checkpoint state, not the target. See IMPLEMENTATION-REPORT.md section 6a.

**Detection is one-way (in this checkpoint).** Once a backend origin has answered with the recovery protocol, the till never returns to legacy behaviour for that origin. This holds even if the V1 SQL is later removed or a pre-V1 backup is restored: new financial writes, including offline sales, stay refused until the server answers again with an ACTIVE status. There is no client-side reset. The only way out is a new profile, which risks unexported queue data, so export first. This is the reason V1 SQL must only ever be installed on an isolated database (see the DB README install acknowledgement).

**Old clients against a server with V1 guards.** The database answers every refused write with `PT503 ORG_SUSPENDED`. 1.0.16 classifies it as a retryable `suspended` hold: queued entries stay pending, and new sales are refused before anything is saved. **1.0.15 has no failure classification**: the entry becomes a `conflict` that is kept on the till until someone presses Retry. Pressing Dismiss would drop that queue entry while keeping the local sale record. 1.0.15 tills must therefore be upgraded or isolated before V1 is ever installed. Neither has been tested over real HTTP/PostgREST; the evidence is direct SQL plus the 1.0.16 unit tests.

Once V1 is detected, new financial operations, actual RPC attempts, manual
retry, stop-on-server, reconciliation, set-aside and restoration of set-aside
entries require an ACTIVE server. Financial execution also requires the
independently authorized device signer. Existing queue payloads/keys are never
discarded or regenerated. V1 financial writes while disconnected are currently
blocked; a safe independently authorized offline execution policy is not
implemented. Existing offline evidence survives disconnection and reconnects
into restricted mode without automatic resend. Do not claim the V1 financial
offline execution requirement is complete.

The existing recovery banner displays the cached V1 state, recovered-as-of claim
or unknown, and uncertainties. Stock, open/restored shifts, profit and settlements
remain unproven. A previous 087 epoch does not display “Safe to resume” for a V1
organization. This banner does not certify individual report correctness.

`sync.ts` creates a checkpoint from actual signed journal records, verifies and
persists its receipt with add-only semantics, and supports evidence-only upload
while financial execution is restricted. `recovery_v1_store_evidence` and
`recovery_v1_store_checkpoint` acknowledgements are explicitly `verified:false`;
they never establish trust and never delete the local originals. Tenant and
actor permissions are enforced again by provisional SQL. POS owner/cost privacy
is retained; no Control financial read or key-management authority is added.

Owner encrypted queue exports now carry immutable `deviceEvidence` and
`witnessReceipts` separately from replayable queue entries, as export **format 4**
(correction pass P3). A file carrying either is labelled 4 in the authenticated
envelope. Readers up to format 3, including the shipped 4971b55 reader, refuse it
as `unsupported-version` rather than silently dropping the signed history.
Contents that need format 4 under an older label are refused. A format-4 file
must carry both arrays explicitly. Formats 1–3 still read unchanged. Tests are in
`src/lib/queueExport/evidenceFormat.test.ts`; a frozen copy of the shipped reader
is in `__fixtures__/format.4971b55.ts`. Staff/foreign-tenant
exports do not receive that financial history. Field-based credential redaction
applies to free-form snapshots, removes the derived fingerprint, and flags a
redacted evidence record as unverifiable. A hash cannot reconstruct redacted or
lost content. A damaged record is exported as redacted parsed contents (own
organization only) or as a key, size and fingerprint marker, so an export is
not a lossless copy of a damaged profile. Preserve the original profile and
vault, damaged records and incident logs before any destructive work.

## Trust, revocation, loss and rotation

`IndependentTrustSource` is a dependency boundary. Pinned owner/enrollment and
witness public keys must arrive from independently controlled custody. The
default source is absent and fails closed. No server RPC response, infrastructure
assertion, ADMIN role, Control login, key fingerprint fetched from the recovering
host or local synthetic fixture establishes independent owner authority.

The enrollment certificate binds every tenant/device/public-key identity and
validity period, and is signed by the pinned enrollment authority. Current
authorization additionally requires `deviceStatus`: a fresh authority-signed
ACTIVE/REVOKED/LOST/RETIRED status bound to the same enrollment/key identities and
a newly generated challenge. The verifier rechecks enrollment and root validity
at actual response receipt, bounds lifetime/response delay to 120 seconds, and
rejects expired, delayed, substituted or replayed statuses. Absent status service
or disconnected independent custody blocks current authorization. The synthetic
source deliberately controls both parties for tests; it is not deployment.

Lifecycle policy:

- Rotation needs a separately authorized new enrollment with a new key and
  stream, linking `replacesEnrollmentId`. Preserve the old key, certificate,
  signed events, sequence/head and receipts; never reset the old stream.
- Revocation/loss/retirement is decided by independent custody's signed status,
  not by changing a server table or replaying an old enrollment certificate.
- Reinstallation never silently recovers or regenerates a signing identity.
  Preserve surviving profile/vault evidence; an explicitly authorized new
  enrollment is a new identity/stream.
- Reinstatement requires an independently authorized fresh ACTIVE status; a
  database restore, server claim, local UI acknowledgement or old certificate
  cannot reinstate a lost/revoked device.
- Production rotation/reinstatement workflows and independent custody adapters
  are unresolved release prerequisites. The prototype has no production key
  generator or approval-free enrollment/reopen interface.

WebCrypto's nonexportable flag is not hardware attestation, an OS keychain
integration or resistance to a machine administrator. Malicious same-origin
code can ask an available key to sign, so independent client distribution and
client integrity are required against a compromised web server serving altered
JavaScript. Historical event times are device claims. Historical verification
does not prove an event predated revocation, nor that a pinned roster is the
latest legitimate roster. Fresh challenge responses depend on the independent
authority's current, honest lifecycle state and a reasonable client clock.

## Checkpoint boundary and withholding

`createCheckpoint` verifies a complete supplied per-device/key event prefix and
requires an observed committed operation. Its digest binds all signed event
hashes and the selected signed committed-observation hashes. Its sequence counts
evidence events in that stream, not global organization transactions or sales.
It binds organization, shop, stream, boundary digest and previous receipt hash.

`verifyWitnessBoundary` verifies independently pinned witness signatures,
receipt links, the signed device prefix, its committed-observation digest, and an
independently supplied trusted boundary. It detects forks, a changed supplied
prefix and rollback below that boundary. Missing receipt/trusted boundary is a
failure. A valid authenticated receipt never proves it is the latest legitimate
one; the server, a mailbox or a compromised relay can suppress later receipts.
A surviving device or independent authority must supply a stronger known
boundary. Disconnected/unavailable witnesses never fabricate acknowledgements.

`tools/recovery-v1/witness-local.ts` is an executable local TEST DOUBLE. Its
private synthetic key exists only in process memory. Its temporary storage uses
exclusive writer locks, append-only JSONL and fsync before acknowledgement.
No network listener or external service is activated. Local custody can change
its files/process; it is not independently controlled or production-ready.

```
node --import tsx tools/recovery-v1/witness-local.ts --smoke
node --import tsx tools/recovery-v1/witness-local.ts --jsonl
```

`--smoke` exercises durable receipt creation, verification, exact duplicate
acknowledgement, fork refusal and a linked successor. `--jsonl` accepts synthetic
organization checkpoint requests on stdin, prints the session's public test key
and storage path, and never outputs private key material.

The backup integration in `tools/recovery-v1/verify-recovery.ts` consumes raw
signed evidence and independently supplied trust/boundary inputs. It verifies
archive/operation/checkpoint binding and surviving offline evidence separately.
`assessRecovery` can return only RESTRICTED or QUARANTINED and never authorizes
reopening. A valid prefix cannot detect every omitted operation or unseen tail;
lost device-only content and unwitnessed transactions cannot generally be
reconstructed. No new ledger or migration 088 is introduced.

## Sources and local checks

Platform semantics: [W3C Web Cryptography Recommendation](https://www.w3.org/TR/2017/REC-WebCryptoAPI-20170126/),
[Dexie waitFor transaction guidance](https://dexie.org/docs/Dexie/Dexie.waitFor()).

Focused tests cover canonical rejection, nonexportable structured storage,
substitution and tenant/device replay, loss/revocation/fresh challenge/delayed
expiry, immutable original observations, concurrent sequence assignment,
transaction rollback, missing-key reply preservation, owner-only export,
actual sale slice integration, restricted reconnect/retry preservation,
capability downgrade, receipt forks/rollback/missing independent evidence and
evidence-only upload. This is Script 1 validation, not exhaustive adversarial
Script 2. Production remains NO-GO until separate infrastructure, custody,
migration, client-release and broader verification decisions are authorized.
