// Builds the synthetic world: orgs A and B (TOTP admins) + sibling attacker
// org C (ADMIN without TOTP: the emailed-code path — users_only_one_admin
// allows exactly one ADMIN per org, so this persona needs its own org), real
// GoTrue users and sessions, catalog via SQL, operations via the keyed RPCs,
// storage objects via storage-api.
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adminCreateUser, canaries, http, randomPassword, rpc, SERVICE, signIn, sql, sqlFile, enrollTotp, stepUp, uuid, q, redact,
} from "./lib";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface Persona {
  key: string; org: string; userId: string | null; authId: string; email: string; password: string;
  role: string; token: string; shopId: string | null;
}
export interface Org {
  key: "A" | "B" | "C"; id: string; p: string; can: string; price: number;
  shops: string[]; products: string[]; units: string[]; supplier: string; category: string; brand: string; unitType: string;
  barcodes: string[]; tier: string; pup: string; priceLevels: string[];
  people: Record<string, Persona>;
  shifts: string[]; sales: string[]; pos: { recv: string; draft: string; appr: string };
  payments: string[]; transfers: { transit: string; pending: string }; refunds: { partial: string; void: string };
  sessions: { id: string; token: string }[]; objects: Record<string, string>;
  idemKeys: Record<string, string>; auditIds: string[];
}
export interface World {
  A: Org; B: Org; C: Org;
  adminA2: string; adminA1: string; adminB2: string;
  totp: Record<string, { factorId: string; secret: string }>;
  orphan: Persona; platform: Persona; anon: null;
  cNoCode: string; cWithCode: string;
}

const PRICES = { A: 314159, B: 918273, C: 271828 };

async function call(token: string, fn: string, args: Record<string, unknown>): Promise<any> {
  const r = await rpc(token, fn, args);
  if (r.status >= 300) throw new Error(`seed ${fn}: ${r.status} ${redact(r.text).slice(0, 300)}`);
  return r.json;
}
/** id of the first object in an RPC response (shapes are {sale:{id}}, {shift:{id}}, ...). */
const idOf = (j: any, key?: string): string => {
  if (key && j?.[key]?.id) return j[key].id;
  if (j?.id) return j.id;
  for (const v of Object.values(j ?? {})) if (v && typeof v === "object" && (v as any).id) return (v as any).id;
  throw new Error("no id in " + JSON.stringify(j).slice(0, 200));
};

async function makeOrg(key: "A" | "B" | "C", roles: string[]): Promise<Org> {
  const p = `iso-${key.toLowerCase()}`;
  const id = `org-iso-${key.toLowerCase()}`;
  const can = `qz${key.toLowerCase()}${randomBytes(4).toString("hex")}`;
  const price = PRICES[key];
  const people: Record<string, Persona> = {};
  const authIds: Record<string, string> = {};
  for (const role of roles) {
    const email = `${role}.${can}@qa.invalid`;
    const password = randomPassword();
    const authId = await adminCreateUser(email, password);
    authIds[role] = authId;
    people[role] = { key: `${key}.${role}`, org: id, userId: `${p}-${role}`, authId, email, password, role, token: "", shopId: null };
  }
  const out = sqlFile(join(HERE, "../sql/seed_org.sql"), {
    p, org: id, can, price: String(price), bc: String(4_000_000_000_000 + Math.floor(Math.random() * 999_999_999_999)),
    au_admin: authIds.admin, au_mgr: authIds.mgr ?? "", au_mgr2: authIds.mgr2 ?? "", au_cash: authIds.cash ?? "",
    au_buyer: authIds.buyer ?? "", au_deact: authIds.deact ?? "",
  });
  console.log("INFO " + out.split("\n").pop());
  // emails in users rows use the role name ("cash.<can>@") — keep the GoTrue email equal (082 compares them)
  for (const role of roles) {
    const userEmail = sql(`SELECT email FROM users WHERE id = ${q(`${p}-${role}`)}`);
    if (userEmail && userEmail !== people[role].email) {
      await http("PUT", `/auth/v1/admin/users/${people[role].authId}`, { token: SERVICE, apikey: SERVICE, body: { email: userEmail, email_confirm: true } });
      people[role].email = userEmail;
    }
    people[role].shopId = sql(`SELECT coalesce(shop_id,'') FROM users WHERE id = ${q(`${p}-${role}`)}`) || null;
  }
  for (const role of roles) {
    if (role === "deact") continue;
    people[role].token = (await signIn(people[role].email, people[role].password)).access_token;
  }
  const priceLevels = sql(`SELECT string_agg(id, ',' ORDER BY id) FROM price_levels WHERE org_id = ${q(id)}`).split(",").filter(Boolean);
  return {
    key, id, p, can, price, shops: [`${p}-shop1`, `${p}-shop2`], products: [`${p}-prod1`, `${p}-prod2`, `${p}-prod3`],
    units: [`${p}-unit1`, `${p}-unit2`, `${p}-unit3`, `${p}-unit1b`], supplier: `${p}-sup`, category: `${p}-cat`,
    brand: `${p}-brand`, unitType: `${p}-ut`, barcodes: [`${p}-bc1`], tier: `${p}-tier1`, pup: `${p}-pup1`, priceLevels,
    people, shifts: [], sales: [], pos: { recv: "", draft: "", appr: "" }, payments: [],
    transfers: { transit: "", pending: "" }, refunds: { partial: "", void: "" }, sessions: [], objects: {}, idemKeys: {}, auditIds: [],
  };
}

async function operate(o: Org, adminToken: string) {
  const cash = o.people.cash?.token ?? adminToken;
  const mgr = o.people.mgr?.token ?? adminToken;
  const k = () => uuid();
  // shift + sales (keyed RPCs)
  const shiftKey = k(); o.idemKeys.open_shift = shiftKey;
  const shift = await call(cash, "open_shift", { p_shop_id: o.shops[0], p_opening_cash_mmk: 0, p_idempotency_key: shiftKey });
  o.shifts.push(idOf(shift, "shift"));
  for (let i = 0; i < 3; i++) {
    const key = k(); if (i === 0) o.idemKeys.complete_sale = key;
    const sale = await call(cash, "complete_sale", {
      p_shop_id: o.shops[0], p_shift_id: o.shifts[0], p_payment_method: "CASH", p_paid_mmk: o.price * 3, p_cart_discount_pct: 0,
      p_items: [{ product_id: o.products[i], qty: 1 }], p_idempotency_key: key,
    });
    o.sales.push(idOf(sale, "sale"));
  }
  await call(adminToken, "adjust_stock", { p_shop_id: o.shops[0], p_product_id: o.products[1], p_adjustment_type: "ADJUSTMENT",
    p_quantity_delta: 5, p_reason: `Recount ${o.can}`, p_idempotency_key: k() });
  // purchase orders: recv (approved+received+paid), appr (approved), draft
  const mk = async () => idOf(await call(mgr, "create_purchase_order", { p_shop_id: o.shops[0], p_supplier_id: o.supplier,
    p_notes: `PO notes ${o.can}`, p_items: [{ product_id: o.products[0], ordered_qty: 10, unit_cost_mmk: 600 }], p_idempotency_key: k() }));
  o.pos.recv = await mk(); o.pos.appr = await mk(); o.pos.draft = await mk();
  for (const po of [o.pos.recv, o.pos.appr]) await call(adminToken, "approve_purchase_order", { p_purchase_order_id: po, p_idempotency_key: k() });
  await call(mgr, "receive_purchase_order", { p_purchase_order_id: o.pos.recv, p_received_items: null, p_idempotency_key: k() });
  await call(mgr, "record_supplier_payment", { p_purchase_order_id: o.pos.recv, p_amount_mmk: 1000, p_payment_method: "CASH",
    p_reference_no: `REF-${o.can}`, p_notes: `Paid ${o.can}`, p_idempotency_key: k() });
  o.payments.push(...sql(`SELECT id FROM supplier_payments WHERE purchase_order_id = ${q(o.pos.recv)} ORDER BY created_at`).split("\n").filter(Boolean));
  // transfers: transit (approved + dispatched) and pending
  const tr = async () => idOf(await call(mgr, "create_stock_transfer", { p_from_shop_id: o.shops[0], p_to_shop_id: o.shops[1],
    p_notes: `Transfer ${o.can}`, p_items: [{ product_id: o.products[0], requested_qty: 2 }], p_idempotency_key: k() }));
  o.transfers.transit = await tr(); o.transfers.pending = await tr();
  await call(adminToken, "approve_stock_transfer", { p_transfer_id: o.transfers.transit, p_idempotency_key: k() });
  await call(mgr, "dispatch_stock_transfer", { p_transfer_id: o.transfers.transit, p_idempotency_key: k() });
  // refund / void requests + reprint + audit event
  o.refunds.partial = idOf(await call(cash, "create_refund_void_request", { p_sale_id: o.sales[1], p_type: "PARTIAL",
    p_reason: `Refund ${o.can}`, p_items: [{ productId: o.products[1], qtyUnits: 1, amountMmk: o.price + 1 }], p_idempotency_key: k() }));
  o.refunds.void = idOf(await call(cash, "create_refund_void_request", { p_sale_id: o.sales[2], p_type: "VOID",
    p_reason: `Void ${o.can}`, p_items: [], p_idempotency_key: k() }));
  await call(cash, "log_receipt_reprint", { p_sale_id: o.sales[0], p_idempotency_key: k() });
  await call(adminToken, "log_audit_event", { p_action_type: "PRODUCT_EDIT", p_message: `Edited ${o.can}`, p_entity_type: "Product",
    p_entity_id: o.products[0], p_shop_id: null, p_idempotency_key: k() });
  // upload sessions (one stays PENDING for phone-upload tests)
  for (let i = 0; i < 2; i++) {
    const s = await call(adminToken, "create_product_image_upload_session", { p_shop_id: o.shops[0], p_product_id: o.products[0] });
    o.sessions.push({ id: s.id ?? s.sessionId ?? idOf(s), token: s.token ?? s.p_token ?? s.uploadToken });
  }
}

/** Synthetic PNG bytes (not an image of anything). */
const png = () => Buffer.concat([Buffer.from("ffd8ffe000104a464946", "hex"), randomBytes(64), Buffer.from("ffd9", "hex")]);

async function objects(o: Org, adminToken: string) {
  const up = async (path: string, token: string) => {
    const r = await http("POST", `/storage/v1/object/product-images/${path}`, {
      token, raw: png(), headers: { "Content-Type": "image/jpeg", "x-upsert": "false" } });
    if (r.status >= 300) throw new Error(`upload ${path}: ${r.status} ${redact(r.text).slice(0, 200)}`);
  };
  o.objects.orgProduct = `org/${o.id}/products/${o.products[0]}/front-${o.can}.jpg`;
  await up(o.objects.orgProduct, adminToken);                 // as the org's ADMIN (RLS path rule)
  o.objects.legacyProduct = `products/${o.products[1]}/legacy-${o.can}.jpg`;
  o.objects.legacyTemp = `temp/${o.sessions[1].id}`;
  o.objects.brandLogo = `products/brand/${o.p}-logo.jpg`;
  o.objects.brandOld = `products/brand/${o.p}-old-${o.can}.jpg`;
  for (const k of ["legacyProduct", "brandLogo", "brandOld"] as const) await up(o.objects[k], SERVICE);
  // legacy temp/<session> object: migrated hosted objects carry no owner; its session row must name the path (078)
  sql(`UPDATE product_image_upload_sessions SET storage_path = ${q(o.objects.legacyTemp)} WHERE id = ${q(o.sessions[1].id)}`);
  await up(o.objects.legacyTemp, SERVICE);
  sql(`UPDATE storage.objects SET owner = NULL, owner_id = NULL WHERE bucket_id = 'product-images' AND name IN (${[o.objects.legacyProduct, o.objects.legacyTemp].map(q).join(",")})`);
  // the old logo was uploaded by this org's admin (owner set) and is no longer referenced
  sql(`UPDATE storage.objects SET owner = ${q(o.people.admin.authId)}::uuid, owner_id = ${q(o.people.admin.authId)} WHERE bucket_id = 'product-images' AND name = ${q(o.objects.brandOld)}`);
}

export async function buildWorld(): Promise<World> {
  const A = await makeOrg("A", ["admin", "mgr", "mgr2", "cash", "buyer", "deact"]);
  const B = await makeOrg("B", ["admin", "mgr", "mgr2", "cash", "buyer", "deact"]);
  const C = await makeOrg("C", ["admin", "mgr", "cash"]);
  const totp: World["totp"] = {};
  // TOTP for the A and B admins: enrol on the aal1 session, then fresh aal1/aal2 sessions
  for (const o of [A, B]) {
    totp[o.key] = await enrollTotp(o.people.admin.token);
    o.people.admin.token = (await signIn(o.people.admin.email, o.people.admin.password)).access_token;
  }
  const adminA2 = (await stepUp(A.people.admin.token, totp.A.factorId, totp.A.secret)).access_token;
  const adminB2 = (await stepUp(B.people.admin.token, totp.B.factorId, totp.B.secret)).access_token;
  const adminA1 = A.people.admin.token;
  for (const [o, t] of [[A, adminA2], [B, adminB2], [C, C.people.admin.token]] as const) {
    await operate(o, t);
    await objects(o, t);
  }
  // C admin (no TOTP): one session without a consumed code, one with a code consumed AFTER sign-in
  const cNoCode = (await signIn(C.people.admin.email, C.people.admin.password)).access_token;
  const cWithCode = (await signIn(C.people.admin.email, C.people.admin.password)).access_token;
  // orphan (auth account, no app user) and a platform admin (platform_admins row, no app user)
  const orphanEmail = `orphan.${randomBytes(4).toString("hex")}@qa.invalid`, orphanPw = randomPassword();
  const orphanId = await adminCreateUser(orphanEmail, orphanPw);
  const orphan: Persona = { key: "orphan", org: "", userId: null, authId: orphanId, email: orphanEmail, password: orphanPw, role: "ORPHAN",
    token: (await signIn(orphanEmail, orphanPw)).access_token, shopId: null };
  const paEmail = `platform.${randomBytes(4).toString("hex")}@qa.invalid`, paPw = randomPassword();
  const paId = await adminCreateUser(paEmail, paPw);
  sql(`INSERT INTO platform_admins (auth_id, name, email) VALUES (${q(paId)}, 'Platform QA', ${q(paEmail)})`);
  const platform: Persona = { key: "platform", org: "", userId: null, authId: paId, email: paEmail, password: paPw, role: "PLATFORM",
    token: (await signIn(paEmail, paPw)).access_token, shopId: null };

  // canaries: everything of org B another org must never receive
  for (const v of [B.can, String(B.price), B.id, ...Object.values(B.people).flatMap((p) => [p.email, p.authId, p.userId ?? ""]),
    ...B.sessions.flatMap((s) => [s.id, s.token]), ...B.shifts, ...B.sales, ...Object.values(B.pos), ...B.payments,
    ...Object.values(B.transfers), ...Object.values(B.refunds), ...B.priceLevels, ...B.shops, ...B.products, ...B.units,
    B.supplier, B.category, B.brand, B.unitType, ...B.barcodes, B.tier, B.pup, ...Object.values(B.objects)]) {
    if (v) canaries.add(v);
  }
  // B's barcode value and auth ids of B users are also canaries
  for (const v of sql(`SELECT value FROM product_barcodes WHERE org_id = 'org-iso-b'`).split("\n")) if (v) canaries.add(v);
  return { A, B, C, adminA1, adminA2, adminB2, totp, orphan, platform, anon: null, cNoCode, cWithCode };
}
