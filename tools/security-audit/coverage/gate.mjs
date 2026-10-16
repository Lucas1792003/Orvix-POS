// Coverage gate. Derives the set of items that MUST have a mapped test from the
// live catalog inventory (not a hand list), unions the Edge Functions, maps each
// to the covers[] recorded by the suites, and FAILS if any of these is unmapped:
//   * every org-scoped table/view
//   * every API-callable function (anon OR authenticated EXECUTE)
//   * every SECURITY DEFINER function (that is API-reachable, i.e. not internal
//     helper owned functions with no client EXECUTE — those are reported as
//     service-role-only, not gaps)
//   * every storage policy
//   * every Edge Function directory
// Writes coverage.json (machine-readable) and coverage.md next to the results.
import { readFileSync, writeFileSync } from "node:fs";

const [invPath, resPath, mapPath, outDir] = process.argv.slice(2);
const inv = JSON.parse(readFileSync(invPath, "utf8"));
const res = JSON.parse(readFileSync(resPath, "utf8"));
const smap = JSON.parse(readFileSync(mapPath, "utf8"));

// covers[] -> [test ids]
const byCover = new Map();
for (const r of res.results) for (const c of r.covers ?? []) {
  if (!byCover.has(c)) byCover.set(c, []);
  byCover.get(c).push(r.id);
}
const covered = (key) => byCover.get(key) ?? [];

const required = []; // { kind, item, cover, tests, classification }
const add = (kind, item, cover, classification = "") => required.push({ kind, item, cover, tests: covered(cover), classification });

// tables / views
for (const t of inv.tables) {
  if (t.class === "org-scoped") add("org-scoped table", t.id, `table:${t.id}`, t.class);
  else if (t.class === "storage") { /* storage policies cover these */ }
}
// storage policies
for (const p of inv.policies.filter((p) => p.table.startsWith("storage."))) {
  add("storage policy", p.id, `storage-policy:${p.id.split(":")[1]}`);
}
// functions: API-callable (anon or authenticated) and SECURITY DEFINER (API-reachable)
for (const f of inv.functions) {
  if (f.returns_trigger) continue;
  const apiCallable = f.anon || f.authenticated;
  const isDefiner = f.security_definer;
  if (!apiCallable && !isDefiner) continue;
  // internal helpers (SECURITY DEFINER but no client EXECUTE at all) are reported
  // as service-role/owner-only, which is itself the isolation property; require a
  // mapping only when API-callable. Definer + service_role-only still needs a note.
  const cover = `rpc:${f.name}`;
  const cls = apiCallable ? (f.anon ? "anon+auth" : "authenticated") : (f.service_role ? "service_role-only" : "definer-no-grant");
  // require a test for anything anon/authenticated can call; definer-only service-role
  // functions are allowed to be covered by a grant assertion OR noted.
  if (apiCallable) add(apiCallable ? "api function" : "definer function", f.name, cover, cls);
  else add("security-definer (service-role-only)", f.name, cover, cls);
}
// Edge functions
for (const e of smap.edge_functions) add("edge function", e, `${smap.edge_function_cover_prefix}${e}`);
for (const x of smap.extra_requirements ?? []) add("extra", x, x);

// Service-role-only definer functions may be covered by a grant/role assertion
// instead of a behavioural test; treat them as covered if ANY test maps OR if
// they are among the known internal helpers with no client grant. Everything
// else that is anon/authenticated or an edge function MUST have a mapped test.
const HARD_KINDS = new Set(["org-scoped table", "storage policy", "api function", "edge function", "extra", "security-definer (service-role-only)"]);
const gaps = required.filter((r) => r.tests.length === 0 && HARD_KINDS.has(r.kind));
const softGaps = required.filter((r) => r.tests.length === 0 && !HARD_KINDS.has(r.kind));

const summary = {
  migration: inv.migration_level,
  totals: {
    org_scoped_tables: required.filter((r) => r.kind === "org-scoped table").length,
    storage_policies: required.filter((r) => r.kind === "storage policy").length,
    api_functions: required.filter((r) => r.kind === "api function").length,
    definer_service_role_only: required.filter((r) => r.kind === "security-definer (service-role-only)").length,
    edge_functions: required.filter((r) => r.kind === "edge function").length,
  },
  required: required.length,
  mapped: required.filter((r) => r.tests.length > 0).length,
  hard_gaps: gaps.length,
  soft_gaps_service_role_only_no_behaviour_test: softGaps.map((s) => s.item),
  gate: gaps.length === 0 ? "PASS" : "FAIL",
  items: required,
};
writeFileSync(`${outDir}/coverage.json`, JSON.stringify(summary, null, 1));

let md = `# Coverage matrix — migration ${inv.migration_level}\n\n`;
md += `Gate: **${summary.gate}** — ${summary.mapped}/${summary.required} required items mapped; ${gaps.length} hard gaps.\n\n`;
md += `| # | kind | item | classification | tests |\n|---|---|---|---|---|\n`;
for (const r of required) md += `| ${r.tests.length ? "✓" : "✗"} | ${r.kind} | \`${r.item}\` | ${r.classification} | ${r.tests.slice(0, 4).join(", ") || "**NONE**"} |\n`;
writeFileSync(`${outDir}/coverage.md`, md);

console.log(`coverage ${inv.migration_level}: ${summary.gate} (${summary.mapped}/${summary.required} mapped, ${gaps.length} hard gaps)`);
if (gaps.length) { for (const g of gaps) console.log(`  GAP ${g.kind}: ${g.item} (${g.cover})`); process.exit(1); }
process.exit(0);
