import { closeWouldExpect, fetchFinShiftReconciliation } from "../reports/finReports";

/**
 * Just before a close is sent: ask the server for the open shift's expected
 * cash again. If it moved since the form showed it (a refund was approved
 * meanwhile), the person must look again — the close is not sent. When the
 * server cannot answer (offline, timeout, recovery) the close proceeds on the
 * figure shown (the backend recomputes expected cash when it applies the close).
 */
export async function checkExpectedBeforeClose(
  shiftId: string,
  shownExpectedMmk: number,
): Promise<{ proceed: true } | { proceed: false; latestMmk: number }> {
  const r = await fetchFinShiftReconciliation(shiftId);
  const latest = r.status === "ok" ? closeWouldExpect(r.data) : null;
  if (latest === null) return { proceed: true };
  return latest === shownExpectedMmk ? { proceed: true } : { proceed: false, latestMmk: latest };
}

/**
 * The variance-reason rule for a close: a reason is needed when the closing
 * count differs from the expected cash the form shows OR from this device's
 * estimate (an offline close on a pre-087 server is staged against the
 * device estimate, shiftSlice.stageCloseShift). Returns an error or null.
 */
export const extraReasonError = (input: {
  closingCash: number | undefined;
  shownExpectedMmk: number;
  deviceExpectedMmk: number | null | undefined;
  varianceReason: string;
}): string | null => {
  const { closingCash, shownExpectedMmk, deviceExpectedMmk, varianceReason } = input;
  if (closingCash === undefined || deviceExpectedMmk === null || deviceExpectedMmk === undefined) return null;
  if (deviceExpectedMmk === shownExpectedMmk || closingCash === deviceExpectedMmk) return null;
  return varianceReason.trim() === ""
    ? "Enter a variance reason: this device's own estimate of expected cash differs from the count (needed if the close is sent offline)."
    : null;
};
