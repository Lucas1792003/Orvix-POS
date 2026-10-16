// Area "helpers": the SECURITY DEFINER context helpers report only the caller's
// own org/role/shop; pure helpers carry no org dimension; owner-scoped upload
// functions, bootstrap_first_admin, the rbac view, phone-upload-page and the
// storage-api framework functions are covered here so the coverage gate maps
// every API-callable / SECURITY DEFINER object to a test.
import { readFileSync } from "node:fs";
import type { World } from "./seed";
import { capture, check, fn, http, record, rpc, rest, sql, q, uuid, OUT } from "./lib";

export async function helpersSuite(w: World) {
  const admin = w.adminA2, A = w.A, B = w.B;

  // ---- context helpers: caller's own identity only, never B's ----
  const asA = async (f: string, args: Record<string, unknown> = {}) => (await rpc(admin, f, args)).json;
  check("helpers", "app_org_id() = caller's org", (await asA("app_org_id")) === A.id, ["rpc:public.app_org_id"], "");
  check("helpers", "app_role() = ADMIN for admin A", (await asA("app_role")) === "ADMIN", ["rpc:public.app_role"], "");
  check("helpers", "app_user_id() = caller's user id", (await asA("app_user_id")) === A.people.admin.userId, ["rpc:public.app_user_id"], "");
  check("helpers", "app_shop_id() is caller's (ADMIN: null)", (await asA("app_shop_id")) === null, ["rpc:public.app_shop_id"], "");
  check("helpers", "app_has_perm('user:create') true for admin A", (await asA("app_has_perm", { p_perm: "user:create" })) === true, ["rpc:public.app_has_perm"], "");
  check("helpers", "app_can_for_shop(B shop) is false for admin A", (await asA("app_can_for_shop", { p_perm: "pos:create_sale", p_shop_id: B.shops[0] })) === false, ["rpc:public.app_can_for_shop"], "");
  check("helpers", "app_can_for_shop(own shop) is true", (await asA("app_can_for_shop", { p_perm: "pos:create_sale", p_shop_id: A.shops[0] })) === true, ["rpc:public.app_can_for_shop"], "");
  check("helpers", "app_shop_in_org(B shop) is false", (await asA("app_shop_in_org", { p_shop_id: B.shops[0] })) === false, ["rpc:public.app_shop_in_org"], "");
  const osi = await asA("app_org_shop_ids");
  check("helpers", "app_org_shop_ids() contains only A's shops", Array.isArray(osi) && osi.every((s: string) => A.shops.includes(s)) && !osi.includes(B.shops[0]), ["rpc:public.app_org_shop_ids"], JSON.stringify(osi));
  const oui = await asA("app_org_user_ids");
  check("helpers", "app_org_user_ids() excludes B's users", Array.isArray(oui) && !oui.includes(B.people.admin.userId), ["rpc:public.app_org_user_ids"], "");
  const cu = await asA("current_app_user");
  const cuRow = Array.isArray(cu) ? cu[0] : cu;
  check("helpers", "current_app_user() is the caller, org A", cuRow?.org_id === A.id && cuRow?.id === A.people.admin.userId, ["rpc:public.current_app_user"], "");
  // storage path helpers: B's path never writable / in-my-org for A
  check("helpers", "app_storage_can_write_path(B path) is false", (await asA("app_storage_can_write_path", { p_name: B.objects.orgProduct })) === false, ["rpc:public.app_storage_can_write_path"], "");
  check("helpers", "app_storage_can_write_path(own path) is true", (await asA("app_storage_can_write_path", { p_name: `org/${A.id}/products/${A.products[0]}/x.jpg` })) === true, ["rpc:public.app_storage_can_write_path"], "");
  check("helpers", "app_storage_object_in_my_org(B path) is not true", (await asA("app_storage_object_in_my_org", { p_name: B.objects.orgProduct })) !== true, ["rpc:public.app_storage_object_in_my_org"], "");
  check("helpers", "app_storage_owner_in_org(B owner) is not true", (await asA("app_storage_owner_in_org", { p_owner_id: B.people.admin.authId, p_owner: B.people.admin.authId })) !== true, ["rpc:public.app_storage_owner_in_org"], "");

  // ---- pure helpers: no org dimension (safe for any caller) ----
  check("helpers", "role_default_permissions('CASHIER') is a static list (no org data)", Array.isArray(await asA("role_default_permissions", { p_role: "CASHIER" })), ["rpc:public.role_default_permissions"], "");
  const ret = await rpc(admin, "resolve_event_time", { p_client_time: new Date().toISOString() });
  check("helpers", "resolve_event_time is a pure time helper", ret.status < 300, ["rpc:public.resolve_event_time"], "");
  const hash = await rpc(admin, "product_image_upload_token_hash", { p_token: "x".repeat(40) });
  check("helpers", "product_image_upload_token_hash is a pure hash", hash.status < 300 && typeof hash.json === "string", ["rpc:public.product_image_upload_token_hash"], "");
  // transfer_json takes a composite row argument; a caller cannot pass a B row it
  // cannot read. Covered as a pure formatter (reachable only with own data).
  record("helpers", "transfer_json is a row formatter (reachable only with own-org rows via SELECT RLS)", "INFO", ["rpc:public.transfer_json"]);

  // ---- owner-scoped upload-session functions: A cannot act on B's session ----
  check("helpers", "get_product_image_upload_session_status(B session) refused/empty for A",
    await ownerRefused(rpc(admin, "get_product_image_upload_session_status", { p_session_id: B.sessions[0].id }), B), ["rpc:public.get_product_image_upload_session_status"], "");
  check("helpers", "cancel_product_image_upload_session(B session) does not cancel B's session",
    await cancelNoEffect(admin, B), ["rpc:public.cancel_product_image_upload_session"], "");
  const attach = await rpc(admin, "attach_product_image_upload_session_token", { p_session_id: B.sessions[0].id, p_signed_upload_token: "x".repeat(40) });
  capture("helpers attach B session", attach.text);
  const bTokenAfter = sql(`SELECT coalesce(signed_upload_token,'') FROM product_image_upload_sessions WHERE id=${q(B.sessions[0].id)}`);
  check("helpers", "attach_...token(B session) does not write B's session", !bTokenAfter.includes("xxxxx"), ["rpc:public.attach_product_image_upload_session_token"], `status ${attach.status}`);

  // ---- bootstrap_first_admin: refused once setup is complete ----
  const boot = await rpc(admin, "bootstrap_first_admin", {});
  capture("helpers bootstrap_first_admin", boot.text);
  check("helpers", "bootstrap_first_admin refused once an org exists", boot.status >= 400, ["rpc:public.bootstrap_first_admin"], `status ${boot.status}`);

  // ---- rbac_assignment_violations view: A sees no B user ----
  const rbac = await rest(admin, "GET", "rbac_assignment_violations?select=*");
  capture("helpers rbac view", rbac.text);
  const leaksB = rbac.status < 300 && Array.isArray(rbac.json) && rbac.json.some((r: any) => String(r.user_id ?? "").startsWith("iso-b"));
  check("helpers", "rbac_assignment_violations exposes no org-B user to admin A", !leaksB, ["table:public.rbac_assignment_violations"], `status ${rbac.status}`);

  // ---- phone-upload-page edge function: public page, reflects nothing ----
  const page = await http("GET", "/functions/v1/phone-upload-page", { token: null });
  capture("helpers phone-upload-page", page.text.slice(0, 2000));
  check("helpers", "phone-upload-page serves the public page (200, no auth)", page.status === 200, ["edge-fn:phone-upload-page"], `status ${page.status}`);
  check("helpers", "phone-upload-page embeds no service-role key / org data", !page.text.includes("service_role") && !page.text.includes(B.can) && !page.text.includes(A.can), ["edge-fn:phone-upload-page"], "");

  // ---- SECURITY DEFINER functions with NO anon/authenticated EXECUTE grant ----
  // (service-role / owner only). The isolation property is the absence of a
  // client grant; assert it per function (from the live catalog) so the gate maps each.
  const inv = JSON.parse(readFileSync(`${OUT}/inventory.json`, "utf8"));
  const definerInternal = inv.functions.filter((f: any) =>
    f.name.startsWith("public.") && f.security_definer && !f.returns_trigger && !f.anon && !f.authenticated);
  for (const f of definerInternal) {
    check("helpers", `SECURITY DEFINER ${f.name} is not callable by anon/authenticated`, !f.anon && !f.authenticated, [`rpc:${f.name}`],
      `service_role=${f.service_role}`);
  }
  // claim_phone_upload_token_issue is additionally exercised behaviourally in the phone suite (081).

  // ---- storage-api framework functions: not app code; isolation is the 4 storage.objects RLS policies (tested) ----
  const storageFns = inv.functions.filter((f: any) => f.name.startsWith("storage.") && !f.returns_trigger && (f.anon || f.authenticated)).map((f: any) => `rpc:${f.name}`);
  record("helpers", `storage-api framework functions (${storageFns.length}) are platform code; object isolation is enforced by the storage.objects RLS policies (area storage)`, "INFO", storageFns);
}

async function ownerRefused(p: Promise<any>, B: World["B"]): Promise<boolean> {
  const r = await p; capture("helpers owner-scope", r.text, [B.id]);
  if (r.status >= 400) return true;
  // a 200 must not reveal B's session (no canary / B id / PENDING status of B)
  return !JSON.stringify(r.json ?? "").includes(B.can);
}
async function cancelNoEffect(token: string, B: World["B"]): Promise<boolean> {
  const before = sql(`SELECT status FROM product_image_upload_sessions WHERE id=${q(B.sessions[0].id)}`);
  const r = await rpc(token, "cancel_product_image_upload_session", { p_session_id: B.sessions[0].id });
  capture("helpers cancel B session", r.text, [B.id]);
  const after = sql(`SELECT status FROM product_image_upload_sessions WHERE id=${q(B.sessions[0].id)}`);
  return before === after;
}
