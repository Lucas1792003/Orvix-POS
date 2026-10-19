// HARNESS STUB (NOT from git). The real file builds a supabase-js client.
// Here every call is delegated to the client the harness installs on
// globalThis.__HARNESS_SUPABASE__ (real @supabase/postgrest-js 2.106.1 from the
// repo's node_modules, with a fixture-serving fetch), resolved at call time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const h = (): any => (globalThis as any).__HARNESS_SUPABASE__;
export const supabase = {
  rpc: (fn: string, args?: unknown, opts?: unknown) => h().rpc(fn, args, opts),
  from: (table: string) => h().from(table),
  auth: {
    getSession: async () => ({ data: { session: { expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null }),
    refreshSession: async () => ({ data: { session: { expires_at: Math.floor(Date.now() / 1000) + 3600 } }, error: null }),
  },
};
