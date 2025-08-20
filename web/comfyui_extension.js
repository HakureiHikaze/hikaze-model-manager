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

// Custom Lora Row Widget for HikazePowerLoraLoader
function HikazeLoraRowWidget(name){
    this.name = name;
    this.value = { key: '', label: 'None', sm: 1.0, sc: 1.0 }; // Default value

    this.draw = function(ctx, node, width, y, height) {
        const data = this.value;
        if (!data) return;

        const margin = 10;
        const rowHeight = height;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        const midY = y + rowHeight / 2;

        // Layout calculation
        const removeBtnWidth = 20;
        const strengthWidth = 45;
        const strengthLabelWidth = 35;
        const totalReservedWidth = (strengthLabelWidth + strengthWidth) * 2 + removeBtnWidth + margin * 4;
        const nameWidth = width - totalReservedWidth;

        let currentX = margin;

        // 1. Draw LoRA Name
        ctx.fillStyle = LiteGraph.WIDGET_TEXT_COLOR;
        const displayName = String(data.label || data.key || 'None');
        let truncatedName = displayName;
        if (ctx.measureText(displayName).width > nameWidth) {
            truncatedName = displayName.slice(0, 40) + '...';
            while (ctx.measureText(truncatedName).width > nameWidth && truncatedName.length > 4) {
                truncatedName = truncatedName.slice(0, -4) + '...';
            }
        }
        ctx.fillText(truncatedName, currentX, midY);
        currentX += nameWidth + margin;

        // 2. Draw Model Strength
        ctx.fillStyle = "#666"; // Label color
        ctx.fillText(t('mm.lora.model'), currentX, midY);
        currentX += strengthLabelWidth;
        ctx.fillStyle = LiteGraph.WIDGET_VALUE_COLOR;
        ctx.fillText(Number(data.sm).toFixed(2), currentX, midY);
        currentX += strengthWidth + margin;

        // 3. Draw Clip Strength
        ctx.fillStyle = "#666";
        ctx.fillText(t('mm.lora.clip'), currentX, midY);
        currentX += strengthLabelWidth;
        ctx.fillStyle = LiteGraph.WIDGET_VALUE_COLOR;
        ctx.fillText(Number(data.sc).toFixed(2), currentX, midY);
        currentX += strengthWidth + margin;

        // 4. Draw Remove Button
        const btnX = width - margin - removeBtnWidth;
        ctx.fillStyle = "#a00";
        ctx.fillRect(btnX, y + 4, removeBtnWidth, rowHeight - 8);
        ctx.fillStyle = "#fff";
        ctx.textAlign = "center";
        ctx.fillText("X", btnX + removeBtnWidth / 2, midY);
        ctx.textAlign = "left"; // Reset alignment
    };

    this.mouse = function(event, pos, node) {
        if (event.type !== 'mousedown') return false;

        const width = node.size[0];
        const margin = 10;
        const removeBtnWidth = 20;
        const btnX = width - margin - removeBtnWidth;
        const y = this.last_y;
        const height = LiteGraph.NODE_WIDGET_HEIGHT;

        if (pos[0] > btnX && pos[0] < btnX + removeBtnWidth && pos[1] > y && pos[1] < y + height) {
            // Find and remove this widget
            const index = node.widgets.findIndex(w => w === this);
            if (index !== -1) {
                node.widgets.splice(index, 1);
                // Also remove the corresponding value from the serialized data
                const propName = `lora_${index}`;
                if (!node.properties) node.properties = {};
                if (node.properties[propName]) {
                    delete node.properties[propName];
                }
                // Re-index subsequent widgets
                for (let i = index; i < node.widgets.length; i++) {
                    if (node.widgets[i].name && node.widgets[i].name.startsWith('lora_')) {
                        const oldName = node.widgets[i].name;
                        const newName = `lora_${i}`;
                        node.widgets[i].name = newName;
                        if (!node.properties) node.properties = {};
                        if (node.properties[oldName]) {
                            node.properties[newName] = node.properties[oldName];
                            delete node.properties[oldName];
                        }
                    }
                }
                node.setDirtyCanvas(true, true);
            }
            return true; // Event handled
        }
        return false;
    };

    this.serializeValue = (node, index) => {
        // Store a JSON-serialized copy to ensure backend receives a STRING-compatible value
        try{
            if (!node.properties) node.properties = {};
            node.properties[this.name] = JSON.stringify(this.value || {});
        }catch(_){
            if (!node.properties) node.properties = {};
            // Fallback: store shallow object if JSON fails
            node.properties[this.name] = this.value;
        }
    };
}


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
        // Filter both old format and new custom widget
        const re = /^lora_\d+(?:_(?:on|strength_model|strength_clip|remove))?$/;
        node.widgets = node.widgets.filter(w=>{
            const name = w && (w.name || w.label);
            if (!name) return true;
            const isOld = re.test(String(name));
            const isNew = String(name).startsWith('lora_') && w.constructor === HikazeLoraRowWidget;
            return !isOld && !isNew;
        });
    }catch(err){ console.warn('[Hikaze] clearAllGroups failed:', err); }
}

function ensureGroup(node, idx, item){
    // This function now adds a single custom widget per LoRA
    if (!Array.isArray(node.widgets)) node.widgets = [];
    const widgetName = `lora_${idx}`;

    // Check if a widget with this name already exists
    let existingWidget = node.widgets.find(w => w.name === widgetName);

    const widgetValue = {
        key: normalizeLoraKey(item.key || item.value || ''),
        label: String(item.label || item.value || item.key || 'None'),
        sm: Number(item.sm) || 1.0,
        sc: Number(item.sc) || 1.0
    };

    if (existingWidget) {
        // Update existing widget's value
        existingWidget.value = widgetValue;
    } else {
        // Add new custom widget
        const widget = new HikazeLoraRowWidget(widgetName);
        widget.value = widgetValue;
        if (!node.widgets) node.widgets = [];
        node.widgets.push(widget);
    }
}

function currentSelectedKeysForPreselect(node){
    const keys = [];
    if (!node.widgets) return keys;
    // Iterate over our custom widgets
    for(const w of node.widgets){
        if (w && w.name && w.name.startsWith('lora_') && w.value){
            const key = normalizeLoraKey(w.value.key);
            if (key) keys.push(key);
        }
    }
    return keys;
}

function currentSelectedItemsForPreselect(node){
    const items = [];
    if (!node.widgets) return items;
    // Iterate over our custom widgets and collect full item data including strengths
    for(const w of node.widgets){
        if (w && w.name && w.name.startsWith('lora_') && w.value){
            const key = normalizeLoraKey(w.value.key);
            if (key) {
                items.push({
                    key: key,
                    label: w.value.label || key,
                    sm: w.value.sm || 1.0,
                    sc: w.value.sc || 1.0
                });
            }
        }
    }
    return items;
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

        // Override the serialize method to convert custom widgets to inputs
        const originalSerialize = node.serialize;
        node.serialize = function() {
            const data = originalSerialize ? originalSerialize.call(this) : {};

            // Convert custom widgets to inputs format for backend
            if (!data.inputs) data.inputs = {};

            // Clear existing lora_* inputs to avoid conflicts
            for (const key in data.inputs) {
                if (key.startsWith('lora_')) {
                    delete data.inputs[key];
                }
            }

            // Convert custom widgets to backend-compatible inputs
            let loraIndex = 0;
            if (this.widgets) {
                for (const w of this.widgets) {
                    if (w && w.name && w.name.startsWith('lora_') && w.value && w.value.key) {
                        const key = w.value.key.trim();
                        if (key && key.toLowerCase() !== 'none') {
                            data.inputs[`lora_${loraIndex}`] = key;
                            data.inputs[`lora_${loraIndex}_on`] = true;
                            data.inputs[`lora_${loraIndex}_strength_model`] = Number(w.value.sm) || 1.0;
                            data.inputs[`lora_${loraIndex}_strength_clip`] = Number(w.value.sc) || 1.0;
                            loraIndex++;
                        }
                    }
                }
            }

            return data;
        };

        // Override configure to load from serialized data
        const originalConfigure = node.configure;
        node.configure = function(info) {
            if (originalConfigure) {
                originalConfigure.apply(this, arguments);
            }

            // Load from serialized inputs data
            if (info.inputs) {
                this.loadFromInputsData(info.inputs);
            }

            // Also handle legacy properties format
            if (this.widgets && this.properties) {
                for (const w of this.widgets) {
                    if (w.name && this.properties[w.name]) {
                        w.value = this.properties[w.name];
                    }
                }
            }
        };

        // Add method to load widget values from inputs data
        node.loadFromInputsData = function(inputs) {
            if (!inputs) return;

            // Clear existing widgets first
            clearAllGroups(this);

            // Group inputs by lora index
            const loraGroups = {};
            for (const [key, value] of Object.entries(inputs)) {
                const match = key.match(/^lora_(\d+)(?:_(on|strength_model|strength_clip))?$/);
                if (match) {
                    const idx = parseInt(match[1], 10);
                    const subkey = match[2] || 'name';
                    if (!loraGroups[idx]) loraGroups[idx] = {};
                    loraGroups[idx][subkey] = value;
                }
            }

            // Create widgets from grouped data
            Object.keys(loraGroups).sort((a, b) => parseInt(a) - parseInt(b)).forEach((idx, widgetIdx) => {
                const group = loraGroups[idx];
                if (group.name && group.on !== false) {
                    ensureGroup(this, widgetIdx, {
                        key: group.name,
                        label: group.name,
                        sm: Number(group.strength_model) || 1.0,
                        sc: Number(group.strength_clip) || 1.0
                    });
                }
            });

            // Add empty placeholder if no widgets
            if (!this.widgets.some(w => w.name && w.name.startsWith('lora_'))) {
                ensureGroup(this, 0, { key:'', label:'None', sm:1.0, sc:1.0 });
            }
        };

        // Monkey-patch onExecute to ensure inputs are updated before execution
        const originalOnExecute = node.onExecute;
        node.onExecute = function(...args) {
            // Update inputs before execution
            this.updateInputsFromWidgets();
            if (originalOnExecute) {
                return originalOnExecute.apply(this, args);
            }
        };

        // Add method to update inputs from current widget state
        node.updateInputsFromWidgets = function() {
            if (!this.inputs) this.inputs = {};

            // Clear existing lora_* inputs
            for (const key in this.inputs) {
                if (key.startsWith('lora_')) {
                    delete this.inputs[key];
                }
            }

            // Convert current widget state to inputs
            let loraIndex = 0;
            if (this.widgets) {
                for (const w of this.widgets) {
                    if (w && w.name && w.name.startsWith('lora_') && w.value && w.value.key) {
                        const key = w.value.key.trim();
                        if (key && key.toLowerCase() !== 'none') {
                            this.inputs[`lora_${loraIndex}`] = key;
                            this.inputs[`lora_${loraIndex}_on`] = true;
                            this.inputs[`lora_${loraIndex}_strength_model`] = Number(w.value.sm) || 1.0;
                            this.inputs[`lora_${loraIndex}_strength_clip`] = Number(w.value.sc) || 1.0;
                            loraIndex++;
                        }
                    }
                }
            }
        };

        // Override getInputData to provide runtime parameters to ComfyUI
        const originalGetInputData = node.getInputData;
        node.getInputData = function(slot) {
            // Update inputs from widgets before ComfyUI queries for data
            this.updateInputsFromWidgets();
            if (originalGetInputData) {
                return originalGetInputData.call(this, slot);
            }
            return this.inputs && this.inputs[slot] !== undefined ? this.inputs[slot] : undefined;
        };

        // Override onGetInputs to expose our dynamic inputs to ComfyUI
        const originalOnGetInputs = node.onGetInputs;
        node.onGetInputs = function() {
            this.updateInputsFromWidgets();
            const baseInputs = originalOnGetInputs ? originalOnGetInputs.call(this) : [];

            // Add our LoRA parameters as inputs
            const loraInputs = [];
            if (this.widgets) {
                let loraIndex = 0;
                for (const w of this.widgets) {
                    if (w && w.name && w.name.startsWith('lora_') && w.value && w.value.key) {
                        const key = w.value.key.trim();
                        if (key && key.toLowerCase() !== 'none') {
                            loraInputs.push([`lora_${loraIndex}`, "*"]);
                            loraInputs.push([`lora_${loraIndex}_on`, "*"]);
                            loraInputs.push([`lora_${loraIndex}_strength_model`, "*"]);
                            loraInputs.push([`lora_${loraIndex}_strength_clip`, "*"]);
                            loraIndex++;
                        }
                    }
                }
            }

            return baseInputs.concat(loraInputs);
        };

        // Override computeSize to ensure proper node sizing
        const originalComputeSize = node.computeSize;
        node.computeSize = function() {
            this.updateInputsFromWidgets();
            if (originalComputeSize) {
                return originalComputeSize.call(this);
            }
        };

        if (!Array.isArray(node.widgets)) node.widgets = [];

        // Migration from old format (multiple widgets per lora)
        const oldGroups = collectLoraGroups(node);
        if (oldGroups.size > 0) {
            const itemsToMigrate = [];
            for (const g of oldGroups.values()) {
                itemsToMigrate.push({
                    key: g.nameVal,
                    label: g.nameVal,
                    sm: g.smWidget ? g.smWidget.value : 1.0,
                    sc: g.scWidget ? g.scWidget.value : 1.0,
                });
            }
            clearAllGroups(node); // Clear old widgets
            itemsToMigrate.forEach((item, idx) => ensureGroup(node, idx, item));
        }

        // If still no groups exist after potential migration, create an empty one for display
        const hasLoraWidget = node.widgets.some(w => w.name && w.name.startsWith('lora_'));
        if (!hasLoraWidget){
             ensureGroup(node, 0, { key:'', label:'None', sm:1.0, sc:1.0 });
        }

        // Selection entry button
        const hasButton = node.widgets.some(w => w.name === 'choose_models');
        if (!hasButton) {
            node.addWidget('button', 'choose_models', t('mm.btn.chooseModelEllipsis'), () => {
                const requestId = 'sel_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
                const selectedItems = currentSelectedItemsForPreselect(node);
                const overlay = openModelSelector({ kind: 'lora', requestId, selectedItems });
                HikazeManager.pending.set(requestId, { node, overlay, mode: 'replace' });
            }, { serialize: false });
        }

        // Override onPropertyChanged to trigger updates
        const originalOnPropertyChanged = node.onPropertyChanged;
        node.onPropertyChanged = function(name, value) {
            if (originalOnPropertyChanged) {
                originalOnPropertyChanged.call(this, name, value);
            }
            this.updateInputsFromWidgets();
        };

        // Override getTitle to show current LoRA count
        const originalGetTitle = node.getTitle;
        node.getTitle = function() {
            const baseTitle = originalGetTitle ? originalGetTitle.call(this) : this.title;
            const loraCount = this.widgets ? this.widgets.filter(w => w && w.name && w.name.startsWith('lora_') && w.value && w.value.key && w.value.key.toLowerCase() !== 'none').length : 0;
            return loraCount > 0 ? `${baseTitle} (${loraCount})` : baseTitle;
        };

        // Most importantly: Override getInputsInfo to declare our inputs to ComfyUI
        node.getInputsInfo = function() {
            this.updateInputsFromWidgets();
            const info = [];

            // Add base inputs
            info.push({ name: "model", type: "MODEL", optional: true });
            info.push({ name: "clip", type: "CLIP", optional: true });

            // Add LoRA inputs dynamically
            if (this.widgets) {
                let loraIndex = 0;
                for (const w of this.widgets) {
                    if (w && w.name && w.name.startsWith('lora_') && w.value && w.value.key) {
                        const key = w.value.key.trim();
                        if (key && key.toLowerCase() !== 'none') {
                            info.push({ name: `lora_${loraIndex}`, type: "*", optional: true });
                            info.push({ name: `lora_${loraIndex}_on`, type: "*", optional: true });
                            info.push({ name: `lora_${loraIndex}_strength_model`, type: "*", optional: true });
                            info.push({ name: `lora_${loraIndex}_strength_clip`, type: "*", optional: true });
                            loraIndex++;
                        }
                    }
                }
            }

            return info;
        };

        // Override onDrawBackground to show debug info
        const originalOnDrawBackground = node.onDrawBackground;
        node.onDrawBackground = function(ctx) {
            if (originalOnDrawBackground) {
                originalOnDrawBackground.call(this, ctx);
            }

            // Debug: show current input count
            if (this.inputs) {
                const loraInputs = Object.keys(this.inputs).filter(k => k.startsWith('lora_')).length;
                if (loraInputs > 0) {
                    ctx.fillStyle = "#0a0";
                    ctx.font = "10px Arial";
                    ctx.fillText(`Inputs: ${loraInputs}`, 10, this.size[1] - 10);
                }
            }
        };

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
                const incoming = (payload.items || []).map(it=>({ key: normalizeLoraKey(it && (it.value || it.label || '')), label: String((it && (it.label || it.value)) || ''), sm: (typeof it.sm==='number'? it.sm: 1.0), sc: (typeof it.sc==='number'? it.sc: 1.0) })).filter(it=>it.key);

                if (opMode === 'replace') {
                    clearAllGroups(node);
                }

                let idx = node.widgets.filter(w => w.name && w.name.startsWith('lora_')).length;

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
