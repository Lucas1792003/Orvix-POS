// ----------------------------------------------------------------------
// Test double for the supabase-js client, shaped the way supabase-js
// actually behaves (see outbox.reliability.test.ts for usage):
//
//  - rpc() RESOLVES with `{ data, error, status }` — a fetch failure comes
//    back as `{ data: null, error: { message: "TypeError: Failed to fetch",
//    code: "" }, status: 0 }`, never as a rejected promise;
//  - the returned object is a thenable builder with `abortSignal()`, like
//    PostgrestFilterBuilder, so runRequest()'s abort wiring is exercised;
//  - an in-memory "server" emulates the Phase D idempotency contract
//    (docs/selfhost-migration/phase-d/idempotency-contract.md): same key +
//    same request hash → the stored response, no new side effect; same key
//    + different hash → IDEMPOTENCY_MISMATCH; missing key →
//    IDEMPOTENCY_KEY_REQUIRED; a failed call leaves no key row;
//  - per-call outcome modes: succeed, network-error, commit-then-timeout
//    (apply the side effect and store the response, then lose the reply),
//    permanent-error, jwt-expired (401 / PGRST301), gateway-502,
//    server-500, hang;
//  - auth.getSession / refreshSession with controllable outcomes and an
//    onAuthStateChange registry so a test can emit SIGNED_IN;
//  - from("inventory").select("*")[.eq("shop_id", id)] reading the same
//    in-memory `server.inventory` the RPC handlers write (Phase G
//    reconciliation tests), with a controllable failure mode;
//  - read-only RPCs (`resolve_event_time` → server now(), `app_setup_needed`)
//    that bypass the idempotency ledger like the real ones do;
//  - channel()/removeChannel() returning a controllable Realtime channel
//    (`fakeSupabase.realtime`): a test drives the subscribe() status
//    callback and emits postgres_changes payloads;
//  - migration 086 (off by default — like a server at 085, op_execute /
//    op_status answer PGRST202): `enableExecutor()` turns on op_execute
//    (durable rejected rows, replay, mismatch, withheld replies for another
//    actor) and op_status (lookup + fence). "permanent-error" through the
//    executor is a DEFINITIVE refusal and is recorded; "dependency-error" is
//    not recorded. op_execute runs an operation only for its own actor
//    (p_actor_id), requires it for UUIDv7 keys, and a UUIDv7 key sent to a
//    legacy RPC is refused (OP_EXECUTOR_REQUIRED), as in migration 086.
//  - migration 087 (off by default — recovery_epoch etc. answer PGRST202,
//    like a server without 087): `enable087()` emulates the recovery hold as
//    supabase/migrations/087_recovery_hold.sql defines it — the server gate
//    (lease, state), till auth, witnesses (AHEAD commits a hold and answers
//    {outcome:'held'}), per-organisation holds and epochs, the old-operation
//    rule (op_epoch, quarantine), op_execute_v87 / op_status_v87 (fence),
//    recovery_epoch, recovery_register_till (MFA admin), journal chunks
//    (idempotent, conflict, quota, quarantine), recovery_approve_till
//    (complete journal, not the submitter). Legacy paths (op_execute, a
//    direct executor RPC) answer 429 CLIENT_UPGRADE_REQUIRED. Every refusal
//    is HTTP 429 {code: PT429, message: "ORG_SUSPENDED: server recovery in
//    progress [CODE]"}.
//
// No vitest imports here, so the module also type-checks in the app
// build; it is only ever imported by tests.
// ----------------------------------------------------------------------

import { createFakePostgrest } from "./fakePostgrest";
import { validReply } from "./validReplies";

export type RpcMode =
  | "succeed"
  | "network-error"
  | "commit-then-timeout"
  | "permanent-error"
  | "jwt-expired"
  | "gateway-502"
  | "server-500"
  | "hang"
  /** The server applies the request, then the reply never arrives (crash after commit). */
  | "commit-then-hang"
  /** 086: refused because a prerequisite is missing — never recorded (op_not_recorded:dependency). */
  | "dependency-error";

export interface RecordedCall {
  name: string;
  args: Record<string, unknown>;
  mode: RpcMode;
  /** True when the server answered from its idempotency ledger. */
  replayed: boolean;
}

interface ServerSale {
  id: string;
  shopId: string;
  shiftId: string;
  receiptNo: string;
  totalMmk: number;
  idempotencyKey: string;
}

export interface FakeServerState {
  sales: ServerSale[];
  inventory: Map<string, number>; // `${shopId}:${productId}` -> qty
  payments: { id: string; purchaseOrderId: string; amountMmk: number }[];
  purchaseOrders: Map<string, { id: string; totalMmk: number; paidMmk: number }>;
  shifts: { id: string; shopId: string }[];
  idempotency: Map<string, {
    rpc: string; hash: string; response: unknown;
    /** 086 */
    state?: "committed" | "rejected" | "abandoned"; actor?: string | null; code?: string; message?: string; purged?: boolean;
  }>;
  executions: Record<string, number>; // real side effects per RPC name
  seq: number;
}

type AuthSessionMode = "valid" | "expired" | "none" | "none-network-error" | "none-auth-error";
type AuthRefreshMode = "ok" | "network" | "invalid";
type SelectMode = "succeed" | "network-error";

/** RPCs that are plain reads on the real server: no idempotency key, no
 *  ledger row, no side effect. */
const READ_ONLY_RPCS = new Set(["resolve_event_time", "app_setup_needed"]);

export interface FakeRealtimePayload {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  shopId: string;
  productId: string;
  qty?: number;
  /** Server commit time of the change (ISO). Defaults to the fake server's now(). */
  commitTimestamp?: string;
}

type ChangeListener = (payload: Record<string, unknown>) => void;
type StatusListener = (status: string, err?: Error) => void;

export interface FakeRealtimeChannel {
  readonly name: string;
  removed: boolean;
  subscribeCalls: number;
  on: (type: string, filter: Record<string, unknown>, cb: ChangeListener) => FakeRealtimeChannel;
  subscribe: (cb?: StatusListener) => FakeRealtimeChannel;
  /** Test control: fire the subscribe() status callback. */
  emitStatus: (status: "SUBSCRIBED" | "CHANNEL_ERROR" | "TIMED_OUT" | "CLOSED", err?: Error) => void;
  /** Test control: deliver a postgres_changes event to every binding. */
  emitChange: (change: FakeRealtimePayload) => void;
}

const freshServer = (): FakeServerState => ({
  sales: [], inventory: new Map(), payments: [], purchaseOrders: new Map(), shifts: [],
  idempotency: new Map(), executions: {}, seq: 0,
});

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([k]) => k !== "p_idempotency_key" && k !== "p_created_at")
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
};

const NETWORK_FAILURE = {
  data: null, status: 0, statusText: "",
  error: { message: "TypeError: Failed to fetch", details: "TypeError: Failed to fetch", hint: "", code: "" },
};

function createFakeSupabase() {
  let server = freshServer();
  const calls: RecordedCall[] = [];
  const queuedModes: RpcMode[] = [];
  // Exact raw replies for the next calls (no side effect), e.g. a PT503.
  const queuedReplies: Record<string, unknown>[] = [];
  let defaultMode: RpcMode = "succeed";
  let sessionMode: AuthSessionMode = "valid";
  let refreshMode: AuthRefreshMode = "ok";
  let refreshCalls = 0;
  const authListeners: ((event: string, session: unknown) => void)[] = [];
  const authUser = { id: "auth-test-user", email: "cashier@shop.test" };
  let selectMode: SelectMode = "succeed";
  let selectCalls = 0;
  // Test hook run before each select request (each page) is answered, with
  // the 0-based request number since the last reset: lets a test change the
  // server or deliver a Realtime event BETWEEN the pages of one read.
  let selectHook: ((request: number) => void) | null = null;
  // The fake server's clock, independent of the client's Date.now() so a
  // test can put the two far apart (the client clock must never matter).
  let serverClockOffsetMs = 0;
  // Migration 086 emulation.
  let executor = false;
  let caller = { id: "user-1", admin: false, org: "org-1", aal2: false };
  // the server's message for a definitive refusal ("permanent-error")
  let rejectionMessage = "Insufficient stock for Tea Mix";
  const executing = new Set<string>(); // keys whose execution has not returned (hang modes)
  const serverNow = (): string => new Date(Date.now() + serverClockOffsetMs).toISOString();
  const channels: FakeRealtimeChannel[] = [];

  const validSession = () => ({ user: authUser, access_token: "jwt", refresh_token: "rt", expires_at: Math.floor(Date.now() / 1000) + 3600 });
  const expiredSession = () => ({ user: authUser, access_token: "jwt", refresh_token: "rt", expires_at: Math.floor(Date.now() / 1000) - 60 });

  // ---- RPC handlers: the "business" side effects, one per in-scope RPC ----
  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    complete_sale: (args) => {
      const seq = ++server.seq;
      const shopId = String(args.p_shop_id);
      const items = (args.p_items as { product_id: string; qty: number; units_per_item: number }[]) ?? [];
      const inventory: { shopId: string; productId: string; qtyBaseUnits: number }[] = [];
      const movements: { id: string; shopId: string; productId: string }[] = [];
      for (const item of items) {
        const key = `${shopId}:${item.product_id}`;
        const before = server.inventory.get(key) ?? 0;
        const after = before - item.qty * item.units_per_item;
        server.inventory.set(key, after);
        inventory.push({ shopId, productId: item.product_id, qtyBaseUnits: after });
        movements.push({ id: `mv-server-${seq}-${item.product_id}`, shopId, productId: item.product_id });
      }
      const sale: ServerSale = {
        id: `sale-server-${seq}`, shopId, shiftId: String(args.p_shift_id), receiptNo: `R-${seq}`,
        totalMmk: items.reduce((sum, i) => sum + i.qty * 1000, 0), idempotencyKey: String(args.p_idempotency_key),
      };
      server.sales.push(sale);
      return {
        sale, items: items.map((i, n) => ({ id: `si-server-${seq}-${n}`, saleId: sale.id, productId: i.product_id })),
        movements, inventory, auditLogs: [{ id: `au-server-${seq}` }], shopName: "Shop", cashierName: "Cashier",
      };
    },
    adjust_stock: (args) => {
      const seq = ++server.seq;
      const key = `${args.p_shop_id}:${args.p_product_id}`;
      const after = (server.inventory.get(key) ?? 0) + Number(args.p_quantity_delta);
      server.inventory.set(key, after);
      return {
        inventory: { shopId: args.p_shop_id, productId: args.p_product_id, qtyBaseUnits: after },
        movement: { id: `mv-server-${seq}`, shopId: args.p_shop_id, productId: args.p_product_id },
        auditLog: { id: `au-server-${seq}` },
      };
    },
    record_supplier_payment: (args) => {
      const seq = ++server.seq;
      const poId = String(args.p_purchase_order_id);
      const po = server.purchaseOrders.get(poId) ?? { id: poId, totalMmk: 10_000, paidMmk: 0 };
      po.paidMmk += Number(args.p_amount_mmk);
      server.purchaseOrders.set(poId, po);
      const payment = { id: `suppay-server-${seq}`, purchaseOrderId: poId, amountMmk: Number(args.p_amount_mmk) };
      server.payments.push(payment);
      return {
        purchaseOrder: { id: poId, status: "RECEIVED", totalMmk: po.totalMmk, paidMmk: po.paidMmk, paymentStatus: po.paidMmk >= po.totalMmk ? "PAID" : "PARTIAL" },
        supplierPayment: payment, auditLogs: [],
      };
    },
    open_shift: (args) => {
      const seq = ++server.seq;
      const shift = { id: `shift-server-${seq}`, shopId: String(args.p_shop_id), cashierId: "user-1", startedAt: "t0", openingCashMmk: Number(args.p_opening_cash_mmk) };
      server.shifts.push(shift);
      return { shift, auditLogs: [] };
    },
  };

  const isV7 = (key: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/i.test(key);
  const execute = (name: string, args: Record<string, unknown>, viaExecutor = false) => {
    const key = args.p_idempotency_key;
    if (typeof key !== "string") {
      return { data: null, status: 400, error: { message: "IDEMPOTENCY_KEY_REQUIRED", code: "22023", details: null, hint: null }, replayed: false };
    }
    if (executor && !viaExecutor && isV7(key) && name !== "create_app_user") {
      return {
        data: null, status: 400, replayed: false,
        error: { message: "OP_EXECUTOR_REQUIRED: this operation must be sent through op_execute", code: "22023", details: null, hint: null },
      };
    }
    const hash = canonical(args);
    const existing = server.idempotency.get(key);
    if (existing) {
      if (existing.rpc !== name || existing.hash !== hash) {
        return {
          data: null, status: 409, replayed: false,
          error: { message: `IDEMPOTENCY_MISMATCH: key ${key} was used for a different request`, code: "23505", details: null, hint: null },
        };
      }
      return { data: existing.response, error: null, status: 200, replayed: true };
    }
    // RPCs without a modelled side effect answer with a minimal VALID reply
    // (testing/validReplies.ts) — replies are validated since Batch 2A.
    const handler = handlers[name] ?? (() => validReply(name));
    const response = handler(args);
    server.executions[name] = (server.executions[name] ?? 0) + 1;
    server.idempotency.set(key, { rpc: name, hash, response, state: "committed", actor: caller.id });
    return { data: response, error: null, status: 200, replayed: false };
  };

  const MISSING_FUNCTION = (fn: string) => ({
    data: null, status: 404, replayed: false,
    error: { message: `Could not find the function public.${fn} in the schema cache`, code: "PGRST202", details: null, hint: null },
  });

  /** op_execute, as migration 086 defines it (definitive refusals = "permanent-error"). */
  const executorRun = (args: Record<string, unknown>, mode: RpcMode) => {
    const key = String(args.p_key);
    const rpcName = String(args.p_rpc);
    const full = { ...(args.p_args as Record<string, unknown>), p_idempotency_key: key };
    const hash = canonical(full);
    const existing = server.idempotency.get(key);
    const ok = (data: unknown, replayed: boolean) => ({ data, error: null, status: 200, replayed });
    const fail = (message: string, code = "22023", hint: string | null = null) =>
      ({ data: null, status: 400, replayed: false, error: { message, code, details: null, hint } });
    const actor = args.p_actor_id;
    if (typeof actor === "string" && actor !== caller.id) return fail("OP_ACTOR_MISMATCH: this operation belongs to another user");
    if (typeof actor !== "string" && isV7(key)) return fail("OP_ACTOR_REQUIRED");
    if (existing) {
      if (existing.rpc !== rpcName) return ok({ outcome: "mismatch" }, false);
      const state = existing.state ?? "committed";
      if (state === "abandoned") return ok({ outcome: "abandoned", replayed: true }, true);
      if (existing.hash.replace(/^R:/, "") !== hash) return ok({ outcome: "mismatch" }, false);
      const maySee = existing.actor === caller.id || caller.admin;
      if (state === "rejected") {
        return ok({ outcome: "rejected", replayed: true, code: maySee ? existing.code : null, message: maySee ? existing.message : null, withheld: !maySee }, true);
      }
      return ok({
        outcome: "committed", replayed: true, response: maySee && !existing.purged ? existing.response : null,
        withheld: !maySee, response_purged: existing.purged === true,
      }, true);
    }
    if (mode === "dependency-error") return fail("Shift not found", "P0001", "op_not_recorded:dependency");
    if (mode === "permanent-error") {
      server.idempotency.set(key, { rpc: rpcName, hash: `R:${hash}`, response: null, state: "rejected", actor: caller.id, code: "P0001", message: rejectionMessage });
      return ok({ outcome: "rejected", replayed: false, code: "P0001", message: rejectionMessage }, false);
    }
    const result = execute(rpcName, full, true);
    return ok({ outcome: "committed", replayed: false, response: result.data }, false);
  };

  /** op_status (+ fence), as migration 086 defines it. */
  const statusRun = (args: Record<string, unknown>) => {
    const key = String(args.p_key);
    const ok = (data: unknown) => ({ data, error: null, status: 200, replayed: false });
    if (executing.has(key)) return ok({ status: "in_flight" });
    const existing = server.idempotency.get(key);
    if (existing) {
      if (existing.rpc !== args.p_rpc) return ok({ status: "unavailable" });
      const maySee = existing.actor === caller.id || caller.admin;
      const state = existing.state ?? "committed";
      return ok({
        status: state, response: maySee && state === "committed" && !existing.purged ? existing.response : null,
        code: maySee && state === "rejected" ? existing.code : null, message: maySee && state === "rejected" ? existing.message : null,
        withheld: !maySee, response_purged: existing.purged === true,
      });
    }
    if (args.p_fence !== true) return ok({ status: "not_found", executable: true });   // NULL / false: a lookup
    const actor = args.p_expected_actor_id;
    // Own operation; ADMIN for a user of the org; ADMIN for an actor-less
    // legacy entry only with the operation's arguments as evidence.
    const allowed = (typeof actor === "string" && (actor === caller.id || caller.admin))
      || (actor == null && caller.admin && args.p_args != null);
    if (!allowed) return ok({ status: "not_found", fenced: false, reason: "not_authorized" });
    server.idempotency.set(key, { rpc: String(args.p_rpc), hash: "A:", response: null, state: "abandoned", actor: (actor as string | null) ?? null, code: "FENCED" });
    return ok({ status: "abandoned", fenced: true });
  };

  // ---- Migration 087 emulation ----------------------------------------------
  type Org87 = { epochNo: number; epoch: string; held: boolean; chain: string[]; epochStartedAt: number };
  type Till87 = { org: string; secret: string; reconciledEpochNo: number };
  type Chunk87 = { payload: string; final: boolean; submittedBy: string; bytes: number };
  const fresh87 = () => ({
    enabled: false, lease: true, state: "open" as "open" | "hold", legacyOpen: false,
    orgs: new Map<string, Org87>(), tills: new Map<string, Till87>(),
    journal: new Map<string, Chunk87>(),                 // `${org}|${till}|${epochNo}|${chunk}`
    quarantine: new Map<string, string>(),               // `${org}|${key}` -> till
    quotaBytes: 52_428_800, seq: 0,
  });
  let r87 = fresh87();
  const PT429 = (code: string) => ({
    data: null, status: 429, replayed: false,
    error: { message: `ORG_SUSPENDED: server recovery in progress [${code}]`, code: "PT429", details: null, hint: null },
  });
  const org87 = (org: string): Org87 => {
    let o = r87.orgs.get(org);
    if (!o) { o = { epochNo: 0, epoch: `epoch-${org}-0`, held: false, chain: [], epochStartedAt: Date.now() }; r87.orgs.set(org, o); }
    return o;
  };
  const bump87 = (org: string) => {
    const o = org87(org);
    o.held = true; o.epochNo += 1; o.epoch = `epoch-${org}-${o.epochNo}-${++r87.seq}`; o.epochStartedAt = Date.now();
  };
  const mac87 = (org: string, epochNo: number, n: number, h: string) => `fake-mac:${org}:${epochNo}:${n}:${h}`;
  const witness87 = (org: string) => {
    const o = org87(org);
    const n = o.chain.length;
    const h = n ? o.chain[n - 1] : "00".repeat(32);
    return { org, epoch_no: o.epochNo, n, h, mac: mac87(org, o.epochNo, n, h) };
  };
  const checkWitness87 = (org: string, w: unknown): null | "MISSING" | "INVALID" | "STALE" | "AHEAD" => {
    const o = org87(org);
    const x = (w && typeof w === "object" ? w : null) as Record<string, unknown> | null;
    if (!x) return "MISSING";
    if (x.org !== org || typeof x.n !== "number" || typeof x.epoch_no !== "number" || x.mac !== mac87(org, x.epoch_no, x.n, String(x.h))) return "INVALID";
    if (x.epoch_no > o.epochNo) return "AHEAD";
    if (x.epoch_no < o.epochNo) return "STALE";
    if (x.n > o.chain.length) return "AHEAD";
    if (x.n > 0 && o.chain[x.n - 1] !== x.h) return "AHEAD";
    return null;
  };
  const serverGate87 = (): ReturnType<typeof PT429> | null =>
    !r87.lease ? PT429("LEASE_INVALID") : r87.state !== "open" ? PT429("RECOVERY_HOLD") : null;
  const tillAuth87 = (org: string, ctx: Record<string, unknown>): Till87 | null => {
    const t = r87.tills.get(`${org}|${String(ctx?.till ?? "")}`);
    return t && t.secret === String(ctx?.till_secret ?? "") ? t : null;
  };
  const isOld87 = (org: string, key: string, ctx: Record<string, unknown>): boolean => {
    const o = org87(org);
    if (String(ctx?.op_epoch ?? "") !== o.epoch) return true;
    if (r87.quarantine.has(`${org}|${key.toLowerCase()}`)) return true;
    if (isV7(key)) {
      const ms = parseInt(key.replace(/-/g, "").slice(0, 12), 16);
      if (ms < o.epochStartedAt - 5 * 60_000) return true;
    }
    return false;
  };
  /** v87_begin: null = proceed; otherwise the reply to return (refusal or committed hold). */
  const begin87 = (key: string, ctx: Record<string, unknown>) => {
    const org = caller.org;
    const gate = serverGate87();
    if (gate) return gate;
    const till = tillAuth87(org, ctx);
    if (!till) return PT429("TILL_UNKNOWN");
    const o = org87(org);
    const w = checkWitness87(org, ctx?.witness);
    if (w === "AHEAD") {
      if (!o.held) bump87(org);
      return { data: { outcome: "held", code: "CONTINUITY_ROLLBACK", org, key, sig: "fake-sig" }, error: null, status: 200, replayed: false };
    }
    if (w === "INVALID") return PT429("WITNESS_INVALID");
    if (o.held) return PT429("RECOVERY_HOLD");
    if (w === "MISSING" || w === "STALE" || till.reconciledEpochNo !== o.epochNo) return PT429("TILL_NOT_RECONCILED");
    if (isOld87(org, key, ctx)) return PT429("PRE_EPOCH_OPERATION");
    return null;
  };
  const finish87 = (reply: { data: unknown; error: unknown; status: number; replayed: boolean }, key: string, rpc: string) => {
    const org = caller.org;
    const d = (reply.data ?? {}) as Record<string, unknown>;
    if (!reply.error && d.outcome === "committed" && !d.replayed) org87(org).chain.push(`h-${org}-${org87(org).chain.length + 1}-${key}`);
    if (!reply.error && (d.outcome === "rejected" && !d.replayed)) org87(org).chain.push(`h-${org}-${org87(org).chain.length + 1}-${key}`);
    if (reply.error) return reply;
    const signed = { org, key, rpc, epoch_no: org87(org).epochNo, outcome: d.outcome ?? d.status ?? null };
    return { ...reply, data: { ...d, signed, sig: `fake-reply-sig:${key}`, witness: witness87(org) } };
  };
  const respond87 = (name: string, args: Record<string, unknown>, mode: RpcMode): ReturnType<typeof PT429> | { data: unknown; error: unknown; status: number; replayed: boolean } | null => {
    const RECOVERY_FNS = new Set(["recovery_epoch", "recovery_register_till", "recovery_submit_journal", "recovery_approve_till", "op_execute_v87", "op_status_v87"]);
    if (!r87.enabled) return RECOVERY_FNS.has(name) ? { ...MISSING_FUNCTION(name) } : null;
    const org = caller.org;
    const ok = (data: unknown) => ({ data, error: null, status: 200, replayed: false });
    if (mode === "network-error" && RECOVERY_FNS.has(name)) return { ...NETWORK_FAILURE, replayed: false };
    switch (name) {
      case "recovery_epoch": {
        const ctx = (args.p_ctx ?? {}) as Record<string, unknown>;
        const till = tillAuth87(org, ctx);
        if (!till) return PT429("TILL_UNKNOWN");
        const o = org87(org);
        if (till.reconciledEpochNo !== o.epochNo) return PT429("TILL_NOT_RECONCILED");
        const gate = serverGate87();
        if (gate) return gate;
        if (o.held) return PT429("RECOVERY_HOLD");
        return ok({ epoch: o.epoch, epoch_no: o.epochNo, witness: witness87(org) });
      }
      case "recovery_register_till": {
        if (!caller.admin || !caller.aal2) return { data: null, status: 403, replayed: false, error: { message: "RECOVERY_ADMIN_MFA_REQUIRED", code: "42501", details: null, hint: null } };
        const id = String(args.p_till);
        if (r87.tills.has(`${org}|${id}`)) return { data: null, status: 409, replayed: false, error: { message: "duplicate key value violates unique constraint \"tills_pkey\"", code: "23505", details: null, hint: null } };
        const secret = `secret-${id}-${++r87.seq}`;
        r87.tills.set(`${org}|${id}`, { org, secret, reconciledEpochNo: -1 });
        return ok({ till: id, till_secret: secret });
      }
      case "recovery_submit_journal": {
        const ctx = (args.p_ctx ?? {}) as Record<string, unknown>;
        const till = tillAuth87(org, ctx);
        if (!till) return PT429("TILL_UNKNOWN");
        const o = org87(org);
        if (till.reconciledEpochNo === o.epochNo) return ok({ outcome: "not_required" });
        const payload = canonical(args.p_chunk);
        const bytes = JSON.stringify(args.p_chunk).length;
        if (bytes > 262_144) return ok({ outcome: "chunk_too_large" });
        const k = `${org}|${String(ctx.till)}|${o.epochNo}|${Number(args.p_chunk_no)}`;
        const existing = r87.journal.get(k);
        if (existing) return ok({ outcome: existing.payload === payload ? "already_stored" : "conflict" });
        const used = [...r87.journal.entries()].filter(([kk]) => kk.startsWith(`${org}|`)).reduce((a, [, c]) => a + c.bytes, 0);
        if (used + bytes > r87.quotaBytes) return ok({ outcome: "quota_exceeded", stored: false });
        const recs = ((args.p_chunk as Record<string, unknown>)?.records ?? []) as Record<string, unknown>[];
        for (const r of recs) {
          if (r.key == null) continue;
          if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(r.key))) {
            return { data: null, status: 400, replayed: false, error: { message: "invalid input syntax for type uuid", code: "22P02", details: null, hint: null } };
          }
        }
        r87.journal.set(k, { payload, final: args.p_final === true, submittedBy: caller.id, bytes });
        for (const r of recs) if (r.key != null) r87.quarantine.set(`${org}|${String(r.key).toLowerCase()}`, String(ctx.till));
        return ok({ outcome: "stored" });
      }
      case "recovery_approve_till": {
        if (!caller.admin || !caller.aal2) return { data: null, status: 403, replayed: false, error: { message: "RECOVERY_ADMIN_MFA_REQUIRED", code: "42501", details: null, hint: null } };
        const id = String(args.p_till);
        const t = r87.tills.get(`${org}|${id}`);
        const o = org87(org);
        const chunks = [...r87.journal.entries()].filter(([kk]) => kk.startsWith(`${org}|${id}|${o.epochNo}|`))
          .map(([kk, c]) => ({ n: Number(kk.split("|")[3]), ...c }));
        const max = Math.max(0, ...chunks.map((c) => c.n));
        if (!t || chunks.length === 0 || chunks.length !== max || !chunks.find((c) => c.n === max)?.final) {
          return { data: null, status: 400, replayed: false, error: { message: "RECOVERY_JOURNAL_INCOMPLETE: chunks 1..n must all be stored and chunk n final", code: "22023", details: null, hint: null } };
        }
        if (chunks.some((c) => c.submittedBy === caller.id)) return { data: null, status: 403, replayed: false, error: { message: "RECOVERY_SELF_APPROVAL", code: "42501", details: null, hint: null } };
        t.reconciledEpochNo = o.epochNo;
        return ok({ till: id, reconciled_epoch_no: o.epochNo });
      }
      case "op_execute_v87": {
        const key = String(args.p_key);
        const stop = begin87(key, (args.p_ctx ?? {}) as Record<string, unknown>);
        if (stop) return stop;
        const inner = respond("op_execute", { p_key: args.p_key, p_rpc: args.p_rpc, p_args: args.p_args, p_actor_id: args.p_actor_id }, mode, true);
        return finish87(inner, key, String(args.p_rpc));
      }
      case "op_status_v87": {
        const key = String(args.p_key);
        if (args.p_fence !== true) return respond("op_status", { ...args }, mode, true);
        const stop = begin87(key, (args.p_ctx ?? {}) as Record<string, unknown>);
        if (stop) return stop;
        const inner = respond("op_status", { ...args, p_fence: true }, mode, true);
        const d = (inner.data ?? {}) as Record<string, unknown>;
        if (!inner.error && d.fenced !== true) return PT429("FENCE_NOT_APPLIED");
        return finish87(inner, key, String(args.p_rpc));
      }
      case "op_execute":
        return r87.legacyOpen ? null : PT429("CLIENT_UPGRADE_REQUIRED");
      case "op_status":
        return args.p_fence === true && !r87.legacyOpen ? PT429("CLIENT_UPGRADE_REQUIRED") : null;
      default:
        // a direct executor RPC (RC3 path) is closed too
        return handlers[name] && !r87.legacyOpen ? PT429("CLIENT_UPGRADE_REQUIRED") : null;
    }
  };

  const respond = (name: string, args: Record<string, unknown>, mode: RpcMode, inner87 = false): { data: unknown; error: unknown; status: number; replayed: boolean } => {
    if (!inner87) {
      const r = respond87(name, args, mode);
      if (r) return r as { data: unknown; error: unknown; status: number; replayed: boolean };
    }
    if (name === "op_execute" || name === "op_status") {
      if (!executor && !(inner87 && r87.enabled)) return MISSING_FUNCTION(name);
      if (name === "op_status" && mode === "network-error") return { ...NETWORK_FAILURE, replayed: false };
      if (name === "op_status" && mode !== "jwt-expired") return statusRun(args);
      if (name === "op_status") return { data: null, status: 401, replayed: false, error: { message: "JWT expired", code: "PGRST301", details: null, hint: null } };
      switch (mode) {
        case "network-error": return { ...NETWORK_FAILURE, replayed: false };
        case "commit-then-timeout": { executorRun(args, "succeed"); return { ...NETWORK_FAILURE, replayed: false }; }
        case "jwt-expired":
        case "gateway-502":
        case "server-500":
          break; // as for any RPC (below)
        default:
          return executorRun(args, mode);
      }
    }
    switch (mode) {
      case "network-error":
        return { ...NETWORK_FAILURE, replayed: false };
      case "commit-then-timeout": {
        const result = execute(name, args);
        return { ...NETWORK_FAILURE, replayed: result.replayed };
      }
      case "permanent-error":
        return { data: null, status: 400, replayed: false, error: { message: rejectionMessage, code: "P0001", details: null, hint: null } };
      case "dependency-error":
        return { data: null, status: 400, replayed: false, error: { message: "Shift not found", code: "P0001", details: null, hint: null } };
      case "jwt-expired":
        return { data: null, status: 401, replayed: false, error: { message: "JWT expired", code: "PGRST301", details: null, hint: null } };
      case "gateway-502":
        return { data: null, status: 502, replayed: false, error: { message: "<html><body>502 Bad Gateway</body></html>", code: "", details: "", hint: "" } };
      case "server-500":
        return { data: null, status: 500, replayed: false, error: { message: "internal server error", code: "", details: "", hint: "" } };
      case "succeed":
      case "hang":
      case "commit-then-hang": // never reached: its reply never arrives
        return execute(name, args);
    }
  };

  const readOnlyRpc = (name: string): { data: unknown; error: null; status: number } => {
    switch (name) {
      case "resolve_event_time":
        return { data: serverNow(), error: null, status: 200 };
      case "app_setup_needed":
        return { data: false, error: null, status: 200 };
      default:
        return { data: null, error: null, status: 200 };
    }
  };

  const rpc = (name: string, args: Record<string, unknown> = {}) => {
    if (READ_ONLY_RPCS.has(name)) {
      const mode: RpcMode = queuedModes.shift() ?? defaultMode;
      calls.push({ name, args, mode, replayed: false });
      const response = mode === "network-error" ? NETWORK_FAILURE : readOnlyRpc(name);
      const promise = Promise.resolve(response);
      const builder = {
        abortSignal: () => builder,
        then<T1 = unknown, T2 = never>(
          onfulfilled?: ((value: unknown) => T1 | PromiseLike<T1>) | null,
          onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
        ): Promise<T1 | T2> {
          return promise.then(onfulfilled, onrejected);
        },
      };
      return builder;
    }
    const mode = queuedModes.shift() ?? defaultMode;
    const call: RecordedCall = { name, args, mode, replayed: false };
    calls.push(call);
    const raw = queuedReplies.shift();
    if (raw) {
      const builder = {
        abortSignal: () => builder,
        then<T1 = unknown, T2 = never>(
          onfulfilled?: ((value: unknown) => T1 | PromiseLike<T1>) | null,
          onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
        ): Promise<T1 | T2> {
          return Promise.resolve(raw).then(onfulfilled, onrejected);
        },
      };
      return builder;
    }
    if (mode === "commit-then-hang") {
      if (name === "op_execute" && executor) executorRun(args, "succeed");
      else execute(name, args);
    }
    if (mode === "hang" && name === "op_execute" && executor) executing.add(String(args.p_key));
    const promise: Promise<unknown> = mode === "hang" || mode === "commit-then-hang"
      ? new Promise(() => undefined)
      : Promise.resolve().then(() => {
          const { replayed, ...response } = respond(name, args, mode);
          call.replayed = replayed;
          return response;
        });
    // Thenable builder, like PostgrestFilterBuilder: abortSignal() returns
    // the builder; awaiting it resolves the response.
    const builder = {
      abortSignal(signal: AbortSignal) {
        void signal; // accepted like the real builder; the fake never aborts
        return builder;
      },
      then<T1 = unknown, T2 = never>(
        onfulfilled?: ((value: unknown) => T1 | PromiseLike<T1>) | null,
        onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
      ): Promise<T1 | T2> {
        return promise.then(onfulfilled, onrejected);
      },
    };
    return builder;
  };

  const auth = {
    getSession: async () => {
      switch (sessionMode) {
        case "valid": return { data: { session: validSession() }, error: null };
        case "expired": return { data: { session: expiredSession() }, error: null };
        case "none": return { data: { session: null }, error: null };
        case "none-network-error":
          return { data: { session: null }, error: { name: "AuthRetryableFetchError", message: "Failed to fetch", status: 0 } };
        case "none-auth-error":
          return { data: { session: null }, error: { name: "AuthApiError", message: "Invalid Refresh Token: Already Used", status: 400, code: "refresh_token_already_used" } };
      }
    },
    refreshSession: async () => {
      refreshCalls += 1;
      switch (refreshMode) {
        case "ok":
          sessionMode = "valid";
          return { data: { session: validSession(), user: authUser }, error: null };
        case "network":
          return { data: { session: null, user: null }, error: { name: "AuthRetryableFetchError", message: "Failed to fetch", status: 0 } };
        case "invalid":
          sessionMode = "none";
          return { data: { session: null, user: null }, error: { name: "AuthApiError", message: "Invalid Refresh Token: Refresh Token Not Found", status: 400, code: "refresh_token_not_found" } };
      }
    },
    onAuthStateChange: (callback: (event: string, session: unknown) => void) => {
      authListeners.push(callback);
      return { data: { subscription: { unsubscribe: () => undefined } } };
    },
  };

  // ---- PostgREST-style reads of `inventory` -------------------------------
  const inventoryRows = (shopId?: string) =>
    [...server.inventory.entries()]
      .map(([key, qty]) => {
        const sep = key.indexOf(":");
        return { shop_id: key.slice(0, sep), product_id: key.slice(sep + 1), qty_base_units: qty };
      })
      .filter((row) => !shopId || row.shop_id === shopId);

  // Reads go through the PostgREST emulator (fakePostgrest.ts): filters,
  // keyset or(), order, limit and the silent 1,000-row cap. Every request
  // (each page) counts as one select call.
  const inventoryTable: { inventory: Record<string, unknown>[] } = { inventory: [] };
  const postgrest = createFakePostgrest({
    tables: inventoryTable,
    beforeRequest: () => {
      selectHook?.(selectCalls);
      selectCalls += 1;
      inventoryTable.inventory = inventoryRows();
      if (selectMode === "network-error") return { message: NETWORK_FAILURE.error.message, code: "" };
      return undefined;
    },
  });
  const from = (table: string) => {
    if (table !== "inventory") throw new Error(`fakeSupabase.from(): table "${table}" is not modelled`);
    return postgrest.from(table);
  };

  // ---- Realtime ------------------------------------------------------------
  const channel = (name: string): FakeRealtimeChannel => {
    const changeListeners: ChangeListener[] = [];
    let statusListener: StatusListener | undefined;
    const ch: FakeRealtimeChannel = {
      name,
      removed: false,
      subscribeCalls: 0,
      on: (type, _filter, cb) => {
        if (type === "postgres_changes") changeListeners.push(cb);
        return ch;
      },
      subscribe: (cb) => {
        ch.subscribeCalls += 1;
        statusListener = cb;
        return ch;
      },
      emitStatus: (status, err) => {
        if (ch.removed) throw new Error(`fakeSupabase: channel ${name} was removed`);
        statusListener?.(status, err);
      },
      emitChange: ({ eventType, shopId, productId, qty, commitTimestamp }) => {
        if (ch.removed) throw new Error(`fakeSupabase: channel ${name} was removed`);
        const row = { shop_id: shopId, product_id: productId, qty_base_units: qty ?? server.inventory.get(`${shopId}:${productId}`) ?? 0 };
        const payload: Record<string, unknown> = {
          schema: "public", table: "inventory", eventType,
          commit_timestamp: commitTimestamp ?? serverNow(), errors: null,
          new: eventType === "DELETE" ? {} : row,
          old: eventType === "INSERT" ? {} : { shop_id: shopId, product_id: productId },
        };
        for (const cb of changeListeners) cb(payload);
      },
    };
    channels.push(ch);
    return ch;
  };
  const removeChannel = async (ch: FakeRealtimeChannel) => {
    ch.removed = true;
    return "ok";
  };

  return {
    rpc,
    auth,
    from,
    channel,
    removeChannel,
    /** Direct access for assertions. */
    get server() { return server; },
    get calls() { return calls; },
    get refreshCalls() { return refreshCalls; },
    get selectCalls() { return selectCalls; },
    callsFor: (name: string) => calls.filter((c) => c.name === name),
    /** Outcome for the next N calls, in order; afterwards `defaultMode` applies. */
    queueModes: (...modes: RpcMode[]) => { queuedModes.push(...modes); },
    /** The next calls answer exactly with these raw responses (no side effect). */
    queueReply: (...replies: Record<string, unknown>[]) => { queuedReplies.push(...replies); },
    setDefaultMode: (mode: RpcMode) => { defaultMode = mode; },
    /** Migration 086 on the fake server (op_execute / op_status). */
    enableExecutor: (on = true) => { executor = on; },
    /** Who the server believes is calling (086 visibility / fence rules; 087 organisation and MFA level). */
    setCaller: (id: string, admin = false, org = "org-1", aal2 = false) => { caller = { id, admin, org, aal2 }; },
    /** Migration 087 on the fake server. */
    enable087: (on = true) => { r87.enabled = on; },
    /** 087 server gate: lease valid / server continuity state. */
    set087Server: (opts: { lease?: boolean; state?: "open" | "hold"; legacyOpen?: boolean; quotaBytes?: number }) => {
      if (opts.lease !== undefined) r87.lease = opts.lease;
      if (opts.state !== undefined) r87.state = opts.state;
      if (opts.legacyOpen !== undefined) r87.legacyOpen = opts.legacyOpen;
      if (opts.quotaBytes !== undefined) r87.quotaBytes = opts.quotaBytes;
    },
    /** owner_hold_org: hold + new epoch. */
    hold87Org: (org = "org-1") => { bump87(org); },
    /** 088 stand-in (test only): release a hold WITHOUT an epoch change. */
    release87Org: (org = "org-1") => { org87(org).held = false; },
    /** Register a till directly (test setup) and optionally reconcile it for the current epoch. */
    register87Till: (till: string, opts: { org?: string; reconciled?: boolean } = {}) => {
      const org = opts.org ?? "org-1";
      const secret = `secret-${till}-${++r87.seq}`;
      r87.tills.set(`${org}|${till}`, { org, secret, reconciledEpochNo: opts.reconciled === false ? -1 : org87(org).epochNo });
      return secret;
    },
    /** Reconcile a till for the current epoch (an admin's approval, test setup). */
    reconcile87Till: (till: string, org = "org-1") => { const t = r87.tills.get(`${org}|${till}`); if (t) t.reconciledEpochNo = org87(org).epochNo; },
    witness87: (org = "org-1") => witness87(org),
    get r87() { return r87; },
    /** The message of the executor's definitive refusals (permanent-error). */
    setRejectionMessage: (message: string) => { rejectionMessage = message; },
    /** Finish a hung execution's lock (op_status stops saying in_flight). */
    releaseExecuting: () => { executing.clear(); },
    /** 086 op_purge_responses for one key. */
    purgeResponse: (key: string) => { const r = server.idempotency.get(key); if (r) r.purged = true; },
    setSelectMode: (mode: SelectMode) => { selectMode = mode; },
    setSelectHook: (hook: ((request: number) => void) | null) => { selectHook = hook; },
    /** Move the fake server's clock relative to the client's. */
    setServerClockOffset: (ms: number) => { serverClockOffsetMs = ms; },
    serverNow,
    setAuth: (session: AuthSessionMode, refresh: AuthRefreshMode = "ok") => { sessionMode = session; refreshMode = refresh; },
    emitAuth: (event: string) => { for (const cb of authListeners) cb(event, sessionMode === "valid" ? validSession() : null); },
    /** Realtime test controls. */
    realtime: {
      get channels() { return channels; },
      /** The most recently created channel that has not been removed. */
      current(): FakeRealtimeChannel {
        const live = channels.filter((c) => !c.removed);
        if (live.length === 0) throw new Error("fakeSupabase: no live realtime channel");
        return live[live.length - 1];
      },
    },
    reset: () => {
      server = freshServer();
      calls.length = 0;
      queuedModes.length = 0;
      queuedReplies.length = 0;
      defaultMode = "succeed";
      sessionMode = "valid";
      refreshMode = "ok";
      refreshCalls = 0;
      authListeners.length = 0;
      selectMode = "succeed";
      selectCalls = 0;
      selectHook = null;
      serverClockOffsetMs = 0;
      channels.length = 0;
      executor = false;
      caller = { id: "user-1", admin: false, org: "org-1", aal2: false };
      r87 = fresh87();
      rejectionMessage = "Insufficient stock for Tea Mix";
      executing.clear();
    },
  };
}

export type FakeSupabase = ReturnType<typeof createFakeSupabase>;

/** Module singleton so a `vi.mock("../../lib/supabase")` factory and the
 *  test body share one instance (vitest caches this module per file). */
export const fakeSupabase: FakeSupabase = createFakeSupabase();
