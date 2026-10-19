import { describe, expect, it } from "vitest";
import {
  ERROR_MESSAGES,
  getErrorMessage,
  isDuplicateError,
  isExpiredSessionError,
  isGatewayStatus,
  isInsufficientStockError,
  isNetworkError,
  isTransientError,
  isNoOpenShiftError,
  isPermissionError,
  isStorageError,
  mapSupabaseError,
  OFFLINE_AUTHORIZATION_ERROR,
  UNRESOLVED_OPERATION_ERROR,
} from "./errors";

describe("error classifiers", () => {
  it("detects RLS / permission errors by code and phrasing", () => {
    expect(isPermissionError({ code: "42501", message: "permission denied for table users" })).toBe(true);
    expect(isPermissionError({ code: "PGRST301" })).toBe(true);
    expect(isPermissionError({ status: 403, message: "Forbidden" })).toBe(true);
    expect(isPermissionError({ message: "Row level security policy violated" })).toBe(true);
    expect(isPermissionError({ message: "not permitted to upload" })).toBe(true);
    expect(isPermissionError(null)).toBe(false);
  });

  it("detects unique-violation duplicates", () => {
    expect(isDuplicateError({ code: "23505" })).toBe(true);
    expect(isDuplicateError({ message: "duplicate key value violates unique constraint" })).toBe(true);
    expect(isDuplicateError({ message: "value already exists" })).toBe(true);
    expect(isDuplicateError({ message: "not unique-violation looking" })).toBe(false);
  });

  it("detects network / fetch failures", () => {
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isNetworkError({ message: "NetworkError when attempting to fetch resource." })).toBe(true);
    expect(isNetworkError({ message: "ETIMEDOUT connecting" })).toBe(true);
    expect(isNetworkError({ message: "boring error" })).toBe(false);
  });

  // Phase D (A3): gateway failures and supabase-js's own resolved fetch
  // error shape count as network — the request may never have reached
  // Postgres, so the online path must fall back to the outbox.
  it("treats 502/503/504 and status-0 responses as network errors", () => {
    expect(isNetworkError({ message: "TypeError: Failed to fetch", code: "", status: 0 })).toBe(true);
    expect(isNetworkError({ message: "<html>502 Bad Gateway</html>", status: 502 })).toBe(true);
    expect(isNetworkError({ message: "upstream connect error or disconnect/reset before headers", status: 503 })).toBe(true);
    expect(isNetworkError({ message: "Gateway Time-out", status: 504 })).toBe(true);
    expect(isNetworkError({ name: "AuthRetryableFetchError", message: "Failed to fetch", status: 0 })).toBe(true);
    expect(isGatewayStatus(503)).toBe(true);
    expect(isGatewayStatus(400)).toBe(false);
    // A business message that merely contains digits is NOT a gateway error.
    expect(isNetworkError({ message: "Only 502 units in stock", status: 400 })).toBe(false);
  });

  it("classifies transient (retry with the same key) vs permanent failures", () => {
    // transient: network, gateway, 5xx, 429, timeouts, expired JWT
    expect(isTransientError({ message: "TypeError: Failed to fetch", code: "" }, 0)).toBe(true);
    expect(isTransientError({ message: "internal server error" }, 500)).toBe(true);
    expect(isTransientError({ message: "Too Many Requests" }, 429)).toBe(true);
    expect(isTransientError({ message: "complete_sale timed out after 30s", status: 0 })).toBe(true);
    expect(isTransientError({ message: "AbortError: signal timed out" })).toBe(true);
    expect(isTransientError({ message: "JWT expired", code: "PGRST301" }, 401)).toBe(true);
    expect(isTransientError({ message: "JWT expired" })).toBe(true);
    expect(isTransientError({ message: "canceling statement due to statement timeout", code: "57014" })).toBe(true);
    // permanent: validation, RLS/permission, business rules, duplicate keys
    expect(isTransientError({ message: "Insufficient stock for Tea Mix", code: "P0001" }, 400)).toBe(false);
    expect(isTransientError({ message: "permission denied for table sales", code: "42501" }, 403)).toBe(false);
    expect(isTransientError({ message: "IDEMPOTENCY_MISMATCH: key x was used for a different request", code: "23505" }, 409)).toBe(false);
    expect(isTransientError({ message: "Shift is already closed." }, 400)).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });

  it("detects storage bucket / policy errors", () => {
    expect(isStorageError({ message: "Bucket not found" })).toBe(true);
    expect(isStorageError({ message: "new row violates row-level security policy" })).toBe(true);
    expect(isStorageError({ message: "storage operation refused" })).toBe(true);
    expect(isStorageError({ message: "happy path" })).toBe(false);
  });

  it("detects business-domain errors that come back in error text", () => {
    expect(isInsufficientStockError({ message: "Insufficient stock for product P1" })).toBe(true);
    expect(isNoOpenShiftError({ message: "Open a shift before checkout." })).toBe(true);
    expect(isExpiredSessionError({ message: "JWT expired" })).toBe(true);
  });
});

describe("mapSupabaseError", () => {
  it("returns the expired-session message", () => {
    expect(mapSupabaseError({ message: "JWT expired" })).toBe(ERROR_MESSAGES.expiredSession);
  });

  it("prefers bucket-missing over generic permission", () => {
    expect(mapSupabaseError({ message: "Bucket not found" })).toBe(ERROR_MESSAGES.storageBucketMissing);
  });

  it("maps storage policy violations", () => {
    expect(mapSupabaseError({ message: "new row violates row-level security policy on storage.objects" })).toBe(
      ERROR_MESSAGES.storagePermission
    );
  });

  it("maps domain insufficient-stock errors before generic permission", () => {
    expect(mapSupabaseError({ message: "Insufficient stock" })).toBe(ERROR_MESSAGES.insufficientStock);
  });

  it("maps no-open-shift errors", () => {
    expect(mapSupabaseError({ message: "Open a shift before checkout." })).toBe(ERROR_MESSAGES.noOpenShift);
  });

  it("maps duplicates", () => {
    expect(mapSupabaseError({ code: "23505", message: "duplicate key" })).toBe(ERROR_MESSAGES.duplicate);
  });

  it("maps RLS / permission errors", () => {
    expect(mapSupabaseError({ code: "42501" })).toBe(ERROR_MESSAGES.permission);
  });

  it("maps network errors", () => {
    expect(mapSupabaseError(new TypeError("Failed to fetch"))).toBe(ERROR_MESSAGES.network);
  });

  it("falls back to unknown for opaque errors", () => {
    expect(mapSupabaseError({ message: "something exotic happened" })).toBe(ERROR_MESSAGES.unknown);
    expect(mapSupabaseError(null)).toBe(ERROR_MESSAGES.unknown);
  });
});

describe("getErrorMessage", () => {
  it("prefers the friendly mapping when one is available", () => {
    expect(getErrorMessage({ code: "23505", message: "duplicate key value" })).toBe(ERROR_MESSAGES.duplicate);
    expect(getErrorMessage({ code: "42501" })).toBe(ERROR_MESSAGES.permission);
  });

  it("prefers a short human-written raw message over the generic 'unknown'", () => {
    // RPC raises a clear message like this — we want it to come through.
    expect(getErrorMessage({ message: "Upload link has expired" })).toBe("Upload link has expired");
  });

  it("uses the fallback when the raw message looks technical", () => {
    const technical = {
      message:
        "PGRST301: { 'hint': null, 'details': 'rejected by row level security', 'code': 'PGRST301' }",
    };
    // Permission detection catches this via the "rls" phrase in details — friendly map wins.
    expect(getErrorMessage(technical, "Save failed.")).toBe(ERROR_MESSAGES.permission);
  });

  it("returns the supplied fallback when no info is available", () => {
    expect(getErrorMessage(undefined, "Save failed.")).toBe("Save failed.");
    expect(getErrorMessage(null)).toBe(ERROR_MESSAGES.unknown);
  });

  it("strips multi-line and JSON-shaped raw messages", () => {
    const ugly = { message: "{ \"code\": 500, \"details\": \"server exploded\" }" };
    expect(getErrorMessage(ugly, "Save failed.")).toBe("Save failed.");
  });
});

describe("unresolved-operation refusals", () => {
  it("are shown as written (the cashier must learn why nothing was sent)", () => {
    const err = new Error("This till holds a payment record it cannot read (damaged, or written by a newer version) that may be this same operation. Nothing was sent.");
    err.name = UNRESOLVED_OPERATION_ERROR;
    expect(getErrorMessage(err, "Could not record supplier payment.")).toMatch(/cannot read/);
  });
});

describe("offline authorisation errors", () => {
  it("shows the gate's own message even while the device is offline", () => {
    const onLine = Object.getOwnPropertyDescriptor(navigator, "onLine");
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    try {
      const err = new Error("This device has been offline for more than 12 hours. Reconnect to the internet to verify your sign-in before recording new offline activity — anything already queued is kept and will sync.");
      err.name = OFFLINE_AUTHORIZATION_ERROR;
      expect(getErrorMessage(err)).toBe(err.message);
      // an ordinary failure while offline still maps to the network message
      expect(getErrorMessage(new TypeError("Failed to fetch"))).toBe(ERROR_MESSAGES.network);
    } finally {
      if (onLine) Object.defineProperty(navigator, "onLine", onLine);
      else delete (navigator as unknown as Record<string, unknown>).onLine;
    }
  });
});

describe("migration 087 recovery messages", () => {
  it("a RecoveryBlockedError reaches the cashier as is; a raw PT429 refusal is shown as the recovery state", () => {
    const blocked = Object.assign(new Error("Till reconciliation required [TILL_UNKNOWN]: this till is not registered with the server. An administrator with an authenticator app must register it before sales can resume."), { name: "RecoveryBlockedError" });
    expect(getErrorMessage(blocked, "Failed")).toBe(blocked.message);
    expect(getErrorMessage({ message: "ORG_SUSPENDED: server recovery in progress [RECOVERY_HOLD]", code: "PT429" }, "Failed"))
      .toBe("Not recorded: server recovery in progress [RECOVERY_HOLD]. Nothing was applied; see Sync › Recovery.");
  });
});
