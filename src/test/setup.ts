// vitest setup — runs before every test file (see vitest.config.ts).
//
// 1. The unit suite never talks to a real backend. Vite loads .env.local
//    into import.meta.env for vitest too, which is how a stray hosted URL
//    could reach src/lib/supabase.ts; pin the backend env to a local
//    placeholder first. A test that wants other values stubs them itself
//    (src/lib/supabase.test.ts, src/live/phase-d.live.test.ts).
// 2. Hosted guard: any request to *.supabase.co throws AND fails the test
//    that caused it (afterEach below) — a hard failure, not a logged abort.
//    See src/test/hostedGuard.ts for the incident this exists for.
import { afterEach, vi } from "vitest";
import { installHostedBackendGuard, takeHostedAttempts } from "./hostedGuard";
import { clearStoreTimers, storeWorkIdle } from "../stores/data/storeTimers";

export const TEST_BACKEND_URL = "http://127.0.0.1:54321";
export const TEST_BACKEND_ANON_KEY = "test-anon-key";

vi.stubEnv("VITE_SUPABASE_URL", TEST_BACKEND_URL);
vi.stubEnv("VITE_SUPABASE_ANON_KEY", TEST_BACKEND_ANON_KEY);
vi.stubEnv("VITE_SUPABASE_EXPECTED_HOST", "");

installHostedBackendGuard();

afterEach(async () => {
  // A follow-up refresh a test's store already STARTED must finish before
  // the next test resets the fake server and clears the database under it
  // (otherwise its mirror transaction and the next test's clears deadlock in
  // fake-indexeddb — the long-standing "FULL LOAD" hook timeout under load).
  await storeWorkIdle();
  // Follow-up refreshes a test's store scheduled must not fire in the next test.
  clearStoreTimers();
  const attempted = takeHostedAttempts();
  if (attempted.length > 0) {
    throw new Error(
      `${attempted.length} request(s) to the hosted Supabase project were refused during this test: ` +
      attempted.map((u) => new URL(u).host).join(", "),
    );
  }
});
