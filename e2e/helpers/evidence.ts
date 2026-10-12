// Evidence ledger: one JSON line per check, appended to
// e2e/.results/evidence.jsonl. docs/selfhost-migration/phase-e/e2e-results.md
// is compiled from it. Never contains secrets — callers pass counts, ids,
// receipt numbers and messages only.
import { appendFileSync } from "node:fs";
import path from "node:path";
import { ensureResultsDir } from "./env";

export type Verdict = "PASS" | "FAIL" | "SKIPPED" | "INFO";

export interface EvidenceRow {
  area: string;
  test: string;
  result: Verdict;
  evidence: string;
  at: string;
}

export function record(area: string, test: string, result: Verdict, evidence: string): void {
  const row: EvidenceRow = { area, test, result, evidence, at: new Date().toISOString() };
  appendFileSync(path.join(ensureResultsDir(), "evidence.jsonl"), `${JSON.stringify(row)}\n`, "utf8");
  process.stdout.write(`  [${result}] ${area} / ${test}: ${evidence}\n`);
}
