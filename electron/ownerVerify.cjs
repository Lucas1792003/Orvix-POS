// ----------------------------------------------------------------------
// Owner verification for the updater's recovery path (RC2, D4). Runs in the
// MAIN process, so the renderer cannot grant itself the owner role over IPC:
//
//   * the renderer hands over only the signed-in session's access token;
//   * main asks the backend itself — POST <backend>/rest/v1/rpc/app_role
//     (migration 003: the role of the ACTIVE app user behind auth.uid(),
//     granted to `authenticated`) — with the backend origin and anon key
//     main reads from the packaged build (dist/backend.json, written by
//     vite.config.ts for the Electron build; never from the renderer);
//   * only "ADMIN" (the owner) passes;
//   * offline (network failure / timeout / 5xx only): passes when THIS main
//     process verified exactly the same token as ADMIN against the backend
//     within OFFLINE_TTL_MS (the bridge primes this while online, see
//     src/lib/updateGuardBridge.ts). A 401/403 or any other role clears it.
//
// The token is used for this one request, kept only as a SHA-256 digest in
// memory, and never logged. Dependency-free apart from node:crypto/fs;
// `fetchImpl` is injectable for tests (src/lib/updateGuard.test.ts).
// ----------------------------------------------------------------------
const crypto = require("node:crypto");
const fs = require("node:fs");

const OWNER_ROLE = "ADMIN";
const VERIFY_TIMEOUT_MS = 8_000;
const OFFLINE_TTL_MS = 12 * 60 * 60 * 1000;

const digest = (token) => crypto.createHash("sha256").update(token).digest("hex");

/** Backend origin + anon key of the packaged build, or null. */
function loadBackendConfig(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const url = new URL(String(raw.url || ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (typeof raw.anonKey !== "string" || !raw.anonKey) return null;
    return { origin: url.origin, anonKey: raw.anonKey };
  } catch {
    return null;
  }
}

/**
 * @param {{ backend: { origin: string, anonKey: string } | null, fetchImpl?: typeof fetch, now?: () => number,
 *           timeoutMs?: number, offlineTtlMs?: number }} opts
 */
function createOwnerVerifier(opts) {
  const backend = opts.backend;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? VERIFY_TIMEOUT_MS;
  const offlineTtlMs = opts.offlineTtlMs ?? OFFLINE_TTL_MS;
  /** digest(token) -> time main last verified it as the owner online. */
  const verified = new Map();

  /** @returns {Promise<{ ok: boolean, code: string, source?: "backend" | "cached", role?: string | null, message: string }>} */
  async function verify(accessToken) {
    if (typeof accessToken !== "string" || accessToken.length < 16 || accessToken.length > 16_384) {
      return { ok: false, code: "no-session", message: "Sign in as the owner on this till first." };
    }
    if (!backend) {
      return { ok: false, code: "unavailable", message: "This build cannot verify the owner (no backend configuration). Install anyway is not available." };
    }
    const key = digest(accessToken);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${backend.origin}/rest/v1/rpc/app_role`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: backend.anonKey, Authorization: `Bearer ${accessToken}` },
        body: "{}",
        signal: controller.signal,
      });
    } catch {
      res = null;
    } finally {
      clearTimeout(timer);
    }

    if (!res || res.status >= 500 || res.status === 0) {
      const at = verified.get(key);
      if (typeof at === "number" && now() - at <= offlineTtlMs) {
        return { ok: true, code: "owner", source: "cached", role: OWNER_ROLE, message: "Owner verified earlier in this session (server unreachable now)." };
      }
      return { ok: false, code: "offline", message: "The server could not confirm that you are the owner. Sign in as the owner while the server is reachable, then try again." };
    }
    if (res.status === 401 || res.status === 403) {
      verified.delete(key);
      return { ok: false, code: "session-rejected", message: "The server rejected this sign-in. Sign in again as the owner." };
    }
    let role = null;
    try {
      const body = await res.json();
      role = typeof body === "string" ? body : null;
    } catch {
      role = null;
    }
    if (res.ok && role === OWNER_ROLE) {
      verified.set(key, now());
      return { ok: true, code: "owner", source: "backend", role, message: "Owner verified by the server." };
    }
    verified.delete(key);
    return { ok: false, code: "not-owner", role, message: "Only the owner (administrator) can install anyway. Ask the owner to sign in on this till." };
  }

  return { verify, _size: () => verified.size };
}

module.exports = { createOwnerVerifier, loadBackendConfig, OWNER_ROLE, OFFLINE_TTL_MS };
