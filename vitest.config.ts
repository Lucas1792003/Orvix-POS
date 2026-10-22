// vitest reads this file instead of vite.config.ts when both exist; the app
// config is merged in so plugins/base stay identical to the real build.
// `setupFiles` installs the hosted-backend guard and pins the backend env
// for every test file — see src/test/setup.ts.
import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default defineConfig((env) =>
  mergeConfig(viteConfig(env), {
    test: {
      setupFiles: ["./src/test/setup.ts"],
      // tools/m086-verify/results/<run>/legacy-app: a full checkout of an older
      // build, run only by tools/m086-verify/run.sh inside that checkout.
      // tools/m087-verify/browser: Playwright specs run by tools/m087-verify/run.sh, not unit tests.
      // tools/recovery-v1/*.test.mjs: node:test suites, run by `node --test` (docs/recovery-v1/backup-readiness.md).
      exclude: [...configDefaults.exclude, "tools/m086-verify/results/**", "tools/m087-verify/browser/**", "tools/m087-verify/results/**", "tools/recovery-v1/**/*.test.mjs"],
    },
  }),
);
