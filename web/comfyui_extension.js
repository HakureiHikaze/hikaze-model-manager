// ComfyUI menu extension - Hikaze Model Manager

import { app } from "../../scripts/app.js";

// Lightweight i18n for extension (fetch from backend /web/i18n)
const LANG_KEY = 'hikaze_mm_lang';
const I18N = {
    dict: {},
    lang: 'zh-CN',
    ready: false,
    normalizeLang(l){
        try{ let s = String(l||'').replace('_','-'); if (s.toLowerCase().startsWith('zh')) return 'zh-CN'; if (/^en(-|$)/i.test(s)) return 'en-US'; return 'zh-CN'; }catch(_){ return 'zh-CN'; }
    },
    getStored(){ try{ return localStorage.getItem(LANG_KEY) || 'system'; }catch(_){ return 'system'; } },
    setStored(v){ try{ if (!v || v==='system') localStorage.setItem(LANG_KEY, 'system'); else localStorage.setItem(LANG_KEY, v); }catch(_){ } },
    async init(){
        try{
            const stored = this.getStored();
            const chosen = (stored && stored !== 'system') ? stored : ((navigator && (navigator.language || navigator.userLanguage)) || 'zh-CN');
            this.lang = this.normalizeLang(chosen);
            const url = `http://127.0.0.1:8789/web/i18n/${this.lang}.json`;
            const res = await fetch(url);
            if (res.ok){ this.dict = await res.json(); this.ready = true; }
        }catch(err){ console.warn('[Hikaze] i18n load failed:', err); this.dict = {}; this.ready = false; }
    },
    t(k){ return (this.dict && Object.prototype.hasOwnProperty.call(this.dict, k)) ? this.dict[k] : k; },
};
const t = (k)=> I18N.t(k);

// Global state management
const HikazeManager = {
    modalWindow: null,
    isServerStarted: false,
    stylesLoaded: false,
    menuButton: null,
    initAttempts: 0,
    maxInitAttempts: 30,
    pending: new Map(), // requestId -> { node, widget, overlay, mode }
};

// Utility: normalize LoRA key (for dedupe and preselect matching)
function normalizeLoraKey(s){
    try{
        return String(s || '')
            .replace(/\\/g, '/')
            .trim()
            .toLowerCase();
    }catch(_){ return ''; }
}

function collectLoraGroups(node){
    const groups = new Map(); // idx -> { idx, on, nameWidget, nameVal, smWidget, scWidget }
    const list = Array.isArray(node.widgets) ? node.widgets : [];
    const re = /^lora_(\d+)(?:_(on|strength_model|strength_clip|remove))?$/;
    for (const w of list){
        const name = w && (w.name || w.label);
        if (!name || typeof name !== 'string') continue;
        const m = name.match(re);
        if (!m) continue;
        const idx = parseInt(m[1], 10);
        if (Number.isNaN(idx)) continue;
        const sub = m[2] || null;
        const g = groups.get(idx) || { idx, on: true };
        if (sub === null){ g.nameWidget = w; g.nameVal = w.value; }
        else if (sub === 'on'){ g.onWidget = w; g.on = !!w.value; }
        else if (sub === 'strength_model'){ g.smWidget = w; }
        else if (sub === 'strength_clip'){ g.scWidget = w; }
        else if (sub === 'remove'){ g.rmWidget = w; }
        groups.set(idx, g);
    }
    return groups;
}

function removeGroup(node, idx){
    try{
        if (!Array.isArray(node.widgets)) return;
        const re = new RegExp(`^lora_${idx}(?:_(?:on|strength_model|strength_clip|remove))?$`);
        node.widgets = node.widgets.filter(w=>{
            const name = w && (w.name || w.label);
            return !(name && re.test(String(name)));
        });
    }catch(err){ console.warn('[Hikaze] removeGroup failed:', err); }
}

function clearAllGroups(node){
    try{
        if (!Array.isArray(node.widgets)) return;
        // Filter both old format and new format
        const re = /^lora_\d+(?:_(?:on|strength_model|strength_clip|remove))?$/;
        node.widgets = node.widgets.filter(w=>{
            const name = w && (w.name || w.label);
            if (!name) return true;
            return !re.test(String(name));
        });
    }catch(err){ console.warn('[Hikaze] clearAllGroups failed:', err); }
}

function ensureGroup(node, idx, item){
    // Create simple widgets that match the backend's expectations
    if (!Array.isArray(node.widgets)) node.widgets = [];
    
    // Remove existing widgets for this index first
    removeGroup(node, idx);
    
    const key = item.key || '';
    const sm = Number(item.sm) || 1.0;
    const sc = Number(item.sc) || 1.0;
    
    // Add the widgets that the backend expects
    if (node.addWidget) {
        // LoRA name widget
        const nameWidget = node.addWidget('text', `lora_${idx}`, key, null, {
            multiline: false,
            placeholder: 'LoRA name'
        });
        if (nameWidget) nameWidget.value = key;
        
        // On/off widget
        const onWidget = node.addWidget('toggle', `lora_${idx}_on`, true);
        if (onWidget) onWidget.value = true;
        
        // Model strength widget
        const smWidget = node.addWidget('number', `lora_${idx}_strength_model`, sm, null, {
            min: -10, max: 10, step: 0.05, precision: 2
        });
        if (smWidget) smWidget.value = sm;
        
        // Clip strength widget
        const scWidget = node.addWidget('number', `lora_${idx}_strength_clip`, sc, null, {
            min: -10, max: 10, step: 0.05, precision: 2
        });
        if (scWidget) scWidget.value = sc;
        
        // Remove button
        const rmWidget = node.addWidget('button', `lora_${idx}_remove`, 'Remove', () => {
            removeGroup(node, idx);
            try { node.setDirtyCanvas(true, true); } catch(_) {}
        }, { serialize: false });
    }
}

function currentSelectedKeysForPreselect(node){
    const keys = [];
    if (!node.widgets) return keys;
    // Look for lora_N widgets (the name widgets)
    for(const w of node.widgets){
        if (w && w.name && w.name.match(/^lora_\d+$/) && w.value){
            const key = normalizeLoraKey(w.value);
            if (key) keys.push(key);
        }
    }
    return keys;
}



// Inline styles - avoid issues when loading external CSS
const MODAL_STYLES = `
.hikaze-modal-overlay {
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    background-color: rgba(0, 0, 0, 0.5) !important;
    z-index: 99999 !important;
    display: block !important;
    backdrop-filter: blur(3px) !important;
}
/* Full-page container (no border/radius/shadow), only used to host the iframe */
.hikaze-fullpage {
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    background: #2a2a2a !important;
    overflow: hidden !important;
}
.hikaze-loading { display:flex !important; align-items:center !important; justify-content:center !important; height:100% !important; color:#fff !important; }
.hikaze-spinner { width: 32px !important; height: 32px !important; border: 3px solid rgba(255,255,255,0.1) !important; border-top:3px solid #4CAF50 !important; border-radius:50% !important; animation: hikaze-spin 1s linear infinite !important; }
@keyframes hikaze-spin { 0%{transform:rotate(0)} 100%{transform:rotate(360deg)} }
.hikaze-modal-content iframe { position:absolute !important; inset:0 !important; width:100% !important; height:100% !important; border:none !important; background:#2a2a2a !important; }
.hikaze-menu-button { position: fixed !important; top: 48px !important; right: 10px !important; z-index: 10000 !important; padding: 10px 15px !important; background: linear-gradient(135deg, #4CAF50, #45a049) !important; color: white !important; border: none !important; border-radius: 6px !important; cursor: pointer !important; font-size: 13px !important; font-weight: 500 !important; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important; box-shadow: 0 4px 12px rgba(76, 175, 80, 0.3) !important; transition: all 0.2s ease !important; }
.hikaze-menu-button:hover { background: linear-gradient(135deg, #45a049, #4CAF50) !important; transform: translateY(-1px) !important; box-shadow: 0 6px 16px rgba(76,175,80,0.4) !important; }
`;

// Load styles
function loadStyles() {
    if (HikazeManager.stylesLoaded) return;

    const styleElement = document.createElement('style');
    styleElement.id = 'hikaze-modal-styles';
    styleElement.textContent = MODAL_STYLES;
    document.head.appendChild(styleElement);
    HikazeManager.stylesLoaded = true;
    console.log('[Hikaze] Styles loaded');
}

// Check backend server status
async function checkServerStatus() {
    try {
        const response = await fetch('http://127.0.0.1:8789/health', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' },
            timeout: 5000
        });

        if (response.ok) {
            const data = await response.json();
            console.log('[Hikaze] Server status:', data);
            return true;
        }
        return false;
    } catch (error) {
        console.log('[Hikaze] Server not responding:', error.message);
        return false;
    }
}

// Wait for server to start
async function waitForServer(maxWaitTime = 15000) {
    const startTime = Date.now();
    const checkInterval = 1000;

    console.log('[Hikaze] Waiting for server to start...');

    while (Date.now() - startTime < maxWaitTime) {
        if (await checkServerStatus()) {
            HikazeManager.isServerStarted = true;
            console.log('[Hikaze] Server is ready!');
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    console.error('[Hikaze] Server failed to start within timeout');
    return false;
}

function currentLang(){ return I18N.lang || 'zh-CN'; }

// Create a generic modal window
function createOverlay({ title = t('mm.title.manager'), iframeSrc = 'http://127.0.0.1:8789/web/manager.html' } = {}) {
    loadStyles();

    const overlay = document.createElement('div');
    overlay.className = 'hikaze-modal-overlay';
    overlay.innerHTML = `
        <div class="hikaze-modal-content hikaze-fullpage">
            <div class="hikaze-loading">
                <div class="hikaze-spinner"></div>
                <p style="margin-left:8px">${t('mm.common.loading')}</p>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    // lock body scroll while overlay is open
    const prevOverflow = document.body && document.body.style ? document.body.style.overflow : '';
    try { if (document.body && document.body.style) document.body.style.overflow = 'hidden'; } catch(_){}

    const escHandler = (e) => { if (e.key === 'Escape') doClose(); };
    const doClose = () => {
        document.removeEventListener('keydown', escHandler);
        try { if (document.body && document.body.style) document.body.style.overflow = prevOverflow || ''; } catch(_){ }
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    // expose unified close method for external callers
    overlay.__hikazeClose = doClose;

    document.addEventListener('keydown', escHandler);
    overlay.onclick = (e) => { /* full-page overlay; clicking the backdrop does not close */ };

    // load iframe
    (async () => {
        const loading = overlay.querySelector('.hikaze-loading');
        const ok = await waitForServer();
        if (!ok) { if (loading) loading.innerHTML = `<div class="hikaze-error">${t('mm.error.backendNotReady')}</div>`; return; }
        const iframe = document.createElement('iframe');
        // append language param for in-iframe i18n
        const hasQ = iframeSrc.includes('?');
        const sep = hasQ ? '&' : '?';
        iframe.src = `${iframeSrc}${sep}lang=${encodeURIComponent(currentLang())}`;
        iframe.onload = () => { if (loading) loading.style.display = 'none'; };
        iframe.onerror = () => { if (loading) loading.innerHTML = `<div class="hikaze-error">${t('mm.error.loadFail')}</div>`; };
        const content = overlay.querySelector('.hikaze-modal-content');
        if (content) content.appendChild(iframe);
    })();

    return overlay;
}

// Open model manager
function openModelManager() {
    try {
        console.log('[Hikaze] Opening model manager...');
        // Cache: keep a singleton window (not shared with selector)
        if (HikazeManager.modalWindow && document.body.contains(HikazeManager.modalWindow)) {
            HikazeManager.modalWindow.style.display = 'block';
            return;
        }
        HikazeManager.modalWindow = createOverlay({ title: t('mm.title.manager'), iframeSrc: 'http://127.0.0.1:8789/web/manager.html' });
    } catch (error) {
        console.error('[Hikaze] Error opening model manager:', error);
        alert(t('mm.error.openManager') + error.message);
    }
}

// Open model selector (selector mode)
function openModelSelector({ kind = 'checkpoint', requestId, selected = [], selectedItems = [] }) {
    const kindNorm = String(kind || '').toLowerCase();
    const isLora = kindNorm.startsWith('lora');
    const base = isLora ? 'http://127.0.0.1:8789/web/selector-lora.html' : 'http://127.0.0.1:8789/web/selector-checkpoint.html';
    const qs = new URLSearchParams({ requestId: requestId || '' });

    if (isLora && Array.isArray(selectedItems) && selectedItems.length) {
        // Use selectedItems with full strength info if available
        const selectedData = JSON.stringify(selectedItems);
        qs.set('selectedData', encodeURIComponent(selectedData));
    } else if (isLora && Array.isArray(selected) && selected.length) {
        // Fallback to old format for backward compatibility
        const keys = selected.map(normalizeLoraKey).filter(Boolean);
        if (keys.length) { qs.set('selected', keys.join(',')); }
    }

    const title = isLora ? t('mm.title.selectorLora') : t('mm.title.selectorGeneric');
    const overlay = createOverlay({ title, iframeSrc: `${base}?${qs.toString()}` });
    return overlay;
}

// Create menu button
function createMenuButton() {
    // Avoid duplicate creation
    if (HikazeManager.menuButton && document.body.contains(HikazeManager.menuButton)) {
        return true;
    }

    const button = document.createElement('button');
    button.className = 'hikaze-menu-button';
    button.textContent = t('mm.menu.button');
    button.title = t('mm.title.manager');
    // Force offset to align with styles
    button.style.top = '48px';
    button.style.right = '10px';

    button.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openModelManager();
    };

    document.body.appendChild(button);
    HikazeManager.menuButton = button;

    console.log('[Hikaze] Menu button created');
    return true;
}

// Try integrating into ComfyUI menu
function tryMenuIntegration() {
    HikazeManager.initAttempts++;

    // Prefer creating a fixed button (more reliable)
    if (createMenuButton()) {
        console.log('[Hikaze] Menu integration successful');
        return true;
    }

    // Retry if it fails and hasn't reached max attempts
    if (HikazeManager.initAttempts < HikazeManager.maxInitAttempts) {
        setTimeout(tryMenuIntegration, 1000);
        return false;
    }

    console.warn('[Hikaze] Menu integration failed after maximum attempts');
    return false;
}

// Inject a "Read" button for the node and ensure ckpt_name is editable
function enhanceCheckpointSelectorNode(node){
    try{
        if (!node || node.comfyClass !== 'HikazeCheckpointSelector') return;
        if (!Array.isArray(node.widgets)) return;
        const wPath = node.widgets.find(w=> w && (w.name === 'ckpt_name' || w.label === 'ckpt_name'));
        if (wPath){
            try { wPath.readonly = false; wPath.disabled = false; wPath.hidden = false; } catch(_) {}
            if (wPath.options) { try { wPath.options.readonly = false; } catch(_) {} }
        }
        const btn = node.addWidget && node.addWidget('button', 'read_selector', t('mm.btn.read'), () => {
            const requestId = 'sel_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
            const overlay = openModelSelector({ kind: 'checkpoint', requestId });
            HikazeManager.pending.set(requestId, { node, wPath, overlay });
        }, { serialize: false });
        if (btn) btn.label = 'read_selector';
        try { node.setDirtyCanvas(true, true); } catch(_) {}
    } catch(err){
        console.warn('[Hikaze] enhance node failed:', err);
    }
}

function enhancePowerLoraLoaderNode(node){
    try{
        if (!node || node.comfyClass !== 'HikazePowerLoraLoader') return;
        if (!Array.isArray(node.widgets)) node.widgets = [];

        // If there is a legacy read-only display, migrate it to grouped widgets
        try{
            const js = node.widgets.find(w=> w && (w.name === 'lora_items_json'));
            if (js && js.value){
                try{
                    const arr = JSON.parse(String(js.value||'[]'));
                    clearAllGroups(node);
                    // Remove read-only items
                    node.widgets = node.widgets.filter(w=>{
                        const n = w && (w.name || w.label) || '';
                        return !(typeof n === 'string' && (/^lora_item_\d+$/.test(n) || n === 'lora_items_json'));
                    });
                    let idx = 0;
                    for (const it of (Array.isArray(arr)? arr: [])){
                        const item = { key: normalizeLoraKey(it.key||it.value||''), label: String(it.label||it.value||it.key||''), sm: Number(it.sm)||1.0, sc: Number(it.sc)||1.0 };
                        ensureGroup(node, idx++, item);
                    }
                }catch(_){ /* ignore */ }
            }
        }catch(_){ }
        
        // If still no groups exist, create an empty one
        const groups = collectLoraGroups(node);
        if (!groups.size){ ensureGroup(node, 0, { key:'', label:'', sm:1.0, sc:1.0 }); }
        
        // Selection entry button
        const btn = node.addWidget && node.addWidget('button', 'choose_models', t('mm.btn.chooseModelEllipsis'), () => {
            const requestId = 'sel_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
            const selected = currentSelectedKeysForPreselect(node);
            const overlay = openModelSelector({ kind: 'lora', requestId, selected });
            HikazeManager.pending.set(requestId, { node, overlay, mode: 'replace' });
        }, { serialize: false });
        if (btn) btn.label = 'choose_models';
        try { node.setDirtyCanvas(true, true); } catch(_) {}
    } catch(err){
        console.warn('[Hikaze] enhance power lora node failed:', err);
    }
}

// ComfyUI extension registration
app.registerExtension({
    name: "hikaze.model.manager",

    async setup() {
        console.log('[Hikaze] Extension setup starting...');

        // Load styles and i18n
        loadStyles();
        await I18N.init();

        // Delay initialization to ensure DOM is fully loaded
        setTimeout(() => {
            // Keep only the top-right button
            tryMenuIntegration();
            // Listen for selection results and write back
            setupMessageListener();
        }, 2000);

        // Check server status
        setTimeout(async () => {
            const isReady = await checkServerStatus();
            console.log(isReady ? '[Hikaze] Backend server is ready' : '[Hikaze] Backend server not ready, will retry when opening manager');
        }, 3000);
    },

    async nodeCreated(node){
        // Enhance our custom nodes (guarded to avoid bubbling exceptions)
        try { enhanceCheckpointSelectorNode(node); } catch (err) { console.warn('[Hikaze] nodeCreated checkpoint enhance failed:', err); }
        try { enhancePowerLoraLoaderNode(node); } catch (err) { console.warn('[Hikaze] nodeCreated lora enhance failed:', err); }
    }
});

// Global function exports
window.hikazeOpenManager = openModelManager;
window.hikazeManager = {
    open: openModelManager,
    openSelector: (kind, requestId, selected)=> openModelSelector({kind, requestId, selected}),
    isServerStarted: () => HikazeManager.isServerStarted,
    checkServer: checkServerStatus
};

console.log('[Hikaze] Extension script loaded');

// Listen for selection results and write back to nodes
function setupMessageListener(){
    window.addEventListener('message', (ev)=>{
        const data = ev && ev.data;
        if (!data) return;
        // handle manager close request from iframe
        if (data.type === 'hikaze-mm-close'){
            const ov = HikazeManager.modalWindow;
            if (ov && typeof ov.__hikazeClose === 'function') ov.__hikazeClose();
            else if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
            HikazeManager.modalWindow = null;
            return;
        }
        // handle selector cancel (close overlay tied to requestId)
        if (data.type === 'hikaze-mm-cancel'){
            const requestId = data.requestId;
            if (requestId && HikazeManager.pending.has(requestId)){
                try{
                    const ctx = HikazeManager.pending.get(requestId);
                    const overlay = ctx && ctx.overlay;
                    if (overlay && typeof overlay.__hikazeClose === 'function') overlay.__hikazeClose();
                    else if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
                } finally {
                    HikazeManager.pending.delete(requestId);
                }
            }
            return;
        }
        if (data.type !== 'hikaze-mm-select') return;
        const { requestId, payload } = data;
        const ctx = HikazeManager.pending.get(requestId);
        if (!ctx) return;
        try{
            const { node, wName, wPath, overlay, mode } = ctx;
            if (payload && (payload.kind === 'lora' || payload.kind === 'loras') && Array.isArray(payload.items) && node && node.comfyClass === 'HikazePowerLoraLoader'){
                const opMode = (payload.mode === 'append' || mode === 'append') ? 'append' : 'replace';
                const incoming = (payload.items || []).map(it=>({ 
                    key: normalizeLoraKey(it && (it.value || it.label || '')), 
                    label: String((it && (it.label || it.value)) || ''), 
                    sm: (typeof it.sm==='number'? it.sm: 1.0), 
                    sc: (typeof it.sc==='number'? it.sc: 1.0) 
                })).filter(it=>it.key);

                if (opMode === 'replace') {
                    clearAllGroups(node);
                }

                // Find the next available index
                let idx = 0;
                if (opMode === 'append') {
                    // Find the highest existing index + 1
                    const existingGroups = collectLoraGroups(node);
                    if (existingGroups.size > 0) {
                        idx = Math.max(...existingGroups.keys()) + 1;
                    }
                }

                for (const it of incoming){
                    // Avoid adding duplicates if appending
                    if (opMode === 'append') {
                        const existing = currentSelectedKeysForPreselect(node);
                        if (existing.includes(normalizeLoraKey(it.key))) continue;
                    }
                    ensureGroup(node, idx++, it);
                }

                // If the list is empty after a replace operation, add a placeholder
                if (opMode === 'replace' && incoming.length === 0) {
                    ensureGroup(node, 0, { key:'', label:'None', sm:1.0, sc:1.0 });
                }

                try { node.setDirtyCanvas(true, true); } catch(_) {}
                try { app.graph.setDirtyCanvas(true, true); } catch(_) {}
                try { if (node.onResize) node.onResize(node.size); } catch(_) {}
                if (overlay && typeof overlay.__hikazeClose === 'function') overlay.__hikazeClose();
                else if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
                return;
            }
            const pathVal = payload && payload.value ? String(payload.value) : '';
            const nameVal = payload && (payload.label || payload.value) ? String(payload.label || payload.value) : '';
            if (wPath){
                try { wPath.value = pathVal; } catch(_) {}
                try { if (wPath.inputEl) wPath.inputEl.value = pathVal; } catch(_) {}
            }
            if (wName){
                try { wName.value = nameVal; } catch(_) {}
                try { if (wName.inputEl) wName.inputEl.value = nameVal; } catch(_) {}
                try {
                    if (wName.element && wName.element.tagName && wName.element.value !== undefined) {
                        wName.element.value = nameVal;
                    }
                } catch(_) {}
            }
            try { node.setDirtyCanvas(true, true); } catch(_) {}
            try { app.graph.setDirtyCanvas(true, true); } catch(_) {}
            try { if (node.onResize) node.onResize(node.size); } catch(_) {}
            if (overlay && typeof overlay.__hikazeClose === 'function') overlay.__hikazeClose();
            else if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        } finally {
            HikazeManager.pending.delete(requestId);
        }
    });
}
