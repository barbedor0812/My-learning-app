import { supabase } from "../lib/supabaseClient.js";

/**
 * Vanilla equivalent of a "useAuth" hook:
 * - subscribe to auth state
 * - provide signIn/signUp/signOut helpers
 *
 * @param {(session: any, event: string) => void} onChange
 */
export function useAuth(onChange) {
  let unsub = null;

  const bind = async () => {
    const { data } = await supabase.auth.getSession();
    onChange?.(data?.session ?? null, "INITIAL_SESSION");
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      onChange?.(session ?? null, event);
    });
    unsub = () => sub?.subscription?.unsubscribe?.();
  };

  const dispose = () => {
    try {
      unsub?.();
    } catch {}
    unsub = null;
  };

  const signIn = async ({ email, password }) => supabase.auth.signInWithPassword({ email, password });
  const signUp = async ({ email, password }) => supabase.auth.signUp({ email, password });
  const signOut = async () => supabase.auth.signOut();

  return { bind, dispose, signIn, signUp, signOut };
}

