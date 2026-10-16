// Desktop QR modal (ProductImagePhoneUploadModal): what a close request does.
//
// Closing the modal while the session is PENDING cancels it on the server
// (cancel_product_image_upload_session), and the phone is then told "This
// upload link was cancelled on the computer". In one e2e run (D300,
// docs/selfhost-migration/phase-f/app-bugfixes.md) that happened with no
// test step touching the desktop. The modal had closed on Escape (any
// keydown on the window, trusted or not) and on any click that ended on the
// backdrop, including a press that started inside the dialog. So:
//
//  - the explicit buttons (footer "Close", header X, and "Stop upload" in
//    the confirmation) cancel and close at once, as before;
//  - the implicit dismissals (Escape, backdrop click) only ask "Stop this
//    phone upload?" while a session is PENDING; nothing is cancelled unless
//    the user then presses "Stop upload";
//  - when nothing is pending they just close (there is nothing to cancel);
//  - unmounting never cancels (the session simply expires on the server).
//
// Every close request while PENDING is logged with a "[phone-upload]"
// console marker (formatPhoneUploadCloseMarker) so a recurrence names its
// trigger.

export type PhoneUploadCloseTrigger =
  | "close-button" // footer "Close" / "Use this image"
  | "x-button" // header X
  | "confirm-stop" // "Stop upload" in the confirmation
  | "escape" // Escape keydown on the window
  | "backdrop"; // a click that started and ended on the backdrop

export type PhoneUploadCloseDecision =
  | { action: "close"; cancel: boolean }
  | { action: "confirm" };

const EXPLICIT: ReadonlySet<PhoneUploadCloseTrigger> = new Set(["close-button", "x-button", "confirm-stop"]);

export const isExplicitPhoneUploadClose = (trigger: PhoneUploadCloseTrigger): boolean => EXPLICIT.has(trigger);

export function decidePhoneUploadClose(
  trigger: PhoneUploadCloseTrigger,
  state: { pendingSession: boolean },
): PhoneUploadCloseDecision {
  if (!state.pendingSession) return { action: "close", cancel: false };
  if (isExplicitPhoneUploadClose(trigger)) return { action: "close", cancel: true };
  return { action: "confirm" };
}

export interface PhoneUploadCloseContext {
  trigger: PhoneUploadCloseTrigger | "unmount";
  decision: PhoneUploadCloseDecision | { action: "none" };
  sessionId?: string;
  phase: string;
  /** Seconds since the QR was shown, if known. */
  shownForS?: number;
  secondsLeft?: number;
  /** Event.isTrusted of the DOM event behind the request (false = dispatched by script). */
  trusted?: boolean;
  visibility?: string;
  hasFocus?: boolean;
}

/** One-line console marker; the session id is cut to its last 6 characters. */
export function formatPhoneUploadCloseMarker(c: PhoneUploadCloseContext): string {
  const decision =
    c.decision.action === "close" ? (c.decision.cancel ? "cancel+close" : "close") : c.decision.action;
  const parts = [
    `[phone-upload] close requested trigger=${c.trigger}`,
    `decision=${decision}`,
    `phase=${c.phase}`,
    `session=${c.sessionId ? `...${c.sessionId.slice(-6)}` : "none"}`,
  ];
  if (c.shownForS !== undefined) parts.push(`shown=+${c.shownForS}s`);
  if (c.secondsLeft !== undefined) parts.push(`left=${c.secondsLeft}s`);
  if (c.trusted !== undefined) parts.push(`trusted=${c.trusted}`);
  if (c.visibility !== undefined) parts.push(`visibility=${c.visibility}`);
  if (c.hasFocus !== undefined) parts.push(`focus=${c.hasFocus}`);
  return parts.join(" ");
}
