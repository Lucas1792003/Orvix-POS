// Builds the staff-admin create_staff request from the Users form. Kept out of
// the page module so it can be unit-tested without a DOM. The server
// re-validates everything (supabase/functions/staff-admin).
import type { Role } from "../../types";
import { STAFF_PASSWORD_MAX, STAFF_PASSWORD_MIN, type CreateStaffInput } from "../../lib/staffAdmin";

export interface NewStaffForm {
  name: string;
  email: string;
  password: string;
  role: Role;
  shopId?: string;
}

export function buildCreateStaffInput(
  form: NewStaffForm,
  existingEmails: ReadonlyArray<string | undefined>,
  idempotencyKey: string,
): { error: string } | { input: CreateStaffInput } {
  const name = form.name.trim();
  if (!name) return { error: "Name is required." };
  const email = form.email.trim().toLowerCase();
  if (!email) return { error: "Email is required." };
  if (form.password.length < STAFF_PASSWORD_MIN || form.password.length > STAFF_PASSWORD_MAX) {
    return { error: `Password must be ${STAFF_PASSWORD_MIN}–${STAFF_PASSWORD_MAX} characters.` };
  }
  if (form.role === "ADMIN") return { error: "Only one admin is allowed in the system." };
  if (!form.shopId) return { error: "Choose a shop." };
  if (existingEmails.some((e) => (e ?? "").trim().toLowerCase() === email)) {
    return { error: "A user with this email already exists." };
  }
  return {
    input: { name, email, password: form.password, role: form.role, shopId: form.shopId, idempotencyKey },
  };
}
