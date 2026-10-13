// QR origin selection for the phone upload page
// (docs/selfhost-migration/phase-f/phone-qr-origin.md).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertElectronPhoneUploadOrigin,
  buildPhoneUploadQrUrl,
  PhoneUploadOriginError,
  resolvePhoneUploadPage,
  type PhoneUploadPageInput,
} from "./phoneUploadOrigin";

const API = "https://pos-api.example.test";
const TOKEN = "f".repeat(128);
const resolve = (over: Partial<PhoneUploadPageInput>) =>
  resolvePhoneUploadPage({ supabaseUrl: API, locationOrigin: "file://", isElectron: true, allowLocalHttp: false, ...over });

describe("resolvePhoneUploadPage", () => {
  it("packaged Electron (file://): the backend-served page on the https API origin, token in the fragment", () => {
    const page = resolve({ locationOrigin: "file://" });
    expect(page).toEqual({ kind: "functionPage", origin: API, base: `${API}/functions/v1/phone-upload-page` });
    const url = buildPhoneUploadQrUrl(page, TOKEN);
    expect(url).toBe(`${API}/functions/v1/phone-upload-page#${TOKEN}`);
    expect(new URL(url).pathname).toBe("/functions/v1/phone-upload-page"); // never sent: the token is not in the path
    expect(new URL(url).search).toBe("");
  });

  it.each([
    ["the 'null' origin a file:// page reports", "null"],
    ["a custom app:// protocol", "app://shwe-pos"],
    ["no origin at all", undefined],
    ["an empty origin", ""],
  ])("never uses %s: always the configured API origin", (_label, locationOrigin) => {
    for (const isElectron of [true, false]) {
      const page = resolve({ locationOrigin, isElectron });
      expect(page.kind).toBe("functionPage");
      expect(page.origin).toBe(API);
      expect(buildPhoneUploadQrUrl(page, TOKEN)).not.toMatch(/^(file|app|null)/);
    }
  });

  it("Electron on a dev server (http://localhost) still uses the configured API origin, not the renderer's", () => {
    const page = resolve({ locationOrigin: "http://localhost:5179", isElectron: true, allowLocalHttp: true });
    expect(page.origin).toBe(API);
    expect(page.kind).toBe("functionPage");
  });

  it("web build on https keeps its own origin and the SPA route (token in the path, as before)", () => {
    const page = resolve({ locationOrigin: "https://shop.example.test", isElectron: false });
    expect(page).toEqual({ kind: "spaRoute", origin: "https://shop.example.test", base: "https://shop.example.test/phone-upload/product-image" });
    expect(buildPhoneUploadQrUrl(page, TOKEN)).toBe(`https://shop.example.test/phone-upload/product-image/${TOKEN}`);
  });

  it("web build on plain http is refused (except http://localhost in dev/test)", () => {
    expect(() => resolve({ locationOrigin: "http://192.168.1.20:4173", isElectron: false, allowLocalHttp: true })).toThrow(PhoneUploadOriginError);
    expect(() => resolve({ locationOrigin: "http://localhost:5173", isElectron: false, allowLocalHttp: false })).toThrow(/only https/);
    expect(resolve({ locationOrigin: "http://localhost:5173", isElectron: false, allowLocalHttp: true }).kind).toBe("spaRoute");
    expect(resolve({ locationOrigin: "http://127.0.0.1:5173", isElectron: false, allowLocalHttp: true }).origin).toBe("http://127.0.0.1:5173");
  });

  it("missing backend configuration: refused with a clear message, never a fallback", () => {
    for (const supabaseUrl of [undefined, null, "", "   "]) {
      expect(() => resolve({ supabaseUrl })).toThrow(/Phone upload is not available in this build.*VITE_SUPABASE_URL\) is not set/);
    }
    expect(() => resolve({ supabaseUrl: "not a url" })).toThrow(/not a valid URL/);
  });

  it("http backend: refused for builds (only https), allowed for a loopback backend in dev/test only", () => {
    expect(() => resolve({ supabaseUrl: "http://pos-api.example.test" })).toThrow(/uses "http:" \(only https/);
    expect(() => resolve({ supabaseUrl: "http://pos-api.example.test", allowLocalHttp: true })).toThrow(PhoneUploadOriginError);
    expect(() => resolve({ supabaseUrl: "http://127.0.0.1:54321" })).toThrow(PhoneUploadOriginError);
    expect(resolve({ supabaseUrl: "http://127.0.0.1:54321", allowLocalHttp: true }).base).toBe("http://127.0.0.1:54321/functions/v1/phone-upload-page");
  });

  it("other schemes and non-origin backend URLs are refused", () => {
    for (const supabaseUrl of ["file:///srv/x", "ftp://pos-api.example.test", "javascript:alert(1)", "app://x"]) {
      expect(() => resolve({ supabaseUrl }), supabaseUrl).toThrow(PhoneUploadOriginError);
    }
    expect(() => resolve({ supabaseUrl: `${API}/some/prefix` })).toThrow(/bare origin/);
    expect(() => resolve({ supabaseUrl: `${API}/?x=1` })).toThrow(/bare origin/);
    // a trailing slash or an explicit port is fine
    expect(resolve({ supabaseUrl: `${API}/` }).origin).toBe(API);
    expect(resolve({ supabaseUrl: "https://pos-api.example.test:8443" }).origin).toBe("https://pos-api.example.test:8443");
  });

  it("encodes the token (no way to break out of the fragment / path)", () => {
    const page = resolve({});
    expect(buildPhoneUploadQrUrl(page, "a b#c/d")).toBe(`${API}/functions/v1/phone-upload-page#a%20b%23c%2Fd`);
  });
});

describe("assertElectronPhoneUploadOrigin (vite build guard)", () => {
  it("passes with an https backend and returns the phone page base", () => {
    expect(assertElectronPhoneUploadOrigin({ VITE_SUPABASE_URL: API })).toBe(`${API}/functions/v1/phone-upload-page`);
  });
  it("fails without a backend URL, with http, or with a loopback https backend", () => {
    expect(() => assertElectronPhoneUploadOrigin({})).toThrow(/not set/);
    expect(() => assertElectronPhoneUploadOrigin({ VITE_SUPABASE_URL: "http://pos-api.example.test" })).toThrow(/only https/);
    expect(() => assertElectronPhoneUploadOrigin({ VITE_SUPABASE_URL: "http://localhost:54321" })).toThrow(/only https/);
    expect(() => assertElectronPhoneUploadOrigin({ VITE_SUPABASE_URL: "https://localhost" })).toThrow(/loopback/);
  });
});

describe("currentPhoneUploadPage (renderer)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("packaged Electron renderer (file://, electronAPI present) -> the API-origin page", async () => {
    vi.stubGlobal("window", { location: { origin: "file://" }, electronAPI: { isElectron: true } });
    const { currentPhoneUploadPage } = await import("./productImagePhoneUpload");
    const page = currentPhoneUploadPage();
    expect(page.kind).toBe("functionPage");
    expect(page.origin).toBe(new URL(import.meta.env.VITE_SUPABASE_URL).origin);
  });

  it("web renderer on https -> its own SPA route", async () => {
    vi.stubGlobal("window", { location: { origin: "https://shop.example.test" } });
    const { currentPhoneUploadPage } = await import("./productImagePhoneUpload");
    expect(currentPhoneUploadPage()).toEqual({ kind: "spaRoute", origin: "https://shop.example.test", base: "https://shop.example.test/phone-upload/product-image" });
  });
});
