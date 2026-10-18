// ----------------------------------------------------------------------
// Queue recovery: replay a decrypted pending-queue export against ONE
// explicitly named backend, exactly the way the till's own drain would
// (src/stores/data/outbox.ts):
//   * entries in original queue order (seq);
//   * the ORIGINAL idempotency key and payload, sent to the same RPC
//     (POST <rest>/rpc/<name>) or table endpoint the app uses, so the
//     server's idempotency ledger turns a second delivery (another replay,
//     or the till syncing the same entry) into the stored response instead
//     of a second sale;
//   * `refs` (an entry that names a record created offline, e.g. a sale on
//     a shift opened offline) resolved from the export's id map and from the
//     responses of the entries replayed before it, as the app's reconcilers
//     do;
//   * a transient failure (network, 5xx, 401, 429 …) stops the run — later
//     entries may depend on that one; so does every entry whose outcome is
//     not decided (held, in flight, unavailable, unknown, a conflict the
//     server never decided — `blocksQueue`), as the till's drain does;
//   * every lookup, fence and executor call is made only against the
//     backend the entry was queued for (its recorded origin); a legacy
//     replay into a DIFFERENT backend (a restore under a new name) needs the
//     operator's --confirm-host and is refused for any entry ever in doubt;
//   * the run never reports success while an undecided entry was skipped
//     or an unresolved online-only operation (payment, void, refund request)
//     is in the file.
// Migration 086 (G1 Stage 1) — on a server that has it:
//   * a UUIDv7 operation runs ONLY through the guarded executor op_execute,
//     and only for the user who created it: the tool asks the SERVER who is
//     signed in (app_user_id()) and never takes an actor id from the
//     operator; another user's operation is only looked up (never run, never
//     fenced) and the run stops there (later entries may depend on it);
//   * a held entry (fenceRequired: its first attempt may or may not have
//     reached the server) is NEVER replayed: it is looked up and, if the
//     server never saw it, fenced (op_status) — by its own user, or by an
//     ADMIN with the operation's own arguments as organisation evidence;
//   * an entry the server already decided (serverOutcome) is reported, not sent;
//   * committed / recorded refusal / abandoned are final; in flight,
//     unavailable, held and unknown stop the run (ordering is preserved);
//     OP_EXECUTOR_REQUIRED and "op_not_recorded" refusals are never final.
// UUIDv4 operations (older tills) keep their direct, 085-compatible path.
// It never talks to the till and never deletes or edits anything locally.
// Docs: docs/selfhost-migration/phase-f/queue-export.md.
// ----------------------------------------------------------------------
import { isDuplicateError, isTransientError } from "../../src/lib/errors";
import { assertNotHostedUrl } from "../../src/test/hostedGuard";
import { REDACTED, inQueueOrder, type QueueExportEntry, type QueueExportPayload } from "../../src/lib/queueExport/format";
import { EXECUTOR_RPCS, isUuidV7 } from "../../src/lib/executorRpcs";

export type Outcome =
  | "applied"                 // executed by this run (ledger had no key before the call)
  | "already-applied"         // the server returned its stored result: no new effect
  | "accepted"                // succeeded; first-vs-repeat not determinable (no ledger access)
  | "rejected"                // permanent server rejection (validation, permission, mismatch …)
  | "skipped-conflict"        // the till had already parked it as a conflict (use --include-conflicts)
  | "skipped-redacted"        // payload was altered by the exporter's credential redaction
  | "skipped-quarantined"     // the till quarantined it: queued for ANOTHER backend (e.g. v1.0.15 → hosted);
                              // replayed only with --include-quarantined + --confirm-host (owner decision)
  | "skipped-set-aside"       // an owner set it aside on the till (RC2); replayed only with --include-set-aside
  | "skipped-reconciled"      // an owner reconciled it on the till (RC3: matched / recreated / cancelled);
                              // replayed only with --include-reconciled (then judged by its former status)
  | "blocked-unresolved-ref"  // depends on an entry that did not succeed / unknown provisional id
  | "not-attempted"           // the run stopped earlier on a transient failure
  | "planned"                 // --dry-run
  // migration 086 (final):
  | "rejected-final"          // the server RECORDED a definitive refusal: it never ran and never will
  | "abandoned"               // stopped (fenced) on the server: it never ran and never will
  // migration 086 (undecided — each one stops the run, later entries may depend on it):
  | "in-flight"               // the server is still running it
  | "unavailable"             // the server will not report it to this user, or the RPC is disabled for this role
  | "held"                    // needs its original user, an administrator, or a server with migration 086
  | "unknown";                // the outcome could not be established (never treated as final)

export interface OpReport {
  seq: number | null;
  opId: string;
  opType: string;
  idempotencyKey: string | null;
  outcome: Outcome;
  detail?: string;
  httpStatus?: number;
  /** Server id of the record the operation created (sale/shift/request), when known. */
  resultId?: string;
}

export interface ReplayReport {
  target: string;
  /** Skipped entries whose outcome is NOT decided (in doubt, held, a
   *  blocking conflict): the queue is not recovered while any remains. */
  undecidedSkipped?: number;
  /** Unresolved online-only operations in the file (may have been applied). */
  onlineUnresolved?: number;
  /** The signed-in app user and role, as the SERVER reports them (null: not determinable). */
  signedInAs?: { userId: string | null; role: string | null };
  /** Whether the target has migration 086 (op_execute / op_status). */
  executor?: "available" | "absent" | "unknown" | "not-probed";
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  tillId: string;
  exportedAt: string;
  classification: "ledger" | "probe";
  stoppedOn: string | null;
  counts: Record<Outcome, number>;
  ops: OpReport[];
}

export interface ReplayOptions {
  /** Origin of the target backend, e.g. https://pos.example.test — given explicitly by the operator. */
  target: string;
  /** "/rest/v1" behind the API gateway (default); "" for a bare PostgREST. */
  restPrefix?: string;
  /** Sent as `apikey` (the gateway requires it); null for a bare PostgREST. */
  anonKey: string | null;
  /** Bearer token of the user the entries are replayed as (normally the user who queued them).
   *  Who that is, is asked from the server (app_user_id / app_role) — never given by the operator. */
  accessToken: string;
  /** Optional service-role token, used ONLY for read-only GETs on idempotency_keys
   *  (exact applied / already-applied classification). */
  ledgerToken?: string | null;
  includeConflicts?: boolean;
  /** Also replay entries the till quarantined (queued for another backend).
   *  An explicit owner decision: the CLI requires --confirm-host with it. */
  includeQuarantined?: boolean;
  /** Also replay entries an owner SET ASIDE on the till (status "archived",
   *  RC2). They are then treated by the status they had before (a former
   *  quarantined / conflict entry still needs its own flag). */
  includeSetAside?: boolean;
  /** The operator repeated the target host (--confirm-host): entries queued
   *  for another (or an unrecorded) backend may be REPLAYED there — never
   *  looked up or fenced there, and never if their outcome was ever in doubt. */
  otherBackendConfirmed?: boolean;
  /** Also replay entries an owner RECONCILED on the till (RC3). Normally
   *  wrong: "matched" means the server already has it, "recreated" means it
   *  was re-entered (a replay would count it twice unless the key was the
   *  same), "cancelled" means it must not happen. Explicit owner decision
   *  only; treated by the status it had before reconciliation. */
  includeReconciled?: boolean;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

/** Which response field holds the server id that replaces an entry's
 *  provisional id (mirrors the reconcilers' recordIdMapping calls). */
const ID_FROM_RESPONSE: Record<string, { table: string; id: (data: Record<string, unknown>) => unknown }> = {
  open_shift: { table: "shifts", id: (d) => (d.shift as Record<string, unknown> | undefined)?.id },
  complete_sale: { table: "sales", id: (d) => (d.sale as Record<string, unknown> | undefined)?.id },
  create_refund_void_request: { table: "refunds", id: (d) => (d.request as Record<string, unknown> | undefined)?.id },
};

const TABLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const RPC_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetError";
  }
}

/**
 * The target must be named explicitly (no default, no env fallback) and be
 * a plain http(s) origin; the hosted project is always refused; and a host
 * other than the one the till was built for must be confirmed by typing it
 * again (`confirmHost`) — e.g. a disposable restore environment.
 */
export function resolveTarget(target: string | undefined, exportBackendHost: string, confirmHost?: string): URL {
  if (!target || !target.trim()) {
    throw new TargetError("--target <url> is required: the tool never picks a backend by itself.");
  }
  let url: URL;
  try {
    url = new URL(target.trim());
  } catch {
    throw new TargetError(`--target is not a valid URL: ${target}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TargetError("--target must be an http(s) URL.");
  if (url.username || url.password) throw new TargetError("--target must not contain credentials.");
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new TargetError("--target must be an origin only (scheme://host[:port]), without a path.");
  }
  try {
    assertNotHostedUrl(url.href, "queue recovery (--target)");
  } catch (err) {
    throw new TargetError(err instanceof Error ? err.message : String(err));
  }
  const host = url.host.toLowerCase();
  if (host !== exportBackendHost.toLowerCase() && (confirmHost ?? "").toLowerCase() !== host) {
    throw new TargetError(
      `The export was taken on a till built for "${exportBackendHost}", but --target is "${host}". ` +
      `Replaying into a different backend executes the operations there; repeat the target host with --confirm-host ${host} if that is intended.`,
    );
  }
  return url;
}

/** fetch that refuses any URL outside the target origin. */
export function confinedFetch(base: typeof fetch, origin: string): typeof fetch {
  return (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (new URL(href).origin !== origin) throw new TargetError(`refusing request outside the target origin: ${new URL(href).origin}`);
    return base(input, init);
  };
}

interface HttpResult {
  status: number;
  body: unknown;
  error: { message: string; code?: string; status: number } | null;
}

async function send(f: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await f(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (res.ok) return { status: res.status, body, error: null };
    const b = (body ?? {}) as { message?: unknown; code?: unknown; msg?: unknown };
    const message = typeof b.message === "string" ? b.message : typeof b.msg === "string" ? b.msg : `HTTP ${res.status}`;
    return { status: res.status, body, error: { message, code: typeof b.code === "string" ? b.code : undefined, status: res.status } };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { status: 0, body: null, error: { message: `network: ${message}`, status: 0 } };
  } finally {
    clearTimeout(timer);
  }
}

const contractViolation = (message: string) => /IDEMPOTENCY_MISMATCH|IDEMPOTENCY_KEY_REQUIRED/.test(message);
const shortKey = (k: string | null) => (k ? k.slice(0, 8) : "-");

function emptyCounts(): Record<Outcome, number> {
  return {
    applied: 0, "already-applied": 0, accepted: 0, rejected: 0, "skipped-conflict": 0,
    "skipped-redacted": 0, "skipped-quarantined": 0, "skipped-set-aside": 0, "skipped-reconciled": 0, "blocked-unresolved-ref": 0, "not-attempted": 0, planned: 0,
    "rejected-final": 0, abandoned: 0, "in-flight": 0, unavailable: 0, held: 0, unknown: 0,
  };
}

/** Outcomes that leave the operation undecided: the run stops (ordering). */
// Final ordering pass: so do a refusal the server did not record (the legacy
// direct path; it could still run if retried), an entry whose reference
// cannot be resolved, and an entry that cannot be replayed (redacted) — the
// till keeps every one of them at the head of its queue too.
const STOPS_RUN: ReadonlySet<Outcome> = new Set([
  "not-attempted", "in-flight", "unavailable", "held", "unknown", "rejected", "blocked-unresolved-ref", "skipped-redacted",
]);

const isMissingFunction = (r: HttpResult, fn: string): boolean =>
  r.error !== null && (r.error.code === "PGRST202" || (r.error.code === "42883" && r.error.message.includes(fn)));
const hintOf = (r: HttpResult): string =>
  r.body && typeof r.body === "object" && typeof (r.body as { hint?: unknown }).hint === "string" ? (r.body as { hint: string }).hint : "";

const containsRedacted = (v: unknown): boolean =>
  v === REDACTED || (Array.isArray(v) ? v.some(containsRedacted) : !!v && typeof v === "object" && Object.values(v).some(containsRedacted));

export async function replayExport(payload: QueueExportPayload, options: ReplayOptions): Promise<ReplayReport> {
  const now = options.now ?? (() => new Date());
  const origin = new URL(options.target).origin;
  const f = confinedFetch(options.fetchImpl ?? fetch, origin);
  const rest = `${origin}${options.restPrefix ?? "/rest/v1"}`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const userHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${options.accessToken}`,
    ...(options.anonKey ? { apikey: options.anonKey } : {}),
  };
  const ledgerHeaders: Record<string, string> | null = options.ledgerToken
    ? { Authorization: `Bearer ${options.ledgerToken}`, ...(options.anonKey ? { apikey: options.anonKey } : {}) }
    : null;

  const idMap = new Map(payload.provisionalIdMap.map((m) => [m.provisionalId, m.realId]));
  const failedProvisional = new Set<string>();
  const report: ReplayReport = {
    target: origin, dryRun: Boolean(options.dryRun), startedAt: now().toISOString(), finishedAt: "", executor: "not-probed",
    tillId: payload.tillId, exportedAt: payload.exportedAt,
    classification: ledgerHeaders ? "ledger" : "probe", stoppedOn: null, counts: emptyCounts(), ops: [],
  };
  report.undecidedSkipped = 0;
  report.onlineUnresolved = 0;
  // As the till decides it (outbox.ts isUndecided + its hold rules): an
  // attempt being sent (or set aside while being sent) is undecided too.
  const sending = (e: QueueExportEntry) => e.status === "syncing" || e.statusBeforeArchive === "syncing";
  const undecided = (e: QueueExportEntry) =>
    !e.serverOutcome && (e.inDoubt === true || e.fenceRequired === true || e.blocksQueue === true || sending(e));
  const push = (e: QueueExportEntry, outcome: Outcome, extra: Partial<OpReport> = {}) => {
    if (outcome.startsWith("skipped-") && outcome !== "skipped-reconciled" && undecided(e)) {
      report.undecidedSkipped! += 1;
      extra = { ...extra, detail: `${extra.detail ?? ""} [NOT DECIDED: it may have been applied — not recovered]`.trim() };
    }
    report.ops.push({ seq: e.seq, opId: e.opId, opType: e.opType, idempotencyKey: e.idempotencyKey, outcome, ...extra });
    report.counts[outcome]++;
    if (STOPS_RUN.has(outcome) && outcome !== "not-attempted" && !report.stoppedOn) report.stoppedOn = String(e.seq);
    if (!["applied", "already-applied", "accepted", "planned"].includes(outcome)) {
      for (const p of e.provisional) for (const id of p.ids) failedProvisional.add(id);
    }
  };

  const ledgerHas = async (key: string): Promise<boolean | null> => {
    if (!ledgerHeaders) return null;
    const r = await send(f, `${rest}/idempotency_keys?select=key&key=eq.${encodeURIComponent(key)}`, { method: "GET", headers: ledgerHeaders }, timeoutMs);
    if (r.error || !Array.isArray(r.body)) return null;
    return r.body.length > 0;
  };

  // Without ledger access, complete_sale (the bulk of any queue) is still
  // classified: the sale ids of its shift are read before the call, and a
  // returned id already in that set means the server replayed its result.
  const saleIdsOfShift = async (shiftId: unknown): Promise<Set<string> | null> => {
    if (typeof shiftId !== "string") return null;
    const r = await send(f, `${rest}/sales?select=id&shift_id=eq.${encodeURIComponent(shiftId)}`, { method: "GET", headers: userHeaders }, timeoutMs);
    if (r.error || !Array.isArray(r.body)) return null;
    return new Set((r.body as { id: string }[]).map((s) => s.id));
  };

  // Who is signed in and whether the target has 086 — asked of the server
  // once, lazily (a dry run or a run that sends nothing asks nothing).
  let envMemo: { userId: string | null; role: string | null; executor: "available" | "absent" | "unknown" } | null = null;
  const environment = async () => {
    if (envMemo) return envMemo;
    const who = await send(f, `${rest}/rpc/app_user_id`, { method: "POST", headers: userHeaders, body: "{}" }, timeoutMs);
    const role = await send(f, `${rest}/rpc/app_role`, { method: "POST", headers: userHeaders, body: "{}" }, timeoutMs);
    // A read-only lookup of a random key (p_fence false never writes).
    const probe = await send(f, `${rest}/rpc/op_status`, {
      method: "POST", headers: userHeaders,
      body: JSON.stringify({ p_key: crypto.randomUUID(), p_rpc: "complete_sale", p_fence: false, p_expected_actor_id: null, p_args: null }),
    }, timeoutMs);
    envMemo = {
      userId: !who.error && typeof who.body === "string" ? who.body : null,
      role: !role.error && typeof role.body === "string" ? role.body : null,
      // A probe that failed for any other reason proves nothing: "unknown"
      // stops the run before anything is sent.
      executor: isMissingFunction(probe, "op_status") || probe.status === 404 ? "absent" : probe.error ? "unknown" : "available",
    };
    report.signedInAs = { userId: envMemo.userId, role: envMemo.role };
    report.executor = envMemo.executor;
    return envMemo;
  };

  const mapResult = (e: QueueExportEntry, data: Record<string, unknown>): unknown => {
    const mapper = ID_FROM_RESPONSE[e.opType];
    const resultId = mapper ? mapper.id(data) : undefined;
    if (mapper && typeof resultId === "string") {
      for (const p of e.provisional.filter((pp) => pp.table === mapper.table)) {
        if (p.ids[0]) idMap.set(p.ids[0], resultId);
      }
    }
    return resultId;
  };

  type Verdict = { outcome: Outcome; extra: Partial<OpReport> };
  const committed = (e: QueueExportEntry, response: unknown, replayed: boolean, httpStatus: number, withheld: boolean): Verdict => {
    if (withheld || response === null || response === undefined) {
      return { outcome: replayed ? "already-applied" : "applied", extra: { httpStatus, detail: "applied on the server; its stored reply is not readable by this user (records created offline that later entries reference cannot be resolved from it)" } };
    }
    const resultId = mapResult(e, (response ?? {}) as Record<string, unknown>);
    return { outcome: replayed ? "already-applied" : "applied", extra: { httpStatus, resultId: typeof resultId === "string" ? resultId : undefined } };
  };

  /** op_status (lookup, optionally + fence). Never executes anything. */
  const statusOf = async (e: QueueExportEntry, key: string, actor: string | null, opArgs: Record<string, unknown>, fence: boolean): Promise<Verdict> => {
    const r = await send(f, `${rest}/rpc/op_status`, {
      method: "POST", headers: userHeaders,
      body: JSON.stringify({ p_key: key, p_rpc: e.opType, p_fence: fence, p_expected_actor_id: actor, p_args: opArgs }),
    }, timeoutMs);
    if (r.error) {
      return isTransientError(r.error, r.status)
        ? { outcome: "not-attempted", extra: { httpStatus: r.status, detail: `status lookup failed (transient): ${r.error.message}` } }
        : { outcome: "unknown", extra: { httpStatus: r.status, detail: `status lookup refused: ${r.error.message}` } };
    }
    const d = (r.body ?? {}) as Record<string, unknown>;
    switch (d.status) {
      case "committed":
        return committed(e, d.response, true, r.status, d.withheld === true || d.response_purged === true);
      case "rejected":
        return { outcome: "rejected-final", extra: { httpStatus: r.status, detail: `refused by the server (recorded): ${typeof d.message === "string" ? d.message : d.code ?? ""}` } };
      case "abandoned":
        return { outcome: "abandoned", extra: { httpStatus: r.status, detail: d.fenced === true ? "never reached the server: stopped there by this run (it can never be applied); re-enter it if still needed" : "stopped on the server earlier: it never ran and never will" } };
      case "in_flight":
        return { outcome: "in-flight", extra: { httpStatus: r.status, detail: "the server is still running it; re-run later" } };
      case "unavailable":
        return { outcome: "unavailable", extra: { httpStatus: r.status, detail: "the server will not report this operation to this user (another organisation or operation)" } };
      case "not_found":
        if (!fence) return { outcome: "unknown", extra: { detail: "not on the server (yet)" } };
        return { outcome: "held", extra: { httpStatus: r.status, detail: d.reason === "expired" ? "too old to confirm or stop automatically: an owner reconciles it from the server records" : `could not be stopped by this user (${typeof d.reason === "string" ? d.reason : "not authorised"}): sign in as its creator or an administrator` } };
      default:
        return { outcome: "unknown", extra: { httpStatus: r.status, detail: "unrecognised status reply" } };
    }
  };

  /** op_execute's reply. Only committed / recorded refusal / abandoned are final. */
  const executorVerdict = (e: QueueExportEntry, r: HttpResult): Verdict => {
    if (r.error) {
      const msg = r.error.message;
      const hint = hintOf(r);
      if (msg.startsWith("OP_ACTOR_MISMATCH") || hint.startsWith("op_not_recorded:actor")) return { outcome: "held", extra: { httpStatus: r.status, detail: `only its creator can run it (${msg.slice(0, 80)})` } };
      if (hint.startsWith("op_not_recorded:dependency")) return { outcome: "held", extra: { httpStatus: r.status, detail: `waiting for a prerequisite (not recorded; re-run later): ${msg.slice(0, 120)}` } };
      if (msg.startsWith("OP_RPC_DISABLED")) return { outcome: "unavailable", extra: { httpStatus: r.status, detail: `this RPC is not executable for the signed-in role: ${msg.slice(0, 80)}` } };
      if (msg.startsWith("OP_KEY_OUTSIDE_WINDOW")) return { outcome: "held", extra: { httpStatus: r.status, detail: "too old to run (key outside the executor window); an owner reconciles it" } };
      if (contractViolation(msg)) return { outcome: "unknown", extra: { httpStatus: r.status, detail: `the server has a decision under this key for a different request: ${msg.slice(0, 100)}` } };
      if (/^OP_(KEY_REQUIRED|ACTOR_REQUIRED|UNKNOWN_RPC|UNKNOWN_ARGUMENT|MISSING_ARGUMENT|INVALID_ARGUMENTS?)\b/.test(msg)) {
        return { outcome: "rejected", extra: { httpStatus: r.status, detail: msg } };
      }
      if (isTransientError(r.error, r.status)) return { outcome: "not-attempted", extra: { httpStatus: r.status, detail: `transient: ${msg}` } };
      // Any other raised error was NOT recorded (op_not_recorded:*): never final.
      return { outcome: "unknown", extra: { httpStatus: r.status, detail: `not recorded on the server${hint ? ` [${hint}]` : ""}: ${msg.slice(0, 120)}` } };
    }
    const d = (r.body ?? {}) as Record<string, unknown>;
    switch (d.outcome) {
      case "committed":
        return committed(e, d.response, d.replayed === true, r.status, d.withheld === true || d.response_purged === true);
      case "rejected":
        return { outcome: "rejected-final", extra: { httpStatus: r.status, detail: `refused by the server (recorded${d.replayed === true ? ", earlier" : ""}): ${typeof d.message === "string" ? d.message : d.code ?? ""}` } };
      case "abandoned":
        return { outcome: "abandoned", extra: { httpStatus: r.status, detail: "stopped on the server: it never ran and never will" } };
      case "mismatch":
        return { outcome: "unknown", extra: { httpStatus: r.status, detail: "IDEMPOTENCY_MISMATCH: the server has a decision under this key for a different request (possibly committed)" } };
      default:
        return { outcome: "unknown", extra: { httpStatus: r.status, detail: "unrecognised executor reply (it may have committed)" } };
    }
  };

  const ordered = inQueueOrder(payload.entries);
  for (let i = 0; i < ordered.length; i++) {
    const e = ordered[i];
    if (report.stoppedOn) {
      push(e, "not-attempted", { detail: `run stopped at seq ${report.stoppedOn}` });
      continue;
    }
    if (e.status === "reconciled" && !options.includeReconciled) {
      const r = e.reconciliation;
      push(e, "skipped-reconciled", {
        detail: r
          ? `reconciled on the till at ${r.reconciledAt} by ${r.owner.name} (${r.owner.userId}): ${r.resolution}${r.serverRef ? ` -> sale ${r.serverRef.saleId}${r.serverRef.receiptNo ? ` (${r.serverRef.receiptNo})` : ""}` : ""}; check ${r.check.result}; ${r.reason}`
          : "reconciled on the till (no record in the file)",
      });
      continue;
    }
    // A reconciled entry included on purpose is judged by its former status
    // (and a former set-aside one by the status it had before that).
    const pre = e.status === "reconciled" ? e.statusBeforeReconcile ?? "conflict" : e.status;
    if (pre === "archived" && !options.includeSetAside) {
      push(e, "skipped-set-aside", {
        detail: `set aside on the till${e.archivedAt ? ` at ${e.archivedAt}` : ""} (was ${e.statusBeforeArchive ?? "unknown"})${e.archiveReason ? `: ${e.archiveReason}` : ""}`,
      });
      continue;
    }
    // A set-aside entry included on purpose is judged by its former status.
    const status = pre === "archived" ? e.statusBeforeArchive ?? "pending" : pre;
    if (status === "quarantined" && !options.includeQuarantined) {
      push(e, "skipped-quarantined", {
        detail: `queued for ${e.backendOrigin ?? "an unrecorded backend (pre-1.0.16 build)"}; ${e.quarantineReason ?? "quarantined by the till"}`,
      });
      continue;
    }
    // Decided by the server already (migration 086): reported, never sent.
    if (e.serverOutcome) {
      push(e, e.serverOutcome === "rejected" ? "rejected-final" : "abandoned", { detail: `decided on the server earlier (till record): ${e.lastError ?? e.serverOutcome}` });
      continue;
    }
    // A conflict the server never decided keeps the head of the queue (the
    // drain stops at it): so does the recovery.
    if (status === "conflict" && e.blocksQueue === true && e.fenceRequired !== true) {
      push(e, "held", { detail: `not decided on the server (${(e.lastError ?? "refusal not recorded").slice(0, 120)}); later entries may depend on it — a person decides first` });
      report.stoppedOn = String(e.seq);
      continue;
    }
    // Held for lookup + fence (stored as "conflict" so older builds and
    // tools never send it): asked, never replayed — no flag needed. As the
    // till holds them (recoverStrandedSyncing / classifyLegacyQueue): a
    // write-ahead online attempt whose outcome is unknown (in doubt, or being
    // sent when exported) and that was NOT authorised offline is held and
    // fenced if the server never saw it; one whose authorisation is unknown
    // (an older build's row) is looked up only — never fenced, never sent.
    // EXACTLY the till's decision for the same row (post-checkpoint fix):
    //  - outbox.ts recoverStrandedSyncing: a write-ahead attempt left being sent
    //    and not staged, on its first attempt or with nothing staged, was
    //    never authorised offline -> held (lookup + fence);
    //  - classifyLegacyQueue: an in-doubt write-ahead row with no staged flag
    //    and nothing staged -> held; one with staged records was authorised;
    //    a close / dispatch with nothing staged may carry local proof the file
    //    lacks (the shift / transfer row) -> lookup only, never fenced here;
    //  - a version-1 file has no 086 fields at all: anything being sent ->
    //    lookup only (never replayed blindly, never fenced).
    const outcomeUnknown = e.inDoubt === true || sending(e);
    const nothingStaged = (e.provisional?.length ?? 0) === 0;
    const legacyFile = payload.formatVersion === 1;
    // (deployment-blocker pass: the till's ONE rule, outbox.ts offlineAuthorisation)
    const evidenceOp = e.opType === "close_shift" || e.opType === "dispatch_stock_transfer";
    const unflagged = e.staged === null || e.staged === undefined;
    // (a write-ahead row with no staged flag and no attempt recorded is a
    //  first online attempt whatever its status — offlineAuthorisation)
    const strandedFirst = e.kind === "rpc" && e.writeAhead === true && e.staged !== true
      && ((unflagged && e.attempts === 0) || (sending(e) && (e.attempts === 0 || (nothingStaged && !evidenceOp))));
    const strandedWithLocalProof = e.kind === "rpc" && sending(e) && e.writeAhead === true && unflagged && e.attempts > 0 && nothingStaged && evidenceOp;
    const legacyInDoubt = e.kind === "rpc" && !sending(e) && e.writeAhead === true && e.inDoubt === true && unflagged && nothingStaged;
    const evidenceElsewhere = (legacyInDoubt && evidenceOp) || strandedWithLocalProof;
    const neverAuthorised = e.kind === "rpc" && (e.staged === false && outcomeUnknown || strandedFirst || (legacyInDoubt && !evidenceElsewhere));
    const authorisationUnknown = e.kind === "rpc" && !neverAuthorised && (evidenceElsewhere || (legacyFile && sending(e)));
    const fenceable = e.kind === "rpc" && (e.fenceRequired === true || neverAuthorised);
    const held = fenceable || authorisationUnknown;
    if (status === "conflict" && !held && !options.includeConflicts) {
      push(e, "skipped-conflict", { detail: e.lastError ?? undefined });
      continue;
    }
    if (containsRedacted(e.payload)) {
      push(e, "skipped-redacted", { detail: "payload contained a credential-like field and was redacted at export" });
      continue;
    }

    // Resolve refs exactly like outbox.ts resolveArgs.
    const args: Record<string, unknown> = { ...(e.payload ?? {}) };
    let unresolved: string | null = null;
    for (const ref of e.refs) {
      const real = idMap.get(ref.provisionalId);
      if (!real) {
        unresolved = failedProvisional.has(ref.provisionalId)
          ? `${ref.field} refers to ${ref.provisionalId}, created by an entry that did not succeed`
          : `${ref.field} refers to unknown provisional id ${ref.provisionalId}`;
        break;
      }
      args[ref.field] = real;
    }
    // A UUIDv7 executor operation is never run against a backend it was not
    // queued for, --confirm-host or not (below, on an 086 target).
    const executorElsewhere = e.kind === "rpc" && e.backendOrigin !== origin && !!e.idempotencyKey && isUuidV7(e.idempotencyKey) && EXECUTOR_RPCS.has(e.opType);
    if (options.dryRun && (held || (e.backendOrigin !== origin && (undecided(e) || !options.otherBackendConfirmed || executorElsewhere)))) {
      // The real run would not replay it (the same tests as below): say so and stop.
      push(e, "held", { detail: `dry run: ${e.backendOrigin !== origin ? `queued for ${e.backendOrigin ?? "an unrecorded backend"}` : fenceable ? "held: would be looked up and fenced, never replayed" : "held: would be looked up only"}` });
      continue;
    }
    if (options.dryRun) {
      // A ref whose parent is replayed earlier in this run resolves at run time.
      const pendingRef = unresolved && ordered.slice(0, i).some((p) => p.provisional.some((pp) => e.refs.some((r) => pp.ids.includes(r.provisionalId))));
      // Who will be signed in is only known to the real run (the server says):
      // an entry with a recorded creator runs only in that user's session.
      const creator = e.kind === "rpc" ? (e.actorId ?? (typeof args.p_expected_actor_id === "string" ? args.p_expected_actor_id : null)) : null;
      push(e, unresolved && !pendingRef ? "blocked-unresolved-ref" : "planned", {
        detail: `${e.kind === "rpc" ? `rpc ${e.opType}` : `${e.tableOp} ${e.table}`} key ${shortKey(e.idempotencyKey)}${held ? " (HELD: lookup + fence only, never replayed)" : ""}${pendingRef ? " (ref resolves from an earlier entry)" : ""}${unresolved && !pendingRef ? `: ${unresolved}` : ""}${creator ? ` (only if signed in as ${creator}; otherwise held)` : ""}`,
      });
      continue;
    }
    if (unresolved && !held) {
      push(e, "blocked-unresolved-ref", { detail: unresolved });
      continue;
    }

    // Backend binding: decisions (lookup, fence, executor) only against the
    // backend the entry was queued for; a plain replay into another one only
    // with the operator's confirmation and never for an entry ever in doubt.
    const bound = e.backendOrigin === origin;
    if (!bound && (held || undecided(e) || !options.otherBackendConfirmed)) {
      push(e, "held", {
        detail: `queued for ${e.backendOrigin ?? "an unrecorded backend"}, target is ${origin}: ${held || undecided(e)
          ? "its outcome is not decided there, and another server cannot decide it — recover it against its own backend"
          : "repeat the target host with --confirm-host to replay it there"}`,
      });
      report.stoppedOn = String(e.seq);
      continue;
    }

    if (e.kind === "table_write") {
      if (!e.table || !TABLE_NAME.test(e.table) || !e.tableOp || (e.tableOp !== "insert" && !e.rowId)) {
        push(e, "rejected", { detail: "malformed table write in export" });
        continue;
      }
      const q = e.tableOp === "insert" ? "" : `?id=eq.${encodeURIComponent(e.rowId!)}`;
      const method = e.tableOp === "insert" ? "POST" : e.tableOp === "update" ? "PATCH" : "DELETE";
      const r = await send(f, `${rest}/${e.table}${q}`, {
        method, headers: { ...userHeaders, Prefer: "return=minimal" },
        body: e.tableOp === "delete" ? undefined : JSON.stringify(e.payload ?? {}),
      }, timeoutMs);
      if (!r.error) push(e, "applied", { httpStatus: r.status });
      else if (e.tableOp === "insert" && isDuplicateError(r.error)) push(e, "already-applied", { httpStatus: r.status, detail: "row already exists (client-minted id)" });
      else if (isTransientError(r.error, r.status)) {
        push(e, "not-attempted", { httpStatus: r.status, detail: `transient: ${r.error.message}` });
        report.stoppedOn = String(e.seq);
      } else push(e, "rejected", { httpStatus: r.status, detail: r.error.message });
      continue;
    }

    if (!RPC_NAME.test(e.opType)) {
      push(e, "rejected", { detail: "malformed RPC name in export" });
      continue;
    }
    if (!e.idempotencyKey) {
      // Never mint a new key: that would turn a replay into a new operation.
      push(e, held ? "held" : "rejected", { detail: "entry has no original idempotency key; not replayed" });
      if (held) report.stoppedOn = String(e.seq);
      continue;
    }
    const key = e.idempotencyKey;
    const { p_idempotency_key: _k, ...opArgs } = args;
    void _k;
    const actor = e.actorId ?? (typeof args.p_expected_actor_id === "string" ? args.p_expected_actor_id : null);
    const env = await environment();
    const finish = (outcome: Outcome, extra: Partial<OpReport> = {}) => {
      push(e, outcome, extra);
      if (STOPS_RUN.has(outcome)) report.stoppedOn = String(e.seq);
    };
    if (env.executor === "unknown") {
      finish("not-attempted", { detail: "could not establish whether the target has migration 086 (its status lookup failed); nothing sent — re-run when it answers" });
      continue;
    }

    // ---- held: lookup (+ fence), never replayed --------------------------
    if (held) {
      if (env.executor !== "available") {
        finish("held", { detail: "held for confirmation; the target has no migration 086 (no lookup or fence exists there). Never replayed — an owner reconciles it." });
        continue;
      }
      const verdict = await statusOf(e, key, actor, opArgs, fenceable);
      if (!fenceable && verdict.outcome === "unknown") {
        finish("held", { detail: "its outcome is unknown and whether it was authorised offline cannot be established from the file: looked up only (not on the server yet) — never fenced, never sent. An owner reconciles it." });
      } else {
        finish(verdict.outcome, verdict.extra);
      }
      continue;
    }

    // ---- UUIDv7 on an 086 server: the guarded executor, own actor only ---
    if (isUuidV7(key) && EXECUTOR_RPCS.has(e.opType) && env.executor === "available") {
      if (!bound) {
        finish("held", { detail: "never executed against a backend it was not queued for" });
        continue;
      }
      if (!actor || !env.userId || actor !== env.userId) {
        // Never executed in someone else's session (and never fenced: it
        // was authorised offline). Report what the server knows.
        const verdict = await statusOf(e, key, actor, opArgs, false);
        if (verdict.outcome === "unknown" && !verdict.extra.httpStatus) {
          finish("held", {
            detail: !actor
              ? "no recorded creator: a UUIDv7 operation runs only for its creator; an administrator can only confirm or stop it (held entries). Never replayed."
              : `created by ${actor}; signed in as ${env.userId ?? "an unidentified user"}. Only that user can replay it. Never run in another user's session.`,
          });
        } else finish(verdict.outcome, verdict.extra);
        continue;
      }
      const r = await send(f, `${rest}/rpc/op_execute`, {
        method: "POST", headers: userHeaders, body: JSON.stringify({ p_key: key, p_rpc: e.opType, p_args: opArgs, p_actor_id: actor }),
      }, timeoutMs);
      const verdict = executorVerdict(e, r);
      finish(verdict.outcome, verdict.extra);
      continue;
    }

    // ---- legacy direct path (UUIDv4, a non-executor RPC, or an 085 server) ---
    // Never in another user's session, on any path (stabilization F): the
    // signed-in user is the one the SERVER reports.
    if (actor && actor !== env.userId) {
      finish("held", {
        detail: `created by ${actor}; signed in as ${env.userId ?? "an unidentified user"}. Only that user can replay it (legacy path included). Never run in another user's session.`,
      });
      continue;
    }
    if (typeof args.p_idempotency_key !== "string" || args.p_idempotency_key !== key) {
      push(e, "rejected", { detail: "entry has no original idempotency key; not replayed" });
      continue;
    }
    const known = await ledgerHas(key);
    const before = known === null && e.opType === "complete_sale" ? await saleIdsOfShift(args.p_shift_id) : null;

    const r = await send(f, `${rest}/rpc/${e.opType}`, { method: "POST", headers: userHeaders, body: JSON.stringify(args) }, timeoutMs);
    if (r.error) {
      if (r.error.message.startsWith("OP_EXECUTOR_REQUIRED")) {
        // The server HAS 086 (the probe said otherwise): nothing ran. Never final.
        finish("unknown", { httpStatus: r.status, detail: "the server requires the operation executor for this key (nothing ran); re-run the tool" });
      } else if (/IDEMPOTENCY_KEY_REQUIRED/.test(r.error.message)) {
        push(e, "rejected", { httpStatus: r.status, detail: r.error.message });
      } else if (contractViolation(r.error.message)) {
        // The server holds a decision under this key for a DIFFERENT request
        // (possibly committed): never a plain rejection.
        finish("unknown", { httpStatus: r.status, detail: `the server has a decision under this key with different arguments: ${r.error.message.slice(0, 100)}` });
      } else if (/queued by a different user/i.test(r.error.message)) {
        finish("held", { httpStatus: r.status, detail: "the server says it belongs to another user: only that user can replay it" });
      } else if (isTransientError(r.error, r.status)) {
        finish("not-attempted", { httpStatus: r.status, detail: `transient: ${r.error.message}` });
      } else {
        push(e, "rejected", { httpStatus: r.status, detail: r.error.message });
      }
      continue;
    }
    const data = (r.body ?? {}) as Record<string, unknown>;
    const resultId = mapResult(e, data);
    let outcome: Outcome = "accepted";
    if (known !== null) outcome = known ? "already-applied" : "applied";
    else if (before && typeof resultId === "string") outcome = before.has(resultId) ? "already-applied" : "applied";
    push(e, outcome, { httpStatus: r.status, resultId: typeof resultId === "string" ? resultId : undefined });
  }
  // Online-only operations (never queued) whose outcome is unknown: they may
  // have been applied — never replayed here, but the recovery is not done.
  for (const op of payload.onlineOperations ?? []) {
    report.onlineUnresolved! += 1;
    report.ops.push({
      seq: null, opId: op.id, opType: op.name, idempotencyKey: op.idempotencyKey, outcome: "held",
      detail: `online-only operation, unresolved on the till (it may have been applied${op.backendOrigin ? ` on ${op.backendOrigin}` : ", server not recorded"}): verify it there; never replayed by this tool`,
    });
    report.counts.held++;
  }
  // Records the till could not read: each may be an unresolved payment.
  for (const r of payload.unreadableOnlineRecords ?? []) {
    report.onlineUnresolved! += 1;
    report.ops.push({
      seq: null, opId: r.key, opType: r.claimed.name ?? "unreadable-record", idempotencyKey: null, outcome: "held",
      detail: `online-operation record the till could not read (${r.reason}); it may be an unresolved payment — an owner examines its raw contents; never replayed`,
    });
    report.counts.held++;
  }
  report.finishedAt = now().toISOString();
  return report;
}

export function formatReport(report: ReplayReport): string {
  const lines = [
    `${report.dryRun ? "DRY RUN (nothing sent)" : "Replay"} -> ${report.target}   till ${report.tillId}, exported ${report.exportedAt}`,
    `classification: ${report.classification === "ledger" ? "exact (idempotency ledger read)" : "probe (complete_sale exact; other RPCs 'accepted')"}`,
    "",
    "  seq  op                            key       outcome                  detail",
  ];
  for (const op of report.ops) {
    lines.push(`  ${String(op.seq ?? "-").padStart(3)}  ${op.opType.padEnd(28).slice(0, 28)}  ${shortKey(op.idempotencyKey).padEnd(8)}  ${op.outcome.padEnd(23)}  ${(op.detail ?? op.resultId ?? "").slice(0, 140)}`);
  }
  lines.push("", `totals: ${Object.entries(report.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`).join("  ") || "nothing to do"}`);
  if (report.undecidedSkipped) lines.push(`NOT RECOVERED: ${report.undecidedSkipped} skipped entr${report.undecidedSkipped === 1 ? "y is" : "ies are"} not decided on the server (they may have been applied).`);
  if (report.onlineUnresolved) lines.push(`NOT RECOVERED: ${report.onlineUnresolved} unresolved online-only operation(s) (payments, voids, refund requests) — verify them on their server.`);
  if (report.signedInAs) lines.push(`signed in as (server): ${report.signedInAs.userId ?? "unknown"} (${report.signedInAs.role ?? "no role"}); migration 086: ${report.executor}`);
  if (report.stoppedOn) {
    lines.push(`STOPPED at seq ${report.stoppedOn}: its outcome is not decided (transient failure, in flight, held or unknown). Later entries may depend on it, so none was sent. ` +
      "Resolve it (re-run once the backend answers, or as its creator / an administrator), then re-run the same command (already-applied entries are not repeated).");
  }
  return lines.join("\n");
}

/** Exit status: 0 when every replayable entry succeeded (or was planned). */
export function exitCodeFor(report: ReplayReport): number {
  const bad = report.counts.rejected + report.counts["blocked-unresolved-ref"] + report.counts["not-attempted"] + report.counts["skipped-redacted"] + report.counts["skipped-quarantined"]
    + report.counts["rejected-final"] + report.counts.abandoned + report.counts["in-flight"] + report.counts.unavailable + report.counts.held + report.counts.unknown
    + (report.undecidedSkipped ?? 0);
  return bad > 0 ? 4 : 0;
}

export type { QueueExportEntry };
