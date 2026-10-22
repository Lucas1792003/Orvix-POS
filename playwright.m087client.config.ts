// v87 client verification against migration 087 (tools/m087-client-verify/run.sh): the m087-client*.e2e.ts specs
// only, real Chromium and the real Electron app against ONE Vite dev server that proxies the Supabase API (same
// origin) to the DISPOSABLE loopback stack's gateway (E2E_API_GATEWAY). Keys from the environment only.
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_DEV_PORT ?? 5183);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  testMatch: /m087-client.*\.e2e\.ts$/,
  outputDir: "e2e/.results/artifacts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
  expect: { timeout: 30_000 },
  // No JSON reporter and no traces: both would serialise keys / bearer tokens.
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  // one action may not consume the whole 10-minute test (C4 hung on a single wait): fail fast with evidence
  use: { baseURL: BASE_URL, trace: "off", screenshot: "only-on-failure", actionTimeout: 60_000 },
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
