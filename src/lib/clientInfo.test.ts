// Release 1.0.16, task 1: version + capabilities, readable by a person (the
// login page / sidebar line) and by a machine (the X-Client-Info header on
// every API request).
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_VERSION, CLIENT_CAPABILITIES, CLIENT_INFO, clientInfoHeader, parseClientInfo } from "./clientInfo";

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf8")) as { version: string };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("client identification", () => {
  it("the version comes from package.json (1.0.16)", () => {
    expect(APP_VERSION).toBe(pkg.version);
    expect(pkg.version).toBe("1.0.16");
  });

  it("header: shwephala-pos/<version> (<capabilities>), parseable", () => {
    expect(CLIENT_INFO).toBe(`shwephala-pos/${pkg.version} (validated-uploads; idem-v1; outbox-origin-v1; update-guard-v1)`);
    expect(parseClientInfo(CLIENT_INFO)).toEqual({ name: "shwephala-pos", version: pkg.version, capabilities: [...CLIENT_CAPABILITIES] });
    expect(parseClientInfo(clientInfoHeader("1.2.3", ["validated-uploads"]))?.capabilities).toEqual(["validated-uploads"]);
    expect(parseClientInfo("supabase-js-web/2.106.1")).toBeNull();
  });

  it("every REST request of the real client carries it (replacing supabase-js's default)", async () => {
    const seen: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    vi.resetModules();
    const { supabase } = await import("./supabase");
    await supabase.from("shops").select("*");
    await supabase.rpc("app_setup_needed");
    expect(seen).toHaveLength(2);
    for (const h of seen) expect(h.get("x-client-info")).toBe(CLIENT_INFO);
  });
});
