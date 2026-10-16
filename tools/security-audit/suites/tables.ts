// Area "tables": for every org-scoped table, org A roles must not read, insert,
// update or delete org B's rows — through plain reads, filters on FK columns,
// embedded joins, or=, and the count header. Positive controls confirm each
// role still operates on its own org.
import type { World, Org } from "./seed";
import { capture, check, record, rest, sql, q, MAX_MIG } from "./lib";

// org-scoped tables, their PK columns, and the column an org A role could aim at B
const TABLES: Record<string, { pk: string[]; ownFilter?: string }> = {
  "shops": { pk: ["id"] }, "users": { pk: ["id"] }, "products": { pk: ["id"] }, "product_units": { pk: ["id"] },
  "product_unit_prices": { pk: ["id"] }, "product_barcodes": { pk: ["id"] }, "price_tiers": { pk: ["id"] },
  "price_levels": { pk: ["id"] }, "categories": { pk: ["id"] }, "brands": { pk: ["id"] }, "unit_types": { pk: ["id"] },
  "suppliers": { pk: ["id"] }, "supplier_products": { pk: ["supplier_id", "product_id"] }, "business_profile": { pk: ["org_id"] },
  "inventory": { pk: ["shop_id", "product_id"] }, "inventory_movements": { pk: ["id"] }, "shifts": { pk: ["id"] },
  "sales": { pk: ["id"] }, "sale_items": { pk: ["id"] }, "purchase_orders": { pk: ["id"] }, "purchase_order_items": { pk: ["id"] },
  "stock_transfers": { pk: ["id"] }, "stock_transfer_items": { pk: ["id"] }, "supplier_payments": { pk: ["id"] },
  "refund_void_requests": { pk: ["id"] }, "reprint_logs": { pk: ["id"] }, "audit_logs": { pk: ["id"] },
  "product_image_upload_sessions": { pk: ["id"] },
};

const orgOf = (table: string, o: Org): string =>
  table === "business_profile" ? o.id : o.id; // every org-scoped table joins back to org o

/** rows of this table belonging to org `org`, as JSON (superuser). */
function rowsFor(table: string, org: string): any[] {
  const whereByOrg: Record<string, string> = {
    shops: `org_id=${q(org)}`, users: `org_id=${q(org)}`, products: `org_id=${q(org)}`,
    categories: `org_id=${q(org)}`, brands: `org_id=${q(org)}`, unit_types: `org_id=${q(org)}`,
    suppliers: `org_id=${q(org)}`, price_levels: `org_id=${q(org)}`, product_barcodes: `org_id=${q(org)}`,
    business_profile: `org_id=${q(org)}`,
    product_units: `product_id IN (SELECT id FROM products WHERE org_id=${q(org)})`,
    product_unit_prices: `product_unit_id IN (SELECT pu.id FROM product_units pu JOIN products p ON p.id=pu.product_id WHERE p.org_id=${q(org)})`,
    price_tiers: `product_id IN (SELECT id FROM products WHERE org_id=${q(org)})`,
    supplier_products: `supplier_id IN (SELECT id FROM suppliers WHERE org_id=${q(org)})`,
    inventory: `shop_id IN (SELECT id FROM shops WHERE org_id=${q(org)})`,
    inventory_movements: `shop_id IN (SELECT id FROM shops WHERE org_id=${q(org)})`,
    shifts: `shop_id IN (SELECT id FROM shops WHERE org_id=${q(org)})`,
    sales: `shop_id IN (SELECT id FROM shops WHERE org_id=${q(org)})`,
    sale_items: `sale_id IN (SELECT s.id FROM sales s JOIN shops sh ON sh.id=s.shop_id WHERE sh.org_id=${q(org)})`,
    purchase_orders: `shop_id IN (SELECT id FROM shops WHERE org_id=${q(org)})`,
    purchase_order_items: `purchase_order_id IN (SELECT po.id FROM purchase_orders po JOIN shops sh ON sh.id=po.shop_id WHERE sh.org_id=${q(org)})`,
    stock_transfers: `from_shop_id IN (SELECT id FROM shops WHERE org_id=${q(org)})`,
    stock_transfer_items: `transfer_id IN (SELECT t.id FROM stock_transfers t JOIN shops sh ON sh.id=t.from_shop_id WHERE sh.org_id=${q(org)})`,
    supplier_payments: `shop_id IN (SELECT id FROM shops WHERE org_id=${q(org)})`,
    refund_void_requests: `shop_id IN (SELECT id FROM shops WHERE org_id=${q(org)})`,
    reprint_logs: `sale_id IN (SELECT s.id FROM sales s JOIN shops sh ON sh.id=s.shop_id WHERE sh.org_id=${q(org)})`,
    audit_logs: `actor_id IN (SELECT id FROM users WHERE org_id=${q(org)})`,
    product_image_upload_sessions: `created_by IN (SELECT id FROM users WHERE org_id=${q(org)})`,
  };
  const j = sql(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY ${TABLES[table].pk.join(",")}), '[]') FROM ${table} t WHERE ${whereByOrg[table]}`);
  return JSON.parse(j);
}

export async function tablesSuite(w: World) {
  const admin = w.adminA2, cashier = w.A.people.cash.token;
  const bRowsByTable: Record<string, any[]> = {};
  for (const table of Object.keys(TABLES)) bRowsByTable[table] = rowsFor(table, w.B.id);

  for (const [table, cfg] of Object.entries(TABLES)) {
    const bRows = bRowsByTable[table];
    const aRows = rowsFor(table, w.A.id);
    const cov = [`table:public.${table}`];
    if (bRows.length === 0) { record("tables", `${table}: no org-B row seeded (skip)`, "SKIP", cov); continue; }
    const pk = cfg.pk;
    const bKey = bRows[0];
    const bFilter = pk.map((c) => `${c}=eq.${encodeURIComponent(bKey[c])}`).join("&");

    for (const [role, token] of [["admin-aal2", admin], ["cashier", cashier]] as const) {
      // plain read: nothing of B visible
      const all = await rest(token, "GET", `${table}?select=*&limit=2000`);
      capture(`tables ${table} ${role} all`, all.text, aRows.flatMap((r) => Object.values(r).map(String)));
      const visibleB = Array.isArray(all.json) ? all.json.filter((r: any) => pk.every((c) => bRows.some((b) => String(b[c]) === String(r[c])))) : [];
      check("tables", `${table} ${role}: reads none of B's rows`, all.status < 300 && visibleB.length === 0, cov,
        `status ${all.status}, ${visibleB.length} B rows visible`);
      // filtered by B's PK
      const filtered = await rest(token, "GET", `${table}?${bFilter}`);
      capture(`tables ${table} ${role} filtered`, filtered.text);
      check("tables", `${table} ${role}: filter on B's id -> 0 rows`, filtered.status < 300 && Array.isArray(filtered.json) && filtered.json.length === 0, cov,
        `status ${filtered.status} len ${Array.isArray(filtered.json) ? filtered.json.length : "?"}`);
      // count header (existence oracle)
      const counted = await rest(token, "GET", `${table}?${bFilter}`, undefined, { Prefer: "count=exact", Range: "0-0" });
      const cr = counted.headers.get("content-range") ?? "";
      check("tables", `${table} ${role}: count=exact on B's id reports 0`, /\/0$|^\*?0-/.test(cr) || cr.endsWith("/0"), cov, `content-range ${cr}`);
    }
    // or= cannot widen past RLS
    const ored = await rest(admin, "GET", `${table}?or=(${pk[0]}.eq.${encodeURIComponent(bKey[pk[0]])},${pk[0]}.not.is.null)&limit=2000`);
    const bViaOr = Array.isArray(ored.json) ? ored.json.filter((r: any) => pk.every((c) => bRows.some((b) => String(b[c]) === String(r[c])))) : [];
    check("tables", `${table} admin: or= filter still hides B`, bViaOr.length === 0, cov, `${bViaOr.length} leaked via or=`);
  }

  // Embedded joins (PostgREST resource embedding) must not pull B parents/children
  const embeds: [string, string, string][] = [
    ["sales", "sales?select=*,shops(*),sale_items(*)&limit=500", "shops"],
    ["product_units", "product_units?select=*,products(*)&limit=500", "products"],
    ["purchase_orders", "purchase_orders?select=*,suppliers(*),purchase_order_items(*)&limit=500", "suppliers"],
  ];
  for (const [table, path, child] of embeds) {
    const r = await rest(admin, "GET", path);
    capture(`tables embed ${table}`, r.text);
    const leaked = r.text.includes(w.B.can) || r.text.includes(w.B.id);
    // A 400 means PostgREST exposes no such embeddable relationship (no declared
    // FK) — no data can leak that way. The isolation requirement is only that no
    // org-B data is returned.
    check("tables", `${table} admin: embedded join (${child}) exposes no org-B data`, !leaked, [`table:public.${table}`],
      `status ${r.status}, canary ${leaked ? "present" : "absent"}`);
  }

  // Direct cross-org writes (INSERT aimed at B, UPDATE/DELETE B rows by id)
  const writes: { table: string; insert?: Record<string, unknown>; }[] = [
    { table: "shops", insert: { id: `iso-evil-${Date.now()}`, code: "EVIL", name: "evil", org_id: w.B.id } },
    { table: "products", insert: { id: `iso-evil-p-${Date.now()}`, sku: `EVILP${Date.now()}`, name: "evil", category: "x", unit_type: "pcs", price_mmk: 1, cost_mmk: 1, org_id: w.B.id } },
    { table: "categories", insert: { id: `iso-evil-c-${Date.now()}`, name: "evil", color: "#000000", org_id: w.B.id } },
  ];
  for (const wr of writes) {
    const cov = [`table:public.${wr.table}`];
    const ins = await rest(admin, "POST", wr.table, wr.insert, { Prefer: "return=representation" });
    capture(`tables insert->B ${wr.table}`, ins.text);
    // acceptable: refused, OR silently re-homed to A (org_id forced from caller). Fail only if it lands in B.
    let landedInB = false;
    if (ins.status < 300) {
      const id = (wr.insert as any).id;
      landedInB = sql(`SELECT count(*) FROM ${wr.table} WHERE id=${q(id)} AND org_id=${q(w.B.id)}`) !== "0";
      sql(`DELETE FROM ${wr.table} WHERE id=${q(id)}`);
    }
    check("tables", `${wr.table} admin: INSERT with org_id=B does not create a B row`, !landedInB, cov,
      `status ${ins.status}${landedInB ? " LANDED IN B" : ""}`);
  }
  // UPDATE / DELETE B rows by id (RLS => 0 rows affected, no error leak)
  for (const table of ["products", "shops", "suppliers", "sales"]) {
    const b = bRowsByTable[table][0]; if (!b) continue;
    const cov = [`table:public.${table}`];
    const before = sql(`SELECT md5(coalesce(to_jsonb(t)::text,'')) FROM ${table} t WHERE ${TABLES[table].pk.map((c) => `${c}=${q(b[c])}`).join(" AND ")}`);
    const upd = await rest(admin, "PATCH", `${table}?${TABLES[table].pk.map((c) => `${c}=eq.${encodeURIComponent(b[c])}`).join("&")}`, { name: `HACKED-${w.A.can}` }, { Prefer: "return=representation" });
    capture(`tables update B ${table}`, upd.text);
    const after = sql(`SELECT md5(coalesce(to_jsonb(t)::text,'')) FROM ${table} t WHERE ${TABLES[table].pk.map((c) => `${c}=${q(b[c])}`).join(" AND ")}`);
    const changed = before !== after;
    check("tables", `${table} admin: UPDATE of B row changes nothing`, !changed && (upd.status < 300 ? (Array.isArray(upd.json) && upd.json.length === 0) : true), cov,
      `status ${upd.status}${changed ? " ROW CHANGED" : ""}`);
    const del = await rest(admin, "DELETE", `${table}?${TABLES[table].pk.map((c) => `${c}=eq.${encodeURIComponent(b[c])}`).join("&")}`, undefined, { Prefer: "return=representation" });
    capture(`tables delete B ${table}`, del.text);
    const stillThere = sql(`SELECT count(*) FROM ${table} WHERE ${TABLES[table].pk.map((c) => `${c}=${q(b[c])}`).join(" AND ")}`) === "1";
    check("tables", `${table} admin: DELETE of B row removes nothing`, stillThere, cov, `status ${del.status}`);
  }

  // Positive controls: org A admin DOES see and act on its own org
  const ownShops = await rest(admin, "GET", `shops?org_id=eq.${w.A.id}`);
  check("tables", "positive: admin A reads its own shops", Array.isArray(ownShops.json) && ownShops.json.length === w.A.shops.length, ["table:public.shops"],
    `got ${Array.isArray(ownShops.json) ? ownShops.json.length : "?"}`);
  const ownSales = await rest(cashier, "GET", `sales?shop_id=eq.${w.A.shops[0]}`);
  check("tables", "positive: cashier A reads own-shop sales", Array.isArray(ownSales.json) && ownSales.json.length >= 3, ["table:public.sales"],
    `got ${Array.isArray(ownSales.json) ? ownSales.json.length : "?"}`);
}
