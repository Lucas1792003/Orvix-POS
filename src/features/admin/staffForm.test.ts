import { describe, expect, it } from "vitest";
import { buildCreateStaffInput, staffCreateErrorMessage } from "./staffForm";
import { mapUserFormError } from "./userFormErrors";
import { StaffAdminError, STAFF_ADMIN_MISSING_MESSAGE } from "../../lib/staffAdmin";

const KEY = "0f8fad5b-d9cb-469f-a165-70867728950e";
const form = { name: "  New Cashier ", email: "  New.Cashier@Example.TEST ", password: "Correct-Horse-9", role: "CASHIER" as const, shopId: "shop-a1" };

describe("buildCreateStaffInput()", () => {
  it("normalises name and email and carries the idempotency key", () => {
    expect(buildCreateStaffInput(form, [], KEY)).toEqual({
      input: { name: "New Cashier", email: "new.cashier@example.test", password: "Correct-Horse-9", role: "CASHIER", shopId: "shop-a1", idempotencyKey: KEY },
    });
  });

  it("enforces the server's password policy (8..72)", () => {
    expect(buildCreateStaffInput({ ...form, password: "short12" }, [], KEY)).toEqual({ error: "Password must be 8–72 characters." });
    expect(buildCreateStaffInput({ ...form, password: "x".repeat(73) }, [], KEY)).toHaveProperty("error");
  });

  it("never requests an ADMIN and always needs a shop", () => {
    expect(buildCreateStaffInput({ ...form, role: "ADMIN" }, [], KEY)).toHaveProperty("error");
    expect(buildCreateStaffInput({ ...form, shopId: undefined }, [], KEY)).toEqual({ error: "Choose a shop." });
  });

  it("catches an email already in the list case-insensitively", () => {
    expect(buildCreateStaffInput(form, [undefined, "NEW.cashier@example.test"], KEY)).toEqual({ error: "A user with this email already exists." });
  });

  it("requires name and email", () => {
    expect(buildCreateStaffInput({ ...form, name: " " }, [], KEY)).toEqual({ error: "Name is required." });
    expect(buildCreateStaffInput({ ...form, email: " " }, [], KEY)).toEqual({ error: "Email is required." });
  });
});

describe("staffCreateErrorMessage() (what the Users form shows)", () => {
  it("shows the 'service not installed' error verbatim (backend without staff-admin, e.g. hosted)", () => {
    const err = new StaffAdminError(STAFF_ADMIN_MISSING_MESSAGE, 404, "function_missing");
    expect(staffCreateErrorMessage(err)).toBe(STAFF_ADMIN_MISSING_MESSAGE);
    expect(staffCreateErrorMessage(err)).toMatch(/Nothing was created/);
  });

  it("shows the server's own refusal verbatim", () => {
    const err = new StaffAdminError("Verify with your authenticator app before creating staff accounts.", 403, "mfa_required");
    expect(staffCreateErrorMessage(err)).toBe("Verify with your authenticator app before creating staff accounts.");
  });

  it("routes database business-rule errors (Postgres code) through the Users form mapping", () => {
    const err = new StaffAdminError("duplicate key value violates unique constraint", 409, "rejected", "23505");
    expect(staffCreateErrorMessage(err)).toBe(mapUserFormError(err));
  });
});
