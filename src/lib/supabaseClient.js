import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config/supabase.js";
import { createSafeStorage } from "./storage.js";

// Use ESM build directly (no window.supabase global needed).
// jsDelivr +esm provides an ES module wrapper for supabase-js v2.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const storage = createSafeStorage();

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
    storage,
    storageKey: "cpaStudyAssistant.sb.auth",
  },
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
  },
});

