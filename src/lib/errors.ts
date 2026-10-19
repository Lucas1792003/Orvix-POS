// Central error utility.
//
// Goal: keep technical details in the console for developers, but surface
// short, friendly messages to users. Every async business action should
// route its catch through `getErrorMessage(err)` (or `mapSupabaseError`)
// instead of dumping `err.message` straight into a toast.
//
// This file is intentionally framework-agnostic so it can be unit-tested
// without React / Supabase test doubles.

export const ERROR_MESSAGES = {
  permission: "You do not have permission to perform this action.",
  network: "Network error. Please check your connection and try again.",
  duplicate: "This record already exists.",
  storageBucketMissing: "Storage is not set up. Please run the required storage migration.",
  storagePermission: "Upload was blocked by storage permissions.",
  insufficientStock: "Not enough stock available for this product.",
  noOpenShift: "Please open a shift before making sales.",
  expiredSession: "Your session expired. Please log in again.",
  unknown: "Something went wrong. Please try again.",
} as const;

// Error name used by the client-side offline authorisation gate
// (stores/authStore.ts assertOfflineWriteEligible). Its message is written
// for the cashier and must be shown as is — while offline, the generic
// mapping below would otherwise turn it into "Network error".
export const OFFLINE_AUTHORIZATION_ERROR = "OfflineAuthorizationError";
// stores/data/operationPrompt.ts UnresolvedOperationError (same reason).
export const UNRESOLVED_OPERATION_ERROR = "UnresolvedOperationError";
// Migration 087: stores/data/recoveryState.ts RecoveryBlockedError (same reason: the
// recovery state and what to do must reach the cashier, never "Something went wrong").
export const RECOVERY_BLOCKED_ERROR = "RecoveryBlockedError";
/** The fixed prefix of an 087 refusal (lib/failureClass.ts RECOVERY_MESSAGE_PREFIX). */
const RECOVERY_PREFIX = "ORG_SUSPENDED: server recovery in progress";

// Postgres SQLSTATE codes we care about.
// 42501 - insufficient_privilege (RLS / RBAC deny)
// 23505 - unique_violation
// 23503 - foreign_key_violation
// PGRST301 - PostgREST RLS deny
// 22P02 - invalid_text_representation
const PERMISSION_PG_CODES = new Set(["42501", "PGRST301", "P0001-PERMISSION"]);
const DUPLICATE_PG_CODES = new Set(["23505"]);

const PERMISSION_PHRASES = [
  "permission denied",
  "not permitted",
  "rls",
  "row-level security",
  "row level security",
  "violates row-level security",
  "not authorized",
];

const NETWORK_PHRASES = [
  "failed to fetch",
  "networkerror",
  "network error",
  "fetch failed",
  "load failed",
  "the network connection was lost",
  "ecconnrefused",
  "econnrefused",
  "econnreset",
  "enetunreach",
  "etimedout",
  "request timeout",
  "request timed out",
  "aborterror",
  "signal timed out",
  "the operation was aborted",
  // Gateway-level failures (nginx / Envoy / Kong in front of PostgREST):
  // the request never reached the database, so for the online path these
  // are "network" (fall back to the queue), not a server rejection.
  "bad gateway",
  "service unavailable",
  "gateway timeout",
  "gateway time-out",
  "upstream connect error",
  "no healthy upstream",
];

// HTTP statuses that mean "the request may not have reached Postgres" —
// gateway-level, retryable from the online path by falling back to the
// outbox. (0 = fetch failure / abort, as postgrest-js reports it.)
const GATEWAY_STATUSES = new Set([0, 502, 503, 504]);

// Statuses that are transient during an outbox replay: everything a later
// retry with the same idempotency key can legitimately succeed on. 401 is
// here because PostgREST answers an expired JWT with 401 and the next pass
// refreshes the token first (see outbox.ts ensureSessionForDrain).
const TRANSIENT_STATUSES = new Set([0, 401, 408, 425, 429, 500, 502, 503, 504]);

const TRANSIENT_PHRASES = [
  "too many requests",
  "rate limit",
  "internal server error",
  "statement timeout",
  "canceling statement due to statement timeout",
  "connection pool",
  "too many connections",
];

const STORAGE_BUCKET_MISSING_PHRASES = [
  "bucket not found",
  "bucket does not exist",
  "the resource was not found",
];

const STORAGE_PERMISSION_PHRASES = [
  "new row violates row-level security policy",
  "storage policy",
  "object policy",
];

const EXPIRED_SESSION_PHRASES = [
  "jwt expired",
  "invalid jwt",
  "token has expired",
  "token is expired",
  "session_not_found",
  "session has expired",
];

const INSUFFICIENT_STOCK_PHRASES = [
  "insufficient stock",
  "not enough stock",
  "exceeds stock",
  "out of stock",
];

const NO_OPEN_SHIFT_PHRASES = [
  "open a shift",
  "shift is required",
  "no open shift",
];

// Loose, defensive shape — Supabase / PostgREST / fetch all wrap differently.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyError = any;

const lower = (value: unknown): string => {
  if (typeof value !== "string") return "";
  return value.toLowerCase();
};

const errorBlob = (error: AnyError): string => {
  if (!error) return "";
  const parts: string[] = [];
  if (typeof error === "string") parts.push(error);
  if (typeof error?.message === "string") parts.push(error.message);
  if (typeof error?.error_description === "string") parts.push(error.error_description);
  if (typeof error?.hint === "string") parts.push(error.hint);
  if (typeof error?.details === "string") parts.push(error.details);
  if (typeof error?.code === "string") parts.push(error.code);
  if (typeof error?.status === "number") parts.push(String(error.status));
  if (typeof error?.statusText === "string") parts.push(error.statusText);
  return lower(parts.join(" | "));
};

const errorCode = (error: AnyError): string | undefined => {
  if (!error) return undefined;
  if (typeof error.code === "string") return error.code;
  if (typeof error.error === "string") return error.error;
  return undefined;
};

const containsAny = (haystack: string, needles: readonly string[]): boolean =>
  needles.some((needle) => haystack.includes(needle));

export const isPermissionError = (error: AnyError): boolean => {
  if (!error) return false;
  const code = errorCode(error);
  if (code && PERMISSION_PG_CODES.has(code)) return true;
  if (typeof error?.status === "number" && (error.status === 401 || error.status === 403)) return true;
  return containsAny(errorBlob(error), PERMISSION_PHRASES);
};

/** 0 (fetch failure/abort), 502, 503, 504 — the request may never have
 *  reached Postgres. Callers that only have the response status (not the
 *  error object) use this to decide on the offline fallback. */
export const isGatewayStatus = (status: unknown): boolean =>
  typeof status === "number" && GATEWAY_STATUSES.has(status);

const httpStatus = (error: AnyError): number | undefined =>
  typeof error?.status === "number" ? error.status : undefined;

export const isNetworkError = (error: AnyError): boolean => {
  if (!error) return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (error instanceof TypeError && lower(error.message).includes("fetch")) return true;
  // supabase-js's auth client wraps fetch failures in AuthRetryableFetchError.
  if (error?.name === "AuthRetryableFetchError") return true;
  const status = httpStatus(error);
  if (status !== undefined && GATEWAY_STATUSES.has(status)) return true;
  return containsAny(errorBlob(error), NETWORK_PHRASES);
};

/**
 * Should a failed request be retried later with the same idempotency key?
 * Broader than isNetworkError: also covers 5xx from PostgREST itself, rate
 * limiting, timeouts and an expired JWT (the next attempt refreshes the
 * token first). `status` is the HTTP status of the *response* when the
 * caller has it (postgrest-js returns it next to `error`, not inside it).
 * Anything that isn't transient is a permanent rejection of this exact
 * request and must not be retried automatically.
 */
export const isTransientError = (error: AnyError, status?: number): boolean => {
  if (status !== undefined && TRANSIENT_STATUSES.has(status)) return true;
  if (!error) return false;
  const own = httpStatus(error);
  if (own !== undefined && TRANSIENT_STATUSES.has(own)) return true;
  if (isNetworkError(error)) return true;
  if (errorCode(error) === "PGRST301") return true;
  if (isExpiredSessionError(error)) return true;
  return containsAny(errorBlob(error), TRANSIENT_PHRASES);
};

export const isDuplicateError = (error: AnyError): boolean => {
  if (!error) return false;
  const code = errorCode(error);
  if (code && DUPLICATE_PG_CODES.has(code)) return true;
  const blob = errorBlob(error);
  return (
    blob.includes("duplicate key") ||
    blob.includes("unique constraint") ||
    blob.includes("already exists")
  );
};

export const isStorageError = (error: AnyError): boolean => {
  if (!error) return false;
  const blob = errorBlob(error);
  return (
    containsAny(blob, STORAGE_BUCKET_MISSING_PHRASES) ||
    containsAny(blob, STORAGE_PERMISSION_PHRASES) ||
    blob.includes("storage")
  );
};

export const isExpiredSessionError = (error: AnyError): boolean =>
  containsAny(errorBlob(error), EXPIRED_SESSION_PHRASES);

export const isInsufficientStockError = (error: AnyError): boolean =>
  containsAny(errorBlob(error), INSUFFICIENT_STOCK_PHRASES);

export const isNoOpenShiftError = (error: AnyError): boolean =>
  containsAny(errorBlob(error), NO_OPEN_SHIFT_PHRASES);

const isStorageBucketMissing = (error: AnyError): boolean =>
  containsAny(errorBlob(error), STORAGE_BUCKET_MISSING_PHRASES);

const isStoragePermission = (error: AnyError): boolean =>
  containsAny(errorBlob(error), STORAGE_PERMISSION_PHRASES);

// Map a Supabase / Postgres / fetch error to a friendly user-facing message.
// Order matters: more specific cases (expired session, storage, stock, shift)
// are checked before broader buckets (permission, duplicate, network).
export const mapSupabaseError = (error: AnyError): string => {
  if (!error) return ERROR_MESSAGES.unknown;

  if (isExpiredSessionError(error)) return ERROR_MESSAGES.expiredSession;
  if (isStorageBucketMissing(error)) return ERROR_MESSAGES.storageBucketMissing;
  if (isStoragePermission(error)) return ERROR_MESSAGES.storagePermission;
  if (isInsufficientStockError(error)) return ERROR_MESSAGES.insufficientStock;
  if (isNoOpenShiftError(error)) return ERROR_MESSAGES.noOpenShift;
  if (isDuplicateError(error)) return ERROR_MESSAGES.duplicate;
  if (isPermissionError(error)) return ERROR_MESSAGES.permission;
  if (isNetworkError(error)) return ERROR_MESSAGES.network;

  return ERROR_MESSAGES.unknown;
};

// Best-effort to extract any human-readable text from arbitrary thrown values.
// Used as the *raw* message — `getErrorMessage` decides whether to keep it or
// fall back to a friendly mapping.
const rawMessage = (error: AnyError): string | undefined => {
  if (!error) return undefined;
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message.trim()) return error.message;
  if (typeof error.error_description === "string" && error.error_description.trim()) {
    return error.error_description;
  }
  return undefined;
};

const looksLikeFriendlyMessage = (message: string): boolean => {
  // A "friendly" message is short, ends in punctuation, and does not look like
  // a Postgres / fetch dump. We err on the side of showing the friendly map
  // when in doubt — technical text always also goes to console.
  if (message.length > 160) return false;
  if (/^[A-Z0-9_]{2,}\d*:/.test(message)) return false; // e.g. "PGRST301: ..."
  if (message.includes("\n")) return false;
  if (/^\s*\{/.test(message)) return false; // JSON dump
  return true;
};

// One-stop helper for catch blocks. Prefers a friendly mapped message; if the
// raw thrown message is short and human, prefers that (so RPC-issued messages
// like "Open a shift before checkout." still shine through).
//
// `fallback` is shown only when nothing else is available.
export const getErrorMessage = (error: AnyError, fallback?: string): string => {
  if (!error) return fallback ?? ERROR_MESSAGES.unknown;
  if (error?.name === OFFLINE_AUTHORIZATION_ERROR && typeof error.message === "string" && error.message) {
    return error.message;
  }
  // "Nothing was sent" refusals of money operations (an earlier attempt or an
  // unreadable record may be this same payment): written for the cashier and
  // the reason must reach them — never replaced by a generic "could not record".
  if (error?.name === UNRESOLVED_OPERATION_ERROR && typeof error.message === "string" && error.message) {
    return error.message;
  }
  if (error?.name === RECOVERY_BLOCKED_ERROR && typeof error.message === "string" && error.message) {
    return error.message;
  }
  // A raw 087 refusal from the server: shown as the recovery state, with its code (nothing ran).
  const raw0 = rawMessage(error);
  if (raw0 && raw0.startsWith(RECOVERY_PREFIX)) {
    const code = /\[([A-Z0-9_]+)\]/.exec(raw0)?.[1];
    return `Not recorded: server recovery in progress${code ? ` [${code}]` : ""}. Nothing was applied; see Sync › Recovery.`;
  }

  const mapped = mapSupabaseError(error);
  // If we got a *specific* mapping (anything other than the generic unknown),
  // prefer it because it's both friendly and accurate.
  if (mapped !== ERROR_MESSAGES.unknown) return mapped;

  const raw = rawMessage(error);
  if (raw && looksLikeFriendlyMessage(raw)) return raw;

  return fallback ?? ERROR_MESSAGES.unknown;
};

// Lightweight console reporter — always logs the original error so devs can
// debug, never throws. Returns the friendly message for convenience.
export const reportError = (scope: string, error: AnyError, fallback?: string): string => {
  // eslint-disable-next-line no-console
  console.error(`[${scope}]`, error);
  return getErrorMessage(error, fallback);
};
