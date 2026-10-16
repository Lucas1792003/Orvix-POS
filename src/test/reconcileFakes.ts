// Test fakes for the RC3 reconciliation tests (not part of the app bundle:
// nothing in src/ outside tests imports this file).
//   * fakeAuthBackend(): the three reads electron/reconcileAuthority.cjs makes
//     (app_role, app_user_id, own users row), answered like PostgREST;
//   * FakeSalesServer: a sales/sale_items store behind the SaleReader
//     interface of lib/reconcile/serverCheck.ts, plus a complete_sale that
//     records like the real one (created_at = p_created_at).
import type { SaleReader, ServerSaleItemRow, ServerSaleRow } from "../lib/reconcile/serverCheck";

export const BACKEND = { origin: "https://pos.example.test", anonKey: "anon-public" };
export const OWNER_TOKEN = "owner-access-token-0123456789";

export type FakeUser = { id: string; name: string; role: string; is_active: boolean; org_id: string };
export const OWNER: FakeUser = { id: "admin-1", name: "Owner One", role: "ADMIN", is_active: true, org_id: "org-1" };
export const CASHIER: FakeUser = { id: "cashier-1", name: "Cashier One", role: "CASHIER", is_active: true, org_id: "org-1" };

export function fakeAuthBackend(opts: { user?: FakeUser | null; down?: boolean; status?: number } = {}) {
  const calls: { url: string; method: string; auth: string | null }[] = [];
  const state = { user: opts.user === undefined ? OWNER : opts.user, down: Boolean(opts.down), status: opts.status ?? 0 };
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, method: String(init.method), auth: (init.headers as Record<string, string>).Authorization ?? null });
    if (state.down) throw new TypeError("fetch failed");
    if (state.status) return new Response(JSON.stringify({ message: "x" }), { status: state.status });
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
    const user = state.user;
    if (url.endsWith("/rest/v1/rpc/app_role")) return json(user?.is_active ? user.role : null);
    if (url.endsWith("/rest/v1/rpc/app_user_id")) return json(user?.is_active ? user.id : null);
    if (url.includes("/rest/v1/users?")) return json(user && url.includes(`id=eq.${encodeURIComponent(user.id)}`) ? [user] : []);
    return new Response("{}", { status: 404 });
  };
  return { fetchImpl, calls, state };
}

export const memoryKeyStore = (hex = "ab".repeat(32)) => ({ load: () => Buffer.from(hex, "hex") });

export class FakeSalesServer implements SaleReader {
  sales: (ServerSaleRow & { cashier_id?: string })[] = [];
  items: ServerSaleItemRow[] = [];
  reads = 0;
  failReads = false;
  private n = 0;

  /** What complete_sale stores for these args (created_at = p_created_at). */
  commitSale(args: Record<string, unknown>, opts: { createdAt?: string; shiftId?: string } = {}): ServerSaleRow {
    const id = `sale-srv-${++this.n}`;
    const row: ServerSaleRow = {
      id, shop_id: String(args.p_shop_id), shift_id: opts.shiftId ?? String(args.p_shift_id), receipt_no: `R-${String(this.n).padStart(4, "0")}`,
      created_at: opts.createdAt ?? new Date(Date.parse(String(args.p_created_at))).toISOString().replace("Z", "+00:00"),
      paid_mmk: Number(args.p_paid_mmk), payment_method: String(args.p_payment_method), cart_discount_pct: Number(args.p_cart_discount_pct ?? 0),
    };
    this.sales.push(row);
    for (const it of args.p_items as Record<string, unknown>[]) {
      this.items.push({ sale_id: id, product_id: String(it.product_id), base_quantity_sold: Number(it.qty) * Number(it.units_per_item ?? 1) });
    }
    return row;
  }

  private read<T>(v: T) {
    this.reads++;
    return Promise.resolve(this.failReads ? { data: null, error: { message: "TypeError: Failed to fetch" } } : { data: v, error: null }) as Promise<
      { data: T; error: null } | { data: null; error: { message: string } }
    >;
  }

  salesBetween(q: { shopId: string; shiftId: string | null; from: string; to: string; limit: number }) {
    return this.read(this.sales.filter((s) => s.shop_id === q.shopId && (!q.shiftId || s.shift_id === q.shiftId)
      && Date.parse(s.created_at!) >= Date.parse(q.from) && Date.parse(s.created_at!) <= Date.parse(q.to)).slice(0, q.limit));
  }
  salesWithAmounts(q: { shopId: string; shiftId: string | null; from: string; paidMmk: number; paymentMethod: string; limit: number }) {
    return this.read(this.sales.filter((s) => s.shop_id === q.shopId && (!q.shiftId || s.shift_id === q.shiftId) && s.paid_mmk === q.paidMmk
      && s.payment_method === q.paymentMethod && Date.parse(s.created_at!) >= Date.parse(q.from)).slice(0, q.limit));
  }
  saleItems(ids: string[]) {
    return this.read(this.items.filter((i) => ids.includes(i.sale_id)));
  }
  saleById(id: string) {
    return this.read(this.sales.filter((s) => s.id === id));
  }
  saleByReceipt(shopId: string, receiptNo: string) {
    return this.read(this.sales.filter((s) => s.shop_id === shopId && s.receipt_no === receiptNo));
  }
}

export const saleArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  p_shop_id: "shop-1",
  p_shift_id: "shift-1",
  p_payment_method: "CASH",
  p_paid_mmk: 1000,
  p_cart_discount_pct: 0,
  p_items: [{ product_id: "p1", product_unit_id: "u1", qty: 2, units_per_item: 1, price_level_id: null, unit_price_mmk: null }],
  p_created_at: "2026-10-16T08:00:00.123Z",
  p_idempotency_key: "11111111-1111-4111-8111-111111111111",
  ...over,
});
