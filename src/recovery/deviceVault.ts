import Dexie, { type Table } from "dexie";
import { digest, sign, syntheticSigningKey, verify } from "./canonical";
import { independentTrustSource, TrustUnavailable, verifyDeviceAuthorization, verifyEnrollment, type Enrollment, type IndependentTrustSource } from "./trust";

export interface DeviceIdentity {
  scope: string;
  privateKey: CryptoKey;
  publicKey: string;
  enrollment: Enrollment;
  createdAt: string;
}

/** Separate additive store: structured clone retains nonexportable CryptoKey.
 * It is never part of a snapshot replace, sign-out, queue cleanup or export.
 * WebCrypto does not attest hardware/OS backing or resist malicious same-origin
 * code using sign(); platform integration is a deployment prerequisite. */
class DeviceVault extends Dexie {
  identities!: Table<DeviceIdentity, string>;
  constructor() {
    super("orvix-recovery-device-v1");
    this.version(1).stores({ identities: "scope" });
  }
}
export const deviceVault = new DeviceVault();
export const deviceScope = (origin: string, orgId: string, shopId: string): string => JSON.stringify([origin, orgId, shopId]);

/** Explicit synthetic enrollment workflow. There is deliberately no automatic
 * enrollment, key replacement, revocation reset or production key generator. */
export async function enrollSyntheticDevice(input: {
  origin: string; orgId: string; shopId: string; deviceId: string;
  authorize: (request: { publicKey: string; keyId: string; deviceId: string }) => Promise<Enrollment>;
  source: IndependentTrustSource;
  now?: string;
}): Promise<DeviceIdentity> {
  if (input.source.custody !== "synthetic-test-only") throw new TrustUnavailable("This enrollment helper permits synthetic test credentials only.");
  const scope = deviceScope(input.origin, input.orgId, input.shopId);
  if (await deviceVault.identities.get(scope)) throw new TrustUnavailable("A device identity already exists. Rotation/loss needs a separately authorized enrollment; nothing was replaced.");
  const pair = await syntheticSigningKey();
  const enrollment = await input.authorize({ publicKey: pair.publicKey, keyId: pair.keyId, deviceId: input.deviceId });
  const at = input.now ?? new Date().toISOString();
  const b = enrollment.body;
  if (!await verifyEnrollment(enrollment, input.source, at) || b.orgId !== input.orgId || b.shopId !== input.shopId || b.deviceId !== input.deviceId
    || b.publicKey !== pair.publicKey || b.keyId !== pair.keyId) throw new TrustUnavailable("Enrollment does not authorize this device key and tenant.");
  const row: DeviceIdentity = { scope, ...pair, enrollment, createdAt: at };
  // add(), never put(): racing enrollment cannot overwrite an identity.
  await deviceVault.identities.add(row);
  return row;
}

export async function enrolledDevice(origin: string, orgId: string, shopId: string, now: () => string = () => new Date().toISOString()): Promise<DeviceIdentity> {
  const at = now();
  const source = independentTrustSource();
  if (!source) throw new TrustUnavailable();
  const identity = await Dexie.ignoreTransaction(() => deviceVault.identities.get(deviceScope(origin, orgId, shopId)));
  if (!identity || identity.privateKey.extractable || identity.privateKey.type !== "private" || identity.privateKey.algorithm.name !== "ECDSA"
    || !await verifyEnrollment(identity.enrollment, source, at) || await digest(identity.publicKey) !== identity.enrollment.body.keyId
    || identity.publicKey !== identity.enrollment.body.publicKey) throw new TrustUnavailable("Device identity is missing, revoked, expired or unreadable. It will not be regenerated. Preserve this profile and its journal.");
  // Ensure restored/corrupted structured keys really match the enrolled public key.
  const challenge = { protocol: "orvix-device-key-check-v1", scope: identity.scope };
  if (!await verify(challenge, await sign(challenge, identity.privateKey), identity.publicKey)) throw new TrustUnavailable("Stored signing key does not match the independent enrollment.");
  if (!source.deviceStatus) throw new TrustUnavailable("Independent current device authorization is unavailable. An old enrollment certificate cannot reinstate a lost or revoked key.");
  const nonce = crypto.randomUUID();
  const status = await source.deviceStatus({ enrollment: identity.enrollment, challenge: nonce, now: at });
  const receivedAt = now();
  if (Date.parse(receivedAt) < Date.parse(at) || Date.parse(receivedAt) - Date.parse(at) > 120_000
    || !await verifyEnrollment(identity.enrollment, source, receivedAt)
    || !await verifyDeviceAuthorization(status, identity.enrollment, source, nonce, receivedAt)) throw new TrustUnavailable("Device authorization is revoked, lost, retired, stale or unverified. Independent reinstatement is required; nothing was regenerated.");
  return identity;
}
