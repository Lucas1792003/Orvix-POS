/// <reference types="node" />
// Helpers for the Phase D live integration run against the self-hosted
// Supabase stack (see phase-d.live.test.ts and
// supabase/tests/phase-d/live/README.md). Node-only; never imported by the
// app. Secrets come in through environment variables and are never logged.

import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertNotHostedUrl, installHostedBackendGuard } from "../test/hostedGuard";

// The live suite exists for the self-hosted stack only. Refuse the hosted
// project at configuration time, and refuse at the network boundary too
// (fetch/WebSocket) — under vitest the setup file already installed the
// guard; this covers the Node-run probes (realtimeProbe.ts) as well.
installHostedBackendGuard();

export interface LiveConfig {
  url: string;
  anonKey: string;
  serviceKey: string;
  sshHost: string;
  stackDir: string;
}

export function liveConfig(): LiveConfig {
  const url = process.env.LIVE_SUPABASE_URL;
  const anonKey = process.env.LIVE_ANON_KEY;
  const serviceKey = process.env.LIVE_SERVICE_KEY;
  if (!url || !anonKey || !serviceKey) {
    throw new Error("LIVE_SUPABASE_URL, LIVE_ANON_KEY and LIVE_SERVICE_KEY must all be set");
  }
  assertNotHostedUrl(url, "the live suite (LIVE_SUPABASE_URL)");
  return {
    url: url.replace(/\/$/, ""),
    anonKey,
    serviceKey,
    sshHost: process.env.LIVE_SSH_HOST ?? "lucashome",
    stackDir: process.env.LIVE_STACK_DIR ?? "/srv/supabase/stack",
  };
}

export const uuid = (): string => randomUUID();

export function randomPassword(): string {
  return `Qa${randomBytes(18).toString("base64url")}1!`;
}

// Short-lived API clients. Auto-refresh is off so no timers outlive the
// test; each client keeps its own in-memory session.
export function makeClient(cfg: LiveConfig, key: string): SupabaseClient {
  return createClient(cfg.url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

export async function signUpUser(cfg: LiveConfig, email: string, password: string): Promise<string> {
  const client = makeClient(cfg, cfg.anonKey);
  const { data, error } = await client.auth.signUp({ email, password });
  if (error) throw new Error(`signup ${email} failed: ${error.message}`);
  const id = data.user?.id;
  if (!id) throw new Error(`signup ${email} returned no user id`);
  await client.auth.signOut().catch(() => undefined);
  return id;
}

export async function signedInClient(cfg: LiveConfig, email: string, password: string): Promise<SupabaseClient> {
  const client = makeClient(cfg, cfg.anonKey);
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in ${email} failed: ${error.message}`);
  return client;
}

const SAFE_VAR = /^[A-Za-z0-9_.:@-]+$/;

/**
 * Run SQL as supabase_admin inside the db container on the stack host, via
 * ssh. The statement travels base64-encoded (no shell quoting), is copied
 * into the container and executed with `psql -f`; stdin is /dev/null as
 * `docker compose exec` requires in this environment. Returns psql's
 * unaligned, tuples-only output. Throws on any SQL error (ON_ERROR_STOP).
 */
export function runSql(cfg: LiveConfig, sql: string, vars: Record<string, string> = {}): string {
  const b64 = Buffer.from(sql, "utf8").toString("base64");
  const varArgs = Object.entries(vars)
    .map(([k, v]) => {
      if (!SAFE_VAR.test(k) || !SAFE_VAR.test(v)) throw new Error(`unsafe psql variable ${k}`);
      return `-v ${k}=${v}`;
    })
    .join(" ");
  const remote = [
    `f=/tmp/qa-live-$$-${Date.now()}.sql`,
    `printf %s '${b64}' | base64 -d > "$f"`,
    `cd ${cfg.stackDir}`,
    `docker compose cp "$f" db:"$f" >/dev/null 2>&1`,
    `docker compose exec -T db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -At -q ${varArgs} -f "$f" </dev/null`,
    `rc=$?`,
    `rm -f "$f"`,
    `docker compose exec -T db rm -f "$f" </dev/null >/dev/null 2>&1 || true`,
    `exit $rc`,
  ].join("; ");
  return execFileSync("ssh", ["-o", "BatchMode=yes", cfg.sshHost, remote], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

export function runSqlFile(cfg: LiveConfig, path: string, vars: Record<string, string> = {}): string {
  return runSql(cfg, readFileSync(path, "utf8"), vars);
}

/** Plain-fetch RPC call (used where the supabase client would hide the
 *  request lifecycle, e.g. the AbortController test). */
export async function rawRpc(
  cfg: LiveConfig,
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${cfg.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: cfg.anonKey,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Prefer: "params=single-object",
    },
    body: JSON.stringify(args),
    signal,
  });
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor<T>(
  probe: () => Promise<T | undefined | null | false>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) return undefined;
    await sleep(intervalMs);
  }
}

/** Evidence ledger printed as a results table at the end of the run. */
export interface EvidenceRow {
  test: string;
  result: "PASS" | "FAIL" | "INFO";
  evidence: string;
}

export class Evidence {
  rows: EvidenceRow[] = [];
  add(test: string, result: EvidenceRow["result"], evidence: string): void {
    this.rows.push({ test, result, evidence });
  }
  pass(test: string, evidence: string): void { this.add(test, "PASS", evidence); }
  fail(test: string, evidence: string): void { this.add(test, "FAIL", evidence); }
  info(test: string, evidence: string): void { this.add(test, "INFO", evidence); }
  table(): string {
    const lines = ["| test | result | evidence |", "|---|---|---|"];
    for (const r of this.rows) lines.push(`| ${r.test} | ${r.result} | ${r.evidence.replace(/\|/g, "\\|")} |`);
    return lines.join("\n");
  }
}
