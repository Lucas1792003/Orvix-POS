// vitest reads this file instead of vite.config.ts when both exist; the app
// config is merged in so plugins/base stay identical to the real build.
// `setupFiles` installs the hosted-backend guard and pins the backend env
// for every test file — see src/test/setup.ts.
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default defineConfig((env) =>
  mergeConfig(viteConfig(env), {
    test: {
      setupFiles: ["./src/test/setup.ts"],
    },
  }),
);
