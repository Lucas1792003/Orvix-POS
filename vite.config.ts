import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { resolveBackendConfig } from './src/lib/backendConfig'
import { assertElectronPhoneUploadOrigin } from './src/lib/phoneUploadOrigin'

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  // Fail closed at BUILD time as well as at startup (src/lib/supabase.ts):
  // a production bundle must never be produced against a backend other
  // than the one it is pinned to. `loadEnv` sees .env* files and the shell
  // alike, exactly what import.meta.env will be inlined from.
  //
  // Every `vite build` (web and Electron alike, whatever --mode) REQUIRES
  // VITE_SUPABASE_EXPECTED_HOST and refuses to build unless the host of
  // VITE_SUPABASE_URL equals it exactly. A CI/hosting build that only has
  // VITE_SUPABASE_URL configured therefore fails instead of publishing a
  // bundle pointed at an unreviewed backend. See docs/deployment-safety.md.
  //
  // The dev server (`vite`) and vitest are not builds: the pin stays
  // optional there, and the runtime check in src/lib/supabase.ts applies.
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  if (command === 'build' && !env.VITE_SUPABASE_EXPECTED_HOST?.trim()) {
    throw new Error(
      '[build] Refusing to build: VITE_SUPABASE_EXPECTED_HOST is not set. ' +
      'Every production build must pin its backend host; set it to the host of ' +
      'VITE_SUPABASE_URL (see .env.example and docs/deployment-safety.md).',
    )
  }
  if (command === 'build' || env.VITE_SUPABASE_EXPECTED_HOST?.trim()) {
    try {
      resolveBackendConfig(env)
    } catch (err) {
      throw new Error(`[${command}] ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // Electron build: the packaged app runs from file://, so the phone-upload
  // QR points at the backend-served phone page (phone-upload-page function)
  // on the VITE_SUPABASE_URL origin. Refuse to build a till whose phone
  // origin is missing, not https, or loopback (a phone could not open it).
  // docs/selfhost-migration/phase-f/phone-qr-origin.md
  if (process.env.ELECTRON_BUILD === 'true') {
    try {
      assertElectronPhoneUploadOrigin(env)
    } catch (err) {
      throw new Error(`[${command}] Electron build: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    plugins: [react()],
    // The web build (Vercel) needs absolute asset paths ("/assets/...", the
    // default) — vercel.json rewrites every path to index.html, and a
    // relative path would resolve against whatever route the browser is on
    // (e.g. /app/pos), 404ing on refresh/deep-link instead of the real
    // domain-root assets.
    //
    // The Electron desktop build needs the OPPOSITE: relative paths
    // ("./assets/..."), because it loads dist/index.html via the file://
    // protocol, where an absolute "/assets/..." resolves against the
    // filesystem root, not the dist folder — script/CSS silently fail to
    // load, giving a blank white window. See package.json's
    // "electron:build:*" scripts, which set ELECTRON_BUILD=true.
    base: process.env.ELECTRON_BUILD === 'true' ? './' : '/',
  }
})
