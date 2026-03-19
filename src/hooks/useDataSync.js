import { supabase } from "../lib/supabaseClient.js";

/**
 * Vanilla equivalent of a "useDataSync" hook.
 *
 * - Loads user state from Supabase (table: app_state, keyed by user_id)
 * - Subscribes to realtime changes and calls back with a reload signal
 * - Provides save(upsert) helper
 *
 * @param {{
 *  table?: string,
 *  onRemoteChange?: (payload: any) => void,
 *  onError?: (err: any) => void,
 * }} opts
 */
export function useDataSync(opts = {}) {
  const table = opts.table ?? "app_state";
  let channel = null;
  let userId = null;

  const dispose = async () => {
    if (!channel) return;
    try {
      await supabase.removeChannel(channel);
    } catch {}
    channel = null;
  };

  const load = async (uid) => {
    userId = uid;
    const { data, error } = await supabase.from(table).select("data, updated_at").eq("user_id", uid).maybeSingle();
    if (error) throw error;
    return data?.data ?? null;
  };

  const save = async (uid, state) => {
    userId = uid;
    const payload = { user_id: uid, data: state, updated_at: new Date().toISOString() };
    const { error } = await supabase.from(table).upsert(payload, { onConflict: "user_id" });
    if (error) throw error;
  };

  const subscribe = async (uid) => {
    userId = uid;
    await dispose();

    channel = supabase
      .channel(`sync:${table}:${uid}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `user_id=eq.${uid}` },
        (payload) => {
          try {
            opts.onRemoteChange?.(payload);
          } catch (e) {
            opts.onError?.(e);
          }
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") return;
        // Realtime can be flaky on mobile backgrounding; treat other statuses as non-fatal.
      });
  };

  const resubscribeIfNeeded = async () => {
    if (!userId) return;
    if (!channel) return subscribe(userId);
    try {
      // Try a lightweight reconnect; if it fails, rebuild channel.
      supabase.realtime.connect();
    } catch {}
  };

  return { load, save, subscribe, resubscribeIfNeeded, dispose };
}

