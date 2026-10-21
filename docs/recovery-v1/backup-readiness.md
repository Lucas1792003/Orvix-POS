# Encrypted backup readiness and recovery verification

This is a local implementation checkpoint. Production recovery and offsite survival remain **NO-GO**. No sender, account, schedule, real key, service, database, retention job or existing backup script was activated or changed.

## Existing behavior verified from source

The existing `deploy/lucashome/backup` implementation remains the operational boundary:

| Component | Actual support | Limitation preserved |
| --- | --- | --- |
| `backup-logical.sh` | PostgreSQL custom dumps, globals/settings, counts, checksums | Hashes and counts alone do not authenticate source financial history. |
| `backup-base.sh` | `pg_basebackup` with `pg_verifybackup`, or SQL backup API with structural checks and required WAL files | SQL API output has no `backup_manifest`; structural checks are weaker than recovery/replay. |
| `email-archive.sh` | Logical dumps, storage/config, manifest, owner-public-key OpenPGP encryption, split parts | Encryption accepts the public key holder's ciphertext; it does not prove who produced truthful contents. Weekly delivery remains disabled. |
| `email-unpack.py` | Part and concatenated ciphertext hashes | Does not establish provenance, latestness or completeness; index hashes can be reproduced by a substitute producer. |
| `dr-verify-restore.sh backup` | `meta.json` logical sets and `MANIFEST.json` unpacked email sets | **Does not support physical `backup.json` sets or PITR.** |
| `tools/recovery-authority/gate.py` | Independently pinned authority series, fresh attestation, restored boundary checks when its prerequisites exist | Existing 087 deployment, independent custody and latest legitimate history are not established by this implementation. |

The rc5 architecture blocker, rejected Gate C review, P0 tooling reality check and P0.1 capability/STOP-and-preserve reports were read from the supplied session scratchpad. Their findings remain applicable: host custody is not independent owner authority; a hash cannot reconstruct lost content; later WAL, hourlies, damaged originals, logs and every surviving offline profile must remain available for investigation. Published v1.0.15 has no operation journal and cannot be retroactively made signed.

## New boundaries and execution

`tools/recovery-v1/backup-archive.mjs` accepts caller-supplied keys and explicit byte files. It seals a canonical envelope with a fresh AES-256-GCM data key and 96-bit nonce, RSA-OAEP-SHA256 key wrapping (3072-bit minimum), and Ed25519 provenance signature. The signature and authenticated header bind organization, shop, schema, format, recovered-as-of UTC time, per-file byte counts/hashes and a signed-device checkpoint boundary. Trust keys are never loaded from the archive. Decryption is released only after authentication succeeds. Tenant/recipient/key mismatch, unsupported schema, unsafe paths and damaged bytes fail closed. This readiness format is bounded to **128 MiB of raw payload**, uses memory, and is not a replacement for streaming operational PostgreSQL backups.

`restore-verification.mjs` verifies the encrypted archive and returns separate authenticity, byte integrity, coverage and availability results. The logical adapter recognizes existing logical and unpacked email file names; it accepts authenticated bytes, not a raw existing OpenPGP archive. Operational integration requires an independently authorized producer to explicitly package those verified files. It never imports credentials, runs the existing backup scripts, reads their environment or sends mail. An explicit absolute `pgRestorePath` enables `pg_restore --file=/dev/null -- <scratch dump>` over the authenticated bytes in a fresh private temporary directory, with no database connection. Missing components, unreadable dump blocks and stale/future metadata produce explicit findings. No caller-provided success flags satisfy this check.

For physical sets it checks required sidecar presence and independently enumerates same-timeline required WAL names from start LSN to **exclusive end LSN**, with PostgreSQL segment/log rollover and exact segment size. Hashes authenticate retained byte content relative to the pinned producer. This does **not** validate WAL records or prove replay succeeds. Cross-timeline history, physical extraction, `pg_verifybackup`, target-time correctness and physical/PITR restore remain unsupported and block a completeness verdict. It never passes a base set to the existing logical verifier.

`verify-recovery.ts` is the integrated entry point. It decrypts the archive, takes device evidence from authenticated `recovery/device-evidence.json`, and verifies enrollment, device signatures, full retained stream prefix and actual witness receipts with externally supplied trust pins. It re-derives the checkpoint commitment and binds it to the backup boundary. `recovery/committed-outcomes.json` uses protocol `orvix-restored-operation-outcomes-v1`, organization/shop and rows `{operationId,rpc,payloadHash,responseHash,originalCreatedAt}`. Rows must match exact signed committed-device observations, including original creation time, full request hash and retained response hash. The manifest represents captured outcome **assertions**, not a live query or a full restored financial ledger audit. A device can sign what the server claimed; neither its signature nor this manifest establishes an independently observed database commit.

The optional offline manifest uses protocol `orvix-offline-preservation-v1`, organization/shop and `devices:[{deviceId,records}]`. Every supplied stream is cryptographically verified. Later offline evidence is retained as unresolved operations; it is never merged into committed history or replayed. A contradictory prefix quarantines the assessment. A missing device roster means lost/withheld devices cannot be excluded. Missing evidence, invalid signatures, withheld trusted receipts or inconsistent boundaries quarantine the assessment; successful checks keep it **RESTRICTED**. The verifier cannot authorize reopening, retries, reconstruction, re-entry, receipt reuse, physical stock correction or release owner authority. Database evidence ingestion must treat its report as an untrusted operator artifact until independently authorized; the report is not a release credential.

## Email-archive integration (correction pass P6)

**The exact gap.** The weekly email archive (`email-archive.sh`) and the V1 envelope are two independent formats:

| | Email archive (existing) | V1 envelope (new) |
|---|---|---|
| Encryption | OpenPGP to the owner's public key (gpg, AES-256, MDC) | AES-256-GCM + RSA-OAEP-3072 key wrap |
| Integrity | `SHA256SUMS`, `MANIFEST.json`, per-part and total hashes in `INDEX.txt` / `index.json` | AES-GCM tag + Ed25519 provenance signature over the canonical header and per-file hashes |
| Who can produce a valid one | Anyone holding the owner's public key, including the server that builds it | Only the holder of the pinned provenance private key |
| Tenant binding | None (whole database) | Organization and shop in the authenticated header |
| Financial evidence boundary | None | Signed device-checkpoint boundary |
| Delivery | Mail provider (disabled; cron commented out) | None (local or simulated recipient only) |

So an email archive proves confidentiality to the owner and byte integrity of what the server put in it. It proves neither who produced the contents nor that they are complete or latest.

**Provenance and tenant labels (review round 2).** A V1 envelope's organization and shop fields bind the LABEL, not the contents. A logical dump or email archive holds every tenant, roles and auth data, and the verifier reports `TENANT_LABEL_ONLY_CONTENTS_MAY_INCLUDE_OTHER_TENANTS`. Provenance is an allow-list. The report carries `signatureVerified` for the packager's signature, and `authenticity` stays `unverified` for an `infrastructure-source` archive (every repackaged email archive), with `CONTENT_PRODUCED_BY_INFRASTRUCTURE_PROVENANCE_UNVERIFIED`. `backupAssessmentInput` passes `authenticity: verified` to the recovery assessment only for the synthetic `local-test` label, which carries `PROVENANCE_LOCAL_TEST_LABEL_SYNTHETIC_ONLY`. A missing, unknown or infrastructure label is always unverified. There is no label yet for an independently produced backup; that needs an independent producer. Two limits remain: `local-test` is accepted on any format, so whoever holds the pinned packaging key can self-label a real dump. And `backupAssessmentInput` trusts the report object it is given. The assessment never returns ACTIVE, so neither can reopen anything.

**What is now implemented.** `tools/recovery-v1/email-archive-adapter.mjs` runs on the owner's device, after `email-unpack.py` has reassembled and hash-checked the parts and the owner has decrypted the archive with `gpg` and checked its exit status. It reads the extracted tree without following links and re-verifies the archive's own `SHA256SUMS` and `MANIFEST.json`, exactly as `email-archive.sh` wrote them. Any mismatch, unlisted file, missing listed file, link or special file refuses packaging. It then seals the verified files into a V1 envelope with `format: logical-pg-custom` and `provenanceCustody: infrastructure-source`, so the report says honestly that the producer was the server. `restore-verification.mjs` then verifies it like any other logical set. Tests: `email-archive-adapter.test.mjs` (8/8, synthetic trees in the exact email layout, in-memory keys).

**What is still not integrated, and why.**
- The adapter does not verify OpenPGP. gpg does that on the owner's device; the adapter starts from its output.
- The server-side producer is unchanged. `email-archive.sh` still builds and (when enabled) sends the OpenPGP archive. Making the server emit a V1 envelope would put the provenance key on the infrastructure, which defeats its purpose.
- The adapter is stricter than `email-archive.sh` in a few cases. Each of these is a refusal, never a silent pass:
  - non-root files named `MANIFEST.json` or `SHA256SUMS`;
  - symlinks that `cp -a` copied under `config/`;
  - file names outside `[A-Za-z0-9._/-]` and escaped `sha256sum` lines.
- **Size.** It reads the whole tree into memory, and the V1 envelope is capped at 128 MiB of payload. The email tier allows up to 12 × 15 MiB = 180 MiB, so a full-size email archive cannot be packaged yet; that needs a streaming envelope.
- **Read race.** A concurrent local process could swap a file between the walk and the read. Run it only in a private directory.
- Nothing is sent. Email delivery stays disabled, no account is connected, and no production key exists. Offsite survival of either format is **not established**; a local or simulated recipient proves nothing about a mailbox surviving host loss.

```sh
node --test tools/recovery-v1/email-archive-adapter.test.mjs
node --test tools/recovery-v1/backup-readiness.test.mjs
node --import tsx tools/recovery-v1/integration-smoke.ts
node_modules/.bin/tsc --project tools/recovery-v1/tsconfig.json --noEmit
node_modules/.bin/eslint tools/recovery-v1/verify-recovery.ts tools/recovery-v1/integration-smoke.ts
```

The smoke runs entirely on synthetic in-memory keys, one signed device stream, a local test witness, a simulated directory recipient and disposable plaintext files. `backup-fixture-roundtrip.mjs ABS_SYNTHETIC_INPUT_DUMP ABS_NEW_OUTPUT_DUMP ABS_NEW_SIMULATED_MAILBOX_DIR ABS_PG_RESTORE` connects an isolated synthetic `pg_dump` fixture to authenticated encrypted storage and byte-identical decryption. The SQL harness can then restore that output to its own disposable database and compare queried rows. This verifies a synthetic PostgreSQL round trip, not full Supabase disaster recovery.

## Preservation and custody

`planEvidencePreservation` inventories explicit local evidence sources read-only, refuses links/special files and destinations inside a source, checks observed free disk, and reports missing categories. `preserveEvidence` copies later WAL, later dumps, damaged originals, logs and offline evidence into a **new** private incident directory. It compares source/copy hashes and source stat before/after; outputs are create-only, 0600 files under 0700 directories. Historical originals and existing incident directories are not overwritten. A failed attempt leaves its partial evidence directory for investigation. Hashes prove copied bytes, not independent provenance or source quiescence. Live files can change while copied; the manifest explicitly says quiescence is unverified. Incident containment, stopped writers, repeated WAL snapshots, prune freeze, sufficient safety headroom and independent sealing remain separate operational prerequisites. Keep incident directories outside temporary/build outputs and existing prune-managed backup roots; the library does not freeze retention, stop services or authorize a destructive restore.

Key custody has three distinct roles:

1. Device keys stay on devices and enrollment authority must be independently pinned; server presentation alone is insufficient.
2. The backup provenance producer signs its own capture. A compromised producer holding that signing key can forge a new backup. Device/witness verification can expose inconsistencies in retained signed material, but cannot certify omitted material or source truth.
3. The recipient's decryption material must remain outside infrastructure custody. Metadata saying `independently-held-required` is a requirement, never proof. No production key loader, production key generation, owner enrollment or independence attestation is installed here. All exercised keys are disposable local test keys.

The simulated recipient writes ciphertext into a fresh file only. Its receipt explicitly says independent availability is unestablished. Real host-loss survival requires activation, externally controlled storage/mailbox retention, separately pinned/enrolled keys, retrieval from the actual recipient and independent restore drills. Losing every decryption key makes authenticated ciphertext unavailable; losing a checkpoint does not recreate its committed contents. Rotation must retain old recipient private keys for the entire archive retention window, preserve old pinned provenance/enrollment/witness keys and signed revocations, and create a separately authorized successor. The implementation never silently replaces a missing key.

## Cadence, retention and data-loss window

Current repository configuration specifies logical dumps hourly (`:15`, retain 48 hourly / 14 daily / 8 weekly), daily physical base (`02:30 UTC`, retain 14), continuous local WAL with five-minute archive timeout, and weekly local restore drills. These are repository procedures, not newly observed deployed status. The weekly email schedule is commented out (`Sunday 04:30 UTC`, retain 4 encrypted local builds). Offsite synchronization is disabled and its cron entries are commented out. Existing reports say the email tier has no operational proof; this implementation changes none of those facts.

If separately enabled and retrieval verified, weekly email archives imply up to approximately **7 days plus delivery delay** of offsite data loss; a missed archive extends that interval. Hourly local dumps imply up to one hour plus job delay; local WAL can narrow local recovery loss only while complete required bytes survive and replay is validated. Host loss can destroy all local dumps/WAL together. No numerical RPO is guaranteed by schedules alone. Witness heads or hashes can identify a missing boundary without retaining transaction content. Keep required WAL at least from the oldest retained base, preserve all incident/post-target material outside automatic pruning, and retain decryption keys for every retained archive. Restoring a healthy backup does not prove current inventory, profits, payments, open/restored shifts or receipt uniqueness.

Primary API references: [Node 22 crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html), [PostgreSQL pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html). Script 2 should exhaustively examine trust-pin substitution/rotation/revocation, archive length/path/parser limits, disk failure/copy races, all dump corruption classes, WAL discontinuities and timeline changes, withheld receipts, malformed/forked offline evidence, missing device inventories and real isolated Supabase restore invariants. None of those future tests is claimed complete here.
