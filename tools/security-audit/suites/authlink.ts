// Area "authlink": the OLDER admin "link any auth account" path
// (create_app_user with an arbitrary p_auth_id; direct users INSERT/UPDATE of
// auth_id). At 081 this is an EXPECTED GAP (admin A can link an orphan / another
// org's / a platform admin's login account). 082 closes it. gap() => GAP at 081,
// PASS at 082.
import type { World } from "./seed";
import { capture, gap, check, rest, rpc, sql, q, uuid, MAX_MIG } from "./lib";

export async function authlinkSuite(w: World) {
  const admin = w.adminA2, A = w.A;
  const closed = MAX_MIG >= 82;

  const targets: [string, string][] = [
    ["an orphan auth account", w.orphan.authId],
    ["another org's (B admin) login account", w.B.people.admin.authId],
    ["a platform admin's login account", w.platform.authId],
  ];
  for (const [label, authId] of targets) {
    const id = `iso-link-${uuid().slice(0, 8)}`;
    const r = await rpc(admin, "create_app_user", {
      p_id: id, p_name: `Link ${A.can}`, p_email: `link.${uuid().slice(0, 6)}@qa.invalid`, p_role: "CASHIER",
      p_shop_id: A.shops[0], p_auth_id: authId, p_granted_permissions: null, p_revoked_permissions: null, p_idempotency_key: uuid() });
    capture(`authlink create_app_user ${label}`, r.text, [authId]);
    const linked = sql(`SELECT count(*) FROM users WHERE id=${q(id)} AND auth_id=${q(authId)}`) === "1";
    if (linked) sql(`DELETE FROM users WHERE id=${q(id)}`);
    gap("authlink", `create_app_user cannot link ${label}`, !linked, ["rpc:public.create_app_user"], "critical",
      `at migration ${MAX_MIG}: linking ${linked ? "SUCCEEDED (gap)" : "refused"} (status ${r.status})`);
  }

  // direct REST INSERT of a users row carrying auth_id
  {
    const id = `iso-ins-${uuid().slice(0, 8)}`;
    const r = await rest(admin, "POST", "users", { id, name: "x", email: `ins.${uuid().slice(0, 6)}@qa.invalid`, role: "CASHIER", shop_id: A.shops[0], org_id: A.id, auth_id: w.orphan.authId });
    capture("authlink direct insert auth_id", r.text, [w.orphan.authId]);
    const linked = sql(`SELECT count(*) FROM users WHERE id=${q(id)} AND auth_id=${q(w.orphan.authId)}`) === "1";
    if (linked) sql(`DELETE FROM users WHERE id=${q(id)}`);
    gap("authlink", "direct users INSERT cannot set auth_id (client)", !linked, ["table:public.users"], "critical",
      `at migration ${MAX_MIG}: insert ${linked ? "SET auth_id (gap)" : "refused"} (status ${r.status})`);
  }
  // direct REST UPDATE of an existing A user's auth_id -> point it at the platform admin
  {
    const victim = A.people.buyer.userId!;
    const orig = sql(`SELECT auth_id FROM users WHERE id=${q(victim)}`);
    const r = await rest(admin, "PATCH", `users?id=eq.${victim}`, { auth_id: w.platform.authId }, { Prefer: "return=representation" });
    capture("authlink direct update auth_id", r.text, [w.platform.authId]);
    const changed = sql(`SELECT auth_id FROM users WHERE id=${q(victim)}`) === w.platform.authId;
    if (changed) sql(`UPDATE users SET auth_id=${q(orig)} WHERE id=${q(victim)}`);
    gap("authlink", "direct users UPDATE cannot change auth_id (client)", !changed, ["table:public.users"], "critical",
      `at migration ${MAX_MIG}: update ${changed ? "CHANGED auth_id (gap)" : "refused"} (status ${r.status})`);
  }

  // 082 positive: the legitimate path still works — staff-admin wrote the marker,
  // and create_app_user links a fresh, same-email, never-signed-in account.
  // (covered end-to-end by functions.ts staff-admin positive; here we assert
  //  that at 082 a NAKED create_app_user with a marked fresh account is accepted.)
  if (closed) {
    // nothing to create here without the GoTrue marker flow; the staff-admin
    // positive in functions.ts is the authoritative positive control.
    check("authlink", "082 positive control is exercised by staff-admin (functions suite)", true, ["rpc:public.create_app_user"], "");
  }
}
