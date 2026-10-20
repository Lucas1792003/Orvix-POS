import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AdjustStockModal } from "./AdjustStockModal";

// ORV-058: the reason is required (no silent "Manual adjustment" default
// that satisfied the server's check), and the form is cleared only after a
// save succeeds. No DOM environment is installed, so this checks the markup;
// the validation rules are normalizeReason (ReasonDialog.test.tsx) plus
// "whole quantity > 0". The save/retry flow still needs an e2e spec (e2e/ is
// outside this workstream; existing A4 covers the happy path).

describe("AdjustStockModal markup", () => {
  const render = () =>
    renderToStaticMarkup(<AdjustStockModal open onClose={vi.fn()} onSave={vi.fn(async () => true)} />);

  it("marks the reason as a required, labelled field with no default value", () => {
    const html = render();
    const reasonId = /<label for="([^"]+-reason)"/.exec(html)?.[1];
    expect(reasonId).toBeTruthy();
    const input = new RegExp(`<input[^>]*id="${reasonId}"[^>]*>`).exec(html)?.[0] ?? "";
    expect(input).toContain('required=""');
    expect(input).toContain('aria-required="true"');
    expect(input).toContain('value=""');
    expect(html).not.toContain("Manual adjustment\"");
  });

  it("labels the quantity field", () => {
    const html = render();
    const qtyId = /<label for="([^"]+-qty)"/.exec(html)?.[1];
    expect(qtyId).toBeTruthy();
    expect(html).toMatch(new RegExp(`<input[^>]*id="${qtyId}"`));
  });

  it("shows no validation error before a save attempt", () => {
    const html = render();
    expect(html).not.toContain("A reason is required.");
    expect(html).not.toContain("Enter a whole quantity");
  });
});
