/** Synthetic fixtures only. No production authority, enrollment or delivery. */
import { sign, syntheticSigningKey } from "./canonical";
import { enrollSyntheticDevice } from "./deviceVault";
import type { DeviceAuthorizationStatus, Enrollment, IndependentTrustSource, TrustKey } from "./trust";
import { LocalTestWitness, MemoryTestWitnessStore } from "./witness";

export const SYNTHETIC_ORIGIN = "http://127.0.0.1:54321";
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
