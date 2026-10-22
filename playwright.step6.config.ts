// Step 6: REAL POS <-> Control integration — the Electron till, the Control console (Chromium) and the network bridge — on the DISPOSABLE loopback stack
// (tools/recovery-v1/step6/run-integration.sh). Same shape as playwright.m087client.config.ts. Keys from the environment only.
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_DEV_PORT ?? 5185);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  testMatch: /step6-integration\.e2e\.ts$/,
  outputDir: "e2e/.results/artifacts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 900_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: { baseURL: BASE_URL, trace: "off", screenshot: "only-on-failure" },
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
