/* eslint-disable @typescript-eslint/no-explicit-any */
// A "terminal" is one running copy of the POS UI: the real Electron app
// (terminal A, launched through Playwright's Electron support with the
// SHWE_POS_E2E hooks in electron/main.cjs) or a Chromium page on the same
// Vite dev server (terminal B — same renderer code; the only difference is
// the http origin instead of Electron's file:// origin and the absence of
// window.electronAPI). Both get their own IndexedDB/localStorage.
//
// Network failure injection never touches the stack: it is done with
// Playwright request interception on the Supabase origin only (the dev
// server stays reachable, as the bundled app's own files would be), plus a
// navigator.onLine override + online/offline events — which is exactly what
// the app keys its offline mode on.
import {
  _electron as electron, chromium, devices, expect,
  type Browser, type BrowserContext, type ElectronApplication, type Locator, type Page, type Request, type Route,
  type WebSocketRoute,
} from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DEV_SERVER_URL, PROJECT_ROOT, RESULTS_DIR, liveCfg, supabaseGlob } from "./env";
import { noteHostedRequest } from "./hostedGuard";
import { freshTotpCode } from "./totp";

export type TerminalKind = "electron" | "browser";

export interface OutboxRow {
  localId: string;
  kind: string;
  name: string;
  status: string;
  attempts: number;
  seq?: number;
  idempotencyKey?: string;
  lastError?: string;
  failureKind?: string;
  nextAttemptAt?: string;
  createdAt: string;
  args?: Record<string, unknown>;
  refs?: { field: string; provisionalId: string }[];
}

export interface AuthCacheRow {
  authId: string;
  userId: string;
  role: string;
  isActive: boolean;
  cachedAt: string;
}

export interface StoredSession {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
  expires_in?: number;
  user?: { id: string };
}

const OFFLINE_INIT = `Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });`;
// The UI defaults to Burmese when the OS looks like a Zawgyi system (this
// Mac does); the specs use the English strings, so each terminal pins the
// persisted language preference (stores/languageStore.ts) before the app boots.
// Debug aid: remember every persisted shop-selection write with its stack.
const SHOP_WRITE_SPY = `(() => { const orig = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k === "pos-app") { const w = window; w.__e2eShopWrites = [...(w.__e2eShopWrites ?? []), { v, at: Date.now(), stack: String(new Error().stack).split("\\n").slice(1, 6).join(" | ") }]; } return orig.call(this, k, v); }; })();`;
const LANG_INIT = `try { if (!localStorage.getItem("pos-language")) localStorage.setItem("pos-language", JSON.stringify({ state: { language: "en", isZawgyi: false }, version: 2 })); } catch (e) {}`;
const ONLINE_INIT = `try { delete navigator.onLine; } catch (e) {}`;

export interface RequestLogEntry { url: string; method: string; at: number; status?: number }

export class Terminal {
  readonly requests: RequestLogEntry[] = [];
  /** POST /rest/v1/rpc/<name> request bodies sent by the page (never written to disk). */
  readonly rpcBodies: { name: string; at: number; body: Record<string, unknown> | null }[] = [];
  /** URLs of requests that tried to reach *.supabase.co (always aborted). */
  readonly hostedRequests: string[] = [];
  /** console.error / console.warn lines from the renderer (diagnostics). */
  readonly consoleErrors: string[] = [];
  /** "[phone-upload]" console markers from the desktop QR modal (any level):
   *  every close request while a session is PENDING names its trigger
   *  (close-button / x-button / confirm-stop / escape / backdrop / unmount),
   *  the decision, isTrusted, visibility and focus (lib/phoneUploadClose.ts). */
  readonly phoneUploadMarkers: { at: number; text: string }[] = [];
  /** Realtime WebSocket frames received by the page (text, with timestamp). */
  readonly wsFrames: { at: number; text: string }[] = [];
  readonly wsEvents: string[] = [];
  private offline = false;

  private constructor(
    readonly kind: TerminalKind,
    readonly page: Page,
    readonly context: BrowserContext,
    readonly app?: ElectronApplication,
    readonly browser?: Browser,
    readonly userDataDir?: string,
  ) {
    page.on("request", (r: Request) => {
      this.requests.push({ url: r.url(), method: r.method(), at: Date.now() });
      // RPC bodies, in memory only (the consistency gate's terminal ledger:
      // which operation was sent under which idempotency key).
      const m = r.method() === "POST" ? /\/rest\/v1\/rpc\/([A-Za-z0-9_]+)/.exec(r.url()) : null;
      if (m) {
        let body: Record<string, unknown> | null = null;
        try { body = r.postDataJSON() as Record<string, unknown> | null; } catch { body = null; }
        this.rpcBodies.push({ name: m[1], at: Date.now(), body });
      }
    });
    page.on("websocket", (ws) => {
      if (!/realtime\/v1/.test(ws.url())) return;
      this.wsEvents.push(`${Date.now()} open`);
      ws.on("framereceived", (f) => this.wsFrames.push({ at: Date.now(), text: typeof f.payload === "string" ? f.payload : "" }));
      ws.on("framesent", (f) => this.wsEvents.push(`${Date.now()} sent ${String(f.payload).slice(0, 80)}`));
      ws.on("close", () => this.wsEvents.push(`${Date.now()} close`));
      ws.on("socketerror", (e) => this.wsEvents.push(`${Date.now()} error ${e}`));
    });
    page.on("console", (m) => { if (m.text().startsWith("[phone-upload]")) this.phoneUploadMarkers.push({ at: Date.now(), text: m.text().slice(0, 400) }); });
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") this.consoleErrors.push(`${new Date().toISOString()} ${m.type()}: ${m.text().slice(0, 300)}`); });
    // Hard guard: the hosted project must never be touched. Any request to
    // a *.supabase.co host (any scheme — Realtime's wss:// included) is
    // aborted, remembered, and turned into a failure of the run by
    // helpers/hostedGuard.ts (consistency gate + global-teardown); B12
    // asserts on it explicitly as well.
    void context.route(/^(https?|wss?):\/\/[^/]*\.supabase\.co(\/|$)/i, (route) => {
      const url = route.request().url();
      this.hostedRequests.push(url);
      noteHostedRequest(url, kind);
      void route.abort("blockedbyclient");
    });
    page.on("response", (res) => {
      const entry = [...this.requests].reverse().find((e) => e.url === res.url() && e.status === undefined);
      if (entry) entry.status = res.status();
    });
  }

  /** Launch the real Electron app. `userDataDir` isolates its storage; pass
   *  the same dir again to "relaunch the same till". */
  /** Set by launchElectron({ holdRpc }): releases the held RPC requests. */
  releaseRpcHold: () => void = () => undefined;

  static async launchElectron(userDataDir: string, options: { offline?: boolean; holdRpc?: string } = {}): Promise<Terminal> {
    mkdirSync(userDataDir, { recursive: true });
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      VITE_DEV_SERVER_URL: DEV_SERVER_URL,
      SHWE_POS_E2E: "1",
      SHWE_POS_E2E_USER_DATA: userDataDir,
    };
    // This shell (Claude Code) exports ELECTRON_RUN_AS_NODE=1, which turns
    // the Electron binary into plain Node and makes it reject Chromium's
    // --remote-debugging-port. Never inherit it.
    delete env.ELECTRON_RUN_AS_NODE;
    // Keep the renderer running at full speed when the window is hidden or
    // occluded (e.g. the Mac's display sleeps mid-run): Chromium otherwise
    // stops animation frames for it and Playwright's actionability checks
    // ("stable") never complete — seen 2026-10-14, a click hanging until the
    // test timeout right after "Display is turned off". Playwright passes
    // these to its own Chromium by default, but not to Electron.
    const app = await electron.launch({
      args: ["--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-background-timer-throttling", "."],
      cwd: PROJECT_ROOT, env,
    });
    const context = app.context();
    await context.addInitScript(LANG_INIT);
    await context.addInitScript(SHOP_WRITE_SPY);
    if (options.offline) {
      // Registered before the window exists so the very first requests of
      // the boot are already cut (restart-while-offline scenario).
      await context.route(supabaseGlob(), (route) => route.abort("internetdisconnected"));
      await context.addInitScript(OFFLINE_INIT);
    }
    // holdRpc: an ONLINE boot whose calls to one RPC (e.g. the outbox drain's
    // complete_sale) are parked until releaseRpcHold(), so a spec can observe
    // the persisted state before the boot-time drain empties it. Registered
    // before the window exists; every other request flows normally.
    let release: () => void = () => undefined;
    if (options.holdRpc) {
      const gate = new Promise<void>((resolve) => { release = resolve; });
      await context.route(`${liveCfg().url}/rest/v1/rpc/${options.holdRpc}`, async (route) => {
        await gate;
        await route.continue().catch(() => undefined);
      });
    }
    const page = await app.firstWindow();
    const t = new Terminal("electron", page, context, app, undefined, userDataDir);
    t.offline = Boolean(options.offline);
    t.releaseRpcHold = () => release();
    await page.waitForLoadState("domcontentloaded");
    await t.ensureEnglish();
    return t;
  }

  /** The second terminal: a headed Chromium page on the same dev server. */
  static async launchBrowser(options: { headless?: boolean } = {}): Promise<Terminal> {
    const browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    await context.addInitScript(LANG_INIT);
    await context.addInitScript(SHOP_WRITE_SPY);
    const page = await context.newPage();
    return new Terminal("browser", page, context, undefined, browser);
  }

  /** A phone: Chromium with an iPhone 13 profile (viewport, DPR, touch,
   *  mobile UA). Used for the anonymous QR upload page. Same hosted guard. */
  static async launchPhone(options: { headless?: boolean } = {}): Promise<Terminal> {
    const { defaultBrowserType: _ignored, ...iphone } = devices["iPhone 13"];
    void _ignored;
    const browser = await chromium.launch({ headless: options.headless ?? true });
    const context = await browser.newContext({ ...iphone });
    // The phone page is bilingual since 081's page change and follows the app's
    // persisted language (default Myanmar); the specs assert the English text.
    await context.addInitScript(LANG_INIT);
    const page = await context.newPage();
    return new Terminal("browser", page, context, undefined, browser);
  }

  /** The first window may have booted before the init script was attached. */
  async ensureEnglish(): Promise<void> {
    const lang = await this.page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem("pos-language") ?? "null")?.state?.language ?? null; } catch { return null; }
    });
    if (lang === "en") return;
    await this.page.evaluate(() => {
      localStorage.setItem("pos-language", JSON.stringify({ state: { language: "en", isZawgyi: false }, version: 2 }));
    });
    await this.reload();
  }

  async close(): Promise<void> {
    try {
      if (this.app) await this.app.close();
      else if (this.browser) await this.browser.close();
    } catch {
      /* already gone */
    }
  }

  // ---- navigation -------------------------------------------------------

  url(route: string): string {
    return this.kind === "electron" ? `${DEV_SERVER_URL}/#${route}` : `${DEV_SERVER_URL}${route}`;
  }

  /** Full document load of a route (what a user typing the URL / a reload does). */
  async goto(route: string): Promise<void> {
    await this.page.goto(this.url(route));
    await this.page.waitForLoadState("domcontentloaded");
  }

  /** In-app navigation without a reload (Electron: hash change; browser:
   *  history push through the SPA router is not exposed, so goto). */
  async navigate(route: string): Promise<void> {
    if (this.kind === "electron") {
      await this.page.evaluate((r) => { window.location.hash = `#${r}`; }, route);
    } else {
      await this.goto(route);
    }
  }

  async reload(): Promise<void> {
    await this.page.reload();
    await this.page.waitForLoadState("domcontentloaded");
  }

  currentRoute(): string {
    const u = new URL(this.page.url());
    return this.kind === "electron" ? u.hash.replace(/^#/, "") : u.pathname;
  }

  async waitForRoute(prefix: string, timeout = 20_000): Promise<string> {
    await expect.poll(() => this.currentRoute(), { timeout }).toMatch(new RegExp(`^${prefix.replace(/\//g, "\\/")}`));
    return this.currentRoute();
  }

  /** The app shell (sidebar) is rendered once the data store has loaded. */
  async waitForApp(timeout = 60_000): Promise<void> {
    await this.page.locator("aside.sidebar").waitFor({ state: "visible", timeout });
  }

  // ---- auth flows -------------------------------------------------------

  async login(email: string, password: string): Promise<void> {
    await this.goto("/login");
    await this.page.locator('input[type="email"]').fill(email);
    await this.page.locator('input[type="password"]').fill(password);
    await this.page.getByRole("button", { name: "Sign in", exact: true }).click();
  }

  /** Setup sign-in (a spec's precondition, not the behaviour under test):
   *  sign in and wait for `routePrefix`. If the page reports "Failed to
   *  fetch" — the request never got an HTTP answer (a network blip between
   *  this Mac and the stack; seen once 2026-10-14 with no matching request
   *  in the gateway log) — sign in again, at most twice. Any answer from the
   *  server (wrong password, inactive user, ...) fails immediately. */
  async signIn(email: string, password: string, routePrefix: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      await this.login(email, password);
      const alert = this.page.locator('form [role="alert"]');
      const outcome = await Promise.race([
        this.waitForRoute(routePrefix, 30_000).then(() => "ok" as const, () => "timeout" as const),
        alert.waitFor({ state: "visible", timeout: 30_000 }).then(() => "alert" as const, () => "timeout" as const),
      ]);
      if (outcome === "ok") return;
      const text = outcome === "alert" ? (await alert.innerText()).replace(/\s+/g, " ").trim() : "(no alert)";
      if (outcome === "alert" && /Failed to fetch/i.test(text) && attempt < 3) {
        this.consoleErrors.push(`${new Date().toISOString()} e2e: sign-in attempt ${attempt} got "${text}", retrying`);
        await this.page.waitForTimeout(2_000);
        continue;
      }
      throw new Error(`sign-in as ${email} did not reach ${routePrefix}: ${outcome} ${text} (route ${this.currentRoute()})`);
    }
  }

  /** Read the login page's inline error (role=alert) if any. */
  async loginError(timeout = 10_000): Promise<string | null> {
    const alert = this.page.locator('form [role="alert"]');
    try {
      await alert.waitFor({ state: "visible", timeout });
      return (await alert.innerText()).trim();
    } catch {
      return null;
    }
  }

  /** The /verify page: type a 6-digit authenticator code and submit. */
  async submitVerifyCode(code: string): Promise<void> {
    const cells = this.page.locator('input[inputmode="numeric"][maxlength="1"]');
    await cells.first().waitFor({ state: "visible" });
    // Clear a previous (wrong) code first: Backspace from the last cell walks back.
    await cells.last().click();
    for (let i = 0; i < 7; i++) await this.page.keyboard.press("Backspace");
    await cells.first().click();
    await this.page.keyboard.type(code, { delay: 40 });
    const typed = (await cells.evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).join("");
    if (typed !== code) throw new Error(`verify cells hold "${typed}", expected the ${code.length}-digit code`);
    await this.page.getByRole("button", { name: "Verify", exact: true }).click();
  }

  async verifyError(timeout = 10_000): Promise<string | null> {
    const alert = this.page.locator('form [role="alert"]');
    try {
      await alert.waitFor({ state: "visible", timeout });
      return (await alert.innerText()).trim();
    } catch {
      return null;
    }
  }

  /** Full admin sign-in: password, then TOTP on /verify (a fresh code). */
  async loginAdminWithTotp(email: string, password: string, secret: string, notThisCode?: string): Promise<string> {
    await this.login(email, password);
    await this.waitForRoute("/verify");
    const code = await freshTotpCode(secret, notThisCode);
    await this.submitVerifyCode(code);
    const outcome = await Promise.race([
      expect.poll(() => this.currentRoute(), { timeout: 30_000 }).toMatch(/^\/app/).then(() => "app" as const),
      this.page.locator('form [role="alert"]').waitFor({ state: "visible", timeout: 30_000 }).then(() => "error" as const),
    ]);
    if (outcome === "error") {
      const text = (await this.page.locator('form [role="alert"]').innerText()).replace(/\s+/g, " ").trim();
      throw new Error(`admin verification failed: ${text} (route ${this.currentRoute()})`);
    }
    return code;
  }

  async logout(): Promise<void> {
    // Either the app shell (someone is signed in) or the login form settles first.
    const shell = this.page.locator("aside.sidebar button.footer-logout-icon");
    const loginForm = this.page.locator('input[type="email"]');
    const first = await Promise.race([
      shell.waitFor({ state: "visible", timeout: 30_000 }).then(() => "shell" as const),
      loginForm.waitFor({ state: "visible", timeout: 30_000 }).then(() => "login" as const),
    ]);
    if (first === "login") return; // nobody signed in on this terminal (subset re-run)
    await shell.click();
    await this.waitForRoute("/login");
    // The sidebar navigates before the async sign-out finishes; wait for the
    // stored session to be gone so the next sign-in cannot race its tail.
    await expect.poll(() => this.storedSession().then((s) => s === null), { timeout: 15_000 }).toBe(true);
    await this.page.waitForTimeout(300);
  }

  // ---- UI flows ---------------------------------------------------------

  /** Wait for a toast (title or description) containing `text`. Toasts
   *  auto-dismiss after ~3 s, so the default timeout is deliberately short
   *  for things expected soon after an action. */
  private async toastTexts(text: string | RegExp, onlyFresh = false): Promise<string[]> {
    const items = this.page.locator(onlyFresh ? ".fixed.right-6.top-6 > div:not([data-e2e-seen])" : ".fixed.right-6.top-6 > div");
    const all = await items.allInnerTexts().catch(() => [] as string[]);
    const norm = all.map((t) => t.replace(/\s+/g, " ").trim());
    return norm.filter((t) => (typeof text === "string" ? t.includes(text) : text.test(t)));
  }

  /** Wait for a toast (title or description) containing `text` that
   *  appeared after the last `toastsNow()` call — a toast lives ~3 s and its
   *  timer is re-armed by every later toast, so a stale one with the very
   *  same text can still be on screen. Returns its full text. */
  /**
   * RC2 (audit D1): the owner's way to take a conflict out of the queue
   * without deleting it — export this session's queue first (native save
   * dialog stubbed), then "Set aside" the matching row and confirm. The row
   * stays on the till (status "archived", same key/payload). Electron only.
   */
  async exportAndSetAside(rowText: string | RegExp, exportFile: string, passphrase: string): Promise<string> {
    if (!this.app) throw new Error("exportAndSetAside needs the Electron terminal");
    await this.app.evaluate(({ dialog }, file) => {
      (dialog as any).showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, exportFile);
    await this.page.getByTestId("export-queue-open").click();
    await this.page.getByTestId("queue-export-passphrase").fill(passphrase);
    await this.page.getByTestId("queue-export-passphrase-confirm").fill(passphrase);
    await this.page.getByTestId("queue-export-submit").click();
    await this.page.getByTestId("queue-export-result").waitFor({ state: "visible", timeout: 60_000 });
    await this.page.getByTestId("queue-export-close").click();
    const row = this.page.getByTestId("outbox-row").filter({ hasText: rowText });
    await row.getByTestId("outbox-set-aside").click();
    await this.page.getByTestId("set-aside-confirm").click();
    return this.toast("Set aside (not deleted)");
  }

  async toast(text: string | RegExp, timeout = 15_000): Promise<string> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const fresh = await this.toastTexts(text, true);
      if (fresh.length) return fresh[fresh.length - 1];
      if (Date.now() > deadline) throw new Error(`toast matching ${String(text)} not seen within ${timeout} ms`);
      await this.page.waitForTimeout(100);
    }
  }

  /** Mark every toast currently on screen as already seen (so the next
   *  toast() only accepts newer ones). Returns their texts. */
  async toastsNow(): Promise<string[]> {
    await this.page.evaluate(() => {
      document.querySelectorAll(".fixed.right-6.top-6 > div").forEach((el) => { (el as HTMLElement).dataset.e2eSeen = "1"; });
    }).catch(() => undefined);
    return this.toastTexts(/./);
  }

  async selectShop(shopId: string): Promise<void> {
    await this.page.locator("select.shop-select").selectOption(shopId);
  }

  async openShift(openingCash: number): Promise<void> {
    await this.navigate("/app/shifts");
    await this.page.locator("#opening-cash, #own-shift-closing-cash").first().waitFor({ state: "visible" });
    if (await this.page.locator("#own-shift-closing-cash").isVisible()) return; // already open (re-run)
    await this.page.locator("#opening-cash").fill(String(openingCash));
    await this.toastsNow();
    await this.page.getByRole("button", { name: "Start shift", exact: true }).click();
    await this.toast("Shift opened");
  }

  /** The "Expected cash" figure the Shifts page shows for the open shift. */
  async expectedCashShown(): Promise<number> {
    await this.navigate("/app/shifts");
    return this.readExpectedCash();
  }

  /** Read the "Expected cash" figure on the current Shifts page (no navigation). */
  private async readExpectedCash(): Promise<number> {
    const label = this.page.locator("main div", { hasText: /^Expected cash$/ }).first();
    await label.waitFor({ state: "visible" });
    const value = await label.locator("xpath=following-sibling::div[1]").innerText();
    return Number(value.replace(/[^\d]/g, ""));
  }

  /** Close the open shift. Returns the inline error (variance gate) or null on success.
   *
   *  Whether a variance reason is needed is decided from the figures, not
   *  guessed: the Shifts page renders #own-shift-variance-reason only when
   *  counted cash != the expected cash it shows. The expected figure is read
   *  until it is stable (the store may still be merging sales), then:
   *    - variance != 0 and a reason is given  -> the box must appear; it is filled;
   *    - variance != 0 and no reason          -> nothing filled (the gate's error is returned);
   *    - variance == 0                        -> the box must NOT be shown; a reason
   *      passed by the caller is not applicable and is ignored. */
  async closeShift(closingCash: number, reason?: string): Promise<string | null> {
    await this.navigate("/app/shifts");
    const cash = this.page.locator("#own-shift-closing-cash");
    await cash.waitFor({ state: "visible" });
    await cash.fill(String(closingCash));
    await cash.blur();
    let expected = await this.readExpectedCash();
    for (let stableSince = Date.now(); Date.now() - stableSince < 750;) {
      await this.page.waitForTimeout(150);
      const now = await this.readExpectedCash();
      if (now !== expected) { expected = now; stableSince = Date.now(); }
    }
    const reasonBox = this.page.locator("#own-shift-variance-reason");
    if (closingCash !== expected) {
      await reasonBox.waitFor({ state: "visible" });
      if (reason !== undefined) await reasonBox.fill(reason);
    } else {
      await reasonBox.waitFor({ state: "hidden" });
    }
    await this.toastsNow();
    await this.page.getByRole("button", { name: "End shift", exact: true }).click();
    const err = this.page.locator("main div.text-rose-700", { hasText: "Enter a variance reason before ending the shift." }).first();
    const fresh = this.page.locator(".fixed.right-6.top-6 > div:not([data-e2e-seen])");
    const closed = fresh.getByText("Shift closed");
    const refused = fresh.filter({ hasText: "Could not close shift" });
    const winner = await Promise.race([
      err.waitFor({ state: "visible", timeout: 15_000 }).then(() => "error" as const),
      closed.waitFor({ state: "visible", timeout: 15_000 }).then(() => "closed" as const),
      refused.first().waitFor({ state: "visible", timeout: 15_000 }).then(() => "refused" as const),
    ]);
    if (winner === "error") return (await err.innerText()).trim();
    if (winner === "refused") return (await refused.first().innerText()).replace(/\s+/g, " ").trim();
    return null;
  }

  async gotoPos(): Promise<void> {
    await this.navigate("/app/pos");
    // An ADMIN with no shop selected gets the "No shop selected" card instead of the POS heading.
    await this.page.getByRole("heading", { name: /Point of Sale|No shop selected/ }).first().waitFor({ state: "visible" });
  }

  async shopWrites(): Promise<unknown[]> {
    return this.page.evaluate(() => (window as any).__e2eShopWrites ?? []);
  }

  /** Barcode mode (F4) + keyboard-wedge style input: the scanner "types"
   *  the code and sends Enter. */
  async posScan(barcode: string): Promise<void> {
    const input = this.page.locator('input[placeholder="Scan or enter barcode..."]');
    if (!(await input.isVisible())) {
      await this.page.keyboard.press("F4");
      await input.waitFor({ state: "visible" });
    }
    await input.focus();
    await this.toastsNow();
    await this.page.keyboard.type(barcode, { delay: 5 });
    await this.page.keyboard.press("Enter");
  }

  /** The cart is POS page state: leaving the page and coming back empties it. */
  async posClearCart(): Promise<void> {
    await this.navigate("/app/shifts");
    await this.page.waitForTimeout(300);
    await this.gotoPos();
  }

  async posAddByCard(productName: string): Promise<void> {
    await this.page.getByRole("button", { name: `Add ${productName}`, exact: true }).first().click();
  }

  /** Stock badge text on a POS product card ("N in stock" / "a of N left"). */
  async posStockText(productName: string): Promise<string> {
    const card = this.page.getByRole("button", { name: `Add ${productName}`, exact: true }).first();
    return (await card.locator("span.rounded-full.bg-black\\/60").innerText()).trim();
  }

  /** F2 (or F3 = save + print) → payment modal → amount → Enter. Resolves
   *  with the receipt number from the "Sale recorded" toast ("PENDING" when
   *  queued offline). */
  async posCheckout(paid: number, options: { print?: boolean } = {}): Promise<{ receiptNo: string; toast: string }> {
    await this.page.keyboard.press(options.print ? "F3" : "F2");
    const amount = this.page.getByLabel("Amount received");
    await amount.waitFor({ state: "visible" });
    // PaymentModal stays mounted between sales and resets "Amount received"
    // to "0" in a useEffect that runs AFTER the reopened modal is painted:
    // for a few ms it still shows the previous sale's amount, and a fill in
    // that window is wiped by the reset (seen 2026-10-12: input "1000" at
    // +12 ms, "0" right after fill). Wait for the reset before typing.
    await expect.poll(() => amount.inputValue(), { timeout: 5_000 }).toBe("0");
    await amount.fill(String(paid));
    await expect.poll(() => amount.inputValue(), { timeout: 5_000 }).toBe(String(paid));
    await this.toastsNow();
    await amount.press("Enter");
    const toast = await this.toast(/Sale recorded/, 60_000);
    const m = toast.match(/Receipt (\S+)/);
    return { receiptNo: m?.[1] ?? "", toast };
  }

  /** Same as posCheckout but expects the checkout to be refused. */
  async posCheckoutExpectFailure(paid: number): Promise<string> {
    await this.page.keyboard.press("F2");
    const amount = this.page.getByLabel("Amount received");
    await amount.waitFor({ state: "visible" });
    // PaymentModal stays mounted between sales and resets "Amount received"
    // to "0" in a useEffect that runs AFTER the reopened modal is painted:
    // for a few ms it still shows the previous sale's amount, and a fill in
    // that window is wiped by the reset (seen 2026-10-12: input "1000" at
    // +12 ms, "0" right after fill). Wait for the reset before typing.
    await expect.poll(() => amount.inputValue(), { timeout: 5_000 }).toBe("0");
    await amount.fill(String(paid));
    await expect.poll(() => amount.inputValue(), { timeout: 5_000 }).toBe(String(paid));
    await this.toastsNow();
    await amount.press("Enter");
    const t = await this.toast(/Checkout failed|Payment blocked/, 60_000);
    await this.page.keyboard.press("Escape");
    return t;
  }

  // ---- network failure injection ---------------------------------------

  /** Cut / restore the Supabase origin for this terminal (see file header). */
  async setOffline(on: boolean): Promise<void> {
    if (on === this.offline) return;
    this.offline = on;
    if (on) {
      await this.page.route(supabaseGlob(), (route) => route.abort("internetdisconnected"));
      await this.page.addInitScript(OFFLINE_INIT);
      await this.page.evaluate(() => {
        Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
        window.dispatchEvent(new Event("offline"));
      });
    } else {
      await this.page.unroute(supabaseGlob());
      // A terminal launched offline registered the cut at context level.
      await this.context.unroute(supabaseGlob()).catch(() => undefined);
      await this.page.addInitScript(ONLINE_INIT);
      await this.page.evaluate(() => {
        try { delete (navigator as unknown as Record<string, unknown>).onLine; } catch { /* non-configurable */ }
        window.dispatchEvent(new Event("online"));
      });
    }
  }

  isOffline(): boolean {
    return this.offline;
  }

  /** Answer every request to `pathPart` with an HTTP `status` and body
   *  until `unroutePath` is called (e.g. 503 from the gateway, or a 503
   *  with PostgREST's own error body to simulate the database being away). */
  async routeStatus(pathPart: string, status: number, body: unknown, counter?: { hits: number }): Promise<string> {
    const glob = `${liveCfg().url}/**${pathPart}**`;
    await this.page.route(glob, (route: Route) => {
      if (counter) counter.hits++;
      void route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    });
    return glob;
  }

  async unroutePath(glob: string): Promise<void> {
    await this.page.unroute(glob);
  }

  /** Let the request reach the server, then drop the response ("commit then
   *  network cut"). Applies once per matching request; counts hits. */
  async routeCommitThenAbort(pathPart: string, counter: { hits: number; serverStatus?: number; cut?: number }): Promise<string> {
    const glob = `${liveCfg().url}/**${pathPart}**`;
    await this.page.route(glob, async (route: Route) => {
      counter.hits++;
      const res = await route.fetch();
      counter.serverStatus = res.status();
      // `cut` counts requests whose server answer is captured AND whose reply
      // was dropped: wait on it (not on hits) before unrouting
      await route.abort("connectionreset").catch(() => {});
      counter.cut = (counter.cut ?? 0) + 1;
    });
    return glob;
  }

  /** Resolves once Realtime has confirmed the postgres_changes subscription
   *  (the channel's "SUBSCRIBED" only acknowledges the join; the server's
   *  system message {extension: postgres_changes, status: ok} is what
   *  guarantees later changes are delivered — see the Phase D README). */
  async waitForRealtimeReady(since = 0, timeout = 30_000): Promise<number> {
    const t0 = Date.now();
    await expect.poll(
      () => this.wsFrames.some((f) => f.at >= since && /postgres_changes/.test(f.text) && /"status":"ok"/.test(f.text)),
      { timeout },
    ).toBe(true);
    return Date.now() - t0;
  }

  private realtimeCut = false;
  private realtimeProxyInstalled = false;
  private realtimeSockets: { ws: WebSocketRoute; server: WebSocketRoute }[] = [];

  /** Pass-through proxy for Realtime's WebSocket so the live socket can be
   *  cut (closed from the "network" side) and reconnects let through again.
   *  Only sockets opened after installation go through it — reload the page
   *  once after calling this. Frames are forwarded untouched. */
  async installRealtimeProxy(): Promise<void> {
    if (this.realtimeProxyInstalled) return;
    this.realtimeProxyInstalled = true;
    await this.page.routeWebSocket(/\/realtime\/v1\//, (ws) => {
      if (this.realtimeCut) {
        this.wsEvents.push(`${Date.now()} proxy: refused (cut)`);
        ws.close({ code: 1006, reason: "e2e: realtime cut" });
        return;
      }
      const server = ws.connectToServer();
      this.wsEvents.push(`${Date.now()} proxy: connected`);
      this.realtimeSockets.push({ ws, server });
    });
  }

  /** Cut Realtime (closes the live socket and refuses reconnects) / restore
   *  (the client's own reconnect backoff brings the channel back). */
  async blockRealtime(on: boolean): Promise<void> {
    if (!this.realtimeProxyInstalled) throw new Error("installRealtimeProxy() first (then reload the page)");
    this.realtimeCut = on;
    if (on) {
      for (const { ws, server } of this.realtimeSockets.splice(0)) {
        try { await server.close({ code: 1006, reason: "e2e: realtime cut" }); } catch { /* already closed */ }
        try { await ws.close({ code: 1006, reason: "e2e: realtime cut" }); } catch { /* already closed */ }
      }
    }
  }

  // ---- local state (IndexedDB / localStorage) --------------------------

  private async idbAll<T>(store: string): Promise<T[]> {
    return this.page.evaluate((storeName) => new Promise<T[]>((resolve, reject) => {
      const req = indexedDB.open("shwe-phala-local");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(storeName)) { db.close(); resolve([]); return; }
        const tx = db.transaction(storeName, "readonly");
        const r = tx.objectStore(storeName).getAll();
        r.onsuccess = () => { db.close(); resolve(r.result as T[]); };
        r.onerror = () => { db.close(); reject(r.error); };
      };
    }), store);
  }

  private async idbPut(store: string, value: unknown): Promise<void> {
    await this.page.evaluate(([storeName, v]) => new Promise<void>((resolve, reject) => {
      const req = indexedDB.open("shwe-phala-local");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(storeName as string, "readwrite");
        tx.objectStore(storeName as string).put(v);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
    }), [store, value] as const);
  }

  async outbox(): Promise<OutboxRow[]> {
    const rows = await this.idbAll<OutboxRow>("syncOutbox");
    return rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }

  async outboxPending(): Promise<OutboxRow[]> {
    return (await this.outbox()).filter((e) => e.status === "pending" || e.status === "syncing" || e.status === "failed");
  }

  async syncState(): Promise<{ key: string; flag?: boolean; reason?: string }[]> {
    return this.idbAll("syncState");
  }

  async authCache(): Promise<AuthCacheRow[]> {
    return this.idbAll<AuthCacheRow>("authCache");
  }

  /** Move the offline-authorisation clock: set cachedAt to `hoursAgo` hours
   *  before now on every cached auth row. */
  async setAuthCacheAge(hoursAgo: number): Promise<string> {
    const rows = await this.authCache();
    const cachedAt = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    for (const r of rows) await this.idbPut("authCache", { ...r, cachedAt });
    return cachedAt;
  }

  async localSales(): Promise<any[]> {
    return this.idbAll("sales");
  }

  async localSnapshotCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of ["products", "inventory", "shifts", "sales", "users", "shops"]) out[t] = (await this.idbAll(t)).length;
    return out;
  }

  private async sessionKey(): Promise<string | null> {
    return this.page.evaluate(() => Object.keys(localStorage).find((k) => /^sb-.*-auth-token$/.test(k)) ?? null);
  }

  async storedSession(): Promise<StoredSession | null> {
    const key = await this.sessionKey();
    if (!key) return null;
    return this.page.evaluate((k) => {
      const raw = localStorage.getItem(k);
      return raw ? (JSON.parse(raw) as StoredSession) : null;
    }, key);
  }

  async writeStoredSession(patch: Partial<StoredSession>): Promise<void> {
    const key = await this.sessionKey();
    if (!key) throw new Error("no stored supabase session");
    await this.page.evaluate(([k, p]) => {
      const raw = localStorage.getItem(k as string);
      if (!raw) throw new Error("no stored session");
      localStorage.setItem(k as string, JSON.stringify({ ...JSON.parse(raw), ...(p as object) }));
    }, [key, patch] as const);
  }

  /** Tamper the stored access token's signature and mark it expired, so the
   *  next sync must refresh before sending anything. Returns the tampered
   *  token's last 6 chars for evidence (never the token). */
  async tamperAccessToken(): Promise<string> {
    const s = await this.storedSession();
    if (!s?.access_token) throw new Error("no access token to tamper");
    const [h, p, sig] = s.access_token.split(".");
    const tamperedSig = sig.slice(0, -2) + (sig.endsWith("AA") ? "BB" : "AA");
    const tampered = `${h}.${p}.${tamperedSig}`;
    await this.writeStoredSession({ access_token: tampered, expires_at: Math.floor(Date.now() / 1000) - 120, expires_in: 0 });
    return tampered.slice(-6);
  }

  /** Call an RPC from inside the page with the page's OWN session token —
   *  i.e. what this user could do with devtools. Returns status + body. */
  async rpcAsPageUser(name: string, args: Record<string, unknown>): Promise<{ status: number; body: any }> {
    const cfg = liveCfg();
    return this.page.evaluate(async ([url, anonKey, fn, a]) => {
      const key = Object.keys(localStorage).find((k) => /^sb-.*-auth-token$/.test(k));
      const raw = key ? localStorage.getItem(key) : null;
      const token = raw ? (JSON.parse(raw) as { access_token: string }).access_token : "";
      const res = await fetch(`${url}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: { apikey: anonKey as string, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(a),
      });
      let body: unknown = null;
      try { body = await res.json(); } catch { body = null; }
      return { status: res.status, body };
    }, [cfg.url, cfg.anonKey, name, args] as const);
  }

  // ---- misc -------------------------------------------------------------

  /** Sidebar nav labels currently rendered. */
  async navLabels(): Promise<string[]> {
    return this.page.locator("aside.sidebar nav .menu-label").allInnerTexts();
  }

  badge(text: string | RegExp): Locator {
    return this.page.locator(".fixed.bottom-3.right-3").getByText(text);
  }

  async screenshot(name: string): Promise<string> {
    const file = path.join(RESULTS_DIR, "artifacts", `${name}.png`);
    mkdirSync(path.dirname(file), { recursive: true });
    await this.page.screenshot({ path: file, fullPage: false });
    return file;
  }

  /** Desktop QR modal close markers since `since` (ms epoch). */
  phoneUploadMarkersSince(since = 0): string[] {
    return this.phoneUploadMarkers.filter((m) => m.at >= since).map((m) => m.text.replace(/^\[phone-upload\] close requested /, ""));
  }

  requestsMatching(pattern: RegExp, since = 0): RequestLogEntry[] {
    return this.requests.filter((r) => r.at >= since && pattern.test(r.url));
  }
}
