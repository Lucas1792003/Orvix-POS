// ----------------------------------------------------------------------
// Owner reconciliation authority (1.0.16 RC3). Runs in the MAIN process.
//
// attest(): the renderer asks to reconcile one outbox entry. Main itself
//   verifies the session with the backend AT THAT MOMENT — no cache, no
//   offline shortcut (unlike the updater's recovery path, ownerVerify.cjs):
//     1. POST <backend>/rest/v1/rpc/app_role     -> must be "ADMIN" (003)
//     2. POST <backend>/rest/v1/rpc/app_user_id  -> the app user id (015)
//     3. GET  <backend>/rest/v1/users?id=eq.<id> -> name / role / active / org
//        (RLS 056: a user always reads their own row)
//   with the backend origin + anon key of the packaged build (never from the
//   renderer). Only then does it return the server's owner identity and an
//   HMAC-SHA-256 seal over (localId, entryDigest, recordDigest, owner id,
//   owner name, verification time). The HMAC key lives in userData
//   (reconcile-seal.key, 0600) and never crosses to the renderer, so code
//   running in the renderer cannot mint a valid reconciliation on its own:
//   it needs the owner's live session and a server that confirms it.
// verifySeals(): checks seals of stored reconciliations (on load / before
//   every update-guard report). A bad seal = the record or the entry was
//   edited outside this flow -> the row goes back to "needs attention".
//
// Residual: an administrator of the machine can read the key file and the
// IndexedDB and forge both. Only a server-side record closes that (proposal
// in docs/desktop-app/release-1.0.16.md §11).
//
// The token is used for these requests only and never logged or stored.
// Dependency-free apart from node:crypto/fs; fetch and the key store are
// injectable for tests (src/lib/reconcile/authority.test.ts).
// ----------------------------------------------------------------------
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const OWNER_ROLE = "ADMIN";
const TIMEOUT_MS = 8_000;
const HEX64 = /^[0-9a-f]{64}$/;

/** Key file in userData: created once (32 random bytes), mode 0600. */
function fileKeyStore(filePath) {
  let cached = null;
  return {
    load() {
      if (cached) return cached;
      try {
        const hex = fs.readFileSync(filePath, "utf8").trim();
        if (/^[0-9a-f]{64,}$/.test(hex)) {
          cached = Buffer.from(hex, "hex");
          return cached;
        }
      } catch {
        /* missing: create below */
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const hex = crypto.randomBytes(32).toString("hex");
      try {
        fs.writeFileSync(filePath, `${hex}\n`, { mode: 0o600, flag: "wx" });
        cached = Buffer.from(hex, "hex");
      } catch {
        // Another process created it first: use that one.
        const again = fs.readFileSync(filePath, "utf8").trim();
        if (!/^[0-9a-f]{64,}$/.test(again)) throw new Error("reconcile seal key unreadable");
        cached = Buffer.from(again, "hex");
      }
      return cached;
    },
  };
}

function sealMessage(f) {
  // Fixed key order: main is the only place that builds this string.
  return JSON.stringify({
    v: 1, localId: f.localId, entryDigest: f.entryDigest, recordDigest: f.recordDigest,
    ownerUserId: f.ownerUserId, ownerName: f.ownerName, verifiedAt: f.verifiedAt,
  });
}

/**
 * @param {{ backend: { origin: string, anonKey: string } | null, keyStore: { load: () => Buffer } | null,
 *           fetchImpl?: typeof fetch, now?: () => number, timeoutMs?: number }} opts
 */
function createReconcileAuthority(opts) {
  const backend = opts.backend;
  const keyStore = opts.keyStore;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;

  function key() {
    try {
      return keyStore ? keyStore.load() : null;
    } catch {
      return null;
    }
  }

  async function call(token, method, pathname) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${backend.origin}/rest/v1/${pathname}`, {
        method,
        headers: { "Content-Type": "application/json", Accept: "application/json", apikey: backend.anonKey, Authorization: `Bearer ${token}` },
        body: method === "POST" ? "{}" : undefined,
        signal: controller.signal,
      });
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, ok: res.ok, body };
    } catch {
      return { status: 0, ok: false, body: null };
    } finally {
      clearTimeout(timer);
    }
  }

  const offline = (step) => ({
    ok: false, code: "offline",
    message: "The server could not be reached, so it cannot confirm that you are the owner. Reconciling needs a live owner check: try again when the till is online.",
    step,
  });

  /** Fresh server verification of the owner. Never cached. */
  async function verifyOwnerNow(token) {
    if (typeof token !== "string" || token.length < 16 || token.length > 16_384) {
      return { ok: false, code: "no-session", message: "Sign in as the owner on this till first." };
    }
    if (!backend) {
      return { ok: false, code: "unavailable", message: "This build cannot verify the owner (no backend configuration). Reconciling is not available." };
    }
    const role = await call(token, "POST", "rpc/app_role");
    if (role.status === 0 || role.status >= 500) return offline("app_role");
    if (role.status === 401 || role.status === 403) {
      return { ok: false, code: "session-rejected", message: "The server rejected this sign-in. Sign in again as the owner." };
    }
    if (!role.ok || role.body !== OWNER_ROLE) {
      return { ok: false, code: "not-owner", role: typeof role.body === "string" ? role.body : null, message: "The server says this user is not the owner (administrator). Only the owner can reconcile." };
    }
    const uid = await call(token, "POST", "rpc/app_user_id");
    if (uid.status === 0 || uid.status >= 500) return offline("app_user_id");
    if (!uid.ok || typeof uid.body !== "string" || !uid.body) {
      return { ok: false, code: "unverified", message: "The server did not return the owner's user id. Nothing was reconciled." };
    }
    const users = await call(token, "GET", `users?select=id,name,role,is_active,org_id&id=eq.${encodeURIComponent(uid.body)}`);
    if (users.status === 0 || users.status >= 500) return offline("users");
    const row = Array.isArray(users.body) && users.body.length === 1 ? users.body[0] : null;
    if (!users.ok || !row || row.id !== uid.body || row.role !== OWNER_ROLE || row.is_active !== true) {
      return { ok: false, code: "unverified", message: "The server did not confirm the owner's profile. Nothing was reconciled." };
    }
    return {
      ok: true, code: "owner",
      owner: {
        userId: row.id, name: typeof row.name === "string" && row.name ? row.name : row.id,
        orgId: typeof row.org_id === "string" ? row.org_id : null, role: OWNER_ROLE,
        verifiedAt: new Date(now()).toISOString(), source: "backend",
      },
    };
  }

  function hmac(k, fields) {
    return crypto.createHmac("sha256", k).update(sealMessage(fields)).digest("hex");
  }

  /** @returns {Promise<{ ok: boolean, code: string, message?: string, owner?: object, seal?: string }>} */
  async function attest(token, request) {
    const r = request && typeof request === "object" ? request : {};
    if (typeof r.localId !== "string" || !r.localId || r.localId.length > 200 || !HEX64.test(r.entryDigest) || !HEX64.test(r.recordDigest)) {
      return { ok: false, code: "bad-request", message: "Malformed reconciliation request." };
    }
    const k = key();
    if (!k) return { ok: false, code: "unavailable", message: "The reconciliation key could not be opened on this till. Reconciling is not available." };
    const v = await verifyOwnerNow(token);
    if (!v.ok) return v;
    const seal = hmac(k, {
      localId: r.localId, entryDigest: r.entryDigest, recordDigest: r.recordDigest,
      ownerUserId: v.owner.userId, ownerName: v.owner.name, verifiedAt: v.owner.verifiedAt,
    });
    return { ok: true, code: "owner", owner: v.owner, seal, message: "Owner verified by the server." };
  }

  /** One boolean per item: the seal is main's own for exactly these fields. */
  function verifySeals(items) {
    const k = key();
    if (!Array.isArray(items)) return [];
    return items.slice(0, 10_000).map((it) => {
      if (!k || !it || typeof it !== "object" || typeof it.seal !== "string" || !HEX64.test(it.seal)) return false;
      if (![it.localId, it.entryDigest, it.recordDigest, it.ownerUserId, it.ownerName, it.verifiedAt].every((s) => typeof s === "string")) return false;
      const expected = Buffer.from(hmac(k, it), "hex");
      const given = Buffer.from(it.seal, "hex");
      return expected.length === given.length && crypto.timingSafeEqual(expected, given);
    });
  }

  return { attest, verifySeals, verifyOwnerNow };
}

module.exports = { createReconcileAuthority, fileKeyStore, OWNER_ROLE };
