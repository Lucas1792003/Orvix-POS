// HARNESS STUB (NOT from git): only what idempotentRpc.ts uses — SYNC_STATE_KEYS.executorDemonstrated
// (value copied from 93ad308 src/lib/localDb.ts:214) and an in-memory syncState table.
export const SYNC_STATE_KEYS = { executorDemonstrated: "executor-086-seen:" } as const;
const mem = new Map<string, unknown>();
export const localDb = {
  syncState: {
    get: async (key: string) => mem.get(key),
    put: async (row: { key: string }) => { mem.set(row.key, row); },
  },
};
export function __resetHarnessLocalDb(): void { mem.clear(); }
