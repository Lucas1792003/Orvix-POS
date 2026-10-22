/** Synthetic fixtures only. No production authority, enrollment or delivery. */
import { sign, syntheticSigningKey } from "./canonical";
import { enrollSyntheticDevice } from "./deviceVault";
import type { DeviceAuthorizationStatus, Enrollment, IndependentTrustSource, TrustKey } from "./trust";
import { LocalTestWitness, MemoryTestWitnessStore } from "./witness";

export const SYNTHETIC_ORIGIN = "http://127.0.0.1:54321";

/** Step 5: a SYNTHETIC owner-approved till for unit tests. The owner key is generated here (test only) and pinned as this
 *  process's trust anchor; the approval is a genuinely signed enroll-device authorization, verified by the real
 *  verifyApproval before the till is stored. No server is involved: lastStatus is recorded as ACTIVE "now". */
export async function installSyntheticTrustedTill(input: { origin?: string; orgId?: string; shopId?: string } = {}) {
  const dt = await import("./deviceTrust");
  const origin = input.origin ?? SYNTHETIC_ORIGIN; const orgId = input.orgId ?? "org-1"; const shopId = input.shopId ?? "shop-1";
  const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
  const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");
  const nHex = async (k: CryptoKey) => { const j = await crypto.subtle.exportKey("jwk", k); return hex(Uint8Array.from(atob(j.n!.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((j.n!.length + 3) % 4)), (c) => c.charCodeAt(0)).buffer).replace(/^0+/, ""); };
  const owner = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"]) as CryptoKeyPair;
  const ownerN = await nHex(owner.publicKey); const ownerFp = await dt.keyFingerprint(ownerN);
  dt.setOwnerTrustAnchorsForTests([ownerFp]);
  const signing = await crypto.subtle.generateKey(RSA, false, ["sign", "verify"]) as CryptoKeyPair;
  const evidence = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]) as CryptoKeyPair;
  const publicN = await nHex(signing.publicKey); const fingerprint = await dt.keyFingerprint(publicN);
  const deviceId = `till-${crypto.randomUUID()}`; const requestId = crypto.randomUUID(); const requestNonce = crypto.randomUUID();
  const notAfter = new Date(Date.now() + 365 * 86400_000).toISOString();
  const authorization = JSON.stringify({ protocol: "orvix-owner-authorization-v1", purpose: "enroll-device", keyId: "synthetic-owner", scope: orgId,
    device: { requestId, orgId, shopId, deviceId, keyFingerprint: fingerprint, requestNonce, notAfter, replacesEnrollmentId: null } });
  const signature = await dt.rsaSignHex(owner.privateKey, authorization);
  const till = { scope: dt.tillScope(origin, orgId, shopId), origin, orgId, shopId, deviceId, signingKey: signing.privateKey, publicN, fingerprint,
    evidenceKey: evidence.privateKey, evidencePublicKey: "synthetic-evidence-spki", requestId, requestNonce, requestText: "{}", requestSig: "00",
    replacesEnrollmentId: null, createdAt: new Date().toISOString(), nextCounter: 1, enrollment: null, lastStatus: null };
  const enrollment = await dt.verifyApproval(till, { ownerKey: { keyId: "synthetic-owner", n: ownerN, e: 65537, fingerprint: ownerFp, scope: "*" },
    authorization, signature, enrollmentId: requestId }, [ownerFp]);
  if (!enrollment) throw new Error("synthetic approval did not verify");
  await dt.tillVault.tills.put({ ...till, enrollment, lastStatus: { state: "ACTIVE", checkedAt: Date.now() } });
  return { ...till, enrollment, ownerKey: owner, ownerFingerprint: ownerFp };
}
export async function syntheticRecoveryFixture(input: { orgId?: string; shopId?: string; deviceId?: string; origin?: string } = {}) {
  const orgId = input.orgId ?? "org-1";
  const shopId = input.shopId ?? "shop-1";
  const deviceId = input.deviceId ?? "synthetic-device-1";
  const root = await syntheticSigningKey();
  const witnessKey = await syntheticSigningKey();
  const keys: TrustKey[] = [
    { ...root, purpose: "device-enrollment", orgId, notBefore: "2020-01-01T00:00:00.000Z", notAfter: "2099-01-01T00:00:00.000Z", revokedAt: null },
    { ...witnessKey, purpose: "witness", orgId, notBefore: "2020-01-01T00:00:00.000Z", notAfter: "2099-01-01T00:00:00.000Z", revokedAt: null },
  ].map(({ privateKey: _private, ...key }) => { void _private; return key; }) as TrustKey[];
  const deviceStates = new Map<string, DeviceAuthorizationStatus["body"]["state"]>();
  const source: IndependentTrustSource = { custody: "synthetic-test-only", keys: async () => keys,
    deviceStatus: async ({ enrollment, challenge, now }) => {
      const e = enrollment.body;
      const body: DeviceAuthorizationStatus["body"] = {
        protocol: "orvix-device-authorization-v1", enrollmentId: e.enrollmentId, orgId: e.orgId, shopId: e.shopId, deviceId: e.deviceId,
        keyId: e.keyId, authorityKeyId: root.keyId, challenge, state: deviceStates.get(e.enrollmentId) ?? "ACTIVE", revision: 1,
        issuedAt: now, expiresAt: new Date(Date.parse(now) + 60_000).toISOString(),
      };
      return { body, signature: await sign(body, root.privateKey) };
    },
  };
  const identity = await enrollSyntheticDevice({ origin: input.origin ?? SYNTHETIC_ORIGIN, orgId, shopId, deviceId, source,
    authorize: async ({ publicKey, keyId }) => {
      const body: Enrollment["body"] = {
        protocol: "orvix-device-enrollment-v1", enrollmentId: `synthetic-enrollment-${deviceId}`, orgId, shopId, deviceId, keyId, publicKey,
        authorityKeyId: root.keyId, notBefore: "2020-01-01T00:00:00.000Z", notAfter: "2099-01-01T00:00:00.000Z", revokedAt: null, replacesEnrollmentId: null,
      };
      return { body, signature: await sign(body, root.privateKey) };
    },
  });
  const store = new MemoryTestWitnessStore();
  const witness = new LocalTestWitness({ witnessId: "synthetic-witness-only", ...witnessKey, store });
  return { source, keys, identity, witness, store, root, witnessKey, orgId, shopId, deviceStates };
}
