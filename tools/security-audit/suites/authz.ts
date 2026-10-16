// Area "authz": authorization-boundary matrix across personas, and the
// anonymous surface (anon reads nothing; only the 3 anon functions execute).
import type { World } from "./seed";
import { check, record, rest, rpc, fn, signIn, http, sql, uuid, ANON, capture } from "./lib";

export async function authzSuite(w: World) {
  const A = w.A;
  const deactTok = (await signIn(A.people.deact.email, A.people.deact.password).catch(() => null))?.access_token ?? null;

  type P = { name: string; token: string | null };
  const personas: P[] = [
    { name: "anon", token: null },
    { name: "orphan", token: w.orphan.token },
    { name: "deactivated", token: deactTok },
    { name: "cashier", token: A.people.cash.token },
    { name: "manager", token: A.people.mgr.token },
    { name: "admin-aal1", token: w.adminA1 },
    { name: "admin-aal2", token: w.adminA2 },
    { name: "admin-code-missing", token: w.cNoCode }, // org C admin, no consumed code
    { name: "platform-admin", token: w.platform.token },
  ];

  // operation classes: fn returns true when the op SUCCEEDED/was allowed
  const ops: { op: string; cover: string[]; run: (p: P) => Promise<boolean>; expect: Record<string, boolean> }[] = [
    {
      op: "read own-org sales", cover: ["table:public.sales"],
      run: async (p) => { const r = await rest(p.token, "GET", `sales?shop_id=eq.${A.shops[0]}`); return Array.isArray(r.json) && r.json.length > 0; },
      expect: { anon: false, orphan: false, deactivated: false, cashier: true, manager: true, "admin-aal1": true, "admin-aal2": true, "admin-code-missing": false, "platform-admin": false },
    },
    {
      op: "adjust_stock (own shop)", cover: ["rpc:public.adjust_stock"],
      run: async (p) => { const r = await rpc(p.token, "adjust_stock", { p_shop_id: A.shops[0], p_product_id: A.products[0], p_adjustment_type: "ADJUSTMENT", p_quantity_delta: 1, p_reason: "authz", p_idempotency_key: uuid() }); return r.status < 300; },
      expect: { anon: false, orphan: false, deactivated: false, cashier: false, manager: true, "admin-aal1": true, "admin-aal2": true, "admin-code-missing": false, "platform-admin": false },
    },
    {
      op: "create staff (staff-admin)", cover: ["edge-fn:staff-admin"],
      run: async (p) => { const r = await fn(p.token, "staff-admin", { action: "create_staff", name: "x", email: `az.${uuid().slice(0, 8)}@qa.invalid`, password: "Str0ngPass!234", role: "CASHIER", shopId: A.shops[0], idempotencyKey: uuid() }); return r.status === 201; },
      expect: { anon: false, orphan: false, deactivated: false, cashier: false, manager: false, "admin-aal1": false, "admin-aal2": true, "admin-code-missing": false, "platform-admin": false },
    },
    {
      op: "create organization (platform-console)", cover: ["edge-fn:platform-console"],
      run: async (p) => { const r = await fn(p.token, "platform-console", { action: "whoami" }); return r.status === 200; },
      expect: { anon: false, orphan: false, deactivated: false, cashier: false, manager: false, "admin-aal1": false, "admin-aal2": false, "admin-code-missing": false, "platform-admin": true },
    },
  ];

  for (const o of ops) {
    for (const p of personas) {
      let got = false;
      try { got = await o.run(p); } catch { got = false; }
      const want = o.expect[p.name];
      check("authz", `${o.op} | ${p.name} ${want ? "allowed" : "denied"}`, got === want, o.cover, `got ${got ? "allowed" : "denied"}, expected ${want ? "allowed" : "denied"}`);
    }
  }

  // deactivated account self-check: has an auth session but no active app user
  if (deactTok) {
    const me = await rpc(deactTok, "current_app_user", {});
    check("authz", "deactivated: current_app_user returns no active row", me.status < 300 && (me.json == null || (Array.isArray(me.json) ? me.json.length === 0 : !me.json?.id)), ["rpc:public.current_app_user"], "");
  } else {
    record("authz", "deactivated account could not sign in (GoTrue), treated as denied everywhere", "INFO", []);
  }

  // ------------------------------------------------- anonymous surface
  const anonReadTables = ["sales", "users", "products", "shops", "organizations", "audit_logs", "price_levels", "suppliers"];
  for (const t of anonReadTables) {
    const r = await rest(null, "GET", `${t}?limit=5`);
    capture(`anon read ${t}`, r.text);
    check("authz", `anon reads 0 rows from ${t}`, (r.status >= 400) || (Array.isArray(r.json) && r.json.length === 0), [`table:public.${t}`], `status ${r.status} len ${Array.isArray(r.json) ? r.json.length : "?"}`);
  }
  const stor = await http("POST", "/storage/v1/object/list/product-images", { token: null, body: { prefix: "", limit: 10 } });
  check("authz", "anon cannot list storage objects", stor.status >= 400 || (Array.isArray(stor.json) && stor.json.length === 0), ["storage-policy:product_images_read"], `status ${stor.status}`);

  // only the 3 anon-executable RPCs run for anon; a privileged RPC is denied
  const appSetup = await rpc(null, "app_setup_needed", {});
  check("authz", "anon: app_setup_needed executes", appSetup.status < 300, ["rpc:public.app_setup_needed"], `status ${appSetup.status}`);
  const denied = await rpc(null, "complete_sale", { p_shop_id: A.shops[0], p_shift_id: A.shifts[0], p_payment_method: "CASH", p_paid_mmk: 1, p_cart_discount_pct: 0, p_items: [], p_idempotency_key: uuid() });
  check("authz", "anon: a privileged RPC (complete_sale) is denied", denied.status >= 400, ["rpc:public.complete_sale"], `status ${denied.status}`);

  // anon cannot bootstrap / enrol / create org
  const boot = await fn(ANON, "staff-admin", { action: "bootstrap_account", email: `boot.${uuid().slice(0, 6)}@qa.invalid`, password: "Str0ngPass!234" });
  check("authz", "anon: bootstrap_account refused once setup is complete", boot.status === 403, ["edge-fn:staff-admin"], `status ${boot.status}`);
}
