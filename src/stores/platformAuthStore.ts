import { create } from "zustand";
import { supabase } from "../lib/supabase";

// Fully separate from authStore.ts by design — shares no state or code
// with the normal org login flow. A platform admin's Supabase Auth
// account is never linked to any org's `users` row; passing the
// password check here proves nothing on its own; every action goes
// through the platform-console Edge Function, which separately checks
// `platform_admins` membership (a table the client can never read).

// A type alias (not an interface) so it satisfies callConsole's
// `Record<string, unknown>` constraint — interfaces have no implicit index signature.
export type PlatformAdminProfile = {
  name: string;
  email: string;
};

interface PlatformAuthState {
  adminProfile: PlatformAdminProfile | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<{ error: string | null }>;
  logout: () => Promise<void>;
  /** Re-checks the current Supabase session against platform_admins. Used
   *  on mount by PlatformConsolePage so a stale/foreign session can't
   *  render the console before the server-side check comes back. */
  restore: () => Promise<void>;
}

async function callConsole<T extends Record<string, unknown>>(
  body: Record<string, unknown>,
): Promise<{ data: T | null; error: string | null }> {
  const { data, error } = await supabase.functions.invoke<T>("platform-console", { body });
  if (error) {
    let message = error.message;
    const ctx = (error as { context?: unknown }).context;
    if (ctx && typeof (ctx as Response).json === "function") {
      try {
        const parsed = await (ctx as Response).json();
        if (parsed?.error) message = String(parsed.error);
      } catch {
        /* keep the generic message */
      }
    }
    return { data: null, error: message };
  }
  return { data: data ?? null, error: null };
}

export const usePlatformAuthStore = create<PlatformAuthState>((set) => ({
  adminProfile: null,
  isLoading: false,

  login: async (email, password) => {
    set({ isLoading: true });
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) {
      set({ isLoading: false, adminProfile: null });
      return { error: "Invalid credentials." };
    }

    const { data, error } = await callConsole<PlatformAdminProfile>({ action: "whoami" });
    if (error || !data) {
      await supabase.auth.signOut();
      set({ isLoading: false, adminProfile: null });
      return { error: "Invalid credentials." };
    }

    set({ isLoading: false, adminProfile: data });
    return { error: null };
  },

  logout: async () => {
    await supabase.auth.signOut();
    set({ adminProfile: null });
  },

  restore: async () => {
    set({ isLoading: true });
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) {
      set({ isLoading: false, adminProfile: null });
      return;
    }
    const { data, error } = await callConsole<PlatformAdminProfile>({ action: "whoami" });
    if (error || !data) {
      await supabase.auth.signOut();
      set({ isLoading: false, adminProfile: null });
      return;
    }
    set({ isLoading: false, adminProfile: data });
  },
}));

export { callConsole as callPlatformConsole };
