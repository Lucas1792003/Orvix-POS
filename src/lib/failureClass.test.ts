import { describe, expect, it } from "vitest";
import { classifyFailure, looksLikeGatewayBody, signalOf, type FailureClass } from "./failureClass";
import { noteResponseForRetryAfter, parseRetryAfter, resetRetryAfterForTests, retryAfterRemainingMs } from "./retryAfter";

// Batch 2A — one row per signal of the classification matrix (status ×
// SQLSTATE/code × message/hint × body shape). Shapes follow what
// supabase-js 2.106 reports (verified on Envoy + PostgREST v14.17).
const cases: [string, Parameters<typeof classifyFailure>[0], FailureClass, boolean][] = [
  // name, signal, class, mayHaveCommitted
  ["not sent (offline before the request)", { notSent: true }, "NOT_SENT", false],
  ["fetch failure (status 0)", { status: 0, message: "TypeError: Failed to fetch" }, "UNKNOWN_OUTCOME", true],
  ["client timeout after send", { status: 0, code: "TIMEOUT", message: "complete_sale timed out after 30s", timedOut: true }, "UNKNOWN_OUTCOME", true],
  ["abort error", { status: 0, message: "AbortError: The operation was aborted" }, "UNKNOWN_OUTCOME", true],
  ["Envoy 503 no healthy upstream", { status: 503, message: "no healthy upstream" }, "NOT_DELIVERED", false],
  ["Envoy 503 connection failure", { status: 503, message: "upstream connect error or disconnect/reset before headers. reset reason: connection failure" }, "NOT_DELIVERED", false],
  ["Envoy 503 reset after send", { status: 503, message: "upstream connect error or disconnect/reset before headers. reset reason: connection termination" }, "UNKNOWN_OUTCOME", true],
  ["502 bad gateway (HTML)", { status: 502, message: "<html><body>502 Bad Gateway</body></html>" }, "UNKNOWN_OUTCOME", true],
  ["504 gateway timeout", { status: 504, message: "upstream request timeout" }, "UNKNOWN_OUTCOME", true],
  ["Cloudflare 520", { status: 520, message: "<!DOCTYPE html>error code: 520" }, "UNKNOWN_OUTCOME", true],
  ["Cloudflare 521 origin down", { status: 521, message: "<html>Web server is down</html>" }, "NOT_DELIVERED", false],
  ["Cloudflare 522 connection timed out", { status: 522, message: "" }, "NOT_DELIVERED", false],
  ["Cloudflare 523 origin unreachable", { status: 523, message: "" }, "NOT_DELIVERED", false],
  ["Cloudflare 524 timeout after connect", { status: 524, message: "<html>A timeout occurred</html>" }, "UNKNOWN_OUTCOME", true],
  ["Cloudflare 530", { status: 530, message: "error code: 1016" }, "NOT_DELIVERED", false],
  ["HTML 403 from an edge/WAF", { status: 403, message: "<html><head><title>Attention Required!</title></head></html>" }, "EDGE_BLOCKED", false],
  ["empty 403", { status: 403, message: "" }, "EDGE_BLOCKED", false],
  ["PT503 org suspended", { status: 503, code: "PT503", message: "ORG_SUSPENDED: service unavailable" }, "ORG_SUSPENDED", false],
  ["ORG_SUSPENDED prefix at another status", { status: 400, code: "P0001", message: "ORG_SUSPENDED: this organisation is suspended" }, "ORG_SUSPENDED", false],
  ["maintenance JSON 503", { status: 503, code: "MAINTENANCE", message: "maintenance" }, "TEMPORARY_SERVER", false],
  ["PostgREST pool timeout 503", { status: 503, code: "PGRST003", message: "Timed out acquiring connection from connection pool." }, "TEMPORARY_SERVER", false],
  ["429 rate limited", { status: 429, message: "Too Many Requests" }, "TEMPORARY_SERVER", false],
  ["408", { status: 408, message: "Request Timeout" }, "TEMPORARY_SERVER", false],
  ["500 serialization failure", { status: 500, code: "40001", message: "could not serialize access" }, "TEMPORARY_SERVER", false],
  ["500 statement timeout", { status: 500, code: "57014", message: "canceling statement due to statement timeout" }, "TEMPORARY_SERVER", false],
  ["500 internal (JSON)", { status: 500, code: "XX000", message: "internal error" }, "TEMPORARY_SERVER", false],
  ["500 without a body", { status: 500, message: "" }, "UNKNOWN_OUTCOME", true],
  ["401 JWT expired", { status: 401, code: "PGRST301", message: "JWT expired" }, "AUTH_REFRESH", false],
  ["401 invalid signature", { status: 401, code: "PGRST301", message: "JWSError JWSInvalidSignature" }, "AUTH_REAUTH", false],
  ["401 from the gateway (no JSON)", { status: 401, message: "" }, "AUTH_REAUTH", false],
  ["400 Not authenticated (no app user)", { status: 400, code: "P0001", message: "Not authenticated" }, "AUTH_REAUTH", false],
  ["OX204 MFA required", { status: 400, code: "OX204", message: "MFA required", hint: "rule=MFA_REQUIRED" }, "AUTH_REAUTH", false],
  ["business refusal P0001", { status: 400, code: "P0001", message: "Insufficient stock for Tea: have 1, need 2" }, "REJECTED", false],
  // Step 6 (PFIN-F / PDISC-A): financial refusals are definitive, like any business refusal — also when the pinned
  // 086 executor did not record them (op_not_recorded:unclassified) or they ride on a 500
  ["DISCOUNT_APPROVAL_REQUIRED (400 P0001)", { status: 400, code: "P0001", message: "DISCOUNT_APPROVAL_REQUIRED: this discount (600 MMK, 6.00% of 10000) needs a separate approval by a Shop Admin" }, "REJECTED", false],
  ["DISCOUNT_APPROVAL_INVALID via op_execute (not recorded)", { status: 400, code: "P0001", message: "DISCOUNT_APPROVAL_INVALID: the approval expired; request it again", hint: "op_not_recorded:unclassified" }, "REJECTED", false],
  ["DISCOUNT_APPROVAL_OFFLINE (500 P0001)", { status: 500, code: "P0001", message: "DISCOUNT_APPROVAL_OFFLINE: a discount that needs approval (500 MMK, 5.00%) cannot be given offline; nothing was saved" }, "REJECTED", false],
  ["FIN_NON_CASH_CHANGE", { status: 400, code: "P0001", message: "FIN_NON_CASH_CHANGE: change is given only from cash; a non-cash payment is recorded for exactly the amount due" }, "REJECTED", false],
  ["FIN_REFUND_OFFLINE", { status: 400, code: "P0001", message: "FIN_REFUND_OFFLINE: refund and void requests are recorded online only (nothing was saved)", hint: "op_not_recorded:unclassified" }, "REJECTED", false],
  ["FIN_REFUND_EXCEPTION_PENDING", { status: 400, code: "P0001", message: "FIN_REFUND_EXCEPTION_PENDING: a Shop Admin decision is outstanding or refused (REFUND_ALT_PAYOUT REQUESTED)" }, "REJECTED", false],
  ["FIN_APPROVAL_SELF", { status: 400, code: "P0001", message: "FIN_APPROVAL_SELF: you cannot decide your own request; another approver must" }, "REJECTED", false],
  ["FIN_DRAWER_INSUFFICIENT", { status: 400, code: "P0001", message: "FIN_DRAWER_INSUFFICIENT: a cash refund of 5000 MMK would take the drawer below zero (100 MMK expected)" }, "REJECTED", false],
  ["a financial code inside a gateway timeout is still unknown", { status: 0, code: "TIMEOUT", message: "complete_sale timed out after 30s", timedOut: true }, "UNKNOWN_OUTCOME", true],
  ["OX101 refusal with hint", { status: 400, code: "OX101", message: "Discount not permitted", hint: "rule=DISCOUNT_NOT_PERMITTED" }, "REJECTED", false],
  ["RLS 42501", { status: 403, code: "42501", message: "permission denied for table sales" }, "REJECTED", false],
  ["unique violation 23505", { status: 409, code: "23505", message: "duplicate key value violates unique constraint \"shops_org_name_key\"" }, "REJECTED", false],
  ["IDEMPOTENCY_MISMATCH", { status: 409, code: "23505", message: "IDEMPOTENCY_MISMATCH: key k was used for a different request" }, "CONTRACT", false],
  ["IDEMPOTENCY_KEY_REQUIRED", { status: 400, code: "22023", message: "IDEMPOTENCY_KEY_REQUIRED" }, "CONTRACT", false],
  ["unknown function (older server)", { status: 404, code: "PGRST202", message: "Could not find the function public.apply_catalog_write" }, "WAITING_BACKEND", false],
  ["undefined column 42703", { status: 400, code: "42703", message: "column products.updated_at does not exist" }, "WAITING_BACKEND", false],
  ["thrown non-HTTP refusal", { message: "Shift not found." }, "REJECTED", false],
  ["thrown TypeError fetch", { message: "TypeError: Failed to fetch" }, "UNKNOWN_OUTCOME", true],
];

describe("classifyFailure — the matrix", () => {
  for (const [name, signal, klass, mayHaveCommitted] of cases) {
    it(`${name} → ${klass}`, () => {
      const f = classifyFailure(signal);
      expect(f.klass).toBe(klass);
      expect(f.mayHaveCommitted).toBe(mayHaveCommitted);
    });
  }

  it("only REJECTED and CONTRACT are definitive refusals; every other class keeps the operation for a same-key resend", () => {
    for (const [, signal, klass] of cases) {
      const f = classifyFailure(signal);
      expect(f.retryable).toBe(klass !== "REJECTED" && klass !== "CONTRACT");
    }
  });

  it("holds: suspended, edge, reauth and server-version waits are never plain retries", () => {
    expect(classifyFailure({ status: 503, code: "PT503", message: "ORG_SUSPENDED: x" }).hold).toBe("suspended");
    expect(classifyFailure({ status: 403, message: "<html>blocked</html>" }).hold).toBe("edge");
    expect(classifyFailure({ status: 401, message: "invalid JWT" }).hold).toBe("reauth");
    expect(classifyFailure({ status: 404, code: "PGRST202", message: "x" }).hold).toBe("backend-version");
    expect(classifyFailure({ status: 0, message: "Failed to fetch" }).hold).toBeNull();
  });

  it("a timeout after submission is never a failure: unknown outcome, same key", () => {
    const f = classifyFailure({ status: 0, code: "TIMEOUT", timedOut: true, message: "timed out" });
    expect(f).toMatchObject({ klass: "UNKNOWN_OUTCOME", mayHaveCommitted: true, retryable: true });
  });

  it("gateway body detection: HTML or empty without a PostgREST code", () => {
    expect(looksLikeGatewayBody("<html>x</html>", undefined)).toBe(true);
    expect(looksLikeGatewayBody("", undefined)).toBe(true);
    expect(looksLikeGatewayBody("Insufficient stock", "P0001")).toBe(false);
  });

  it("signalOf reads supabase-js error objects and thrown errors", () => {
    expect(signalOf({ message: "m", code: "P0001", hint: "rule=X" }, 400)).toMatchObject({ status: 400, code: "P0001", hint: "rule=X" });
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(signalOf(abort).timedOut).toBe(true);
  });
});

describe("Retry-After", () => {
  it("parses delta-seconds and HTTP dates, capped", () => {
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter("99999")).toBe(10 * 60_000);
    const now = Date.parse("2026-10-17T00:00:00Z");
    expect(parseRetryAfter("Sat, 17 Oct 2026 00:01:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("soon")).toBeUndefined();
  });

  it("is recorded only from 429/503 and reported until it passes", () => {
    resetRetryAfterForTests();
    const now = 1_000_000;
    noteResponseForRetryAfter(200, "60", now);
    expect(retryAfterRemainingMs(now)).toBeUndefined();
    noteResponseForRetryAfter(429, "20", now);
    expect(retryAfterRemainingMs(now)).toBe(20_000);
    expect(retryAfterRemainingMs(now + 21_000)).toBeUndefined();
    resetRetryAfterForTests();
  });
});
