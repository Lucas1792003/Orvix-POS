// Order-independence check for the e2e suite: the same specs, setup and
// teardown as playwright.config.ts, but run in REVERSE file order
// (f -> e -> d -> c -> b -> a). Playwright always runs files of one project
// in path order, so each spec is its own project and a dependency chain
// fixes the order. Run: `npm run e2e -- --config playwright.reverse.config.ts`
// (same env as `npm run e2e`, see e2e/README.md).
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const specs = [
  "f-queue-export",
  "e-consistency-gate",
  "d-phone-upload",
  "c-offline-auth",
  "b-failures",
  "a-workflows",
];

export default defineConfig({
  ...base,
  projects: specs.map((name, i) => ({
    name,
    testMatch: new RegExp(`${name}\\.e2e\\.ts$`),
    dependencies: i === 0 ? [] : [specs[i - 1]],
  })),
});
