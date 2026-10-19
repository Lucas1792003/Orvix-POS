// Migration 087: real Chromium proof that recovery refusals (HTTP 429) reach the page — never a CORS/network failure — through
// the prepared maintenance listener and the pinned upstream Envoy (tools/m087-verify/run.sh, part "browser"). URLs and the test
// JWT come from the environment only; no traces, no JSON reporter (they would serialise bearer tokens).
import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.M087_PAGE_PORT ?? 5187);
export default defineConfig({
  testDir: ".",
  testMatch: /m087-.*\.spec\.ts$/,
  outputDir: "../results/browser-artifacts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "off", screenshot: "off", browserName: "chromium", headless: true },
  webServer: { command: `python3 -I -m http.server ${PORT} --bind 127.0.0.1 --directory static`, url: `http://127.0.0.1:${PORT}/index.html`, reuseExistingServer: false, timeout: 30_000 },
});
