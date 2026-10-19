// See playwright.config.ts. Every probe is a real fetch() from a page origin (http://127.0.0.1:PORT, and file:// as Electron
// loads the app) with the headers supabase-js / storage uploads send, so Chromium performs the real CORS preflight.
import { test, expect, type Page } from "@playwright/test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAINT = process.env.M087_MAINT_URL!;          // deploy/lucashome/envoy-recovery-maintenance.yaml
const WILD = process.env.M087_WILDCARD_URL!;        // the same listener with allow-headers '*' (negative control)
const ENVOY = process.env.M087_ENVOY_URL!;          // pinned upstream Envoy -> real PostgREST with 087 installed
const ANON = process.env.M087_ANON_KEY!;
const JWT = process.env.M087_JWT!;
const SERVICE = process.env.M087_SERVICE_KEY!;

type Probe = { ok: boolean; status?: number; code?: string; message?: string; error?: string };
async function probe(page: Page, url: string, headers: Record<string, string>, body = "{}"): Promise<Probe> {
  return page.evaluate(async ({ url, headers, body }) => {
    try {
      const r = await fetch(url, { method: "POST", headers, body });
      let j: any = {}; try { j = await r.json(); } catch { /* not json */ }
      return { ok: true, status: r.status, code: j.code, message: j.message };
    } catch (e: any) { return { ok: false, error: String(e) }; }
  }, { url, headers, body });
}
const supa = (extra: Record<string, string> = {}) => ({
  apikey: ANON, authorization: `Bearer ${JWT}`, "content-type": "application/json", "x-client-info": "supabase-js-web/2.106.1",
  prefer: "return=representation", "x-orvix-epoch": "00000000-0000-4000-8000-000000000000", ...extra,
});

test("B1 maintenance listener: an RPC from a web origin sees HTTP 429 PT429 API_GUARD (not a network error)", async ({ page }) => {
  await page.goto("/index.html");
  const r = await probe(page, `${MAINT}/rest/v1/rpc/op_execute_v87`, supa());
  expect(r).toMatchObject({ ok: true, status: 429, code: "PT429" });
  expect(r.message).toContain("[API_GUARD]");
});

test("B2 maintenance listener: a storage upload (x-upsert, cache-control) also sees the 429", async ({ page }) => {
  await page.goto("/index.html");
  const r = await probe(page, `${MAINT}/storage/v1/object/product-images/x.png`, supa({ "x-upsert": "true", "cache-control": "3600" }), "x");
  expect(r).toMatchObject({ ok: true, status: 429, code: "PT429" });
});

test("B3 OBSERVATION: allow-headers '*' with Authorization (the Fetch spec excludes Authorization from the wildcard)", async ({ page }) => {
  await page.goto("/index.html");
  const r = await probe(page, `${WILD}/rest/v1/rpc/op_execute_v87`, supa());
  // Recorded, not asserted: the explicit list (B1) is spec-correct whatever a given Chromium build does with '*'.
  console.log(`[m087-browser] wildcard allow-headers + Authorization in this Chromium: ${r.ok ? `ACCEPTED (status ${r.status})` : `REJECTED (${r.error})`}`);
  expect(r.ok ? r.status : 0).toBeGreaterThanOrEqual(0);
});

test("B4 file:// origin (Electron): the maintenance 429 is readable", async ({ page }) => {
  const d = mkdtempSync(join(tmpdir(), "m087-")); const f = join(d, "app.html");
  writeFileSync(f, "<!doctype html><title>file origin</title>");
  await page.goto(`file://${f}`);
  const r = await probe(page, `${MAINT}/rest/v1/rpc/op_execute`, supa());
  expect(r).toMatchObject({ ok: true, status: 429, code: "PT429" });
});

test("B5 pinned upstream Envoy + PostgREST with 087: a guarded write from the page sees a readable 429 PT429", async ({ page }) => {
  await page.goto("/index.html");
  const r = await probe(page, `${ENVOY}/rest/v1/categories`, supa({ apikey: SERVICE, authorization: `Bearer ${SERVICE}` }),
    JSON.stringify({ id: "zz-browser-b5", name: "b5", color: "#000000", org_id: process.env.M087_ORG }));   // a real organisation: a made-up id fails the foreign key (409) before the guard
  expect(r).toMatchObject({ ok: true, status: 429, code: "PT429" });
  expect(r.message).toMatch(/ORG_SUSPENDED: server recovery in progress \[(LEASE_INVALID|RECOVERY_HOLD|ORG_UNRESOLVED)\]/);
});

test("B6 pinned upstream Envoy: the x-orvix-epoch header passes the real preflight (v87 call reaches PostgREST)", async ({ page }) => {
  await page.goto("/index.html");
  const r = await probe(page, `${ENVOY}/rest/v1/rpc/recovery_epoch`, supa(), JSON.stringify({ p_ctx: { till: "none", till_secret: "x" } }));
  expect(r.ok).toBe(true);
  expect(r.status).toBe(429);
  expect(r.message).toContain("ORG_SUSPENDED");
});
