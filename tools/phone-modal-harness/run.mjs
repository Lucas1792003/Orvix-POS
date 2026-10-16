// Local-only real-browser check of the desktop QR modal (D300 investigation,
// docs/selfhost-migration/phase-f/app-bugfixes.md).
//
//   node tools/phone-modal-harness/run.mjs
//
// Starts a Vite dev server for tools/phone-modal-harness/index.html (the REAL
// ProductImageInput + ProductImagePhoneUploadModal under StrictMode), opens it
// in headless Chromium with Playwright's fake clock, and answers every backend
// request from a mock on a fake loopback origin. Nothing leaves this machine:
// any request to another host is aborted and fails the run. For each scenario
// it reports how many cancel_product_image_upload_session calls the modal made
// and which "[phone-upload]" markers it logged. Exit code 1 if a scenario's
// outcome differs from the expected one in SCENARIOS.
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FAKE_API = "http://127.0.0.1:59999";
process.env.VITE_SUPABASE_URL = FAKE_API;
process.env.VITE_SUPABASE_ANON_KEY = "harness-anon-key";
process.env.VITE_SUPABASE_EXPECTED_HOST = "";

const T0 = Date.parse("2026-10-16T09:00:00.000Z");
const SESSION_MS = 10 * 60_000;

const server = await createServer({
  root: ROOT,
  configFile: path.join(ROOT, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, strictPort: false, hmr: false },
  logLevel: "error",
});
await server.listen();
const addr = server.httpServer.address();
const HARNESS = `http://127.0.0.1:${addr.port}/tools/phone-modal-harness/index.html`;

const browser = await chromium.launch({ headless: true });

async function newRun() {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const log = { cancels: [], creates: 0, polls: 0, markers: [], foreign: [], errors: [] };
  const sessions = new Map();
  await context.route(() => true, async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === `http://127.0.0.1:${addr.port}`) return route.continue();
    if (url.origin !== FAKE_API) {
      log.foreign.push(url.href);
      return route.abort("blockedbyclient");
    }
    const now = await page.evaluate(() => Date.now()).catch(() => T0);
    const body = (() => { try { return route.request().postDataJSON() ?? {}; } catch { return {}; } })();
    const json = (status, obj) => route.fulfill({ status, contentType: "application/json", body: obj === undefined ? "" : JSON.stringify(obj) });
    switch (url.pathname) {
      case "/rest/v1/rpc/create_product_image_upload_session": {
        log.creates += 1;
        const id = `sess-${log.creates}`;
        const s = { sessionId: id, token: "t".repeat(64), storagePath: `org/qa/temp/${id}`, expiresAt: new Date(now + SESSION_MS).toISOString(), status: "PENDING" };
        sessions.set(id, s);
        return json(200, s);
      }
      case "/rest/v1/rpc/get_product_image_upload_session_status": {
        log.polls += 1;
        const s = sessions.get(body.p_session_id);
        if (!s) return json(404, { message: "Upload session not found" });
        if (s.status === "PENDING" && Date.parse(s.expiresAt) <= now) s.status = "EXPIRED";
        return json(200, { sessionId: s.sessionId, storagePath: s.storagePath, status: s.status, expiresAt: s.expiresAt, ...(s.status === "COMPLETED" ? { publicUrl: `${FAKE_API}/storage/v1/object/public/product-images/${s.storagePath}`, bytes: 1234 } : {}) });
      }
      case "/rest/v1/rpc/cancel_product_image_upload_session": {
        log.cancels.push({ id: body.p_session_id, atS: Math.round((now - T0) / 1000) });
        const s = sessions.get(body.p_session_id);
        if (s && s.status === "PENDING") s.status = "CANCELED";
        return route.fulfill({ status: 204, body: "" });
      }
      default:
        if (url.pathname.startsWith("/storage/v1/object/public/product-images/")) {
          // 1x1 PNG for the "Upload received" preview
          return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64") });
        }
        log.foreign.push(`unmocked ${url.pathname}`);
        return json(404, { message: "not mocked" });
    }
  });
  page.on("console", (m) => { if (m.text().includes("[phone-upload]")) log.markers.push(m.text()); });
  page.on("pageerror", (e) => log.errors.push(String(e)));
  await page.clock.install({ time: T0 });
  await page.goto(HARNESS);
  await page.getByRole("button", { name: "Use phone camera" }).click();
  await page.getByText("Waiting for upload...").waitFor();
  /** Advance the fake clock in 1 s steps, letting the mocked fetches settle. */
  const advance = async (seconds, each) => {
    for (let i = 0; i < seconds; i++) {
      await page.clock.runFor(1_000);
      await page.waitForTimeout(5);
      if (each) await each(i + 1);
    }
  };
  const modalOpen = () => page.getByText("Upload from phone", { exact: true }).isVisible();
  const close = async () => { await page.close(); await context.close(); };
  return { page, log, sessions, advance, modalOpen, close };
}

/** Background noise for 300 s: re-renders every second (harness default),
 *  blur/focus + visibilitychange every 20 s, pointer moves and wheel over
 *  the backdrop every 30 s - none of these is a click or a key. */
async function noise(page, s) {
  if (s % 20 === 0) {
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
  }
  if (s % 30 === 0) {
    await page.mouse.move(10, 10);
    await page.mouse.move(1300, 700, { steps: 5 });
    await page.mouse.wheel(0, 200);
  }
}

const dialogBox = async (page) => page.getByText("Upload from phone", { exact: true }).boundingBox();

const SCENARIOS = [
  {
    name: "300 s idle: 1 s re-renders, blur/focus/visibility, mouse moves, wheel",
    expect: { cancels: 0, open: true },
    run: async (r) => { await r.advance(300, (s) => noise(r.page, s)); },
  },
  {
    name: "300 s idle with 50 ms re-render storm",
    expect: { cancels: 0, open: true },
    run: async (r) => { await r.page.evaluate(() => window.__harness.setRerenderMs(50)); await r.advance(300); },
  },
  {
    name: "unmount at +100 s (layout shows Loading data), remount, re-key",
    expect: { cancels: 0, open: false, marker: "trigger=unmount decision=none" },
    run: async (r) => {
      await r.advance(100);
      await r.page.evaluate(() => window.__harness.setMounted(false));
      await r.advance(50);
      await r.page.evaluate(() => window.__harness.setMounted(true));
      await r.page.evaluate(() => window.__harness.rekey());
      await r.advance(150);
    },
  },
  {
    name: "Close button",
    expect: { cancels: 1, open: false, marker: "trigger=close-button" },
    run: async (r) => { await r.advance(30); await r.page.getByRole("button", { name: "Close", exact: true }).click(); await r.advance(2); },
  },
  {
    name: "X button",
    expect: { cancels: 1, open: false, marker: "trigger=x-button" },
    run: async (r) => { await r.advance(30); await r.page.getByRole("button", { name: "close", exact: true }).click(); await r.advance(2); },
  },
  {
    name: "Escape key (trusted)",
    expect: { cancels: 0, open: true, confirm: true, marker: "trigger=escape" },
    run: async (r) => { await r.advance(30); await r.page.keyboard.press("Escape"); await r.advance(2); },
  },
  {
    name: "Escape then 'Stop upload' in the confirmation",
    expect: { cancels: 1, open: false, marker: "trigger=confirm-stop" },
    run: async (r) => {
      await r.advance(30);
      await r.page.keyboard.press("Escape");
      await r.page.getByRole("button", { name: "Stop upload", exact: true }).click();
      await r.advance(2);
    },
  },
  {
    name: "Escape then 'Keep waiting', then 270 s more",
    expect: { cancels: 0, open: true },
    run: async (r) => {
      await r.advance(30);
      await r.page.keyboard.press("Escape");
      await r.page.getByRole("button", { name: "Keep waiting", exact: true }).click();
      await r.advance(270);
    },
  },
  {
    name: "synthetic (untrusted) Escape keydown on window",
    expect: { cancels: 0, open: true, marker: "trusted=false" },
    run: async (r) => {
      await r.advance(30);
      await r.page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
      await r.advance(2);
    },
  },
  {
    name: "click on the backdrop (outside the dialog)",
    expect: { cancels: 0, open: true, confirm: true, marker: "trigger=backdrop" },
    run: async (r) => { await r.advance(30); await r.page.mouse.click(8, 8); await r.advance(2); },
  },
  {
    name: "phone completes, then Escape just closes (nothing to cancel)",
    expect: { cancels: 0, open: false },
    run: async (r) => {
      await r.advance(30);
      for (const s of r.sessions.values()) s.status = "COMPLETED";
      await r.advance(5);
      await r.page.getByText("Upload received").waitFor();
      await r.page.keyboard.press("Escape");
      await r.advance(2);
    },
  },
  {
    name: "press inside the dialog, release on the backdrop (text-selection drag)",
    expect: { cancels: 0, open: true, confirm: false },
    run: async (r) => {
      await r.advance(30);
      const b = await dialogBox(r.page);
      await r.page.mouse.move(b.x + 5, b.y + b.height / 2);
      await r.page.mouse.down();
      await r.page.mouse.move(8, 8, { steps: 4 });
      await r.page.mouse.up();
      await r.advance(2);
    },
  },
];

const only = process.argv.slice(2).find((a) => a.startsWith("--only="))?.slice(7);
const report = (process.argv.includes("--report"));
let failed = 0;
for (const sc of SCENARIOS) {
  if (only && !sc.name.includes(only)) continue;
  const r = await newRun();
  let err = "";
  try { await sc.run(r); } catch (e) { err = String(e).split("\n")[0]; }
  const open = await r.modalOpen().catch(() => false);
  const confirm = await r.page.getByText("Stop this phone upload?").isVisible().catch(() => false);
  const got = { cancels: r.log.cancels.length, open, confirm };
  const exp = sc.expect;
  const ok = !err && r.log.foreign.length === 0 && got.cancels === exp.cancels && got.open === exp.open
    && (exp.confirm === undefined || exp.confirm === confirm)
    && (!exp.marker || r.log.markers.some((m) => m.includes(exp.marker)));
  if (!ok && !report) failed += 1;
  console.log(`${ok ? "PASS" : report ? "INFO" : "FAIL"} | ${sc.name} | cancels=${got.cancels}${got.cancels ? ` at +${r.log.cancels.map((c) => c.atS).join(",")} s` : ""} open=${open} confirm=${confirm} creates=${r.log.creates} polls=${r.log.polls}${err ? ` | error: ${err}` : ""}${r.log.foreign.length ? ` | FOREIGN: ${r.log.foreign.join(",")}` : ""}${r.log.errors.length ? ` | pageerror: ${r.log.errors.join(" ; ")}` : ""}`);
  for (const m of r.log.markers) console.log(`      ${m}`);
  await r.close();
}
await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
