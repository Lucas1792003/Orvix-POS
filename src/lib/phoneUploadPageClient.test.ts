// The browser code of the phone-upload-page Edge Function
// (supabase/functions/phone-upload-page/client.js), driven with a fake
// window/DOM and a scripted same-origin fetch. It must behave like the React
// phone page + uploadPhoneProductImage (productImagePhoneUpload.*.test.ts):
// token from the fragment, just-in-time signed token, 429 handling (081),
// one retry on an expired storage token, completion with the server's path.
// docs/selfhost-migration/phase-f/phone-qr-origin.md
import { describe, expect, it } from "vitest";
import { translations } from "../i18n/translations";
import { phoneUploadPage } from "../../supabase/functions/phone-upload-page/client.js";
import { PHONE_UPLOAD_PAGE_MESSAGES } from "../../supabase/functions/phone-upload-page/messages";

const ORIGIN = "https://api.example.test";
const ANON = "anon-key.public.jwt";
const QR = "a".repeat(64) + "b".repeat(64);
const PATH = "org/org-1/temp/pimg-1";
const IMAGE = { blob: new Blob(["webp-bytes"], { type: "image/webp" }), bytes: 2048, mimeType: "image/webp" };
const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

interface Logged { method: string; url: string; headers: Record<string, string>; body: unknown }
type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | "network";

class FakeEl {
  textContent = "";
  hidden = false;
  disabled = false;
  value = "";
  files: File[] | null = null;
  clicks = 0;
  listeners: Record<string, ((e: { target: FakeEl }) => void)[]> = {};
  addEventListener(type: string, fn: (e: { target: FakeEl }) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  click() {
    this.clicks += 1;
    for (const fn of this.listeners.click ?? []) fn({ target: this });
  }
  fire(type: string) {
    for (const fn of this.listeners[type] ?? []) fn({ target: this });
  }
}

function setup(opts: {
  hash?: string;
  session?: Record<string, unknown> | "error";
  fn?: Reply[];
  put?: Reply[];
  complete?: Reply[];
  reread?: Record<string, unknown>;
  stored?: string | null;
  languages?: string[];
} = {}) {
  const ids = ["title", "status", "compressed", "error", "take", "choose", "camera-input", "library-input", "done", "lang"];
  const els: Record<string, FakeEl> = Object.fromEntries(ids.map((id) => [id, new FakeEl()]));
  const storage = new Map<string, string>();
  if (opts.stored) storage.set("pos-language", opts.stored);
  const log: Logged[] = [];
  const sleeps: number[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const queues = { fn: [...(opts.fn ?? [])], put: [...(opts.put ?? [])], complete: [...(opts.complete ?? [])] };
  let sessionReads = 0;

  const reply = (r: Reply | undefined) => {
    if (!r) throw new Error("unexpected extra request");
    if (r === "network") return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve(new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json", ...(r.headers ?? {}) } }));
  };

  const fetch = async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    let body: unknown = init.body;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    log.push({ method: String(init.method), url, headers, body });
    const u = new URL(url);
    expect(u.origin, "same origin only").toBe(ORIGIN);
    if (u.pathname === "/rest/v1/rpc/get_product_image_upload_session_by_token") {
      sessionReads += 1;
      if (sessionReads > 1 && opts.reread) return reply({ status: 200, body: opts.reread });
      if (opts.session === "error") return reply({ status: 400, body: { message: "Invalid upload link" } });
      return reply({ status: 200, body: opts.session ?? { sessionId: "pimg-1", storagePath: PATH, status: "PENDING", expiresAt: inMinutes(9) } });
    }
    // 083 (G5): completion = the same function with action "complete" (byte check server-side)
    if (u.pathname === "/functions/v1/phone-upload-token" && (body as { action?: string } | null)?.action === "complete") {
      return reply(queues.complete.shift() ?? { status: 200, body: { sessionId: "pimg-1", storagePath: PATH, status: "COMPLETED", expiresAt: inMinutes(9), publicUrl: `${ORIGIN}/storage/v1/object/public/product-images/${PATH}` } });
    }
    if (u.pathname === "/functions/v1/phone-upload-token") return reply(queues.fn.shift());
    if (u.pathname.startsWith("/storage/v1/object/upload/sign/")) return reply(queues.put.shift() ?? { status: 200, body: { Key: `product-images/${PATH}` } });
    throw new Error(`unexpected request ${url}`);
  };

  const win = {
    document: { documentElement: { lang: "" }, title: "", getElementById: (id: string) => els[id] },
    location: { origin: ORIGIN, hash: opts.hash ?? `#${QR}` },
    navigator: { languages: opts.languages ?? ["en-US"] },
    localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) },
    fetch,
    FormData,
    setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }),
    clearTimeout: () => undefined,
    console: { error: () => undefined },
  } as Record<string, unknown>;

  const api = phoneUploadPage(win, { anonKey: ANON, messages: PHONE_UPLOAD_PAGE_MESSAGES }, {
    sleep: async (ms: number) => void sleeps.push(ms),
    compress: async () => IMAGE,
    random: () => 0,
  });
  const isComplete = (l: Logged) => (l.body as { action?: string } | null)?.action === "complete";
  const fnCalls = () => log.filter((l) => l.url.endsWith("/functions/v1/phone-upload-token") && !isComplete(l));
  const puts = () => log.filter((l) => l.method === "PUT");
  const completes = () => log.filter((l) => l.url.endsWith("/functions/v1/phone-upload-token") && isComplete(l));
  const pick = () => api.handleFile(new File(["x"], "p.png", { type: "image/png" }));
  return { api, els, log, sleeps, timers, storage, win, fnCalls, puts, completes, pick };
}

const tokenOk = (n = 1): Reply => ({ status: 200, body: { token: `signed-jwt-${n}`, path: PATH, expiresAt: inMinutes(1) } });

describe("phone-upload-page client: loading", () => {
  it("reads the token from the URL fragment and shows the ready state", async () => {
    const p = setup();
    await p.api.ready;
    expect(p.log).toHaveLength(1);
    expect(p.log[0].body).toEqual({ p_token: QR });
    expect(p.log[0].headers).toMatchObject({ apikey: ANON, Authorization: `Bearer ${ANON}` });
    expect(p.els.status.textContent).toBe("Choose or take a product photo.");
    expect(p.els.take.disabled).toBe(false);
    expect(p.els.choose.disabled).toBe(false);
    expect(p.els.error.hidden).toBe(true);
    expect(p.win.shwePhaLaPhoneUpload).toBe(p.api);
  });

  it.each([["no fragment", ""], ["too short", "#abc"], ["markup", `#${encodeURIComponent("<script>" + "x".repeat(40))}`], ["bad escape", "#%E0%A4%A"]])(
    "invalid link (%s): error, no request at all",
    async (_label, hash) => {
      const p = setup({ hash });
      await p.api.ready;
      expect(p.log).toHaveLength(0);
      expect(p.els.error.textContent).toBe("Invalid upload link.");
      expect(p.els.status.textContent).toBe("Upload failed.");
      expect(p.els.take.disabled).toBe(true);
    },
  );

  it("unknown session: error with the server's message", async () => {
    const p = setup({ session: "error" });
    await p.api.ready;
    expect(p.els.error.textContent).toBe("Invalid upload link");
    expect(p.els.take.disabled).toBe(true);
  });

  it.each([["COMPLETED", "Photo uploaded. You can return to the computer."], ["EXPIRED", "This upload link has expired. Create a new QR code on the computer."], ["CANCELED", "This upload link was cancelled on the computer. Create a new QR code to upload."]])(
    "session already %s: final message, buttons disabled",
    async (status, text) => {
      const p = setup({ session: { sessionId: "pimg-1", storagePath: PATH, status, expiresAt: inMinutes(5) } });
      await p.api.ready;
      expect(p.els.status.textContent).toBe(text);
      expect(p.els.take.disabled).toBe(true);
    },
  );

  it("a PENDING session past its expiry shows expired; a live one arms the expiry timer", async () => {
    const past = setup({ session: { sessionId: "pimg-1", storagePath: PATH, status: "PENDING", expiresAt: new Date(Date.now() - 1000).toISOString() } });
    await past.api.ready;
    expect(past.els.status.textContent).toMatch(/expired/);
    const live = setup();
    await live.api.ready;
    expect(live.timers.some((t) => t.ms > 8 * 60_000)).toBe(true);
    live.timers.find((t) => t.ms > 8 * 60_000)!.fn();
    expect(live.els.status.textContent).toMatch(/expired/);
  });

  it("bilingual: follows the stored app language, else the phone's language; the toggle switches and persists", async () => {
    const my = setup({ stored: JSON.stringify({ state: { language: "my" }, version: 2 }) });
    await my.api.ready;
    expect(my.els.status.textContent).toBe(PHONE_UPLOAD_PAGE_MESSAGES.my.ready);
    expect(my.els.lang.textContent).toBe("English");
    my.els.lang.click();
    expect(my.els.status.textContent).toBe("Choose or take a product photo.");
    expect(JSON.parse(my.storage.get("pos-language")!).state.language).toBe("en");
    const phoneMy = setup({ languages: ["my-MM", "en"] });
    await phoneMy.api.ready;
    expect(phoneMy.els.take.textContent).toBe(PHONE_UPLOAD_PAGE_MESSAGES.my.takePhoto);
  });

  it("the buttons open the hidden file inputs; a pick starts the upload and clears the input", async () => {
    const p = setup({ fn: [tokenOk()] });
    await p.api.ready;
    p.els.take.click();
    p.els.choose.click();
    expect(p.els["camera-input"].clicks).toBe(1);
    expect(p.els["library-input"].clicks).toBe(1);
    p.els["library-input"].files = [new File(["x"], "p.png", { type: "image/png" })];
    p.els["library-input"].value = "C:\\fakepath\\p.png";
    p.els["library-input"].fire("change");
    expect(p.els["library-input"].value).toBe("");
    await expect.poll(() => p.els.status.textContent).toBe("Photo uploaded. You can return to the computer.");
  });
});

describe("phone-upload-page client: upload", () => {
  it("happy path: token just in time -> PUT to the signed URL -> completion with the server's path", async () => {
    const p = setup({ fn: [tokenOk()] });
    await p.api.ready;
    expect(p.fnCalls()).toHaveLength(0); // never at page load
    await p.pick();
    expect(p.els.status.textContent).toBe("Photo uploaded. You can return to the computer.");
    expect(p.els.done.hidden).toBe(false);
    expect(p.els.compressed.textContent).toBe("Compressed: 2 KB");

    const [fn] = p.fnCalls();
    expect(fn.method).toBe("POST");
    expect(fn.body).toEqual({ token: QR });
    expect(fn.headers).toMatchObject({ apikey: ANON, Authorization: `Bearer ${ANON}`, "Content-Type": "application/json" });

    const [put] = p.puts();
    const u = new URL(put.url);
    expect(u.pathname).toBe(`/storage/v1/object/upload/sign/product-images/${PATH}`);
    expect(u.searchParams.get("token")).toBe("signed-jwt-1");
    expect(put.headers).toMatchObject({ "x-upsert": "false", apikey: ANON });
    const form = put.body as FormData;
    expect(form.get("cacheControl")).toBe("31536000");
    expect(form.get("")).toBeInstanceOf(Blob);

    // 083 (G5): completion through the validating function, never the RPC
    const [done] = p.completes();
    expect(done.method).toBe("POST");
    expect(done.body).toEqual({ token: QR, action: "complete" });
    expect(done.headers).toMatchObject({ apikey: ANON, Authorization: `Bearer ${ANON}` });
    expect(p.log.some((l) => l.url.includes("complete_product_image_upload_session"))).toBe(false);
    // only the anon key, only the session token from the fragment
    for (const l of p.log) expect(JSON.stringify(l.headers)).not.toMatch(/service/i);
  });

  it("083: the server refuses the stored file (422 invalid_image): its message is shown, nothing completed", async () => {
    const p = setup({
      fn: [tokenOk()],
      complete: [{ status: 422, body: { error: "The uploaded file is not a valid JPEG or WebP photo under 100 KB. Please choose another photo.", code: "invalid_image" } }],
    });
    await p.api.ready;
    await p.pick();
    expect(p.completes()).toHaveLength(1);
    expect(p.els.error.textContent).toBe("The uploaded file is not a valid JPEG or WebP photo under 100 KB. Please choose another photo.");
    expect(p.els.done.hidden).toBe(true);
  });

  it("083: completion answers 410 COMPLETED (a concurrent attempt won): re-read -> success for the same path", async () => {
    const p = setup({
      fn: [tokenOk()],
      complete: [{ status: 410, body: { error: "x", code: "inactive", status: "COMPLETED" } }],
      reread: { sessionId: "pimg-1", storagePath: PATH, status: "COMPLETED", expiresAt: inMinutes(5) },
    });
    await p.api.ready;
    await p.pick();
    expect(p.els.status.textContent).toMatch(/Photo uploaded/);
  });

  it("double tap: a second pick while the first is in flight does nothing", async () => {
    const p = setup({ fn: [tokenOk()] });
    await p.api.ready;
    await Promise.all([p.pick(), p.pick()]);
    expect(p.fnCalls()).toHaveLength(1);
    expect(p.puts()).toHaveLength(1);
    expect(p.completes()).toHaveLength(1);
  });

  it("expired storage token (400 exp): one fresh token, then success", async () => {
    const p = setup({ fn: [tokenOk(1), tokenOk(2)], put: [{ status: 400, body: { statusCode: "400", error: "InvalidJWT", message: '"exp" claim timestamp check failed' } }] });
    await p.api.ready;
    await p.pick();
    expect(p.fnCalls()).toHaveLength(2);
    expect(p.puts().map((x) => new URL(x.url).searchParams.get("token"))).toEqual(["signed-jwt-1", "signed-jwt-2"]);
    expect(p.els.status.textContent).toMatch(/Photo uploaded/);
  });

  it("network failure on the PUT: retried once with a fresh token", async () => {
    const p = setup({ fn: [tokenOk(1), { status: 200, body: { alreadyUploaded: true, path: PATH } }], put: ["network"] });
    await p.api.ready;
    await p.pick();
    expect(p.puts()).toHaveLength(1); // the server says it landed: no second PUT
    expect(p.completes()).toHaveLength(1);
    expect(p.els.status.textContent).toMatch(/Photo uploaded/);
  });

  it("409 duplicate: the object is there, go to completion", async () => {
    const p = setup({ fn: [tokenOk()], put: [{ status: 400, body: { statusCode: "409", error: "Duplicate", message: "The resource already exists" } }] });
    await p.api.ready;
    await p.pick();
    expect(p.fnCalls()).toHaveLength(1);
    expect(p.completes()).toHaveLength(1);
  });

  it("a second storage failure is an error (no third attempt)", async () => {
    const exp = { status: 400, body: { statusCode: "400", message: "jwt expired" } } as Reply;
    const p = setup({ fn: [tokenOk(1), tokenOk(2)], put: [exp, exp] });
    await p.api.ready;
    await p.pick();
    expect(p.puts()).toHaveLength(2);
    expect(p.completes()).toHaveLength(0);
    expect(p.els.error.textContent).toBe("Image upload failed: jwt expired");
  });

  it("completion fails but the session is already COMPLETED for the same path: success", async () => {
    const p = setup({ fn: [tokenOk()], complete: [{ status: 400, body: { message: "Upload session is not pending" } }], reread: { sessionId: "pimg-1", storagePath: PATH, status: "COMPLETED", expiresAt: inMinutes(5) } });
    await p.api.ready;
    await p.pick();
    expect(p.els.status.textContent).toMatch(/Photo uploaded/);
  });

  it.each([["EXPIRED", /expired/], ["CANCELED", /cancelled/]])("function says the session is %s (410): final message, no PUT", async (status, text) => {
    const p = setup({ fn: [{ status: 410, body: { error: "x", code: "inactive", status } }] });
    await p.api.ready;
    await p.pick();
    expect(p.puts()).toHaveLength(0);
    expect(p.els.status.textContent).toMatch(text);
  });

  it("refused (404/403): the server's message, no PUT", async () => {
    const p = setup({ fn: [{ status: 403, body: { error: "This upload link can no longer be used.", code: "refused" } }] });
    await p.api.ready;
    await p.pick();
    expect(p.puts()).toHaveLength(0);
    expect(p.els.error.textContent).toBe("This upload link can no longer be used.");
  });
});

describe("phone-upload-page client: 081 rate limits", () => {
  it("short 429: shows the countdown, waits Retry-After (+ jitter), retries by itself, completes", async () => {
    const p = setup({ fn: [{ status: 429, body: { error: "Too many", code: "rate_limited", retry_after_seconds: 3 }, headers: { "Retry-After": "3" } }, tokenOk()] });
    await p.api.ready;
    await p.pick();
    expect(p.sleeps).toEqual([3000]);
    expect(p.fnCalls()).toHaveLength(2);
    expect(p.els.status.textContent).toMatch(/Photo uploaded/);
    // the countdown text was shown while waiting
    const p2 = setup({ fn: [{ status: 429, body: { code: "rate_limited", retry_after_seconds: 3 } }, tokenOk()] });
    await p2.api.ready;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const api2 = phoneUploadPage(p2.win, { anonKey: ANON, messages: PHONE_UPLOAD_PAGE_MESSAGES }, { sleep: () => gate, compress: async () => IMAGE, random: () => 0 });
    await api2.ready;
    const pending = api2.handleFile(new File(["x"], "p.png", { type: "image/png" }));
    await expect.poll(() => p2.els.status.textContent).toBe("Too many attempts right now. Trying again automatically in 3 s...");
    release();
    await pending;
  });

  it("Retry-After header is used when the body has no number", async () => {
    const p = setup({ fn: [{ status: 429, body: { code: "rate_limited" }, headers: { "Retry-After": "7" } }, tokenOk()] });
    await p.api.ready;
    await p.pick();
    expect(p.sleeps).toEqual([7000]);
  });

  it("at most 3 automatic retries, then the 'try again later' message and the photo can be picked again", async () => {
    const r429 = { status: 429, body: { code: "rate_limited", retry_after_seconds: 2 } } as Reply;
    const p = setup({ fn: [r429, r429, r429, r429] });
    await p.api.ready;
    await p.pick();
    expect(p.sleeps).toHaveLength(3);
    expect(p.puts()).toHaveLength(0);
    expect(p.els.error.textContent).toBe("Too many upload attempts. Please wait about 1 min and try again.");
    expect(p.els.take.disabled).toBe(false);
  });

  it("long 429 (> 60 s, before expiry): no automatic wait, 'about N min' message", async () => {
    const p = setup({ fn: [{ status: 429, body: { code: "rate_limited", retry_after_seconds: 90 } }] });
    await p.api.ready;
    await p.pick();
    expect(p.sleeps).toHaveLength(0);
    expect(p.els.error.textContent).toBe("Too many upload attempts. Please wait about 2 min and try again.");
  });

  it("429 until after the link expires (lifetime cap): 'create a new QR', final", async () => {
    const p = setup({ fn: [{ status: 429, body: { code: "rate_limited", retry_after_seconds: 600 } }] });
    await p.api.ready;
    await p.pick();
    expect(p.sleeps).toHaveLength(0);
    expect(p.els.error.textContent).toBe("This upload link has been used too many times. Create a new QR code on the computer.");
    expect(p.els.take.disabled).toBe(true);
  });
});

describe("phone-upload-page client: embedding", () => {
  it("is self-contained (embeddable with Function.prototype.toString)", () => {
    const src = phoneUploadPage.toString();
    expect(src.startsWith("function phoneUploadPage(win, cfg, deps)")).toBe(true);
    expect(src).not.toMatch(/<\/script|<!--|\bimport\b|\brequire\(|https?:\/\//);
    // runs from its source text alone
    const rebuilt = new Function(`return (${src});`)() as typeof phoneUploadPage;
    expect(typeof rebuilt).toBe("function");
  });

  it("wording is identical to the React phone page (src/i18n/translations.ts phoneUpload)", () => {
    expect(PHONE_UPLOAD_PAGE_MESSAGES.en).toEqual(translations.en.phoneUpload);
    expect(PHONE_UPLOAD_PAGE_MESSAGES.my).toEqual(translations.my.phoneUpload);
  });
});
