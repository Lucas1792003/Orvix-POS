import { isPendingConfirmation, isUnresolvedOperation } from "../stores/data/operationPrompt";

// How a form/dialog must react when a financial submit did NOT simply
// succeed (v87.x store contract: stores/data/onlineOnly.ts, writeAhead.ts).
//
//  "pending"  — the outcome is unknown: it may already be recorded. It is kept
//               with its original key and confirmed by the till itself. The
//               form CLOSES and must not be submitted again (a new submit
//               would be a new operation with a new key).
//  "not-sent" — an earlier attempt of the same operation is still unresolved
//               and the person chose not to send, or it could not be decided:
//               nothing was sent. The form STAYS OPEN with what was typed.
//  "failed"   — a confirmed failure: the server refused it, or it was never
//               sent (offline / recovery safeguard on an 087 server:
//               "Not recorded — nothing was saved"). Nothing was recorded.
//               The form STAYS OPEN for a deliberate retry.
//
// The UI never retries by itself; a retry is always the person pressing the
// button again, and the store's own unresolved-attempt check (the same key
// first) applies to it.
export type SubmitFailure = "pending" | "not-sent" | "failed";

export const classifySubmitFailure = (err: unknown): SubmitFailure => {
  if (isPendingConfirmation(err)) return "pending";
  if (isUnresolvedOperation(err)) return "not-sent";
  return "failed";
};
