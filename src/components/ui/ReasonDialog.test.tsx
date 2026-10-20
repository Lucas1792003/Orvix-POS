import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReasonDialog } from "./ReasonDialog";
import { REASON_MAX_LENGTH, normalizeReason } from "./reasonInput";

// ReasonDialog replaces window.prompt() (ORV-013): Electron has no prompt(),
// so transfer reject/cancel did nothing on tills. No DOM environment is
// installed, so this covers the reason rules and the rendered markup. The
// click-through (retry, double submit, Escape while saving) still needs an
// Electron e2e spec — planned as "u-dialogs" (Claude 2 plan), not yet
// written; e2e/ is outside this workstream.

describe("normalizeReason", () => {
  it("rejects blank and whitespace-only reasons", () => {
    expect(normalizeReason("")).toBeNull();
    expect(normalizeReason("   \n\t ")).toBeNull();
  });

  it("trims what it sends", () => {
    expect(normalizeReason("  wrong shop  ")).toBe("wrong shop");
  });

  it("caps the length", () => {
    expect(normalizeReason("x".repeat(REASON_MAX_LENGTH + 50))).toHaveLength(REASON_MAX_LENGTH);
  });
});

const props = (over: Partial<Parameters<typeof ReasonDialog>[0]> = {}) => ({
  open: true,
  title: "Reject transfer",
  label: "Rejection reason",
  confirmLabel: "Reject",
  cancelLabel: "Back",
  requiredMessage: "Enter a reason.",
  onConfirm: vi.fn(),
  onClose: vi.fn(),
  ...over,
});

describe("ReasonDialog markup", () => {
  it("renders nothing while closed", () => {
    expect(renderToStaticMarkup(<ReasonDialog {...props({ open: false })} />)).toBe("");
  });

  it("renders a labelled, required reason field and both actions", () => {
    const html = renderToStaticMarkup(<ReasonDialog {...props()} />);
    expect(html).toContain("Reject transfer");
    const id = /<label for="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<textarea id="${id}"`);
    expect(html).toMatch(/<textarea[^>]*required=""/);
    expect(html).toMatch(/<textarea[^>]*aria-required="true"/);
    expect(html).toMatch(/<textarea[^>]*maxLength="500"/i);
    // Submit button is tied to the form; dismiss is a plain button.
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*form="[^"]+"[^>]*>Reject<\/button>/);
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>Back<\/button>/);
    // No error shown before a submit attempt.
    expect(html).not.toContain("Enter a reason.");
  });

  it("uses the danger style for destructive actions", () => {
    const html = renderToStaticMarkup(<ReasonDialog {...props({ destructive: true })} />);
    expect(html).toMatch(/<button[^>]*class="[^"]*bg-rose-600[^"]*"[^>]*>Reject<\/button>/);
  });
});
