// The QA tenant is deliberately NOT removed here, so a failed run can be
// inspected (and re-run against the same seed with E2E_QA_TS). Cleanup is
// an explicit, separate step: `npm run e2e:cleanup` (e2e/seed/cleanup.ts),
// which runs cleanup.sql -> audit_purge.sql -> verify_clean.sql and prints
// the counts for the run report.
import { hostedFailuresInLedger } from "./helpers/hostedGuard";

export default async function globalTeardown(): Promise<void> {
  const ts = process.env.E2E_QA_STATE ? (JSON.parse(process.env.E2E_QA_STATE) as { ts: string }).ts : "?";
  process.stdout.write(`[e2e] done. QA tenant ts=${ts} still on the stack — run \`npm run e2e:cleanup\` to remove it.\n`);

  // Hard failure of the whole run if any terminal ever tried to reach the
  // hosted project (helpers/hostedGuard.ts) — independent of whether the
  // spec that caused it noticed.
  const hosted = hostedFailuresInLedger();
  if (hosted.length > 0) {
    throw new Error(`[e2e] HOSTED PROJECT GUARD: ${hosted.length} attempted request(s) to *.supabase.co during this run:\n  ${hosted.join("\n  ")}`);
  }
}
