// Migration 086 verification in real Chromium (tools/m086-verify/run.sh).
//
// The m086-*.e2e.ts specs only, against ONE Vite dev server that proxies the
// Supabase API (same origin) to the DISPOSABLE loopback stack's gateway
// (E2E_API_GATEWAY). Keys come from the environment only (the stack's secrets
// file, loaded by run.sh — never printed, never written to .env files).
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_DEV_PORT ?? 5181);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  testMatch: /m086-.*\.e2e\.ts$/,
  outputDir: "e2e/.results/artifacts",
  // One shared QA tenant: specs run one at a time, in file order.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 20_000 },
  // No JSON reporter and no traces: both would serialise keys / bearer tokens.
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
      E2E_API_GATEWAY: process.env.E2E_API_GATEWAY ?? "",
      VITE_SUPABASE_ANON_KEY: process.env.E2E_ANON_KEY ?? "",
    },
  },
});
