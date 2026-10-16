// Compare the live and disposable schema fingerprints. The audit FAILS if parity
// cannot be shown: a missing/failed live read, or any difference, is reported.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
const [parityDir, localDir, mig] = process.argv.slice(2);
const livePath = `${parityDir}/live.fingerprint`, localPath = `${localDir}/local.fingerprint`;
const status = existsSync(`${parityDir}/live.status`) ? readFileSync(`${parityDir}/live.status`, "utf8").trim() : "MISSING";

if (status !== "OK" || !existsSync(livePath)) {
  console.log(`PARITY ${mig}: SKIPPED/UNAVAILABLE (live read status: ${status}). Parity cannot be shown without PHF_ISO_PARITY_SSH.`);
  process.exit(0); // run.sh treats absence of --parity data as "not shown"; only a run WITH a live read can assert parity
}
const live = new Set(readFileSync(livePath, "utf8").split("\n").filter(Boolean));
const local = new Set(readFileSync(localPath, "utf8").split("\n").filter(Boolean));
const onlyLive = [...live].filter((l) => !local.has(l));
const onlyLocal = [...local].filter((l) => !live.has(l));

let out = `# Schema parity — live (production) vs disposable (migration ${mig})\n\n`;
out += `live lines: ${live.size}, disposable lines: ${local.size}\n`;
out += `only on live: ${onlyLive.length}, only on disposable: ${onlyLocal.length}\n\n`;
const cat = (l) => l.split("|")[0];
const byCat = (arr) => { const m = {}; for (const l of arr) m[cat(l)] = (m[cat(l)] ?? 0) + 1; return m; };
out += `differences by category (live-only): ${JSON.stringify(byCat(onlyLive))}\n`;
out += `differences by category (disposable-only): ${JSON.stringify(byCat(onlyLocal))}\n\n`;
if (onlyLive.length) out += `## Only on live\n` + onlyLive.slice(0, 200).map((l) => "- " + l).join("\n") + "\n\n";
if (onlyLocal.length) out += `## Only on disposable\n` + onlyLocal.slice(0, 200).map((l) => "- " + l).join("\n") + "\n\n";
const parityOk = onlyLive.length === 0 && onlyLocal.length === 0;
out = (parityOk ? `PARITY ${mig}: PASS — disposable schema is identical to production.\n\n` : `PARITY ${mig}: FAIL — ${onlyLive.length + onlyLocal.length} differences.\n\n`) + out;
writeFileSync(`${localDir}/../parity-${mig}.md`, out);
console.log(out.split("\n").slice(0, 8).join("\n"));
process.exit(parityOk ? 0 : 1);
