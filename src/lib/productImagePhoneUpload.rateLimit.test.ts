// 081 rate limits on the phone side (docs/selfhost-migration/phase-f/rate-limiting.md):
// the phone-upload-token function answers 429 {code:"rate_limited",
// retry_after_seconds} + Retry-After. The phone waits out a short limit by
// itself (bounded), and otherwise shows a friendly message (English + Myanmar).
import { describe, expect, it, vi } from "vitest";
import type { PhoneUploadTarget, ProductImageUploadSessionStatusResult } from "./productImagePhoneUpload";

const invoke = vi.fn();
vi.mock("./supabase", () => ({
  supabase: { rpc: vi.fn(), functions: { invoke: (...a: unknown[]) => invoke(...a) }, storage: { from: () => ({}) } },
}));

const {
  adviseOnRateLimit,
  PHONE_UPLOAD_MAX_AUTO_WAIT_SECONDS,
  PHONE_UPLOAD_MAX_RATE_LIMIT_RETRIES,
  PhoneUploadRateLimitedError,
  requestPhoneUploadTarget,
  uploadPhoneProductImage,
} = await import("./productImagePhoneUpload");
const { phoneUploadRateLimitMessage, phoneUploadStatusText } = await import("./phoneUploadMessages");
const { getTranslation } = await import("../i18n/translations");

const PATH = "org/org-1/temp/pimg-1";
const QR = "q".repeat(128);
const IMAGE = { blob: new Blob(["x"]), bytes: 2048, mimeType: "image/webp" };
const NOW = Date.parse("2026-10-13T10:00:00Z");
const inSeconds = (s: number) => new Date(NOW + s * 1000).toISOString();
const upload = (token: string): PhoneUploadTarget => ({ kind: "upload", storagePath: PATH, uploadToken: token, expiresAt: null });
const completed = (): ProductImageUploadSessionStatusResult => ({
  sessionId: "pimg-1", storagePath: PATH, publicUrl: `https://stack.example/storage/v1/object/public/product-images/${PATH}`,
  bytes: 2048, mimeType: "image/webp", expiresAt: inSeconds(300), status: "COMPLETED",
});
const tFor = (lang: "en" | "my") => (section: string, key: string, vars?: Record<string, string | number>) => {
  let text = getTranslation(lang, section, key);
  for (const [k, v] of Object.entries(vars ?? {})) text = text.replaceAll(`{${k}}`, String(v));
  return text;
};

/** requestTarget answers: a 429 (seconds) or a target. */
const flow = (answers: (number | PhoneUploadTarget)[]) => {
  const requestTarget = vi.fn(async () => {
    const a = answers.shift();
    if (a === undefined) throw new Error("no more answers");
    if (typeof a === "number") throw new PhoneUploadRateLimitedError(a);
    return a;
  });
  const sleep = vi.fn(async () => undefined);
  const onRateLimitWait = vi.fn();
  return {
    requestTarget, sleep, onRateLimitWait,
    uploadToSignedUrl: vi.fn(async () => ({ error: null })),
    complete: vi.fn(async () => completed()),
    readSession: vi.fn(async () => completed()),
    publicUrl: vi.fn(async (p: string) => `https://stack.example/storage/v1/object/public/product-images/${p}`),
  };
};

describe("requestPhoneUploadTarget: 429 mapping", () => {
  it("429 {code:rate_limited, retry_after_seconds} -> PhoneUploadRateLimitedError with that wait", async () => {
    const err = await requestPhoneUploadTarget(QR, async () => ({
      status: 429, body: { error: "Too many upload attempts. Please wait a moment and try again.", code: "rate_limited", retry_after_seconds: 7 }, retryAfter: "7",
    })).catch((e) => e);
    expect(err).toBeInstanceOf(PhoneUploadRateLimitedError);
    expect(err.retryAfterSeconds).toBe(7);
    expect(err.message).toBe("Too many upload attempts. Please wait a moment and try again.");
  });

  it("falls back to the Retry-After header, then to 10 s, when the body has no usable number", async () => {
    const h = await requestPhoneUploadTarget(QR, async () => ({ status: 429, body: null, retryAfter: "12" })).catch((e) => e);
    expect(h.retryAfterSeconds).toBe(12);
    const d = await requestPhoneUploadTarget(QR, async () => ({ status: 429, body: { code: "rate_limited" }, retryAfter: "Wed, 21 Oct 2026 07:28:00 GMT" })).catch((e) => e);
    expect(d.retryAfterSeconds).toBe(10);
  });

  it("reads status, body and Retry-After from a FunctionsHttpError (the real transport)", async () => {
    invoke.mockResolvedValue({
      data: null,
      error: { name: "FunctionsHttpError", context: new Response(JSON.stringify({ error: "x", code: "rate_limited", retry_after_seconds: 4 }), { status: 429, headers: { "Retry-After": "4" } }) },
    });
    const err = await requestPhoneUploadTarget(QR).catch((e) => e);
    expect(err).toBeInstanceOf(PhoneUploadRateLimitedError);
    expect(err.retryAfterSeconds).toBe(4);
  });

  it("503 (limiter unavailable: the server failed closed) stays a plain retryable error, not a rate limit", async () => {
    const err = await requestPhoneUploadTarget(QR, async () => ({ status: 503, body: { error: "Phone upload is temporarily unavailable. Try again.", code: "unavailable" } })).catch((e) => e);
    expect(err).not.toBeInstanceOf(PhoneUploadRateLimitedError);
    expect(err.message).toMatch(/temporarily unavailable/);
  });
});

describe("adviseOnRateLimit", () => {
  it("short wait well before expiry -> wait (rounded up, at least 1 s)", () => {
    expect(adviseOnRateLimit(7, { expiresAt: inSeconds(300), now: NOW })).toEqual({ kind: "wait", seconds: 7 });
    expect(adviseOnRateLimit(0.2, { expiresAt: inSeconds(300), now: NOW })).toEqual({ kind: "wait", seconds: 1 });
    expect(adviseOnRateLimit(PHONE_UPLOAD_MAX_AUTO_WAIT_SECONDS, { now: NOW })).toEqual({ kind: "wait", seconds: 60 });
  });
  it("wait longer than the auto-wait bound -> later (minutes)", () => {
    expect(adviseOnRateLimit(61, { expiresAt: inSeconds(500), now: NOW })).toEqual({ kind: "later", minutes: 2 });
  });
  it("retries used up -> later even for a short wait", () => {
    expect(adviseOnRateLimit(5, { expiresAt: inSeconds(300), now: NOW, retriesSoFar: PHONE_UPLOAD_MAX_RATE_LIMIT_RETRIES })).toEqual({ kind: "later", minutes: 1 });
  });
  it("the wait reaches the link's expiry (per-session cap: Retry-After = time left) -> linkExhausted", () => {
    expect(adviseOnRateLimit(412, { expiresAt: inSeconds(412), now: NOW })).toEqual({ kind: "linkExhausted" });
    expect(adviseOnRateLimit(9, { expiresAt: inSeconds(5), now: NOW })).toEqual({ kind: "linkExhausted" });
  });
});

describe("uploadPhoneProductImage: bounded automatic retry after 429", () => {
  it("one short 429 -> waits Retry-After (+ < 1 s jitter), retries, uploads once, completes once", async () => {
    const d = flow([7, upload("jwt-1")]);
    const res = await uploadPhoneProductImage(QR, IMAGE, { ...d, sessionExpiresAt: new Date(Date.now() + 300_000).toISOString() });
    expect(res.status).toBe("COMPLETED");
    expect(d.requestTarget).toHaveBeenCalledTimes(2);
    expect(d.onRateLimitWait).toHaveBeenCalledWith(7, 1);
    expect(d.sleep).toHaveBeenCalledTimes(1);
    const waited = (d.sleep.mock.calls[0] as unknown as [number])[0];
    expect(waited).toBeGreaterThanOrEqual(7000);
    expect(waited).toBeLessThan(8000);
    expect(d.uploadToSignedUrl).toHaveBeenCalledTimes(1);
    expect(d.complete).toHaveBeenCalledTimes(1);
  });

  it("at most PHONE_UPLOAD_MAX_RATE_LIMIT_RETRIES automatic retries, then the 429 reaches the page", async () => {
    const d = flow([3, 3, 3, 3, upload("never")]);
    const err = await uploadPhoneProductImage(QR, IMAGE, { ...d, sessionExpiresAt: new Date(Date.now() + 300_000).toISOString() }).catch((e) => e);
    expect(err).toBeInstanceOf(PhoneUploadRateLimitedError);
    expect(PHONE_UPLOAD_MAX_RATE_LIMIT_RETRIES).toBe(3);
    expect(d.requestTarget).toHaveBeenCalledTimes(4);
    expect(d.sleep).toHaveBeenCalledTimes(3);
    expect(d.uploadToSignedUrl).not.toHaveBeenCalled();
    expect(d.complete).not.toHaveBeenCalled();
  });

  it("a long Retry-After (or one past the link's expiry) is not waited out: no sleep, the page tells the user", async () => {
    const long = flow([600, upload("never")]);
    await expect(uploadPhoneProductImage(QR, IMAGE, { ...long, sessionExpiresAt: new Date(Date.now() + 300_000).toISOString() })).rejects.toBeInstanceOf(PhoneUploadRateLimitedError);
    expect(long.sleep).not.toHaveBeenCalled();
    const pastExpiry = flow([30, upload("never")]);
    await expect(uploadPhoneProductImage(QR, IMAGE, { ...pastExpiry, sessionExpiresAt: new Date(Date.now() + 10_000).toISOString() })).rejects.toBeInstanceOf(PhoneUploadRateLimitedError);
    expect(pastExpiry.sleep).not.toHaveBeenCalled();
  });

  it("the stale-token refresh still works after a rate-limit wait (expired token -> one fresh token)", async () => {
    const d = flow([2, upload("jwt-old"), upload("jwt-new")]);
    d.uploadToSignedUrl
      .mockResolvedValueOnce({ error: { name: "StorageApiError", status: 400, statusCode: "400", message: '"exp" claim timestamp check failed' } } as never)
      .mockResolvedValueOnce({ error: null });
    const res = await uploadPhoneProductImage(QR, IMAGE, d);
    expect(res.status).toBe("COMPLETED");
    expect(d.requestTarget).toHaveBeenCalledTimes(3);
    expect(d.uploadToSignedUrl).toHaveBeenCalledTimes(2);
  });

  it("other errors are not retried as rate limits", async () => {
    const d = flow([]);
    d.requestTarget.mockRejectedValueOnce(new Error("Phone upload is temporarily unavailable. Try again."));
    await expect(uploadPhoneProductImage(QR, IMAGE, d)).rejects.toThrow(/temporarily unavailable/);
    expect(d.sleep).not.toHaveBeenCalled();
  });
});

describe("phone page wording (English + Myanmar)", () => {
  it("waiting countdown, try-later and link-used-up messages exist in both languages with the numbers filled in", () => {
    for (const lang of ["en", "my"] as const) {
      const t = tFor(lang);
      const wait = phoneUploadStatusText(t, "waiting", 7);
      const later = phoneUploadRateLimitMessage(t, { kind: "later", minutes: 2 });
      const used = phoneUploadRateLimitMessage(t, { kind: "linkExhausted" });
      expect(wait).toContain("7");
      expect(later).toContain("2");
      for (const s of [wait, later, used]) {
        expect(s).not.toMatch(/^rateLimited|\{seconds\}|\{minutes\}/);
        expect(s.length).toBeGreaterThan(10);
      }
    }
    expect(phoneUploadStatusText(tFor("en"), "waiting", 7)).toBe("Too many attempts right now. Trying again automatically in 7 s...");
    expect(phoneUploadRateLimitMessage(tFor("en"), { kind: "later", minutes: 2 })).toBe("Too many upload attempts. Please wait about 2 min and try again.");
    expect(phoneUploadRateLimitMessage(tFor("en"), { kind: "linkExhausted" })).toBe("This upload link has been used too many times. Create a new QR code on the computer.");
    // Myanmar text is Myanmar script
    expect(phoneUploadRateLimitMessage(tFor("my"), { kind: "linkExhausted" })).toMatch(/[က-႟]/);
  });

  it("English status lines are unchanged (spec D matches them verbatim)", () => {
    const t = tFor("en");
    expect(phoneUploadStatusText(t, "ready")).toBe("Choose or take a product photo.");
    expect(phoneUploadStatusText(t, "complete")).toBe("Photo uploaded. You can return to the computer.");
    expect(phoneUploadStatusText(t, "expired")).toBe("This upload link has expired. Create a new QR code on the computer.");
    expect(phoneUploadStatusText(t, "cancelled")).toBe("This upload link was cancelled on the computer. Create a new QR code to upload.");
    expect(phoneUploadStatusText(t, "loading")).toBe("Checking upload link...");
    expect(phoneUploadStatusText(t, "error")).toBe("Upload failed.");
  });

  it("every phoneUpload key exists in both languages", async () => {
    const { translations } = await import("../i18n/translations");
    expect(Object.keys(translations.my.phoneUpload).sort()).toEqual(Object.keys(translations.en.phoneUpload).sort());
    for (const lang of ["en", "my"] as const) {
      for (const [k, v] of Object.entries(translations[lang].phoneUpload)) expect(v, `${lang}.${k}`).toBeTruthy();
    }
  });
});
