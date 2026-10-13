/// <reference types="node" />
/* eslint-disable @typescript-eslint/no-explicit-any */
// Diagnostic probe for live test 14 (Realtime postgres_changes on inventory).
// Subscribes as the service role (no RLS) and as the QA cashier (RLS), then
// bumps a QA inventory row through adjust_stock as the QA manager and prints
// which subscriber received what. Prints no secrets (only event shapes).
//
// Usage (keys in env vars):
//   LIVE_SUPABASE_URL=... LIVE_ANON_KEY=... LIVE_SERVICE_KEY=... \
//   LIVE_QA_TS=<ts> LIVE_QA_PASSWORD=<pw> npx tsx src/live/realtimeProbe.ts
import { liveConfig, makeClient, signedInClient, sleep, uuid } from "./liveHelpers";

async function main() {
  const cfg = liveConfig();
  const ts = process.env.LIVE_QA_TS!;
  const password = process.env.LIVE_QA_PASSWORD!;
  const shop = `qa-shop-${ts}`;
  const prod = `qa-prod-1-${ts}`;
  const mgrId = `qa-user-manager-${ts}`;

  const svc = makeClient(cfg, cfg.serviceKey);
  const cashA = await signedInClient(cfg, `qa-cashier-a-${ts}@qa.invalid`, password);
  const mgr = await signedInClient(cfg, `qa-manager-${ts}@qa.invalid`, password);

  const log = (who: string, p: any) =>
    console.log(`[${who}] ${p.eventType} ${p.table} new=${JSON.stringify(p.new)} errors=${JSON.stringify(p.errors)}`);

  const subscribe = (client: any, who: string, filter?: string) =>
    new Promise<string>((resolve) => {
      const ch = client.channel(`probe-${who}-${Date.now()}`);
      ch.on("postgres_changes", { event: "*", schema: "public", table: "inventory", ...(filter ? { filter } : {}) }, (p: any) => log(who, p));
      ch.on("system", {}, (p: any) => console.log(`[${who}] system ${JSON.stringify(p)}`));
      const timer = setTimeout(() => resolve("TIMEOUT"), 20000);
      ch.subscribe((s: string, err?: Error) => {
        console.log(`[${who}] status ${s}${err ? ` err=${err.message}` : ""}`);
        if (s === "SUBSCRIBED" || s === "CHANNEL_ERROR" || s === "TIMED_OUT" || s === "CLOSED") { clearTimeout(timer); resolve(s); }
      });
    });

  console.log("svc:", await subscribe(svc, "service-role"));
  console.log("cashA:", await subscribe(cashA, "cashier-a"));
  console.log("cashA-filtered:", await subscribe(cashA, "cashier-a-filter", `shop_id=eq.${shop}`));
  await sleep(1500);

  const { data: subs } = await svc.rpc("__nonexistent__").then(() => ({ data: null }), () => ({ data: null }));
  void subs;

  const r = await mgr.rpc("adjust_stock", {
    p_shop_id: shop, p_product_id: prod, p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 1, p_reason: "QA realtime probe",
    p_product_unit_id: null, p_unit_qty: null, p_created_at: null, p_expected_actor_id: mgrId, p_idempotency_key: uuid(),
  });
  console.log("adjust_stock:", r.error ? `ERROR ${r.error.message}` : `ok qtyAfter=${r.data.inventory.qtyBaseUnits}`);
  await sleep(8000);
  console.log("done waiting 8 s");
  await svc.removeAllChannels();
  await cashA.removeAllChannels();
  process.exit(0);
}

main().catch((err) => { console.error("probe failed:", err?.message ?? err); process.exit(1); });
