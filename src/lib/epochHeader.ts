// ----------------------------------------------------------------------
// Migration 087: `x-orvix-epoch` on PostgREST writes.
//
// With 087 installed (legacy paths closed), every PostgREST write by an API
// role must carry `x-orvix-epoch` = the organisation's recovery epoch under
// which the write was CREATED (docs/selfhost-migration/phase-g/migration-087.md,
// "Legacy paths closed at install"). This wrapper adds the header to a
// /rest/v1/ write only when the request does not carry one already: a queued
// write sets its own creation epoch (stores/data/tableWrite.ts), and is never
// re-stamped here. The value comes from a provider registered by
// stores/data/recoveryState.ts (no import of the store here: lib/supabase.ts
// is loaded before the stores). No provider, or no epoch: no header (the
// server then refuses the write with CLIENT_UPGRADE_REQUIRED, fail closed).
// ----------------------------------------------------------------------

export const EPOCH_HEADER = "x-orvix-epoch";

let provider: () => string | null = () => null;

/** Wired once by stores/data/recoveryState.ts: the epoch a write created NOW belongs to. */
export function setEpochHeaderProvider(next: () => string | null): void {
  provider = next;
}

const WRITE_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

function hasHeader(headers: HeadersInit | undefined, name: string): boolean {
  if (!headers) return false;
  if (headers instanceof Headers) return headers.has(name);
  if (Array.isArray(headers)) return headers.some(([k]) => k.toLowerCase() === name);
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

function withHeader(headers: HeadersInit | undefined, name: string, value: string): HeadersInit {
  if (headers instanceof Headers) {
    const h = new Headers(headers);
    h.set(name, value);
    return h;
  }
  if (Array.isArray(headers)) return [...headers, [name, value]];
  return { ...(headers ?? {}), [name]: value };
}

/** Wrap a fetch: PostgREST writes get the current epoch unless they carry one. */
export function epochHeaderFetch(inner: typeof fetch): typeof fetch {
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    let path = "";
    try { path = new URL(url).pathname; } catch { path = ""; }
    if (!path.startsWith("/rest/v1/") || !WRITE_METHODS.has(method) || hasHeader(init?.headers, EPOCH_HEADER)) {
      return inner(input, init);
    }
    let epoch: string | null = null;
    try { epoch = provider(); } catch { epoch = null; }
    if (!epoch) return inner(input, init);
    return inner(input, { ...init, headers: withHeader(init?.headers, EPOCH_HEADER, epoch) });
  };
}
