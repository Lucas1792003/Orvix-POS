// ----------------------------------------------------------------------
// Unresolved operations need a decision from a person (Batch 2A correction
// pass). When something about to be sent looks like an operation whose
// outcome is still unknown — a sale re-rung after a lost reply or a
// restart, a supplier payment entered again after "pending confirmation" —
// the data layer never guesses: it asks, through the prompt the app shell
// registers (components/sync/UnresolvedOperationPrompt.tsx).
//
//   "retry"  → resend the EARLIER operation unchanged, with its original
//              idempotency key (the server answers from its ledger if it
//              already has it — nothing is applied twice);
//   "new"    → this is a genuinely separate operation: a new key;
//   "cancel" → do nothing now.
//
// With no prompt registered (tests, early startup) the answer is "cancel":
// the safe default is never to send.
// ----------------------------------------------------------------------

export interface UnresolvedOperationInfo {
  /** What is unresolved, for the person: e.g. "Supplier payment · 50,000 MMK". */
  summary: string;
  /** When the earlier attempt was made (ISO). */
  createdAt: string;
  /** "sale" for checkout; anything else for back-office operations. */
  kind: "sale" | "operation";
}

export interface UnresolvedPromptRequest {
  existing: UnresolvedOperationInfo[];
  /** The earlier operation can be resent unchanged from here. */
  allowRetry: boolean;
  /** A new, separate operation is a legitimate choice here. */
  allowNew: boolean;
}

export type PromptDecision = "retry" | "new" | "cancel";

type PromptHandler = (request: UnresolvedPromptRequest) => Promise<PromptDecision>;
let handler: PromptHandler | null = null;

export function registerOperationPrompt(next: PromptHandler | null): void {
  handler = next;
}

export async function askAboutUnresolved(request: UnresolvedPromptRequest): Promise<PromptDecision> {
  if (!handler) return "cancel";
  try {
    return await handler(request);
  } catch {
    return "cancel";
  }
}

/** The person did not choose to send (or could not be asked). */
export class UnresolvedOperationError extends Error {
  readonly existing: UnresolvedOperationInfo[];
  constructor(message: string, existing: UnresolvedOperationInfo[]) {
    super(message);
    this.name = "UnresolvedOperationError";
    this.existing = existing;
  }
}

/** The outcome is unknown: NOT failed, NOT confirmed. Kept and confirmed
 *  automatically (same idempotency key); the person must not enter it again. */
export class PendingConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PendingConfirmationError";
  }
}

export const isPendingConfirmation = (err: unknown): err is PendingConfirmationError =>
  err instanceof PendingConfirmationError || (err as { name?: string } | null)?.name === "PendingConfirmationError";

export const isUnresolvedOperation = (err: unknown): err is UnresolvedOperationError =>
  err instanceof UnresolvedOperationError || (err as { name?: string } | null)?.name === "UnresolvedOperationError";
