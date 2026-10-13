import { describe, it, expect, vi, afterEach } from "vitest";
import { TEST_BACKEND_ANON_KEY, TEST_BACKEND_URL } from "../test/setup";

// The client module itself (not just the pure resolver): importing
// src/lib/supabase.ts must throw at load time when the backend env is
// missing or points at a host other than the pinned one, and must expose
// the host it is talking to. Each case stubs the env, resets the module
// registry and imports fresh. createClient() does no network I/O at
// construction, so the real factory is exercised.

const importClient = () => import("./supabase");

afterEach(() => {
  // Back to the placeholders src/test/setup.ts pinned (never .env.local).
  vi.stubEnv("VITE_SUPABASE_URL", TEST_BACKEND_URL);
  vi.stubEnv("VITE_SUPABASE_ANON_KEY", TEST_BACKEND_ANON_KEY);
  vi.stubEnv("VITE_SUPABASE_EXPECTED_HOST", "");
  vi.resetModules();
});

describe("src/lib/supabase.ts fail-closed startup", () => {
  it("throws when VITE_SUPABASE_URL is empty", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "");
    vi.resetModules();
    await expect(importClient()).rejects.toThrow(/VITE_SUPABASE_URL is not set/);
  });

  it("throws when VITE_SUPABASE_ANON_KEY is empty", async () => {
    vi.stubEnv("VITE_SUPABASE_ANON_KEY", "");
    vi.resetModules();
    await expect(importClient()).rejects.toThrow(/VITE_SUPABASE_ANON_KEY is not set/);
  });

  it("throws when the URL host differs from VITE_SUPABASE_EXPECTED_HOST", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://abcdefgh.supabase.co");
    vi.stubEnv("VITE_SUPABASE_EXPECTED_HOST", "your-backend.example.ts.net");
    vi.resetModules();
    await expect(importClient()).rejects.toThrow(/Backend host mismatch/);
  });

  it("starts when the host matches the expectation and exposes backendHost", async () => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://your-backend.example.ts.net");
    vi.stubEnv("VITE_SUPABASE_EXPECTED_HOST", "your-backend.example.ts.net");
    vi.resetModules();
    const mod = await importClient();
    expect(mod.backendHost).toBe("your-backend.example.ts.net");
    expect(mod.supabase).toBeTruthy();
  });

  it("exposes the placeholder host the unit suite is pinned to (never a default)", async () => {
    const mod = await importClient();
    expect(mod.backendHost).toBe("127.0.0.1:54321");
  });
});
