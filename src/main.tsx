import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import "./index.css";
import "./print/receipt.css";
import "./print/labels.css";
// Side-effecting import: applies the persisted/system theme to <html>
// before React mounts — see stores/themeStore.ts.
import "./stores/themeStore";

// BrowserRouter's pushState sets an absolute path (e.g. "/app/dashboard"),
// which is fine for the web deploy (a real https:// origin) but breaks
// under Electron's file:// loading: pushState replaces the ENTIRE path
// portion of a file:// URL, so location.href goes from
// "file:///.../app.asar/dist/index.html" to "file:///app/dashboard" —
// losing the "dist/" (and even "app.asar") prefix. Any relative asset
// referenced after that first navigation (e.g. the sidebar logo, which
// only mounts once logged in) then resolves against the wrong location
// and 404s, even though the initial JS/CSS bundle loaded fine (it was
// fetched once, before any navigation happened). HashRouter only touches
// the URL fragment, so the file:// path never changes.
const Router = window.electronAPI?.isElectron ? HashRouter : BrowserRouter;

const root = ReactDOM.createRoot(document.getElementById("root")!);

// A backend configuration error (src/lib/backendConfig.ts: missing
// VITE_SUPABASE_URL/ANON_KEY, or a host other than the one this build is
// pinned to) throws while src/lib/supabase.ts is evaluated — i.e. while
// the app's module graph is being imported. That must be visible on the
// till, not a blank window with a console line, so the app is imported
// here and the failure rendered as a plain error screen.
function renderFatal(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error("[boot] The app cannot start:", err);
  root.render(
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div role="alert" style={{ maxWidth: 560, fontFamily: "system-ui, sans-serif" }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>The app cannot start</h1>
        <p style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{message}</p>
      </div>
    </div>,
  );
}

async function boot(): Promise<void> {
  const [{ default: App }, { useAuthStore }] = await Promise.all([
    import("./App"),
    import("./stores/authStore"),
  ]);

  // Restore Supabase session on app start
  void useAuthStore.getState().restoreSession();

  root.render(
    <React.StrictMode>
      <Router>
        <App />
      </Router>
    </React.StrictMode>,
  );
}

boot().catch(renderFatal);
