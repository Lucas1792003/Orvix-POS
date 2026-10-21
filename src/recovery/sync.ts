import { localDb } from "../lib/localDb";
import { supabase } from "../lib/supabase";
import { canonical } from "./canonical";
import { listDeviceEvidence, WITNESS_RECEIPT_PREFIX } from "./journalCapture";
import { independentTrustSource, type IndependentTrustSource } from "./trust";
import { createCheckpoint, submitCheckpoint, verifyWitnessReceipt, type WitnessClient, type WitnessReceipt } from "./witness";

/** Evidence-only delivery remains available while financial writes are held.
 * The database labels these opaque records unverified; its acknowledgement
 * neither enrolls a device nor proves completeness or a committed operation. */
export async function uploadRecoveryEvidence(orgId: string, shopId?: string): Promise<{ stored: number; checkpoints: number; verifiedByServer: false }> {
  const { useAuthStore } = await import("../stores/authStore");
  if (!orgId || useAuthStore.getState().currentOrgId !== orgId || !useAuthStore.getState().currentUserId) throw new Error("EVIDENCE_UPLOAD_TENANT_OR_SESSION_MISMATCH");
  const records = await listDeviceEvidence(orgId, shopId);
  let stored = 0;
  for (const record of records) {
    const reply = await supabase.rpc("recovery_v1_store_evidence", { p_envelope: record.envelope });
    const body = reply.data as { outcome?: unknown; verified?: unknown } | null;
    if (reply.error || !body || !["stored", "already_stored"].includes(String(body.outcome)) || body.verified !== false) throw new Error("EVIDENCE_UPLOAD_NOT_ACKNOWLEDGED;LOCAL_ORIGINALS_RETAINED");
    stored++;
  }
  const rows = await localDb.syncState.where("key").startsWith(WITNESS_RECEIPT_PREFIX).toArray();
  let checkpoints = 0;
  for (const row of rows) {
    const receipt = JSON.parse(row.value ?? "null") as WitnessReceipt;
    if (receipt.body.checkpoint.orgId !== orgId || (shopId && receipt.body.checkpoint.shopId !== shopId)) continue;
    const reply = await supabase.rpc("recovery_v1_store_checkpoint", { p_receipt: receipt });
    const body = reply.data as { outcome?: unknown; verified?: unknown } | null;
    if (reply.error || !body || !["stored", "already_stored"].includes(String(body.outcome)) || body.verified !== false) throw new Error("CHECKPOINT_UPLOAD_NOT_ACKNOWLEDGED;LOCAL_ORIGINALS_RETAINED");
    checkpoints++;
  }
  return { stored, checkpoints, verifiedByServer: false };
}

/** Create one checkpoint from the actual immutable device journal prefix and
 * persist the verifiable receipt. Witness absence/failure never fabricates ack.
 * Caller supplies one stream; queued/pending intent is not a committed sale. */
export async function checkpointDeviceEvidence(options: {
  orgId: string; shopId: string; streamId: string; client: WitnessClient | null;
  previous: WitnessReceipt | null; source?: IndependentTrustSource | null;
}): Promise<WitnessReceipt> {
  const source = options.source ?? independentTrustSource();
  if (options.previous && !await verifyWitnessReceipt(options.previous, source, options)) throw new Error("PREVIOUS_WITNESS_RECEIPT_UNVERIFIED");
  const records = (await listDeviceEvidence(options.orgId, options.shopId))
    .filter((r) => `${r.envelope.body.deviceId}:${r.envelope.body.keyId}` === options.streamId);
  const checkpoint = await createCheckpoint(records, source, options, options.previous?.hash ?? null);
  const receipt = await submitCheckpoint(options.client, checkpoint, source);
  const key = WITNESS_RECEIPT_PREFIX + receipt.hash;
  await localDb.transaction("rw", localDb.syncState, async () => {
    const old = await localDb.syncState.get(key);
    if (old) {
      if (old.value !== canonical(receipt)) throw new Error("LOCAL_WITNESS_RECEIPT_CONFLICT");
      return;
    }
    await localDb.syncState.add({ key, value: canonical(receipt), updatedAt: receipt.body.receivedAt });
  });
  return receipt;
}
