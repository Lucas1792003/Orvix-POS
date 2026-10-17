// ----------------------------------------------------------------------
// One classifier for every failed request (Batch 2A, plan v2 §5.2).
//
// Every consumer — the online checkout path, the outbox drain, catalogue
// table writes, session restore — asks the same question of a failure:
// MAY THE SERVER HAVE APPLIED IT, and what should the queue do now? The
// answer depends on the HTTP status, the SQLSTATE / PostgREST code, the
// message and hint, and whether the body was PostgREST JSON at all (an
// HTML or empty body comes from a gateway or edge, never from Postgres).
//
// Verified against the real gateway (Envoy v1.39.1 + PostgREST v14.17 +
// supabase-js 2.106.1, disposable stack, 2026-10-16): custom SQLSTATEs and
// P0001 arrive as HTTP 400 with code/message/hint/details intact; PT503
// (ORG_SUSPENDED) as 503; 42703 as 400. postgrest-js reports a body that is
// not JSON as `{ message: <body> }` with no code; a fetch failure, abort or
// client timeout as status 0.
//
// A timeout or reset AFTER the request was sent is UNKNOWN_OUTCOME — never
// "failed": the entry keeps its idempotency key and is resent with it, and
// the server's ledger answers with the original result if it committed.
// ----------------------------------------------------------------------

export type FailureClass =
  /** The client knows nothing was sent (offline before the request). */
  | "NOT_SENT"
  /** The request may have been applied (timeout/reset after send, 502/504/52x). */
  | "UNKNOWN_OUTCOME"
  /** A gateway/edge says the origin was not reached (no healthy upstream, 521–523). */
  | "NOT_DELIVERED"
  /** The server answered and rolled back (5xx from PostgREST, 408/425/429, maintenance). */
  | "TEMPORARY_SERVER"
  /** Definitive refusal of this exact request (business rule, validation, RLS). */
  | "REJECTED"
  /** Idempotency contract violation (key reused for a different request / missing). */
  | "CONTRACT"
  /** Access token expired: refresh, then resend with the same key. */
  | "AUTH_REFRESH"
  /** Credentials rejected (invalid token, no app user, MFA required): sign in again. */
  | "AUTH_REAUTH"
  /** The organisation is suspended: hold, never conflict, no offline trading. */
  | "ORG_SUSPENDED"
  /** An edge (Cloudflare/WAF) blocked the request before the origin: hold. */
  | "EDGE_BLOCKED"
  /** The server lacks the function/column the client calls (version skew): hold. */
  | "WAITING_BACKEND"
  /** A 2xx whose body is not the expected shape (set by reply validation). */
  | "MALFORMED_SUCCESS"
  /** 086: the operation was fenced before it executed; it never will. */
  | "ABANDONED"
  /** 086: a UUIDv7 key outside the server's execution window; never executed. */
  | "KEY_EXPIRED"
  /** 086: the operation belongs to another user; it is sent only in that
   *  user's session (nothing ran, nothing recorded). */
  | "WRONG_ACTOR"
  /** 086: refused because a prerequisite may not have synchronised yet
   *  (another till's queued operation). Nothing recorded; retried later. */
  | "DEPENDENCY"
  /** 086: the server refused it but did NOT record the refusal (an
   *  unexpected / unaudited error, or an actor-less legacy entry): nothing
   *  ran, nothing is decided — never shown as final; held and retried. */
  | "NOT_RECORDED";

export type HoldReason = "reauth" | "suspended" | "edge" | "backend-version" | "actor" | "dependency" | "not-recorded";

export interface FailureInfo {
  klass: FailureClass;
  /** True when the server may have applied the request: keep it, resend
   *  only with the same idempotency key, never report it as failed. */
  mayHaveCommitted: boolean;
  /** Resend later, automatically, with the same key. */
  retryable: boolean;
  /** Needs something outside the queue first (sign-in, upgrade, reactivation). */
  hold: HoldReason | null;
  /** Server-requested delay (Retry-After), when known. */
  retryAfterMs?: number;
}

export interface FailureSignal {
  status?: number;
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
  /** The request never left the client (offline check before sending). */
  notSent?: boolean;
  /** The client gave up waiting after sending (abort/timeout). */
  timedOut?: boolean;
  retryAfterMs?: number;
}

const info = (klass: FailureClass, retryAfterMs?: number): FailureInfo => {
  switch (klass) {
    case "NOT_SENT":
    case "NOT_DELIVERED":
    case "TEMPORARY_SERVER":
    case "AUTH_REFRESH":
      return { klass, mayHaveCommitted: false, retryable: true, hold: null, retryAfterMs };
    case "UNKNOWN_OUTCOME":
    case "MALFORMED_SUCCESS":
      return { klass, mayHaveCommitted: true, retryable: true, hold: null, retryAfterMs };
    case "AUTH_REAUTH":
      return { klass, mayHaveCommitted: false, retryable: true, hold: "reauth", retryAfterMs };
    case "ORG_SUSPENDED":
      return { klass, mayHaveCommitted: false, retryable: true, hold: "suspended", retryAfterMs };
    case "EDGE_BLOCKED":
      return { klass, mayHaveCommitted: false, retryable: true, hold: "edge", retryAfterMs };
    case "WAITING_BACKEND":
      return { klass, mayHaveCommitted: false, retryable: true, hold: "backend-version", retryAfterMs };
    case "WRONG_ACTOR":
      return { klass, mayHaveCommitted: false, retryable: true, hold: "actor", retryAfterMs };
    case "DEPENDENCY":
      return { klass, mayHaveCommitted: false, retryable: true, hold: "dependency", retryAfterMs };
    case "NOT_RECORDED":
      return { klass, mayHaveCommitted: false, retryable: true, hold: "not-recorded", retryAfterMs };
    case "REJECTED":
    case "CONTRACT":
    case "ABANDONED":
    case "KEY_EXPIRED":
      return { klass, mayHaveCommitted: false, retryable: false, hold: null, retryAfterMs };
  }
};

/** The fixed meaning of a class (for outcomes the server states itself). */
export const failureInfo = (klass: FailureClass, retryAfterMs?: number): FailureInfo => info(klass, retryAfterMs);

const lower = (s: unknown): string => (typeof s === "string" ? s.toLowerCase() : "");

/** A body that came from a gateway/edge, not PostgREST: HTML, or nothing. */
export const looksLikeGatewayBody = (message: string | undefined, code: string | undefined): boolean => {
  if (code) return false;
  const m = (message ?? "").trim();
  return m === "" || m.startsWith("<") || /<html|<!doctype/i.test(m);
};

// Postgres/PostgREST codes meaning "the transaction was rolled back, retry".
const ROLLED_BACK_RETRYABLE = new Set([
  "40001", "40P01", // serialization failure, deadlock
  "57014", // statement timeout / cancelled
  "53300", "53400", // too many connections, configuration limit
  "57P01", "57P02", "57P03", // admin shutdown, crash shutdown, cannot connect now
  "PGRST000", "PGRST001", "PGRST002", "PGRST003", // PostgREST: DB unreachable / pool timeout
]);
// The server does not know what the client calls: an older/newer server.
const VERSION_SKEW = new Set(["42703", "42883", "PGRST202", "PGRST204", "PGRST200"]);

const EXPIRED_PHRASES = ["jwt expired", "token is expired", "token has expired", "session has expired"];
const REAUTH_PHRASES = [
  "invalid jwt", "jwserror", "invalid signature", "jwt signature", "no suitable key", "not authenticated",
  "refresh_token_already_used", "refresh_token_not_found", "invalid refresh token", "session_not_found",
];
const NETWORK_PHRASES = [
  "failed to fetch", "networkerror", "network error", "fetch failed", "load failed",
  "the network connection was lost", "econnreset", "etimedout", "timed out", "timeout occurred",
  "connection timed out", "aborterror", "signal timed out", "the operation was aborted", "socket hang up",
];
// Envoy texts that prove the origin was never reached.
const NOT_REACHED_PHRASES = [
  "no healthy upstream", "connection failure", "connection refused", "econnrefused", "enotfound",
  "enetunreach", "name not resolved", "err_name_not_resolved",
];

/**
 * Classify one failed request. Pure: no clock, no globals.
 */
export function classifyFailure(signal: FailureSignal): FailureInfo {
  const { status, retryAfterMs } = signal;
  const code = signal.code && signal.code.trim() ? signal.code.trim() : undefined;
  const message = signal.message ?? "";
  const text = `${lower(message)} | ${lower(signal.details)} | ${lower(signal.hint)}`;

  if (signal.notSent) return info("NOT_SENT", retryAfterMs);

  // Suspension and contract violations win over the status they ride on.
  if (code === "PT503" || message.startsWith("ORG_SUSPENDED") || text.includes("rule=org_suspended")) {
    return info("ORG_SUSPENDED", retryAfterMs);
  }
  if (message.includes("IDEMPOTENCY_MISMATCH") || message.includes("IDEMPOTENCY_KEY_REQUIRED")) {
    return info("CONTRACT");
  }
  if (code === "OX204" || message.startsWith("MFA_REQUIRED") || text.includes("rule=mfa_required")) {
    return info("AUTH_REAUTH", retryAfterMs);
  }
  // 086 executor markers (op_execute / op_status / idem_begin). Nothing was
  // executed or recorded for any of them.
  if (message.startsWith("OP_NOT_AUTHENTICATED") || text.includes("op_not_recorded:auth")) return info("AUTH_REAUTH", retryAfterMs);
  if (message.startsWith("OP_ACTOR_MISMATCH") || text.includes("op_not_recorded:actor") && !text.includes("op_not_recorded:actor_unverified")) {
    return info("WRONG_ACTOR", retryAfterMs);
  }
  if (text.includes("op_not_recorded:dependency")) return info("DEPENDENCY", retryAfterMs);
  // Any other refusal the executor did not record (unclassified, internal,
  // actor_unverified): nothing ran and nothing is decided. Never final.
  if (text.includes("op_not_recorded:")) return info("NOT_RECORDED", retryAfterMs);
  // The legacy path refused a UUIDv7 key (it must go through op_execute):
  // nothing ran; resent through the executor.
  if (message.startsWith("OP_EXECUTOR_REQUIRED")) return info("TEMPORARY_SERVER", retryAfterMs);
  if (message.startsWith("OP_KEY_OUTSIDE_WINDOW")) return info("KEY_EXPIRED");
  // The RPC is not executable for this role on this server (privilege
  // parity with the direct path): nothing ran; wait for the server.
  if (message.startsWith("OP_RPC_DISABLED")) return info("WAITING_BACKEND", retryAfterMs);
  if (/^OP_(KEY_REQUIRED|ACTOR_REQUIRED|UNKNOWN_RPC|UNKNOWN_ARGUMENT|MISSING_ARGUMENT|INVALID_ARGUMENTS?)\b/.test(message)) return info("CONTRACT");

  if (signal.timedOut || code === "TIMEOUT") return info("UNKNOWN_OUTCOME", retryAfterMs);

  const gatewayBody = looksLikeGatewayBody(message, code);

  if (status === 0) {
    if (NOT_REACHED_PHRASES.some((p) => text.includes(p))) return info("NOT_DELIVERED", retryAfterMs);
    // A fetch failure or abort may happen after the request body was sent.
    return info("UNKNOWN_OUTCOME", retryAfterMs);
  }
  if (status === undefined) {
    // No HTTP status: a thrown error. supabase-js always reports one for an
    // HTTP answer, so this is either a transport failure (by its text) or a
    // non-HTTP refusal raised in code.
    if (code) return classifyByCode(code, text, retryAfterMs) ?? info("REJECTED");
    if (NOT_REACHED_PHRASES.some((p) => text.includes(p))) return info("NOT_DELIVERED", retryAfterMs);
    if (NETWORK_PHRASES.some((p) => text.includes(p))) return info("UNKNOWN_OUTCOME", retryAfterMs);
    if (REAUTH_PHRASES.some((p) => text.includes(p))) return info("AUTH_REAUTH", retryAfterMs);
    if (EXPIRED_PHRASES.some((p) => text.includes(p))) return info("AUTH_REFRESH", retryAfterMs);
    return info("REJECTED");
  }

  if (status === 401) {
    if (EXPIRED_PHRASES.some((p) => text.includes(p))) return info("AUTH_REFRESH", retryAfterMs);
    if (REAUTH_PHRASES.some((p) => text.includes(p)) || gatewayBody) return info("AUTH_REAUTH", retryAfterMs);
    return info("AUTH_REFRESH", retryAfterMs); // PGRST301 without detail: refresh first
  }

  if (status === 408 || status === 425 || status === 429) return info("TEMPORARY_SERVER", retryAfterMs);

  if (status === 503) {
    if (!gatewayBody && lower(code) === "maintenance") return info("TEMPORARY_SERVER", retryAfterMs);
    if (code && ROLLED_BACK_RETRYABLE.has(code)) return info("TEMPORARY_SERVER", retryAfterMs);
    if (NOT_REACHED_PHRASES.some((p) => text.includes(p))) return info("NOT_DELIVERED", retryAfterMs);
    if (/maintenance/i.test(message) && !code) return info("TEMPORARY_SERVER", retryAfterMs);
    return info("UNKNOWN_OUTCOME", retryAfterMs);
  }
  if (status === 521 || status === 522 || status === 523 || status === 525 || status === 526 || status === 530) {
    return info("NOT_DELIVERED", retryAfterMs);
  }
  if (status >= 500) {
    // PostgREST JSON 5xx: the statement failed and the transaction rolled back.
    if (!gatewayBody && code && status === 500) {
      return classifyByCode(code, text, retryAfterMs) ?? info("TEMPORARY_SERVER", retryAfterMs);
    }
    if (NOT_REACHED_PHRASES.some((p) => text.includes(p))) return info("NOT_DELIVERED", retryAfterMs);
    return info("UNKNOWN_OUTCOME", retryAfterMs); // 502, 504, 520, 524, 527, other
  }

  if (status >= 400) {
    // 4xx without a PostgREST body: an edge or a proxy answered.
    if (gatewayBody) return info("EDGE_BLOCKED", retryAfterMs);
    return classifyByCode(code ?? "", text, retryAfterMs) ?? info("REJECTED");
  }

  // 2xx/3xx reaching here means a caller passed a "success" as a failure.
  return info("MALFORMED_SUCCESS", retryAfterMs);
}

function classifyByCode(code: string, text: string, retryAfterMs?: number): FailureInfo | null {
  if (VERSION_SKEW.has(code)) return info("WAITING_BACKEND", retryAfterMs);
  if (ROLLED_BACK_RETRYABLE.has(code)) return info("TEMPORARY_SERVER", retryAfterMs);
  if (code === "PGRST301" || code === "PGRST302") {
    return EXPIRED_PHRASES.some((p) => text.includes(p)) ? info("AUTH_REFRESH", retryAfterMs) : info("AUTH_REAUTH", retryAfterMs);
  }
  if (REAUTH_PHRASES.some((p) => text.includes(p)) && (code === "P0001" || code === "28000" || code === "28P01")) {
    return info("AUTH_REAUTH", retryAfterMs);
  }
  if (code === "XX000") return info("TEMPORARY_SERVER", retryAfterMs);
  return null;
}

/** Signal fields from any error shape supabase-js / fetch produce. */
export function signalOf(raw: unknown, status?: number): FailureSignal {
  const e = (raw ?? {}) as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown; status?: unknown; name?: unknown };
  const message = typeof raw === "string" ? raw : typeof e.message === "string" ? e.message : raw instanceof Error ? raw.message : "";
  const own = typeof e.status === "number" ? e.status : undefined;
  return {
    status: status ?? own,
    code: typeof e.code === "string" ? e.code : undefined,
    message,
    details: typeof e.details === "string" ? e.details : undefined,
    hint: typeof e.hint === "string" ? e.hint : undefined,
    timedOut: e.name === "AbortError" || e.code === "TIMEOUT",
  };
}

/** Backoff floor per hold, so a held entry does not hammer the server. */
export function holdBackoffMs(hold: HoldReason | null): number {
  switch (hold) {
    case "suspended": return 5 * 60_000;
    case "backend-version": return 30 * 60_000;
    case "edge": return 60_000;
    case "reauth": return 30_000;
    case "actor": return 5 * 60_000;
    case "dependency": return 5 * 60_000;
    case "not-recorded": return 15 * 60_000;
    default: return 0;
  }
}
