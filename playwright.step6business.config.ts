// Step 6: full business workflows (cashier, manager, refunds, cash, reports) on the complete local system with Recovery V1
// (tools/recovery-v1/step6/run-integration.sh). Same shape as playwright.m087client.config.ts. Keys from the environment only.
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_DEV_PORT ?? 5187);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  testMatch: /step6-business\.e2e\.ts$/,
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
