// ComfyUI 菜单扩展 - Hikaze Model Manager

import { app } from "../../scripts/app.js";

// 全局状态管理
const HikazeManager = {
    modalWindow: null,
    isServerStarted: false,
    stylesLoaded: false,
    menuButton: null,
    initAttempts: 0,
    maxInitAttempts: 30
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

// 创建模态窗口
function createModalWindow() {
    loadStyles();
    if (HikazeManager.modalWindow && document.body.contains(HikazeManager.modalWindow)) {
        HikazeManager.modalWindow.style.display = 'block';
        return;
    }
    const vw = window.innerWidth; const vh = window.innerHeight;
    const modalWidth = Math.floor(vw * 0.6); const modalHeight = Math.floor(vh * 0.6);
    const left = Math.max( (vw - modalWidth) >> 1, 10 );
    const top = Math.max( (vh - modalHeight) >> 1, 10 );

    const overlay = document.createElement('div');
    overlay.className = 'hikaze-modal-overlay';
    overlay.innerHTML = `
        <div class="hikaze-modal-window" style="width:${modalWidth}px;height:${modalHeight}px;left:${left}px;top:${top}px;">
            <div class="hikaze-modal-header">
                <h3>🎨 Hikaze Model Manager</h3>
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
    HikazeManager.modalWindow = overlay;

    setupModalEvents(overlay);
    loadModalContent(overlay);
}

// 设置模态窗口事件
function setupModalEvents(overlay) {
    const modal = overlay.querySelector('.hikaze-modal-window');
    const header = overlay.querySelector('.hikaze-modal-header');
    const closeBtn = overlay.querySelector('.hikaze-modal-close');

    // 关闭函数：移除DOM与事件
    const escHandler = (e) => { if (e.key === 'Escape') doClose(); };
    const doClose = () => {
        document.removeEventListener('keydown', escHandler);
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (HikazeManager.modalWindow === overlay) HikazeManager.modalWindow = null;
    };

    if (closeBtn) closeBtn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); doClose(); };
    document.addEventListener('keydown', escHandler);

    // 背景点击不关闭，避免误触；如需可改为关闭
    overlay.onclick = (e) => { /* no-op to prevent accidental close */ };

    // 拖拽：仅标题栏可拖动
    if (header && modal) {
        let isDragging = false; let startX = 0, startY = 0; let startLeft = 0, startTop = 0;
        header.onmousedown = (e) => {
            if (e.target === closeBtn) return; // 点×不拖拽
            isDragging = true;
            startX = e.clientX; startY = e.clientY;
            // 确保存在初始 left/top
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
}

// 加载模态窗口内���
function loadModalContent(overlay) {
    const loading = overlay.querySelector('.hikaze-loading');
    waitForServer().then((serverReady) => {
        if (!serverReady) {
            if (loading) loading.innerHTML = '<div class="hikaze-error">⚠️ 后端未就绪</div>';
            return;
        }
        const iframe = document.createElement('iframe');
        iframe.src = 'http://127.0.0.1:8789/web/';
        iframe.onload = () => { if (loading) loading.style.display = 'none'; };
        iframe.onerror = () => { if (loading) loading.innerHTML = '<div class="hikaze-error">⚠️ 无法加载</div>'; };
        const content = overlay.querySelector('.hikaze-modal-content');
        if (content) content.appendChild(iframe);
    });
}

// 打开模型管理器
function openModelManager() {
    try {
        console.log('[Hikaze] Opening model manager...');
        createModalWindow();
    } catch (error) {
        console.error('[Hikaze] Error opening model manager:', error);
        alert('打开模型管理器时发生错误: ' + error.message);
    }
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

// 移除“编辑”菜单注入（按需可恢复）
async function addToEditMenu() {
    // 已禁用：仅保留右上角按钮作为入口
    return false;
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
            // 不再尝试在“编辑”菜单添加入口
        }, 2000);

        // 检查服务器状态
        setTimeout(async () => {
            const isReady = await checkServerStatus();
            console.log(isReady ? '[Hikaze] Backend server is ready' : '[Hikaze] Backend server not ready, will retry when opening manager');
        }, 3000);
    }
});

// 全局函数导出
window.hikazeOpenManager = openModelManager;
window.hikazeManager = {
    open: openModelManager,
    isServerStarted: () => HikazeManager.isServerStarted,
    checkServer: checkServerStatus
};

console.log('[Hikaze] Extension script loaded');
