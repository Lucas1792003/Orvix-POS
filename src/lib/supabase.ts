import { createClient } from "@supabase/supabase-js";
import { useToastStore } from "../stores/toastStore";
import { getErrorMessage } from "./errors";
import { resolveBackendConfig } from "./backendConfig";

// Fail closed: a missing/empty URL or key, or a host other than the one
// this build was pinned to (VITE_SUPABASE_EXPECTED_HOST), throws here —
// at module load, i.e. at app startup — instead of creating a client
// against a default or unexpected backend. main.tsx catches this and shows
// the message on screen. See lib/backendConfig.ts.
const backend = resolveBackendConfig({
  VITE_SUPABASE_URL: import.meta.env.VITE_SUPABASE_URL,
  VITE_SUPABASE_ANON_KEY: import.meta.env.VITE_SUPABASE_ANON_KEY,
  VITE_SUPABASE_EXPECTED_HOST: import.meta.env.VITE_SUPABASE_EXPECTED_HOST,
});

/** Host (and port) of the backend this build talks to — shown on the login
 *  page and in the sidebar footer so a till shows what it is connected to. */
export const backendHost = backend.host;

export const supabase = createClient(backend.url, backend.anonKey);

/** Backend REST origin + public anon key, for the few calls that need the raw
 *  HTTP response (status code, Retry-After) that supabase-js does not expose. */
export const backendRest = { url: backend.url, anonKey: backend.anonKey } as const;

// Fire-and-forget write — shows a friendly error toast + console log on failure.
// Prefer dbExec for new code; this remains for legacy callers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dbWrite(query: PromiseLike<{ error: any }>, label: string) {
  query.then(({ error }) => {
    if (error) {
      console.error(`[DB] ${label} failed:`, error);
      useToastStore.getState().addToast({
        variant: "error",
        title: "Save failed",
        description: getErrorMessage(error, "Please try again."),
      });
    }
  });
}

/**
 * Awaited write for critical data. Throws a controlled, friendly error on
 * failure so the caller can abort before mutating local state. The caller is
 * responsible for surfacing the error to the UI (via useAsyncAction, a toast,
 * or an inline message).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function dbExec(query: PromiseLike<{ error: any }>, label: string): Promise<void> {
  const { error } = await query;
  if (error) {
    console.error(`[DB] ${label} failed:`, error);
    throw new Error(getErrorMessage(error, `${label} failed.`));
  }
}

/**
 * Awaited write for audit/ledger-secondary rows. Logs on failure but never
 * throws — a lost audit row must not roll back an already-persisted operation.
 * (Full transactional audit is handled in the next, RPC-based step.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function dbAudit(query: PromiseLike<{ error: any }>, label: string): Promise<void> {
  const { error } = await query;
  if (error) console.error(`[DB] audit ${label} failed (non-fatal):`, error.message);
}
