import { describe, it, expect } from "vitest";
import { HostedBackendError, isHostedSupabaseUrl, assertNotHostedUrl, takeHostedAttempts } from "./hostedGuard";

// The guard is installed for every test file by src/test/setup.ts; this
// file checks it actually bites. Attempts are drained inside each test so
// the setup file's afterEach does not (correctly) fail these on purpose.

describe("hosted-backend guard", () => {
  it("recognises *.supabase.co and nothing else", () => {
    expect(isHostedSupabaseUrl("https://abcdefgh.supabase.co/rest/v1/users")).toBe(true);
    expect(isHostedSupabaseUrl("wss://abcdefgh.supabase.co/realtime/v1/websocket")).toBe(true);
    expect(isHostedSupabaseUrl("https://ABCDEFGH.SUPABASE.CO")).toBe(true);
    expect(isHostedSupabaseUrl("https://lucashome.tail8a86e4.ts.net/rest/v1")).toBe(false);
    expect(isHostedSupabaseUrl("http://127.0.0.1:54321")).toBe(false);
    expect(isHostedSupabaseUrl("https://supabase.com")).toBe(false);
    expect(isHostedSupabaseUrl("https://notsupabase.co")).toBe(false);
    expect(isHostedSupabaseUrl("not a url")).toBe(false);
  });

  it("assertNotHostedUrl throws for the hosted project only", () => {
    expect(() => assertNotHostedUrl("https://x.supabase.co", "a test")).toThrow(HostedBackendError);
    expect(() => assertNotHostedUrl("https://lucashome.tail8a86e4.ts.net", "a test")).not.toThrow();
  });

  it("refuses fetch() to the hosted project synchronously and records the attempt", () => {
    expect(() => fetch("https://abcdefgh.supabase.co/auth/v1/signup", { method: "POST" })).toThrow(HostedBackendError);
    expect(takeHostedAttempts()).toEqual(["https://abcdefgh.supabase.co/auth/v1/signup"]);
    expect(takeHostedAttempts()).toEqual([]);
  });

  it("refuses a WebSocket to the hosted project", () => {
    expect(() => new WebSocket("wss://abcdefgh.supabase.co/realtime/v1/websocket")).toThrow(HostedBackendError);
    expect(takeHostedAttempts()).toHaveLength(1);
  });

  it("lets self-hosted requests through to the real fetch (the loopback placeholder has no listener)", async () => {
    await expect(fetch("http://127.0.0.1:1/rest/v1/")).rejects.toThrow();
    expect(takeHostedAttempts()).toEqual([]);
  });
});
