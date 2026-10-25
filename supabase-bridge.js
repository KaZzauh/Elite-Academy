/* ═══════════════════════════════════════════════════════════════
   supabase-bridge.js  v11 — Elite Minds Academy
   ───────────────────────────────────────────────────────────────
   • Syncs JSON blob to individual relational tables
   • Includes Safety Guard: Prevents empty devices from wiping 
     the cloud database.
   ═══════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    const SUPABASE_URL      = 'https://kcfhqipelrxymxuekeem.supabase.co';
    const SUPABASE_ANON_KEY = 'sb_publishable_FN1vIx0t1JKXLsN17dg41Q_GFoQLDUS';

    const STORAGE_KEY   = 'DarAlWafaa_v1';        
    const SETTINGS_KEY  = 'DarAlWafaaSettings';   
    const SESSION_KEY   = 'DarAlWafaaAuth';       
    const USERS_KEY     = 'DarAlWafaaUsers';      

    const TABLE          = 'app_state';
    const DIRTY_KEY      = '__bridge_dirty';
    const SDK_URL        = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
    const PUSH_DEBOUNCE  = 1500;
    const RELOAD_FLAG    = '__bridge_reloaded';
    const REALTIME_ON    = false;   
    const RETRY_INTERVAL = 30000;

    let supabase        = null;
    let initialized     = false;
    let online          = navigator.onLine;
    let pushTimer       = null;
    let pushing         = false;
    let pendingPush     = {
        [STORAGE_KEY]:  false,
        [SETTINGS_KEY]: false,
        [USERS_KEY]:    false
    };
    let lastCloudUpdate = 0;
    let lastPushTs      = 0;
    let suppressPush    = false;
    let applyingRemote  = false;

    const log  = (...a) => window.SUPABASE_BRIDGE_DEBUG && console.log('[Bridge]', ...a);
    const warn = (...a) => console.warn('[Bridge]', ...a);

    function showToast(msg, isError) {
        for (const id of ['toast']) {
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

    function installStorageHook() {
        if (localStorage.__bridgePatched) return;
        const orig = localStorage.setItem.bind(localStorage);
        localStorage.setItem = function (key, value) {
            orig(key, value);
            if (key === STORAGE_KEY || key === SETTINGS_KEY || key === USERS_KEY) {
                schedulePush(key);
            }
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
                    else if (name === 'saveUsers')        schedulePush(USERS_KEY);
                    else                                  schedulePush(STORAGE_KEY);
                } catch {}
                return r;
            };
            wrapped.__bridgeWrapped = true;
            window[name] = wrapped;
        };
        ['saveAll', 'saveData', 'saveToLocal', 'saveSettings', 'saveSettingsHandler', 'saveUsers'].forEach(wrap);
    }

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

    async function syncToTables(blobData) {
        if (!supabase || !blobData) return;
        
        const TABLE_MAP = {
            students: 'students', 
            classes: 'classes', 
            subjects: 'subjects',
            staff: 'staff', 
            attendance: 'attendance', 
            staffAttendance: 'staff_attendance',
            exams: 'exams', 
            grades: 'grades', 
            payments: 'payments', 
            expenses: 'expenses'
        };

        for (const [key, table] of Object.entries(TABLE_MAP)) {
            const arr = blobData[key];
            if (!Array.isArray(arr)) continue;
            
            try {
                // 1. Handle Deletions
                const { data: existing } = await supabase.from(table).select('id');
                if (existing && existing.length > 0) {
                    const currentIds = arr.map(x => x.id);
                    const toDelete = existing.map(r => r.id).filter(id => !currentIds.includes(id));
                    if (toDelete.length > 0) {
                        await supabase.from(table).delete().in('id', toDelete);
                    }
                }

                // 2. Handle Insertions / Updates
                if (arr.length > 0) {
                    const { error } = await supabase.from(table).upsert(arr);
                    if (error) console.warn(`[Bridge] Sync error for ${table}:`, error.message);
                }
            } catch (err) {
                console.warn(`[Bridge] Sync failed for ${table}:`, err.message);
            }
        }
    }

    async function pushKey(key) {
        if (!supabase || !online) return false;
        const parsed = safeParse(localStorage.getItem(key));
        if (parsed === null) return false;

        // 🟢 SAFETY GUARD: Prevent wiping the cloud with empty data
        if (key === STORAGE_KEY) {
            const isEmpty = (!parsed.students || parsed.students.length === 0) && 
                            (!parsed.classes || parsed.classes.length === 0) && 
                            (!parsed.payments || parsed.payments.length === 0);
            
            if (isEmpty) {
                console.warn('[Bridge] Prevented pushing empty data to cloud. Data is safe.');
                return true; // Pretend it succeeded so it doesn't try to retry
            }
        }

        try { 
            await cloudPut(key, parsed); 
            if (key === STORAGE_KEY) {
                await syncToTables(parsed);
            }
            return true; 
        }
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
            if (Object.values(pendingPush).every(v => !v)) clearDirty();
        } finally {
            pushing = false;
        }
    }

    function schedulePush(key) {
        if (suppressPush || applyingRemote) return;
        markDirty();
        pendingPush[key] = true;
        clearTimeout(pushTimer);
        pushTimer = setTimeout(flushPushQueue, PUSH_DEBOUNCE);
    }

    function startRealtime() {
        if (!REALTIME_ON) { log('Realtime reload disabled'); }
    }

    function installConnectivity() {
        window.addEventListener('online', () => {
            online = true;
            showToast('🌐 Back online — syncing…');
            pendingPush[STORAGE_KEY]  = true;
            pendingPush[SETTINGS_KEY] = true;
            pendingPush[USERS_KEY]    = true;
            flushPushQueue();
        });
        window.addEventListener('offline', () => {
            online = false;
            showToast('📴 Offline — changes will sync later', true);
        });
        setInterval(() => {
            if (!isDirty() || !online || !supabase) return;
            pendingPush[STORAGE_KEY]  = true;
            pendingPush[SETTINGS_KEY] = true;
            pendingPush[USERS_KEY]    = true;
            flushPushQueue();
        }, RETRY_INTERVAL);
    }

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
                pendingPush[STORAGE_KEY]  = true;
                pendingPush[SETTINGS_KEY] = true;
                pendingPush[USERS_KEY]    = true;
                await flushPushQueue();
            }

            const [mainRow, settingsRow, usersRow] = await Promise.all([
                cloudGet(STORAGE_KEY),
                cloudGet(SETTINGS_KEY),
                cloudGet(USERS_KEY)
            ]);

            const localMain = localStorage.getItem(STORAGE_KEY);
            const localHasData = localMain && localMain.length > 50;
            const cloudIsEmpty = !mainRow || !mainRow.value ||
                (!mainRow.value.students?.length &&
                 !mainRow.value.classes?.length &&
                 !mainRow.value.payments?.length &&
                 !mainRow.value.exams?.length);

            if (localHasData && cloudIsEmpty) {
                log('Cloud empty, local has data — seeding cloud');
                pendingPush[STORAGE_KEY]  = true;
                pendingPush[SETTINGS_KEY] = true;
                pendingPush[USERS_KEY]    = true;
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
                if (usersRow?.value) {
                    const incoming = JSON.stringify(usersRow.value);
                    if (incoming !== localStorage.getItem(USERS_KEY)) {
                        localStorage.setItem(USERS_KEY, incoming);
                        localChanged = true;
                    }
                }

                suppressPush = false;

                const hasSession   = !!localStorage.getItem(SESSION_KEY);
                const loginOverlay = document.getElementById('loginOverlay');
                const loginVisible = loginOverlay && !loginOverlay.classList.contains('hidden');
                const isTyping     = document.activeElement &&
                    ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName);

                if (localChanged && !hasSession && loginVisible && !isTyping
                    && !sessionStorage.getItem(RELOAD_FLAG)) {
                    sessionStorage.setItem(RELOAD_FLAG, '1');
                    log('One-time reload to apply cloud data');
                    location.reload();
                    return;
                }
            }

            startRealtime();
            installConnectivity();

            if (Object.values(pendingPush).some(Boolean)) flushPushQueue();

            initialized = true;
            log('Bridge v11 ready (Safety Guard enabled)');
            window.__bridgeReady = true;
            window.dispatchEvent(new CustomEvent('bridge:ready'));
        } catch (err) {
            warn('Init failed:', err.message);
            window.__bridgeReady = true;
            window.dispatchEvent(new CustomEvent('bridge:ready'));
        }
    }

    window.SupabaseBridge = {
        init,
        push: async () => {
            pendingPush[STORAGE_KEY]  = true;
            pendingPush[SETTINGS_KEY] = true;
            pendingPush[USERS_KEY]    = true;
            await flushPushQueue();
            showToast('☁️ Pushed to cloud');
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
