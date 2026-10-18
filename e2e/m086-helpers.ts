/* eslint-disable @typescript-eslint/no-explicit-any */
// tools/m086-verify Chromium helpers. Real Chromium / Electron, real
// IndexedDB and Web Locks, the disposable LOOPBACK stack (085 + 086).
import { expect, type Route } from "@playwright/test";
import { rmSync } from "node:fs";
import path from "node:path";
import { count, inv, svc } from "./helpers/db";
import { RESULTS_DIR, liveCfg, qaPassword, qaState } from "./helpers/env";
import { Terminal } from "./helpers/terminal";

export const st = qaState();
export const pw = qaPassword();
export const P1 = "QA Product One";
export const P2 = "QA Product Two";
export const P3 = "QA Product Three";
export const RPC = (name: string) => `${liveCfg().url}/rest/v1/rpc/${name}`;

export const profile = (name: string) => path.join(RESULTS_DIR, `b2b-${name}`);

/** A fresh till profile: cashier A signed in, shift open, on the POS. */
export async function freshTill(name: string): Promise<Terminal> {
  rmSync(profile(name), { recursive: true, force: true });
  const T = await Terminal.launchPersistent(profile(name));
  await T.signIn(st.emails.cashA, pw, "/app");
  await T.waitForApp();
  await T.openShift(10000);
  await T.gotoPos();
  return T;
}

/** Restarts that came back signed OUT (the stored session was lost). */
export const sessionsLostOnRestart: string[] = [];

/** The same till after a browser restart (same on-disk profile). If the
 *  stored session did not survive (recorded), the cashier signs in again. */
export async function reopenTill(name: string, setup?: (T: Terminal) => Promise<void>): Promise<Terminal> {
  const T = await Terminal.launchPersistent(profile(name));
  if (setup) await setup(T);
  await T.goto("/app/pos");
  await Promise.race([
    T.page.locator("aside.sidebar").waitFor({ state: "visible", timeout: 30_000 }),
    T.page.locator('input[type="email"]').waitFor({ state: "visible", timeout: 30_000 }),
  ]);
  if (await T.page.locator('input[type="email"]').isVisible()) {
    sessionsLostOnRestart.push(name);
    if (T.isOffline()) throw new Error(`${name}: signed out after restart and offline — cannot sign in`);
    await T.signIn(st.emails.cashA, pw, "/app");
  }
  await T.waitForApp();
  await T.gotoPos();
  return T;
}

/** The profile's IndexedDB as left on disk (no app shell needed). */
export async function openRaw(name: string): Promise<Terminal> {
  const T = await Terminal.launchPersistent(profile(name));
  await T.setOffline(true).catch(() => undefined);
  await T.goto("/login");
  return T;
}

/** The figure on a POS card ("N in stock" / "a of N left" → N). */
export async function shown(T: Terminal, product = P1): Promise<number> {
  const text = await T.posStockText(product);
  const m = text.match(/(\d+)\s+in stock/) ?? text.match(/of\s+(\d+)\s+left/);
  return m ? Number(m[1]) : NaN;
}

export const serverStock = (productId = st.ids.prod1) => inv(st.ids.shop, productId);

export async function serverSales(): Promise<number> {
  return count("sales", { shop_id: st.ids.shop, cashier_id: st.ids.cashA });
}

export async function serverSaleKeys(): Promise<string[]> {
  const { data, error } = await svc().from("idempotency_keys").select("key").eq("rpc", "complete_sale").eq("org_id", st.ids.org);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: { key: string }) => r.key);
}

export const saleBodies = (T: Terminal) => T.rpcBodies.filter((b) => b.name === "complete_sale");

/** F2 → amount → Enter; resolves with the first toast that answers. */
export async function checkout(T: Terminal, paid = 5000): Promise<string> {
  await T.page.keyboard.press("F2");
  const amount = T.page.getByLabel("Amount received");
  await amount.waitFor({ state: "visible" });
  await expect.poll(() => amount.inputValue(), { timeout: 5_000 }).toBe("0");
  await amount.fill(String(paid));
  await expect.poll(() => amount.inputValue(), { timeout: 5_000 }).toBe(String(paid));
  await T.toastsNow();
  await amount.press("Enter");
  const text = await T.toast(/Sale recorded|Pending confirmation|Checkout failed|Nothing was sent|Payment blocked/, 60_000);
  // A refused checkout leaves the payment dialog open: close it.
  if (!/Sale recorded|Pending confirmation/.test(text) && await amount.isVisible()) await T.page.keyboard.press("Escape");
  return text;
}

export async function idbAll(T: Terminal, store: string): Promise<any[]> {
  return T.page.evaluate((storeName) => new Promise<any[]>((resolve, reject) => {
    const req = indexedDB.open("shwe-phala-local");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(storeName)) { db.close(); resolve([]); return; }
      const tx = db.transaction(storeName, "readonly");
      const r = tx.objectStore(storeName).getAll();
      r.onsuccess = () => { db.close(); resolve(r.result); };
      r.onerror = () => { db.close(); reject(r.error); };
    };
  }), store);
}

export async function idbSnapshot(T: Terminal) {
  const [outbox, sales, saleItems, movements, inventory, syncState] = await Promise.all(
    ["syncOutbox", "sales", "saleItems", "movements", "inventory", "syncState"].map((s) => idbAll(T, s)),
  );
  return { outbox, sales, saleItems, movements, inventory, syncState };
}

export const mirrorQty = (snap: { inventory: any[] }, productId = st.ids.prod1) =>
  snap.inventory.find((r) => r.shopId === st.ids.shop && r.productId === productId)?.qtyBaseUnits;

/** Hold every complete_sale request: forwarded to the server only when
 *  `send()` is called; its reply delivered only when `reply()` is called.
 *  `drop()` delivers a connection reset instead (lost reply). */
export async function gateCompleteSale(T: Terminal, mode: "commit-then-hold" | "hold-before-send") {
  let sendGate!: () => void;
  let replyGate!: (how: "deliver" | "drop") => void;
  const sendP = new Promise<void>((r) => { sendGate = r; });
  const replyP = new Promise<"deliver" | "drop">((r) => { replyGate = r; });
  const seen = { requests: 0, serverStatus: 0, committed: false };
  const handler = async (route: Route) => {
    seen.requests += 1;
    if (mode === "hold-before-send") await sendP;
    const res = await route.fetch().catch(() => null);
    seen.committed = Boolean(res);
    seen.serverStatus = res?.status() ?? 0;
    const how = await replyP;
    if (how === "drop" || !res) await route.abort("connectionreset").catch(() => undefined);
    else await route.fulfill({ response: res }).catch(() => undefined);
  };
  await T.context.route(RPC("complete_sale"), handler);
  return {
    seen,
    send: () => sendGate(),
    reply: () => replyGate("deliver"),
    drop: () => replyGate("drop"),
    off: () => T.context.unroute(RPC("complete_sale"), handler),
  };
}

/** Sample the POS figure every ~25 ms while `fn` runs. */
export async function sampleShown(T: Terminal, fn: () => Promise<unknown>, product = P1): Promise<number[]> {
  const samples: number[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const v = await shown(T, product).catch(() => NaN);
      if (!Number.isNaN(v)) samples.push(v);
      await T.page.waitForTimeout(25).catch(() => undefined);
    }
  })();
  try {
    await fn();
  } finally {
    running = false;
    await loop;
  }
  return samples;
}
