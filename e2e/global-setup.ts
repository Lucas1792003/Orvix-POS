// Creates the QA tenant on the self-hosted stack (same approach as the
// Phase D live suite: GoTrue sign-ups through the API, then seed.sql with
// triggers disabled, then the Phase E extension) and enrols a TOTP factor
// for the QA admin through the auth API. Secrets go to process.env only.
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { randomPassword, signUpUser } from "../src/live/liveHelpers";
import { runSql, runSqlFile, svc, userClient } from "./helpers/db";
import { buildQaState, DEV_SERVER_URL, ensureResultsDir, liveCfg, PROJECT_ROOT, type QaState } from "./helpers/env";
import { record } from "./helpers/evidence";
import { totpCode, totpSecondsLeft } from "./helpers/totp";

const PHASE_D_SQL = path.join(PROJECT_ROOT, "supabase", "tests", "phase-d", "live");
const PHASE_E_SQL = path.join(PROJECT_ROOT, "supabase", "tests", "phase-e", "live");

/** The dev server must have been started with the self-hosted env (Vite
 *  inlines import.meta.env into the transformed module): refuse to run
 *  otherwise, so a stray .env.local can never point the suite at hosted. */
async function assertDevServerTarget(cfg: { url: string }): Promise<void> {
  const res = await fetch(`${DEV_SERVER_URL}/src/lib/supabase.ts`);
  const text = await res.text();
  if (!text.includes(cfg.url) || /supabase\.co/.test(text)) {
    throw new Error(`dev server at ${DEV_SERVER_URL} is not configured for ${cfg.url} — refusing to run`);
  }
  record("guard", "dev server target", "INFO", `transformed src/lib/supabase.ts embeds ${cfg.url}; no *.supabase.co host present`);
}

export default async function globalSetup(): Promise<void> {
  const resultsDir = ensureResultsDir();
  const evidenceFile = path.join(resultsDir, "evidence.jsonl");
  if (!process.env.E2E_KEEP_EVIDENCE && existsSync(evidenceFile)) rmSync(evidenceFile);
  const cfg = liveCfg();
  await assertDevServerTarget(cfg);

  const reuse = process.env.E2E_QA_TS;
  const ts = reuse ?? String(Date.now());
  const password = process.env.E2E_QA_PASSWORD ?? randomPassword();
  let authIds: QaState["authIds"];
  const st0 = buildQaState(ts, { admin: "", mgr: "", cashA: "", cashB: "" });

  if (!reuse) {
    // Refuse to seed on top of leftovers from an earlier run.
    const verify = runSqlFile(path.join(PHASE_D_SQL, "verify_clean.sql")).trim();
    if (!verify.endsWith("CLEAN")) throw new Error(`stack is not clean before seeding: ${verify}`);
    authIds = {
      admin: await signUpUser(cfg, st0.emails.admin, password),
      mgr: await signUpUser(cfg, st0.emails.mgr, password),
      cashA: await signUpUser(cfg, st0.emails.cashA, password),
      cashB: await signUpUser(cfg, st0.emails.cashB, password),
    };
    const seed = runSqlFile(path.join(PHASE_D_SQL, "seed.sql"), {
      ts, auth_admin: authIds.admin, auth_mgr: authIds.mgr, auth_casha: authIds.cashA, auth_cashb: authIds.cashB,
    }).trim();
    const extra = runSqlFile(path.join(PHASE_E_SQL, "seed_extra.sql"), { ts }).trim();
    record("seed", "phase-d seed.sql", "INFO", seed);
    record("seed", "phase-e seed_extra.sql", "INFO", extra);
  } else {
    const { data, error } = await svc().from("users").select("id, auth_id").like("id", `qa-user-%-${ts}`);
    if (error) throw new Error(error.message);
    const byId = new Map<string, string>((data ?? []).map((u: { id: string; auth_id: string }) => [u.id, u.auth_id]));
    authIds = {
      admin: byId.get(st0.ids.admin) ?? "", mgr: byId.get(st0.ids.mgr) ?? "",
      cashA: byId.get(st0.ids.cashA) ?? "", cashB: byId.get(st0.ids.cashB) ?? "",
    };
    record("seed", "reuse", "INFO", `reusing QA tenant ts=${ts}`);
  }
  const state = buildQaState(ts, authIds);

  // TOTP for the QA admin: enroll -> challenge -> verify through the auth API.
  let secret = process.env.E2E_QA_TOTP_SECRET;
  const admin = await userClient(state.emails.admin, password);
  const factors = await admin.auth.mfa.listFactors();
  if (factors.error) throw new Error(`listFactors: ${factors.error.message}`);
  const verified = (factors.data?.totp ?? []).filter((f) => f.status === "verified");
  if (verified.length === 0) {
    const en = await admin.auth.mfa.enroll({ factorType: "totp", issuer: "Shwe PhaLar", friendlyName: "QA e2e" });
    if (en.error) throw new Error(`enroll: ${en.error.message}`);
    secret = en.data.totp.secret;
    if (totpSecondsLeft() < 3) await new Promise((r) => setTimeout(r, 3500));
    const ch = await admin.auth.mfa.challenge({ factorId: en.data.id });
    if (ch.error) throw new Error(`challenge: ${ch.error.message}`);
    const ve = await admin.auth.mfa.verify({ factorId: en.data.id, challengeId: ch.data.id, code: totpCode(secret) });
    if (ve.error) throw new Error(`verify: ${ve.error.message}`);
    const aal = await admin.auth.mfa.getAuthenticatorAssuranceLevel();
    record("seed", "admin TOTP enrolment (API)", "INFO",
      `factor ${en.data.id} verified; enrolment session aal=${aal.data?.currentLevel}; secret kept in memory only`);
    // The enrolment session is not the UI's session: drop it.
    await admin.auth.signOut();
  } else {
    if (!secret) {
      // Re-run against an existing seed: GoTrue keeps the factor secret in
      // auth.mfa_factors — read it back into memory, never into a file.
      secret = runSql(`SELECT secret FROM auth.mfa_factors WHERE id = '${verified[0].id}' AND status = 'verified';`).trim();
      if (!secret) throw new Error("could not read the QA admin's TOTP secret back from auth.mfa_factors");
    }
    await admin.auth.signOut();
  }

  process.env.E2E_QA_STATE = JSON.stringify(state);
  process.env.E2E_QA_PASSWORD = password;
  process.env.E2E_QA_TOTP_SECRET = secret;
  process.stdout.write(`[e2e] QA tenant ts=${ts} shop=${state.ids.shop} (reuse with E2E_QA_TS=${ts})\n`);
}
