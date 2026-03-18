const pdfjsLib = window.pdfjsLib;
if (pdfjsLib?.GlobalWorkerOptions) {
  // PDF.js in browsers typically needs an explicit worker URL.
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    new URL("./pdf.worker.min.js", window.location.href).toString();
}

// ---- Supabase config ----
const SUPABASE_URL = "https://vwdoqofrfpwyxcqmzynh.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_CbFm6sZSClJ9SJgF_1qgpg_YUqgBq8x";

/** @type {any|null} */
let supabaseClient = null;
try {
  if (window.supabase?.createClient) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } else {
    console.warn("Supabase library not loaded. Check network/CDN.");
  }
} catch (e) {
  console.error("Supabase init failed", e);
  supabaseClient = null;
}

const STORAGE_KEY = "cpaStudyAssistant.v1";

const EBBINGHAUS_DAYS = [1, 2, 4, 7, 15, 30];

function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const CLIENT_ID_KEY = `${STORAGE_KEY}.clientId`;
let CLIENT_ID = localStorage.getItem(CLIENT_ID_KEY);
if (!CLIENT_ID) {
  CLIENT_ID = uid("client");
  localStorage.setItem(CLIENT_ID_KEY, CLIENT_ID);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toISODateLocal(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function parseISODateLocal(iso) {
  const parts = String(iso ?? "").split("-");
  if (parts.length !== 3) return null;
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (y <= 0 || m <= 0 || d <= 0) return null;
  return new Date(y, m - 1, d);
}

function todayISO() {
  return toISODateLocal(new Date());
}

function addDaysISO(isoDate, days) {
  const base = parseISODateLocal(isoDate) ?? new Date();
  base.setDate(base.getDate() + days);
  return toISODateLocal(base);
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function escapeHtml(s) {
  return (s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatHours(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  const rounded = Math.round(n * 100) / 100;
  return `${rounded} 小时`;
}

function parseTags(tagStr) {
  return (tagStr ?? "")
    .split(/[，,]/g)
    .map((t) => t.trim())
    .filter(Boolean);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialState();
    const parsed = JSON.parse(raw);
    return migrateState(parsed);
  } catch {
    return createInitialState();
  }
}

async function loadFromCloud(userId) {
  if (!supabaseClient) throw new Error("Supabase 未加载");
  const { data, error } = await supabaseClient
    .from("app_state")
    .select("data")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return createInitialState();
  return migrateState(data.data);
}

async function saveToCloud(userId) {
  if (!supabaseClient) throw new Error("Supabase 未加载");
  const payload = {
    user_id: userId,
    data: state,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabaseClient
    .from("app_state")
    .upsert(payload, { onConflict: "user_id" });
  if (error) throw error;
}

let savingTimer = null;
let cloudSaveInFlight = null;
let cloudSaveQueued = false;
let applyingRemote = false;
let realtimeChannel = null;
let cloudPollTimer = null;
let cloudHooksBound = false;
let cloudRetryTimer = null;
let cloudRetryDelayMs = 2000;

function withTimeout(promise, ms) {
  let t = null;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error("timeout")), ms);
    }),
  ]).finally(() => {
    if (t) clearTimeout(t);
  });
}

function touchCloudMeta() {
  if (applyingRemote) return;
  const cm = state.cloudMeta && typeof state.cloudMeta === "object" ? state.cloudMeta : {};
  state.cloudMeta = {
    rev: (Number(cm.rev) || 0) + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: CLIENT_ID,
  };
}

function shouldApplyRemote(remote) {
  if (!remote || typeof remote !== "object") return false;
  const rcm = remote.cloudMeta && typeof remote.cloudMeta === "object" ? remote.cloudMeta : null;
  const lcm = state.cloudMeta && typeof state.cloudMeta === "object" ? state.cloudMeta : null;
  const rRev = Number(rcm?.rev) || 0;
  const lRev = Number(lcm?.rev) || 0;
  const rBy = String(rcm?.updatedBy || "");
  if (rBy && rBy === CLIENT_ID) return false;
  if (rRev > lRev) return true;
  const rAt = String(rcm?.updatedAt || "");
  const lAt = String(lcm?.updatedAt || "");
  return rAt && rAt > lAt;
}

function isStateNewer(a, b) {
  const acm = a && typeof a === "object" ? (a.cloudMeta && typeof a.cloudMeta === "object" ? a.cloudMeta : null) : null;
  const bcm = b && typeof b === "object" ? (b.cloudMeta && typeof b.cloudMeta === "object" ? b.cloudMeta : null) : null;
  const aAt = String(acm?.updatedAt || "");
  const bAt = String(bcm?.updatedAt || "");
  if (aAt && bAt && aAt !== bAt) return aAt > bAt;
  const aRev = Number(acm?.rev) || 0;
  const bRev = Number(bcm?.rev) || 0;
  if (aRev !== bRev) return aRev > bRev;
  return false;
}

function applyRemoteState(remote) {
  applyingRemote = true;
  state = migrateState(remote);
  saveState();
  applyingRemote = false;
  renderAll();
}

async function syncFromCloud() {
  if (!currentUser?.id) return;
  try {
    const remote = await loadFromCloud(currentUser.id);
    if (shouldApplyRemote(remote)) applyRemoteState(remote);
  } catch (e) {
    console.error(e);
  }
}

function stopCloudSync() {
  if (realtimeChannel) {
    try {
      realtimeChannel.unsubscribe();
    } catch {}
    realtimeChannel = null;
  }
  if (cloudPollTimer) {
    clearInterval(cloudPollTimer);
    cloudPollTimer = null;
  }
}

function startCloudSync(userId) {
  stopCloudSync();
  if (!supabaseClient) return;

  realtimeChannel = supabaseClient
    .channel(`app_state_${userId}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "app_state", filter: `user_id=eq.${userId}` },
      (payload) => {
        const remote = payload?.new?.data;
        if (!remote) return;
        const migrated = migrateState(remote);
        if (shouldApplyRemote(migrated)) applyRemoteState(migrated);
      },
    )
    .subscribe();

  cloudPollTimer = setInterval(syncFromCloud, 2000);

  if (!cloudHooksBound) {
    cloudHooksBound = true;
    window.addEventListener("focus", syncFromCloud);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") syncFromCloud();
    });
  }
}

async function flushCloudSave() {
  if (!currentUser?.id) return;
  if (cloudSaveInFlight) {
    cloudSaveQueued = true;
    return;
  }

  cloudSaveInFlight = (async () => {
    try {
      setCloudStatus("云端：同步中…", "warn");
      await withTimeout(saveToCloud(currentUser.id), 10000);
      setCloudStatus("云端：已同步", "ok");
      cloudRetryDelayMs = 2000;
      if (cloudRetryTimer) {
        clearTimeout(cloudRetryTimer);
        cloudRetryTimer = null;
      }
    } catch (err) {
      console.error(err);
      setCloudStatus("云端：同步失败（自动重试）", "bad");
      if (!cloudRetryTimer) {
        const delay = cloudRetryDelayMs;
        cloudRetryDelayMs = Math.min(60000, Math.floor(cloudRetryDelayMs * 1.7));
        cloudRetryTimer = setTimeout(() => {
          cloudRetryTimer = null;
          flushCloudSave();
        }, delay);
      }
    } finally {
      cloudSaveInFlight = null;
      if (cloudSaveQueued) {
        cloudSaveQueued = false;
        flushCloudSave();
      }
    }
  })();
}

function scheduleSave() {
  touchCloudMeta();
  saveState();
  if (savingTimer) clearTimeout(savingTimer);
  savingTimer = setTimeout(async () => {
    savingTimer = null;
    await flushCloudSave();
  }, 1000);
}

function saveState() {
  const HISTORY_KEY = `${STORAGE_KEY}.history`;
  try {
    const prev = localStorage.getItem(STORAGE_KEY);
    const next = JSON.stringify(state);
    if (prev && prev !== next) {
      const raw = localStorage.getItem(HISTORY_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      const list = Array.isArray(arr) ? arr : [];
      list.unshift({ at: new Date().toISOString(), data: prev });
      while (list.length > 5) list.pop();
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
    }
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
}

function createInitialState() {
  return {
    version: 2,
    cloudMeta: { rev: 0, updatedAt: null, updatedBy: null },
    notes: [],
    folders: [],
    reviewTasks: [],
    plans: [], // multi-subject plans
    dayLog: {},
    studyLog: [],
    ui: {
      lastRoute: "today",
      activeNoteId: null,
      activeFolderId: "all",
      activePlanId: null,
      calendarYM: null, // "YYYY-MM"
      expandedFolderIds: [],
      editorShowClozeHighlight: true,
    },
  };
}

function migrateState(s) {
  if (!s || typeof s !== "object") return createInitialState();
  const base = createInitialState();
  const out = { ...base, ...s };
  out.cloudMeta = out.cloudMeta && typeof out.cloudMeta === "object" ? out.cloudMeta : base.cloudMeta;
  out.cloudMeta.rev = Number(out.cloudMeta.rev) || 0;
  out.cloudMeta.updatedAt = out.cloudMeta.updatedAt ?? null;
  out.cloudMeta.updatedBy = out.cloudMeta.updatedBy ?? null;

  // ---- Plans (multi-subject) ----
  // Migrate old single plan -> plans[0]
  if (!Array.isArray(out.plans)) out.plans = [];
  if (out.plans.length === 0) {
    const legacy = s.plan && typeof s.plan === "object" ? s.plan : null;
    const now = new Date().toISOString();
    const subj = (legacy?.subject ?? "").trim() || "默认科目";
    out.plans.push({
      id: uid("pln"),
      subject: subj,
      totalHours: Number(legacy?.totalHours ?? 0) || 0,
      dueDate: legacy?.dueDate ?? "",
      dailyHours: Number(legacy?.dailyHours ?? 2) || 2,
      specialRules: Array.isArray(legacy?.specialRules) ? legacy.specialRules : [],
      generated: legacy?.generated ?? null,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    out.plans = out.plans.map((p) => ({
      id: p?.id ?? uid("pln"),
      subject: (p?.subject ?? "").trim() || "未命名科目",
      totalHours: Number(p?.totalHours ?? 0) || 0,
      dueDate: p?.dueDate ?? "",
      dailyHours: Number(p?.dailyHours ?? 2) || 2,
      specialRules: Array.isArray(p?.specialRules) ? p.specialRules : [],
      generated: p?.generated ?? null,
      createdAt: p?.createdAt ?? new Date().toISOString(),
      updatedAt: p?.updatedAt ?? new Date().toISOString(),
    }));
  }

  out.ui = out.ui && typeof out.ui === "object" ? out.ui : base.ui;
  out.ui.activePlanId = out.ui.activePlanId ?? out.plans[0]?.id ?? null;

  // folders (v2) - Initial folders removed as requested
  out.folders = Array.isArray(out.folders) ? out.folders : [];
  // Cleanup old default folders if they exist
  out.folders = out.folders.filter(f => !["第一章", "第二章"].includes(f.name));

  // Ensure note.folderId exists
  out.notes = Array.isArray(out.notes) ? out.notes : [];
  out.notes = out.notes.map((n) => ({ ...n, folderId: n?.folderId ?? null, isTodayTarget: !!n?.isTodayTarget }));

  out.ui.activeFolderId = out.ui.activeFolderId ?? "all";
  out.ui.calendarYM = out.ui.calendarYM ?? todayISO().slice(0, 7);
  out.ui.expandedFolderIds = Array.isArray(out.ui.expandedFolderIds) ? out.ui.expandedFolderIds : [];

  out.version = 2;
  return out;
}

let state = loadState();

// Notes multi-select (UI-only, not persisted)
let notesSelectionMode = false;
let selectedNoteIds = new Set();
let openMovePanelNoteId = null;
let movePanelDraft = { targetType: "folder", folderId: null, newFolderName: "" };

// ---------------- Routing ----------------
const tabs = [...document.querySelectorAll(".tab")];
const views = [...document.querySelectorAll(".view")];

function setRoute(route) {
  for (const t of tabs) t.classList.toggle("is-active", t.dataset.route === route);
  for (const v of views) v.classList.toggle("is-active", v.dataset.view === route);
  state.ui.lastRoute = route;
  scheduleSave();
  renderAll();
}

tabs.forEach((t) =>
  t.addEventListener("click", () => {
    setRoute(t.dataset.route);
  }),
);

// ---------------- Export/Import ----------------
const btnExportEl = document.getElementById("btnExport");
const importJsonEl = document.getElementById("importJson");

if (btnExportEl) {
  btnExportEl.addEventListener("click", () => {
    const json = JSON.stringify(state, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cpa-data-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

if (importJsonEl) {
  importJsonEl.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      state = migrateState(parsed);
      scheduleSave();
      renderAll();
    } catch {
      alert("导入失败：不是有效的 JSON");
    } finally {
      e.target.value = "";
    }
  });
}

// ---------------- Notes ----------------
const notesListEl = document.getElementById("notesList");
const notesSearchEl = document.getElementById("notesSearch");
const notesFilterEl = document.getElementById("notesFilter");
const btnToggleSelectNotesEl = document.getElementById("btnToggleSelectNotes");
const notesBulkActionsEl = document.getElementById("notesBulkActions");
const notesSelectedCountEl = document.getElementById("notesSelectedCount");
const btnSelectAllNotesEl = document.getElementById("btnSelectAllNotes");
const btnClearSelectedNotesEl = document.getElementById("btnClearSelectedNotes");
const btnDeleteSelectedNotesEl = document.getElementById("btnDeleteSelectedNotes");
const notesBulkMoveSelectEl = document.getElementById("notesBulkMoveSelect");
const btnBulkMoveNotesEl = document.getElementById("btnBulkMoveNotes");
const foldersTreeEl = document.getElementById("foldersTree");
const btnAddFolderEl = document.getElementById("btnAddFolder");
const btnDeleteFolderEl = document.getElementById("btnDeleteFolder");
const activeFolderPillEl = document.getElementById("activeFolderPill");

const noteEditorEl = document.getElementById("noteEditor");
const noteReviewEl = document.getElementById("noteReview");

const noteTitleEl = document.getElementById("noteTitle");
const noteTagsEl = document.getElementById("noteTags");
const noteBodyEl = document.getElementById("noteBody");
const notePreviewEl = document.getElementById("notePreview");
const noteSavedHintEl = document.getElementById("noteSavedHint");
const noteMetaPillEl = document.getElementById("noteMetaPill");
const noteFolderSelectEl = document.getElementById("noteFolderSelect");
const btnEditorToggleTodayTargetEl = document.getElementById("btnEditorToggleTodayTarget");
const btnToggleClozeHighlightEl = document.getElementById("btnToggleClozeHighlight");
const tagsEditorEl = document.getElementById("tagsEditor");
const tagInputEl = document.getElementById("tagInput");
const btnAddTagEl = document.getElementById("btnAddTag");

// ---- Cloud / Auth state ----
let currentUser = null;
const cloudStatusEl = document.getElementById("cloudStatus");
const btnOpenAccountEl = document.getElementById("btnOpenAccount");
const accountPanelEl = document.getElementById("accountPanel");
const accountHintEl = document.getElementById("accountHint");
const btnCloseAccountEl = document.getElementById("btnCloseAccount");
const authEmailEl = document.getElementById("authEmail");
const authPasswordEl = document.getElementById("authPassword");
const authMsgEl = document.getElementById("authMsg");
const btnSignInEl = document.getElementById("btnSignIn");
const btnSignUpEl = document.getElementById("btnSignUp");
const btnSignOutEl = document.getElementById("btnSignOut");

function setCloudStatus(text, kind = "idle") {
  if (!cloudStatusEl) return;
  cloudStatusEl.textContent = text;
  cloudStatusEl.style.borderColor =
    kind === "ok"
      ? "rgba(51,214,166,.45)"
      : kind === "warn"
        ? "rgba(255,211,105,.55)"
        : kind === "bad"
          ? "rgba(255,77,109,.55)"
          : "var(--border)";
}

async function onAuthChanged(session) {
  currentUser = session?.user ?? null;
  if (currentUser?.id) {
    btnSignOutEl.classList.remove("hidden");
    accountHintEl.textContent = `已登录：${currentUser.email}（数据会自动云端同步）`;
    setCloudStatus("云端：同步中…", "warn");
    try {
      const localBefore = loadState();
      const remoteLoaded = await loadFromCloud(currentUser.id);

      const remoteIsNewer = isStateNewer(remoteLoaded, localBefore);
      if (remoteIsNewer) {
        state = remoteLoaded;
      } else {
        state = localBefore;
      }
      setCloudStatus("云端：已连接", "ok");
      startCloudSync(currentUser.id);
      if (!remoteIsNewer) scheduleSave();
    } catch (e) {
      console.error(e);
      setCloudStatus("云端：连接失败", "bad");
      // Fallback to local if cloud fails
      state = loadState();
    }
  } else {
    btnSignOutEl.classList.add("hidden");
    accountHintEl.textContent = "未登录：登录后数据会自动同步到云端，不同设备同账号数据一致。";
    setCloudStatus("云端：未登录", "warn");
    stopCloudSync();
    state = loadState();
  }
  state = migrateState(state);
  setRoute(state.ui.lastRoute ?? "today");
  renderAll();
}

if (supabaseClient) {
  supabaseClient.auth.onAuthStateChange((_event, session) => onAuthChanged(session));
  supabaseClient.auth.getSession().then(({ data }) => onAuthChanged(data.session));
  window.addEventListener("online", () => {
    if (currentUser?.id) flushCloudSave();
  });
}

if (btnOpenAccountEl) btnOpenAccountEl.addEventListener("click", () => accountPanelEl.classList.remove("hidden"));
if (btnCloseAccountEl) btnCloseAccountEl.addEventListener("click", () => accountPanelEl.classList.add("hidden"));

if (btnSignInEl) {
  btnSignInEl.addEventListener("click", async () => {
    authMsgEl.textContent = "";
    const email = authEmailEl.value.trim();
    const password = authPasswordEl.value.trim();
    if (!email || !password) return (authMsgEl.textContent = "请输入邮箱和密码");
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) authMsgEl.textContent = `登录失败：${error.message}`;
  });
}

if (btnSignUpEl) {
  btnSignUpEl.addEventListener("click", async () => {
    authMsgEl.textContent = "";
    const email = authEmailEl.value.trim();
    const password = authPasswordEl.value.trim();
    if (!email || !password) return (authMsgEl.textContent = "请输入邮箱和密码");
    const { error } = await supabaseClient.auth.signUp({ email, password });
    if (error) authMsgEl.textContent = `注册失败：${error.message}`;
    else authMsgEl.textContent = "注册成功，请去邮箱验证（如果开启了验证）或直接登录。";
  });
}

if (btnSignOutEl) btnSignOutEl.addEventListener("click", () => supabaseClient.auth.signOut());

let editorDirty = false;
let editorAutoSaveTimer = null;
let editorShowClozeHighlight = true;

function setEditorDirty(dirty) {
  editorDirty = dirty;
  if (noteSavedHintEl) {
    if (dirty) {
      noteSavedHintEl.textContent = "未保存（将自动保存）";
    } else {
      noteSavedHintEl.textContent = "";
    }
  }
}

function scheduleAutoSave() {
  if (editorAutoSaveTimer) clearTimeout(editorAutoSaveTimer);
  editorAutoSaveTimer = setTimeout(() => {
    if (!editorDirty) return;
    saveEditor(true);
  }, 800);
}

function renderNoteFolderSelect(note) {
  if (!noteFolderSelectEl) return;
  const options = (state.folders ?? [])
    .map((f) => ({ id: f.id, name: getFolderDisplayName(f.id) }))
    .filter((x) => x.name)
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));

  noteFolderSelectEl.innerHTML =
    `<option value="">未分类</option>` +
    options.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`).join("");
  noteFolderSelectEl.value = note.folderId ?? "";
}

function updateEditorTodayTargetButton(note) {
  if (!btnEditorToggleTodayTargetEl) return;
  btnEditorToggleTodayTargetEl.textContent = note.isTodayTarget ? "移出今日新学" : "加入今日新学";
}

function renderTagsEditor(note) {
  if (!tagsEditorEl) return;
  const tags = Array.isArray(note.tags) ? note.tags : [];
  if (tags.length === 0) {
    tagsEditorEl.innerHTML = `<div class="muted">暂无标签</div>`;
  } else {
    tagsEditorEl.innerHTML = tags
      .map(
        (t) => `
        <span class="tagChip">
          <span>${escapeHtml(t)}</span>
          <button class="tagChip__x" type="button" data-action="delTag" data-tag="${escapeHtml(t)}">×</button>
        </span>
      `,
      )
      .join("");
  }
  // keep hidden input in sync
  noteTagsEl.value = tags.join(", ");

  tagsEditorEl.querySelectorAll("[data-action='delTag']").forEach((b) => {
    b.addEventListener("click", () => {
      const note2 = getNoteById(state.ui.activeNoteId);
      if (!note2) return;
      const tag = b.dataset.tag;
      note2.tags = (note2.tags ?? []).filter((x) => x !== tag);
      setEditorDirty(true);
      scheduleAutoSave();
      renderTagsEditor(note2);
      renderNotePreview({ ...note2, title: noteTitleEl.value, tags: note2.tags, body: noteBodyEl.value });
    });
  });
}

function addTagsFromInput() {
  const note = getNoteById(state.ui.activeNoteId);
  if (!note) return;
  const raw = (tagInputEl?.value ?? "").trim();
  if (!raw) return;
  const incoming = raw.split(/[，,]/g).map((x) => x.trim()).filter(Boolean);
  note.tags = Array.isArray(note.tags) ? note.tags : [];
  for (const t of incoming) {
    if (!note.tags.includes(t)) note.tags.push(t);
  }
  tagInputEl.value = "";
  setEditorDirty(true);
  scheduleAutoSave();
  renderTagsEditor(note);
  renderNotePreview({ ...note, title: noteTitleEl.value, tags: note.tags, body: noteBodyEl.value });
}

function getNoteById(id) {
  return state.notes.find((n) => n.id === id) ?? null;
}

function upsertNote(note) {
  const idx = state.notes.findIndex((n) => n.id === note.id);
  if (idx >= 0) state.notes[idx] = note;
  else state.notes.unshift(note);
}

function createEmptyNote() {
  const now = new Date().toISOString();
  return {
    id: uid("note"),
    title: "未命名笔记",
    tags: [],
    body: "",
    createdAt: now,
    updatedAt: now,
    learnedAt: null,
    lastReviewedAt: null,
    folderId: null,
    isTodayTarget: false,
  };
}

function getFolderById(id) {
  return (state.folders ?? []).find((f) => f.id === id) ?? null;
}

function getActiveFolderId() {
  return state.ui.activeFolderId ?? "all";
}

function setActiveFolderId(id) {
  state.ui.activeFolderId = id ?? "all";
  scheduleSave();
  renderNotes();
}

function ensureFoldersArray() {
  state.folders = Array.isArray(state.folders) ? state.folders : [];
}

function buildFolderChildrenMap() {
  ensureFoldersArray();
  const childrenMap = new Map();
  for (const f of state.folders) {
    const pid = f.parentId ?? null;
    childrenMap.set(pid, childrenMap.get(pid) ?? []);
    childrenMap.get(pid).push(f);
  }
  for (const [, arr] of childrenMap) arr.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), "zh"));
  return childrenMap;
}

function getDescendantFolderIds(rootId) {
  // includes self
  const childrenMap = buildFolderChildrenMap();
  const out = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (!id || out.has(id)) continue;
    out.add(id);
    const kids = childrenMap.get(id) ?? [];
    for (const k of kids) stack.push(k.id);
  }
  return out;
}

function getExpandedFolderIds() {
  const arr = state.ui.expandedFolderIds;
  return Array.isArray(arr) ? arr : [];
}

function isFolderExpanded(id) {
  return getExpandedFolderIds().includes(id);
}

function setFolderExpanded(id, expanded) {
  const cur = new Set(getExpandedFolderIds());
  if (expanded) cur.add(id);
  else cur.delete(id);
  state.ui.expandedFolderIds = [...cur];
  scheduleSave();
}

function getFolderDisplayName(id) {
  const f = getFolderById(id);
  if (!f) return "";
  const parts = [];
  let cur = f;
  let guard = 0;
  while (cur && guard++ < 20) {
    parts.unshift(String(cur.name ?? "").trim() || "未命名");
    cur = cur.parentId ? getFolderById(cur.parentId) : null;
  }
  return parts.join(" / ");
}

function renderFoldersTree() {
  ensureFoldersArray();
  const activeId = getActiveFolderId();

  const allCount = state.notes.length;
  const uncategorizedCount = state.notes.filter((n) => !n.folderId).length;

  const childrenMap = buildFolderChildrenMap();

  const calcFolderCountDeep = (folderId) => {
    const ids = getDescendantFolderIds(folderId);
    return state.notes.filter((n) => ids.has(n.folderId)).length;
  };
  const hasChildren = (folderId) => (childrenMap.get(folderId) ?? []).length > 0;

  const renderNode = (node, depth) => {
    const count = calcFolderCountDeep(node.id);
    const expanded = isFolderExpanded(node.id);
    const kids = childrenMap.get(node.id) ?? [];
    const toggleDisabled = kids.length === 0;
    const pad = depth * 14;
    const cls = `tree__node ${node.id === activeId ? "is-active" : ""}`;
    const icon = toggleDisabled ? "·" : expanded ? "▾" : "▸";
    let html = `
      <div class="${cls}" style="padding-left:${pad}px" data-id="${node.id}">
        <div class="tree__left">
          <button class="tree__toggle" type="button" data-action="toggleFolder" data-id="${node.id}" ${toggleDisabled ? "disabled" : ""}>${icon}</button>
          <div class="tree__pick" data-action="pickFolder" data-id="${node.id}">
            <span class="folder-check ${node.id === activeId ? 'is-checked' : ''}">✓</span>
            <div class="tree__name">${escapeHtml(node.name ?? "未命名")}</div>
          </div>
        </div>
        <div class="tree__meta"><span class="chip">${count} 条</span></div>
      </div>
    `;
    if (kids.length > 0 && expanded) {
      html += kids.map((k) => renderNode(k, depth + 1)).join("");
    }
    return html;
  };

  const activeName =
    activeId === "all"
      ? "全部"
      : activeId === "uncategorized"
        ? "未归类"
        : getFolderDisplayName(activeId) || "未知文件夹";
  activeFolderPillEl.textContent = activeName;

  const roots = childrenMap.get(null) ?? [];
  foldersTreeEl.innerHTML =
    `
      <div class="tree__node ${"all" === activeId ? "is-active" : ""}" data-id="all">
        <div class="tree__left">
          <button class="tree__toggle" type="button" disabled>·</button>
          <div class="tree__pick" data-action="pickFolder" data-id="all">
            <span class="folder-check ${"all" === activeId ? 'is-checked' : ''}">✓</span>
            <div class="tree__name">全部</div>
          </div>
        </div>
        <div class="tree__meta"><span class="chip">${allCount} 条</span></div>
      </div>
      <div class="tree__node ${"uncategorized" === activeId ? "is-active" : ""}" data-id="uncategorized">
        <div class="tree__left">
          <button class="tree__toggle" type="button" disabled>·</button>
          <div class="tree__pick" data-action="pickFolder" data-id="uncategorized">
            <span class="folder-check ${"uncategorized" === activeId ? 'is-checked' : ''}">✓</span>
            <div class="tree__name">未归类</div>
          </div>
        </div>
        <div class="tree__meta"><span class="chip">${uncategorizedCount} 条</span></div>
      </div>
    ` + roots.map((r) => renderNode(r, 0)).join("");

  foldersTreeEl.querySelectorAll("[data-action='pickFolder']").forEach((el) => {
    el.addEventListener("click", () => {
      setActiveFolderId(el.dataset.id);
    });
  });
  foldersTreeEl.querySelectorAll("[data-action='toggleFolder']").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const id = btn.dataset.id;
      setFolderExpanded(id, !isFolderExpanded(id));
      renderFoldersTree();
    });
  });

  // Only allow delete when active is a real folder
  const canDelete = !!getFolderById(activeId);
  btnDeleteFolderEl.disabled = !canDelete;
}

function renderNotes() {
  renderFoldersTree();
  renderNotesList();
}

function openEditor(noteId) {
  state.ui.activeNoteId = noteId;
  const note = getNoteById(noteId);
  if (!note) return;
  noteEditorEl.classList.remove("hidden");
  noteReviewEl.classList.add("hidden");
  noteTitleEl.value = note.title ?? "";
  noteTagsEl.value = (note.tags ?? []).join(", ");
  noteBodyEl.value = note.body ?? "";
  setEditorDirty(false);

  renderNoteFolderSelect(note);
  updateEditorTodayTargetButton(note);
  editorShowClozeHighlight = state.ui.editorShowClozeHighlight ?? true;
  btnToggleClozeHighlightEl && (btnToggleClozeHighlightEl.textContent = `挖空高亮：${editorShowClozeHighlight ? "开" : "关"}`);
  renderTagsEditor(note);
  renderNotePreview(note);
  scheduleSave();
}

function closeEditor() {
  state.ui.activeNoteId = null;
  noteEditorEl.classList.add("hidden");
  setEditorDirty(false);
  scheduleSave();
  renderNotesList();
}

function saveEditor(fromAutoSave = false) {
  const id = state.ui.activeNoteId;
  const note = getNoteById(id);
  if (!note) return;
  note.title = (noteTitleEl.value || "未命名笔记").trim();
  note.tags = parseTags(noteTagsEl.value);
  note.body = noteBodyEl.value ?? "";
  note.updatedAt = new Date().toISOString();
  upsertNote(note);
  scheduleSave();
  setEditorDirty(false);
  noteSavedHintEl.textContent = fromAutoSave ? "已自动保存" : "已保存";
  setTimeout(() => { if (noteSavedHintEl.textContent === "已保存" || noteSavedHintEl.textContent === "已自动保存") noteSavedHintEl.textContent = ""; }, 2000);
  renderNotePreview(note);
  renderNotesList();
  renderToday();
  renderStats();
}

function renderMarkdownLite(text) {
  // Minimal markdown: headings (#, ##, ###), bullet lists, paragraphs, inline code, links.
  const lines = (text ?? "").split(/\r?\n/);
  const out = [];
  let inList = false;

  const pushParagraph = (s) => {
    if (!s.trim()) return;
    const html = escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    out.push(`<p>${html}</p>`);
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      continue;
    }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      const level = h[1].length;
      const content = escapeHtml(h[2]).replace(/`([^`]+)`/g, "<code>$1</code>");
      out.push(`<h${level}>${content}</h${level}>`);
      continue;
    }

    const li = line.match(/^[-*]\s+(.*)$/);
    if (li) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      const content = escapeHtml(li[1]).replace(/`([^`]+)`/g, "<code>$1</code>");
      out.push(`<li>${content}</li>`);
      continue;
    }

    if (inList) {
      out.push("</ul>");
      inList = false;
    }

    pushParagraph(line);
  }
  if (inList) out.push("</ul>");

  return out.join("\n");
}

function renderNotePreview(note) {
  const clozedHtml = editorShowClozeHighlight
    ? renderMarkdownLite(note.body).replace(/\{\{([\s\S]*?)\}\}/g, (_, ans) => {
        return `<span class="cloze">${escapeHtml(ans.trim())}</span>`;
      })
    : renderMarkdownLite(note.body).replace(/\{\{([\s\S]*?)\}\}/g, (_, ans) => escapeHtml(ans.trim()));
  notePreviewEl.innerHTML = clozedHtml || `<div class="muted">在左侧输入正文，这里会实时预览（含挖空高亮）。</div>`;

  const learned = note.learnedAt ? "已学" : "未学";
  const due = isNoteDueToday(note.id) ? "今日需复习" : "—";
  noteMetaPillEl.textContent = `${learned} · ${due}`;
}

const btnNewNoteEl = document.getElementById("btnNewNote");
if (btnNewNoteEl) {
  btnNewNoteEl.addEventListener("click", () => {
    const note = createEmptyNote();
    upsertNote(note);
    scheduleSave();
    openEditor(note.id);
    renderNotesList();
  });
}

const btnCloseEditorEl = document.getElementById("btnCloseEditor");
if (btnCloseEditorEl) btnCloseEditorEl.addEventListener("click", closeEditor);

const btnSaveNoteEl = document.getElementById("btnSaveNote");
if (btnSaveNoteEl) btnSaveNoteEl.addEventListener("click", () => saveEditor());

noteTitleEl.addEventListener("input", () => {
  const note = getNoteById(state.ui.activeNoteId);
  if (!note) return;
  setEditorDirty(true);
  scheduleAutoSave();
  renderNotePreview({ ...note, title: noteTitleEl.value, tags: parseTags(noteTagsEl.value), body: noteBodyEl.value });
});
noteTagsEl.addEventListener("input", () => {
  const note = getNoteById(state.ui.activeNoteId);
  if (!note) return;
  setEditorDirty(true);
  scheduleAutoSave();
  renderNotePreview({ ...note, title: noteTitleEl.value, tags: parseTags(noteTagsEl.value), body: noteBodyEl.value });
});
noteBodyEl.addEventListener("input", () => {
  const note = getNoteById(state.ui.activeNoteId);
  if (!note) return;
  setEditorDirty(true);
  scheduleAutoSave();
  renderNotePreview({ ...note, title: noteTitleEl.value, tags: parseTags(noteTagsEl.value), body: noteBodyEl.value });
});

noteFolderSelectEl?.addEventListener("change", () => {
  const note = getNoteById(state.ui.activeNoteId);
  if (!note) return;
  note.folderId = noteFolderSelectEl.value || null;
  note.updatedAt = new Date().toISOString();
  upsertNote(note);
  scheduleSave();
  renderNotes();
  renderNoteFolderSelect(note);
});

btnEditorToggleTodayTargetEl?.addEventListener("click", () => {
  const note = getNoteById(state.ui.activeNoteId);
  if (!note) return;
  note.isTodayTarget = !note.isTodayTarget;
  note.updatedAt = new Date().toISOString();
  upsertNote(note);
  scheduleSave();
  updateEditorTodayTargetButton(note);
  renderToday();
  renderNotesList();
});

btnToggleClozeHighlightEl?.addEventListener("click", () => {
  editorShowClozeHighlight = !editorShowClozeHighlight;
  state.ui.editorShowClozeHighlight = editorShowClozeHighlight;
  scheduleSave();
  btnToggleClozeHighlightEl.textContent = `挖空高亮：${editorShowClozeHighlight ? "开" : "关"}`;
  const note = getNoteById(state.ui.activeNoteId);
  if (!note) return;
  renderNotePreview({ ...note, title: noteTitleEl.value, tags: parseTags(noteTagsEl.value), body: noteBodyEl.value });
});

btnAddTagEl?.addEventListener("click", addTagsFromInput);
tagInputEl?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addTagsFromInput();
  }
});

// Ctrl/Cmd + S to save
document.addEventListener("keydown", (e) => {
  const isSave = (e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S");
  if (!isSave) return;
  if (!state.ui.activeNoteId) return;
  e.preventDefault();
  saveEditor(false);
});

document.getElementById("btnClozeSelection")?.addEventListener("click", (e) => {
  e.preventDefault();
  const ta = noteBodyEl;
  const start = ta.selectionStart ?? 0;
  const end = ta.selectionEnd ?? 0;
  if (start === end) {
    alert("请先选中要挖空的文字");
    return;
  }

  // 记录当前滚动位置
  const scrollTop = ta.scrollTop;

  const before = ta.value.slice(0, start);
  const selected = ta.value.slice(start, end);
  const after = ta.value.slice(end);
  ta.value = `${before}{{${selected}}}${after}`;
  
  // Set dirty and schedule auto save
  setEditorDirty(true);
  scheduleAutoSave();

  // Keep focus and restore selection for better UX
  ta.focus();
  ta.selectionStart = start;
  ta.selectionEnd = start + selected.length + 4;

  // 恢复滚动位置，防止跳到最后
  ta.scrollTop = scrollTop;

  const note = getNoteById(state.ui.activeNoteId);
  if (!note) return;
  renderNotePreview({ ...note, title: noteTitleEl.value, tags: parseTags(noteTagsEl.value), body: ta.value });
});

let lastSmartClozeBackup = null;
const btnUndoSmartClozeEl = document.getElementById("btnUndoSmartCloze");

document.getElementById("btnSmartCloze")?.addEventListener("click", () => {
  const note = getNoteById(state.ui.activeNoteId);
  if (!note) return;
  const body = noteBodyEl.value ?? "";
  
  // Backup before smart cloze for undo
  lastSmartClozeBackup = body;
  btnUndoSmartClozeEl?.classList.remove("hidden");

  const updated = smartCloze(body);
  noteBodyEl.value = updated;
  
  setEditorDirty(true);
  scheduleAutoSave();
  renderNotePreview({ ...note, title: noteTitleEl.value, tags: parseTags(noteTagsEl.value), body: updated });
  noteSavedHintEl.textContent = "已生成挖空建议（可撤销或继续手动调整）";
});

btnUndoSmartClozeEl?.addEventListener("click", () => {
  if (lastSmartClozeBackup === null) return;
  const note = getNoteById(state.ui.activeNoteId);
  if (!note) return;
  
  noteBodyEl.value = lastSmartClozeBackup;
  lastSmartClozeBackup = null;
  btnUndoSmartClozeEl.classList.add("hidden");
  
  setEditorDirty(true);
  scheduleAutoSave();
  renderNotePreview({ ...note, title: noteTitleEl.value, tags: parseTags(noteTagsEl.value), body: noteBodyEl.value });
  noteSavedHintEl.textContent = "已撤销智能挖空";
});

function smartCloze(text) {
  let out = String(text ?? "");
  out = out
    // 连续下划线包裹内容：______答案______
    .replace(/[_＿]{2,}([^_＿\n]*?)[_＿]{2,}/g, (_, inner) => {
      const v = String(inner ?? "").trim();
      return `{{${v || " "}}}`;
    })
    // 下划线之间有空格的情况：_ _ _  或  ＿ ＿ ＿
    .replace(/(?:[_＿]\s*){3,}/g, "{{ }}")
    // 单个下划线左右包裹内容且带空格：_ 答案 _
    .replace(/[_＿]\s*([^\n]{1,50}?)\s*[_＿]/g, (_, inner) => `{{${String(inner ?? "").trim()}}}`)
    // 多组下划线由标点分隔：_____、______、_____，______
    .replace(/([_＿]{3,})(?=\s*[、，,；;。．.])/g, "{{ }}");

  const protectedRanges = [];
  const markProtected = (match) => protectedRanges.push([match.index, match.index + match[0].length]);
  [...out.matchAll(/\{\{[\s\S]*?\}\}/g)].forEach(markProtected);

  const isProtected = (idx) => protectedRanges.some(([a, b]) => idx >= a && idx < b);

  const candidates = [];
  const pushCandidate = (m, groupIndex = 0) => {
    if (!m || m.index == null) return;
    const val = groupIndex ? m[groupIndex] : m[0];
    if (!val || val.length < 1) return;
    const start = groupIndex ? m.index + m[0].indexOf(val) : m.index;
    const end = start + val.length;
    if (isProtected(start) || isProtected(end - 1)) return;
    candidates.push([start, end]);
  };

  for (const m of out.matchAll(/\b\d{2,4}\b/g)) pushCandidate(m);
  for (const m of out.matchAll(/\b\d+(\.\d+)?%/g)) pushCandidate(m);
  for (const m of out.matchAll(/\b\d+(\.\d+)?\s*(年|月|日|小时|h|H)\b/g)) pushCandidate(m);
  for (const m of out.matchAll(/(包括|称为|是|为|指|分为)\s*([一-龥]{2,8})/g)) pushCandidate(m, 2);

  candidates.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const c of candidates) {
    const last = merged[merged.length - 1];
    if (!last || c[0] > last[1]) merged.push(c);
    else last[1] = Math.max(last[1], c[1]);
  }

  for (let i = merged.length - 1; i >= 0; i--) {
    const [a, b] = merged[i];
    const seg = out.slice(a, b);
    if (!seg.trim()) continue;
    out = `${out.slice(0, a)}{{${seg}}}${out.slice(b)}`;
  }
  return out;
}

document.getElementById("btnMarkLearned")?.addEventListener("click", () => {
  const note = getNoteById(state.ui.activeNoteId);
  if (!note) return;
  const iso = todayISO();
  note.learnedAt = note.learnedAt ?? `${iso}T00:00:00.000Z`;
note.updatedAt = new Date().toISOString();
upsertNote(note);
scheduleEbbinghausForNote(note.id, iso);
scheduleSave();
renderNotePreview(note);
  renderToday();
  renderNotesList();
  noteSavedHintEl.textContent = "已标记已学，并生成复习任务（1/2/4/7/15/30天后）";
});

function scheduleEbbinghausForNote(noteId, baseISO) {
  // Ensure tasks exist (idempotent)
  for (const d of EBBINGHAUS_DAYS) {
    const dueDate = addDaysISO(baseISO, d);
    const exists = state.reviewTasks.some((t) => t.noteId === noteId && t.dueDate === dueDate);
    if (!exists) {
      state.reviewTasks.push({
        id: uid("rv"),
        noteId,
        dueDate,
        completedAt: null,
      });
    }
  }
}

function isNoteDueToday(noteId) {
  const iso = todayISO();
  return state.reviewTasks.some((t) => t.noteId === noteId && t.dueDate === iso && !t.completedAt);
}

function openReview(noteId) {
  alert(`Reviewing note: ${noteId}`);
}

function bulkMoveNotes() {
  const ids = [...selectedNoteIds];
  if (ids.length === 0) return alert("请先选择要移动的笔记");
  const targetFolderId = notesBulkMoveSelectEl.value;
  if (!targetFolderId) return alert("请选择目标文件夹");

  for (const id of ids) {
    const note = getNoteById(id);
    if (note) note.folderId = targetFolderId === "uncategorized" ? null : targetFolderId;
  }
  scheduleSave();
  notesSelectionMode = false;
  selectedNoteIds = new Set();
  renderAll();
  alert(`成功移动 ${ids.length} 条笔记`);
}

btnBulkMoveNotesEl?.addEventListener("click", bulkMoveNotes);

function renderNotesList() {
  const q = (notesSearchEl.value ?? "").trim().toLowerCase();
  const filter = notesFilterEl.value;
  const iso = todayISO();
  const folder = getActiveFolderId();

  const list = state.notes
    .filter((n) => {
      if (folder === "all") return true;
      if (folder === "uncategorized") return !n.folderId;
      const descIds = getDescendantFolderIds(folder);
      return descIds.has(n.folderId);
    })
    .filter((n) => {
      if (!q) return true;
      const title = (n.title ?? "").toLowerCase();
      const body = (n.body ?? "").toLowerCase();
      const tags = (n.tags ?? []).join(" ").toLowerCase();
      return title.includes(q) || body.includes(q) || tags.includes(q);
    })
    .filter((n) => {
      if (filter === "all") return true;
      if (filter === "due") return isNoteDueToday(n.id);
      if (filter === "learned") return !!n.learnedAt;
      if (filter === "unlearned") return !n.learnedAt;
      if (filter === "todayTarget") return !!n.isTodayTarget;
      return true;
    })
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));

  if (list.length === 0) {
    notesListEl.innerHTML = `<div class="muted centered-text" style="padding: 40px 20px;">无笔记</div>`;
    return;
  }

  notesListEl.innerHTML = list
    .map((n) => {
      const isDue = isNoteDueToday(n.id);
      const learned = !!n.learnedAt;
      const selected = selectedNoteIds.has(n.id);
      const cls = `list__item ${selected ? "is-selected" : ""}`;

      const checkboxHtml = notesSelectionMode
        ? `
        <label class="check">
          <input type="checkbox" data-action="selectNote" data-id="${n.id}" ${selected ? "checked" : ""}>
          <span class="checkmark"></span>
        </label>`
        : "";

      return `
      <div class="${cls}" data-id="${n.id}">
        <div class="list__item-main">
          ${checkboxHtml}
          <div class="list__item-content" data-action="openNote" data-id="${n.id}">
            <div class="list__item-title">${escapeHtml(n.title)}</div>
            <div class="list__item-meta">
              ${isDue ? `<span class="chip chip--due">需复习</span>` : ""}
              ${learned ? `<span class="chip chip--learned">已学</span>` : ""}
            </div>
          </div>
        </div>
        <div class="list__item-actions">
          <button class="btn--secondary btn--small" data-action="reviewNote" data-id="${n.id}">复习</button>
          <button class="btn btn--small" data-action="openNote" data-id="${n.id}">编辑</button>
        </div>
      </div>
    `;
    })
    .join("");

  notesListEl.querySelectorAll("[data-action='openNote']").forEach((el) => {
    el.addEventListener("click", () => openEditor(el.dataset.id));
  });
  notesListEl.querySelectorAll("[data-action='reviewNote']").forEach((el) => {
    el.addEventListener("click", () => openReview(el.dataset.id));
  });
  notesListEl.querySelectorAll("[data-action='selectNote']").forEach((el) => {
    el.addEventListener("change", (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) selectedNoteIds.add(id);
      else selectedNoteIds.delete(id);
      renderNotesList(); // Re-render to update the .is-selected class
      updateBulkActionUI();
    });
  });
}

function renderAll() {
  renderToday();
  renderNotes();
  renderPlan();
  renderStats();
  updateBulkActionUI();
}

function updateBulkActionUI() {
  if (notesSelectionMode) {
    btnToggleSelectNotesEl.textContent = "取消选择";
    notesBulkActionsEl.classList.remove("hidden");
    notesSelectedCountEl.textContent = `已选 ${selectedNoteIds.size}`;

    const folderOptions = (state.folders ?? [])
      .map((f) => ({ id: f.id, name: getFolderDisplayName(f.id) }))
      .filter((x) => x.name)
      .sort((a, b) => a.name.localeCompare(b.name, "zh"));
    notesBulkMoveSelectEl.innerHTML =
      `<option value="">移动到文件夹…</option><option value="uncategorized">未分类</option>` +
      folderOptions.map((f) => `<option value="${escapeHtml(f.id)}">${escapeHtml(f.name)}</option>`).join("");
  } else {
    btnToggleSelectNotesEl.textContent = "选择";
    notesBulkActionsEl.classList.add("hidden");
  }
}

function deleteSelectedNotes() {
  const ids = [...selectedNoteIds];
  if (ids.length === 0) {
    alert("还没有选择任何笔记");
    return;
  }
  if (!confirm(`确认删除选中的 ${ids.length} 条笔记？此操作不可撤销。`)) return;

  const idSet = new Set(ids);
  state.notes = state.notes.filter((n) => !idSet.has(n.id));
  state.reviewTasks = state.reviewTasks.filter((t) => !idSet.has(t.noteId));
  if (state.ui.activeNoteId && idSet.has(state.ui.activeNoteId)) closeEditor();

  notesSelectionMode = false;
  selectedNoteIds = new Set();
  scheduleSave();
  renderAll();
}

notesSearchEl.addEventListener("input", renderNotesList);
notesFilterEl.addEventListener("change", renderNotesList);

btnToggleSelectNotesEl.addEventListener("click", () => {
  notesSelectionMode = !notesSelectionMode;
  if (!notesSelectionMode) {
    selectedNoteIds = new Set();
  }
  renderNotesList();
  updateBulkActionUI();
});

btnSelectAllNotesEl.addEventListener("click", () => {
  if (!notesSelectionMode) return;
  const visibleNoteElements = [...notesListEl.querySelectorAll(".list__item")];
  const visibleNoteIds = visibleNoteElements.map(el => el.dataset.id);
  
  for (const id of visibleNoteIds) {
    if(id) selectedNoteIds.add(id);
  }
  renderNotesList();
  updateBulkActionUI();
});

btnClearSelectedNotesEl.addEventListener("click", () => {
  if (!notesSelectionMode) return;
  selectedNoteIds = new Set();
  renderNotesList();
  updateBulkActionUI();
});

btnDeleteSelectedNotesEl.addEventListener("click", () => {
  if (!notesSelectionMode) return;
  deleteSelectedNotes();
});




btnAddFolderEl.addEventListener("click", () => {
  const activeId = getActiveFolderId();
  const parentId = getFolderById(activeId) ? activeId : null;
  const hint = parentId ? `（将在「${getFolderDisplayName(parentId)}」下创建子文件夹）` : "（创建顶层文件夹）";
  const name = (prompt(`文件夹名称${hint}`, "") ?? "").trim();
  if (!name) return;
  ensureFoldersArray();
  const exists = state.folders.some((f) => (f.parentId ?? null) === parentId && (f.name ?? "").trim() === name);
  if (exists) {
    alert("已存在同名文件夹");
    return;
  }
  const id = uid("fld");
  state.folders.push({ id, name, parentId, createdAt: new Date().toISOString() });
  // auto-expand parent so new child is visible
  if (parentId) setFolderExpanded(parentId, true);
  scheduleSave();
  renderNotes();
});

btnDeleteFolderEl.addEventListener("click", () => {
  const activeId = getActiveFolderId();
  const folder = getFolderById(activeId);
  if (!folder) return;
  // Delete folder and all descendants; move notes to uncategorized
  const toDelete = new Set();
  const stack = [activeId];
  while (stack.length) {
    const id = stack.pop();
    if (toDelete.has(id)) continue;
    toDelete.add(id);
    for (const f of state.folders ?? []) {
      if (f.parentId === id) stack.push(f.id);
    }
  }
  const count = state.notes.filter((n) => toDelete.has(n.folderId)).length;
  const childCount = Math.max(0, toDelete.size - 1);
  if (!confirm(`确认删除文件夹「${folder.name}」？将同时删除其 ${childCount} 个子文件夹；其中的 ${count} 条笔记会移动到「未归类」。`)) return;

  for (const n of state.notes) {
    if (toDelete.has(n.folderId)) n.folderId = null;
  }
  state.folders = (state.folders ?? []).filter((f) => !toDelete.has(f.id));
  // cleanup expanded state
  state.ui.expandedFolderIds = (state.ui.expandedFolderIds ?? []).filter((id) => !toDelete.has(id));
  setActiveFolderId("all");
  scheduleSave();
  renderAll();
});

// ---------------- Review Mode ----------------
const reviewTitleEl = document.getElementById("reviewTitle");
const reviewBodyEl = document.getElementById("reviewBody");
const reviewResultHintEl = document.getElementById("reviewResultHint");

let currentReview = null; // { noteId, blanks: [{answer, inputEl, wrapperEl}] }

document.getElementById("btnOpenReview")?.addEventListener("click", () => {
  const noteId = state.ui.activeNoteId;
  if (!noteId) return;
  openReview(noteId);
});

document.getElementById("btnCloseReview")?.addEventListener("click", () => {
  noteReviewEl.classList.add("hidden");
  reviewResultHintEl.textContent = "";
});

document.getElementById("btnCheckAnswers")?.addEventListener("click", () => {
  if (!currentReview) return;
  let correct = 0;
  for (const b of currentReview.blanks) {
    const user = (b.inputEl.value ?? "").trim();
    const ans = (b.answer ?? "").trim();
    const ok = user === ans;
    b.wrapperEl.classList.toggle("is-correct", ok);
    b.wrapperEl.classList.toggle("is-wrong", !ok);
    if (ok) correct += 1;
  }
  reviewResultHintEl.textContent = `本次正确 ${correct}/${currentReview.blanks.length}（错误会显示正确答案）`;
});

document.getElementById("btnResetAnswers")?.addEventListener("click", () => {
  if (!currentReview) return;
  for (const b of currentReview.blanks) {
    b.inputEl.value = "";
    b.wrapperEl.classList.remove("is-correct", "is-wrong");
  }
  reviewResultHintEl.textContent = "已重置，可重新填写";
});

document.getElementById("btnFinishReview")?.addEventListener("click", () => {
  if (!currentReview) return;
  const note = getNoteById(currentReview.noteId);
  if (note) {
    note.lastReviewedAt = new Date().toISOString();
    upsertNote(note);
  }
  const iso = todayISO();
  for (const t of state.reviewTasks) {
    if (t.noteId === currentReview.noteId && t.dueDate === iso && !t.completedAt) {
      t.completedAt = new Date().toISOString();
    }
  }
  scheduleSave();
  renderToday();
  renderStats();
  renderNotesList();
  reviewResultHintEl.textContent = "已完成复习（如有今日到期任务已标记完成）";
});

function openReview(noteId) {
  const note = getNoteById(noteId);
  if (!note) return;
  noteReviewEl.classList.remove("hidden");
  noteEditorEl.classList.add("hidden");

  reviewTitleEl.textContent = note.title ?? "未命名笔记";
  const { html, blanks } = renderReviewHtml(note.body ?? "");
  reviewBodyEl.innerHTML = html;

  currentReview = { noteId, blanks: [] };
  for (const b of blanks) {
    const wrapperEl = reviewBodyEl.querySelector(`[data-blank-id="${b.id}"]`);
    const inputEl = wrapperEl?.querySelector("input");
    if (!wrapperEl || !inputEl) continue;
    currentReview.blanks.push({ answer: b.answer, wrapperEl, inputEl });
  }
  reviewResultHintEl.textContent = "";
}

function renderReviewHtml(text) {
  const parts = [];
  const blanks = [];
  let last = 0;
  const re = /\{\{([\s\S]*?)\}\}/g;
  let m;
  while ((m = re.exec(text)) != null) {
    const start = m.index;
    const end = start + m[0].length;
    parts.push(escapeHtml(text.slice(last, start)));
    const answer = (m[1] ?? "").trim();
    const id = uid("blank");
    blanks.push({ id, answer });
    parts.push(
      `<span class="blank" data-blank-id="${id}">
        <input type="text" placeholder="_____" />
        <span class="blank__tick">✓</span>
        <span class="blank__answer">正确：${escapeHtml(answer)}</span>
      </span>`,
    );
    last = end;
  }
  parts.push(escapeHtml(text.slice(last)));

  // Keep newlines readable
  const html = parts.join("").replaceAll("\n", "<br/>");
  return { html, blanks };
}

// ---------------- PDF Import (prototype) ----------------
const pdfInputEl = document.getElementById("pdfInput");
const pdfImportStatusEl = document.getElementById("pdfImportStatus");
const pdfSplitPanelEl = document.getElementById("pdfSplitPanel");
const pdfCanvasEl = document.getElementById("pdfCanvas");
const pdfExtractedTextEl = document.getElementById("pdfExtractedText");
const pdfRulesFormEl = document.getElementById("pdfRulesForm");
const btnAddPdfRuleEl = document.getElementById("btnAddPdfRule");

let pdfRulesDraft = []; // [{id, from, to, targetType: 'folder'|'uncategorized'|'new', folderId, newFolderName}]

function renderPdfRulesForm() {
  if (!pdfRulesFormEl) return;
  if (!Array.isArray(pdfRulesDraft) || pdfRulesDraft.length === 0) {
    pdfRulesFormEl.innerHTML = `<div class="muted">暂无规则。你可以点击「新增规则」。</div>`;
    return;
  }

  const folders = (state.folders ?? []).map((f) => ({ id: f.id, name: getFolderDisplayName(f.id) })).filter((x) => x.name);

  pdfRulesFormEl.innerHTML = pdfRulesDraft
    .map((r) => {
      const folderOptionsHtml = folders
        .map((f) => `<option value="${escapeHtml(f.id)}" ${f.id === r.folderId ? "selected" : ""}>${escapeHtml(f.name)}</option>`)
        .join("");
      const type = r.targetType ?? "folder";
      return `
        <div class="pdfRule" data-rule-id="${r.id}">
          <div class="pdfRule__label">页码</div>
          <div class="pdfRule__range">
            <input class="input" type="number" min="1" step="1" placeholder="始" data-field="from" value="${Number.isFinite(r.from) ? String(r.from) : ""}" />
            <span>-</span>
            <input class="input" type="number" min="1" step="1" placeholder="终" data-field="to" value="${Number.isFinite(r.to) ? String(r.to) : ""}" />
          </div>
          <div class="pdfRule__target">
            <select class="select" data-field="targetType" aria-label="归类目标">
              <option value="folder" ${type === "folder" ? "selected" : ""}>已有文件夹</option>
              <option value="new" ${type === "new" ? "selected" : ""}>新文件夹</option>
              <option value="uncategorized" ${type === "uncategorized" ? "selected" : ""}>未分类</option>
            </select>
            <div class="mt4 ${type === "folder" ? "" : "hidden"}" data-block="pickFolder">
              <select class="select" data-field="folderId" aria-label="选择文件夹">
                <option value="">选择…</option>
                ${folderOptionsHtml}
              </select>
            </div>
            <div class="mt4 ${type === "new" ? "" : "hidden"}" data-block="newFolder">
              <input class="input" placeholder="新名称" data-field="newFolderName" value="${escapeHtml(r.newFolderName ?? "")}" />
            </div>
          </div>
          <button class="btn btn--danger btn--small" type="button" data-action="delPdfRule">删除</button>
        </div>
      `;
    })
    .join("");

  pdfRulesFormEl.querySelectorAll(".pdfRule").forEach((row) => {
    const ruleId = row.dataset.ruleId;
    row.querySelectorAll("input, select").forEach((inp) => {
      const field = inp.dataset.field;
      if (!field) return;
      
      const updateRule = () => {
        const r = pdfRulesDraft.find((x) => x.id === ruleId);
        if (!r) return;
        if (field === "from" || field === "to") {
          r[field] = parseInt(inp.value, 10);
        } else if (field === "targetType") {
          r.targetType = inp.value;
          renderPdfRulesForm();
        } else if (field === "folderId") {
          r.folderId = inp.value || null;
        } else if (field === "newFolderName") {
          r.newFolderName = inp.value.trim();
        }
      };

      inp.addEventListener("input", updateRule);
      inp.addEventListener("change", updateRule);
    });
    
    row.querySelector("[data-action='delPdfRule']").addEventListener("click", () => {
      pdfRulesDraft = pdfRulesDraft.filter((x) => x.id !== ruleId);
      renderPdfRulesForm();
    });
  });
}

pdfInputEl.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!pdfjsLib?.getDocument) {
    pdfImportStatusEl.textContent =
      "解析失败：PDF 解析组件未加载。请确认同目录下存在 pdf.min.js 与 pdf.worker.min.js，然后刷新页面重试。";
    e.target.value = "";
    return;
  }
  pdfImportStatusEl.textContent = `正在解析：${file.name}`;
  pdfSplitPanelEl.classList.add("hidden");

  try {
    const arr = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjsLib.getDocument({ data: arr }).promise;

    // Render first page
    const page1 = await doc.getPage(1);
    const viewport = page1.getViewport({ scale: 1.2 });
    const ctx = pdfCanvasEl.getContext("2d");
    pdfCanvasEl.width = Math.floor(viewport.width);
    pdfCanvasEl.height = Math.floor(viewport.height);
    await page1.render({ canvasContext: ctx, viewport }).promise;

    // Extract text and identify colored items
    const texts = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false,
      });
      
      // Attempt to find items with colors (non-black)
      const pageText = content.items.map(item => {
        let str = item.str;
        // In pdf.js textContent, color information isn't always direct. 
        // We look for color in styles if available, or assume all items are candidates.
        // For actual color detection, we'd need page.getOperatorList() which is very slow.
        // Here we enhance underline detection which is common in "pre-clozed" PDFs.
        return str;
      }).join(" ");
      
      texts.push(extractTextPreserveLayout(content).trimEnd());
    }

    const combined = texts
      .map((t, idx) => `# 第${idx + 1}页\n${t}`)
      .join("\n\n---\n\n");

    pdfExtractedTextEl.value = combined;
    pdfSplitPanelEl.classList.remove("hidden");
    pdfImportStatusEl.textContent = `解析完成：共 ${doc.numPages} 页（已自动识别下划线并保留层级）`;

    // Initialize with a default rule for the entire range
    pdfRulesDraft = [{ id: uid("pRule"), from: 1, to: doc.numPages, targetType: "folder", folderId: null, newFolderName: "" }];
    renderPdfRulesForm();
  } catch (err) {
    pdfImportStatusEl.textContent = `解析失败：${String(err?.message ?? err)}`;
  } finally {
    e.target.value = "";
  }
});

function extractTextPreserveLayout(textContent) {
  // Strategy:
  // - group by y (line), sort by x
  // - insert spaces based on x gaps
  // - insert blank lines for large y gaps (paragraph-ish)
  const items = (textContent?.items ?? [])
    .filter((it) => (it?.str ?? "").trim().length > 0 && Array.isArray(it.transform))
    .map((it) => {
      const [a, b, c, d, e, f] = it.transform; // e=x, f=y in page space
      const fontSize = Math.hypot(a, b); // approximate
      return {
        str: it.str,
        x: e,
        y: f,
        w: it.width ?? 0,
        fontSize: Number.isFinite(fontSize) ? fontSize : 10,
      };
    });

  if (items.length === 0) return "";

  // Normalize y into buckets (tolerance based on median font size)
  const fontSizes = items.map((i) => i.fontSize).sort((x, y) => x - y);
  const medianFont = fontSizes[Math.floor(fontSizes.length / 2)] || 10;
  const yTol = Math.max(1.5, medianFont * 0.35);

  items.sort((i1, i2) => i2.y - i1.y || i1.x - i2.x); // top-to-bottom, left-to-right

  /** @type {{y:number, items: any[]}[]} */
  const lines = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    if (!last || Math.abs(last.y - it.y) > yTol) {
      lines.push({ y: it.y, items: [it] });
    } else {
      last.items.push(it);
    }
  }

  // For each line: sort by x and reconstruct with spacing
  const rendered = [];
  let prevY = null;
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);

    // Paragraph gap: if vertical jump is large, insert blank line
    if (prevY != null) {
      const dy = Math.abs(prevY - line.y);
      if (dy > medianFont * 1.35) rendered.push("");
    }

    let out = "";
    let prev = null;
    for (const it of line.items) {
      if (!prev) {
        out += it.str;
        prev = it;
        continue;
      }
      const gap = it.x - (prev.x + (prev.w || 0));
      // Use gap heuristics to decide spaces
      if (gap > medianFont * 0.35) out += " ";
      if (gap > medianFont * 1.2) out += " ";
      out += it.str;
      prev = it;
    }

    rendered.push(out.replace(/\s+/g, (m) => (m.length >= 2 ? "  " : " ")).trimEnd());
    prevY = line.y;
  }

  // Try to keep list-like indentation: if many lines start with "1." / "（1）" etc, keep as-is.
  return rendered.join("\n");
}

document.getElementById("btnCreateNotesFromPdf")?.addEventListener("click", () => {
  const raw = pdfExtractedTextEl.value ?? "";
  const chunks = raw
    .split(/\n\s*---\s*\n/g)
    .map((s) => s.trim())
    .filter(Boolean);
  if (chunks.length === 0) {
    alert("没有可创建的内容。你可以先粘贴/编辑提取文本。");
    return;
  }

  const rules = getPdfFolderRulesFromForm();
  const now = new Date().toISOString();
  let createdCount = 0;

  for (const c of chunks) {
    const pageNo = inferPdfPageNo(c);
    const folderId = pickFolderIdForPageNo(pageNo, rules);
    
    if (folderId === undefined) continue; // Skip if no rule matches

    const firstLine = c.split(/\r?\n/).find((l) => l.trim()) ?? "从PDF导入";
    const title = firstLine.replace(/^#+\s*/, "").slice(0, 40) || "从PDF导入";

    upsertNote({
      id: uid("note"),
      title,
      tags: [],
      body: c, // Import raw text, do not convert underlines here
      createdAt: now,
      updatedAt: now,
      learnedAt: null,
      lastReviewedAt: null,
      folderId,
    });
    createdCount++;
  }
  
  scheduleSave();
  renderNotes();
  pdfImportStatusEl.textContent = `已创建 ${createdCount} 条笔记（未命中规则的页面已跳过）`;
  pdfSplitPanelEl.classList.add("hidden");
});

function getPdfFolderRulesFromForm() {
  const rules = [];
  for (const r of pdfRulesDraft ?? []) {
    const from = Number(r.from);
    const to = Number(r.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0 || from > to) continue;

    const type = r.targetType ?? "folder";
    if (type === "uncategorized") continue;
    if (type === "folder") {
      const folder = getFolderById(r.folderId);
      if (!folder) continue;
      rules.push({ from, to, folderName: folder.name });
      continue;
    }
    if (type === "new") {
      const name = String(r.newFolderName ?? "").trim();
      if (!name) continue;
      rules.push({ from, to, folderName: name });
      continue;
    }
  }
  return rules;
}

function inferPdfPageNo(chunk) {
  // chunk usually begins with "# 第N页"
  const firstLine = (chunk ?? "").split(/\r?\n/)[0] ?? "";
  const m = firstLine.match(/第\s*(\d+)\s*页/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function getOrCreateFolderIdByName(name) {
  const folderName = (name ?? "").trim();
  if (!folderName) return null;
  ensureFoldersArray();
  const existing = state.folders.find((f) => (f.name ?? "").trim() === folderName);
  if (existing) return existing.id;
  const f = { id: uid("fld"), name: folderName, parentId: null, createdAt: new Date().toISOString() };
  state.folders.push(f);
  return f.id;
}

function pickFolderIdForPageNo(pageNo, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return undefined; // Return undefined if no rules
  if (pageNo == null) return undefined;
  const hit = rules.find((r) => pageNo >= r.from && pageNo <= r.to);
  if (!hit) return undefined; // Return undefined if no rule matches
  if (hit.folderName === null) return null; // Explicitly Uncategorized
  return getOrCreateFolderIdByName(hit.folderName);
}

btnAddPdfRuleEl?.addEventListener("click", () => {
  pdfRulesDraft = Array.isArray(pdfRulesDraft) ? pdfRulesDraft : [];
  pdfRulesDraft.push({ id: uid("pRule"), from: 1, to: 1, targetType: "folder", folderId: null, newFolderName: "" });
  renderPdfRulesForm();
});

// ---------------- Plan (multi-subject) ----------------
const planTabsEl = document.getElementById("planTabs");
const planSubjectHintEl = document.getElementById("planSubjectHint");
const btnAddPlanSubjectEl = document.getElementById("btnAddPlanSubject");
const btnRenamePlanSubjectEl = document.getElementById("btnRenamePlanSubject");
const btnDeletePlanSubjectEl = document.getElementById("btnDeletePlanSubject");

const planSubjectEl = document.getElementById("planSubject");
const planTotalHoursEl = document.getElementById("planTotalHours");
const planDueDateEl = document.getElementById("planDueDate");
const planDailyHoursEl = document.getElementById("planDailyHours");
const specialRulesEl = document.getElementById("specialRules");
const planPreviewEl = document.getElementById("planPreview");
const planSavedHintEl = document.getElementById("planSavedHint");

function getActivePlanId() {
  return state.ui.activePlanId ?? (state.plans?.[0]?.id ?? null);
}

function getActivePlan() {
  const id = getActivePlanId();
  return (state.plans ?? []).find((p) => p.id === id) ?? (state.plans?.[0] ?? null);
}

function setActivePlan(id) {
  if (!id) return;
  state.ui.activePlanId = id;
  scheduleSave();
  renderPlanForm();
  renderToday();
  renderStats();
}

function renderPlanTabs() {
  state.plans = Array.isArray(state.plans) ? state.plans : [];
  const activeId = getActivePlanId();
  planTabsEl.innerHTML = state.plans
    .map(
      (p) =>
        `<button class="tab ${p.id === activeId ? "is-active" : ""}" data-action="pickPlan" data-id="${p.id}" type="button">${escapeHtml(p.subject)}</button>`,
    )
    .join("");
  planTabsEl.querySelectorAll("[data-action='pickPlan']").forEach((b) => {
    b.addEventListener("click", () => setActivePlan(b.dataset.id));
  });

  const active = getActivePlan();
  planSubjectHintEl.textContent = active ? `当前科目：${active.subject}（本页学时按单科目计算）` : "尚未创建科目";
  btnDeletePlanSubjectEl.disabled = state.plans.length <= 1;
}

function renderPlanForm() {
  renderPlanTabs();
  const p = getActivePlan();
  if (!p) return;
  planSubjectEl.value = p.subject ?? "";
  planTotalHoursEl.value = String(p.totalHours ?? 0);
  planDueDateEl.value = p.dueDate ?? "";
  planDailyHoursEl.value = String(p.dailyHours ?? 2);
  renderSpecialRules();
  renderPlanPreview();
}

function renderSpecialRules() {
  const p = getActivePlan();
  const rules = p?.specialRules ?? [];
  if (rules.length === 0) {
    specialRulesEl.innerHTML = `<div class="muted">暂无特殊时段规则。</div>`;
    return;
  }
  specialRulesEl.innerHTML = rules
    .map((r) => {
      return `
      <div class="item">
        <div class="item__title">每月 ${r.startDay} - ${r.endDay} 日</div>
        <div class="item__meta">
          <span class="chip">可用 ${escapeHtml(String(r.hours))} 小时</span>
        </div>
        <div class="item__actions">
          <button class="btn btn--danger" data-action="delRule" data-id="${r.id}">删除</button>
        </div>
      </div>`;
    })
    .join("");

  specialRulesEl.querySelectorAll("button[data-action='delRule']").forEach((b) => {
    b.addEventListener("click", () => {
      const p2 = getActivePlan();
      if (!p2) return;
      const id = b.dataset.id;
      p2.specialRules = (p2.specialRules ?? []).filter((x) => x.id !== id);
      scheduleSave();
      renderSpecialRules();
      renderPlanPreview();
      renderToday();
      renderStats();
    });
  });
}

document.getElementById("btnAddSpecialRule")?.addEventListener("click", () => {
  const p = getActivePlan();
  if (!p) return;
  const startDay = Number(prompt("特殊时段开始日（1-31）", "26") ?? "");
  const endDay = Number(prompt("特殊时段结束日（1-31）", "31") ?? "");
  const hours = Number(prompt("该时段每日可用学习时长（小时）", "0.5") ?? "");
  if (![startDay, endDay, hours].every((n) => Number.isFinite(n))) return;
  if (startDay < 1 || startDay > 31 || endDay < 1 || endDay > 31 || startDay > endDay || hours < 0) {
    alert("输入不合法");
    return;
  }
  p.specialRules = p.specialRules ?? [];
  p.specialRules.push({ id: uid("rule"), startDay, endDay, hours });
  scheduleSave();
  renderSpecialRules();
  renderPlanPreview();
  renderToday();
});

document.getElementById("btnGeneratePlan")?.addEventListener("click", () => {
  const p = getActivePlan();
  if (!p) return;
  p.subject = (planSubjectEl.value ?? "").trim() || p.subject;
  p.totalHours = Number(planTotalHoursEl.value ?? 0) || 0;
  p.dueDate = planDueDateEl.value ?? "";
  p.dailyHours = Number(planDailyHoursEl.value ?? 0) || 0;

  const generated = generatePlan({
    fromISO: todayISO(),
    toISO: p.dueDate,
    totalHours: p.totalHours,
    dailyHours: p.dailyHours,
    specialRules: p.specialRules ?? [],
  });

  p.generated = generated;
  scheduleSave();
  planSavedHintEl.textContent = "已生成并保存";
  renderPlanTabs();
  renderPlanPreview();
  renderToday();
  renderStats();
});

function generatePlan({ fromISO, toISO, totalHours, dailyHours, specialRules }) {
  if (!toISO) return null;
  const from = parseISODateLocal(fromISO) ?? new Date();
  const to = parseISODateLocal(toISO) ?? new Date();
  if (!(from <= to) || totalHours <= 0) return null;

  const days = [];
  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    const iso = toISODateLocal(d);
    const day = d.getDate();
    let hours = dailyHours;
    for (const r of specialRules ?? []) {
      if (day >= r.startDay && day <= r.endDay) hours = r.hours;
    }
    days.push({ iso, availableHours: Math.max(0, Number(hours) || 0) });
  }

  const totalAvail = days.reduce((sum, x) => sum + x.availableHours, 0);
  if (totalAvail <= 0) return { days, totalAvail: 0, allocations: [] };

  const allocations = days.map((x) => ({
    iso: x.iso,
    availableHours: x.availableHours,
    plannedHours: (x.availableHours / totalAvail) * totalHours,
  }));

  return { days, totalAvail, allocations };
}

function renderPlanPreview() {
  const p = getActivePlan();
  const g = p?.generated;
  if (!g || !g.allocations || g.allocations.length === 0) {
    planPreviewEl.innerHTML = `<div class="muted">暂无计划。填写配置后点击「生成计划」。</div>`;
    return;
  }

  // Show a mini-calendar for the next 30 days
  const allocations = g.allocations.slice(0, 30);
  planPreviewEl.innerHTML = `
    <div class="mini-calendar mt12">
      ${allocations.map(a => {
        const isSpecial = (p?.specialRules ?? []).some(r => {
          const day = Number(a.iso.slice(8, 10));
          return day >= r.startDay && day <= r.endDay;
        });
        const hours = Number(a.plannedHours) || 0;
        return `
          <div class="mini-day ${isSpecial ? 'is-special' : ''}" title="${a.iso}: ${hours.toFixed(1)}h">
            <div class="mini-day__label">${a.iso.slice(8, 10)}</div>
            <div class="mini-day__hours">${hours > 0 ? hours.toFixed(1) : ''}</div>
          </div>
        `;
      }).join('')}
    </div>
    <div class="muted mt8">展示未来 30 天的计划（含特殊时段自动调整）。</div>
  `;
}

btnAddPlanSubjectEl.addEventListener("click", () => {
  const name = (prompt("新科目名称", "会计") ?? "").trim();
  if (!name) return;
  state.plans = Array.isArray(state.plans) ? state.plans : [];
  const exists = state.plans.some((p) => (p.subject ?? "").trim() === name);
  if (exists) {
    alert("已存在同名科目");
    return;
  }
  const now = new Date().toISOString();
  const p = {
    id: uid("pln"),
    subject: name,
    totalHours: 0,
    dueDate: "",
    dailyHours: 2,
    specialRules: [],
    generated: null,
    createdAt: now,
    updatedAt: now,
  };
  state.plans.push(p);
  state.ui.activePlanId = p.id;
  scheduleSave();
  renderPlanForm();
});

btnRenamePlanSubjectEl.addEventListener("click", () => {
  const p = getActivePlan();
  if (!p) return;
  const name = (prompt("科目新名称", p.subject) ?? "").trim();
  if (!name) return;
  p.subject = name;
  scheduleSave();
  renderPlanForm();
  renderToday();
  renderStats();
});

btnDeletePlanSubjectEl.addEventListener("click", () => {
  state.plans = Array.isArray(state.plans) ? state.plans : [];
  if (state.plans.length <= 1) return;
  const p = getActivePlan();
  if (!p) return;
  if (!confirm(`确认删除科目「${p.subject}」？该科目的计划配置与预览会被删除。`)) return;
  state.plans = state.plans.filter((x) => x.id !== p.id);
  state.ui.activePlanId = state.plans[0]?.id ?? null;
  scheduleSave();
  renderPlanForm();
  renderToday();
  renderStats();
});

// ---------------- Today ----------------
const todayHintEl = document.getElementById("todayHint");
const todayStudyTargetEl = document.getElementById("todayStudyTarget");
const todayStudyListEl = document.getElementById("todayStudyList");
const todayReviewListEl = document.getElementById("todayReviewList");
const todayMoodSavedEl = document.getElementById("todayMoodSaved");
const studyTimerDisplayEl = document.getElementById("studyTimerDisplay");
const dailyTaskInputEl = document.getElementById("dailyTaskInput");
const dailyTasksListEl = document.getElementById("dailyTasksList");
// (Plan/Stats daily tasks sync cards were removed)

document.querySelectorAll(".segmented__btn").forEach((b) => {
  b.addEventListener("click", () => {
    const iso = todayISO();
    state.dayLog[iso] = state.dayLog[iso] ?? {};
    state.dayLog[iso].mood = b.dataset.mood;
    scheduleSave();
    renderToday();
    renderStats();
  });
});

document.getElementById("btnAddDailyTask")?.addEventListener("click", () => {
  const iso = todayISO();
  const text = (dailyTaskInputEl.value ?? "").trim();
  if (!text) return;
  state.dayLog[iso] = state.dayLog[iso] ?? {};
  state.dayLog[iso].tasks = Array.isArray(state.dayLog[iso].tasks) ? state.dayLog[iso].tasks : [];
  state.dayLog[iso].tasks.unshift({ id: uid("dt"), text, status: "todo", createdAt: new Date().toISOString() });
  dailyTaskInputEl.value = "";
  scheduleSave();
  renderToday();
  renderStats();
});

function getDayTasks(iso) {
  const tasks = state.dayLog?.[iso]?.tasks;
  return Array.isArray(tasks) ? tasks : [];
}

function calcDayTaskSummary(iso) {
  const tasks = getDayTasks(iso);
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const partial = tasks.filter((t) => t.status === "partial").length;
  const todo = tasks.filter((t) => t.status === "todo").length;
  return { total, done, partial, todo };
}

function calcDayTaskOverallStatus(iso) {
  const { total, done, partial } = calcDayTaskSummary(iso);
  if (total === 0) return null;
  if (done === total) return "done";
  if (done > 0 || partial > 0) return "partial";
  return "todo";
}

let studyTimer = { running: false, startedAt: null, noteId: null, tickId: null };

function formatHMS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = String(Math.floor(s / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function startStudyTick() {
  if (!studyTimerDisplayEl) return;
  studyTimerDisplayEl.classList.remove("hidden");
  const startedAt = studyTimer.startedAt ?? Date.now();
  studyTimerDisplayEl.textContent = formatHMS(Date.now() - startedAt);
  if (studyTimer.tickId) clearInterval(studyTimer.tickId);
  studyTimer.tickId = setInterval(() => {
    if (!studyTimer.running) return;
    const base = studyTimer.startedAt ?? Date.now();
    studyTimerDisplayEl.textContent = formatHMS(Date.now() - base);
  }, 1000);
}

function stopStudyTick() {
  if (studyTimer.tickId) clearInterval(studyTimer.tickId);
  studyTimer.tickId = null;
  if (studyTimerDisplayEl) studyTimerDisplayEl.classList.add("hidden");
}

document.getElementById("btnStartStudyTimer")?.addEventListener("click", () => {
  if (!studyTimer.running) {
    studyTimer.running = true;
    studyTimer.startedAt = Date.now();
    studyTimer.noteId = null;
    document.getElementById("btnStartStudyTimer").textContent = "停止并记录";
    startStudyTick();
    return;
  }
  const ms = Date.now() - (studyTimer.startedAt ?? Date.now());
  const hours = ms / 1000 / 60 / 60;
  state.studyLog.push({ id: uid("st"), iso: todayISO(), hours, at: new Date().toISOString() });
  stopStudyTick();
  studyTimer = { running: false, startedAt: null, noteId: null, tickId: null };
  document.getElementById("btnStartStudyTimer").textContent = "开始计时";
  scheduleSave();
  renderToday();
  renderStats();
});

function renderToday() {
  const iso = todayISO();
  const plannedHours = (state.plans ?? [])
    .map((p) => p.generated?.allocations?.find((a) => a.iso === iso)?.plannedHours ?? 0)
    .reduce((sum, x) => sum + (Number(x) || 0), 0);
  const day = Number(iso.slice(8, 10));
  const isSpecial = (state.plans ?? []).some((p) => (p.specialRules ?? []).some((r) => day >= r.startDay && day <= r.endDay));

  todayHintEl.textContent = isSpecial
    ? "今日为轻度学习日，请根据精力安排复习。"
    : "按计划推进，先做新学，再做复习。";

  todayStudyTargetEl.textContent = plannedHours > 0 ? `今日新学目标：${formatHours(plannedHours)}` : "今日新学目标：—";

  const dueTasks = state.reviewTasks.filter((t) => t.dueDate === iso && !t.completedAt);
  if (dueTasks.length === 0) todayReviewListEl.innerHTML = `<div class="muted">今天没有到期复习任务。</div>`;
  else {
    todayReviewListEl.innerHTML = dueTasks
      .map((t) => {
        const note = getNoteById(t.noteId);
        if (!note) return "";
        return `
          <div class="item">
            <div class="item__title">${escapeHtml(note.title)}</div>
            <div class="item__actions">
              <button class="btn" data-action="reviewToday" data-id="${note.id}">去复习</button>
            </div>
          </div>
        `;
      })
      .join("");
    todayReviewListEl.querySelectorAll("button[data-action='reviewToday']").forEach((b) => {
      b.addEventListener("click", () => {
        setRoute("notes");
        openReview(b.dataset.id);
      });
    });
  }

  // Today study list: user-selected notes from Notes page
  const selected = state.notes.filter((n) => n.isTodayTarget);
  todayStudyListEl.innerHTML =
    selected.length === 0
      ? `<div class="muted">暂无今日新学笔记。请去「笔记」页面将笔记加入「今日新学」。</div>`
      : selected
          .map(
            (n) => `
        <div class="item">
          <div class="item__title">${escapeHtml(n.title)}</div>
          <div class="item__meta">${(n.tags ?? []).slice(0, 3).map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join("")}</div>
          <div class="item__actions">
            <button class="btn btn--ghost" data-action="openStudy" data-id="${n.id}">打开</button>
            <button class="btn" data-action="markLearned" data-id="${n.id}">标记已学</button>
            <button class="btn btn--ghost" data-action="removeTodayTarget" data-id="${n.id}">移出今日新学</button>
          </div>
        </div>
      `,
          )
          .join("");

  todayStudyListEl.querySelectorAll("button[data-action='openStudy']").forEach((b) => {
    b.addEventListener("click", () => {
      setRoute("notes");
      openEditor(b.dataset.id);
    });
  });
  todayStudyListEl.querySelectorAll("button[data-action='markLearned']").forEach((b) => {
    b.addEventListener("click", () => {
      setRoute("notes");
      openEditor(b.dataset.id);
      document.getElementById("btnMarkLearned").click();
    });
  });
  todayStudyListEl.querySelectorAll("button[data-action='removeTodayTarget']").forEach((b) => {
    b.addEventListener("click", () => {
      const note = getNoteById(b.dataset.id);
      if (!note) return;
      note.isTodayTarget = false;
      note.updatedAt = new Date().toISOString();
      upsertNote(note);
      scheduleSave();
      renderToday();
      renderNotesList();
    });
  });

  const mood = state.dayLog?.[iso]?.mood ?? null;
  document.querySelectorAll(".segmented__btn").forEach((b) => b.classList.toggle("is-active", b.dataset.mood === mood));
  todayMoodSavedEl.textContent = mood ? `已记录：${mood === "good" ? "状态很好" : mood === "ok" ? "一般般" : "有点难"}` : "";

  renderDailyTasksToday();
}

function renderDailyTasksToday() {
  renderDailyTasksForDate(dailyTasksListEl, todayISO());
}

function renderDailyTasksForDate(containerEl, iso) {
  if (!containerEl) return;
  const tasks = getDayTasks(iso);
  if (tasks.length === 0) {
    containerEl.innerHTML = `<div class="muted">今天还没有自定义打卡任务。</div>`;
    return;
  }

  containerEl.innerHTML = tasks
    .map((t) => {
      const statusLabel = t.status === "done" ? "完成" : t.status === "partial" ? "半完成" : "未开始";
      const chipClass = t.status === "done" ? "chip--accent" : t.status === "partial" ? "chip--warn" : "";
      return `
        <div class="item item--compact">
          <div class="row row--between">
            <div class="item__title">${escapeHtml(t.text)}</div>
            <div class="item__actions">
              <select class="select select--small" data-action="taskStatus" data-iso="${iso}" data-id="${t.id}" aria-label="任务状态">
                <option value="todo" ${t.status === "todo" ? "selected" : ""}>未开始</option>
                <option value="partial" ${t.status === "partial" ? "selected" : ""}>半完成</option>
                <option value="done" ${t.status === "done" ? "selected" : ""}>完成</option>
              </select>
              <button class="btn btn--danger btn--small" data-action="taskDel" data-iso="${iso}" data-id="${t.id}" type="button">删除</button>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  containerEl.querySelectorAll("[data-action='taskStatus']").forEach((sel) => {
    sel.addEventListener("change", () => {
      const id = sel.dataset.id;
      const iso2 = sel.dataset.iso ?? todayISO();
      const list = getDayTasks(iso2);
      const task = list.find((x) => x.id === id);
      if (!task) return;
      task.status = sel.value;
      state.dayLog[iso2] = state.dayLog[iso2] ?? {};
      state.dayLog[iso2].tasks = list;
      scheduleSave();
      renderAll();
    });
  });

  containerEl.querySelectorAll("[data-action='taskDel']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const iso2 = btn.dataset.iso ?? todayISO();
      const list = getDayTasks(iso2).filter((x) => x.id !== id);
      state.dayLog[iso2] = state.dayLog[iso2] ?? {};
      state.dayLog[iso2].tasks = list;
      scheduleSave();
      renderAll();
    });
  });
}

// ---------------- Stats ----------------
const progressHoursBarEl = document.getElementById("progressHoursBar");
const progressHoursTextEl = document.getElementById("progressHoursText");
const progressNotesBarEl = document.getElementById("progressNotesBar");
const progressNotesTextEl = document.getElementById("progressNotesText");
const streakTextEl = document.getElementById("streakText");
const reviewDistributionEl = document.getElementById("reviewDistribution");
const dailyTasksSummaryEl = document.getElementById("dailyTasksSummary");
const calendarEl = document.getElementById("calendar");
const btnCalendarPrevEl = document.getElementById("btnCalendarPrev");
const btnCalendarNextEl = document.getElementById("btnCalendarNext");
const calendarMonthLabelEl = document.getElementById("calendarMonthLabel");

function parseYM(ym) {
  const m = String(ym ?? "").match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) return null;
  return { year: y, month: mo };
}

function formatYM(year, month) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

function shiftYM(ym, deltaMonths) {
  const p = parseYM(ym) ?? parseYM(todayISO().slice(0, 7));
  let y = p.year;
  let m = p.month + deltaMonths;
  while (m < 1) {
    m += 12;
    y -= 1;
  }
  while (m > 12) {
    m -= 12;
    y += 1;
  }
  return formatYM(y, m);
}

function renderStats() {
  const totalHours = (state.plans ?? []).reduce((sum, p) => sum + (Number(p.totalHours) || 0), 0);
  const doneHours = (state.studyLog ?? []).reduce((s, x) => s + (Number(x.hours) || 0), 0);
  const ratioHours = totalHours > 0 ? clamp01(doneHours / totalHours) : 0;
  progressHoursBarEl.style.width = `${ratioHours * 100}%`;
  progressHoursTextEl.textContent = totalHours > 0 ? `${doneHours.toFixed(1)} / ${totalHours.toFixed(1)} 小时` : "未设置总学时";

  // Repurposed Notes Progress to Today's Task Progress
  const iso = todayISO();
  const tasks = getDayTasks(iso);
  const totalTasks = tasks.length;
  const finishedTasks = tasks.reduce((sum, t) => {
    if (t.status === "done") return sum + 1;
    if (t.status === "partial") return sum + 0.5;
    return sum;
  }, 0);
  
  const ratioTasks = totalTasks > 0 ? clamp01(finishedTasks / totalTasks) : 0;
  progressNotesBarEl.style.width = `${ratioTasks * 100}%`;
  progressNotesTextEl.textContent = totalTasks > 0 ? `${finishedTasks} / ${totalTasks} 个任务` : "今日暂无任务";
  
  // Update the label to reflect the change
  const notesLabel = progressNotesBarEl.parentElement.previousElementSibling;
  if (notesLabel) notesLabel.textContent = "今日任务进度";

  streakTextEl.textContent = String(calcStreakDays());
  
  renderTodayTaskStatsInOverview();
  renderReviewDistribution();
  renderDailyTasksSummary();
  renderCalendar();
}

function showDayDetail(iso) {
  const tasks = getDayTasks(iso);
  const mood = state.dayLog?.[iso]?.mood;
  const studyLogs = (state.studyLog ?? []).filter(s => s.iso === iso);
  const totalStudy = studyLogs.reduce((sum, s) => sum + (Number(s.hours) || 0), 0);

  let html = `<div class="card mt12">
    <div class="row row--between">
      <div class="card__title">${iso} 学习记录</div>
      <button class="btn btn--ghost btn--small" onclick="this.parentElement.parentElement.remove()">关闭</button>
    </div>
    <div class="mt12">
      <div class="label">今日状态</div>
      <div class="mt8">${mood ? (mood === 'good' ? '状态很好' : mood === 'ok' ? '一般般' : '有点难') : '未记录'}</div>
    </div>
    <div class="mt12">
      <div class="label">学习时长</div>
      <div class="mt8">${totalStudy.toFixed(1)} 小时</div>
    </div>
    <div class="mt12">
      <div class="label">打卡任务</div>
      <div class="list mt8">
        ${tasks.length === 0 ? '<div class="muted">无任务</div>' : tasks.map(t => `
          <div class="item item--compact">
            <div class="row row--between">
              <div class="item__title">${escapeHtml(t.text)}</div>
              <span class="chip ${t.status === 'done' ? 'chip--accent' : t.status === 'partial' ? 'chip--warn' : ''}">${t.status === 'done' ? '完成' : t.status === 'partial' ? '半完成' : '未开始'}</span>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  </div>`;
  
  const existing = document.getElementById("dayDetailPanel");
  if (existing) existing.remove();
  
  const div = document.createElement("div");
  div.id = "dayDetailPanel";
  div.innerHTML = html;
  document.getElementById("viewStats").prepend(div);
  div.scrollIntoView({ behavior: 'smooth' });
}

function renderTodayTaskStatsInOverview() {
  const container = document.getElementById("todayTaskStatsOverview");
  if (!container) return;
  
  const iso = todayISO();
  const tasks = getDayTasks(iso).filter(t => t.status === "done" || t.status === "partial");
  
  if (tasks.length === 0) {
    container.innerHTML = `<div class="muted mt8">今日暂无已完成或半完成的任务</div>`;
    return;
  }
  
  container.innerHTML = `
    <div class="mt12">
      <div class="label">今日任务进度</div>
      <div class="list mt8">
        ${tasks.map(t => `
          <div class="item item--compact">
            <div class="row row--between">
              <div class="item__title">${escapeHtml(t.text)}</div>
              <span class="chip ${t.status === "done" ? "chip--accent" : "chip--warn"}">${t.status === "done" ? "完成" : "半完成"}</span>
            </div>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

btnCalendarPrevEl?.addEventListener("click", () => {
  state.ui.calendarYM = shiftYM(state.ui.calendarYM ?? todayISO().slice(0, 7), -1);
  scheduleSave();
  renderCalendar();
});

btnCalendarNextEl?.addEventListener("click", () => {
  state.ui.calendarYM = shiftYM(state.ui.calendarYM ?? todayISO().slice(0, 7), 1);
  scheduleSave();
  renderCalendar();
});

function renderDailyTasksSummary() {
  const start = todayISO();
  const days = [];
  for (let i = 0; i < 7; i++) days.push(addDaysISO(start, -i));
  dailyTasksSummaryEl.innerHTML = days
    .map((d) => {
      const s = calcDayTaskSummary(d);
      if (s.total === 0) {
        return `
          <div class="item">
            <div class="row row--between">
              <div class="item__title">${d}</div>
              <div class="item__meta"><span class="chip">无任务</span></div>
            </div>
          </div>
        `;
      }
      return `
        <div class="item">
          <div class="row row--between row--wrap gap8">
            <div class="item__title">${d}</div>
            <div class="item__meta">
              <span class="chip chip--accent">完成 ${s.done}</span>
              <span class="chip chip--warn">半完成 ${s.partial}</span>
              <span class="chip">未开始 ${s.todo}</span>
              <span class="chip">总计 ${s.total}</span>
            </div>
          </div>
        </div>
      `;
    })
    .join("");
}

function calcStreakDays() {
  // Simple streak: consecutive days with either mood recorded or study logged > 0.2h
  const hasStudy = new Map();
  for (const s of state.studyLog ?? []) {
    const h = Number(s.hours) || 0;
    if (h >= 0.2) hasStudy.set(s.iso, true);
  }
  const hasMood = new Map(Object.entries(state.dayLog ?? {}).map(([k, v]) => [k, !!v?.mood]));
  const hasTaskDoneOrPartial = new Map(
    Object.keys(state.dayLog ?? {}).map((iso) => [iso, calcDayTaskOverallStatus(iso) !== null]),
  );

  let streak = 0;
  let cur = todayISO();
  while (true) {
    const ok = hasStudy.get(cur) || hasMood.get(cur) || hasTaskDoneOrPartial.get(cur);
    if (!ok) break;
    streak += 1;
    cur = addDaysISO(cur, -1);
    if (streak > 365) break;
  }
  return streak;
}

function renderReviewDistribution() {
  const start = todayISO();
  const days = [];
  for (let i = 0; i < 7; i++) days.push(addDaysISO(start, i));
  const counts = new Map(days.map((d) => [d, 0]));
  for (const t of state.reviewTasks ?? []) {
    if (!t.completedAt && counts.has(t.dueDate)) counts.set(t.dueDate, counts.get(t.dueDate) + 1);
  }
  reviewDistributionEl.innerHTML = days
    .map((d) => {
      const c = counts.get(d) ?? 0;
      return `
        <div class="item">
          <div class="row row--between">
            <div class="item__title">${d}</div>
            <div class="item__meta">
              <span class="chip ${c > 0 ? "chip--warn" : ""}">复习 ${c} 条</span>
            </div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderCalendar() {
  const ym = state.ui.calendarYM ?? todayISO().slice(0, 7);
  const p = parseYM(ym) ?? parseYM(todayISO().slice(0, 7));
  const year = p.year;
  const month0 = p.month - 1; // 0-based for Date
  if (calendarMonthLabelEl) calendarMonthLabelEl.textContent = ym;

  const first = new Date(year, month0, 1);
  const last = new Date(year, month0 + 1, 0);
  const startWeekday = (first.getDay() + 6) % 7; // Monday=0
  const daysInMonth = last.getDate();

  const cells = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month0, d));

  calendarEl.innerHTML = cells
    .map((date) => {
      if (!date) return `<div class="day is-missed" aria-hidden="true"></div>`;
      const iso = toISODateLocal(date);
      const day = date.getDate();
      const isSpecial = (state.plans ?? []).some((p) => (p.specialRules ?? []).some((r) => day >= r.startDay && day <= r.endDay));
      const planned = (state.plans ?? [])
        .map((p) => p.generated?.allocations?.find((a) => a.iso === iso)?.plannedHours ?? 0)
        .reduce((sum, x) => sum + (Number(x) || 0), 0);
      const actual = (state.studyLog ?? []).filter((s) => s.iso === iso).reduce((sum, x) => sum + (Number(x.hours) || 0), 0);
      let cls = "day";
      if (isSpecial) cls += " is-special";
      if (planned > 0) {
        const p = Number(planned) || 0;
        if (actual >= p) cls += " is-done";
        else if (actual > 0) cls += " is-partial";
        else cls += " is-missed";
      }
      const taskSummary = calcDayTaskSummary(iso);
      const progressed = (taskSummary.done ?? 0) + (taskSummary.partial ?? 0);
      const taskText = taskSummary.total > 0 ? `任务 进展 ${progressed}/${taskSummary.total}` : "任务 —";
      const mood = state.dayLog?.[iso]?.mood ?? null;
      const moodChip =
        mood === "good"
          ? `<span class="chip chip--accent">状态很好</span>`
          : mood === "ok"
            ? `<span class="chip chip--warn">一般般</span>`
            : mood === "hard"
              ? `<span class="chip chip--danger">有点难</span>`
              : ``;
      const timeText =
        planned > 0
          ? `${(Number(planned) || 0).toFixed(1)}h / ${actual.toFixed(1)}h`
          : `— / ${actual.toFixed(1)}h`;
      const body = `${timeText}<br/>${taskText}`;
      return `
        <div class="${cls}" data-action="clickDay" data-iso="${iso}">
          <div class="day__head">
            <div>${day}</div>
            <div class="row gap8">
              ${isSpecial ? `<span class="chip chip--warn">特殊</span>` : ``}
              ${moodChip}
            </div>
          </div>
          <div class="day__body">${body}</div>
        </div>
      `;
    })
    .join("");

  calendarEl.querySelectorAll("[data-action='clickDay']").forEach(el => {
    el.addEventListener("click", () => showDayDetail(el.dataset.iso));
  });
}

// ---------------- Boot ----------------
function renderAll() {
  renderToday();
  renderNotes();
  renderPlanForm();
  renderStats();

  if (state.ui.activeNoteId) {
    const note = getNoteById(state.ui.activeNoteId);
    if (note) openEditor(note.id);
  }
}

setRoute(state.ui.lastRoute ?? "today");
renderAll();

// PWA: register service worker (requires http(s), not file://)
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

