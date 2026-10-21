import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProductImageUploadSessionStatusResult } from "./productImagePhoneUpload";
import {
  classifyStatusPollError,
  parseRetryAfterSeconds,
  startUploadStatusPolling,
  UploadStatusRequestError,
  type ReconnectingInfo,
  type UploadStatusPollStop,
} from "./uploadStatusPoller";

// Bug: the desktop QR modal stopped polling for good after ONE failed status
// request (network blip / 5xx / 429), so an upload that succeeded on the
// phone was never shown. These tests drive the poller with fake timers.

const T0 = Date.parse("2026-10-15T10:00:00.000Z");
const EXPIRES = new Date(T0 + 10 * 60_000).toISOString();

const result = (status: ProductImageUploadSessionStatusResult["status"], extra: Partial<ProductImageUploadSessionStatusResult> = {}): ProductImageUploadSessionStatusResult => ({
  sessionId: "s1", storagePath: "org/p/x.webp", expiresAt: EXPIRES, status, ...extra,
});

type Step = ProductImageUploadSessionStatusResult | Error;

function harness(steps: Step[], opts: { expiresAt?: string } = {}) {
  const calls: number[] = [];
  const reconnecting: (ReconnectingInfo | null)[] = [];
  const stops: UploadStatusPollStop[] = [];
  const pending: ProductImageUploadSessionStatusResult[] = [];
  const queue = [...steps];
  const fetchStatus = vi.fn(async () => {
    calls.push(Date.now() - T0);
    const next = queue.shift() ?? result("PENDING");
    if (next instanceof Error) throw next;
    return next;
  });
  const stop = startUploadStatusPolling({
    sessionId: "s1",
    expiresAt: opts.expiresAt ?? EXPIRES,
    fetchStatus,
    onPending: (r) => pending.push(r),
    onReconnecting: (i) => reconnecting.push(i),
    onStop: (s) => stops.push(s),
  });
  return { calls, reconnecting, stops, pending, stop, fetchStatus };
}

const net = () => new UploadStatusRequestError("Could not reach the server to check the upload.", 0);
const http = (status: number, message = `HTTP ${status}`, retryAfterSeconds?: number) =>
  new UploadStatusRequestError(message, status, { retryAfterSeconds });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe("startUploadStatusPolling", () => {
  it("polls every 2 s while PENDING, one request at a time, and stops on COMPLETED", async () => {
    const h = harness([result("PENDING"), result("PENDING"), result("COMPLETED", { publicUrl: "https://x/img.webp" })]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toEqual([0, 2000, 4000]);
    expect(h.pending).toHaveLength(2);
    expect(h.stops).toEqual([{ kind: "status", result: result("COMPLETED", { publicUrl: "https://x/img.webp" }) }]);
    expect(h.reconnecting).toEqual([]);
  });

  it.each(["EXPIRED", "CANCELED"] as const)("stops on %s", async (status) => {
    const h = harness([result(status)]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.calls).toEqual([0]);
    expect(h.stops).toEqual([{ kind: "status", result: result(status) }]);
  });

  it("a network error does not stop polling: it reconnects with backoff and then sees the upload (the D65 case)", async () => {
    const h = harness([result("PENDING"), net(), net(), result("COMPLETED", { publicUrl: "u" })]);
    await vi.advanceTimersByTimeAsync(30_000);
    // 0 ok, 2000 fail -> +2000, 4000 fail -> +4000, 8000 ok
    expect(h.calls).toEqual([0, 2000, 4000, 8000]);
    expect(h.reconnecting.map((r) => r?.failures ?? null)).toEqual([1, 2, null]);
    expect(h.reconnecting[0]).toMatchObject({ nextAttemptAt: T0 + 4000, message: expect.stringMatching(/reach the server/) });
    expect(h.stops).toEqual([{ kind: "status", result: result("COMPLETED", { publicUrl: "u" }) }]);
  });

  it.each([500, 502, 503, 504, 408])("retries an HTTP %i", async (status) => {
    const h = harness([http(status), result("PENDING")]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.calls.slice(0, 2)).toEqual([0, 2000]);
    expect(h.stops).toEqual([]);
    expect(h.reconnecting).toEqual([expect.objectContaining({ failures: 1 }), null]);
  });

  it("backoff doubles and is capped at 15 s", async () => {
    const h = harness(Array.from({ length: 8 }, () => http(502)));
    await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000 + 15_000 + 15_000 + 15_000 + 15_000);
    const gaps = h.calls.slice(1).map((t, i) => t - h.calls[i]);
    expect(gaps).toEqual([2000, 4000, 8000, 15_000, 15_000, 15_000, 15_000]);
    expect(h.stops).toEqual([]);
  });

  it("a 429 waits for Retry-After before the next request", async () => {
    const h = harness([http(429, "rate limited", 30), result("PENDING")]);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.calls).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toEqual([0, 30_000]);
    expect(h.reconnecting[0]).toMatchObject({ failures: 1, nextAttemptAt: T0 + 30_000 });
    expect(h.stops).toEqual([]);
  });

  it("a 429 without Retry-After uses the normal backoff", async () => {
    const h = harness([http(429), result("PENDING")]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.calls).toEqual([0, 2000]);
  });

  it("an RPC 'Upload session not found' (HTTP 400) stops with an error", async () => {
    const h = harness([http(400, "Upload session not found")]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.calls).toEqual([0]);
    expect(h.stops).toEqual([{ kind: "error", message: "Upload session not found" }]);
  });

  it("an HTTP 404 stops with an error", async () => {
    const h = harness([http(404, "Not Found")]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.calls).toEqual([0]);
    expect(h.stops[0]).toMatchObject({ kind: "error" });
  });

  it("'Not authenticated' (auth session refreshing) is retried, not final", async () => {
    const h = harness([http(400, "Not authenticated"), result("PENDING")]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.calls).toEqual([0, 2000]);
    expect(h.stops).toEqual([]);
  });

  it("retries end at the session expiry (+10 s grace) with one last attempt there", async () => {
    const expiresAt = new Date(T0 + 60_000).toISOString();
    const h = harness(Array.from({ length: 50 }, () => net()), { expiresAt });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.calls[h.calls.length - 1]).toBe(70_000);
    expect(h.calls.every((t) => t <= 70_000)).toBe(true);
    expect(h.stops).toEqual([{ kind: "expired", message: expect.stringMatching(/expired/) }]);
    const n = h.fetchStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetchStatus.mock.calls.length).toBe(n);
  });

  it("a Retry-After longer than the remaining session is cut to the deadline", async () => {
    const expiresAt = new Date(T0 + 20_000).toISOString();
    const h = harness([http(429, "slow down", 600), result("EXPIRED")], { expiresAt });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.calls).toEqual([0, 30_000]);
    expect(h.stops).toEqual([{ kind: "status", result: result("EXPIRED") }]);
  });

  it("the stop function ends polling with no callback", async () => {
    const h = harness([]);
    await vi.advanceTimersByTimeAsync(0);
    h.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.calls).toEqual([0]);
    expect(h.stops).toEqual([]);
  });
});

describe("classifyStatusPollError / parseRetryAfterSeconds", () => {
  it("classifies", () => {
    expect(classifyStatusPollError(new TypeError("Failed to fetch"))).toEqual({ kind: "transient" });
    expect(classifyStatusPollError(http(503, "x", 5))).toEqual({ kind: "transient", retryAfterMs: 5000 });
    expect(classifyStatusPollError(http(401, "JWT expired"))).toEqual({ kind: "transient" });
    expect(classifyStatusPollError(http(403, "permission denied"))).toEqual({ kind: "permanent" });
    expect(classifyStatusPollError(http(502, "Upload session not found"))).toEqual({ kind: "permanent" });
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfterSeconds("12")).toBe(12);
    expect(parseRetryAfterSeconds(new Date(T0 + 7_500).toUTCString(), T0)).toBe(7);
    expect(parseRetryAfterSeconds("soon")).toBeUndefined();
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
  });
});
