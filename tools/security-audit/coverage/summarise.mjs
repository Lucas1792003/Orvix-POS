// Roll the per-migration results + coverage (+ parity) into one SUMMARY.md.
import { readFileSync, existsSync, readdirSync } from "node:fs";
const dir = process.argv[2];
const levels = readdirSync(dir).filter((d) => /^m\d+$/.test(d)).sort();
const read = (p) => (existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

let md = `# Org-isolation security audit — summary\n\nGenerated ${new Date().toISOString()} · results dir \`${dir}\`\n\n`;

const parity = existsSync(`${dir}/parity`) ? "run (see parity/ and each m*/parity.txt)" : "not run (pass --parity)";
md += `Schema parity (live 081 vs disposable 081): ${parity}\n\n`;

for (const lvl of levels) {
  const res = read(`${dir}/${lvl}/results.json`);
  const cov = read(`${dir}/${lvl}/coverage.json`);
  if (!res) continue;
  const n = res.migration;
  md += `## Migration ${n}\n\n`;
  if (cov) md += `Coverage gate: **${cov.gate}** — ${cov.mapped}/${cov.required} items mapped, ${cov.hard_gaps} hard gaps `
    + `(org-scoped tables ${cov.totals.org_scoped_tables}, storage policies ${cov.totals.storage_policies}, API functions ${cov.totals.api_functions}, service-role definer ${cov.totals.definer_service_role_only}, edge functions ${cov.totals.edge_functions}).\n\n`;
  md += `| area | PASS | FAIL | GAP | SKIP | INFO |\n|---|--:|--:|--:|--:|--:|\n`;
  let tot = { PASS: 0, FAIL: 0, GAP: 0, SKIP: 0, INFO: 0 };
  for (const [area, c] of Object.entries(res.counts)) {
    md += `| ${area} | ${c.PASS} | ${c.FAIL} | ${c.GAP} | ${c.SKIP} | ${c.INFO} |\n`;
    for (const k of Object.keys(tot)) tot[k] += c[k];
  }
  md += `| **total** | **${tot.PASS}** | **${tot.FAIL}** | **${tot.GAP}** | **${tot.SKIP}** | **${tot.INFO}** |\n\n`;
  const gaps = res.results.filter((r) => r.status === "GAP");
  if (gaps.length) {
    md += `### Gaps at ${n}\n\n`;
    for (const g of gaps) md += `- **[${g.severity ?? "?"}]** ${g.name} — ${g.detail ?? ""}\n`;
    md += `\n`;
  }
  const fails = res.results.filter((r) => r.status === "FAIL");
  if (fails.length) {
    md += `### Unexpected failures at ${n}\n\n`;
    for (const f of fails.slice(0, 40)) md += `- ${f.area}: ${f.name} — ${f.detail ?? ""}\n`;
    md += `\n`;
  }
}

// GAP delta: which gaps at the lowest level are closed at the highest
if (levels.length >= 2) {
  const lo = read(`${dir}/${levels[0]}/results.json`);
  const hi = read(`${dir}/${levels[levels.length - 1]}/results.json`);
  if (lo && hi) {
    const hiByName = new Map(hi.results.map((r) => [r.name, r.status]));
    md += `## What the top migration closes\n\n`;
    for (const g of lo.results.filter((r) => r.status === "GAP")) {
      md += `- ${g.name}: ${lo.migration} = GAP → ${hi.migration} = ${hiByName.get(g.name) ?? "?"}\n`;
    }
    md += `\n`;
  }
}
process.stdout.write(md);
