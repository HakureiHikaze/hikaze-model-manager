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

// Universal Isolated Container Widget - bypasses ComfyUI's default rendering
class HikazeIsolatedWidget {
    constructor(name, options = {}) {
        this.name = name;
        this.type = "hikaze_isolated";
        this.value = options.value || null;
        this.options = options;
        this.y = 0;
        this.height = options.height || LiteGraph.NODE_WIDGET_HEIGHT;
        this.last_y = 0;
        this.mouse_pressed = false;
    }

    draw(ctx, node, width, y, height) {
        this.last_y = y;
        this.height = height;
        
        ctx.fillStyle = "#21252b";
        ctx.fillRect(0, y, width, height);
        
        ctx.strokeStyle = "#404040";
        ctx.lineWidth = 1;
        ctx.strokeRect(0, y, width, height);
        
        if (this.customDraw) {
            this.customDraw(ctx, node, width, y, height);
        }
    }

    mouse(event, pos, node) {
        if (this.customMouse) {
            return this.customMouse(event, pos, node);
        }
        return false;
    }

    computeSize(width) {
        return [width, this.height];
    }
}

// 新：画布绘制面板（替代之前 DOM overlay 实现）
class HikazeLoraPanelWidget extends HikazeIsolatedWidget {
    constructor(name, options = {}){
        super(name, { height: 140 });
        this.type = 'hikaze_lora_panel';
        this.itemsProvider = options.itemsProvider; // ()=>array
        this.maxHeight = options.maxHeight || 260;
        this.rowHeight = 22;
        this.headerHeight = 24;
        this.padding = 6;
    }
    ensureHeight(){
        const items = (this.itemsProvider && this.itemsProvider()) || [];
        const h = this.headerHeight + items.length * this.rowHeight + this.padding*2;
        const target = Math.min(this.maxHeight, Math.max( this.headerHeight + this.rowHeight + this.padding*2, h));
        if (Math.abs(target - this.height) > 0.5){
            this.height = target;
        }
    }
    customDraw(ctx, node, width, y, height){
        this.ensureHeight();
        const items = (this.itemsProvider && this.itemsProvider()) || [];
        // 背景已经由父类填充，这里再加内层
        const px = 4; const py = y + 4; const innerW = width - 8; const innerH = this.height - 8;
        ctx.fillStyle = '#1c1f23';
        ctx.fillRect(px, py, innerW, innerH);
        ctx.strokeStyle = '#30363d';
        ctx.strokeRect(px, py, innerW, innerH);
        // Header
        ctx.save();
        ctx.beginPath(); ctx.rect(px, py, innerW, innerH); ctx.clip();
        ctx.fillStyle = '#262b30';
        ctx.fillRect(px, py, innerW, this.headerHeight);
        ctx.fillStyle = '#9aa0a6';
        ctx.textBaseline = 'middle';
        ctx.font = '12px sans-serif';
        const colSeqW = 36; const colModelW = 70; const colClipW = 70; // fixed
        const colNameW = innerW - colSeqW - colModelW - colClipW - 16; // paddings
        let tx = px + 8; const hy = py + this.headerHeight/2;
        ctx.fillText('#', tx, hy); tx += colSeqW;
        ctx.fillText('LoRA', tx, hy); tx += colNameW;
        ctx.fillText('Model', tx, hy); tx += colModelW;
        ctx.fillText('CLIP', tx, hy);
        // 分隔线
        ctx.strokeStyle = '#343a40';
        ctx.beginPath(); ctx.moveTo(px, py + this.headerHeight + 0.5); ctx.lineTo(px+innerW, py + this.headerHeight + 0.5); ctx.stroke();
        // Rows
        const startY = py + this.headerHeight;
        items.forEach((it, idx)=>{
            const ry = startY + idx * this.rowHeight;
            if (ry + this.rowHeight > py + innerH) return; // overflow hidden
            // zebra
            if (idx % 2 === 0){ ctx.fillStyle = '#21262c'; ctx.fillRect(px+1, ry, innerW-2, this.rowHeight); }
            const mid = ry + this.rowHeight/2;
            let cx = px + 8;
            ctx.fillStyle = '#adb4ba';
            ctx.fillText(String(idx+1), cx, mid); cx += colSeqW;
            const name = String(it.label || it.key || '');
            // truncate name
            ctx.save();
            ctx.beginPath(); ctx.rect(cx, ry, colNameW-4, this.rowHeight); ctx.clip();
            ctx.fillStyle = '#d1d5d9';
            ctx.fillText(name, cx, mid);
            ctx.restore();
            cx += colNameW;
            ctx.fillStyle = '#7ee787';
            ctx.fillText((Number(it.sm)||1).toFixed(2), cx, mid); cx += colModelW;
            ctx.fillStyle = '#7ee787';
            ctx.fillText((Number(it.sc)||1).toFixed(2), cx, mid);
        });
        ctx.restore();
        // Scroll 提示（当前未实现滚动，未来可加）
        if (this.headerHeight + items.length * this.rowHeight + this.padding*2 > this.maxHeight){
            ctx.fillStyle = 'rgba(255,255,255,0.25)';
            ctx.font = '10px sans-serif';
            ctx.textBaseline = 'bottom';
            ctx.fillText('More...', px + innerW - 44, py + innerH - 4);
        }
    }
}

// Custom LoRA Row Widget that renders as table format
class HikazeLoraRowWidget extends HikazeIsolatedWidget {
    constructor(name, value = null) {
        super(name, { height: 30 });
        this.value = value || { key: '', label: 'None', sm: 1.0, sc: 1.0, on: true };
        this.customDraw = this.drawLoraRow.bind(this);
        this.customMouse = this.mouseLoraRow.bind(this);
    }

    drawLoraRow(ctx, node, width, y, height) {
        const data = this.value;
        if (!data) return;

        const margin = 8;
        const rowHeight = height;
        const midY = y + rowHeight / 2;
        
        // Layout calculation - table columns
        const toggleWidth = 20;
        const removeBtnWidth = 20;
        const strengthWidth = 50;
        const strengthLabelWidth = 10; // Reduced for compactness
        const totalReservedWidth = toggleWidth + (strengthWidth + strengthLabelWidth) * 2 + removeBtnWidth + margin * 5;
        const nameWidth = Math.max(100, width - totalReservedWidth);

        let currentX = margin;

        // Column 1: LoRA Name (read-only text)
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillStyle = data.on ? "#e6edf3" : "#8b949e";
        const displayName = String(data.label || data.key || 'None');
        let truncatedName = displayName;
        
        // Truncate if too long
        const maxNameWidth = nameWidth - margin;
        while (ctx.measureText(truncatedName).width > maxNameWidth && truncatedName.length > 4) {
            truncatedName = truncatedName.slice(0, -4) + '...';
        }
        ctx.fillText(truncatedName, currentX, midY);
        currentX += nameWidth;

        // Column 2: Model Strength (read-only text)
        ctx.fillStyle = data.on ? "#58a6ff" : "#6e7681";
        ctx.fillText("M:", currentX, midY);
        currentX += strengthLabelWidth;
        ctx.fillStyle = data.on ? "#7ee787" : "#6e7681";
        ctx.fillText(Number(data.sm).toFixed(2), currentX, midY);
        currentX += strengthWidth;

        // Column 3: Clip Strength (read-only text)  
        ctx.fillStyle = data.on ? "#58a6ff" : "#6e7681";
        ctx.fillText("C:", currentX, midY);
        currentX += strengthLabelWidth;
        ctx.fillStyle = data.on ? "#7ee787" : "#6e7681";
        ctx.fillText(Number(data.sc).toFixed(2), currentX, midY);
        currentX += strengthWidth;

        // Column 4: Toggle Switch (interactive)
        const toggleX = currentX;
        const toggleY = y + (height - toggleWidth) / 2;
        
        // Draw toggle background
        ctx.fillStyle = data.on ? "#2ea043" : "#6e7681";
        ctx.fillRect(toggleX, toggleY, toggleWidth, toggleWidth);
        
        // Draw toggle border
        ctx.strokeStyle = data.on ? "#46954a" : "#8b949e";
        ctx.lineWidth = 1;
        ctx.strokeRect(toggleX, toggleY, toggleWidth, toggleWidth);
        
        // Toggle indicator
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        if (data.on) {
            ctx.fillText("✓", toggleX + toggleWidth/2, midY);
        } else {
            ctx.fillText("⭘", toggleX + toggleWidth/2, midY);
        }
        ctx.textAlign = "left"; // Reset alignment
        currentX += toggleWidth + margin;

        // Column 5: Remove Button (interactive)
        const btnX = currentX;
        const btnY = y + (height - removeBtnWidth) / 2;
        
        // Draw remove button background
        ctx.fillStyle = "#da3633";
        ctx.fillRect(btnX, btnY, removeBtnWidth, removeBtnWidth);
        
        // Draw remove button border
        ctx.strokeStyle = "#f85149";
        ctx.lineWidth = 1;
        ctx.strokeRect(btnX, btnY, removeBtnWidth, removeBtnWidth);
        
        // Draw remove button text
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.fillText("×", btnX + removeBtnWidth/2, midY);
        ctx.textAlign = "left"; // Reset alignment
        
        // Store hit areas for mouse handling
        this.hitAreas = {
            toggle: { x: toggleX, y: toggleY, width: toggleWidth, height: toggleWidth },
            remove: { x: btnX, y: btnY, width: removeBtnWidth, height: removeBtnWidth }
        };
    }

    mouseLoraRow(event, pos, node) {
        if (event.type !== 'mousedown') return false;
        if (!this.hitAreas) return false;

        const relativeY = pos[1] - this.last_y;
        
        // Check toggle button
        const toggle = this.hitAreas.toggle;
        if (pos[0] >= toggle.x && pos[0] <= toggle.x + toggle.width &&
            relativeY >= 0 && relativeY <= toggle.height) {
            this.value.on = !this.value.on;
            try { node.setDirtyCanvas(true, true); } catch(_) {}
            return true;
        }

        // Check remove button
        const remove = this.hitAreas.remove;
        if (pos[0] >= remove.x && pos[0] <= remove.x + remove.width &&
            relativeY >= 0 && relativeY <= remove.height) {
            this.removeFromNode(node);
            return true;
        }

        return false;
    }

    removeFromNode(node) {
        if (!node.widgets) return;
        
        const index = node.widgets.indexOf(this);
        if (index !== -1) {
            node.widgets.splice(index, 1);
            
            // Re-index subsequent lora widgets
            for (let i = index; i < node.widgets.length; i++) {
                const widget = node.widgets[i];
                if (widget && widget.name && widget.name.startsWith('lora_')) {
                    const oldName = widget.name;
                    const newName = `lora_${i}`;
                    widget.name = newName;
                }
            }
            
            try { node.setDirtyCanvas(true, true); } catch(_) {}
            try { app.graph.setDirtyCanvas(true, true); } catch(_) {}
            try { if (node.onResize) node.onResize(node.size); } catch(_) {}
        }
    }

    serializeValue() {
        // Return a serialized copy for backend compatibility
        try {
            return JSON.stringify(this.value || {});
        } catch(_) {
            return this.value;
        }
    }
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
        const re = /^lora_\d+(?:_(?:on|strength_model|strength_clip|remove))?$/;
        node.widgets = node.widgets.filter(w=>{
            const name = w && (w.name || w.label);
            if (!name) return true;
            // 去除旧的行部件和新的面板部件（面板后面重新创建）
            const isOld = re.test(String(name));
            const isNew = w instanceof HikazeLoraRowWidget || w instanceof HikazeLoraPanelWidget;
            return !isOld && !isNew;
        });
    }catch(err){ console.warn('[Hikaze] clearAllGroups failed:', err); }
}

function ensureGroup(node, idx, item){
    if (!Array.isArray(node.widgets)) node.widgets = [];
    
    const widgetName = `lora_${idx}`;
    
    // Check if widget with this name already exists
    let existingWidget = node.widgets.find(w => w.name === widgetName && w instanceof HikazeLoraRowWidget);
    
    const widgetValue = {
        key: normalizeLoraKey(item.key || item.value || ''),
        label: String(item.label || item.value || item.key || 'None'),
        sm: Number(item.sm) || 1.0,
        sc: Number(item.sc) || 1.0,
        on: item.on !== undefined ? Boolean(item.on) : true
    };

    if (existingWidget) {
        // Update existing widget's value
        existingWidget.value = widgetValue;
    } else {
        // Remove any legacy widgets for this index first
        removeGroup(node, idx);
        
        // Add new custom isolated widget
        const widget = new HikazeLoraRowWidget(widgetName, widgetValue);
        node.widgets.push(widget);
    }
}

function currentSelectedKeysForPreselect(node){
    const keys = [];
    if (!node.widgets) return keys;
    
    // Look for both old format and new custom widgets
    for(const w of node.widgets){
        if (w instanceof HikazeLoraRowWidget && w.value && w.value.key){
            const key = normalizeLoraKey(w.value.key);
            if (key) keys.push(key);
        } else if (w && w.name && w.name.match(/^lora_\d+$/) && w.value){
            // Legacy widget support
            const key = normalizeLoraKey(w.value);
            if (key) keys.push(key);
        }
    }
    return keys;
}

function currentSelectedItemsForPreselect(node){
    const items = [];
    if (!node) return items;
    if (Array.isArray(node.loraItems) && node.loraItems.length){
        node.loraItems.forEach(it=>{ if (it && it.key) items.push({...it}); });
        return items;
    }
    if (!node.widgets) return items;
    for(const w of node.widgets){
        if (w instanceof HikazeLoraRowWidget && w.value && w.value.key){
            const key = normalizeLoraKey(w.value.key);
            if (key) items.push({ key, label: w.value.label || key, sm: w.value.sm||1, sc: w.value.sc||1, on: w.value.on!==false });
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

function syncHiddenLoraWidgets(node){
    try{
        if (!node) return;
        if (!Array.isArray(node.widgets)) node.widgets = [];
        // 保留：panel, choose button, 其它非 lora_*；移除旧 lora_* 隐藏项
        node.widgets = node.widgets.filter(w=>{
            if (!w) return false;
            if (w instanceof HikazeLoraPanelWidget) return true;
            const n = w.name || w.label;
            if (n === 'choose_models') return true;
            if (/^lora_\d+(?:(_on|_strength_model|_strength_clip))?$/.test(String(n))) return false;
            return true;
        });
        const panel = node.widgets.find(w=> w instanceof HikazeLoraPanelWidget);
        // 插入隐藏widgets 紧跟 panel 之后（若存在）
        let insertIndex = panel ? (node.widgets.indexOf(panel)+1) : node.widgets.length;
        const list = Array.isArray(node.loraItems) ? node.loraItems : [];
        let i = 0;
        for (const it of list){
            const key = (it && it.key) ? String(it.key).trim() : '';
            if (!key || key.toLowerCase()==='none') { i++; continue; }
            const base = `lora_${i}`;
            const mkHidden = (w)=>{ if(!w) return; w.hidden = true; w.serialize = true; w.computeSize = ()=>[0,0]; w.draw = ()=>{}; };
            const nameW = { name: base, type:'text', value: key };
            const onW = { name: base+'_on', type:'number', value: it.on===false?0:1 };
            const smW = { name: base+'_strength_model', type:'number', value: Number(it.sm)||1 };
            const scW = { name: base+'_strength_clip', type:'number', value: Number(it.sc)||1 };
            mkHidden(nameW); mkHidden(onW); mkHidden(smW); mkHidden(scW);
            // 直接 splice 注入，保持顺序
            node.widgets.splice(insertIndex, 0, nameW, onW, smW, scW);
            insertIndex += 4;
            i++;
        }
    }catch(err){ console.warn('[Hikaze] syncHiddenLoraWidgets failed:', err); }
}

function enhancePowerLoraLoaderNode(node){
    try{
        if (!node || node.comfyClass !== 'HikazePowerLoraLoader') return;
        if (!Array.isArray(node.widgets)) node.widgets = [];
        // 迁移旧数据
        const legacyGroups = collectLoraGroups(node);
        const migrate = [];
        if (legacyGroups.size){
            for (const g of legacyGroups.values()) migrate.push({ key: normalizeLoraKey(g.nameVal||''), label: g.nameVal||'', sm: g.smWidget?g.smWidget.value:1, sc: g.scWidget?g.scWidget.value:1, on: g.onWidget?g.onWidget.value:true });
        }
        try {
            const js = node.widgets.find(w=> w && (w.name === 'lora_items_json'));
            if (js && js.value){
                try { const arr = JSON.parse(String(js.value||'[]')); for (const it of (Array.isArray(arr)?arr:[])){ const key=normalizeLoraKey(it.key||it.value||''); if(!key) continue; migrate.push({ key, label: it.label||it.value||it.key||'', sm:Number(it.sm)||1, sc:Number(it.sc)||1, on: it.on!==false }); } }catch(_){ }
            }
        }catch(_){ }
        clearAllGroups(node);
        node.loraItems = migrate.length? migrate: [{ key:'', label:'None', sm:1, sc:1, on:true }];
        // 添加面板部件
        let panel = node.widgets.find(w=> w instanceof HikazeLoraPanelWidget);
        if (!panel){
            panel = new HikazeLoraPanelWidget('lora_panel', { itemsProvider: ()=> node.loraItems });
            node.widgets.push(panel);
        }
        node.updateLoraPanel = ()=>{ if (panel){ panel.ensureHeight(); syncHiddenLoraWidgets(node); try { node.setDirtyCanvas(true,true); }catch(_){} try { if(node.onResize) node.onResize(node.size); }catch(_){} } };
        node.updateLoraPanel();
        // 序列化覆盖
        const originalSerialize = node.serialize;
        node.serialize = function(){
            const data = originalSerialize ? originalSerialize.call(this) : {};
            if (!data.inputs) data.inputs = {};
            for (const k of Object.keys(data.inputs)) if (k.startsWith('lora_')) delete data.inputs[k];
            let idx=0; for (const it of (this.loraItems||[])){ const key=String(it.key||'').trim(); if(!key || key==='none') continue; data.inputs[`lora_${idx}`]=key; data.inputs[`lora_${idx}_on`]= (it.on===false?0:1); data.inputs[`lora_${idx}_strength_model`]=Number(it.sm)||1; data.inputs[`lora_${idx}_strength_clip`]=Number(it.sc)||1; idx++; }
            return data;
        };
        const originalConfigure = node.configure;
        node.configure = function(info){ if (originalConfigure) originalConfigure.apply(this, arguments); if (info && info.inputs){ const groups={}; for (const [k,v] of Object.entries(info.inputs)){ const m=k.match(/^lora_(\d+)(?:_(on|strength_model|strength_clip))?$/); if(!m) continue; const i=parseInt(m[1],10); if(!groups[i]) groups[i]={sm:1,sc:1,on:true}; const sub=m[2]; if(!sub){ groups[i].key=v; groups[i].label=v; } else if(sub==='strength_model'){ groups[i].sm=Number(v)||1;} else if(sub==='strength_clip'){ groups[i].sc=Number(v)||1;} else if(sub==='on'){ groups[i].on= !!v && v!==0 && v!=='0'; } } this.loraItems=Object.keys(groups).sort((a,b)=>a-b).map(i=>groups[i]); if(!this.loraItems.length) this.loraItems=[{key:'',label:'None',sm:1,sc:1,on:true}]; this.updateLoraPanel&&this.updateLoraPanel(); } };
        const originalComputeSize = node.computeSize;
        node.computeSize = function(){ const base = originalComputeSize ? originalComputeSize.call(this) : [220,120]; const pnl = this.widgets.find(w=> w instanceof HikazeLoraPanelWidget); if (pnl){ base[0] = Math.max(base[0], 380); } return base; };
        // 选择按钮
        if (!node.widgets.some(w=> w.name==='choose_models')){
            const btn = node.addWidget && node.addWidget('button','choose_models', t('mm.btn.chooseModelEllipsis'), ()=>{ const requestId='sel_'+Date.now().toString(36)+Math.random().toString(36).slice(2,8); const selectedItems=currentSelectedItemsForPreselect(node); const overlay=openModelSelector({kind:'lora', requestId, selectedItems}); HikazeManager.pending.set(requestId,{ node, overlay, mode:'replace'}); }, { serialize:false });
            if (btn) btn.label='choose_models';
        }
        try { node.setDirtyCanvas(true,true); }catch(_){ }
    }catch(err){ console.warn('[Hikaze] enhance power lora node failed:', err); }
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
    window.addEventListener('message', (ev)=>{ const data = ev && ev.data; if(!data) return; if(data.type==='hikaze-mm-close'){ const ov=HikazeManager.modalWindow; if(ov && typeof ov.__hikazeClose==='function') ov.__hikazeClose(); else if(ov&&ov.parentNode) ov.parentNode.removeChild(ov); HikazeManager.modalWindow=null; return; }
        if(data.type==='hikaze-mm-cancel'){ const requestId=data.requestId; if(requestId && HikazeManager.pending.has(requestId)){ try{ const ctx=HikazeManager.pending.get(requestId); const overlay=ctx&&ctx.overlay; if(overlay && typeof overlay.__hikazeClose==='function') overlay.__hikazeClose(); else if(overlay&&overlay.parentNode) overlay.parentNode.removeChild(overlay);} finally { HikazeManager.pending.delete(requestId);} } return; }
        if(data.type!=='hikaze-mm-select') return; const { requestId, payload } = data; const ctx = HikazeManager.pending.get(requestId); if(!ctx) return; try{ const { node, wName, wPath, overlay, mode } = ctx; if(payload && (payload.kind==='lora'||payload.kind==='loras') && Array.isArray(payload.items) && node && node.comfyClass==='HikazePowerLoraLoader'){ const opMode=(payload.mode==='append'||mode==='append')?'append':'replace'; const incoming=(payload.items||[]).map(it=>({ key:normalizeLoraKey(it && (it.value||it.label||'')), label:String((it && (it.label||it.value))||''), sm:(typeof it.sm==='number'?it.sm:1), sc:(typeof it.sc==='number'?it.sc:1), on:true })).filter(it=>it.key); if(opMode==='replace') node.loraItems=[]; if(!Array.isArray(node.loraItems)) node.loraItems=[]; const existing=new Set(node.loraItems.map(i=>i.key)); for(const it of incoming){ if(opMode==='append' && existing.has(it.key)) continue; node.loraItems.push(it);} if(!node.loraItems.length) node.loraItems=[{key:'',label:'None',sm:1,sc:1,on:true}]; node.updateLoraPanel && node.updateLoraPanel(); syncHiddenLoraWidgets(node); try { node.setDirtyCanvas(true,true);}catch(_){} try { app.graph.setDirtyCanvas(true,true);}catch(_){} try { if(node.onResize) node.onResize(node.size);}catch(_){} if(overlay && typeof overlay.__hikazeClose==='function') overlay.__hikazeClose(); else if(overlay&&overlay.parentNode) overlay.parentNode.removeChild(overlay); return; }
        const pathVal = payload && payload.value ? String(payload.value):''; const nameVal = payload && (payload.label||payload.value)? String(payload.label||payload.value):''; if(wPath){ try { wPath.value=pathVal;}catch(_){} try { if(wPath.inputEl) wPath.inputEl.value=pathVal;}catch(_){} } if(wName){ try { wName.value=nameVal;}catch(_){} try { if(wName.inputEl) wName.inputEl.value=nameVal;}catch(_){} }
        try { node.setDirtyCanvas(true,true);}catch(_){} try { app.graph.setDirtyCanvas(true,true);}catch(_){} if(overlay && typeof overlay.__hikazeClose==='function') overlay.__hikazeClose(); else if(overlay&&overlay.parentNode) overlay.parentNode.removeChild(overlay);
    } finally { HikazeManager.pending.delete(requestId); }
    });
}
