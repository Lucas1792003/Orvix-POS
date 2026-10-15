/* eslint-disable @typescript-eslint/no-explicit-any */
// Phase F · F. "Export pending transactions" + recovery replay
// (docs/selfhost-migration/phase-f/queue-export.md).
//
//   F1  offline: a shift opened offline + three sales queue on the Electron
//       till; the app is restarted offline; the queue is exported through
//       the UI (sync badge -> dialog -> passphrase -> native save dialog,
//       stubbed in the main process to a path under e2e/.results). The file
//       is encrypted, holds every entry in queue order with its original
//       key, holds no session token, and the till's queue is byte-identical
//       before/after.
//   F2  the recovery tool (the real CLI, as a subprocess) replays the export
//       into the QA organization: --target is mandatory, the hosted project
//       is refused, --dry-run sends nothing; replay #1 applies 4 ops, replay
//       #2 creates nothing (4 already-applied). Then a B13-style outage
//       (API refused, navigator online) while the till retries; restore ->
//       the till drains the SAME entries on its own and gets the stored
//       results (still 3 sales, 4 keys); replay #3 after the till synced is
//       again all already-applied; consistency gate (saleLedger) PASS.
//
// Secrets: the QA password / anon / service keys go to the CLI through its
// environment only; the export passphrase is random per run unless
// E2E_QX_PASSPHRASE is set (used to hand the same file to the disposable
// restore check, tools/queue-recovery/disposable/run.sh).
import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { closeOpenShifts, count, ensureQaBarcode, inv, keyRows, rows } from "./helpers/db";
import { PROJECT_ROOT, RESULTS_DIR, liveCfg, qaPassword, qaState } from "./helpers/env";
import { record } from "./helpers/evidence";
import { assertConsistency } from "./helpers/consistency";
import { Terminal, type OutboxRow } from "./helpers/terminal";
import { decryptQueueExport, parseEnvelope, type QueueExportPayload } from "../src/lib/queueExport/format";
import type { ReplayReport } from "../tools/queue-recovery/replay";

test.describe.configure({ mode: "serial" });

const st = qaState();
const pw = qaPassword();
const { ids, emails } = st;
const USERDATA = path.join(RESULTS_DIR, "userdata-f");
const EXPORT_DIR = path.join(RESULTS_DIR, "queue-export");
const EXPORT_FILE = path.join(EXPORT_DIR, "f1-export.spqx");
const PASSPHRASE = process.env.E2E_QX_PASSPHRASE || `qx-${randomBytes(18).toString("base64url")}`;

let A: Terminal;
let exported: QueueExportPayload;
let outboxAtExport: OutboxRow[] = [];
let salesBefore = 0;
let q1 = 0;
let q2 = 0;

/** The till's queue exactly as stored (every field, primary-key order). */
async function rawOutbox(t: Terminal): Promise<string> {
  return t.page.evaluate(() => new Promise<string>((resolve, reject) => {
    const req = indexedDB.open("shwe-phala-local");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(["syncOutbox", "provisionalIdMap", "syncState"], "readonly");
      const out: Record<string, unknown> = {};
      for (const s of ["syncOutbox", "provisionalIdMap", "syncState"]) {
        const r = tx.objectStore(s).getAll();
        r.onsuccess = () => { out[s] = r.result; };
      }
      tx.oncomplete = () => { db.close(); resolve(JSON.stringify(out)); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    };
  }));
}

/** Run the real recovery CLI. Secrets only through its environment. */
function tool(args: string[], extraEnv: Record<string, string> = {}): { code: number; out: string } {
  const cfg = liveCfg();
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    QUEUE_RECOVERY_PASSPHRASE: PASSPHRASE,
    QUEUE_RECOVERY_ANON_KEY: cfg.anonKey,
    QUEUE_RECOVERY_PASSWORD: pw,
    QUEUE_RECOVERY_SERVICE_KEY: cfg.serviceKey,
    ...extraEnv,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync("npx", ["tsx", "tools/queue-recovery/cli.ts", ...args], { cwd: PROJECT_ROOT, env, encoding: "utf8", timeout: 180_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  for (const s of [cfg.anonKey, cfg.serviceKey, pw, PASSPHRASE]) {
    if (out.includes(s)) throw new Error("the recovery tool printed a secret");
  }
  return { code: r.status ?? -1, out };
}

function readReport(file: string): ReplayReport {
  return JSON.parse(readFileSync(file, "utf8")) as ReplayReport;
}

test.beforeAll(async () => {
  rmSync(USERDATA, { recursive: true, force: true });
  rmSync(EXPORT_DIR, { recursive: true, force: true });
  mkdirSync(EXPORT_DIR, { recursive: true });
  // F needs the shift to be opened OFFLINE by this spec: cashier A must hold
  // no open shift (an earlier spec may have left one) before the till loads.
  const closed = await closeOpenShifts([ids.cashA], { email: emails.mgr, password: pw }, "spec F");
  record("F", "precondition: no open shift for cashier A", "INFO", closed.length ? closed.join("; ") : "none open");
  record("F", "precondition: QA Product One barcode", "INFO", await ensureQaBarcode(st));
  A = await Terminal.launchElectron(USERDATA);
  await A.signIn(emails.cashA, pw, "/app/pos");
  await A.waitForApp();
});

test.afterAll(async () => {
  try {
    await assertConsistency("spec F", A ? [A] : []);
  } finally {
    await A?.close();
  }
});

test("F1 offline sales -> restart offline -> export via the UI: encrypted file, every entry, no secrets, queue untouched", async () => {
  test.setTimeout(10 * 60_000);
  salesBefore = await count("sales", { shop_id: ids.shop });
  q1 = await inv(ids.shop, ids.prod1);
  q2 = await inv(ids.shop, ids.prod2);

  await A.setOffline(true);
  await A.openShift(0);
  await A.gotoPos();
  await A.posScan(st.barcodeValue);
  expect((await A.posCheckout(1000)).receiptNo).toBe("PENDING");
  await A.posScan(st.barcodeValue);
  expect((await A.posCheckout(1000)).receiptNo).toBe("PENDING");
  await A.posAddByCard("QA Product Two");
  expect((await A.posCheckout(2000)).receiptNo).toBe("PENDING");
  const queued = await A.outbox();
  expect(queued.map((e) => e.name)).toEqual(["open_shift", "complete_sale", "complete_sale", "complete_sale"]);
  expect(queued.slice(1).every((e) => e.refs?.[0]?.field === "p_shift_id")).toBe(true);

  // restart the till while still offline: the queue survives
  await A.close();
  A = await Terminal.launchElectron(USERDATA, { offline: true });
  await A.waitForApp();
  await expect(A.badge("4 actions waiting to sync")).toBeVisible();
  const session = await A.storedSession();
  expect(session?.access_token).toBeTruthy();

  const before = await rawOutbox(A);
  const requestsBefore = A.requestsMatching(/rest\/v1|auth\/v1/).length;

  // native save dialog -> fixed path (the main process still writes the file)
  await A.app!.evaluate(({ dialog }, file) => {
    (dialog as any).showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, EXPORT_FILE);
  await A.page.getByTestId("export-queue-open").click();
  await expect(A.page.getByTestId("queue-export-total")).toHaveAttribute("data-total", "4");
  await A.page.getByTestId("queue-export-passphrase").fill("too short");
  await A.page.getByTestId("queue-export-passphrase-confirm").fill("too short");
  await A.page.getByTestId("queue-export-submit").click();
  await expect(A.page.getByRole("alert").filter({ hasText: "at least 10 characters" })).toBeVisible();
  await A.page.getByTestId("queue-export-passphrase").fill(PASSPHRASE);
  await A.page.getByTestId("queue-export-passphrase-confirm").fill(PASSPHRASE);
  const t0 = Date.now();
  await A.page.getByTestId("queue-export-submit").click();
  await expect(A.page.getByTestId("queue-export-result")).toBeVisible({ timeout: 60_000 });
  const exportMs = Date.now() - t0;
  await expect(A.page.getByTestId("queue-export-path")).toContainText(EXPORT_FILE);
  await A.page.getByTestId("queue-export-close").click();

  // the queue is byte-identical and nothing was sent
  expect(await rawOutbox(A)).toBe(before);
  outboxAtExport = await A.outbox();
  expect(A.requestsMatching(/rest\/v1|auth\/v1/).length).toBe(requestsBefore);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore);

  // the file: owner-only, encrypted envelope, counts-only clear part
  expect(existsSync(EXPORT_FILE)).toBe(true);
  expect(statSync(EXPORT_FILE).mode & 0o777).toBe(0o600);
  const text = readFileSync(EXPORT_FILE, "utf8");
  const env = parseEnvelope(text);
  expect(env.header.summary).toEqual({ total: 4, byStatus: { pending: 4 }, byOpType: { open_shift: 1, complete_sale: 3 } });
  for (const e of outboxAtExport) expect(text).not.toContain(e.idempotencyKey!);
  expect(text).not.toContain(ids.shop);
  await expect(decryptQueueExport(text, `${PASSPHRASE}x`)).rejects.toMatchObject({ code: "decrypt-failed" });

  exported = await decryptQueueExport(text, PASSPHRASE);
  expect(exported.entries.map((e) => [e.seq, e.opType, e.idempotencyKey, e.status]))
    .toEqual(outboxAtExport.map((e) => [e.seq, e.name, e.idempotencyKey, e.status]));
  expect(exported.entries.slice(1).every((e) => e.refs[0]?.provisionalId === exported.entries[0].provisional[0].ids[0])).toBe(true);
  expect(exported.entries.slice(1).every((e) => typeof e.ringUpAt === "string")).toBe(true);
  expect(exported.session).toMatchObject({ userId: ids.cashA, orgId: ids.org, role: "CASHIER" });
  expect(exported.backendHost).toBe(new URL(liveCfg().url).host);
  const plain = JSON.stringify(exported);
  for (const s of [session!.access_token, session!.refresh_token, liveCfg().anonKey]) expect(plain).not.toContain(s);
  expect(plain).not.toMatch(/access_token|refresh_token|password|totp/i);

  record("F", "export pending queue via UI (offline, after restart)", "PASS",
    `4 queued ops (open_shift offline + 3 sales with refs) survived an offline restart; exported through badge -> dialog -> main-process save in ${exportMs} ms; file 0600, AES-256-GCM/PBKDF2 600k envelope, clear part = counts only, wrong passphrase rejected; decrypted: 4 entries in seq order with the outbox's own keys/status, session user/org, backend host; no access/refresh token, anon key, password or TOTP field; outbox+idMap+syncState byte-identical before/after; 0 network requests; 0 sales on the server`);
});

test("F2 recovery tool: explicit target, dry run, replay x2 into the QA org, outage + till drain of the same ops, replay x3 -> no duplicates", async () => {
  test.setTimeout(15 * 60_000);
  const cfg = liveCfg();
  const keys = exported.entries.map((e) => e.idempotencyKey!);

  // target safety (exit 2, nothing sent)
  const noTarget = tool(["replay", EXPORT_FILE, "--email", emails.cashA]);
  expect(noTarget.code).toBe(2);
  expect(noTarget.out).toContain("--target <url> is required");
  const hosted = tool(["replay", EXPORT_FILE, "--target", "https://qxqxqxqx.supabase.co", "--email", emails.cashA]);
  expect(hosted.code).toBe(2);
  expect(hosted.out).toMatch(/hosted Supabase/i);
  const otherHost = tool(["replay", EXPORT_FILE, "--target", "http://127.0.0.1:9", "--email", emails.cashA]);
  expect(otherHost.code).toBe(2);
  expect(otherHost.out).toContain("--confirm-host");
  const wrongPass = tool(["inspect", EXPORT_FILE], { QUEUE_RECOVERY_PASSPHRASE: "definitely-not-it" });
  expect(wrongPass.code).toBe(3);
  const inspect = tool(["inspect", EXPORT_FILE]);
  expect(inspect.code).toBe(0);
  expect(inspect.out).toContain("entries: 4");

  const dry = tool(["replay", EXPORT_FILE, "--target", cfg.url, "--dry-run", "--report", path.join(EXPORT_DIR, "dry.json")]);
  expect(dry.code).toBe(0);
  expect(readReport(path.join(EXPORT_DIR, "dry.json")).counts.planned).toBe(4);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore);
  expect(await keyRows(keys)).toHaveLength(0);

  // replay #1: everything applied, in order, under the original keys
  const r1 = tool(["replay", EXPORT_FILE, "--target", cfg.url, "--email", emails.cashA, "--report", path.join(EXPORT_DIR, "replay1.json")]);
  expect(r1.code, r1.out).toBe(0);
  const rep1 = readReport(path.join(EXPORT_DIR, "replay1.json"));
  expect(rep1.ops.map((o) => [o.opType, o.outcome])).toEqual([
    ["open_shift", "applied"], ["complete_sale", "applied"], ["complete_sale", "applied"], ["complete_sale", "applied"],
  ]);
  const krows = await keyRows(keys);
  expect(krows).toHaveLength(4);
  expect(krows.every((k: any) => k.actor_id === ids.cashA)).toBe(true);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore + 3);
  const shiftId = rep1.ops[0].resultId!;
  const landed = await rows("sales", {}, (q) => q.in("id", rep1.ops.slice(1).map((o) => o.resultId)));
  expect(landed).toHaveLength(3);
  expect(landed.every((s: any) => s.shift_id === shiftId && s.cashier_id === ids.cashA)).toBe(true);
  // ring-up time kept (not the replay time)
  const ringUps = exported.entries.slice(1).map((e) => Date.parse(e.ringUpAt!)).sort();
  expect(landed.map((s: any) => Date.parse(s.created_at)).sort()).toEqual(ringUps);
  expect(await inv(ids.shop, ids.prod1)).toBe(q1 - 2);
  expect(await inv(ids.shop, ids.prod2)).toBe(q2 - 1);

  // replay #2: nothing new
  const r2 = tool(["replay", EXPORT_FILE, "--target", cfg.url, "--email", emails.cashA, "--report", path.join(EXPORT_DIR, "replay2.json")]);
  expect(r2.code, r2.out).toBe(0);
  expect(readReport(path.join(EXPORT_DIR, "replay2.json")).counts["already-applied"]).toBe(4);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore + 3);
  expect(await keyRows(keys)).toHaveLength(4);

  // The till is untouched by all of this: its queue is still the exported one.
  expect((await A.outbox()).map((e) => e.idempotencyKey)).toEqual(keys);

  // B13-style outage: the API refuses connections while the till is "online" and retries.
  // (a RegExp, not the supabaseGlob() string: setOffline(false) unroutes that string)
  const apiPattern = new RegExp(`^${cfg.url.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/`);
  let refused = 0;
  await A.page.route(apiPattern, (route) => { refused++; void route.abort("connectionrefused"); });
  const tCut = Date.now();
  await A.setOffline(false);
  await expect.poll(async () => Math.max(...(await A.outbox()).map((e) => e.attempts)), { timeout: 120_000, intervals: [2_000] })
    .toBeGreaterThanOrEqual(1);
  await A.page.waitForTimeout(Math.max(0, 45_000 - (Date.now() - tCut)));
  const during = await A.outbox();
  expect(during.map((e) => e.idempotencyKey)).toEqual(keys);
  expect(during.every((e) => e.status === "pending")).toBe(true);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore + 3);
  const outageS = Math.round((Date.now() - tCut) / 1000);

  // restore: the till drains the SAME operations on its own; the server hands back the stored results
  const tRestore = Date.now();
  await A.page.unroute(apiPattern);
  await expect.poll(async () => (await A.outbox()).length, { timeout: 8 * 60_000, intervals: [2_000] }).toBe(0);
  const drainS = Math.round((Date.now() - tRestore) / 1000);
  const tillSent = A.rpcBodies.filter((b) => b.at >= tRestore).map((b) => b.body?.p_idempotency_key);
  for (const k of keys) expect(tillSent).toContain(k);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore + 3);
  expect(await keyRows(keys)).toHaveLength(4);
  expect(await inv(ids.shop, ids.prod1)).toBe(q1 - 2);
  expect(await inv(ids.shop, ids.prod2)).toBe(q2 - 1);
  await expect.poll(async () => (await A.localSales()).some((s: any) => s.receiptNo === "PENDING"), { timeout: 30_000 }).toBe(false);
  await expect(A.badge(/waiting to sync/)).toBeHidden({ timeout: 30_000 });

  // replay #3 after the till synced: still nothing new
  const r3 = tool(["replay", EXPORT_FILE, "--target", cfg.url, "--email", emails.cashA, "--report", path.join(EXPORT_DIR, "replay3.json")]);
  expect(r3.code, r3.out).toBe(0);
  expect(readReport(path.join(EXPORT_DIR, "replay3.json")).counts["already-applied"]).toBe(4);
  expect(await count("sales", { shop_id: ids.shop })).toBe(salesBefore + 3);
  expect(await count("shifts", { cashier_id: ids.cashA, ended_at: null })).toBe(1);

  await assertConsistency("F2 export replayed x3 + till drained the same ops", [A]);
  record("F", "recovery tool replay into the QA org + till drain of the same ops", "PASS",
    `tool refused: no --target (exit 2), *.supabase.co (exit 2), other host without --confirm-host (exit 2), wrong passphrase (exit 3); dry run: 4 planned, 0 sent; replay #1: 4 applied in seq order under the original keys (open_shift -> ${shiftId}, 3 sales on it, ring-up times kept), sales ${salesBefore}->${salesBefore + 3}, prod1 ${q1}->${q1 - 2}, prod2 ${q2}->${q2 - 1}; replay #2: 4 already-applied, 0 new rows; till queue untouched by the tool; API refused ${outageS} s with the till online (${refused} refused requests, entries kept pending with attempts); restored -> the till drained the same 4 keys on its own in ${drainS} s and got the stored results (sales still +3, keys 4, no PENDING left); replay #3: 4 already-applied; consistency gate PASS`);
});

test("F3 no request ever left for the hosted project", async () => {
  expect(A.hostedRequests).toEqual([]);
  record("guard", "hosted project untouched (spec F)", "PASS", `0 requests to *.supabase.co from the till; the recovery tool refused a *.supabase.co target before any request`);
});
