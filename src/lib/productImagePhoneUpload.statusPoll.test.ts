// Desktop status poll transport: every failure carries the HTTP status (0 =
// no response) and Retry-After, so uploadStatusPoller can retry transient
// failures instead of giving up after one.
import { describe, expect, it, vi, afterEach } from "vitest";

vi.mock("./supabase", () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: "user-jwt" } } }) } },
  backendRest: { url: "https://backend.test", anonKey: "anon-key" },
}));

const { getProductImageUploadSessionStatus } = await import("./productImagePhoneUpload");
const { UploadStatusRequestError, classifyStatusPollError } = await import("./uploadStatusPoller");

const ok = { sessionId: "s1", storagePath: "p", expiresAt: "2026-10-15T10:10:00Z", status: "PENDING" };
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers }));

async function failure(fetchImpl: typeof fetch, timeoutMs?: number) {
  try {
    await getProductImageUploadSessionStatus("s1", { fetchImpl, timeoutMs });
  } catch (e) {
    return e as InstanceType<typeof UploadStatusRequestError>;
  }
  throw new Error("expected a failure");
}

afterEach(() => vi.useRealTimers());

describe("getProductImageUploadSessionStatus", () => {
  it("POSTs to the RPC endpoint with the user's JWT and returns the row", async () => {
    const f = reply(200, ok);
    await expect(getProductImageUploadSessionStatus("s1", { fetchImpl: f })).resolves.toEqual(ok);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://backend.test/rest/v1/rpc/get_product_image_upload_session_status");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ apikey: "anon-key", Authorization: "Bearer user-jwt" });
    expect(JSON.parse(String(init.body))).toEqual({ p_session_id: "s1" });
  });

  it("a network error is httpStatus 0 (transient)", async () => {
    const e = await failure(vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    expect(e).toBeInstanceOf(UploadStatusRequestError);
    expect(e.httpStatus).toBe(0);
    expect(classifyStatusPollError(e).kind).toBe("transient");
  });

  it("a hung request times out as httpStatus 0", async () => {
    vi.useFakeTimers();
    const hang = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const p = failure(hang as unknown as typeof fetch, 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    const e = await p;
    expect(e.httpStatus).toBe(0);
    expect(e.message).toMatch(/timed out/);
  });

  it("a 502 HTML page from the proxy is transient", async () => {
    const e = await failure(reply(502, "<html>Bad Gateway</html>"));
    expect(e.httpStatus).toBe(502);
    expect(classifyStatusPollError(e).kind).toBe("transient");
  });

  it("a 429 carries Retry-After", async () => {
    const e = await failure(reply(429, { message: "rate limited" }, { "Retry-After": "17" }));
    expect(e.httpStatus).toBe(429);
    expect(e.retryAfterSeconds).toBe(17);
    expect(classifyStatusPollError(e)).toEqual({ kind: "transient", retryAfterMs: 17_000 });
  });

  it("the RPC's 'Upload session not found' (400) is permanent", async () => {
    const e = await failure(reply(400, { code: "P0001", message: "Upload session not found" }));
    expect(e.httpStatus).toBe(400);
    expect(e.code).toBe("P0001");
    expect(classifyStatusPollError(e)).toEqual({ kind: "permanent" });
  });

  it("a 200 with an unreadable body is transient, a JSON null is not-found", async () => {
    expect((await failure(reply(200, "{trunc"))).httpStatus).toBe(0);
    const e = await failure(reply(200, "null"));
    expect(e.httpStatus).toBe(404);
    expect(classifyStatusPollError(e).kind).toBe("permanent");
  });
});
