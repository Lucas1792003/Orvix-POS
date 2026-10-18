import { readFileSync } from 'node:fs'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { resolveBackendConfig } from './src/lib/backendConfig'
import { assertElectronPhoneUploadOrigin } from './src/lib/phoneUploadOrigin'

// The app version shown on the login page / sidebar and sent in the
// X-Client-Info header (src/lib/clientInfo.ts) comes from package.json, the
// same value electron-builder stamps into the installer and app.getVersion().
const APP_VERSION: string = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  // Fail closed at BUILD time as well as at startup (src/lib/supabase.ts):
  // a production bundle must never be produced against a backend other
  // than the one it is pinned to. `loadEnv` sees .env* files and the shell
  // alike, exactly what import.meta.env will be inlined from. Only enforced
  // when VITE_SUPABASE_EXPECTED_HOST is set (the Electron build sets it —
  // see deploy/lucashome/README.md); a plain `vite build` / `vite` / vitest
  // run without it is unaffected, and so is a dev server for which the
  // runtime check in src/lib/supabase.ts still applies.
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  if (env.VITE_SUPABASE_EXPECTED_HOST?.trim()) {
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

  // Electron build (RC2, D4): the main process verifies the owner for the
  // updater's recovery path against the SAME pinned backend, reading its
  // origin and the public anon key (both already inlined in the bundle)
  // from dist/backend.json — never from the renderer (electron/ownerVerify.cjs).
  const electronBackendFile = {
    name: 'electron-backend-json',
    apply: 'build' as const,
    generateBundle(this: { emitFile: (f: { type: 'asset'; fileName: string; source: string }) => void }) {
      if (process.env.ELECTRON_BUILD !== 'true') return
      const cfg = resolveBackendConfig(env)
      this.emitFile({ type: 'asset', fileName: 'backend.json', source: `${JSON.stringify({ url: cfg.url, anonKey: cfg.anonKey })}\n` })
    },
  }

  return {
    plugins: [react(), electronBackendFile],
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
    },
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
    // Dev server only, opt-in (tools/m086-verify Chromium runs): a same-origin
    // proxy to the disposable LOOPBACK stack's gateway (E2E_API_GATEWAY), so the
    // app makes no cross-origin calls. Refuses any non-loopback target. Unset
    // (every normal dev run and every build): no effect.
    server: process.env.E2E_API_GATEWAY ? (() => {
      const target = process.env.E2E_API_GATEWAY as string
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(target)) throw new Error('E2E_API_GATEWAY must be http://127.0.0.1:<port>')
      const p = { target, changeOrigin: true, ws: true }
      return { host: 'localhost', proxy: { '/auth/v1': p, '/rest/v1': p, '/realtime/v1': p, '/storage/v1': p, '/functions/v1': p } }
    })() : undefined,
  }
})
