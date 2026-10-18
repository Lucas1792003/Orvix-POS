#!/usr/bin/env -S npx tsx
// ----------------------------------------------------------------------
// Pending-queue recovery tool. See docs/selfhost-migration/phase-f/queue-export.md.
//
//   npx tsx tools/queue-recovery/cli.ts inspect <file.spqx> [--json]
//   npx tsx tools/queue-recovery/cli.ts replay  <file.spqx> --target <https://host> [options]
//
// Secrets come from the environment or a hidden prompt, never from argv,
// and are never printed:
//   QUEUE_RECOVERY_PASSPHRASE     export passphrase (else prompted)
//   QUEUE_RECOVERY_ANON_KEY       the backend's anon key (`apikey` header for the gateway)
//   QUEUE_RECOVERY_PASSWORD       password for --email (else prompted)
//   QUEUE_RECOVERY_ACCESS_TOKEN   bearer token instead of --email (e.g. a disposable test stack)
//   QUEUE_RECOVERY_SERVICE_KEY    optional; read-only idempotency-ledger lookups for an exact
//                                 applied / already-applied report
// ----------------------------------------------------------------------
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { installHostedBackendGuard } from "../../src/test/hostedGuard";
import { decryptQueueExport, parseEnvelope, summarize, type QueueExportPayload } from "../../src/lib/queueExport/format";
import { TargetError, confinedFetch, exitCodeFor, formatReport, replayExport, resolveTarget } from "./replay";

// The hosted project is refused at the network boundary for this process.
installHostedBackendGuard();

const USAGE = `usage:
  queue-recovery inspect <file.spqx> [--json]
  queue-recovery replay  <file.spqx> --target <url> [--dry-run] [--email <user email>]
                         [--confirm-host <host>] [--include-conflicts] [--include-quarantined] [--include-set-aside]
                         [--include-reconciled] [--rest-prefix /rest/v1] [--report <out.json>]
  --target is mandatory (no default, no env fallback). A host different from the one
  the till was built for must be repeated with --confirm-host.
  --include-quarantined replays entries the till QUARANTINED (queued for another backend,
  e.g. by v1.0.15 for hosted); it always needs --confirm-host <target host> as well.
  --include-set-aside replays entries an owner SET ASIDE on the till (RC2); without it they
  are reported as skipped-set-aside and never sent.
  --include-reconciled replays entries an owner RECONCILED on the till (RC3: matched /
  recreated / cancelled); without it they are reported as skipped-reconciled (with the
  owner's record) and never sent. Normally wrong: only on an explicit owner decision.
  Migration 086: the signed-in user is asked from the server (no actor option exists).
  A UUIDv7 entry runs through op_execute only for its own creator; another user's is
  reported 'held'. Entries the till HELD are only looked up / fenced, never replayed.
  The run stops at the first undecided entry (held, in-flight, unavailable, unknown).`;

interface Args { cmd: string; file: string; flags: Map<string, string | true> }

function parseArgs(argv: string[]): Args {
  const [cmd, file, ...rest] = argv;
  const flags = new Map<string, string | true>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument: ${a}`);
    const name = a.slice(2);
    if (["dry-run", "json", "include-conflicts", "include-quarantined", "include-set-aside", "include-reconciled"].includes(name)) flags.set(name, true);
    else if (["target", "email", "confirm-host", "rest-prefix", "report"].includes(name)) {
      const v = rest[++i];
      if (v === undefined) throw new Error(`--${name} needs a value`);
      flags.set(name, v);
    } else throw new Error(`unknown option --${name}`);
  }
  if (!cmd || !file || !["inspect", "replay"].includes(cmd)) throw new Error("missing command or file");
  return { cmd, file, flags };
}

async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error(`${question.trim()} is required (set it in the environment; no terminal to prompt on)`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let prompted = false;
  out._writeToOutput = (s: string) => { if (!prompted) { out.output.write(s); prompted = true; } };
  try {
    return await new Promise<string>((resolve) => rl.question(question, (a) => resolve(a)));
  } finally {
    rl.close();
    process.stdout.write("\n");
  }
}

const secret = async (env: string, prompt: string) => process.env[env] || promptHidden(prompt);

async function load(file: string): Promise<QueueExportPayload> {
  const text = readFileSync(file, "utf8");
  const env = parseEnvelope(text); // fails fast on a non-export before asking for a passphrase
  console.log(`export: till ${env.header.tillId}, exported ${env.header.exportedAt}, app ${env.header.appVersion}, ${env.header.summary.total} entries`);
  const passphrase = await secret("QUEUE_RECOVERY_PASSPHRASE", "Export passphrase: ");
  return decryptQueueExport(text, passphrase);
}

function printSummary(p: QueueExportPayload): void {
  const s = summarize(p.entries);
  console.log(`backend host (till build): ${p.backendHost}`);
  console.log(`session: user ${p.session.userId ?? "-"}  org ${p.session.orgId ?? "-"}  shop ${p.session.shopId ?? "-"}  role ${p.session.role ?? "-"}`);
  console.log(`entries: ${s.total}  by status ${JSON.stringify(s.byStatus)}  by op ${JSON.stringify(s.byOpType)}`);
  if (p.redactedFields > 0) console.log(`note: ${p.redactedFields} credential-like field(s) were redacted at export; affected entries are not replayed`);
  for (const e of p.entries) {
    const r = e.reconciliation;
    console.log(`  ${String(e.seq ?? "-").padStart(3)}  ${e.opType.padEnd(28)}  ${e.status.padEnd(8)}  attempts ${String(e.attempts).padStart(2)}  key ${e.idempotencyKey?.slice(0, 8) ?? "-"}  ring-up ${e.ringUpAt ?? "-"}${e.refs.length ? `  refs ${e.refs.map((x) => x.field).join(",")}` : ""}${e.lastErrorClass ? `  last ${e.lastErrorClass}` : ""}${e.actorId ? `  by ${e.actorId}` : ""}${e.fenceRequired ? "  HELD (lookup only)" : ""}${e.serverOutcome ? `  server: ${e.serverOutcome}` : ""}${r ? `  reconciled ${r.resolution}${r.serverRef ? ` -> ${r.serverRef.receiptNo ?? r.serverRef.saleId}` : ""} by ${r.owner.name} at ${r.reconciledAt}` : ""}${e.reconcileRejected ? "  RECONCILIATION REJECTED (integrity)" : ""}`);
  }
  if (p.onlineOperations.length) {
    console.log(`UNRESOLVED ONLINE-ONLY OPERATIONS (${p.onlineOperations.length}) — they may have been applied; never replayed by this tool, verify them on their server:`);
    for (const o of p.onlineOperations) console.log(`  ${o.name.padEnd(28)}  key ${o.idempotencyKey?.slice(0, 8) ?? "-"}  by ${o.userId ?? "-"}  org ${o.orgId ?? "-"}  server ${o.backendOrigin ?? "(not recorded)"}  attempts ${o.attempts}  created ${o.createdAt}`);
  }
  if (p.reconciliationLog.length) {
    console.log(`reconciliation log (${p.reconciliationLog.length}):`);
    for (const l of p.reconciliationLog) console.log(`  ${l.at}  ${l.event.padEnd(15)}  ${l.localId}  ${l.detail}`);
  }
}

async function signIn(origin: string, anonKey: string | null, email: string): Promise<string> {
  const password = await secret("QUEUE_RECOVERY_PASSWORD", `Password for ${email}: `);
  const f = confinedFetch(fetch, origin);
  const res = await f(`${origin}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(anonKey ? { apikey: anonKey } : {}) },
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string; msg?: string };
  if (!res.ok || typeof body.access_token !== "string") {
    throw new Error(`sign-in failed (HTTP ${res.status}): ${body.error_description ?? body.msg ?? "no token"}`);
  }
  return body.access_token;
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
    return 2;
  }
  const payload = await load(args.file);

  if (args.cmd === "inspect") {
    if (args.flags.has("json")) {
      // Counts and identifiers only — payloads stay in the encrypted file.
      console.log(JSON.stringify({
        tillId: payload.tillId, exportedAt: payload.exportedAt, appVersion: payload.appVersion,
        backendHost: payload.backendHost, session: payload.session, summary: summarize(payload.entries),
        entries: payload.entries.map((e) => ({ seq: e.seq, opId: e.opId, opType: e.opType, status: e.status, idempotencyKey: e.idempotencyKey, attempts: e.attempts, backendOrigin: e.backendOrigin, actorId: e.actorId, fenceRequired: e.fenceRequired, blocksQueue: e.blocksQueue, serverOutcome: e.serverOutcome })),
        onlineOperations: payload.onlineOperations.map((o) => ({ id: o.id, name: o.name, idempotencyKey: o.idempotencyKey, userId: o.userId, orgId: o.orgId, backendOrigin: o.backendOrigin, attempts: o.attempts, uncertain: o.uncertain })),
      }, null, 1));
    } else printSummary(payload);
    // Not "clean" while anything may have been applied without a server
    // decision: an unresolved online money operation, or an entry in doubt,
    // held, blocking or being sent.
    const undecided = payload.entries.filter((e) => !e.serverOutcome && e.status !== "reconciled"
      && (e.inDoubt === true || e.fenceRequired === true || e.blocksQueue === true || e.status === "syncing" || e.statusBeforeArchive === "syncing")).length;
    if (undecided) console.log(`NOT CLEAN: ${undecided} entr${undecided === 1 ? "y is" : "ies are"} not decided on the server (it may have been applied).`);
    const ops = payload.onlineOperations.length;
    if (ops) console.log(`NOT CLEAN: ${ops} online-only operation${ops === 1 ? " has" : "s have"} no server decision (it may have been applied).`);
    return payload.onlineOperations.length || undecided ? 4 : 0;
  }

  const targetFlag = args.flags.get("target");
  const confirm = args.flags.get("confirm-host");
  const target = resolveTarget(typeof targetFlag === "string" ? targetFlag : undefined, payload.backendHost, typeof confirm === "string" ? confirm : undefined);
  const restPrefixFlag = args.flags.get("rest-prefix");
  const restPrefix = typeof restPrefixFlag === "string" ? restPrefixFlag.replace(/\/+$/, "") : "/rest/v1";
  const dryRun = args.flags.has("dry-run");
  const includeQuarantined = args.flags.has("include-quarantined");
  if (includeQuarantined && (typeof confirm !== "string" || confirm.trim().toLowerCase() !== new URL(target.origin).host)) {
    console.error("--include-quarantined replays entries queued for ANOTHER backend; repeat the target host with --confirm-host <host>");
    return 2;
  }
  printSummary(payload);

  let accessToken = "";
  const anonKey = process.env.QUEUE_RECOVERY_ANON_KEY || null;
  if (!dryRun) {
    if (restPrefix === "/rest/v1" && !anonKey) throw new Error("QUEUE_RECOVERY_ANON_KEY is required for the API gateway");
    const email = args.flags.get("email");
    if (typeof email === "string") accessToken = await signIn(target.origin, anonKey, email);
    else if (process.env.QUEUE_RECOVERY_ACCESS_TOKEN) accessToken = process.env.QUEUE_RECOVERY_ACCESS_TOKEN;
    else throw new Error("give --email <the user who queued the entries> (or QUEUE_RECOVERY_ACCESS_TOKEN)");
  }

  const report = await replayExport(payload, {
    target: target.origin,
    restPrefix,
    anonKey,
    accessToken,
    ledgerToken: process.env.QUEUE_RECOVERY_SERVICE_KEY || null,
    includeConflicts: args.flags.has("include-conflicts"),
    includeQuarantined,
    includeSetAside: args.flags.has("include-set-aside"),
    includeReconciled: args.flags.has("include-reconciled"),
    // the operator repeated the target host: a plain replay into it is allowed
    otherBackendConfirmed: typeof confirm === "string" && confirm.trim().toLowerCase() === new URL(target.origin).host,
    dryRun,
  });
  console.log(`\n${formatReport(report)}`);
  const reportPath = args.flags.get("report");
  if (typeof reportPath === "string") {
    writeFileSync(reportPath, `${JSON.stringify(report, null, 1)}\n`, { mode: 0o600 });
    console.log(`report written to ${reportPath}`);
  }
  return exitCodeFor(report);
}

main().then((code) => { process.exitCode = code; }, (err: unknown) => {
  const code = (err as { code?: string }).code;
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = err instanceof TargetError ? 2 : code === "decrypt-failed" || code === "bad-format" ? 3 : 1;
});
