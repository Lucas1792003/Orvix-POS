import { describe, expect, it } from "vitest";
import { mayDepend } from "./dependencies";

const sale = (product: string, shift = "sh-1", extra: Record<string, unknown> = {}) => ({
  kind: "rpc" as const, name: "complete_sale", shopId: "shop-1",
  args: { p_shop_id: "shop-1", p_shift_id: shift, p_items: [{ product_id: product, qty: 1 }], ...extra },
});

describe("dependencies: an entry may be passed only by work PROVEN independent of it", () => {
  it("two sales commute (any product, same shift); a restock is ordered against a sale of that product only", () => {
    expect(mayDepend(sale("p1"), sale("p1"))).toBe(false);
    expect(mayDepend(sale("p2", "sh-2"), sale("p1"))).toBe(false);
    const restock = { kind: "rpc" as const, name: "adjust_stock", shopId: "shop-1", args: { p_shop_id: "shop-1", p_product_id: "p1", p_quantity_delta: 5 } };
    expect(mayDepend(sale("p1"), restock)).toBe(true);
    expect(mayDepend(sale("p2"), restock)).toBe(false);
  });
  it("a close is ordered after the sales of its shift (not other shifts); an open after a close of the same cashier", () => {
    const close = { kind: "rpc" as const, name: "close_shift", shopId: "shop-1", actorId: "a", args: { p_shift_id: "sh-1" } };
    expect(mayDepend(close, sale("p1", "sh-1"))).toBe(true);
    expect(mayDepend(close, sale("p1", "sh-2"))).toBe(false);
    const open = { kind: "rpc" as const, name: "open_shift", shopId: "shop-1", actorId: "a", args: { p_shop_id: "shop-1" } };
    // whose shift is closed is not in the close's arguments: unknown -> it blocks every open
    expect(mayDepend(open, close)).toBe(true);
    expect(mayDepend({ ...open, actorId: "b" }, close)).toBe(true);
    // known (the till's shift rows): only that cashier's open — in ANY shop, whoever queued the close
    const ctx = { resolve: (id: string) => id, shiftCashier: (id: string) => (id === "sh-1" ? "a" : null) };
    const managersClose = { ...close, actorId: "mgr" };
    expect(mayDepend(open, managersClose, ctx)).toBe(true);
    expect(mayDepend({ ...open, shopId: "shop-9", args: { p_shop_id: "shop-9" } }, managersClose, ctx)).toBe(true);
    expect(mayDepend({ ...open, actorId: "b" }, managersClose, ctx)).toBe(false);
  });
  it("an entry referencing an offline-created record depends on the entry that makes it; two references commute", () => {
    const open = { kind: "rpc" as const, name: "open_shift", shopId: "shop-1", args: {}, provisional: [{ table: "shifts", ids: ["local-1"] }] };
    const s1 = { ...sale("p1", "local-1"), refs: [{ field: "p_shift_id", provisionalId: "local-1" }] };
    const s2 = { ...sale("p2", "local-1"), refs: [{ field: "p_shift_id", provisionalId: "local-1" }] };
    expect(mayDepend(s1, open)).toBe(true);
    expect(mayDepend(s2, s1)).toBe(false);
  });
  it("payments depend on any purchase-order receipt; a PO cancel on that PO's receipt; refunds on their sale; deactivation on that user's entries", () => {
    const receive = { kind: "rpc" as const, name: "receive_purchase_order", shopId: "shop-1", args: { p_purchase_order_id: "po-1" } };
    expect(mayDepend({ name: "pay_supplier_lump_sum", args: { p_supplier_id: "s1" } }, receive)).toBe(true);
    expect(mayDepend({ name: "cancel_purchase_order", args: { p_purchase_order_id: "po-1" } }, receive)).toBe(true);
    expect(mayDepend({ name: "cancel_purchase_order", args: { p_purchase_order_id: "po-2" } }, receive)).toBe(false);
    const s = { ...sale("p1"), provisional: [{ table: "sales", ids: ["sale-local"] }] };
    expect(mayDepend({ name: "create_refund_void_request", args: { p_sale_id: "sale-local" } }, s)).toBe(true);
    expect(mayDepend({ name: "deactivate_app_user", args: { p_id: "a" } }, { ...sale("p1"), actorId: "a" })).toBe(true);
    expect(mayDepend({ name: "deactivate_app_user", args: { p_id: "b" } }, { ...sale("p1"), actorId: "a" })).toBe(false);
  });
  it("anything not modelled (table writes, unknown RPCs, a sale without items) is never proven independent", () => {
    expect(mayDepend(sale("p1"), { kind: "table_write", name: "products.update" })).toBe(true);
    expect(mayDepend(sale("p1"), { name: "replace_manager", args: {} })).toBe(true);
    expect(mayDepend({ name: "complete_sale", args: { p_shift_id: "x" } }, sale("p1"))).toBe(true);
  });
});
