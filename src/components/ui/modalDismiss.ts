/** Why a Modal asked to close. Callers that do not care ignore it. */
export type ModalCloseReason = "escape" | "backdrop" | "x-button";

export interface ModalCloseDetail {
  /** Event.isTrusted: false when the event was dispatched by script. */
  trusted: boolean;
}

/**
 * A backdrop click dismisses only when the press STARTED on the backdrop as
 * well. A click event targets the nearest common ancestor of the mousedown
 * and mouseup targets, so selecting text in the dialog and releasing outside
 * it used to arrive as a "click on the backdrop" and close the modal.
 */
export function isBackdropDismiss(pressStartedOnBackdrop: boolean, target: EventTarget | null, backdrop: EventTarget | null): boolean {
  return pressStartedOnBackdrop && target !== null && target === backdrop;
}

/** Escape closes, except while an IME composition is in progress. */
export function isEscapeDismiss(event: Pick<KeyboardEvent, "key" | "isComposing">): boolean {
  return event.key === "Escape" && !event.isComposing;
}
