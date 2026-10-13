// Removes every QA row created by a Phase E run and proves it:
//   1. supabase/tests/phase-d/live/cleanup.sql  (single transaction, FK order)
//   2. supabase/tests/phase-e/live/audit_purge.sql (GoTrue audit rows that
//      mention @qa.invalid — everything else is kept)
//   3. supabase/tests/phase-d/live/verify_clean.sql (RAISEs if anything remains)
// plus the storage file count on the host (no flow uploads an image, so it
// must be unchanged). Usage: npm run e2e:cleanup  (needs E2E_* env).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { runSqlFile } from "../helpers/db";
import { liveCfg, PROJECT_ROOT } from "../helpers/env";

const PHASE_D_SQL = path.join(PROJECT_ROOT, "supabase", "tests", "phase-d", "live");
const PHASE_E_SQL = path.join(PROJECT_ROOT, "supabase", "tests", "phase-e", "live");

function storageFileCount(): string {
  const cfg = liveCfg();
  return execFileSync("ssh", ["-o", "BatchMode=yes", cfg.sshHost, `find ${cfg.stackDir}/volumes/storage -type f | wc -l`], { encoding: "utf8" }).trim();
}

async function main(): Promise<void> {
  const before = storageFileCount();
  process.stdout.write(`storage files on disk before cleanup: ${before}\n`);
  process.stdout.write(`\n== cleanup.sql ==\n${runSqlFile(path.join(PHASE_D_SQL, "cleanup.sql")).trim()}\n`);
  process.stdout.write(`\n== audit_purge.sql ==\n${runSqlFile(path.join(PHASE_E_SQL, "audit_purge.sql")).trim()}\n`);
  process.stdout.write(`\n== verify_clean.sql ==\n${runSqlFile(path.join(PHASE_D_SQL, "verify_clean.sql")).trim()}\n`);
  const after = storageFileCount();
  process.stdout.write(`\nstorage files on disk after cleanup: ${after}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
