// Phase E end-to-end verification (docs/selfhost-migration/phase-e/).
//
// Drives the real Electron app (electron/main.cjs, ORVIX_POS_E2E=1) and a
// second "terminal" (a Chromium page) against ONE Vite dev server that is
// pointed at the self-hosted Supabase stack. The stack URL and anon key come
// from the environment only (E2E_SUPABASE_URL / E2E_ANON_KEY; the service
// key, E2E_SERVICE_KEY, is used by the test helpers for DB-side evidence) —
// nothing is written into .env files. Specs live in e2e/*.e2e.ts (vitest's
// default include pattern ignores the .e2e.ts suffix, so `npm test` is
// unaffected). Run: see e2e/README.md.
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_DEV_PORT ?? 5179);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.e2e\.ts$/,
  outputDir: "e2e/.results/artifacts",
  // One Electron app (single-instance lock) and a shared QA tenant: specs
  // run one at a time, in file order, tests within a file in order.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  // No JSON reporter and no traces by default: both serialise the dev-server
  // env / request headers (the anon key, QA bearer tokens) into files under
  // e2e/.results. The evidence ledger (helpers/evidence.ts) holds no secrets.
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: BASE_URL,
    trace: "off",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 90_000,
    env: {
      VITE_SUPABASE_URL: process.env.E2E_SUPABASE_URL ?? "",
      VITE_SUPABASE_ANON_KEY: process.env.E2E_ANON_KEY ?? "",
    },
  },
});
