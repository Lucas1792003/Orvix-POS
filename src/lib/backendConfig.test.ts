import { describe, it, expect } from "vitest";
import { BackendConfigError, resolveBackendConfig } from "./backendConfig";

describe("resolveBackendConfig()", () => {
  const good = { VITE_SUPABASE_URL: "https://your-backend.example.ts.net", VITE_SUPABASE_ANON_KEY: "anon" };

  it("returns the url, key and host for a valid env", () => {
    expect(resolveBackendConfig(good)).toEqual({
      url: "https://your-backend.example.ts.net", anonKey: "anon", host: "your-backend.example.ts.net",
    });
  });

  it("keeps a port in the host and strips a trailing slash from the url", () => {
    expect(resolveBackendConfig({ ...good, VITE_SUPABASE_URL: "http://127.0.0.1:54321/" })).toMatchObject({
      url: "http://127.0.0.1:54321", host: "127.0.0.1:54321",
    });
  });

  it.each([
    ["missing url", { VITE_SUPABASE_ANON_KEY: "anon" }, /VITE_SUPABASE_URL is not set/],
    ["empty url", { ...good, VITE_SUPABASE_URL: "   " }, /VITE_SUPABASE_URL is not set/],
    ["missing key", { VITE_SUPABASE_URL: good.VITE_SUPABASE_URL }, /VITE_SUPABASE_ANON_KEY is not set/],
    ["empty key", { ...good, VITE_SUPABASE_ANON_KEY: "" }, /VITE_SUPABASE_ANON_KEY is not set/],
    ["malformed url", { ...good, VITE_SUPABASE_URL: "not a url" }, /not a valid URL/],
    ["non-http scheme", { ...good, VITE_SUPABASE_URL: "ftp://x.example" }, /must be an http\(s\) URL/],
  ])("throws a BackendConfigError for %s — never a default", (_label, env, message) => {
    expect(() => resolveBackendConfig(env)).toThrow(BackendConfigError);
    expect(() => resolveBackendConfig(env)).toThrow(message);
  });

  it("refuses a host other than VITE_SUPABASE_EXPECTED_HOST", () => {
    const env = { ...good, VITE_SUPABASE_URL: "https://abcdefgh.supabase.co", VITE_SUPABASE_EXPECTED_HOST: "your-backend.example.ts.net" };
    expect(() => resolveBackendConfig(env)).toThrow(BackendConfigError);
    expect(() => resolveBackendConfig(env)).toThrow(/Backend host mismatch.*expects "your-backend\.example\.ts\.net".*points at "abcdefgh\.supabase\.co"/);
  });

  it("accepts the expected host case-insensitively and ignores an empty expectation", () => {
    expect(resolveBackendConfig({ ...good, VITE_SUPABASE_EXPECTED_HOST: "YOUR-BACKEND.example.ts.net" }).host).toBe("your-backend.example.ts.net");
    expect(resolveBackendConfig({ ...good, VITE_SUPABASE_EXPECTED_HOST: "  " }).host).toBe("your-backend.example.ts.net");
  });
});
