// Recovery V1 Step 5: the real Electron app — device enrollment, owner-signed reopening, aggregate offline budgets — on the DISPOSABLE loopback stack
// (tools/recovery-v1/step5/run-electron.sh). Same shape as playwright.m087client.config.ts. Keys from the environment only.
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_DEV_PORT ?? 5183);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  testMatch: /step5-.*\.e2e\.ts$/,
  outputDir: "e2e/.results/artifacts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 600_000,
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
