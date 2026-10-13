// Hosted-project guard for the Playwright run (Phase G). Every terminal
// already aborts any request to *.supabase.co (helpers/terminal.ts); this
// makes such an attempt a HARD FAILURE of the run instead of a logged abort:
//
//   1. the attempt is written to the evidence ledger as a FAIL line;
//   2. assertConsistency() (run after every spec) treats it as a violation
//      and throws, failing the spec;
//   3. global-teardown (a different process, so it cannot see this module's
//      memory) scans the ledger and throws, so `playwright test` exits
//      non-zero even if a spec swallowed the error;
//   4. B12 keeps its own explicit assertion.
//
// The host test itself is shared with the vitest suite (src/test/hostedGuard.ts).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isHostedSupabaseUrl } from "../../src/test/hostedGuard";
import { RESULTS_DIR } from "./env";
import { record, type EvidenceRow } from "./evidence";

export const HOSTED_GUARD_AREA = "guard";
export const HOSTED_GUARD_TEST = "hosted project touched";

const attempts: string[] = [];

export { isHostedSupabaseUrl };

/** Called by a terminal's request interceptor after aborting the request. */
export function noteHostedRequest(url: string, terminal: string): void {
  attempts.push(url);
  let where = url;
  try {
    const u = new URL(url);
    where = `${u.host}${u.pathname}`;
  } catch {
    /* keep the raw url */
  }
  record(HOSTED_GUARD_AREA, HOSTED_GUARD_TEST, "FAIL", `${terminal} terminal attempted ${where} (aborted)`);
}

export function hostedRequests(): string[] {
  return [...attempts];
}

/** Throws when any terminal in this worker tried to reach the hosted project. */
export function assertHostedUntouched(label: string): void {
  if (attempts.length === 0) return;
  throw new Error(`${label}: ${attempts.length} request(s) to the hosted Supabase project were attempted (and aborted): ${attempts.join(", ")}`);
}

/** For global-teardown: FAIL lines this guard wrote during the whole run. */
export function hostedFailuresInLedger(): string[] {
  const file = path.join(RESULTS_DIR, "evidence.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const row = JSON.parse(line) as EvidenceRow;
        return row.area === HOSTED_GUARD_AREA && row.test === HOSTED_GUARD_TEST && row.result === "FAIL" ? [row.evidence] : [];
      } catch {
        return [];
      }
    });
}
