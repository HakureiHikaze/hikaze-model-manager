'use strict';

(function(){
  // Allow running when accessed directly under /web; skip initialization if top window isn't our page
  try {
    if (typeof window !== 'undefined' && window.top === window) {
      const p = (typeof location !== 'undefined' && location.pathname ? location.pathname.toLowerCase() : '');
      const isOurPage = (p === '/web' || p.startsWith('/web/'));
      if (!isOurPage) {
        console.debug('[HikazeMM] app.js: top window but not /web, skip initialization');
        return;
      }
    }
  } catch(_) {}

  // i18n loader
  const I18N = {
    dict: {},
    lang: 'zh-CN',
    ready: false,
    async init(){
      try{
        const urlParams = new URLSearchParams(location.search||'');
        let lang = urlParams.get('lang') || (navigator.language || navigator.userLanguage || 'zh-CN');
        // Normalize like zh, zh-CN, en-US
        lang = String(lang).replace('_','-');
        if (lang.toLowerCase().startsWith('zh')) lang = 'zh-CN';
        this.lang = lang;
        const res = await fetch(`/web/i18n/${this.lang}.json`);
        if (res.ok){ this.dict = await res.json(); this.ready = true; }
      }catch(err){ console.warn('[HikazeMM] i18n load failed, use keys as text', err); this.dict = {}; this.ready = false; }
    },
    t(key){ return (this.dict && Object.prototype.hasOwnProperty.call(this.dict, key)) ? this.dict[key] : key; },
    apply(root){
      const r = root || document;
      try{
        // Elements with data-i18n => textContent
        r.querySelectorAll('[data-i18n]').forEach(el=>{
          const k = el.getAttribute('data-i18n');
          if (k) el.textContent = I18N.t(k);
        });
        // Attributes mapping: data-i18n-attr="placeholder:key,title:key2"
        r.querySelectorAll('[data-i18n-attr]').forEach(el=>{
          const spec = el.getAttribute('data-i18n-attr')||'';
          spec.split(',').forEach(pair=>{
            const [attr, k] = pair.split(':').map(s=>s && s.trim());
            if (attr && k){ el.setAttribute(attr, I18N.t(k)); }
          });
        });
        // <title data-i18n="...">
        const ti = r.querySelector('title[data-i18n]');
        if (ti){ const k = ti.getAttribute('data-i18n'); if (k) ti.textContent = I18N.t(k); }
      }catch(err){ console.warn('[HikazeMM] i18n apply failed', err); }
    }
  };
  const t = (k)=> I18N.t(k);

  const urlParams = new URLSearchParams(location.search || '');
  // Determine selector mode via both query params and path
  let selectorMode = (urlParams.get('mode') === 'selector');
  let selectorKind = urlParams.get('kind') || null; // e.g., 'checkpoint' | 'lora'
  const pathName = (typeof location !== 'undefined' && location.pathname) ? location.pathname.toLowerCase() : '';
  if (!selectorMode) {
    if (pathName.includes('selector-lora')) { selectorMode = true; selectorKind = selectorKind || 'lora'; }
    else if (pathName.includes('selector-checkpoint')) { selectorMode = true; selectorKind = selectorKind || 'checkpoint'; }
  }
  const selectorRequestId = urlParams.get('requestId') || null;
  // Added: normalize type names (subset of backend alias rules)
  function normalizeTypeName(n){
    const m = String(n||'').trim().toLowerCase();
    const alias = { checkpoints: 'checkpoint', loras: 'lora', embeddings: 'embedding', vaes: 'vae' };
    return alias[m] || m;
  }
  // Helper for LoRA preselect key
  function normalizeKey(s){
    try { return String(s||'').replace(/\\/g,'/').trim().toLowerCase(); } catch(_){ return ''; }
  }
  function basename(p){
    try{ const parts = String(p||'').split(/[\\\/]/); return parts[parts.length-1] || ''; }catch(_){ return String(p||''); }
  }
  function identityForModel(m){
    const v = m && (m.lora_name || basename(m.path) || m.name);
    return normalizeKey(v);
  }
  // Added: preselected keys (from URL 'selected' param, comma-separated)
  const selectorPreselectedRaw = urlParams.get('selected') || '';
  const preselectedKeys = new Set(
    (selectorPreselectedRaw || '')
      .split(',')
      .map(s=>decodeURIComponent(s).trim())
      .filter(Boolean)
      .map(s=>s.toLowerCase())
  );

  // Added: preselected items with strength data (from URL 'selectedData' param)
  const selectorPreselectedData = urlParams.get('selectedData');
  let preselectedItems = [];
  try {
    if (selectorPreselectedData) {
      const decoded = decodeURIComponent(selectorPreselectedData);
      const parsed = JSON.parse(decoded);
      if (Array.isArray(parsed)) {
        preselectedItems = parsed;
      }
    }
  } catch (err) {
    console.warn('[HikazeMM] Failed to parse selectedData:', err);
    preselectedItems = [];
  }

  const state = {
    types: [],
    currentType: null,
    q: '',
    selectedTags: new Set(),
    viewMode: 'cards',
    models: [],
    total: 0,
    page: 1,
    limit: 5000,
    loading: false,
    hasMore: true,
    selectedModel: null,
    originalDetail: null,
    tagCandidates: [], // available tag candidates (by type)
    selector: {
      on: selectorMode,
      kind: selectorKind,
      requestId: selectorRequestId,
      selectedIds: new Set(),
      preKeys: preselectedKeys,
      strengths: new Map(),
      preselectedIds: new Set(), // 新增：记录 URL 传入的预选模型 id
      filterSelected: false,     // 新增：是否只显示已选
      selectedCache: new Map(),  // 新增：缓存已选模型（即使搜索/筛选后不再返回也保留）
    },
    loadSeq: 0 // 新增：请求序列号，用于丢弃过期搜索结果
  };

  // DOM
  const el = {
    typeTabs: document.getElementById('typeTabs'),
    searchInput: document.getElementById('searchInput'),
    tagDropdownBtn: document.getElementById('tagDropdownBtn'),
    tagDropdown: document.getElementById('tagDropdown'),
    cardViewBtn: document.getElementById('cardViewBtn'),
    listViewBtn: document.getElementById('listViewBtn'),
    modelsContainer: document.getElementById('modelsContainer'),
    detailImage: document.getElementById('detailImage'),
    detailName: document.getElementById('detailName'),
    detailFields: document.getElementById('detailFields'),
    revertBtn: document.getElementById('revertBtn'),
    saveBtn: document.getElementById('saveBtn'),
    confirmBtn: document.getElementById('confirmBtn'),
    refreshBtn: document.getElementById('refreshBtn'),
    // toolbar buttons: settings/close
    settingsBtn: document.getElementById('settingsBtn'),
    closeBtn: document.getElementById('closeBtn'),
    // 新增
    clearSelectionBtn: document.getElementById('clearSelectionBtn'),
    filterSelectedCheckbox: document.getElementById('filterSelectedCheckbox'),
  };

  // Added: safe binding and logging
  function bind(target, event, handler, name){
    if (!target){
      console.warn('[HikazeMM] Missing element for binding', name || event);
      return;
    }
    try { target.addEventListener(event, handler); }
    catch (e) { console.error('[HikazeMM] bind error', name || event, e); }
  }
  function exists(node, name){
    if (!node){ console.warn('[HikazeMM] Missing element:', name); }
    return !!node;
  }

  // Helpers
  const h = (tag, props={}, ...children)=>{
    const e = document.createElement(tag);
    Object.entries(props||{}).forEach(([k,v])=>{
      if (k === 'class') e.className = v;
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (v !== undefined && v !== null) e.setAttribute(k, v);
    });
    children.flat().forEach(c=>{
      if (c === null || c === undefined) return;
      if (typeof c === 'string') e.appendChild(document.createTextNode(c));
      else e.appendChild(c);
    });
    return e;
  };

  function formatMs(ms){
    if (!ms && ms !== 0) return '—';
    const n = Number(ms);
    if (!isFinite(n) || n <= 0) return '—';
    try { return new Date(n).toLocaleString(); } catch(_){ return String(ms); }
  }
  function formatSize(bytes){
    const n = Number(bytes);
    if (!isFinite(n) || n < 0) return '—';
    const units = [t('mm.units.B'), t('mm.units.KB'), t('mm.units.MB'), t('mm.units.GB'), t('mm.units.TB')];
    let v = n, u = 0; while (v >= 1024 && u < units.length-1){ v/=1024; u++; }
    return (u===0? v: v.toFixed(1)) + ' ' + units[u];
  }
  function sanitizeTagName(s){
    if (typeof s !== 'string') return '';
    return s.trim().toLowerCase().replace(/\s+/g,' ');
  }
  const NOASK_HASH_KEY = 'hikaze_mm_hash_noask';

  async function api(path){
    const r = await fetch(path);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function apiJSON(method, path, body){
    const r = await fetch(path, {method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(body||{})});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  // SHA row and helpers
  function getNoAskHash(){
    try { return localStorage.getItem(NOASK_HASH_KEY) === '1'; } catch(_) { return false; }
  }
  function setNoAskHash(on){
    try { if (on) localStorage.setItem(NOASK_HASH_KEY, '1'); else localStorage.removeItem(NOASK_HASH_KEY);} catch(_) {}
  }
  async function fetchModelById(id){
    return api(`/models/${id}`);
  }
  function createShaRow(m){
    const current = m.hash_hex || '';
    const row = h('label', {class:'field'});
    const lab = h('span', {class:'label'}, t('mm.sha.label'));
    const input = h('input', {value: current || '—', disabled: ''});
    const btn = h('button', {class: 'btn', style:{flex:'0 0 auto'}}, current ? t('mm.sha.recompute') : t('mm.sha.compute'));

    btn.addEventListener('click', async ()=>{
      try{
        if (!getNoAskHash()){
          if (!confirm(t('mm.sha.confirmCompute'))) return;
          if (confirm(t('mm.confirm.noAsk'))) setNoAskHash(true);
        }
        btn.disabled = true; btn.textContent = t('mm.common.computing');
        await apiJSON('POST', '/models/refresh', {id: m.id, compute_hash: true});
        const fresh = await fetchModelById(m.id);
        m.hash_hex = fresh.hash_hex;
        input.value = m.hash_hex || '—';
        btn.textContent = m.hash_hex ? t('mm.sha.recompute') : t('mm.sha.compute');
      }catch(err){
        alert(t('mm.sha.computeFail') + (err && err.message ? err.message : err));
      }finally{
        btn.disabled = false;
      }
    });

    row.append(lab, input, btn);
    return row;
  }

  function createCommunityLinkRow(m){
    const wrap = h('label', {class:'field'});
    const lab = h('span', {class:'label'}, t('mm.community.label'));
    const val = (m.extra && typeof m.extra.community_links === 'string') ? m.extra.community_links : '';
    const input = h('input', {value: val, placeholder: t('mm.community.placeholder'), oninput:(e)=>{ m.extra=m.extra||{}; m.extra.community_links = e.target.value; }});
    const openBtn = h('button', {class:'btn', style:{flex:'0 0 auto'}}, t('mm.common.open'));
    openBtn.addEventListener('click', ()=>{
      const url = (m.extra && m.extra.community_links) ? String(m.extra.community_links).trim() : '';
      if (!url) return;
      const hasProto = /^(https?:)?\/\//i.test(url);
      const target = hasProto ? url : ('https://' + url);
      window.open(target, '_blank');
    });
    wrap.append(lab, input, openBtn);
    return wrap;
  }

  // Types
  async function loadTypes(){
    const rows = await api('/types');
    state.types = rows;
    const preferred = ['checkpoints','loras','embeddings','vae','checkpoint','lora','embedding'];
    let t = rows.find(x=>preferred.includes(String(x.name||'').toLowerCase()));
    if (!t && rows.length) t = rows[0];
    state.currentType = t ? t.name : null;
    // In selector mode: prefer switching to specified kind (with aliases)
    if (state.selector.on && state.selector.kind) {
      const want = normalizeTypeName(state.selector.kind);
      const found = rows.find(x=> normalizeTypeName(x && x.name) === want || String(x && x.name).toLowerCase() === (want+'s'));
      // Change: if not found in /types, force to want to avoid falling back to checkpoint
      state.currentType = found ? found.name : want;
    }
    renderTypeTabs();
  }

  function renderTypeTabs(){
    if (!exists(el.typeTabs, 'typeTabs')) return;
    el.typeTabs.innerHTML = '';
    state.types.forEach(t=>{
      const btn = h('button', {
        class: 'tab' + (state.currentType===t.name?' active':'') ,
        onclick: ()=>{ state.currentType = t.name; state.selectedTags.clear(); renderTypeTabs(); resetAndLoad(); }
      }, `${t.name} (${t.count})`);
      el.typeTabs.appendChild(btn);
    });
  }

  // Tags facets & dropdown
  async function loadFacets(){
    // In selector mode, force using kind as filter type (when currentType is missing)
    const forcedType = (state.selector.on && state.selector.kind) ? normalizeTypeName(state.selector.kind) : null;
    const effectiveType = state.currentType || forcedType;
    if (!effectiveType) { if (el.tagDropdown) el.tagDropdown.innerHTML=''; state.tagCandidates = []; return; }
    const selected = Array.from(state.selectedTags).join(',');
    const url = new URL(location.origin + '/tags/facets');
    if (effectiveType) url.searchParams.set('type', effectiveType);
    if (state.q) url.searchParams.set('q', state.q);
    if (selected) url.searchParams.set('selected', selected);
    // always use ALL mode on backend
    url.searchParams.set('mode', 'all');
    const facets = await api(url.pathname + '?' + url.searchParams.toString());
    try {
      const byTypeUrl = new URL(location.origin + '/tags/by-type');
      byTypeUrl.searchParams.set('type', effectiveType);
      const allTags = await api(byTypeUrl.pathname + '?' + byTypeUrl.searchParams.toString());
      if (Array.isArray(allTags)) {
        state.tagCandidates = allTags
          .map(t => (typeof t === 'string' ? t : (t && t.name)))
          .filter(v => typeof v === 'string' && v.trim().length > 0);
      } else {
        state.tagCandidates = [];
      }
    } catch(e) {
      state.tagCandidates = Array.isArray(facets) ? facets.map(f=>f && f.name).filter(Boolean) : [];
    }
    renderTagDropdown(facets);
  }

  function renderTagDropdown(facets){
    if (!exists(el.tagDropdown, 'tagDropdown')) return;
    el.tagDropdown.innerHTML = '';
    const items = facets.filter(f=> String(f.name) !== String(state.currentType||''));
    if (!items.length) {
      el.tagDropdown.appendChild(h('div', {class:'empty'}, t('mm.tags.empty')));
      return;
    }
    items.forEach(f=>{
      const active = state.selectedTags.has(f.name);
      const disabled = !active && f.count === 0;
      const btn = h('button', {class:'tag-item' + (active?' active':'') + (disabled?' disabled':''), onclick: ()=>{
        if (disabled) return;
        if (active) state.selectedTags.delete(f.name); else state.selectedTags.add(f.name);
        resetAndLoad();
      }}, `${f.name} (${f.count})`);
      el.tagDropdown.appendChild(btn);
    });
  }

  // Models
  async function loadModels(){
    if (state.loading || !state.hasMore) return;
    state.loading = true;
    const seq = state.loadSeq; // 记录当前请求序列
    const isFirstPage = state.page === 1; // 本次请求是否第一页

    const url = new URL(location.origin + '/models');
    // In selector mode, try to use the real type from /types first; then fall back to normalized kind from URL to restrict the main category
    const forcedType = (state.selector.on && state.selector.kind) ? normalizeTypeName(state.selector.kind) : null;
    const effectiveType = state.currentType || forcedType;
    if (effectiveType) url.searchParams.set('type', effectiveType);
    if (state.q) url.searchParams.set('q', state.q);
    if (state.selectedTags.size>0) url.searchParams.append('tags', Array.from(state.selectedTags).join(','));
    // always use ALL mode for tags filtering
    url.searchParams.set('tags_mode', 'all');
    url.searchParams.set('limit', String(state.limit));
    url.searchParams.set('offset', String((state.page - 1) * state.limit));

    try {
      const data = await api(url.pathname + '?' + url.searchParams.toString());
      // 过期请求��输入已变更）直接丢弃
      if (seq !== state.loadSeq) { state.loading = false; return; }

      const newModels = data.items || [];
      if (isFirstPage) {
        // 再保险：若是第一页，确保 state.models 已为空（避免竞态）
        state.models = [];
      }
      state.models.push(...newModels);
      state.total = data.total || 0;
      state.page++;
      state.hasMore = state.models.length < state.total;

      // map preselected keys for lora
      if (state.selector.on && (state.selector.kind||'').toLowerCase().startsWith('lora') && state.selector.preKeys && state.selector.preKeys.size){
        for (const m of newModels){
          const key = identityForModel(m);
          if (key && state.selector.preKeys.has(key)){
            state.selector.selectedIds.add(m.id);
            state.selector.preselectedIds.add(m.id);
            if (!state.selector.strengths.has(m.id)) state.selector.strengths.set(m.id, { sm: 1.0, sc: 1.0 });
            state.selector.selectedCache.set(m.id, m); // 缓存
          }
        }
      }
      if (state.selector.on && (state.selector.kind||'').toLowerCase().startsWith('lora') && preselectedItems.length) {
        for (const m of newModels) {
          const key = identityForModel(m);
          if (!key) continue;
          const preselected = preselectedItems.find(item => normalizeKey(item.key) === key);
          if (preselected) {
            state.selector.selectedIds.add(m.id);
            state.selector.preselectedIds.add(m.id);
            state.selector.strengths.set(m.id, {
              sm: Number(preselected.sm) || 1.0,
              sc: Number(preselected.sc) || 1.0
            });
            state.selector.selectedCache.set(m.id, m); // 缓存
          }
        }
      }
      // 若之前已选（用户手动选择）且刚好出现在新结果里，则刷新缓存对象
      if (state.selector.on){
        for (const m of newModels){
          if (state.selector.selectedIds.has(m.id)) state.selector.selectedCache.set(m.id, m);
          if (state.selectedModel && state.selectedModel.id === m.id) state.selector.selectedCache.set(m.id, m);
        }
      }
      if (state.selectedModel) {
        const found = state.models.find(it=> it && it.id === state.selectedModel.id);
        if (found) state.originalDetail = JSON.parse(JSON.stringify(found));
      }
      // 根据是否第一页决定 append
      renderModels(!isFirstPage);
    } catch (err) {
      console.error('[HikazeMM] Failed to load models:', err);
    } finally {
      // 若已有新序列启动，不回滚 loading 状态（由新请求接管）
      if (seq === state.loadSeq) state.loading = false;
    }
  }

  // Hover preview
  const hoverPreview = { el: null, timer: null, pos: {x: 0, y: 0} };
  function createHoverEl(){
    if (hoverPreview.el) return hoverPreview.el;
    const box = document.createElement('div');
    box.id = 'hikaze-hover-preview';
    Object.assign(box.style, {
      position: 'fixed', zIndex: '9999', pointerEvents: 'none',
      background: '#000', border: '1px solid #444', borderRadius: '6px',
      boxShadow: '0 6px 16px rgba(0,0,0,0.35)', padding: '4px',
      maxWidth: '280px', maxHeight: '280px', display: 'none'
    });
    const img = document.createElement('img');
    Object.assign(img.style, { maxWidth: '272px', maxHeight: '272px', display: 'block', objectFit: 'contain' });
    box.appendChild(img);
    document.body.appendChild(box);
    hoverPreview.el = box;
    return box;
  }
  function positionPreview(){
    const elp = hoverPreview.el; if (!elp) return;
    const pad = 12, offset = 16;
    let x = hoverPreview.pos.x + offset;
    let y = hoverPreview.pos.y + offset;
    const rect = elp.getBoundingClientRect();
    const ww = window.innerWidth, wh = window.innerHeight;
    if (x + rect.width + pad > ww) x = Math.max(pad, ww - rect.width - pad);
    if (y + rect.height + pad > wh) y = Math.max(pad, wh - rect.height - pad);
    elp.style.left = x + 'px';
    elp.style.top = y + 'px';
  }
  function trackMouse(e){
    hoverPreview.pos.x = e.clientX; hoverPreview.pos.y = e.clientY;
    if (hoverPreview.el && hoverPreview.el.style.display === 'block') positionPreview();
  }
  function removePreview(){
    if (hoverPreview.timer) { clearTimeout(hoverPreview.timer); hoverPreview.timer = null; }
    if (hoverPreview.el) hoverPreview.el.style.display = 'none';
  }
  function schedulePreview(m){
    if (hoverPreview.timer) { clearTimeout(hoverPreview.timer); hoverPreview.timer = null; }
    removePreview();
    const url = (m && m.images && m.images[0]) ? m.images[0] : null;
    if (!url) return;
    hoverPreview.timer = setTimeout(() => {
      const box = createHoverEl();
      const img = box.querySelector('img');
      img.onload = () => { box.style.display = 'block'; positionPreview(); };
      img.onerror = () => { box.style.display = 'none'; };
      img.src = url;
    }, 350);
  }

  function renderModels(append = false){
    if (!exists(el.modelsContainer, 'modelsContainer')) return;
    el.modelsContainer.className = state.viewMode === 'cards' ? 'cards' : 'list';
    if (!append) {
      el.modelsContainer.innerHTML = '';
    }

    const isLoraSelector = !!(state.selector.on && String(state.selector.kind||'').toLowerCase().startsWith('lora'));

    // 基础列表副本
    let baseList = state.models.slice();

    // 合并缓存：确保所有已选 / 预选模型始终存在于渲染集合
    if (state.selector.on && state.selector.selectedCache.size){
      const existing = new Set(baseList.map(m=>m.id));
      state.selector.selectedCache.forEach((m,id)=>{
        if (!existing.has(id)) baseList.push(m);
      });
      append = false; // 结构变化需全量重绘
    }

    // 过滤：只显示已选
    if (state.selector.on && state.selector.filterSelected){
      if (isLoraSelector){
        baseList = baseList.filter(m=> state.selector.selectedIds.has(m.id));
      }else{
        baseList = state.selectedModel ? baseList.filter(m=> m.id === state.selectedModel.id) : [];
      }
      append = false;
    }

    // 预选排序
    if (isLoraSelector && state.selector.preselectedIds.size){
      const pre = [], rest = [];
      for (const m of baseList){
        (state.selector.preselectedIds.has(m.id) ? pre : rest).push(m);
      }
      baseList = pre.concat(rest);
      append = false;
    }

    if (!append) el.modelsContainer.innerHTML = '';
    const modelsToRender = append ? baseList.slice(-state.limit) : baseList;
    if (!append && !modelsToRender.length){
      el.modelsContainer.appendChild(h('div', {class:'empty'}, t('mm.empty')));
      return;
    }
    const stop = (e)=>{ try{ e.stopPropagation(); }catch(_){} };
    const includeModel = (m)=>{
      if (!state.selector.selectedIds.has(m.id)){
        state.selector.selectedIds.add(m.id);
        if (!state.selector.strengths.has(m.id)) state.selector.strengths.set(m.id, { sm: 1.0, sc: 1.0 });
      }
      // 缓存最新对象
      state.selector.selectedCache.set(m.id, m);
    };
    const removeModel = (m)=>{
      if (state.selector.selectedIds.has(m.id)){
        state.selector.selectedIds.delete(m.id);
        state.selector.strengths.delete(m.id);
      }
      state.selector.selectedCache.delete(m.id);
    };
    const createStrengthControls = (m)=>{
      const wrap = h('div', {class:'lora-strengths-wrap', onclick:stop});
      const s = state.selector.strengths.get(m.id) || { sm: 1.0, sc: 1.0 };
      const num = (name, val, onchg)=> h('input', {type:'number', step:'0.05', min:'-10', max:'10', value: String(val), style:{width:'72px'}, oninput:(e)=>{ stop(e); const v=parseFloat(e.target.value); if (isFinite(v)) onchg(v); }});

      const modelRow = h('div', {class:'lora-strengths'});
      const smLab = h('span', {class:'tag', style:{background:'#333', color:'#ddd'}}, t('mm.lora.model'));
      const sm = num('sm', s.sm, (v)=>{ const cur=state.selector.strengths.get(m.id)||{sm:1,sc:1}; cur.sm=Math.max(-10, Math.min(10, v)); state.selector.strengths.set(m.id, cur); });
      modelRow.append(smLab, sm);

      const clipRow = h('div', {class:'lora-strengths'});
      const scLab = h('span', {class:'tag', style:{background:'#333', color:'#ddd'}}, t('mm.lora.clip'));
      const sc = num('sc', s.sc, (v)=>{ const cur=state.selector.strengths.get(m.id)||{sm:1,sc:1}; cur.sc=Math.max(-10, Math.min(10, v)); state.selector.strengths.set(m.id, cur); });
      clipRow.append(scLab, sc);

      wrap.append(modelRow, clipRow);
      return wrap;
    };
    modelsToRender.forEach(m=>{
      const tags = (m.tags||[]).filter(t=>t!==m.type);
      const isSel = !!(state.selectedModel && state.selectedModel.id === m.id);
      const picked = isLoraSelector && state.selector.selectedIds.has(m.id);
      if (state.viewMode === 'cards'){
        const card = h('div', {class:'card' + (isSel?' selected':'') + (picked?' picked':''), onclick:()=>{
          if (isLoraSelector){
            // Click card: include and focus (do not toggle off)
            includeModel(m);
            state.selectedModel = JSON.parse(JSON.stringify(m));
            state.originalDetail = JSON.parse(JSON.stringify(m));
            updateActionsState();
            renderDetail();
            renderModels(); // Re-render all to update selection styles
          } else {
            selectModel(m);
          }
        }});
        const badge = h('span', {class:'badge'}, m.type);
        const topChildren = [badge];
        // Checkbox: used primarily to remove (also supports re-including)
        if (isLoraSelector){
          const chk = h('input', {type:'checkbox', checked: picked? '' : null, onclick:(e)=>{
            stop(e);
            const on = e.currentTarget && e.currentTarget.checked;
            if (on) includeModel(m); else removeModel(m);
            updateActionsState();
            // If just unchecked while card is highlighted, keep right panel content to match "most recent selection" behavior
            renderModels(); // Re-render all
          }});
          topChildren.push(h('span', {style:{marginLeft:'auto'}}, chk));
        }
        const top = h('div', {class:'card-top'}, topChildren);
        const bg = h('div', {class:'bg'});
        const name = h('div', {class:'name'}, m.name || m.path);
        const tagRowChildren = tags.map(t=>h('span', {class: 'tag' + (state.selectedTags.has(t)?' highlight':'')}, t));
        if (isLoraSelector && picked) tagRowChildren.push(createStrengthControls(m));
        const tagRow = h('div', {class:'tags', style:{display:'flex', gap:'6px', flexWrap:'wrap'}}, tagRowChildren);
        card.append(top, bg, name, tagRow);
        if (m.images && m.images.length){
          card.style.backgroundImage = `url(${m.images[0]})`;
        } else {
          card.classList.add('no-image');
        }
        el.modelsContainer.appendChild(card);
      } else {
        const row = h('div', {class:'row' + (isSel?' selected':'') + (picked?' picked':''), onclick:()=>{
          if (isLoraSelector){
            includeModel(m);
            state.selectedModel = JSON.parse(JSON.stringify(m));
            state.originalDetail = JSON.parse(JSON.stringify(m));
            updateActionsState();
            renderDetail();
            renderModels(); // Re-render all
          } else {
            selectModel(m);
          }
        }});
        // Checkbox column
        if (isLoraSelector){
          const chk = h('input', {type:'checkbox', checked: picked? '' : null, onclick:(e)=>{
            stop(e);
            const on = e.currentTarget && e.currentTarget.checked;
            if (on) includeModel(m); else removeModel(m);
            updateActionsState();
            row.classList.toggle('picked', !!on);
            // In list mode, avoid repainting the whole page; update strength controls for this row only
            const old = row.querySelector('.lora-strengths'); if (old) old.remove();
            if (on){ row.appendChild(createStrengthControls(m)); }
          }});
          row.appendChild(h('span', {class:'row-pick'}, chk));
        }
        row.append(
          h('span', {class:'row-name'}, m.name || m.path),
          h('span', {class:'row-tags'}, tags.map(t=>h('span', {class:'tag' + (state.selectedTags.has(t)?' highlight':'')}, t)))
        );
        if (isLoraSelector && picked){
          row.appendChild(createStrengthControls(m));
        }
        row.addEventListener('mouseenter', (e)=>{ trackMouse(e); schedulePreview(m); });
        row.addEventListener('mousemove', (e)=>{ trackMouse(e); });
        row.addEventListener('mouseleave', ()=>{ removePreview(); });
        el.modelsContainer.appendChild(row);
      }
    });
  }

  function selectModel(m){
    state.selectedModel = JSON.parse(JSON.stringify(m));
    state.originalDetail = JSON.parse(JSON.stringify(m));
    // 缓存（单选情况下也保留，防止搜索后消失）
    if (state.selector.on) state.selector.selectedCache.set(m.id, m);
    renderDetail();
    renderModels();
  }

  // Tag chips editor (type tag is grayed out and not removable; others are removed via ×)
  function createTagChipsEditor(m){
    const box = h('div', {class:'chips'});
    const typeName = m.type || '';
    // Initialize as user tags (excluding type tag), edited in classic chips manner
    if (!Array.isArray(m.__tags)){
      m.__tags = (Array.isArray(m.tags)? m.tags: []).filter(t=>t && t!==typeName);
    }
    const tagsSet = new Set(m.__tags.map(sanitizeTagName).filter(Boolean));

    const input = h('input', {class:'chips-input', placeholder: t('mm.tags.inputPlaceholder')});
    const suggestWrap = h('div', {class:'chips-suggest hidden'});

    function renderChips(){
      box.querySelectorAll('.chip').forEach(n=>n.remove());
      // Do not render the type tag chip; only render editable user tags
      Array.from(tagsSet).forEach(tag=>{
        const chip = h('span', {class:'chip', onclick:(e)=>{ e.stopPropagation(); }}, [
          tag,
          h('button', {class:'chip-x', title: t('mm.tags.remove'), onclick:(e)=>{ e.preventDefault(); e.stopPropagation(); tagsSet.delete(tag); syncBack(); renderChips(); }}, '×')
        ]);
        box.insertBefore(chip, input);
      });
      syncBack();
    }
    function syncBack(){
      m.__tags = Array.from(tagsSet);
    }
    function commitFromInput(){
      const raw = input.value.trim();
      if (!raw) return;
      const parts = raw.split(/[\s,]+/).map(sanitizeTagName).filter(Boolean);
      let changed = false;
      for (const p of parts){ if (p && !tagsSet.has(p)){ tagsSet.add(p); changed = true; } }
      input.value='';
      if (changed) renderChips();
    }
    function refreshSuggest(){
      const q = input.value.trim().toLowerCase();
      const cands = Array.isArray(state.tagCandidates)? state.tagCandidates: [];
      const filtered = cands
        .map(sanitizeTagName)
        .filter(Boolean)
        .filter(t=> !tagsSet.has(t) && (!q || t.includes(q)))
        .slice(0, 20);
      suggestWrap.innerHTML = '';
      if (!filtered.length){ suggestWrap.classList.add('hidden'); return; }
      filtered.forEach(t=>{
        const item = h('div', {class:'chips-suggest-item', onclick:(e)=>{ e.stopPropagation(); tagsSet.add(t); syncBack(); renderChips(); input.focus(); suggestWrap.classList.add('hidden'); }}, t);
        suggestWrap.appendChild(item);
      });
      suggestWrap.classList.remove('hidden');
    }

    // Submit only on Enter/Space/Comma; Backspace bulk clear is not supported
    input.addEventListener('keydown', (e)=>{
      if (e.key==='Enter' || e.key===' ' || e.key===','){ e.preventDefault(); commitFromInput(); suggestWrap.classList.add('hidden'); }
    });
    input.addEventListener('input', ()=> refreshSuggest());
    input.addEventListener('blur', ()=> setTimeout(()=>{ suggestWrap.classList.add('hidden'); }, 150));

    // Clicking the container focuses the input only; it doesn't modify tags
    box.addEventListener('click', ()=>{ input.focus(); });

    box.append(input, suggestWrap);
    renderChips();
    return box;
  }

  function createImageUploadRow(m){
    const url = (m.extra && Array.isArray(m.extra.images) && m.extra.images[0]) ? m.extra.images[0] : '';
    const filename = url ? (url.split('/').pop() || '') : '';
    const wrap = h('label', {class:'field'});
    const lab = h('span', {class:'label'}, t('mm.image.sample'));
    const nameBox = h('input', {value: filename || '—', disabled: ''});
    const btn = h('button', {class: 'btn', style:{flex:'0 0 auto'}}, t('mm.btn.upload'));
    const fileInput = h('input', {type:'file', accept:'image/*', style:'display:none'});

    btn.addEventListener('click', ()=> fileInput.click());
    fileInput.addEventListener('change', async ()=>{
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      btn.disabled = true; const old = btn.textContent; btn.textContent = t('mm.common.uploading');
      try{
        const r = await fetch(`/models/${m.id}/image`, {method:'PUT', headers:{'Content-Type': f.type || 'application/octet-stream', 'X-Filename': f.name}, body: f});
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const js = await r.json();
        const imageUrl = js.image_url;
        m.extra = m.extra || {}; m.extra.images = [imageUrl];
        nameBox.value = js.file || (imageUrl.split('/').pop()||'');
        if (imageUrl) { el.detailImage.style.backgroundImage = `url(${imageUrl})`; }
        const found = state.models.find(it=>it.id===m.id); if (found) { found.images = [imageUrl]; }
        renderModels();
      }catch(err){
        alert(t('mm.upload.fail') + (err && err.message ? err.message : err));
      }finally{
        btn.disabled = false; btn.textContent = old; fileInput.value = '';
      }
    });

    wrap.append(lab, nameBox, btn, fileInput);
    return wrap;
  }

  function renderDetail(){
    const m = state.selectedModel;
    if (!m){
      el.detailName.textContent = t('mm.detail.none');
      el.detailFields.innerHTML = '';
      el.detailImage.style.backgroundImage = '';
      updateActionsState();
      return;
    }
    el.detailName.textContent = m.name || m.path;
    const img = (m.images && m.images[0]) ? m.images[0] : null;
    el.detailImage.style.backgroundImage = img ? `url(${img})` : '';

    const ro = (label, value)=> h('label', {class:'field'}, [h('span', {class:'label'}, label), h('input', {value: (value===undefined||value===null||value==='')?'—':String(value), disabled: ''})]);
    const rwArea = (label, key, placeholder)=> h('label', {class:'field'}, [h('span', {class:'label'}, label), h('textarea', {placeholder: placeholder||'', oninput:(e)=>{ m.extra = m.extra||{}; m.extra[key]=e.target.value; }}, (m.extra&&m.extra[key])||'')]);

    const tagsEditor = createTagChipsEditor(m);
    const promptsEditor = createPromptsEditor(m);

    el.detailFields.innerHTML='';
    el.detailFields.append(
      ro(t('mm.detail.type'), m.type),
      ro(t('mm.detail.filename'), m.name || (m.path? m.path.split(/[\/\\]/).pop(): '—')),
      ro(t('mm.detail.path'), m.path),
      ro(t('mm.detail.size'), formatSize(m.size_bytes)),
      ro(t('mm.detail.createdAt'), formatMs(m.created_at)),
      createShaRow(m),
      createCommunityLinkRow(m),
      rwArea(t('mm.detail.descriptionLabel'), 'description', t('mm.detail.descriptionPlaceholder')),
      createImageUploadRow(m)
    );
    el.detailFields.append(
      h('label', {class:'field'}, [h('span', {class:'label'}, t('mm.detail.tags'))])
    );
    el.detailFields.append(tagsEditor);
    el.detailFields.append(
      h('label', {class:'field'}, [h('span', {class:'label'}, t('mm.detail.prompts'))]),
      promptsEditor
    );
    updateActionsState();
  }

  function createPromptsEditor(m){
    const box = h('div', {style:{display:'flex',flexDirection:'column',gap:'8px', width:'100%'}});
    const get = (k)=> (m.extra && m.extra.prompts && m.extra.prompts[k]) || '';
    const set = (k,v)=>{ m.extra=m.extra||{}; m.extra.prompts=m.extra.prompts||{}; m.extra.prompts[k]=v; };
    const pos = h('textarea', {placeholder: t('mm.prompts.positive'), oninput:(e)=>set('positive', e.target.value)}, get('positive'));
    const neg = h('textarea', {placeholder: t('mm.prompts.negative'), oninput:(e)=>set('negative', e.target.value)}, get('negative'));
    pos.rows = 3; neg.rows = 3;
    box.append(pos, neg);
    return box;
  }

  // Parameters editor and suggestParamKey removed

  function revertDetail(){
    if (!state.originalDetail) return;
    state.selectedModel = JSON.parse(JSON.stringify(state.originalDetail));
    renderDetail();
  }

  async function saveDetail(){
    const m = state.selectedModel; if (!m) return;
    // Save tags
    const current = new Set((m.tags||[]).filter(t=>t!==m.type));
    const desiredList = Array.isArray(m.__tags) ? m.__tags : Array.from(current);
    const desiredClean = new Set(desiredList.map(sanitizeTagName).filter(Boolean));
    const add = Array.from(desiredClean).filter(t=>!current.has(t));
    const remove = Array.from(current).filter(t=>!desiredClean.has(t));
    if (add.length || remove.length){
      const resp = await apiJSON('POST', `/models/${m.id}/tags`, {add, remove});
      m.tags = resp.tags;
    }
    // Save extra: params no longer submitted
    m.extra = m.extra || {};
    const extraPayload = {};
    ['description','community_links','images','prompts'].forEach(k=>{
      if (m.extra[k] !== undefined) extraPayload[k] = m.extra[k];
    });
    if (Object.keys(extraPayload).length){
      const resp2 = await apiJSON('PATCH', `/models/${m.id}/extra`, extraPayload);
      m.extra = Object.assign({}, m.extra||{}, resp2);
    }
    state.originalDetail = JSON.parse(JSON.stringify(m));
    await loadModels();
    renderDetail();
    const txt = el.saveBtn.textContent; el.saveBtn.textContent = t('mm.saved'); setTimeout(()=>{ el.saveBtn.textContent = txt; }, 1000);
  }

  function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }

  function sendSelection(ev){
    if (!state.selector.on) return;
    const kind = (state.selector.kind || 'checkpoint').toLowerCase();
    const mode = (ev && ev.shiftKey) ? 'append' : 'replace';
    if (kind === 'lora' || kind === 'loras'){
      const picked = Array.from(state.selector.selectedCache.values());
      if (!picked.length) { alert(t('mm.selector.needLora')); return; }
      const items = picked.map(m=>{
        const base = (m.path ? (m.path.split(/[\\\/]/).pop()||'') : (m.name||''));
        const value = (m && m.lora_name) ? m.lora_name : base; // prefer relative name
        const label = (m && (m.name || base)) || String(value);
        const st = state.selector.strengths.get(m.id) || { sm: 1.0, sc: 1.0 };
        return { value, label, sm: Number(st.sm)||1.0, sc: Number(st.sc)||1.0 };
      });
      const msg = { type: 'hikaze-mm-select', requestId: state.selector.requestId, payload: { kind: 'lora', items, mode } };
      try { window.parent.postMessage(msg, '*'); } catch(_) {}
      return;
    }
    // Default: checkpoint single select
    const m = state.selectedModel;
    if (!m) { alert(t('mm.selector.none')); return; }
    let value = null;
    if (kind === 'checkpoint' || kind === 'checkpoints') {
      value = m.ckpt_name || m.path || m.name || null;
    } else {
      value = m.path || m.name || null;
    }
    if (!value) { alert(t('mm.selector.invalid')); return; }
    const label = (m && (m.name || (m.path ? m.path.split(/[\\\/]/).pop() : ''))) || String(value);
    const msg = { type: 'hikaze-mm-select', requestId: state.selector.requestId, payload: { kind, value, label } };
    try { window.parent.postMessage(msg, '*'); } catch(_) {}
  }

  function postCloseMessage(){
    try{
      if (state.selector && state.selector.on){
        const msg = { type: 'hikaze-mm-cancel', requestId: state.selector.requestId };
        window.parent && window.parent.postMessage(msg, '*');
      } else {
        const msg = { type: 'hikaze-mm-close' };
        window.parent && window.parent.postMessage(msg, '*');
      }
    }catch(_){ }
  }

  async function boot(){
    console.debug('[HikazeMM] boot start');
    await I18N.init();
    // Apply initial i18n for static DOM
    I18N.apply(document);
    wire();
    await loadTypes();
    await updateAll();
    // UI tweaks in selector mode
    if (state.selector.on){
      try { if (el.typeTabs) el.typeTabs.style.display = 'none'; } catch(_) {}
    }
    // In selector mode: bind Enter for quick confirm
    if (state.selector.on && el.confirmBtn){
      bind(el.confirmBtn, 'click', (e)=> sendSelection(e));
      document.addEventListener('keydown', (e)=>{
        if (e.key === 'Enter'){
          e.preventDefault();
          sendSelection(e);
        }
      });
    }
    // Global Esc close (selector: cancel; manager: close)
    document.addEventListener('keydown', (e)=>{
      if (e.key === 'Escape'){
        e.preventDefault();
        postCloseMessage();
      }
    });
    // Toolbar close button
    if (el.closeBtn){
      el.closeBtn.addEventListener('click', (e)=>{ e.preventDefault(); postCloseMessage(); });
    }
    // Settings button placeholder (no-op currently)
    if (el.settingsBtn){
      el.settingsBtn.addEventListener('click', (e)=>{ e.preventDefault(); /* TODO: open settings in future */ });
    }
    console.debug('[HikazeMM] boot done');
  }

  function wire(){
    // View toggle
    bind(el.cardViewBtn, 'click', ()=>{ state.viewMode='cards'; el.cardViewBtn && el.cardViewBtn.classList.add('active'); el.listViewBtn && el.listViewBtn.classList.remove('active'); renderModels(); }, 'cardViewBtn');
    bind(el.listViewBtn, 'click', ()=>{ state.viewMode='list'; el.listViewBtn && el.listViewBtn.classList.add('active'); el.cardViewBtn && el.cardViewBtn.classList.remove('active'); renderModels(); }, 'listViewBtn');

    // removed tag mode radios: always ALL

    // Tag dropdown
    bind(el.tagDropdownBtn, 'click', ()=>{ if (el.tagDropdown) el.tagDropdown.classList.toggle('hidden'); }, 'tagDropdownBtn');
    document.addEventListener('click', (e)=>{
      try{
        if (el.tagDropdown && !el.tagDropdown.contains(e.target) && e.target!==el.tagDropdownBtn) el.tagDropdown.classList.add('hidden');
      }catch(err){ console.debug('[HikazeMM] click handler skipped', err); }
    });

    // Search and Scan
    bind(el.searchInput, 'input', debounce(()=>{ state.q = (el.searchInput && el.searchInput.value || '').trim(); resetAndLoad(); }, 300), 'searchInput');
    bind(el.refreshBtn, 'click', async ()=>{
      try{
        if (!el.refreshBtn) return;
        el.refreshBtn.disabled = true; const old = el.refreshBtn.textContent; el.refreshBtn.textContent = t('mm.scan.starting');
        await apiJSON('POST', '/scan/start', {full: false});
        el.refreshBtn.textContent = t('mm.scan.started');
        setTimeout(()=>{ if (!el.refreshBtn) return; el.refreshBtn.textContent = old; el.refreshBtn.disabled = false; resetAndLoad(); }, 1000);
      }catch(err){
        if (el.refreshBtn) el.refreshBtn.disabled = false; alert(t('mm.scan.startFail') + err.message);
      }
    }, 'refreshBtn');

    // Save/Revert
    bind(el.saveBtn, 'click', ()=>{ saveDetail().catch(err=>alert(t('mm.save.fail')+err.message)); }, 'saveBtn');
    bind(el.revertBtn, 'click', ()=> revertDetail(), 'revertBtn');

    // 新增：取消全部选择
    bind(el.clearSelectionBtn, 'click', ()=>{
      if (!state.selector.on) return;
      if ((state.selector.kind||'').toLowerCase().startsWith('lora')){
        state.selector.selectedIds.clear();
        state.selector.strengths.clear();
        state.selector.selectedCache.clear(); // 清空缓存
      }else{
        if (state.selectedModel) state.selector.selectedCache.delete(state.selectedModel.id);
        state.selectedModel = null;
        state.originalDetail = null;
      }
      updateActionsState();
      renderDetail();
      renderModels(false);
    }, 'clearSelectionBtn');

    // 新增：筛选已选
    bind(el.filterSelectedCheckbox, 'change', ()=>{
      state.selector.filterSelected = !!el.filterSelectedCheckbox.checked;
      renderModels(false);
    }, 'filterSelectedCheckbox');

    updateActionsState();
  }

  function updateActionsState(){
    if (!exists(el.saveBtn, 'saveBtn') || !exists(el.revertBtn, 'revertBtn')) return;
    const has = !!state.selectedModel;
    if (state.selector.on){
      el.saveBtn.style.display = 'none';
      el.revertBtn.style.display = 'none';
      if (el.confirmBtn){
        el.confirmBtn.style.display = '';
        const kind = String(state.selector.kind||'').toLowerCase();
        let can = false;
        if (kind === 'checkpoint' || kind === 'checkpoints') {
          can = !!(state.selectedModel && (state.selectedModel.ckpt_name || state.selectedModel.path));
        } else if (kind === 'lora' || kind === 'loras') {
          can = !!(state.selector.selectedIds && state.selector.selectedIds.size > 0);
        } else {
          can = has;
        }
        el.confirmBtn.disabled = !can;
      }
    } else {
      el.saveBtn.style.display = '';
      el.revertBtn.style.display = '';
      el.saveBtn.disabled = !has;
      el.revertBtn.disabled = !has;
      if (el.confirmBtn) el.confirmBtn.style.display = 'none';
    }
    const isLora = !!(state.selector.on && (state.selector.kind||'').toLowerCase().startsWith('lora'));
    if (state.selector.on){
      // 显示 / 隐藏新控件
      if (el.clearSelectionBtn){
        el.clearSelectionBtn.style.display = isLora ? '' : 'none';
        el.clearSelectionBtn.disabled = isLora ? (state.selector.selectedIds.size===0) : false;
      }
      if (el.filterSelectedCheckbox){
        el.filterSelectedCheckbox.parentElement.style.display = '';
        el.filterSelectedCheckbox.checked = !!state.selector.filterSelected;
      }
    }else{
      if (el.clearSelectionBtn) el.clearSelectionBtn.style.display = 'none';
      if (el.filterSelectedCheckbox){
        el.filterSelectedCheckbox.parentElement.style.display = 'none';
        el.filterSelectedCheckbox.checked = false;
      }
    }
  }

  // Ensure view mode buttons reflect current state
  function updateViewModeButtons(){
    try{
      if (el.cardViewBtn){
        if (state.viewMode === 'cards') el.cardViewBtn.classList.add('active');
        else el.cardViewBtn.classList.remove('active');
      }
      if (el.listViewBtn){
        if (state.viewMode === 'list') el.listViewBtn.classList.add('active');
        else el.listViewBtn.classList.remove('active');
      }
    }catch(err){ console.warn('[HikazeMM] updateViewModeButtons failed', err); }
  }

  function resetAndLoad(){
    state.loadSeq++; // 序列自增，标记之前的请求为过期
    state.page = 1;
    state.models = [];
    state.hasMore = true;
    state.loading = false;
    if (el.modelsContainer){
      el.modelsContainer.scrollTop = 0;
      el.modelsContainer.innerHTML = ''; // 立即清空旧 DOM，提升搜索反馈
    }
    updateAll();
  }

  async function updateAll(){
    await Promise.all([loadFacets(), loadModels()]);
    updateViewModeButtons();
    updateActionsState();
    renderDetail();
  }

  boot().catch(err=>{
    console.error(err);
    alert(t('mm.init.fail') + err.message);
  });
})();
