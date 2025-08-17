// ComfyUI 菜单扩展 - Hikaze Model Manager

import { app } from "../../scripts/app.js";

// 全局状态管理
const HikazeManager = {
    modalWindow: null,
    isServerStarted: false,
    stylesLoaded: false,
    menuButton: null,
    initAttempts: 0,
    maxInitAttempts: 30,
    pending: new Map(), // requestId -> { node, widget, overlay }
};

// 内联样式 - 避免外部CSS加载问题
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
.hikaze-modal-window {
    position: fixed !important; /* 固定定位，避免 flex 居中影响拖拽 */
    background: #2a2a2a !important;
    border-radius: 8px !important;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5) !important;
    border: 1px solid #555 !important;
    overflow: hidden !important;
    min-width: 400px !important;
    min-height: 300px !important;
    max-width: 95vw !important;
    max-height: 95vh !important;
    display: flex !important;
    flex-direction: column !important;
}
.hikaze-modal-header {
    background: linear-gradient(135deg, #404040, #2a2a2a) !important;
    color: #ffffff !important;
    padding: 10px 14px !important;
    display: flex !important;
    justify-content: space-between !important;
    align-items: center !important;
    cursor: move !important;
    user-select: none !important;
    border-bottom: 1px solid #555 !important;
    font-size: 14px !important;
    font-weight: 500 !important;
}
.hikaze-modal-header h3 { margin: 0 !important; font-size: 14px !important; color: #ffffff !important; }
.hikaze-modal-controls { display: flex !important; gap: 6px !important; }
.hikaze-modal-controls button { width: 28px !important; height: 28px !important; border: none !important; background: rgba(255,255,255,0.1) !important; color: #fff !important; border-radius: 4px !important; cursor: pointer !important; }
.hikaze-modal-close:hover { background: #ff4444 !important; }
.hikaze-modal-content { flex: 1 !important; position: relative !important; overflow: hidden !important; background: #2a2a2a !important; }
.hikaze-loading { display:flex !important; align-items:center !important; justify-content:center !important; height:100% !important; color:#fff !important; }
.hikaze-spinner { width: 32px !important; height: 32px !important; border: 3px solid rgba(255,255,255,0.1) !important; border-top:3px solid #4CAF50 !important; border-radius:50% !important; animation: hikaze-spin 1s linear infinite !important; }
@keyframes hikaze-spin { 0%{transform:rotate(0)} 100%{transform:rotate(360deg)} }
.hikaze-modal-content iframe { position:absolute !important; inset:0 !important; width:100% !important; height:100% !important; border:none !important; background:#2a2a2a !important; }
.hikaze-menu-button { position: fixed !important; top: 48px !important; right: 10px !important; z-index: 10000 !important; padding: 10px 15px !important; background: linear-gradient(135deg, #4CAF50, #45a049) !important; color: white !important; border: none !important; border-radius: 6px !important; cursor: pointer !important; font-size: 13px !important; font-weight: 500 !important; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important; box-shadow: 0 4px 12px rgba(76, 175, 80, 0.3) !important; transition: all 0.2s ease !important; }
.hikaze-menu-button:hover { background: linear-gradient(135deg, #45a049, #4CAF50) !important; transform: translateY(-1px) !important; box-shadow: 0 6px 16px rgba(76,175,80,0.4) !important; }
`;

// 加载样式
function loadStyles() {
    if (HikazeManager.stylesLoaded) return;

    const styleElement = document.createElement('style');
    styleElement.id = 'hikaze-modal-styles';
    styleElement.textContent = MODAL_STYLES;
    document.head.appendChild(styleElement);
    HikazeManager.stylesLoaded = true;
    console.log('[Hikaze] Styles loaded');
}

// 检查后端服务状态
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

// 等待服务器启动
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

// 创建通用模态窗口
function createOverlay({ title = '🎨 Hikaze Model Manager', iframeSrc = 'http://127.0.0.1:8789/web/' } = {}) {
    loadStyles();

    const vw = window.innerWidth; const vh = window.innerHeight;
    const modalWidth = Math.floor(vw * 0.6); const modalHeight = Math.floor(vh * 0.6);
    const left = Math.max( (vw - modalWidth) >> 1, 10 );
    const top = Math.max( (vh - modalHeight) >> 1, 10 );

    const overlay = document.createElement('div');
    overlay.className = 'hikaze-modal-overlay';
    overlay.innerHTML = `
        <div class="hikaze-modal-window">
            <div class="hikaze-modal-header">
                <h3>${title}</h3>
                <div class="hikaze-modal-controls">
                    <button class="hikaze-modal-close" title="关闭">×</button>
                </div>
            </div>
            <div class="hikaze-modal-content">
                <div class="hikaze-loading">
                    <div class="hikaze-spinner"></div>
                    <p style="margin-left:8px">加载中…</p>
                </div>
            </div>
        </div>`;
    document.body.appendChild(overlay);

    const modal = overlay.querySelector('.hikaze-modal-window');
    const header = overlay.querySelector('.hikaze-modal-header');
    const closeBtn = overlay.querySelector('.hikaze-modal-close');

    // 通过JS设置尺寸与位置，避免内联样式解析问题
    if (modal) {
        try {
            modal.style.width = modalWidth + 'px';
            modal.style.height = modalHeight + 'px';
            modal.style.left = left + 'px';
            modal.style.top = top + 'px';
        } catch(_) {}
    }

    const escHandler = (e) => { if (e.key === 'Escape') doClose(); };
    const doClose = () => {
        document.removeEventListener('keydown', escHandler);
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    };

    if (closeBtn) closeBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); doClose(); };
    document.addEventListener('keydown', escHandler);
    overlay.onclick = (e) => { /* prevent accidental close */ };

    // 拖拽
    if (header && modal) {
        let isDragging = false; let startX = 0, startY = 0; let startLeft = 0, startTop = 0;
        header.onmousedown = (e) => {
            if (e.target === closeBtn) return;
            isDragging = true;
            startX = e.clientX; startY = e.clientY;
            const ml = parseInt(modal.style.left || '0', 10) || modal.getBoundingClientRect().left;
            const mt = parseInt(modal.style.top || '0', 10) || modal.getBoundingClientRect().top;
            startLeft = ml; startTop = mt;
            const onMove = (ev) => {
                if (!isDragging) return;
                const dx = ev.clientX - startX; const dy = ev.clientY - startY;
                modal.style.left = (startLeft + dx) + 'px';
                modal.style.top = (startTop + dy) + 'px';
            };
            const onUp = () => {
                isDragging = false;
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            e.preventDefault();
        };
    }

    // 加载 iframe
    (async () => {
        const loading = overlay.querySelector('.hikaze-loading');
        const ok = await waitForServer();
        if (!ok) { if (loading) loading.innerHTML = '<div class="hikaze-error">⚠️ 后端未就绪</div>'; return; }
        const iframe = document.createElement('iframe');
        iframe.src = iframeSrc;
        iframe.onload = () => { if (loading) loading.style.display = 'none'; };
        iframe.onerror = () => { if (loading) loading.innerHTML = '<div class="hikaze-error">⚠️ 无法加载</div>'; };
        const content = overlay.querySelector('.hikaze-modal-content');
        if (content) content.appendChild(iframe);
    })();

    return overlay;
}

// 打开模型管理器
function openModelManager() {
    try {
        console.log('[Hikaze] Opening model manager...');
        // 缓存：保留原有单例（不与选择器共享）
        if (HikazeManager.modalWindow && document.body.contains(HikazeManager.modalWindow)) {
            HikazeManager.modalWindow.style.display = 'block';
            return;
        }
        HikazeManager.modalWindow = createOverlay({ title: '🎨 Hikaze Model Manager', iframeSrc: 'http://127.0.0.1:8789/web/' });
    } catch (error) {
        console.error('[Hikaze] Error opening model manager:', error);
        alert('打开模型管理器时发生错误: ' + error.message);
    }
}

// 打开������选择器（selector 模式）
function openModelSelector({ kind = 'checkpoint', requestId }) {
    const qs = new URLSearchParams({ mode: 'selector', kind: kind, requestId: requestId || '' });
    const overlay = createOverlay({ title: '🧩 选择模型', iframeSrc: `http://127.0.0.1:8789/web/?${qs.toString()}` });
    return overlay;
}

// 创建菜单按钮
function createMenuButton() {
    // 避免重复创建
    if (HikazeManager.menuButton && document.body.contains(HikazeManager.menuButton)) {
        return true;
    }

    const button = document.createElement('button');
    button.className = 'hikaze-menu-button';
    button.textContent = '🎨 模型管理器';
    button.title = 'Hikaze Model Manager';
    // 强制设置偏移，确保与样式一致
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

// 尝试集成到ComfyUI菜单
function tryMenuIntegration() {
    HikazeManager.initAttempts++;

    // 首先尝试创建固定按钮（更可靠）
    if (createMenuButton()) {
        console.log('[Hikaze] Menu integration successful');
        return true;
    }

    // 如果失败且未达到最大尝试次数，继续重试
    if (HikazeManager.initAttempts < HikazeManager.maxInitAttempts) {
        setTimeout(tryMenuIntegration, 1000);
        return false;
    }

    console.warn('[Hikaze] Menu integration failed after maximum attempts');
    return false;
}

// 监听选择结果
function setupMessageListener(){
    window.addEventListener('message', (ev)=>{
        const data = ev && ev.data;
        if (!data || data.type !== 'hikaze-mm-select') return;
        const { requestId, payload } = data;
        const ctx = HikazeManager.pending.get(requestId);
        if (!ctx) return;
        try{
            const { node, wName, wPath, overlay, mode } = ctx;
            // LoRA 批量回填
            if (payload && (payload.kind === 'lora' || payload.kind === 'loras') && Array.isArray(payload.items) && node && node.comfyClass === 'HikazePowerLoraLoader'){
                addLoraRows(node, payload.items);
                // 刷新画布
                try { node.setDirtyCanvas(true, true); } catch(_) {}
                try { app.graph.setDirtyCanvas(true, true); } catch(_) {}
                if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
                return;
            }
            const pathVal = payload && payload.value ? String(payload.value) : '';
            const nameVal = payload && (payload.label || payload.value) ? String(payload.label || payload.value) : '';
            // 通用单值回填（如 checkpoint）
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
            if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        } finally {
            HikazeManager.pending.delete(requestId);
        }
    });
}

// 为节点注入“读取”按钮并将 ckpt_name 设为隐藏、model_name 只读显示
function enhanceCheckpointSelectorNode(node){
    try{
        if (!node || node.comfyClass !== 'HikazeCheckpointSelector') return;
        if (!Array.isArray(node.widgets)) return;
        const wPath = node.widgets.find(w=> w && (w.name === 'ckpt_name' || w.label === 'ckpt_name'));
        // 保持原版下拉：不禁用不隐藏，让用户可直接从下拉选择
        if (wPath){
            try { wPath.readonly = false; wPath.disabled = false; wPath.hidden = false; } catch(_) {}
            if (wPath.options) { try { wPath.options.readonly = false; } catch(_) {} }
        }
        // 添加“读取”按钮：作为补充选择方式
        const btn = node.addWidget && node.addWidget('button', '读取', '读取', () => {
            const requestId = 'sel_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
            const overlay = openModelSelector({ kind: 'checkpoint', requestId });
            HikazeManager.pending.set(requestId, { node, wPath, overlay });
        }, { serialize: false });
        if (btn) btn.label = '读取';
        try { node.setDirtyCanvas(true, true); } catch(_) {}
    } catch(err){
        console.warn('[Hikaze] enhance node failed:', err);
    }
}

// 工具：在 Power LoRA Loader 上新增若干行 widgets
function addLoraRows(node, items){
    try{
        if (!node || !Array.isArray(items)) return;
        const nextIndex = (()=>{
            let maxI = -1;
            const re = /^lora_(\d+)(?:_(on|strength_model|strength_clip))?$/;
            const list = Array.isArray(node.widgets) ? node.widgets : [];
            for (const w of list){
                const name = w && (w.name || w.label);
                if (!name || typeof name !== 'string') continue;
                const m = name.match(re);
                if (m){ const i = parseInt(m[1], 10); if (!Number.isNaN(i)) maxI = Math.max(maxI, i); }
            }
            return (maxI + 1);
        })();
        let i = nextIndex;
        const addOne = (val, label)=>{
            const idx = i++;
            const keyBase = `lora_${idx}`;
            // on 开关
            const wOn = node.addWidget && node.addWidget('checkbox', `${keyBase}_on`, true, (v)=>{ /* no-op */ }, { serialize: true });
            if (wOn) { wOn.label = `${keyBase}_on`; }
            // 名称文本（loras 相对路径/文件名）
            const wName = node.addWidget && node.addWidget('text', keyBase, String(val||''), (v)=>{ /* no-op */ }, { serialize: true });
            // 模型强度
            const wSm = node.addWidget && node.addWidget('number', `${keyBase}_strength_model`, 1.0, (v)=>{ /* no-op */ }, { serialize: true, min: -4, max: 4, step: 0.05 });
            // CLIP 强度
            const wSc = node.addWidget && node.addWidget('number', `${keyBase}_strength_clip`, 1.0, (v)=>{ /* no-op */ }, { serialize: true, min: -4, max: 4, step: 0.05 });
            // UI 微调
            try { if (wName) wName.serialize = true; } catch(_) {}
            try { if (wSm) wSm.serialize = true; } catch(_) {}
            try { if (wSc) wSc.serialize = true; } catch(_) {}
        };
        items.forEach(it=> addOne(it && (it.value || it.label || '')));
    }catch(err){
        console.warn('[Hikaze] addLoraRows failed:', err);
    }
}

// 增强 LoRA Loader：添加 bypass 与“选择模型”按钮
function enhancePowerLoraLoaderNode(node){
    try{
        if (!node || node.comfyClass !== 'HikazePowerLoraLoader') return;
        if (!Array.isArray(node.widgets)) node.widgets = [];
        // 如未存在 bypass，则添加
        const hasBypass = node.widgets.some(w=> w && (w.name === 'bypass' || w.label === 'bypass'));
        if (!hasBypass){
            const wBy = node.addWidget && node.addWidget('checkbox', 'bypass', false, (v)=>{ /* 透传 */ }, { serialize: true });
            if (wBy) wBy.label = '禁用全部LoRA（bypass）';
        }
        // 添加“选择模型”按钮（LoRA 多选）
        const btn = node.addWidget && node.addWidget('button', '选择模型…', '选择模型…', () => {
            const requestId = 'sel_' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
            const overlay = openModelSelector({ kind: 'lora', requestId });
            HikazeManager.pending.set(requestId, { node, overlay, mode: 'lora-batch' });
        }, { serialize: false });
        if (btn) btn.label = '选择模型…';
        try { node.setDirtyCanvas(true, true); } catch(_) {}
    } catch(err){
        console.warn('[Hikaze] enhance power lora node failed:', err);
    }
}

// ComfyUI扩展注册
app.registerExtension({
    name: "hikaze.model.manager",

    async setup() {
        console.log('[Hikaze] Extension setup starting...');

        // 加载样式
        loadStyles();

        // 延迟初始化以确保DOM完全加载
        setTimeout(() => {
            // 仅保留右上角按钮
            tryMenuIntegration();
            // 选择结果监听
            setupMessageListener();
        }, 2000);

        // 检查服务器状态
        setTimeout(async () => {
            const isReady = await checkServerStatus();
            console.log(isReady ? '[Hikaze] Backend server is ready' : '[Hikaze] Backend server not ready, will retry when opening manager');
        }, 3000);
    },

    async nodeCreated(node){
        // 增强我们自定义的节点
        enhanceCheckpointSelectorNode(node);
        enhancePowerLoraLoaderNode(node);
    }
});

// 全局函数导��
window.hikazeOpenManager = openModelManager;
window.hikazeManager = {
    open: openModelManager,
    openSelector: (kind, requestId)=> openModelSelector({kind, requestId}),
    isServerStarted: () => HikazeManager.isServerStarted,
    checkServer: checkServerStatus
};

console.log('[Hikaze] Extension script loaded');
