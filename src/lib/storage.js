/**
 * localStorage wrapper that survives Safari/Private/ITP restrictions.
 * When storage is blocked/throws, it silently falls back to in-memory storage.
 */
export function createSafeStorage() {
  /** @type {Map<string, string>} */
  const mem = new Map();

  const canUseLocalStorage = () => {
    try {
      const k = "__cpa_ls_test__";
      window.localStorage.setItem(k, "1");
      window.localStorage.removeItem(k);
      return true;
    } catch {
      return false;
    }
  };

  const hasLocal = typeof window !== "undefined" && !!window.localStorage && canUseLocalStorage();

  return {
    getItem: (key) => {
      if (hasLocal) {
        try {
          return window.localStorage.getItem(key);
        } catch {
          // fall through
        }
      }
      return mem.has(key) ? mem.get(key) : null;
    },
    setItem: (key, value) => {
      if (hasLocal) {
        try {
          window.localStorage.setItem(key, value);
          return;
        } catch {
          // fall through
        }
      }
      mem.set(key, String(value));
    },
    removeItem: (key) => {
      if (hasLocal) {
        try {
          window.localStorage.removeItem(key);
        } catch {}
      }
      mem.delete(key);
    },
  };
}

