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
//    callback and emits postgres_changes payloads.
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
  | "commit-then-hang";

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
  idempotency: Map<string, { rpc: string; hash: string; response: unknown }>;
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

  const execute = (name: string, args: Record<string, unknown>) => {
    const key = args.p_idempotency_key;
    if (typeof key !== "string") {
      return { data: null, status: 400, error: { message: "IDEMPOTENCY_KEY_REQUIRED", code: "22023", details: null, hint: null }, replayed: false };
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
    server.idempotency.set(key, { rpc: name, hash, response });
    return { data: response, error: null, status: 200, replayed: false };
  };

  const respond = (name: string, args: Record<string, unknown>, mode: RpcMode) => {
    switch (mode) {
      case "network-error":
        return { ...NETWORK_FAILURE, replayed: false };
      case "commit-then-timeout": {
        const result = execute(name, args);
        return { ...NETWORK_FAILURE, replayed: result.replayed };
      }
      case "permanent-error":
        return { data: null, status: 400, replayed: false, error: { message: "Insufficient stock for Tea Mix", code: "P0001", details: null, hint: null } };
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
    if (mode === "commit-then-hang") execute(name, args);
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
    },
  };
}

export type FakeSupabase = ReturnType<typeof createFakeSupabase>;

/** Module singleton so a `vi.mock("../../lib/supabase")` factory and the
 *  test body share one instance (vitest caches this module per file). */
export const fakeSupabase: FakeSupabase = createFakeSupabase();
