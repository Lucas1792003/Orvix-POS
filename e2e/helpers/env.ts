// Environment for the Phase E run. Secrets (anon/service keys, QA
// password, QA TOTP secret) live in process.env only — never in files.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requiredEnv, type LiveConfig } from "../../src/live/liveHelpers";
import { assertNotHostedUrl } from "../../src/test/hostedGuard";

// package.json is "type": "module", so Playwright loads these as ESM.
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RESULTS_DIR = path.join(PROJECT_ROOT, "e2e", ".results");
export const DEV_PORT = Number(process.env.E2E_DEV_PORT ?? 5179);
export const DEV_SERVER_URL = `http://localhost:${DEV_PORT}`;

export function liveCfg(): LiveConfig {
  const url = process.env.E2E_SUPABASE_URL;
  const anonKey = process.env.E2E_ANON_KEY;
  const serviceKey = process.env.E2E_SERVICE_KEY;
  if (!url || !anonKey || !serviceKey) {
    throw new Error("E2E_SUPABASE_URL, E2E_ANON_KEY and E2E_SERVICE_KEY must be set (see e2e/README.md)");
  }
  // The suite is for the self-hosted stack only — never the hosted project.
  assertNotHostedUrl(url, "the e2e run (E2E_SUPABASE_URL)");
  return {
    url: url.replace(/\/$/, ""),
    anonKey,
    serviceKey,
    // No defaults: deployment-specific, must come from the environment.
    sshHost: requiredEnv("E2E_SSH_HOST"),
    stackDir: requiredEnv("E2E_STACK_DIR"),
  };
}

/** Glob matching every request to the Supabase origin (REST, auth, storage). */
export function supabaseGlob(): string {
  return `${liveCfg().url}/**`;
}

export function ensureResultsDir(): string {
  mkdirSync(path.join(RESULTS_DIR, "artifacts"), { recursive: true });
  return RESULTS_DIR;
}

/** Non-secret QA tenant facts, created by global-setup and handed to the
 *  specs through process.env (Playwright forwards globalSetup's env to the
 *  workers). */
export interface QaState {
  ts: string;
  ids: {
    org: string; shop: string; shop2: string; shopCode: string; shop2Code: string;
    admin: string; mgr: string; cashA: string; cashB: string;
    prod1: string; prod2: string; prod3: string;
    unit1: string; unit2: string; unit3: string;
    sup: string; barcode1: string;
  };
  emails: { admin: string; mgr: string; cashA: string; cashB: string };
  authIds: { admin: string; mgr: string; cashA: string; cashB: string };
  barcodeValue: string;
  /** Seeded on-hand per shop x product (the "initial" of inventory = initial + sum(movements)). */
  initialInventory: { shopId: string; productId: string; qty: number }[];
}

export function qaState(): QaState {
  const raw = process.env.E2E_QA_STATE;
  if (!raw) throw new Error("E2E_QA_STATE missing — global-setup did not run");
  return JSON.parse(raw) as QaState;
}

export function qaPassword(): string {
  const v = process.env.E2E_QA_PASSWORD;
  if (!v) throw new Error("E2E_QA_PASSWORD missing");
  return v;
}

export function qaTotpSecret(): string {
  const v = process.env.E2E_QA_TOTP_SECRET;
  if (!v) throw new Error("E2E_QA_TOTP_SECRET missing");
  return v;
}

export function buildQaState(ts: string, authIds: QaState["authIds"]): QaState {
  const ids = {
    org: `qa-org-${ts}`, shop: `qa-shop-${ts}`, shop2: `qa-shop2-${ts}`, shopCode: `QA${ts}`, shop2Code: `QB${ts}`,
    admin: `qa-user-admin-${ts}`, mgr: `qa-user-manager-${ts}`,
    cashA: `qa-user-cashier-a-${ts}`, cashB: `qa-user-cashier-b-${ts}`,
    prod1: `qa-prod-1-${ts}`, prod2: `qa-prod-2-${ts}`, prod3: `qa-prod-3-${ts}`,
    unit1: `qa-unit-1-${ts}`, unit2: `qa-unit-2-${ts}`, unit3: `qa-unit-3-${ts}`,
    sup: `qa-sup-${ts}`, barcode1: `qa-bc-1-${ts}`,
  };
  return {
    ts,
    ids,
    emails: {
      admin: `qa-admin-${ts}@qa.invalid`, mgr: `qa-manager-${ts}@qa.invalid`,
      cashA: `qa-cashier-a-${ts}@qa.invalid`, cashB: `qa-cashier-b-${ts}@qa.invalid`,
    },
    authIds,
    barcodeValue: `QABC1${ts}`,
    initialInventory: [
      { shopId: ids.shop, productId: ids.prod1, qty: 100 },
      { shopId: ids.shop, productId: ids.prod2, qty: 100 },
      { shopId: ids.shop, productId: ids.prod3, qty: 100 },
      { shopId: ids.shop2, productId: ids.prod1, qty: 50 },
      { shopId: ids.shop2, productId: ids.prod2, qty: 50 },
      { shopId: ids.shop2, productId: ids.prod3, qty: 50 },
    ],
  };
}
