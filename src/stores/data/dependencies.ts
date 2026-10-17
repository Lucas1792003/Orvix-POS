// ----------------------------------------------------------------------
// Which queued operations may depend on which (migration 086, shared-till
// pass). The queue is strictly ordered; an entry that cannot be sent here
// (another cashier's, waiting for its creator) may be PASSED only by a
// later operation PROVEN independent of it. Proof is conservative: every
// operation is described by the records it touches; anything not modelled
// here touches everything ("*") and is never passed.
//
// Keys: "<ns>:<id>" (exact; "<ns>:*" matches every key of that namespace),
// "stock:<shop>:<product>:<dir>" (dir inc | dec; "*" for an unknown shop or
// product). Two stock DECREASES of the same product commute (the final stock
// is the same in either order — only which one a server-side stock check
// would refuse can differ); an increase is ordered against everything on
// that product. "actor:<id>" (who created it) is only compared with
// "user:<id>" (an operation ON that user, e.g. deactivating them).
// Uses vs owners: a sale USES its shift ("shiftuse:<id>"), opening/closing
// OWNS it ("shift:<id>") — sales on one shift commute, a close is ordered
// after them. An offline-created record is MADE by one entry ("made:<id>")
// and referenced by others ("ref:<id>"): two references commute.
// ----------------------------------------------------------------------

export interface DependencySubject {
  kind?: "rpc" | "table_write";
  name: string;
  args?: Record<string, unknown> | null;
  shopId?: string | null;
  actorId?: string | null;
  provisional?: { table: string; ids: string[] }[];
  refs?: { field: string; provisionalId: string }[];
}

type Keys = Set<string> | "*";

/** How ids are compared (final ordering pass). An id created offline is
 *  compared under its SERVER id once a verified mapping exists; an
 *  offline id with no mapping yet stands for "any id" ("*") — it can never
 *  prove independence. `shiftCashier`: whose shift it is (from the till's own
 *  shift rows), or null when unknown. */
export interface DependencyContext {
  resolve(id: string): string;
  shiftCashier(shiftId: string): string | null;
}

/** No offline ids known, no shift owners known (pure tests, the server view). */
export const PLAIN_CONTEXT: DependencyContext = { resolve: (id) => id, shiftCashier: () => null };

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export function resourcesOf(e: DependencySubject, ctx: DependencyContext = PLAIN_CONTEXT): Keys {
  if (e.kind === "table_write") return "*";
  const a = e.args ?? {};
  const k = new Set<string>();
  const id = (v: unknown): string | null => { const s = str(v); return s ? ctx.resolve(s) : null; };
  const add = (ns: string, v: unknown) => { const s = id(v); if (s) k.add(`${ns}:${s}`); };
  const stock = (shop: unknown, product: unknown, dir: "inc" | "dec") => k.add(`stock:${id(shop) ?? "*"}:${id(product) ?? "*"}:${dir}`);
  const shop = a.p_shop_id ?? e.shopId;
  // Records made / referenced by offline id: the raw id, plus the server id
  // once mapped (never a wildcard — that would tie every offline entry).
  const both = (ns: string, pid: string) => { k.add(`${ns}:${pid}`); const real = ctx.resolve(pid); if (real !== "*" && real !== pid) k.add(`${ns}:${real}`); };
  for (const p of e.provisional ?? []) for (const pid of p.ids) both("made", pid);
  for (const r of e.refs ?? []) both("ref", r.provisionalId);
  if (e.actorId) k.add(`actor:${e.actorId}`);

  switch (e.name) {
    case "complete_sale":
      add("shiftuse", a.p_shift_id);
      for (const p of e.provisional ?? []) if (p.table === "sales") for (const pid of p.ids) both("sale", pid);
      if (!Array.isArray(a.p_items)) return "*";
      for (const item of a.p_items as { product_id?: unknown }[]) stock(shop, item?.product_id, "dec");
      return k;
    case "adjust_stock": {
      // The sign of p_quantity_delta is the direction, with or without a
      // unit (the server's v_sign). Unknown -> both directions.
      const delta = Number(a.p_quantity_delta);
      if (Number.isFinite(delta) && delta < 0) stock(shop, a.p_product_id, "dec");
      else if (Number.isFinite(delta) && delta > 0) stock(shop, a.p_product_id, "inc");
      else { stock(shop, a.p_product_id, "dec"); stock(shop, a.p_product_id, "inc"); }
      return k;
    }
    case "open_shift":
      // One open shift per CASHIER (any shop): ordered after a close of any
      // shift of that cashier — whoever queued the close (a manager may).
      for (const p of e.provisional ?? []) if (p.table === "shifts") for (const pid of p.ids) both("shift", pid);
      k.add(`cashieropen:${e.actorId ?? "*"}`);
      return k;
    case "close_shift": {
      add("shift", a.p_shift_id);
      // The expected cash of the close depends on void / refund approvals.
      add("shiftcash", a.p_shift_id);
      const sid = id(a.p_shift_id);
      k.add(`cashieropen:${(sid && sid !== "*" ? ctx.shiftCashier(sid) : null) ?? "*"}`);
      return k;
    }
    case "create_purchase_order":
      add("supplier", a.p_supplier_id);
      for (const p of e.provisional ?? []) for (const pid of p.ids) both("po", pid);
      return k;
    case "approve_purchase_order":
    case "cancel_purchase_order":
      add("po", a.p_purchase_order_id);
      return k;
    case "receive_purchase_order":
      add("po", a.p_purchase_order_id);
      k.add(`stock:${str(shop) ?? "*"}:*:inc`);
      return k;
    case "create_stock_transfer":
      for (const p of e.provisional ?? []) for (const pid of p.ids) both("transfer", pid);
      return k;
    case "approve_stock_transfer":
    case "reject_stock_transfer":
    case "cancel_stock_transfer":
      add("transfer", a.p_transfer_id);
      return k;
    case "dispatch_stock_transfer":
      add("transfer", a.p_transfer_id);
      k.add("stock:*:*:dec");
      return k;
    case "receive_stock_transfer":
      add("transfer", a.p_transfer_id);
      k.add("stock:*:*:inc");
      return k;
    case "create_refund_void_request":
      add("sale", a.p_sale_id);
      for (const p of e.provisional ?? []) for (const pid of p.ids) both("request", pid);
      return k;
    case "approve_refund_request":
    case "approve_void_request":
      add("request", a.p_request_id);
      k.add("stock:*:*:inc");
      // It changes the expected cash of the shift its sale belongs to — not
      // in its arguments: every shift close is ordered against it.
      k.add("shiftcash:*");
      return k;
    case "reject_refund_void_request":
      add("request", a.p_request_id);
      return k;
    case "pay_supplier_lump_sum":
    case "record_supplier_payment":
      // A payment can depend on any receipt (the outstanding balance).
      add("supplier", a.p_supplier_id);
      add("po", a.p_purchase_order_id);
      k.add("po:*");
      return k;
    case "void_supplier_payment":
      add("payment", a.p_payment_id);
      k.add("po:*");
      return k;
    case "create_supplier":
      add("suppliercode", typeof a.p_code === "string" ? a.p_code.trim().toLowerCase() : null);
      return k;
    case "update_supplier":
      add("supplier", a.p_id);
      return k;
    case "update_app_user":
    case "deactivate_app_user":
      add("user", a.p_id);
      return k;
    case "log_audit_event":
    case "log_receipt_reprint":
      return k;
    default:
      // replace_manager, delete_product, anything new: never proven independent.
      return "*";
  }
}

const nsOf = (key: string) => key.slice(0, key.indexOf(":"));

/** Pairs of namespaces that are ordered against each other although each
 *  commutes with itself (a use against its owner). */
const USE_OWNER: Record<string, string> = { shiftuse: "shift", ref: "made" };

function keyConflicts(x: string, y: string): boolean {
  if (x.startsWith("stock:") && y.startsWith("stock:")) {
    const [, sx, px, dx] = x.split(":");
    const [, sy, py, dy] = y.split(":");
    const same = (p: string, q: string) => p === "*" || q === "*" || p === q;
    // decrease/decrease and increase/increase commute; a mix is ordered
    return same(sx, sy) && same(px, py) && dx !== dy;
  }
  if (x.startsWith("actor:") && y.startsWith("user:")) return x.slice(6) === y.slice(5);
  if (y.startsWith("actor:") && x.startsWith("user:")) return y.slice(6) === x.slice(5);
  if (x.startsWith("actor:") || y.startsWith("actor:")) return false;
  const nx = nsOf(x);
  const ny = nsOf(y);
  if (USE_OWNER[nx] === ny || USE_OWNER[ny] === nx) {
    const ix = x.slice(nx.length + 1);
    const iy = y.slice(ny.length + 1);
    return ix === iy || ix === "*" || iy === "*";
  }
  if (nx === "shiftuse" || nx === "ref") return false;     // two uses commute
  if (nx !== ny) return false;
  return x === y || x.endsWith(":*") || y.endsWith(":*");
}

/** True unless `later` is PROVEN independent of `earlier` (order matters). */
export function mayDepend(later: DependencySubject, earlier: DependencySubject, ctx: DependencyContext = PLAIN_CONTEXT): boolean {
  const a = resourcesOf(later, ctx);
  const b = resourcesOf(earlier, ctx);
  if (a === "*" || b === "*") return true;
  for (const x of a) for (const y of b) if (keyConflicts(x, y)) return true;
  return false;
}
