# Independent review 3: cryptographic trust and backup/recovery

Review date: 2026-10-21 (America/Toronto). Scope: Script 1 implementation review, with focused local verification. This is not a comprehensive security audit or Script 2.

Reviewed `src/recovery/{canonical,trust,deviceVault,evidence,witness,assessment,journalCapture,testing}.ts`, the recovery client authorization boundary, `tools/recovery-v1/{backup-archive,restore-verification}.mjs`, `verify-recovery.ts`, the synthetic integration smoke and backup-readiness documentation. No real database, Docker service, external witness, email transport, production credential or existing deployment was accessed. The reviewer initially read source only; the lead subsequently authorized the two narrow backup corrections below.

## Findings and corrections

### HIGH C1: immutable enrollment alone could continue authorizing a lost/revoked device — fixed for the local interface

The initial `IndependentTrustSource` exposed authority/witness public keys only. `enrolledDevice` validated its stored, signed enrollment certificate, whose original `revokedAt:null` remained valid. Issuing a different certificate with the same identity and a revocation did not invalidate the surviving original. Per-device revocation could not be communicated to the current write gate without revoking the enrollment authority for all devices. A synthetic reproduction confirmed the old enrollment still verified while the replacement revoked enrollment failed. Existing tests covered authority-root revocation, which did not resolve individual device lifecycle authorization.

The evidence/client author corrected the current authorization boundary: `trust.ts` now defines an independently root-signed, challenge-bound `DeviceAuthorizationStatus`, binds enrollment/organization/shop/device/key/authority, requires ACTIVE state and a bounded validity interval, and rejects malformed signatures. `deviceVault.ts` now requires that interface for each current authorization. A missing status provider fails closed; the stored certificate alone cannot reinstate a lost, retired or revoked device. Disposable fixtures implement the interface for local verification only. No production authority or custody adapter was introduced.

Review also identified that validating a returned status against request-start time could accept an excessively delayed response. The author corrected `deviceVault.ts:64` to read the receipt clock again, reject clock rollback or a response delay exceeding 120 seconds, and revalidate enrollment/root/status at receipt time. The reviewer inspected that correction and independently reran the focused suite, including the delayed-by-121-seconds and prior-challenge replay regression. C1 is closed for the prototype interface; actual independent lifecycle custody remains a production prerequisite.

Historical `verifyEvidence` deliberately remains verification of retained signed assertions. Its `createdAt` is a device claim. A backdated signature made after key compromise cannot establish that an operation occurred before revocation. Independent, timely commitments and a defined compromise policy remain required for stronger historical authorization claims. Original evidence is retained.

### MEDIUM C2: an inspection exception could leave an inconsistent RESTRICTED backup report — fixed

After cryptographic success, `verifyBackupArchive` assigned `RESTRICTED`; an exception during content/policy inspection appended a quarantine finding without changing that state. The reviewer changed `restore-verification.mjs:141` to set `QUARANTINED` on every caught verification exception. Successful authenticity and byte-integrity results remain distinct from subsequent inspection failure. Opened plaintext buffers are now cleared in `finally`, including error paths. The regression passes malformed runtime policy input after successful archive authentication and confirms quarantine without falsely calling authenticated bytes corrupted.

### MEDIUM C3: a dot-prefixed nested incident destination bypassed source containment — fixed

The original source-containment check treated every relative path starting with `..` as outside its source. A child named `..incident` therefore passed, permitting an incident directory inside original evidence. The reviewer added a path-component check in `restore-verification.mjs:13` and used it at the preservation source/destination boundaries (`:172`, `:196`). The focused regression rejects `source/..incident`, leaves the source untouched and still permits an external sibling with a dot-prefixed name.

No other introduced CRITICAL/HIGH defect was identified in this review's bounded source and focused-test scope. This does not establish absence of defects.

## Verified behavior

- Device evidence binds tenant, device/key/enrollment, operation identity/type, payload/observation hashes, sequence, prior hash and authorization context. Verification independently recomputes hashes and signatures; the integrated verifier reads raw encrypted evidence rather than accepting caller-provided verified booleans.
- Evidence persistence adds immutable snapshots rather than replacing previous signed events. Prefix verification never claims completeness. The current backup integration verifies one device/key stream; it does not establish an organization-wide independent device roster.
- Witness receipts bind checkpoint scope and digest, verify against caller-pinned keys, and detect supplied chain/digest/boundary inconsistencies. A missing trusted boundary or withheld required receipt fails verification. The local witness labels itself a disposable test double. Both prefix and witness outputs explicitly withhold latestness/completeness claims.
- Backup sealing uses AES-256-GCM, fresh per-archive key/nonce, RSA-OAEP-SHA256 wrapping and a pinned Ed25519 provenance signature. Signature/authentication cover tenant, recipient, metadata, inventory and ciphertext. The verifier keeps authenticity, retained-byte integrity, completeness and availability separate.
- Logical dump reading does not connect to a database. Physical backup support performs limited sidecar/WAL-name/size checks and explicitly does not claim physical restore/PITR or WAL-record validity. The integrated verifier cannot authorize replay, reconstruction or reopen; successful checks remain RESTRICTED.

## Focused verification

| Command | Observed result |
| --- | --- |
| `node --test tools/recovery-v1/backup-readiness.test.mjs` | Initial 18/18 passed; after the two reviewer regressions, 20/20 passed, zero failures/skips. |
| `node --import tsx tools/recovery-v1/integration-smoke.ts` | 8/8 passed before and after reviewer backup corrections. Synthetic keys, test witness and simulated local recipient only. |
| `node_modules/.bin/vitest run src/recovery/evidence.test.ts` | Initial review snapshot: 12/12 passed. |
| `node_modules/.bin/vitest run src/recovery/evidence.test.ts src/recovery/witness.test.ts` | Final reviewed lifecycle/witness snapshot: 21/21 passed, zero failures/skips. Includes absent per-device status, revoked/lost status, delayed response and challenge replay checks. |
| In-memory synthetic `verifyDeviceAuthorization` assertions | 4/4 passed: valid status succeeds; malformed signature, absent trust source and unknown authority root all fail. No keys persisted outside disposable in-memory test stores. |
| `node_modules/.bin/tsc --project tools/recovery-v1/tsconfig.json --noEmit` | Exit 0 after reviewer backup corrections. |

No comprehensive parser/fault/concurrency/cryptographic adversarial suite was run. The reviewer did not independently execute a database restore or validate real host-loss survival.

## Unresolved deployment and architecture prerequisites

These are not repaired by adding cryptographic labels or reporting synthetic tests as independent infrastructure:

1. `custody:"independent"` is an adapter contract, not evidence of independent custody. Production enrollment, lifecycle authority, trust-pin delivery/rotation and owner authorization remain uninstalled. The current write path must stay blocked when those prerequisites are unavailable.
2. WebCrypto non-exportable keys do not attest OS/hardware backing and do not stop malicious code on the same device origin from requesting signatures. Platform-backed signing and client-code trust are separate prerequisites.
3. Valid historical device evidence can still contain server outcome assertions or compromised-device assertions. A signed local timestamp does not prove pre-revocation history or an independently observed database commit.
4. Infrastructure can withhold a newer witness head, entire device stream or transaction tail. Receipt authenticity is not latestness. An independent current-head channel, trusted device roster and custody/availability policy remain necessary.
5. An infrastructure-held provenance signer can produce a newly signed dishonest archive. Independent recipient decryption material and retained device/witness evidence narrow the trust boundary but cannot prove omitted data did not exist.
6. Simulated delivery does not prove that offsite data survives host loss. Real recipient custody, activated delivery/retention, independent retrieval and restore drills remain required. No production key was generated or enrolled.
7. Content hashes, witness heads and successful synthetic round trips cannot reconstruct lost transaction content. Full Supabase restore invariants, complete WAL replay, restored shifts/receipt identities/financial history and all omitted devices remain unresolved.
8. Evidence preservation does not establish source quiescence, freeze pruning or authorize a destructive restore. Operators still need incident containment and independent sealing; source-copy races and filesystem faults require the separately authorized next testing phase.

Production remains NO-GO. No unresolved introduced HIGH/CRITICAL issue was found in the final reviewed snapshot; the independent custody, withheld-history and full-reconstruction limitations above remain explicit. This review supports only the bounded local implementation checkpoint.
