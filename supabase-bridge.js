/* ═══════════════════════════════════════════════════════════════
   supabase-bridge.js  v7 — adapted for Elite Minds Academy
   ───────────────────────────────────────────────────────────────
   • Zero changes to script.js — intercepts localStorage.setItem
   • Keys, URL and auth wired for YOUR project
   • Realtime ON by default
   • Safe refresh — won't reload while user is typing or in a modal
   • Dirty flag prevents cloud-empty wipes
   • Mirror DISABLED (your schema ≠ friend's schema — see note below)
   ═══════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    // ── YOUR PROJECT SETTINGS ─────────────────────────────────────
    const SUPABASE_URL      = 'https://kcfhqipelrxymxuekeem.supabase.co';
    const SUPABASE_ANON_KEY = 'sb_publishable_FN1vIx0t1JKXLsN17dg41Q_GFoQLDUS';

    // ── KEYS — must match script.js exactly ───────────────────────
    const STORAGE_KEY   = 'DarAlWafaa_v1';        // ← script.js STORAGE_KEY
    const SETTINGS_KEY  = 'DarAlWafaaSettings';   // ← script.js SETTINGS_KEY
    const SESSION_KEY   = 'DarAlWafaaAuth';       // ← script.js AUTH_KEY

    const TABLE         = 'app_state';
    const DIRTY_KEY     = '__bridge_dirty';
    const SDK_URL       = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
    const PUSH_DEBOUNCE = 1500;
    const RELOAD_FLAG   = '__bridge_reloaded';
    const REALTIME_ON   = true;
    const MIRROR_ON     = false;                  // ← leave OFF until you create matching tables
    const RETRY_INTERVAL = 30000;

    let supabase        = null;
    let initialized     = false;
    let online          = navigator.onLine;
    let pushTimer       = null;
    let pushing         = false;
    let pendingPush     = { [STORAGE_KEY]: false, [SETTINGS_KEY]: false };
    let realtimeChannel = null;
    let lastCloudUpdate = 0;
    let lastPushTs      = 0;
    let suppressPush    = false;
    let applyingRemote  = false;
    let _refreshTimer   = null;

    const log  = (...a) => window.SUPABASE_BRIDGE_DEBUG && console.log('[Bridge]', ...a);
    const warn = (...a) => console.warn('[Bridge]', ...a);

    // ── UTILITIES ─────────────────────────────────────────────────
    function showToast(msg, isError) {
        for (const id of ['toast', 'teacherToast', 'accountantToast']) {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = msg;
                el.style.background = isError ? '#e74c3c' : '#27ae60';
                el.classList.add('show');
                clearTimeout(el._bridgeTimer);
                el._bridgeTimer = setTimeout(() => el.classList.remove('show'), 3500);
                return;
            }
        }
    }

    function safeParse(raw, fallback = null) {
        if (!raw) return fallback;
        try { return JSON.parse(raw); } catch { return fallback; }
    }

    function isDirty()    { try { return localStorage.getItem(DIRTY_KEY) === '1'; } catch { return false; } }
    function markDirty()  { try { localStorage.setItem(DIRTY_KEY, '1'); } catch {} }
    function clearDirty() { try { localStorage.removeItem(DIRTY_KEY); } catch {} }

    // ── STORAGE HOOK — the magic ──────────────────────────────────
    function installStorageHook() {
        if (localStorage.__bridgePatched) return;
        const orig = localStorage.setItem.bind(localStorage);
        localStorage.setItem = function (key, value) {
            orig(key, value);
            if (key === STORAGE_KEY || key === SETTINGS_KEY) schedulePush(key);
        };
        Object.defineProperty(localStorage, '__bridgePatched', {
            value: true, writable: false, enumerable: false, configurable: false
        });
    }

    function installFunctionHooks() {
        const wrap = (name) => {
            const orig = window[name];
            if (typeof orig !== 'function' || orig.__bridgeWrapped) return;
            const wrapped = function (...args) {
                const r = orig.apply(this, args);
                try {
                    if (name.startsWith('saveSettings')) schedulePush(SETTINGS_KEY);
                    else schedulePush(STORAGE_KEY);
                } catch {}
                return r;
            };
            wrapped.__bridgeWrapped = true;
            window[name] = wrapped;
        };
        // script.js uses saveAll and saveSettings
        ['saveAll', 'saveData', 'saveToLocal', 'saveSettings', 'saveSettingsHandler'].forEach(wrap);
    }

    // ── SDK LOADER ────────────────────────────────────────────────
    function loadSdk() {
        return new Promise((resolve, reject) => {
            if (window.supabase?.createClient) return resolve(window.supabase);
            const existing = document.querySelector(`script[src="${SDK_URL}"]`);
            if (existing) {
                existing.addEventListener('load', () => resolve(window.supabase));
                existing.addEventListener('error', reject);
                return;
            }
            const s = document.createElement('script');
            s.src = SDK_URL; s.async = true;
            s.onload  = () => resolve(window.supabase);
            s.onerror = () => reject(new Error('Failed to load Supabase SDK'));
            document.head.appendChild(s);
        });
    }

    // ── CLOUD I/O ─────────────────────────────────────────────────
    async function cloudGet(key) {
        if (!supabase) return null;
        const { data, error } = await supabase
            .from(TABLE).select('value, updated_at').eq('key', key).maybeSingle();
        if (error) { warn('cloudGet', key, error.message); return null; }
        return data;
    }

    async function cloudPut(key, value) {
        const now = new Date().toISOString();
        lastPushTs = Date.now();
        const { error } = await supabase
            .from(TABLE)
            .upsert({ key, value, updated_at: now }, { onConflict: 'key' });
        if (error) throw error;
    }

    // ── MIRROR — disabled by default (your schema ≠ friend's) ─────
    async function mirrorAll(_data) {
        if (!MIRROR_ON) return;
        // Removed — will be re-added later when you're ready to mirror
        // each entity to its own table for reporting.
        log('Mirror skipped (MIRROR_ON=false)');
    }

    // ── PUSH QUEUE ────────────────────────────────────────────────
    async function pushKey(key) {
        if (!supabase || !online) return false;
        const parsed = safeParse(localStorage.getItem(key));
        if (parsed === null) return false;
        try { await cloudPut(key, parsed); return true; }
        catch (err) { warn('pushKey', key, err.message); return false; }
    }

    async function flushPushQueue() {
        if (pushing || !online || !supabase) return;
        pushing = true;
        try {
            const keys = Object.keys(pendingPush).filter(k => pendingPush[k]);
            for (const k of keys) {
                pendingPush[k] = false;
                const ok = await pushKey(k);
                if (!ok) pendingPush[k] = true;
            }
            const mainData = safeParse(localStorage.getItem(STORAGE_KEY));
            if (mainData) await mirrorAll(mainData);
            if (Object.values(pendingPush).every(v => !v)) clearDirty();
        } finally { pushing = false; }
    }

    function schedulePush(key) {
        if (suppressPush || applyingRemote) return;
        markDirty();
        pendingPush[key] = true;
        clearTimeout(pushTimer);
        pushTimer = setTimeout(flushPushQueue, PUSH_DEBOUNCE);
    }

    // ── SAFE REFRESH ──────────────────────────────────────────────
    function safeRefreshFromCloud() {
        const openModal = document.querySelector('.modal-overlay.active');
        if (openModal) {
            showToast('☁️ New data available — close the form to see it');
            return;
        }
        const focused = document.activeElement;
        if (focused && ['INPUT','TEXTAREA','SELECT'].includes(focused.tagName)) {
            showToast('☁️ New data available — refresh when ready');
            return;
        }
        if (_refreshTimer) return;
        showToast('☁️ Syncing changes from another device…');
        _refreshTimer = setTimeout(() => {
            _refreshTimer = null;
            location.reload();
        }, 800);
    }

    // ── REALTIME ──────────────────────────────────────────────────
    function startRealtime() {
        if (!REALTIME_ON) { log('Realtime disabled'); return; }
        if (!supabase || realtimeChannel) return;
        try {
            realtimeChannel = supabase
                .channel('app_state_changes')
                .on('postgres_changes',
                    { event: '*', schema: 'public', table: TABLE },
                    (payload) => {
                        const row = payload.new || payload.old;
                        if (!row?.key) return;
                        const ts = Date.now();
                        if (Date.now() - lastPushTs < 10000) return; // ignore own echo
                        if (ts <= lastCloudUpdate) return;
                        lastCloudUpdate = ts;

                        if (row.key === STORAGE_KEY && row.value) {
                            applyingRemote = true;
                            localStorage.setItem(STORAGE_KEY, JSON.stringify(row.value));
                            applyingRemote = false;
                            safeRefreshFromCloud();
                        } else if (row.key === SETTINGS_KEY && row.value) {
                            applyingRemote = true;
                            localStorage.setItem(SETTINGS_KEY, JSON.stringify(row.value));
                            applyingRemote = false;
                            if (typeof window.applySettings === 'function') {
                                try { window.applySettings(); } catch {}
                            }
                        }
                    })
                .subscribe((status) => log('Realtime:', status));
        } catch (err) { warn('Realtime failed:', err.message); }
    }

    // ── CONNECTIVITY ──────────────────────────────────────────────
    function installConnectivity() {
        window.addEventListener('online', () => {
            online = true;
            showToast('🌐 Back online — syncing…');
            pendingPush[STORAGE_KEY]  = true;
            pendingPush[SETTINGS_KEY] = true;
            flushPushQueue();
        });
        window.addEventListener('offline', () => {
            online = false;
            showToast('📴 Offline — changes will sync later', true);
        });
        setInterval(() => {
            if (!isDirty() || !online || !supabase) return;
            log('Retrying unsynced changes…');
            pendingPush[STORAGE_KEY]  = true;
            pendingPush[SETTINGS_KEY] = true;
            flushPushQueue();
        }, RETRY_INTERVAL);
    }

    // ── INIT ──────────────────────────────────────────────────────
    async function init() {
        if (initialized) return;

        installStorageHook();
        installFunctionHooks();

        if (!SUPABASE_ANON_KEY || SUPABASE_ANON_KEY.startsWith('PASTE_')) {
            warn('No Supabase key set');
            window.__bridgeReady = true;
            window.dispatchEvent(new CustomEvent('bridge:ready'));
            return;
        }

        try {
            const sdk = await loadSdk();
            supabase = sdk.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
                auth: { persistSession: false, autoRefreshToken: false }
            });

            if (isDirty()) {
                log('Unsynced local changes detected — pushing before pull');
                pendingPush[STORAGE_KEY]  = true;
                pendingPush[SETTINGS_KEY] = true;
                await flushPushQueue();
            }

            const [mainRow, settingsRow] = await Promise.all([
                cloudGet(STORAGE_KEY), cloudGet(SETTINGS_KEY)
            ]);

            const localMain = localStorage.getItem(STORAGE_KEY);
            const localHasData = localMain && localMain.length > 50;
            const cloudIsEmpty = !mainRow || !mainRow.value ||
                (!mainRow.value.students?.length &&
                 !mainRow.value.classes?.length &&
                 !mainRow.value.payments?.length &&
                 !mainRow.value.exams?.length);

            if (localHasData && cloudIsEmpty) {
                log('Cloud empty, local has data — seeding cloud from local');
                pendingPush[STORAGE_KEY]  = true;
                pendingPush[SETTINGS_KEY] = true;
                await flushPushQueue();
            } else {
                let localChanged = false;
                suppressPush = true;
                if (mainRow?.value) {
                    const incoming = JSON.stringify(mainRow.value);
                    if (incoming !== localStorage.getItem(STORAGE_KEY)) {
                        localStorage.setItem(STORAGE_KEY, incoming);
                        localChanged = true;
                    }
                    lastCloudUpdate = new Date(mainRow.updated_at || 0).getTime();
                }
                if (settingsRow?.value) {
                    const incoming = JSON.stringify(settingsRow.value);
                    if (incoming !== localStorage.getItem(SETTINGS_KEY)) {
                        localStorage.setItem(SETTINGS_KEY, incoming);
                        localChanged = true;
                    }
                }
                suppressPush = false;

                // Only force-reload if logged out (SESSION_KEY = 'DarAlWafaaAuth')
                const hasSession = !!localStorage.getItem(SESSION_KEY);
                if (localChanged && !hasSession && !sessionStorage.getItem(RELOAD_FLAG)) {
                    sessionStorage.setItem(RELOAD_FLAG, '1');
                    log('Reloading once (logged out) to apply cloud data');
                    location.reload();
                    return;
                }
            }

            startRealtime();
            installConnectivity();

            const data = safeParse(localStorage.getItem(STORAGE_KEY));
            if (data) mirrorAll(data).catch(() => {});

            if (Object.values(pendingPush).some(Boolean)) {
                flushPushQueue();
            }

            initialized = true;
            log('Bridge ready');
            window.__bridgeReady = true;
            window.dispatchEvent(new CustomEvent('bridge:ready'));
        } catch (err) {
            warn('Init failed:', err.message);
            window.__bridgeReady = true;
            window.dispatchEvent(new CustomEvent('bridge:ready'));
        }
    }

    // ── PUBLIC API ────────────────────────────────────────────────
    window.SupabaseBridge = {
        init,
        push: async () => {
            pendingPush[STORAGE_KEY]  = true;
            pendingPush[SETTINGS_KEY] = true;
            await flushPushQueue();
            showToast('☁️ Pushed to cloud');
        },
        pull: async () => {
            const [r1, r2] = await Promise.all([
                cloudGet(STORAGE_KEY), cloudGet(SETTINGS_KEY)
            ]);
            suppressPush = true;
            if (r1?.value) localStorage.setItem(STORAGE_KEY, JSON.stringify(r1.value));
            if (r2?.value) localStorage.setItem(SETTINGS_KEY, JSON.stringify(r2.value));
            suppressPush = false;
            showToast('☁️ Loaded from cloud');
        },
        forceSync: async () => {
            await window.SupabaseBridge.pull();
            await window.SupabaseBridge.push();
            showToast('🔄 Full sync complete');
        },
        resetFlags: () => {
            sessionStorage.removeItem(RELOAD_FLAG);
            clearDirty();
            showToast('🔄 Flags cleared');
        },
        status: () => ({
            initialized,
            online,
            pushing,
            realtime: REALTIME_ON,
            dirty: isDirty(),
            hasSession: !!localStorage.getItem(SESSION_KEY),
            lastCloudUpdate: new Date(lastCloudUpdate).toISOString(),
            lastPushTs: new Date(lastPushTs).toISOString()
        }),
        get client() { return supabase; }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();