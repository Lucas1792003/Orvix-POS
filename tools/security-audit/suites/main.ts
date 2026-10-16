// Org-isolation audit driver. Builds the synthetic world on the disposable
// phf-iso stack, runs every area suite, scans all captured refusals/responses
// for org-B leaks, and writes results.json. Never prints a secret.
import { buildWorld } from "./seed";
import { record, writeResults, scanLeaks, check, MAX_MIG } from "./lib";
import { tablesSuite } from "./tables";
import { rpcsSuite } from "./rpcs";
import { storageSuite } from "./storage";
import { phoneSuite } from "./phone";
import { functionsSuite } from "./functions";
import { authlinkSuite } from "./authlink";
import { authzSuite } from "./authz";
import { helpersSuite } from "./helpers";

const area = async (name: string, f: () => Promise<void>) => {
  console.log(`\n== ${name} (migration ${MAX_MIG}) ==`);
  try { await f(); } catch (e) { record(name, `suite crashed: ${(e as Error).message}`, "FAIL", []); }
};

console.log(`\n== seed (migration ${MAX_MIG}) ==`);
const w = await buildWorld();
record("seed", "synthetic world built (2 orgs A/B with TOTP admins, attacker org C, orphan, platform admin, deactivated)", "PASS", []);

await area("tables", () => tablesSuite(w));
await area("rpcs", () => rpcsSuite(w));
await area("storage", () => storageSuite(w));
await area("phone", () => phoneSuite(w));
await area("functions", () => functionsSuite(w));
await area("authlink", () => authlinkSuite(w));
await area("authz", () => authzSuite(w));
await area("helpers", () => helpersSuite(w));

// ---- leak scan over every captured refusal / response (req 11) ----
console.log(`\n== errors (migration ${MAX_MIG}) ==`);
const { scanned, leaks } = scanLeaks();
check("errors", `no org-B identifier/canary leaked in any captured response or refusal (${scanned} scanned)`, leaks.length === 0, ["leak-scan"],
  leaks.slice(0, 5).map((l) => `${l.ctx}: ${l.value} in "${l.snippet}"`).join(" | "));
for (const l of leaks.slice(0, 20)) record("errors", `LEAK in ${l.ctx}`, "FAIL", ["leak-scan"], `${l.value} :: ${l.snippet}`);

const counts = writeResults({ scanned });
console.log("\nsummary " + JSON.stringify(counts));
const fails = Object.values(counts).reduce((a, c) => a + c.FAIL, 0);
process.exit(fails > 0 ? 1 : 0);
