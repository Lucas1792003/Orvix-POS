import { digest, isId, isTime, verify } from "./canonical";

export interface TrustKey {
  keyId: string;
  publicKey: string;
  purpose: "device-enrollment" | "witness";
  orgId: string;
  notBefore: string;
  notAfter: string;
  revokedAt: string | null;
}

/** The implementation of this boundary must obtain pinned keys through
 * independent custody. An RPC response, Control login or ADMIN role is not
 * an implementation. No production adapter is installed by this change. */
export interface IndependentTrustSource {
  readonly custody: "independent" | "synthetic-test-only";
  keys(): Promise<readonly TrustKey[]>;
  /** Fresh challenge-bound status from independent owner custody. No installed
   * implementation means no CURRENT device authorization, even if an old
   * enrollment certificate still verifies historically. */
  deviceStatus?(request: { enrollment: Enrollment; challenge: string; now: string }): Promise<DeviceAuthorizationStatus>;
}

export interface DeviceAuthorizationStatus {
  body: {
    protocol: "orvix-device-authorization-v1";
    enrollmentId: string; orgId: string; shopId: string; deviceId: string; keyId: string;
    authorityKeyId: string; challenge: string;
    state: "ACTIVE" | "REVOKED" | "LOST" | "RETIRED";
    revision: number; issuedAt: string; expiresAt: string;
  };
  signature: string;
}

/** Historical signatures have claimed local times. Current authorization uses
 * a fresh unpredictable challenge; an old ACTIVE status cannot be replayed. */
export async function verifyDeviceAuthorization(status: DeviceAuthorizationStatus, enrollment: Enrollment, source: IndependentTrustSource | null, challenge: string, now: string): Promise<boolean> {
  try {
    const b = status.body;
    const e = enrollment.body;
    if (b.protocol !== "orvix-device-authorization-v1" || b.state !== "ACTIVE" || b.challenge !== challenge || b.enrollmentId !== e.enrollmentId
      || b.orgId !== e.orgId || b.shopId !== e.shopId || b.deviceId !== e.deviceId || b.keyId !== e.keyId || b.authorityKeyId !== e.authorityKeyId
      || !Number.isSafeInteger(b.revision) || b.revision < 1 || !isTime(b.issuedAt) || !isTime(b.expiresAt) || !isTime(now)
      || Date.parse(b.issuedAt) > Date.parse(now) || Date.parse(b.expiresAt) < Date.parse(now)
      || Date.parse(b.expiresAt) - Date.parse(b.issuedAt) > 120_000) return false;
    const root = await trustedKey(source, b.authorityKeyId, "device-enrollment", b.orgId, now);
    return !!root && await verify(b, status.signature, root.publicKey);
  } catch { return false; }
}

export interface Enrollment {
  body: {
    protocol: "orvix-device-enrollment-v1";
    enrollmentId: string;
    orgId: string;
    shopId: string;
    deviceId: string;
    keyId: string;
    publicKey: string;
    authorityKeyId: string;
    notBefore: string;
    notAfter: string;
    /** An independently signed revocation record is needed to update this
     * certificate. Infrastructure changing a local status never establishes trust. */
    revokedAt: string | null;
    replacesEnrollmentId: string | null;
  };
  signature: string;
}

export class TrustUnavailable extends Error {
  constructor(message = "Independent device enrollment is unavailable. Existing evidence is preserved; financial operations remain restricted.") {
    super(message); this.name = "TrustUnavailable";
  }
}

export async function trustedKey(source: IndependentTrustSource | null, keyId: string, purpose: TrustKey["purpose"], orgId: string, at: string): Promise<TrustKey | null> {
  if (!source || !isTime(at)) return null;
  const keys = await source.keys();
  const matches = keys.filter((k) => k.keyId === keyId && k.purpose === purpose && k.orgId === orgId);
  if (matches.length !== 1) return null;
  const k = matches[0];
  if (!isTime(k.notBefore) || !isTime(k.notAfter) || Date.parse(k.notBefore) > Date.parse(at) || Date.parse(k.notAfter) < Date.parse(at)
    || (k.revokedAt !== null && (!isTime(k.revokedAt) || Date.parse(k.revokedAt) <= Date.parse(at)))) return null;
  if (await digest(k.publicKey) !== k.keyId) return null;
  return k;
}

export async function verifyEnrollment(enrollment: Enrollment, source: IndependentTrustSource | null, at: string): Promise<boolean> {
  try {
    const b = enrollment.body;
    if (b.protocol !== "orvix-device-enrollment-v1" || ![b.enrollmentId, b.orgId, b.shopId, b.deviceId].every(isId)
      || !isTime(b.notBefore) || !isTime(b.notAfter) || !isTime(at) || b.notBefore > at || b.notAfter < at
      || (b.revokedAt !== null && (!isTime(b.revokedAt) || b.revokedAt <= at)) || await digest(b.publicKey) !== b.keyId) return false;
    const root = await trustedKey(source, b.authorityKeyId, "device-enrollment", b.orgId, at);
    return !!root && await verify(b, enrollment.signature, root.publicKey);
  } catch { return false; }
}

/** No TOFU fallback: this source must be explicitly injected from independent
 * custody. Calling code must not derive it from the recovering server. */
let configuredSource: IndependentTrustSource | null = null;
export const independentTrustSource = (): IndependentTrustSource | null => configuredSource;
export function configureIndependentTrust(source: IndependentTrustSource | null): void { configuredSource = source; }
