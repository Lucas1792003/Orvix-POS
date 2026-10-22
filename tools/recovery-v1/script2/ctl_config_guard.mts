// Recovery Script 2: Control server fail-closed config guard (DB-free).
// Run INSIDE the disposable Control runner (node_modules present), with this file mounted at /probe:
//   node --conditions=react-server --import tsx /probe/ctl_config_guard.mts
// Each case spawns a fresh node that only imports Control's src/server/config.ts with a synthetic environment
// (dummy values; no database connection is ever attempted) and records whether it refuses.
import { spawnSync } from "node:child_process";

const base: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  ORVIX_DB_HOST: "127.0.0.1", ORVIX_DB_PORT: "55440", ORVIX_DB_NAME: "orvix_control",
  ORVIX_DB_APP_USER: "control_app", ORVIX_DB_APP_PASSWORD: "synthetic-not-a-secret",
  ORVIX_RP_ID: "localhost", ORVIX_ORIGIN: "http://localhost:3410",
};
const cases: Array<[string, Record<string, string>, boolean]> = [
  ["CFG-0 dev target accepted", {}, true],
  ["CFG-1 POS/Supabase host refused", { ORVIX_DB_HOST: "10.0.0.5", ORVIX_DB_PORT: "5432", ORVIX_DB_NAME: "postgres" }, false],
  ["CFG-2 service_role user refused", { ORVIX_DB_APP_USER: "service_role" }, false],
  ["CFG-3 SUPABASE_SERVICE_ROLE_KEY in env refused", { SUPABASE_SERVICE_ROLE_KEY: "synthetic" }, false],
  ["CFG-4 superuser creds in env refused", { ORVIX_DB_SUPERUSER_PASSWORD: "synthetic" }, false],
  ["CFG-5 non-localhost RP refused", { ORVIX_RP_ID: "control.example.invalid", ORVIX_ORIGIN: "https://control.example.invalid" }, false],
];
let fails = 0;
for (const [name, env, expectOk] of cases) {
  const r = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "-e",
    "await import('/work/src/server/config.ts'); console.log('LOADED')"], { env: { ...base, ...env }, cwd: "/work", encoding: "utf8" });
  const loaded = r.status === 0 && r.stdout.includes("LOADED");
  const msg = (r.stderr.match(/orvix-control: [^\n]*/) ?? [""])[0];
  const pass = loaded === expectOk;
  if (!pass) fails++;
  console.log(`${name}: expected ${expectOk ? "load" : "refuse"}, got ${loaded ? "load" : "refuse"} ${msg} -> ${pass ? "PASS" : "FAIL"}`);
}
console.log(`config guard: ${fails} failing`);
process.exit(fails ? 1 : 0);
