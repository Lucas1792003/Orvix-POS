/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Phase F (docs/selfhost-migration/phase-f/staff-creation.md): the self-hosted
// backend runs GoTrue with DISABLE_SIGNUP=true. Every auth account is created
// server-side (staff-admin Edge Function, GoTrue admin API). This guard fails
// the unit suite if any app, e2e or live-test source calls the public sign-up
// API again — `auth.signUp(` on a supabase client, or a hand-built request to
// GoTrue's `/signup` endpoint.
//
// Exempt: this file; the live suite that PROVES sign-up is refused (it calls
// /auth/v1/signup on purpose and expects an error); the hosted-guard test.

const ROOT = path.resolve(__dirname, "..", "..");
const SCAN = ["src", "e2e", "electron"];
const EXEMPT = new Set([
  path.join("src", "test", "noPublicSignUp.test.ts"),
  path.join("src", "live", "phase-f-staff.live.test.ts"),
  // uses a hosted /signup URL only to prove the hosted-backend guard throws
  path.join("src", "test", "hostedGuard.test.ts"),
]);
const SIGNUP_CALL = /\bauth\s*\.\s*signUp\s*\(/;
const SIGNUP_ENDPOINT = /auth\/v1\/signup/;

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name)) out.push(full);
  }
  return out;
};

describe("no public sign-up anywhere in the app", () => {
  const files = SCAN.flatMap((d) => {
    try { return walk(path.join(ROOT, d)); } catch { return []; }
  });

  it("scans a meaningful number of files", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no source file calls auth.signUp( or the /auth/v1/signup endpoint", () => {
    const offenders = files
      .filter((f) => !EXEMPT.has(path.relative(ROOT, f)))
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        return SIGNUP_CALL.test(text) || SIGNUP_ENDPOINT.test(text);
      })
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("staff creation and first-time setup go through the staff-admin function", () => {
    const shopSlice = readFileSync(path.join(ROOT, "src/stores/data/slices/shopSlice.ts"), "utf8");
    expect(shopSlice).toMatch(/createStaffAccount\(/);
    const authStore = readFileSync(path.join(ROOT, "src/stores/authStore.ts"), "utf8");
    expect(authStore).toMatch(/createBootstrapAccount\(/);
    const usersPage = readFileSync(path.join(ROOT, "src/pages/UsersPage.tsx"), "utf8");
    expect(usersPage).not.toMatch(/setSession\(/);
  });
});
