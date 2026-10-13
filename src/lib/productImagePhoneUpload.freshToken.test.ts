// Just-in-time signed upload token for the phone (phone-upload-token Edge
// Function, docs/selfhost-migration/phase-g/phone-upload-jit.md). Storage
// signed upload tokens live UPLOAD_SIGNED_URL_EXPIRATION_TIME (60 s on
// lucashome); the QR session lives 10 min. The phone asks for a token right
// before the transfer, replaces an expired one once, and never creates a
// second object or a second completion.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PhoneUploadTarget, ProductImageUploadSessionStatusResult } from "./productImagePhoneUpload";

const rpc = vi.fn();
const invoke = vi.fn();
const createSignedUploadUrl = vi.fn();
vi.mock("./supabase", () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpc(...a),
    functions: { invoke: (...a: unknown[]) => invoke(...a) },
    storage: { from: () => ({ createSignedUploadUrl: (...a: unknown[]) => createSignedUploadUrl(...a) }) },
  },
}));

const lib = await import("./productImagePhoneUpload");
const {
  classifyStorageUploadError,
  createPhoneProductImageUploadSession,
  PHONE_UPLOAD_TOKEN_FUNCTION,
  PhoneUploadInactiveError,
  PhoneUploadRefusedError,
  requestPhoneUploadTarget,
  uploadPhoneProductImage,
} = lib;

const PATH = "org/org-1/temp/pimg-1";
const QR = "q".repeat(128);
const IMAGE = { blob: new Blob(["x"]), bytes: 2048, mimeType: "image/webp" };
const PUBLIC = (p: string) => `https://stack.example/storage/v1/object/public/product-images/${p}`;
const completed = (over: Partial<ProductImageUploadSessionStatusResult> = {}): ProductImageUploadSessionStatusResult => ({
  sessionId: "pimg-1",
  storagePath: PATH,
  publicUrl: PUBLIC(PATH),
  bytes: 2048,
  mimeType: "image/webp",
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
  status: "COMPLETED",
  ...over,
});
const upload = (token: string): PhoneUploadTarget => ({ kind: "upload", storagePath: PATH, uploadToken: token, expiresAt: null });

// storage-js error shapes (StorageApiError / StorageUnknownError)
const expiredJwt = { name: "StorageApiError", status: 400, statusCode: "400", message: '"exp" claim timestamp check failed' };
const duplicate = { name: "StorageApiError", status: 409, statusCode: "409", message: "The resource already exists" };
const network = { name: "StorageUnknownError", message: "Failed to fetch" };

const deps = (targets: PhoneUploadTarget[], uploads: { error: unknown }[]) => {
  const requestTarget = vi.fn(async () => {
    const t = targets.shift();
    if (!t) throw new Error("no more targets");
    return t;
  });
  const uploadToSignedUrl = vi.fn(async () => uploads.shift() ?? { error: null });
  const complete = vi.fn(async () => completed());
  const readSession = vi.fn(async () => completed());
  const publicUrl = vi.fn(async (p: string) => PUBLIC(p));
  return { requestTarget, uploadToSignedUrl, complete, readSession, publicUrl };
};

beforeEach(() => {
  rpc.mockReset();
  invoke.mockReset();
  createSignedUploadUrl.mockReset();
});

describe("createPhoneProductImageUploadSession (desktop)", () => {
  it("creates the session and the QR only: no storage signing, no attach RPC", async () => {
    rpc.mockResolvedValue({ data: { sessionId: "pimg-1", token: QR, storagePath: PATH, expiresAt: "2026-10-12T10:10:00Z", status: "PENDING" }, error: null });
    const s = await createPhoneProductImageUploadSession({ productId: "p1", shopId: "s1", origin: "https://pos.example/" });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("create_product_image_upload_session", { p_product_id: "p1", p_shop_id: "s1" });
    expect(createSignedUploadUrl).not.toHaveBeenCalled();
    expect(rpc.mock.calls.map((c) => c[0])).not.toContain("attach_product_image_upload_session_token");
    expect(s.qrUrl).toBe(`https://pos.example/phone-upload/product-image/${QR}`);
    expect(s).not.toHaveProperty("uploadToken");
  });

  it("no longer exports the desktop refresh / attach helpers", () => {
    expect(lib).not.toHaveProperty("issueSignedUploadToken");
    expect(lib).not.toHaveProperty("SIGNED_UPLOAD_TOKEN_REFRESH_MS");
    expect(lib).not.toHaveProperty("getFreshPhoneUploadTarget");
  });
});

describe("requestPhoneUploadTarget (phone -> phone-upload-token)", () => {
  it("calls the function with the QR session token only (anon client, no user session)", async () => {
    invoke.mockResolvedValue({ data: { token: "jwt-1", path: PATH, expiresAt: "2026-10-12T10:01:00.000Z" }, error: null });
    await expect(requestPhoneUploadTarget(QR)).resolves.toEqual({ kind: "upload", storagePath: PATH, uploadToken: "jwt-1", expiresAt: "2026-10-12T10:01:00.000Z" });
    expect(invoke).toHaveBeenCalledWith(PHONE_UPLOAD_TOKEN_FUNCTION, { body: { token: QR } });
    expect(PHONE_UPLOAD_TOKEN_FUNCTION).toBe("phone-upload-token");
  });

  it("maps { alreadyUploaded } to a completion-only target", async () => {
    const call = vi.fn(async () => ({ status: 200, body: { alreadyUploaded: true, path: PATH } }));
    await expect(requestPhoneUploadTarget(QR, call)).resolves.toEqual({ kind: "alreadyUploaded", storagePath: PATH });
  });

  it.each(["EXPIRED", "CANCELED", "COMPLETED"] as const)("410 %s -> PhoneUploadInactiveError with that status", async (status) => {
    const call = vi.fn(async () => ({ status: 410, body: { error: "x", code: "inactive", status } }));
    const err = await requestPhoneUploadTarget(QR, call).catch((e) => e);
    expect(err).toBeInstanceOf(PhoneUploadInactiveError);
    expect(err.status).toBe(status);
  });

  it("clear messages for expired and cancelled links", () => {
    expect(new PhoneUploadInactiveError("EXPIRED").message).toBe("This upload link has expired.");
    expect(new PhoneUploadInactiveError("CANCELED").message).toMatch(/cancelled on the computer/);
  });

  it("404 / 403 -> PhoneUploadRefusedError with the server's generic message", async () => {
    for (const [status, error] of [[404, "Invalid upload link."], [403, "This upload link can no longer be used."]] as const) {
      const err = await requestPhoneUploadTarget(QR, async () => ({ status, body: { error, code: "x" } })).catch((e) => e);
      expect(err).toBeInstanceOf(PhoneUploadRefusedError);
      expect(err.message).toBe(error);
    }
  });

  it("503 / unreadable body / malformed 200 -> plain retryable error", async () => {
    await expect(requestPhoneUploadTarget(QR, async () => ({ status: 503, body: null }))).rejects.toThrow(/temporarily unavailable/);
    await expect(requestPhoneUploadTarget(QR, async () => ({ status: 200, body: { path: PATH } }))).rejects.toThrow(/unexpected answer/);
  });

  it("reads the status and body of a FunctionsHttpError (non-2xx)", async () => {
    invoke.mockResolvedValue({ data: null, error: { name: "FunctionsHttpError", context: new Response(JSON.stringify({ error: "This upload link has expired.", code: "inactive", status: "EXPIRED" }), { status: 410 }) } });
    const err = await requestPhoneUploadTarget(QR).catch((e) => e);
    expect(err).toBeInstanceOf(PhoneUploadInactiveError);
    expect(err.status).toBe("EXPIRED");
  });

  it("a network failure reaching the function is reported, not swallowed", async () => {
    invoke.mockResolvedValue({ data: null, error: { name: "FunctionsFetchError", context: new TypeError("Failed to fetch") } });
    await expect(requestPhoneUploadTarget(QR)).rejects.toThrow(/Could not reach the server/);
  });
});

describe("classifyStorageUploadError", () => {
  it("recognises storage-api's expired-token, duplicate and network failures", () => {
    expect(classifyStorageUploadError(expiredJwt)).toBe("expired_token");
    expect(classifyStorageUploadError({ status: 400, statusCode: "InvalidJWT", message: "jwt expired" })).toBe("expired_token");
    expect(classifyStorageUploadError(duplicate)).toBe("duplicate");
    expect(classifyStorageUploadError({ status: 400, statusCode: "409", message: "Duplicate" })).toBe("duplicate");
    expect(classifyStorageUploadError(network)).toBe("network");
    expect(classifyStorageUploadError({ name: "StorageApiError", status: 413, statusCode: "413", message: "Payload too large" })).toBe("other");
  });
});

describe("uploadPhoneProductImage (phone)", () => {
  it("token just in time -> upload to the SERVER's path -> complete with getPublicUrl(path)", async () => {
    const d = deps([upload("jwt-1")], [{ error: null }]);
    await expect(uploadPhoneProductImage(QR, IMAGE, d)).resolves.toMatchObject({ status: "COMPLETED" });
    expect(d.requestTarget).toHaveBeenCalledTimes(1);
    expect(d.uploadToSignedUrl).toHaveBeenCalledWith(PATH, "jwt-1", IMAGE);
    expect(d.complete).toHaveBeenCalledWith({ token: QR, storagePath: PATH, publicUrl: PUBLIC(PATH), bytes: 2048, mimeType: "image/webp" });
    // the token is requested BEFORE the transfer, never earlier
    expect(d.requestTarget.mock.invocationCallOrder[0]).toBeLessThan(d.uploadToSignedUrl.mock.invocationCallOrder[0]);
  });

  it("storage refuses an expired token -> ONE fresh token, then success", async () => {
    const d = deps([upload("stale"), upload("fresh")], [{ error: expiredJwt }, { error: null }]);
    await expect(uploadPhoneProductImage(QR, IMAGE, d)).resolves.toMatchObject({ status: "COMPLETED" });
    expect(d.uploadToSignedUrl.mock.calls.map((c) => c[1])).toEqual(["stale", "fresh"]);
    expect(d.complete).toHaveBeenCalledTimes(1);
  });

  it("expired twice in a row -> gives up with the storage message (no loop)", async () => {
    const d = deps([upload("a"), upload("b"), upload("c")], [{ error: expiredJwt }, { error: expiredJwt }]);
    await expect(uploadPhoneProductImage(QR, IMAGE, d)).rejects.toThrow(/Image upload failed: "exp" claim/);
    expect(d.requestTarget).toHaveBeenCalledTimes(2);
    expect(d.complete).not.toHaveBeenCalled();
  });

  it("session expired/cancelled when the fresh token is requested -> inactive, no second upload", async () => {
    const d = deps([upload("stale")], [{ error: expiredJwt }]);
    d.requestTarget.mockImplementationOnce(async () => upload("stale")).mockImplementationOnce(async () => { throw new PhoneUploadInactiveError("CANCELED"); });
    const err = await uploadPhoneProductImage(QR, IMAGE, d).catch((e) => e);
    expect(err).toBeInstanceOf(PhoneUploadInactiveError);
    expect(err.status).toBe("CANCELED");
    expect(d.uploadToSignedUrl).toHaveBeenCalledTimes(1);
    expect(d.complete).not.toHaveBeenCalled();
  });

  it("network failure after the transfer landed -> retry finds it already uploaded -> completes once, no re-upload", async () => {
    const d = deps([upload("jwt-1"), { kind: "alreadyUploaded", storagePath: PATH }], [{ error: network }]);
    await expect(uploadPhoneProductImage(QR, IMAGE, d)).resolves.toMatchObject({ status: "COMPLETED" });
    expect(d.uploadToSignedUrl).toHaveBeenCalledTimes(1);
    expect(d.complete).toHaveBeenCalledTimes(1);
  });

  it("network failure before anything landed -> retry uploads with a fresh token", async () => {
    const d = deps([upload("jwt-1"), upload("jwt-2")], [{ error: network }, { error: null }]);
    await expect(uploadPhoneProductImage(QR, IMAGE, d)).resolves.toMatchObject({ status: "COMPLETED" });
    expect(d.uploadToSignedUrl.mock.calls.map((c) => c[1])).toEqual(["jwt-1", "jwt-2"]);
  });

  it("409 duplicate (a concurrent tap won the race) -> proceed to completion without re-uploading", async () => {
    const d = deps([upload("jwt-1")], [{ error: duplicate }]);
    await expect(uploadPhoneProductImage(QR, IMAGE, d)).resolves.toMatchObject({ status: "COMPLETED" });
    expect(d.requestTarget).toHaveBeenCalledTimes(1);
    expect(d.complete).toHaveBeenCalledTimes(1);
  });

  it("completion refused because the session is ALREADY COMPLETED for this path -> success (no second completion)", async () => {
    const d = deps([upload("jwt-1")], [{ error: duplicate }]);
    d.complete.mockRejectedValueOnce(new Error("Upload link is no longer active"));
    await expect(uploadPhoneProductImage(QR, IMAGE, d)).resolves.toMatchObject({ status: "COMPLETED", storagePath: PATH });
    expect(d.complete).toHaveBeenCalledTimes(1);
    expect(d.readSession).toHaveBeenCalledWith(QR);
  });

  it("completion refused and the session is EXPIRED -> inactive error", async () => {
    const d = deps([upload("jwt-1")], [{ error: null }]);
    d.complete.mockRejectedValueOnce(new Error("Upload link is no longer active"));
    d.readSession.mockResolvedValueOnce(completed({ status: "EXPIRED", publicUrl: undefined }));
    const err = await uploadPhoneProductImage(QR, IMAGE, d).catch((e) => e);
    expect(err).toBeInstanceOf(PhoneUploadInactiveError);
    expect(err.status).toBe("EXPIRED");
  });

  it("completion refused for another reason while still PENDING -> that error", async () => {
    const d = deps([upload("jwt-1")], [{ error: null }]);
    d.complete.mockRejectedValueOnce(new Error("Uploaded image must be 100 KB or smaller"));
    d.readSession.mockResolvedValueOnce(completed({ status: "PENDING", publicUrl: undefined }));
    await expect(uploadPhoneProductImage(QR, IMAGE, d)).rejects.toThrow(/100 KB/);
  });

  it("other storage errors are not retried", async () => {
    const d = deps([upload("jwt-1"), upload("jwt-2")], [{ error: { name: "StorageApiError", status: 413, statusCode: "413", message: "Payload too large" } }]);
    await expect(uploadPhoneProductImage(QR, IMAGE, d)).rejects.toThrow(/Payload too large/);
    expect(d.requestTarget).toHaveBeenCalledTimes(1);
  });
});
