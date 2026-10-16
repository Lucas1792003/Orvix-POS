// Area "sweep": the abandoned phone/desktop upload cleanup
// (deploy/lucashome/backup/sweep-abandoned-uploads.sh, G5 follow-up,
// docs/selfhost-migration/phase-f/g5-followups.md §2) run for real against the
// disposable stack: its candidate SQL in the db container, deletion through
// storage-api with the service role. Proves it removes ONLY abandoned uploads
// (row and file), keeps completed / recent / referenced / legacy / allow-listed
// objects, never prints a name, and refuses to run unsafely.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { World } from "./seed";
import { check, http, record, sql, q, DB, MAX_MIG, SERVICE, URL_BASE } from "./lib";
import { fixtures } from "./storage";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "../../../deploy/lucashome/backup/sweep-abandoned-uploads.sh");
const COVER = ["sweep:abandoned-uploads"];
const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const sid = (label: string) => `pimg-${createHash("md5").update(`sweep-${label}-${process.pid}`).digest("hex")}`;

export async function sweepSuite(w: World) {
  if (MAX_MIG < 79) {
    record("sweep", "abandoned-upload sweep: skipped below 079 (no org/<org>/temp/<session> paths)", "SKIP", COVER);
    return;
  }
  const A = w.A, B = w.B;
  const adminA = sql(`SELECT id FROM users WHERE org_id=${q(A.id)} AND role='ADMIN' LIMIT 1`);
  const adminB = sql(`SELECT id FROM users WHERE org_id=${q(B.id)} AND role='ADMIN' LIMIT 1`);

  // label -> [creator, org, status, session age h, object age h, completed]
  const fx: Record<string, [string, string, string, number, number, boolean]> = {
    "a-expired-old": [adminA, A.id, "EXPIRED", 72, 72, false],
    "a-canceled-old": [adminA, A.id, "CANCELED", 48, 48, false],
    "b-pending-stale": [adminB, B.id, "PENDING", 30, 30, false],
    "a-completed-old": [adminA, A.id, "COMPLETED", 96, 96, true],
    "a-expired-recent": [adminA, A.id, "EXPIRED", 3, 3, false],
    "a-referenced-old": [adminA, A.id, "EXPIRED", 72, 72, false],
    "a-allowlisted-old": [adminA, A.id, "CANCELED", 72, 72, false],
  };
  const path = (label: string) => `org/${fx[label][1]}/temp/${sid(label)}`;
  for (const [label, [creator, , status, sAge, oAge, completed]] of Object.entries(fx)) {
    const p = path(label);
    sql(`INSERT INTO product_image_upload_sessions (id, token_hash, created_by, storage_path, status, created_at, expires_at, completed_at, public_url, bytes, mime_type)
         VALUES (${q(sid(label))}, ${q(sha256(`tok-${label}-${process.pid}`))}, ${q(creator)}, ${q(p)}, ${q(status)},
                 now() - interval '${sAge} hours', now() - interval '${sAge} hours' + interval '10 minutes',
                 ${completed ? `now() - interval '${sAge} hours' + interval '1 minute'` : "NULL"},
                 ${completed ? q(`http://127.0.0.1/storage/v1/object/public/product-images/${p}`) : "NULL"},
                 ${completed ? 1500 : "NULL"}, ${completed ? "'image/jpeg'" : "NULL"})`);
    const up = await http("POST", `/storage/v1/object/product-images/${enc(p)}`, { token: SERVICE, apikey: SERVICE, raw: fixtures.polyglot(), headers: { "Content-Type": "image/jpeg" } });
    if (up.status >= 300) throw new Error(`sweep fixture upload ${label}: ${up.status}`);
    sql(`UPDATE storage.objects SET created_at = now() - interval '${oAge} hours' WHERE bucket_id='product-images' AND name=${q(p)}`);
  }
  sql(`UPDATE products SET image_url = ${q(`http://127.0.0.1/storage/v1/object/public/product-images/${path("a-referenced-old")}`)} WHERE id = ${q(A.products[1])}`);
  const expectDelete = ["a-expired-old", "a-canceled-old", "b-pending-stale"].map(path).sort();
  const keepFixtures = ["a-completed-old", "a-expired-recent", "a-referenced-old", "a-allowlisted-old"].map(path);
  // every object that is NOT an expected deletion (seeded org/legacy/brand objects, earlier suites' objects, kept fixtures)
  const othersDigest = () => sql(`SELECT count(*) || ':' || md5(coalesce(string_agg(name || '|' || id::text, ',' ORDER BY name), '')) FROM storage.objects
                                  WHERE NOT (bucket_id = 'product-images' AND name IN (${expectDelete.map(q).join(",")}))`);
  const before = othersDigest();

  const tmp = mkdtempSync(join(tmpdir(), "phf-iso-sweep-"));
  try {
    const envFile = join(tmp, "stack.env");
    writeFileSync(envFile, `ANON_KEY=not-used\nSERVICE_ROLE_KEY=${SERVICE}\n`, { mode: 0o600 });
    const allow = join(tmp, "allow.sha256");
    writeFileSync(allow, `# test allow-list\n# count: 1\n${sha256(path("a-allowlisted-old"))}\n`, { mode: 0o600 });
    const run = (args: string[]) => {
      try {
        const out = execFileSync("bash", [SCRIPT, ...args], {
          encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, SWEEP_DB_CONTAINER: DB, SWEEP_API_URL: URL_BASE, SWEEP_ENV_FILE: envFile, SWEEP_LOCK_DIR: tmp, TMPDIR: tmp },
        });
        return { code: 0, out };
      } catch (e) {
        const err = e as { status?: number; stdout?: string; stderr?: string };
        return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
      }
    };
    const noNames = (out: string) => !Object.keys(fx).some((l) => out.includes(sid(l))) && !out.includes(SERVICE);

    // 1. refuses to run without / with a broken allow-list
    const missing = run(["--dry-run", "--allow-list", join(tmp, "nope.sha256")]);
    writeFileSync(join(tmp, "bad.sha256"), "# count: 2\nabc\n");
    const broken = run(["--dry-run", "--allow-list", join(tmp, "bad.sha256")]);
    check("sweep", "refuses to run without a well-formed allow-list (missing file / count mismatch)", missing.code !== 0 && /allow-list not found/.test(missing.out) && broken.code !== 0 && /allow-list malformed/.test(broken.out) && othersDigest() === before,
      COVER, `codes ${missing.code} ${broken.code}`);
    const graceZero = run(["--dry-run", "--allow-list", allow, "--grace-hours", "0"]);
    check("sweep", "refuses a grace period below 1 hour", graceZero.code !== 0 && /--grace-hours must be/.test(graceZero.out), COVER, `code ${graceZero.code}`);

    // 2. dry run: counts only, nothing deleted
    const dry = run(["--dry-run", "--allow-list", allow]);
    const dryLine = dry.out.split("\n").find((l) => l.startsWith("RESULT dry-run")) ?? "";
    check("sweep", "dry run (default) reports delete=3 (EXPIRED, CANCELED, stale PENDING; both orgs), kept_referenced=1, kept_allow_listed=1 and deletes nothing",
      dry.code === 0 && / delete=3 /.test(dryLine) && /kept_referenced=1 /.test(dryLine) && /kept_allow_listed=1 /.test(dryLine)
        && expectDelete.every((p) => sql(`SELECT count(*) FROM storage.objects WHERE bucket_id='product-images' AND name=${q(p)}`) === "1"),
      COVER, dryLine || dry.out.slice(-300));
    check("sweep", "its output contains counts only: no object name, session id or key", noNames(dry.out), COVER, "");
    const real = run(["--dry-run"]);
    check("sweep", "the committed allow-list (574 migrated object names) is accepted and protects none of the fixtures (delete=4 incl. the test-allow-listed one, kept_allow_listed=0)",
      real.code === 0 && /RESULT dry-run .* delete=4 .*kept_allow_listed=0/.test(real.out), COVER, real.out.split("\n").filter((l) => l.includes("RESULT")).join(" "));

    // 3. a delete set larger than --max-delete is refused as a whole
    const capped = run(["--apply", "--allow-list", allow, "--max-delete", "2"]);
    check("sweep", "--apply refuses (deletes nothing) when the delete set exceeds --max-delete",
      capped.code !== 0 && /exceeds --max-delete 2; nothing deleted/.test(capped.out) && expectDelete.every((p) => sql(`SELECT count(*) FROM storage.objects WHERE bucket_id='product-images' AND name=${q(p)}`) === "1"),
      COVER, `code ${capped.code}`);

    // 4. apply: exactly the 3 abandoned objects go (row AND file); everything else is untouched
    const applied = run(["--apply", "--allow-list", allow]);
    const line = applied.out.split("\n").find((l) => l.startsWith("RESULT apply")) ?? "";
    const gone = expectDelete.every((p) => sql(`SELECT count(*) FROM storage.objects WHERE bucket_id='product-images' AND name=${q(p)}`) === "0");
    const files: number[] = [];
    for (const p of expectDelete) files.push((await http("GET", `/storage/v1/object/public/product-images/${enc(p)}`, { token: null })).status);
    check("sweep", "--apply deletes exactly the 3 abandoned uploads through storage-api (rows gone, public URLs no longer served)",
      applied.code === 0 && /deleted=3 failed=0 still_present=0/.test(line) && gone && files.every((s) => s === 400 || s === 404),
      COVER, `${line} files ${files.join(",")}`);
    const kept: number[] = [];
    for (const p of keepFixtures) kept.push((await http("GET", `/storage/v1/object/public/product-images/${enc(p)}`, { token: null })).status);
    check("sweep", "completed, recent (inside the grace period), referenced and allow-listed objects are kept and still served",
      kept.every((s) => s === 200), COVER, `statuses ${kept.join(",")}`);
    check("sweep", "every other object (seeded org / legacy temp / legacy products / brand logo, earlier suites) is untouched (names + ids digest)",
      othersDigest() === before, COVER, "");
    check("sweep", "--apply output names nothing either", noNames(applied.out), COVER, "");
    const sessions = sql(`SELECT count(*) FROM product_image_upload_sessions WHERE id IN (${Object.keys(fx).map((l) => q(sid(l))).join(",")})`);
    check("sweep", "session rows are kept (audit trail); only objects are removed", sessions === String(Object.keys(fx).length), COVER, `sessions ${sessions}`);

    // 5. idempotent
    const again = run(["--apply", "--allow-list", allow]);
    check("sweep", "a second --apply is a no-op (deleted=0)", again.code === 0 && /RESULT apply deleted=0/.test(again.out) && othersDigest() === before,
      COVER, again.out.split("\n").filter((l) => l.includes("RESULT")).join(" "));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    for (const label of Object.keys(fx)) {
      await http("DELETE", `/storage/v1/object/product-images/${enc(path(label))}`, { token: SERVICE, apikey: SERVICE });
    }
  }
}
