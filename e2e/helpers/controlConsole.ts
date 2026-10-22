/* eslint-disable @typescript-eslint/no-explicit-any */
// Step 6: the REAL Orvix Control web console (next start on http://localhost:3410, its own database) driven in Chromium,
// with a WebAuthn VIRTUAL authenticator (Chrome DevTools protocol) standing in for the operator's passkey. Every action
// goes through Control's pages, its HTTP API, its step-up ceremony and its network bridge to the POS — nothing here
// talks to the POS database. Synthetic operators only.
import { chromium, expect, type Browser, type BrowserContext, type CDPSession, type Page } from "@playwright/test";
import { LOOPBACK_ONLY_ARGS } from "./terminal";

export const CONTROL_URL = "http://localhost:3410";

export class ControlConsole {
  private constructor(readonly browser: Browser, readonly context: BrowserContext, readonly page: Page, readonly cdp: CDPSession,
                      readonly authenticatorId: string, readonly label: string) {}
  readonly dialogs: string[] = [];
  /** answers for window.prompt / window.confirm, consumed in order */
  private answers: (string | boolean)[] = [];

  static async open(label: string): Promise<ControlConsole> {
    const browser = await chromium.launch({ headless: true, args: LOOPBACK_ONLY_ARGS });
    const context = await browser.newContext({ baseURL: CONTROL_URL });
    context.setDefaultNavigationTimeout(60_000);
    context.setDefaultTimeout(60_000);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
      automaticPresenceSimulation: true } });
    const c = new ControlConsole(browser, context, page, cdp, authenticatorId, label);
    page.on("dialog", async (d) => {
      c.dialogs.push(`${d.type()}: ${d.message()}`);
      const a = c.answers.shift();
      if (d.type() === "prompt") await d.accept(typeof a === "string" ? a : "");
      else if (a === false) await d.dismiss(); else await d.accept();
    });
    return c;
  }

  async close(): Promise<void> { await this.browser.close().catch(() => undefined); }
  answer(...a: (string | boolean)[]): void { this.answers.push(...a); }
  async credentials(): Promise<number> {
    return ((await this.cdp.send("WebAuthn.getCredentials", { authenticatorId: this.authenticatorId })).credentials ?? []).length;
  }

  /** One-time enrolment link (host bootstrap or invitation) -> passkey registered in the virtual authenticator. */
  async enroll(token: string): Promise<string | null> {
    await this.page.goto(`/enroll/${token}`);
    await this.page.getByRole("button", { name: "Register passkey" }).click();
    await expect(this.page.getByText("Passkey registered")).toBeVisible({ timeout: 30_000 });
    // an invited operator is shown the fingerprint the host must approve; a first owner is not
    const fp = this.page.locator("p", { hasText: "Read this fingerprint to the host" }).locator("span.font-mono");
    return (await fp.count()) ? (await fp.first().textContent())?.trim() ?? null : null;
  }

  async login(): Promise<void> {
    await this.page.goto("/login");
    await this.page.getByRole("button", { name: "Sign in with passkey" }).click();
    await this.page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 });
  }

  /** Same-origin JSON call from the signed-in page (cookie + CSRF exactly as the UI sends them). */
  async api(path: string, body?: unknown): Promise<{ status: number; body: any }> {
    return this.page.evaluate(async ({ path, body }) => {
      const s = await (await fetch("/api/auth/session")).json().catch(() => ({}));
      const r = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", "x-orvix-csrf": s.csrf ?? "" }, body: JSON.stringify(body) });
      const t = await r.text(); let j: unknown = t; try { j = JSON.parse(t); } catch { /* html */ }
      return { status: r.status, body: j as any };
    }, { path, body });
  }

  /** The step-up ceremony exactly as the UI performs it (options -> navigator.credentials.get -> verify), for API-level tests. */
  async stepUp(action: string, target: string): Promise<boolean> {
    return this.page.evaluate(async ({ action, target }) => {
      const s = await (await fetch("/api/auth/session")).json();
      const post = async (u: string, b: unknown) => (await fetch(u, { method: "POST", headers: { "content-type": "application/json", "x-orvix-csrf": s.csrf }, body: JSON.stringify(b) })).json();
      const o = await post("/api/auth/stepup/options", { action, target });
      if (!o.ok) return false;
      const b64u = (x: string) => Uint8Array.from(atob(x.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(x.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
      const enc = (b: ArrayBuffer | null) => b ? btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : undefined;
      const opt = o.options;
      const cred = await navigator.credentials.get({ publicKey: { ...opt, challenge: b64u(opt.challenge),
        allowCredentials: (opt.allowCredentials ?? []).map((c: any) => ({ ...c, id: b64u(c.id) })) } }) as PublicKeyCredential;
      const r = cred.response as AuthenticatorAssertionResponse;
      const v = await post("/api/auth/stepup/verify", { response: { id: cred.id, rawId: enc(cred.rawId), type: cred.type, clientExtensionResults: {},
        response: { clientDataJSON: enc(r.clientDataJSON), authenticatorData: enc(r.authenticatorData), signature: enc(r.signature), userHandle: enc(r.userHandle) } } });
      return v.ok === true;
    }, { action, target });
  }

  async openOrg(org: string): Promise<void> {
    await this.page.goto(`/pos-recovery?org=${encodeURIComponent(org)}`);
    await this.page.getByRole("heading", { name: "POS recovery", exact: true }).waitFor();
  }
  /** the organization's state badge in the detail section */
  orgState(org: string) { return this.page.locator("section h2", { hasText: org }).locator("xpath=following-sibling::span[1]"); }
  async blockedBanner(): Promise<string | null> {
    const b = this.page.getByRole("alert").filter({ hasText: /BLOCKED: POS recovery interface unavailable|POS recovery unavailable/ });
    return (await b.count()) ? (await b.first().innerText()) : null;
  }

  /** Containment: pick the target state, give reason + evidence, confirm with the passkey (step-up). Returns the error text or null. */
  async transition(to: "RECONCILING" | "RESTRICTED" | "QUARANTINED", reason: string, evidence: string): Promise<string | null> {
    const label = { RECONCILING: "Start reconciliation", RESTRICTED: "Restrict", QUARANTINED: "Quarantine" }[to];
    const panel = this.page.locator("div", { has: this.page.getByRole("heading", { name: "Containment and reconciliation" }) }).last();
    await panel.getByRole("button", { name: `${label} 🔑` }).click();
    await panel.getByLabel(/Reason \(10–500/).fill(reason);
    await panel.getByLabel(/Evidence reference/).fill(evidence);
    const reload = this.page.waitForEvent("load", { timeout: 30_000 }).then(() => null, () => "no reload");
    await panel.getByRole("button", { name: `Move to ${to}` }).click();
    const err = panel.getByRole("alert");
    const r = await Promise.race([reload, err.waitFor({ timeout: 30_000 }).then(async () => await err.innerText(), () => "no answer")]);
    await this.page.getByRole("heading", { name: "POS recovery", exact: true }).waitFor();
    return r;
  }

  async recordReport(): Promise<void> {
    const reload = this.page.waitForEvent("load", { timeout: 30_000 });
    await this.page.getByRole("button", { name: "Record reconciliation report" }).click();
    await reload;
    await this.page.getByRole("heading", { name: "POS recovery", exact: true }).waitFor();
  }

  /** Paste an owner-signed authorization (text + hex signature), confirm with the passkey. Returns the UI's answer. */
  async submitAuthorization(a: { authorization: string; signature: string }): Promise<{ ok: boolean; text: string }> {
    const panel = this.page.locator("div", { has: this.page.getByRole("heading", { name: "Submit an owner-signed authorization" }) }).last();
    await panel.getByLabel("Authorization (exact text)").fill(a.authorization);
    await panel.getByLabel("Signature (hex)").fill(a.signature);
    await panel.getByRole("button", { name: /Confirm with passkey and submit/ }).click();
    const ok = panel.getByText(/^Accepted by the POS:/);
    const err = panel.getByRole("alert");
    return Promise.race([
      ok.waitFor({ timeout: 45_000 }).then(async () => ({ ok: true, text: await ok.innerText() })),
      err.waitFor({ timeout: 45_000 }).then(async () => ({ ok: false, text: await err.innerText() })),
    ]);
  }
  submitButtonEnabled(): Promise<boolean> {
    return this.page.getByRole("button", { name: /Confirm with passkey and submit/ }).isEnabled();
  }

  /** Suspend / revoke a till from its row (window.prompt for the reason, window.confirm for revoke, then step-up). */
  async containDevice(deviceId: string, action: "suspend" | "revoke", reason: string): Promise<string | null> {
    this.answer(reason); if (action === "revoke") this.answer(true);
    const row = this.page.locator("li", { has: this.page.locator("span.font-mono", { hasText: deviceId }) }).first();
    const reload = this.page.waitForEvent("load", { timeout: 30_000 }).then(() => null, () => "no reload");
    await row.getByRole("button", { name: action === "suspend" ? "Suspend 🔑" : "Revoke 🔑" }).click();
    const err = row.getByRole("alert");
    const r = await Promise.race([reload, err.waitFor({ timeout: 30_000 }).then(async () => await err.innerText(), () => "no answer")]);
    await this.page.getByRole("heading", { name: "POS recovery", exact: true }).waitFor();
    return r;
  }
  deviceRow(deviceId: string) { return this.page.locator("li", { has: this.page.locator("span.font-mono", { hasText: deviceId }) }).first(); }
}
