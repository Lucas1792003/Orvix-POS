// Rate-limit local e2e driver (started by run.sh). Drives the REAL
// phone-upload-token function in a local edge-runtime container, which talks
// through the test gateway to a REAL PostgREST on a disposable harness
// database with migration 081 applied. Never contacts any other server.
// Env: FN_URL, GW_URL, DB_CONTAINER, DB_PW, JWT_SECRET (values never printed).
import { createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const { FN_URL, GW_URL, DB_CONTAINER, DB_PW, JWT_SECRET } = process.env;
if (!FN_URL || !GW_URL || !DB_CONTAINER || !DB_PW || !JWT_SECRET) throw new Error("missing env");

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);
};
const sql = (q) =>
  execFileSync("docker", ["exec", "-i", "-e", "PGPASSWORD", DB_CONTAINER, "psql", "-X", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"], {
    input: q, env: { ...process.env, PGPASSWORD: DB_PW }, encoding: "utf8",
  }).trim();
const jwt = (claims) => {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = `${b({ alg: "HS256", typ: "JWT" })}.${b({ ...claims, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })}`;
  return `${head}.${createHmac("sha256", JWT_SECRET).update(head).digest("base64url")}`;
};
const call = async (token) => {
  const r = await fetch(FN_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, retryAfter: r.headers.get("retry-after") };
};

// ---- fixtures: the harness leaves one user (the bootstrap owner) and its org
const [userId, authId, orgId] = sql("SELECT id || '|' || auth_id || '|' || org_id FROM users WHERE is_active ORDER BY created_at LIMIT 1;").split("|");
if (!userId || !orgId) throw new Error("no active user in the harness database");
const session = () => {
  const token = randomBytes(64).toString("hex");
  const id = `pimg-${randomBytes(16).toString("hex")}`;
  sql(`INSERT INTO product_image_upload_sessions (id, token_hash, created_by, storage_path, expires_at)
       VALUES ('${id}', product_image_upload_token_hash('${token}'), '${userId}', 'org/${orgId}/temp/${id}', now() + interval '10 minutes');`);
  return { id, token };
};
const counters = (id) => sql(`SELECT token_issue_count || '|' || token_window_count FROM product_image_upload_sessions WHERE id = '${id}';`);
sql(`DELETE FROM phone_upload_org_rate;`);

// ---- 1. sequential burst on one session
{
  const s = session();
  const st = [];
  for (let i = 0; i < 5; i++) st.push((await call(s.token)).status);
  const sixth = await call(s.token);
  check("local e2e: 5 sequential requests -> 200 x5 (real function -> PostgREST -> claim_ RPC as service_role)", st.join(",") === "200,200,200,200,200", st.join(","));
  check("local e2e: 6th -> 429 {error, code:rate_limited, retry_after_seconds} + Retry-After header",
    sixth.status === 429 && sixth.body?.code === "rate_limited" && Number.isInteger(sixth.body?.retry_after_seconds)
      && sixth.body.retry_after_seconds >= 1 && sixth.body.retry_after_seconds <= 10 && sixth.retryAfter === String(sixth.body.retry_after_seconds)
      && JSON.stringify(Object.keys(sixth.body).sort()) === JSON.stringify(["code", "error", "retry_after_seconds"]),
    `${sixth.status} ${JSON.stringify(sixth.body)} Retry-After=${sixth.retryAfter}`);
  check("local e2e: DB counters 5|5 after the refusal", counters(s.id) === "5|5", counters(s.id));
  await new Promise((r) => setTimeout(r, (sixth.body.retry_after_seconds + 1) * 1000));
  const again = await call(s.token);
  check("local e2e: after Retry-After a token is issued again (window reset)", again.status === 200 && typeof again.body?.token === "string" && counters(s.id) === "6|1", `${again.status} ${counters(s.id)}`);
}

// ---- 2. concurrent burst on one session
{
  const s = session();
  const rs = await Promise.all(Array.from({ length: 30 }, () => call(s.token)));
  const n200 = rs.filter((r) => r.status === 200).length;
  const n429 = rs.filter((r) => r.status === 429).length;
  check("local e2e: 30 concurrent requests for one session -> exactly 5 x 200, 25 x 429 (atomic in the DB)", n200 === 5 && n429 === 25 && counters(s.id) === "5|5", `200=${n200} 429=${n429} counters=${counters(s.id)}`);
}

// ---- 3. org window
{
  sql(`DELETE FROM phone_upload_org_rate;`);
  const ss = Array.from({ length: 13 }, session);
  const rs = [];
  for (const s of ss) for (let j = 0; j < 5; j++) rs.push(await call(s.token));
  const n200 = rs.filter((r) => r.status === 200).length;
  const r429 = rs.filter((r) => r.status === 429);
  check("local e2e: 65 requests over 13 sessions in one minute -> 60 x 200, 5 x 429 (per-org window)",
    n200 === 60 && r429.length === 5 && r429.every((r) => r.body.retry_after_seconds >= 1 && r.body.retry_after_seconds <= 60)
      && sql(`SELECT issued FROM phone_upload_org_rate WHERE org_id = '${orgId}';`) === "60",
    `200=${n200} 429=${r429.length}`);
}

// ---- 4. lifetime cap
{
  const s = session();
  sql(`UPDATE product_image_upload_sessions SET token_issue_count = 20 WHERE id = '${s.id}';`);
  sql(`DELETE FROM phone_upload_org_rate;`);
  const r = await call(s.token);
  check("local e2e: lifetime cap -> 429 with Retry-After ~ the session's remaining lifetime", r.status === 429 && r.body.retry_after_seconds > 500 && r.body.retry_after_seconds <= 600, `${r.status} ${r.retryAfter}`);
}

// ---- 5. fail closed: limiter not executable by service_role (as if 081 were missing)
{
  const s = session();
  sql(`REVOKE EXECUTE ON FUNCTION public.claim_phone_upload_token_issue(text) FROM service_role; NOTIFY pgrst, 'reload schema';`);
  await new Promise((r) => setTimeout(r, 1500));
  const before = await (await fetch(`${GW_URL}/storage/v1/object/_stats`)).json();
  const r = await call(s.token);
  const after = await (await fetch(`${GW_URL}/storage/v1/object/_stats`)).json();
  check("local e2e: limiter RPC refused (permission) -> 503 unavailable, NO token signed (fail closed)",
    r.status === 503 && r.body?.code === "unavailable" && after.signed === before.signed && counters(s.id) === "0|0", `${r.status} ${JSON.stringify(r.body)} signed ${before.signed}->${after.signed}`);
  sql(`GRANT EXECUTE ON FUNCTION public.claim_phone_upload_token_issue(text) TO service_role; NOTIFY pgrst, 'reload schema';`);
  await new Promise((r) => setTimeout(r, 1500));
  sql(`ALTER FUNCTION public.claim_phone_upload_token_issue(text) RENAME TO claim_phone_upload_token_issue_off; NOTIFY pgrst, 'reload schema';`);
  await new Promise((r) => setTimeout(r, 1500));
  const missing = await call(s.token);
  check("local e2e: limiter RPC missing (pre-081 schema) -> 503, no token", missing.status === 503 && !missing.body?.token, `${missing.status}`);
  sql(`ALTER FUNCTION public.claim_phone_upload_token_issue_off(text) RENAME TO claim_phone_upload_token_issue; NOTIFY pgrst, 'reload schema';`);
  await new Promise((r) => setTimeout(r, 1500));
  const back = await call(s.token);
  check("local e2e: limiter restored -> 200 again", back.status === 200, `${back.status}`);
}

// ---- 6. per-user session creation through PostgREST: PT429 -> HTTP 429
{
  const userJwt = jwt({ sub: authId, role: "authenticated", aud: "authenticated" });
  const anon = jwt({ role: "anon" });
  sql(`INSERT INTO product_image_upload_sessions (id, token_hash, created_by, storage_path, expires_at)
       SELECT 'pimg-fill' || g, md5('fill' || g || clock_timestamp()), '${userId}', 'org/${orgId}/temp/pimg-fill' || g, now() + interval '10 minutes'
         FROM generate_series(1, 120 - (SELECT count(*) FROM product_image_upload_sessions WHERE created_by = '${userId}' AND created_at > now() - interval '1 hour')) g;`);
  const r = await fetch(`${GW_URL}/rest/v1/rpc/create_product_image_upload_session`, {
    method: "POST", headers: { "content-type": "application/json", apikey: anon, Authorization: `Bearer ${userJwt}` }, body: JSON.stringify({}),
  });
  const body = await r.json().catch(() => null);
  check("local e2e: 121st session in an hour via PostgREST -> HTTP 429, code PT429, friendly message",
    r.status === 429 && body?.code === "PT429" && /^Too many phone upload links were created\. Try again in \d+ minutes\.$/.test(body?.message ?? ""),
    `${r.status} ${JSON.stringify(body)}`);
  const a = await fetch(`${GW_URL}/rest/v1/rpc/claim_phone_upload_token_issue`, {
    method: "POST", headers: { "content-type": "application/json", apikey: anon, Authorization: `Bearer ${anon}` }, body: JSON.stringify({ p_token: "x".repeat(64) }),
  });
  const u = await fetch(`${GW_URL}/rest/v1/rpc/claim_phone_upload_token_issue`, {
    method: "POST", headers: { "content-type": "application/json", apikey: anon, Authorization: `Bearer ${userJwt}` }, body: JSON.stringify({ p_token: "x".repeat(64) }),
  });
  check("local e2e: anon and authenticated cannot call claim_phone_upload_token_issue through PostgREST", a.status >= 400 && u.status >= 400 && a.status !== 429 && u.status !== 429, `anon ${a.status}, authenticated ${u.status}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`local e2e: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
