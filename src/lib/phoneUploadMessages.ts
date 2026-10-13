// Phone upload page wording (English + Myanmar via the phoneUpload section of
// src/i18n/translations.ts). Kept out of the page module so the page file
// exports only its component (react-refresh) and the wording is unit-testable.
import type { PhoneUploadRateLimitAdvice } from "./productImagePhoneUpload";

export type UploadPhase =
  | "loading"
  | "ready"
  | "compressing"
  | "uploading"
  | "waiting"
  | "complete"
  | "expired"
  | "cancelled"
  | "error";

export type PhoneUploadT = (section: string, key: string, vars?: Record<string, string | number>) => string;

/** Status line for a phase (English + Myanmar through the phoneUpload i18n section). */
export function phoneUploadStatusText(t: PhoneUploadT, phase: UploadPhase, waitSeconds = 0): string {
  switch (phase) {
    case "loading": return t("phoneUpload", "loading");
    case "compressing": return t("phoneUpload", "compressing");
    case "uploading": return t("phoneUpload", "uploading");
    case "waiting": return t("phoneUpload", "rateLimitedWaiting", { seconds: Math.max(0, waitSeconds) });
    case "complete": return t("phoneUpload", "complete");
    case "expired": return t("phoneUpload", "expired");
    case "cancelled": return t("phoneUpload", "cancelled");
    case "ready": return t("phoneUpload", "ready");
    default: return t("phoneUpload", "failed");
  }
}

/** Friendly message once the phone has stopped retrying a 429 by itself. */
export function phoneUploadRateLimitMessage(t: PhoneUploadT, advice: PhoneUploadRateLimitAdvice): string {
  if (advice.kind === "linkExhausted") return t("phoneUpload", "rateLimitedLinkUsedUp");
  if (advice.kind === "later") return t("phoneUpload", "rateLimitedLater", { minutes: advice.minutes });
  return t("phoneUpload", "rateLimitedWaiting", { seconds: advice.seconds });
}
