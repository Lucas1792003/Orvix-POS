// Shared rules for required free-text reasons (ReasonDialog, stock
// adjustments). Kept out of the component files so they stay
// fast-refresh friendly (see modalDismiss.ts).

export const REASON_MAX_LENGTH = 500;

/** The reason to send, or null when it is blank after trimming. */
export const normalizeReason = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, REASON_MAX_LENGTH) : null;
};
