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
//     entries may depend on that one; a permanent rejection is reported and
//     the run continues (same policy as the drain).
// It never talks to the till and never deletes or edits anything locally.
// Docs: docs/selfhost-migration/phase-f/queue-export.md.
// ----------------------------------------------------------------------
import { isDuplicateError, isTransientError } from "../../src/lib/errors";
import { assertNotHostedUrl } from "../../src/test/hostedGuard";
import { REDACTED, inQueueOrder, type QueueExportEntry, type QueueExportPayload } from "../../src/lib/queueExport/format";

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
  | "blocked-unresolved-ref"  // depends on an entry that did not succeed / unknown provisional id
  | "not-attempted"           // the run stopped earlier on a transient failure
  | "planned";                // --dry-run

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
  /** Bearer token of the user the entries are replayed as (normally the user who queued them). */
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
    "skipped-redacted": 0, "skipped-quarantined": 0, "skipped-set-aside": 0, "blocked-unresolved-ref": 0, "not-attempted": 0, planned: 0,
  };
}

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
    target: origin, dryRun: Boolean(options.dryRun), startedAt: now().toISOString(), finishedAt: "",
    tillId: payload.tillId, exportedAt: payload.exportedAt,
    classification: ledgerHeaders ? "ledger" : "probe", stoppedOn: null, counts: emptyCounts(), ops: [],
  };
  const push = (e: QueueExportEntry, outcome: Outcome, extra: Partial<OpReport> = {}) => {
    report.ops.push({ seq: e.seq, opId: e.opId, opType: e.opType, idempotencyKey: e.idempotencyKey, outcome, ...extra });
    report.counts[outcome]++;
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

  const ordered = inQueueOrder(payload.entries);
  for (let i = 0; i < ordered.length; i++) {
    const e = ordered[i];
    if (report.stoppedOn) {
      push(e, "not-attempted", { detail: `run stopped at seq ${report.stoppedOn}` });
      continue;
    }
    if (e.status === "archived" && !options.includeSetAside) {
      push(e, "skipped-set-aside", {
        detail: `set aside on the till${e.archivedAt ? ` at ${e.archivedAt}` : ""} (was ${e.statusBeforeArchive ?? "unknown"})${e.archiveReason ? `: ${e.archiveReason}` : ""}`,
      });
      continue;
    }
    // A set-aside entry included on purpose is judged by its former status.
    const status = e.status === "archived" ? e.statusBeforeArchive ?? "pending" : e.status;
    if (status === "quarantined" && !options.includeQuarantined) {
      push(e, "skipped-quarantined", {
        detail: `queued for ${e.backendOrigin ?? "an unrecorded backend (pre-1.0.16 build)"}; ${e.quarantineReason ?? "quarantined by the till"}`,
      });
      continue;
    }
    if (status === "conflict" && !options.includeConflicts) {
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
    if (options.dryRun) {
      // A ref whose parent is replayed earlier in this run resolves at run time.
      const pendingRef = unresolved && ordered.slice(0, i).some((p) => p.provisional.some((pp) => e.refs.some((r) => pp.ids.includes(r.provisionalId))));
      push(e, unresolved && !pendingRef ? "blocked-unresolved-ref" : "planned", {
        detail: `${e.kind === "rpc" ? `rpc ${e.opType}` : `${e.tableOp} ${e.table}`} key ${shortKey(e.idempotencyKey)}${pendingRef ? " (ref resolves from an earlier entry)" : ""}${unresolved && !pendingRef ? `: ${unresolved}` : ""}`,
      });
      continue;
    }
    if (unresolved) {
      push(e, "blocked-unresolved-ref", { detail: unresolved });
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
    if (typeof args.p_idempotency_key !== "string" || args.p_idempotency_key !== e.idempotencyKey) {
      // Never mint a new key: that would turn a replay into a new operation.
      push(e, "rejected", { detail: "entry has no original idempotency key; not replayed" });
      continue;
    }
    const known = await ledgerHas(e.idempotencyKey);
    const before = known === null && e.opType === "complete_sale" ? await saleIdsOfShift(args.p_shift_id) : null;

    const r = await send(f, `${rest}/rpc/${e.opType}`, { method: "POST", headers: userHeaders, body: JSON.stringify(args) }, timeoutMs);
    if (r.error) {
      if (!contractViolation(r.error.message) && isTransientError(r.error, r.status)) {
        push(e, "not-attempted", { httpStatus: r.status, detail: `transient: ${r.error.message}` });
        report.stoppedOn = String(e.seq);
      } else {
        push(e, "rejected", { httpStatus: r.status, detail: r.error.message });
      }
      continue;
    }
    const data = (r.body ?? {}) as Record<string, unknown>;
    const mapper = ID_FROM_RESPONSE[e.opType];
    const resultId = mapper ? mapper.id(data) : undefined;
    if (mapper && typeof resultId === "string") {
      for (const p of e.provisional.filter((pp) => pp.table === mapper.table)) {
        if (p.ids[0]) idMap.set(p.ids[0], resultId);
      }
    }
    let outcome: Outcome = "accepted";
    if (known !== null) outcome = known ? "already-applied" : "applied";
    else if (before && typeof resultId === "string") outcome = before.has(resultId) ? "already-applied" : "applied";
    push(e, outcome, { httpStatus: r.status, resultId: typeof resultId === "string" ? resultId : undefined });
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
  if (report.stoppedOn) lines.push(`STOPPED at seq ${report.stoppedOn} on a transient failure: re-run the same command once the backend answers (already-applied entries are not repeated).`);
  return lines.join("\n");
}

/** Exit status: 0 when every replayable entry succeeded (or was planned). */
export function exitCodeFor(report: ReplayReport): number {
  const bad = report.counts.rejected + report.counts["blocked-unresolved-ref"] + report.counts["not-attempted"] + report.counts["skipped-redacted"] + report.counts["skipped-quarantined"];
  return bad > 0 ? 4 : 0;
}

export type { QueueExportEntry };
