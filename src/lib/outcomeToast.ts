import { getErrorMessage } from "./errors";
import { isPendingConfirmation, isUnresolvedOperation } from "../stores/data/operationPrompt";
import type { ToastItem } from "../stores/toastStore";

type Translate = (section: string, key: string, vars?: Record<string, string | number>) => string;

/**
 * The toast for an operation that did not simply succeed. An unknown
 * outcome is "pending confirmation" (never "failed"); a send the person
 * declined is "nothing was sent"; anything else is the caller's failure.
 */
export function outcomeToast(err: unknown, t: Translate, failedTitle: string, fallback: string): Omit<ToastItem, "id"> {
  if (isPendingConfirmation(err)) {
    return { variant: "warning", title: t("unresolved", "pendingTitle"), description: getErrorMessage(err, fallback) };
  }
  if (isUnresolvedOperation(err)) {
    return { variant: "info", title: t("unresolved", "cancelledTitle"), description: getErrorMessage(err, fallback) };
  }
  return { variant: "error", title: failedTitle, description: getErrorMessage(err, fallback) };
}

/** The operation may already be recorded: the form must not be resubmitted. */
export const mayAlreadyBeRecorded = (err: unknown): boolean => isPendingConfirmation(err);
