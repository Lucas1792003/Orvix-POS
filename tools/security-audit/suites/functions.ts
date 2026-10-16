// Area "functions": the service-role Edge Functions derive the org server-side
// and cannot be steered across orgs by request parameters; plus public signup.
import type { World } from "./seed";
import { capture, check, fn, http, record, sql, q, uuid, ANON, redact } from "./lib";

export async function functionsSuite(w: World) {
  const A = w.A, B = w.B;
  const adminA2 = w.adminA2, adminA1 = w.adminA1;

  // ---------------------------------------------------------------- staff-admin
  const sa = (token: string | null, body: Record<string, unknown>) => fn(token, "staff-admin", body);
  const base = (over: Record<string, unknown> = {}) => ({
    action: "create_staff", name: `New ${A.can}`, email: `new.${uuid().slice(0, 8)}@qa.invalid`,
    password: "Str0ngPass!234", role: "CASHIER", shopId: A.shops[0], idempotencyKey: uuid(), ...over,
  });
  const noOrphanBefore = () => sql(`SELECT count(*) FROM auth.users u WHERE NOT EXISTS (SELECT 1 FROM users a WHERE a.auth_id=u.id) AND NOT EXISTS (SELECT 1 FROM platform_admins p WHERE p.auth_id=u.id)`);

  // A's admin cannot create staff in B's shop
  let r = await sa(adminA2, base({ shopId: B.shops[0] }));
  capture("staff-admin A->B shop", r.text, [B.shops[0]]);
  check("functions", "staff-admin: admin A cannot create staff in B's shop", r.status >= 400 && r.json?.code !== undefined, ["edge-fn:staff-admin"], `status ${r.status} code ${r.json?.code}`);

  // org param tampering: no org field is honoured — create still lands in A only
  const beforeB = sql(`SELECT count(*) FROM users WHERE org_id=${q(B.id)}`);
  r = await sa(adminA2, base({ orgId: B.id, org_id: B.id }));
  capture("staff-admin org tamper", r.text);
  const afterB = sql(`SELECT count(*) FROM users WHERE org_id=${q(B.id)}`);
  check("functions", "staff-admin: an org param cannot place the new user in B", beforeB === afterB, ["edge-fn:staff-admin"], `B users ${beforeB}->${afterB}`);
  if (r.status === 201 && r.json?.user?.id) {
    check("functions", "staff-admin: tampered-org create landed in A", r.json.user.orgId === A.id || sql(`SELECT org_id FROM users WHERE id=${q(r.json.user.id)}`) === A.id, ["edge-fn:staff-admin"], "");
  }

  // MANAGER / CASHIER of A refused (no user:create, or not ADMIN creating MANAGER)
  r = await sa(A.people.cash.token, base());
  check("functions", "staff-admin: CASHIER A is refused", r.status === 403, ["edge-fn:staff-admin"], `status ${r.status}`);
  r = await sa(A.people.mgr.token, base({ role: "MANAGER" }));
  check("functions", "staff-admin: MANAGER A cannot create a MANAGER", r.status === 403, ["edge-fn:staff-admin"], `status ${r.status}`);

  // aal1 while TOTP enrolled -> refused (mfa_required)
  r = await sa(adminA1, base());
  check("functions", "staff-admin: admin A on aal1 (TOTP enrolled) is refused", r.status === 403 && r.json?.code === "mfa_required", ["edge-fn:staff-admin"], `status ${r.status} code ${r.json?.code}`);

  // ADMIN without a consumed code after sign-in -> refused (org C admin, no TOTP, cNoCode session)
  r = await sa(w.cNoCode, { ...base(), shopId: w.C.shops[0] });
  check("functions", "staff-admin: ADMIN without a consumed email code is refused", r.status === 403 && r.json?.code === "verification_required", ["edge-fn:staff-admin"], `status ${r.status} code ${r.json?.code}`);

  // privilege escalation: ADMIN role never creatable
  r = await sa(adminA2, base({ role: "ADMIN" }));
  check("functions", "staff-admin: creating an ADMIN is refused (privilege escalation)", r.status === 403, ["edge-fn:staff-admin"], `status ${r.status} code ${r.json?.code}`);

  // positive + replay: admin A (aal2) creates a CASHIER in its own shop, then replays the same key
  const beforeOrphan = noOrphanBefore();
  const body = base();
  const c1 = await sa(adminA2, body);
  check("functions", "staff-admin: positive — admin A (aal2) creates a CASHIER in own shop", c1.status === 201 && c1.json?.user?.orgId === A.id, ["edge-fn:staff-admin"], `status ${c1.status}`);
  const c2 = await sa(adminA2, body);
  check("functions", "staff-admin: replay of the same key returns the same user (no duplicate)", c2.status === 200 && c2.json?.replayed === true && c2.json?.user?.id === c1.json?.user?.id, ["edge-fn:staff-admin"], `status ${c2.status}`);
  // a conflicting reuse of the key (different email) -> 409
  const c3 = await sa(adminA2, { ...body, email: `other.${uuid().slice(0, 8)}@qa.invalid` });
  check("functions", "staff-admin: reusing a key with a different payload is refused", c3.status === 409, ["edge-fn:staff-admin"], `status ${c3.status}`);
  // duplicate email -> 409 and NO orphan auth user left behind (compensation)
  const dup = await sa(adminA2, base({ email: c1.json?.user?.email }));
  check("functions", "staff-admin: duplicate email is refused", dup.status === 409, ["edge-fn:staff-admin"], `status ${dup.status}`);
  check("functions", "staff-admin: no orphan auth account left behind (compensation)", noOrphanBefore() === beforeOrphan, ["edge-fn:staff-admin"], `orphans ${beforeOrphan}->${noOrphanBefore()}`);

  // ---------------------------------------------------------------- platform-console
  const pc = (token: string | null, body: Record<string, unknown>) => fn(token, "platform-console", body);
  for (const [label, token] of [["org A admin aal2", adminA2], ["org A cashier", A.people.cash.token], ["orphan", w.orphan.token]] as const) {
    const who = await pc(token, { action: "whoami" });
    capture(`platform-console ${label}`, who.text);
    check("functions", `platform-console: ${label} is not authorized`, who.status === 403, ["edge-fn:platform-console"], `status ${who.status}`);
    const list = await pc(token, { action: "list_organizations" });
    check("functions", `platform-console: ${label} cannot list organizations`, list.status === 403, ["edge-fn:platform-console"], `status ${list.status}`);
    const create = await pc(token, { action: "create_organization", orgName: "x", adminName: "x", adminEmail: `x${uuid().slice(0, 6)}@qa.invalid` });
    check("functions", `platform-console: ${label} cannot create an organization`, create.status === 403, ["edge-fn:platform-console"], `status ${create.status}`);
  }
  const paWho = await pc(w.platform.token, { action: "whoami" });
  check("functions", "platform-console: positive — the platform admin is recognised", paWho.status === 200, ["edge-fn:platform-console"], `status ${paWho.status}`);

  // ---------------------------------------------------------------- admin-2fa
  const a2 = (token: string | null) => fn(token, "admin-2fa", { action: "request" });
  check("functions", "admin-2fa: CASHIER A is refused (active ADMIN only)", (await a2(A.people.cash.token)).status === 403, ["edge-fn:admin-2fa"], "");
  check("functions", "admin-2fa: orphan is refused", (await a2(w.orphan.token)).status === 403, ["edge-fn:admin-2fa"], "");
  // admin A passes authz (self-targeted); email send fails closed (Resend -> 127.0.0.1), proving no cross-user targeting param
  const a2admin = await a2(adminA2);
  record("functions", `admin-2fa: admin A passes authz and targets only its own account (status ${a2admin.status})`, a2admin.status === 403 ? "FAIL" : "INFO", ["edge-fn:admin-2fa"],
    "no user-targeting parameter exists; code uses auth.getUser(token).id");

  // ---------------------------------------------------------------- email-sales-report
  const esr = (token: string | null) => fn(token, "email-sales-report", { subject: "x", csv: "a,b", filename: "x.csv" });
  check("functions", "email-sales-report: CASHIER A is refused", (await esr(A.people.cash.token)).status === 403, ["edge-fn:email-sales-report"], "");
  check("functions", "email-sales-report: orphan is refused", (await esr(w.orphan.token)).status === 403, ["edge-fn:email-sales-report"], "");
  const esrAdmin = await esr(adminA2);
  record("functions", `email-sales-report: admin A passes authz; recipient derived from own profile (status ${esrAdmin.status})`, esrAdmin.status === 403 ? "FAIL" : "INFO", ["edge-fn:email-sales-report"],
    "no org/recipient parameter is honoured; recipient = caller's own profile email");

  // ---------------------------------------------------------------- public signup (req 12)
  const su = await http("POST", "/auth/v1/signup", { token: null, apikey: ANON, body: { email: `signup.${uuid().slice(0, 8)}@qa.invalid`, password: "Str0ngPass!234" } });
  capture("gotrue signup", su.text);
  check("functions", "GoTrue signup is disabled (422 signup_disabled)", su.status === 422 && /signup_disabled/.test(su.text), ["edge-fn:signup"], `status ${su.status}`);
}
