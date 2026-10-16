import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decidePhoneUploadClose,
  formatPhoneUploadCloseMarker,
  isExplicitPhoneUploadClose,
  type PhoneUploadCloseTrigger,
} from "./phoneUploadClose";
import { isBackdropDismiss, isEscapeDismiss } from "../components/ui/modalDismiss";

// D300 (docs/selfhost-migration/phase-f/app-bugfixes.md): only an explicit
// close may cancel a PENDING phone-upload session. The component behaviour
// (real React under StrictMode, 300 s of fake time with re-renders, focus /
// visibility events, unmount / re-key, every trigger) is exercised in a real
// browser by tools/phone-modal-harness/run.mjs; this suite pins the rules.

const ALL: PhoneUploadCloseTrigger[] = ["close-button", "x-button", "confirm-stop", "escape", "backdrop"];

describe("decidePhoneUploadClose", () => {
  it("explicit buttons cancel and close a PENDING session", () => {
    for (const t of ["close-button", "x-button", "confirm-stop"] as const) {
      expect(isExplicitPhoneUploadClose(t)).toBe(true);
      expect(decidePhoneUploadClose(t, { pendingSession: true })).toEqual({ action: "close", cancel: true });
    }
  });

  it("Escape and a backdrop click only ask while PENDING (never cancel)", () => {
    for (const t of ["escape", "backdrop"] as const) {
      expect(isExplicitPhoneUploadClose(t)).toBe(false);
      expect(decidePhoneUploadClose(t, { pendingSession: true })).toEqual({ action: "confirm" });
    }
  });

  it("with nothing pending every trigger just closes, nothing to cancel", () => {
    for (const t of ALL) {
      expect(decidePhoneUploadClose(t, { pendingSession: false })).toEqual({ action: "close", cancel: false });
    }
  });

  it("300 s of repeated implicit dismissals never produce a cancel", () => {
    vi.useFakeTimers();
    try {
      const decisions: string[] = [];
      for (let s = 0; s < 300; s++) {
        vi.advanceTimersByTime(1_000);
        decisions.push(decidePhoneUploadClose(s % 2 ? "escape" : "backdrop", { pendingSession: true }).action);
      }
      expect(new Set(decisions)).toEqual(new Set(["confirm"]));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("formatPhoneUploadCloseMarker", () => {
  it("names trigger, decision, trust, visibility and focus; the session id is cut", () => {
    const m = formatPhoneUploadCloseMarker({
      trigger: "escape",
      decision: { action: "confirm" },
      sessionId: "pius-0123456789abcdef",
      phase: "PENDING",
      shownForS: 287,
      secondsLeft: 313,
      trusted: false,
      visibility: "visible",
      hasFocus: true,
    });
    expect(m).toBe(
      "[phone-upload] close requested trigger=escape decision=confirm phase=PENDING session=...abcdef shown=+287s left=313s trusted=false visibility=visible focus=true",
    );
    expect(m).not.toContain("0123456789");
  });

  it("marks an explicit cancel and an unmount without a decision", () => {
    expect(formatPhoneUploadCloseMarker({ trigger: "x-button", decision: { action: "close", cancel: true }, phase: "PENDING" })).toBe(
      "[phone-upload] close requested trigger=x-button decision=cancel+close phase=PENDING session=none",
    );
    expect(formatPhoneUploadCloseMarker({ trigger: "unmount", decision: { action: "none" }, sessionId: "s-abcdefgh", phase: "PENDING" })).toBe(
      "[phone-upload] close requested trigger=unmount decision=none phase=PENDING session=...cdefgh",
    );
  });
});

describe("Modal dismissal rules", () => {
  const backdrop = {} as EventTarget;
  const inner = {} as EventTarget;

  it("a backdrop click needs the press to start on the backdrop too", () => {
    expect(isBackdropDismiss(true, backdrop, backdrop)).toBe(true);
    // pressed inside the dialog, released on the backdrop (text selection drag)
    expect(isBackdropDismiss(false, backdrop, backdrop)).toBe(false);
    expect(isBackdropDismiss(true, inner, backdrop)).toBe(false);
    expect(isBackdropDismiss(true, null, backdrop)).toBe(false);
  });

  it("Escape dismisses, except during an IME composition", () => {
    expect(isEscapeDismiss({ key: "Escape", isComposing: false })).toBe(true);
    expect(isEscapeDismiss({ key: "Escape", isComposing: true })).toBe(false);
    expect(isEscapeDismiss({ key: "Enter", isComposing: false })).toBe(false);
  });
});

describe("ProductImagePhoneUploadModal source guard", () => {
  // No DOM test environment in this repo (no jsdom / Testing Library), so the
  // "cancel only on an explicit close" rule is also pinned on the source:
  // one cancel call, inside requestClose, behind decision.cancel; no effect
  // cleanup cancels.
  const src = readFileSync(path.resolve(__dirname, "../components/forms/ProductImagePhoneUploadModal.tsx"), "utf8");
  let calls: string[];
  beforeEach(() => {
    calls = [...src.matchAll(/cancelProductImageUploadSession\(/g)].map((m) => src.slice(Math.max(0, m.index! - 900), m.index!));
  });
  afterEach(() => {
    calls = [];
  });

  it("cancels in exactly one place: requestClose, when the decision says cancel", () => {
    expect(calls).toHaveLength(1);
    const before = calls[0];
    expect(before).toContain("const requestClose = ");
    expect(before).toContain("decidePhoneUploadClose(trigger, { pendingSession })");
    expect(before.slice(before.lastIndexOf("const requestClose = "))).toMatch(/if \(decision\.cancel && session\) \{\s*void $/);
  });

  it("the Modal's Escape / backdrop / X all go through requestClose", () => {
    expect(src).toContain("onClose={(reason, detail) => requestClose(reason, detail.trusted)}");
    expect(src).not.toMatch(/onClose=\{onClose\}/);
  });
});
