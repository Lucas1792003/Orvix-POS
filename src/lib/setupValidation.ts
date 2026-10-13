// Client-side checks for the /setup (first administrator) form — kept out
// of the page module so the page only exports components (react-refresh).
import { STAFF_PASSWORD_MAX, STAFF_PASSWORD_MIN } from "./staffAdmin";

export interface SetupFormInput {
  email: string;
  confirmEmail: string;
  password: string;
  acknowledged: boolean;
}

/** Returns the message to show, or null when the form may be submitted. */
export function validateSetupForm(input: SetupFormInput): string | null {
  const email = input.email.trim().toLowerCase();
  if (!email || !input.password) return "Email and password are required.";
  if (email !== input.confirmEmail.trim().toLowerCase()) return "The two email addresses do not match.";
  if (input.password.length < STAFF_PASSWORD_MIN) return `Password must be at least ${STAFF_PASSWORD_MIN} characters.`;
  if (input.password.length > STAFF_PASSWORD_MAX) return `Password must be at most ${STAFF_PASSWORD_MAX} characters.`;
  if (!input.acknowledged) return "Confirm that you understand what this page does before continuing.";
  return null;
}
