// Legacy-client failure classification harness (m087 PoC).
//
// Run through tools/m087-verify/legacy/run-harness.sh (materialises the verbatim legacy files from git objects first):
//   ORVIX_REPO=<repo> node_modules/.bin/tsx <materialised dir>/classify-harness.mjs <fixtures.json> [--json]
//
// Fixture shape: {id, status, contentType, body (string), networkError?: bool,
//                 networkMessage?: string, headers?: {name: value}}
//
// For every fixture the SAME raw HTTP reply is served (to every request) by a
// fake fetch behind the REAL @supabase/postgrest-js 2.106.1 from the repo's
// node_modules (the version every ref's lockfile pins), so the {error, status}
// each version sees is built exactly as in the app. BATCH2A/PHASE0 also wrap
// fetch with their real retryAfterAwareFetch (src/lib/supabase.ts:36).
// Version code: <VER>/src/** = `git show <ref>:<path>` (unmodified) + clearly
// marked stubs; <VER>/extracted.ts = verbatim inline decisions with citations.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_NM = `${process.env.ORVIX_REPO ?? path.resolve(HERE, "../../..")}/node_modules`;
const { PostgrestClient } = await import(pathToFileURL(`${REPO_NM}/@supabase/postgrest-js/dist/index.mjs`).href);

const argv = process.argv.slice(2);
const fixturesPath = argv.find((a) => !a.startsWith("--")) ?? path.join(HERE, "fixtures.json");
const asJson = argv.includes("--json");
const fixtures = JSON.parse(fs.readFileSync(fixturesPath, "utf8"));

const mod = (rel) => import(pathToFileURL(path.join(HERE, rel)).href);
const V = {
  V1015: { x: await mod("V1015/extracted.ts") },
  RC3: { x: await mod("RC3/extracted.ts") },
  BATCH2A: { x: await mod("BATCH2A/extracted.ts"), ra: await mod("BATCH2A/src/lib/retryAfter.ts") },
  PHASE0: {
    x: await mod("PHASE0/extracted.ts"), ra: await mod("PHASE0/src/lib/retryAfter.ts"),
    rpc: await mod("PHASE0/src/stores/data/idempotentRpc.ts"), db: await mod("PHASE0/src/lib/localDb.ts"),
  },
};

let requests = [];
function fakeFetchFor(fx) {
  return async (url, init) => {
    const u = new URL(typeof url === "string" ? url : url.url);
    requests.push(`${init?.method ?? "GET"} ${u.pathname.replace("/rest/v1", "")}`);
    if (fx.networkError) throw new TypeError(fx.networkMessage ?? "Failed to fetch");
    const noBody = [204, 205, 304].includes(fx.status);
    return new Response(noBody ? null : (fx.body ?? ""), {
      status: fx.status, headers: { "content-type": fx.contentType ?? "application/json", ...(fx.headers ?? {}) },
    });
  };
}
function install(fx, wrap) {
  const base = fakeFetchFor(fx);
  globalThis.__HARNESS_SUPABASE__ = new PostgrestClient("https://harness.invalid/rest/v1", { fetch: wrap ? wrap(base) : base });
  return globalThis.__HARNESS_SUPABASE__;
}
const KEY = "0192a5e0-0000-7000-8000-000000000001"; // UUIDv7-shaped
const saleArgs = (withKey) => ({ p_shop_id: "shop-1", p_shift_id: "shift-1", p_items: [], ...(withKey ? { p_idempotency_key: KEY } : {}) });
const catRow = { id: "cat-1", name: "Harness" };

async function phase0Reset(seen086) {
  V.PHASE0.ra.resetRetryAfterForTests();
  V.PHASE0.db.__resetHarnessLocalDb();
  V.PHASE0.rpc.setExecutorCapabilityForTests("unknown", false);
  if (seen086) await V.PHASE0.db.localDb.syncState.put({ key: "executor-086-seen:https://harness.invalid" });
}

const short = (o) => {
  if (!o) return "";
  const e = o.outcome?.error;
  return e ? `${e.status ?? "-"}/${e.code ?? "-"}` : "";
};

async function runFixture(fx) {
  const row = { id: fx.id };
  // RAW: what postgrest-js resolves with for supabase.rpc("complete_sale", …)
  {
    const sb = install(fx);
    requests = [];
    const r = await sb.rpc("complete_sale", saleArgs(true));
    row.raw = { status: r.status, code: r.error?.code ?? "", message: (r.error?.message ?? "").slice(0, 70) };
  }
  // V1015
  {
    const v = V.V1015.x;
    const sb = install(fx);
    row.V1015 = {
      online: await v.onlineSaleDecision(() => sb.rpc("complete_sale", saleArgs(false))),
      drain: await v.drainDecision(() => sb.rpc("complete_sale", saleArgs(false))),
      table: await v.tableWriteDecision(() => sb.from("categories").insert(catRow)),
      drainTable: await v.drainDecision(() => sb.from("categories").insert(catRow)),
    };
  }
  // RC3
  {
    const v = V.RC3.x;
    const sb = install(fx);
    row.RC3 = {
      online: await v.onlineSaleDecision(saleArgs(true)),
      drain: await v.drainDecision({ kind: "rpc", name: "complete_sale", args: saleArgs(true) }),
      table: await v.tableWriteDecision(() => sb.from("categories").insert(catRow)),
      drainTable: await v.drainDecision({ kind: "table_write", op: "insert", name: "categories.insert" }, () => sb.from("categories").insert(catRow)),
    };
  }
  // BATCH2A
  {
    const v = V.BATCH2A.x;
    V.BATCH2A.ra.resetRetryAfterForTests();
    const sb = install(fx, V.BATCH2A.ra.retryAfterAwareFetch);
    const tw = () => sb.from("categories").insert(catRow).select("id");
    row.BATCH2A = {
      online: await v.onlineSaleDecision(saleArgs(true)),
      drain: (V.BATCH2A.ra.resetRetryAfterForTests(), await v.drainDecision({ kind: "rpc", name: "complete_sale", args: saleArgs(true) })),
      table: (V.BATCH2A.ra.resetRetryAfterForTests(), await v.tableWriteDecision(tw, "categories.insert")),
      drainTable: (V.BATCH2A.ra.resetRetryAfterForTests(), await v.drainDecision({ kind: "table_write", name: "categories.insert" }, tw)),
    };
  }
  // PHASE0 (server never seen with 086) and PHASE0* (086 already demonstrated by this backend)
  for (const [label, seen] of [["PHASE0", false], ["PHASE0*", true]]) {
    const v = V.PHASE0.x;
    const sb = install(fx, V.PHASE0.ra.retryAfterAwareFetch);
    const tw = () => sb.from("categories").insert(catRow).select("id");
    await phase0Reset(seen); requests = [];
    const online = await v.onlineSaleDecision(saleArgs(true), "user-1");
    online.requests = requests.join(" -> ");
    await phase0Reset(seen); requests = [];
    const drain = await v.drainDecision({ kind: "rpc", name: "complete_sale", args: saleArgs(true), actorId: "user-1" });
    drain.requests = requests.join(" -> ");
    await phase0Reset(seen);
    const table = await v.tableWriteDecision(tw, "categories.insert");
    await phase0Reset(seen);
    const drainTable = await v.drainDecision({ kind: "table_write", name: "categories.insert" }, tw);
    row[label] = { online, drain, table, drainTable };
  }
  return row;
}

const rows = [];
for (const fx of fixtures) rows.push(await runFixture(fx));

if (asJson) {
  const strip = (o) => JSON.parse(JSON.stringify(o, (k, val) => (k === "outcome" ? undefined : val)));
  console.log(JSON.stringify(rows.map(strip), null, 2));
  process.exit(0);
}

const pad = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
const VERS = ["V1015", "RC3", "BATCH2A", "PHASE0", "PHASE0*"];
console.log(`fixtures: ${fixturesPath}\n`);
console.log("RAW postgrest-js 2.106.1 result for supabase.rpc('complete_sale')  [status | error.code | error.message]");
for (const r of rows) console.log(`  ${pad(r.id, 22)} ${pad(r.raw.status, 4)} ${pad(r.raw.code, 9)} ${r.raw.message}`);

function table(title, pick, w = 38) {
  console.log(`\n${title}`);
  console.log(`  ${pad("fx", 4)} ${VERS.map((v) => pad(v, w)).join(" ")}`);
  for (const r of rows) console.log(`  ${pad(r.id, 22)} ${VERS.map((v) => pad(pick(r[v], v), w)).join(" ")}`);
}
const klassOf = (o, v) => {
  if (v === "V1015") return "(no classifier)";
  if (v === "RC3") { const e = o.outcome?.error; return e ? `transient=${e.transient}` : "ok"; }
  return o.klass;
};
table("1. ONLINE CHECKOUT (createSale while navigator.onLine): what the cashier gets", (x) => x.online.result);
table("   classifier class seen by the online path", (x, v) => (v === "V1015" || v === "RC3" ? "-" : x.online.klass));
table("2. QUEUE DRAIN of a queued complete_sale: classification", (x, v) => klassOf(x.drain, v));
table("   resulting queue state", (x) => x.drain.state);
table("   held reason / in doubt / backoff floor / pass", (x, v) =>
  v === "V1015" || v === "RC3" ? (x.drain.passEnds ? "pass stops" : "next entry") :
  `${x.drain.heldReason ?? "-"}/${x.drain.inDoubt ? "inDoubt" : "-"}/${Math.round((x.drain.delayFloorMs ?? 0) / 1000)}s/${x.drain.passEnds}`);
table("   requests sent for one drain attempt", (x, v) => (v.startsWith("PHASE0") ? x.drain.requests.replaceAll("POST /rpc/", "") : "complete_sale"), 38);
table("3. CATALOGUE writeTableRow (categories insert) online", (x) => x.table.result);
table("4. QUEUE DRAIN of a queued table_write", (x) => x.drainTable.state);
