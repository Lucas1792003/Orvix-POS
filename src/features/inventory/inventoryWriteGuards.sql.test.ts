import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Inventory is per-shop: products are a shared catalog, but a stock row is
// keyed by (shopId, productId). These characterization tests pin that model
// in the server-side RPC SQL so a regression that treats stock as one global
// quantity is caught. (Moved verbatim from the former selectors.test.ts when
// the unused client selector was removed.)

// ---- RPC SQL: every inventory write is keyed by (shop_id, product_id) -----

describe("RPC SQL keeps inventory writes shop-scoped", () => {
  const migration = (file: string): string =>
    readFileSync(
      fileURLToPath(new URL(`../../../supabase/migrations/${file}`, import.meta.url)),
      "utf8",
    ).replace(/\s+/g, " ");

  it("complete_sale deducts stock for the sale's shop only", () => {
    const sql = migration("004_complete_sale_rpc.sql");
    expect(sql).toContain("UPDATE inventory");
    expect(sql).toContain("WHERE shop_id = p_shop_id AND product_id = v_c->>'product_id'");
  });

  it("complete_sale locks shop inventory and rejects unauthorized negative stock", () => {
    const sql = migration("004_complete_sale_rpc.sql");
    expect(sql).toContain("v_can_ovr_stock := app_has_perm('pos:override_stock')");
    expect(sql).toContain("WHERE shop_id = p_shop_id AND product_id = v_product.id FOR UPDATE");
    expect(sql).toContain("IF v_qty_after < 0 AND NOT v_can_ovr_stock THEN");
    expect(sql).toContain("RAISE EXCEPTION 'Insufficient stock for %: have %, need %'");
  });

  it("receive_purchase_order adds stock for the PO's shop only", () => {
    const sql = migration("006_receive_purchase_order_rpc.sql");
    expect(sql).toContain("ON CONFLICT (shop_id, product_id)");
    expect(sql).toContain("WHERE shop_id = v_po.shop_id AND product_id = v_poitem.product_id");
  });

  it("complete_stock_transfer moves stock between source and destination shop", () => {
    const sql = migration("007_complete_stock_transfer_rpc.sql");
    expect(sql).toContain("WHERE shop_id = v_transfer.from_shop_id AND product_id = v_titem.product_id");
    expect(sql).toContain("WHERE shop_id = v_transfer.to_shop_id AND product_id = v_titem.product_id");
  });

  it("adjust_stock (migration 014) adjusts the selected shop only", () => {
    const sql = migration("014_rbac_role_tuning.sql");
    expect(sql).toContain("ON CONFLICT (shop_id, product_id)");
    expect(sql).toContain("WHERE shop_id = p_shop_id AND product_id = p_product_id");
  });

  it("refund/void restores stock to the original sale's shop only", () => {
    const sql = migration("005_refund_void_rpc.sql");
    expect(sql).toContain("WHERE shop_id = v_sale.shop_id AND product_id = v_product_id");
    expect(sql).toContain("WHERE shop_id = v_sale.shop_id AND product_id = v_sale_item.product_id");
  });
});

// ---- Schema: inventory uniqueness is (shop_id, product_id) ----------------

describe("inventory schema", () => {
  it("declares a composite (shop_id, product_id) primary key", () => {
    const schema = readFileSync(
      fileURLToPath(new URL("../../../supabase/schema.sql", import.meta.url)),
      "utf8",
    ).replace(/\s+/g, " ");
    // one stock row per (shop, product) — no global-per-product row possible
    expect(schema).toMatch(/CREATE TABLE IF NOT EXISTS inventory \(.*PRIMARY KEY \(shop_id, product_id\)/);
  });
});
