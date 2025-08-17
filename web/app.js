'use strict';

(function(){
  // 仅在 iframe 内运行，避免被 ComfyUI 主页面自动加载
  try {
    if (typeof window !== 'undefined' && window.top === window) {
      console.debug('[HikazeMM] app.js: detected top window, skip initialization');
      return;
    }
  } catch(_) {}

  const urlParams = new URLSearchParams(location.search || '');
  const selectorMode = (urlParams.get('mode') === 'selector');
  const selectorKind = urlParams.get('kind') || null; // e.g., 'checkpoint'
  const selectorRequestId = urlParams.get('requestId') || null;

  const state = {
    types: [],
    currentType: null,
    q: '',
    selectedTags: new Set(),
    tagsMode: 'all',
    viewMode: 'cards',
    models: [],
    total: 0,
    selectedModel: null,
    originalDetail: null,
    tagCandidates: [], // 可用标签候选（按类型）
    selector: {
      on: selectorMode,
      kind: selectorKind,
      requestId: selectorRequestId,
      selectedIds: new Set(), // 新增：多选已选 id 集
    }
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
  };

  // 新增：安全绑定与日志
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
  const qsa = (sel, root=document)=>Array.from(root.querySelectorAll(sel));
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
    const units = ['B','KB','MB','GB','TB'];
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

  // SHA 行与相关辅助
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
    const lab = h('span', {class:'label'}, 'SHA256');
    const input = h('input', {value: current || '—', disabled: ''});
    const btn = h('button', {class: 'btn', style:{flex:'0 0 auto'}}, current ? '重算' : '计算');

    btn.addEventListener('click', async ()=>{
      try{
        if (!getNoAskHash()){
          if (!confirm('将计算该文件的 SHA256，可能较慢，是否继续？')) return;
          if (confirm('是否不再询问？')) setNoAskHash(true);
        }
        btn.disabled = true; btn.textContent = '计算中…';
        await apiJSON('POST', '/models/refresh', {id: m.id, compute_hash: true});
        const fresh = await fetchModelById(m.id);
        m.hash_hex = fresh.hash_hex;
        input.value = m.hash_hex || '—';
        btn.textContent = m.hash_hex ? '重算' : '计算';
      }catch(err){
        alert('计算失败: ' + (err && err.message ? err.message : err));
      }finally{
        btn.disabled = false;
      }
    });

    row.append(lab, input, btn);
    return row;
  }

  function createCommunityLinkRow(m){
    const wrap = h('label', {class:'field'});
    const lab = h('span', {class:'label'}, '社区链接');
    const val = (m.extra && typeof m.extra.community_links === 'string') ? m.extra.community_links : '';
    const input = h('input', {value: val, placeholder:'输入链接（Civitai/HF 等）', oninput:(e)=>{ m.extra=m.extra||{}; m.extra.community_links = e.target.value; }});
    const openBtn = h('button', {class:'btn', style:{flex:'0 0 auto'}}, '打开');
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
    // 选择器模式：优先切换到指定 kind（含别名）
    if (state.selector.on && state.selector.kind) {
      const want = String(state.selector.kind).toLowerCase();
      const alias = { checkpoint: 'checkpoint', checkpoints: 'checkpoint', lora: 'lora', loras: 'lora' };
      const target = alias[want] || want;
      // 在 /types 返回中匹配目标类型（允许 singular/plural 差异）
      const found = rows.find(x=> String(x.name||'').toLowerCase() === target || String(x.name||'').toLowerCase() === (target+'s'));
      if (found) state.currentType = found.name;
    }
    renderTypeTabs();
  }

  function renderTypeTabs(){
    if (!exists(el.typeTabs, 'typeTabs')) return;
    el.typeTabs.innerHTML = '';
    state.types.forEach(t=>{
      const btn = h('button', {
        class: 'tab' + (state.currentType===t.name?' active':''),
        onclick: ()=>{ state.currentType = t.name; state.selectedTags.clear(); renderTypeTabs(); updateAll(); }
      }, `${t.name} (${t.count})`);
      el.typeTabs.appendChild(btn);
    });
  }

  // Tags facets & dropdown
  async function loadFacets(){
    if (!state.currentType) { el.tagDropdown.innerHTML=''; state.tagCandidates = []; return; }
    const selected = Array.from(state.selectedTags).join(',');
    const url = new URL(location.origin + '/tags/facets');
    if (state.currentType) url.searchParams.set('type', state.currentType);
    if (state.q) url.searchParams.set('q', state.q);
    if (selected) url.searchParams.set('selected', selected);
    url.searchParams.set('mode', state.tagsMode);
    const facets = await api(url.pathname + '?' + url.searchParams.toString());
    try {
      const byTypeUrl = new URL(location.origin + '/tags/by-type');
      byTypeUrl.searchParams.set('type', state.currentType);
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
      el.tagDropdown.appendChild(h('div', {class:'empty'}, '暂无可筛选标签'));
      return;
    }
    items.forEach(f=>{
      const active = state.selectedTags.has(f.name);
      const disabled = !active && f.count === 0;
      const btn = h('button', {class:'tag-item' + (active?' active':'') + (disabled?' disabled':''), onclick: ()=>{
        if (disabled) return;
        if (active) state.selectedTags.delete(f.name); else state.selectedTags.add(f.name);
        updateAll();
      }}, `${f.name} (${f.count})`);
      el.tagDropdown.appendChild(btn);
    });
  }

  // Models
  async function loadModels(){
    const url = new URL(location.origin + '/models');
    if (state.currentType) url.searchParams.set('type', state.currentType);
    if (state.q) url.searchParams.set('q', state.q);
    if (state.selectedTags.size>0) url.searchParams.append('tags', Array.from(state.selectedTags).join(','));
    url.searchParams.set('tags_mode', state.tagsMode);
    url.searchParams.set('limit', '100');
    const data = await api(url.pathname + '?' + url.searchParams.toString());
    state.models = data.items || [];
    state.total = data.total || 0;
    if (state.selectedModel) {
      const found = state.models.find(it=> it && it.id === state.selectedModel.id);
      if (found) state.originalDetail = JSON.parse(JSON.stringify(found));
    }
    renderModels();
  }

  // 悬浮预览
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

  function renderModels(){
    if (!exists(el.modelsContainer, 'modelsContainer')) return;
    el.modelsContainer.className = state.viewMode === 'cards' ? 'cards' : 'list';
    el.modelsContainer.innerHTML = '';
    if (!state.models.length){
      el.modelsContainer.appendChild(h('div', {class:'empty'}, '无结果'));
      return;
    }
    state.models.forEach(m=>{
      const tags = (m.tags||[]).filter(t=>t!==m.type);
      const isSel = !!(state.selectedModel && state.selectedModel.id === m.id);
      const multiPick = state.selector.on && (String(state.selector.kind||'').toLowerCase() === 'lora' || String(state.selector.kind||'').toLowerCase() === 'loras');
      const picked = multiPick && state.selector.selectedIds.has(m.id);
      const pickBox = multiPick ? h('input', {type:'checkbox', checked: picked? '': null, onclick:(e)=>{ e.stopPropagation(); if (state.selector.selectedIds.has(m.id)) state.selector.selectedIds.delete(m.id); else state.selector.selectedIds.add(m.id); updateActionsState(); if (state.viewMode==='cards'){ /* 触发重绘选中样式 */ renderModels(); } else { e.currentTarget.closest('.row')?.classList.toggle('picked', state.selector.selectedIds.has(m.id)); } }}) : null;
      if (state.viewMode === 'cards'){
        const card = h('div', {class:'card' + (isSel?' selected':'') + (picked?' picked':''), onclick:()=>selectModel(m)});
        const badge = h('span', {class:'badge'}, m.type);
        const top = h('div', {class:'card-top'}, [badge]);
        if (pickBox){ top.appendChild(h('span', {style:{marginLeft:'auto'}}, pickBox)); }
        const bg = h('div', {class:'bg'});
        const name = h('div', {class:'name'}, m.name || m.path);
        const tagRow = h('div', {class:'tags'}, tags.map(t=>h('span', {class: 'tag' + (state.selectedTags.has(t)?' highlight':'')}, t)));
        card.append(top, bg, name, tagRow);
        if (m.images && m.images.length){
          card.style.backgroundImage = `url(${m.images[0]})`;
        } else {
          card.classList.add('no-image');
        }
        el.modelsContainer.appendChild(card);
      } else {
        const row = h('div', {class:'row' + (isSel?' selected':'') + (picked?' picked':''), onclick:()=>selectModel(m)});
        if (pickBox) row.appendChild(h('span', {class:'row-pick'}, pickBox));
        row.append(
          h('span', {class:'row-name'}, m.name || m.path),
          h('span', {class:'row-tags'}, tags.map(t=>h('span', {class:'tag' + (state.selectedTags.has(t)?' highlight':'')}, t)))
        );
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
    renderDetail();
    renderModels();
  }

  // 标签 chips 编辑器（类型标签置灰不可删；其他标签仅在点击 × 时删除）
  function createTagChipsEditor(m){
    const box = h('div', {class:'chips'});
    const typeName = m.type || '';
    // 初始化为“用户标签”（不含类型标签），以经典chips方式编辑
    if (!Array.isArray(m.__tags)){
      m.__tags = (Array.isArray(m.tags)? m.tags: []).filter(t=>t && t!==typeName);
    }
    const tagsSet = new Set(m.__tags.map(sanitizeTagName).filter(Boolean));

    const input = h('input', {class:'chips-input', placeholder:'输入标签，空格/逗号/回车添加'});
    const suggestWrap = h('div', {class:'chips-suggest hidden'});

    function renderChips(){
      box.querySelectorAll('.chip').forEach(n=>n.remove());
      // 不再渲染类型标签chip，仅渲染可编辑的用户标签
      Array.from(tagsSet).forEach(tag=>{
        const chip = h('span', {class:'chip', onclick:(e)=>{ e.stopPropagation(); }}, [
          tag,
          h('button', {class:'chip-x', title:'移除', onclick:(e)=>{ e.preventDefault(); e.stopPropagation(); tagsSet.delete(tag); syncBack(); renderChips(); }}, '×')
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

    // 仅在 Enter/空格/逗号提交；不支持 Backspace 批量清空
    input.addEventListener('keydown', (e)=>{
      if (e.key==='Enter' || e.key===' ' || e.key===','){ e.preventDefault(); commitFromInput(); suggestWrap.classList.add('hidden'); }
    });
    input.addEventListener('input', ()=> refreshSuggest());
    input.addEventListener('blur', ()=> setTimeout(()=>{ suggestWrap.classList.add('hidden'); }, 150));

    // 点击容器仅聚焦输入，不修改标签
    box.addEventListener('click', ()=>{ input.focus(); });

    box.append(input, suggestWrap);
    renderChips();
    return box;
  }

  function createImageUploadRow(m){
    const url = (m.extra && Array.isArray(m.extra.images) && m.extra.images[0]) ? m.extra.images[0] : '';
    const filename = url ? (url.split('/').pop() || '') : '';
    const wrap = h('label', {class:'field'});
    const lab = h('span', {class:'label'}, '示例图片');
    const nameBox = h('input', {value: filename || '—', disabled: ''});
    const btn = h('button', {class: 'btn', style:{flex:'0 0 auto'}}, '上传');
    const fileInput = h('input', {type:'file', accept:'image/*', style:'display:none'});

    btn.addEventListener('click', ()=> fileInput.click());
    fileInput.addEventListener('change', async ()=>{
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      btn.disabled = true; const old = btn.textContent; btn.textContent = '上传中…';
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
        alert('上传失败: ' + (err && err.message ? err.message : err));
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
      el.detailName.textContent = '未选择';
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
      ro('类型', m.type),
      ro('文件名', m.name || (m.path? m.path.split(/[\/\\]/).pop(): '—')),
      ro('路径', m.path),
      ro('大小', formatSize(m.size_bytes)),
      ro('添加时间', formatMs(m.created_at)),
      createShaRow(m),
      createCommunityLinkRow(m),
      rwArea('描述', 'description', '模型描述'),
      createImageUploadRow(m)
    );
    // 标签标题行（仅标题在 label 内）
    el.detailFields.append(
      h('label', {class:'field'}, [h('span', {class:'label'}, '标签')])
    );
    // 标签编辑器框置于 label 外，独占一行
    el.detailFields.append(tagsEditor);
    // Prompts 标题与编辑器（保持原有结构）
    el.detailFields.append(
      h('label', {class:'field'}, [h('span', {class:'label'}, 'Prompts')]),
      promptsEditor
    );
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
          can = !!(state.selectedModel && state.selectedModel.ckpt_name);
        } else if (kind === 'lora' || kind === 'loras') {
          can = state.selector.selectedIds && state.selector.selectedIds.size > 0;
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
  }

  function createPromptsEditor(m){
    const box = h('div', {style:{display:'flex',flexDirection:'column',gap:'8px', width:'100%'}});
    const get = (k)=> (m.extra && m.extra.prompts && m.extra.prompts[k]) || '';
    const set = (k,v)=>{ m.extra=m.extra||{}; m.extra.prompts=m.extra.prompts||{}; m.extra.prompts[k]=v; };
    const pos = h('textarea', {placeholder:'正向提示词', oninput:(e)=>set('positive', e.target.value)}, get('positive'));
    const neg = h('textarea', {placeholder:'反向提示词', oninput:(e)=>set('negative', e.target.value)}, get('negative'));
    pos.rows = 3; neg.rows = 3;
    box.append(pos, neg);
    return box;
  }

  // 移除参数编辑器与 suggestParamKey

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
    // Save extra：不再提交 params
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
    const txt = el.saveBtn.textContent; el.saveBtn.textContent = '已保存'; setTimeout(()=>{ el.saveBtn.textContent = txt; }, 1000);
  }

  function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }

  async function updateAll(){
    await Promise.all([loadFacets(), loadModels()]);
  }

  function sendSelection(){
    if (!state.selector.on) return;
    const kind = (state.selector.kind || 'checkpoint').toLowerCase();
    if (kind === 'lora' || kind === 'loras'){
      const picked = state.models.filter(m=> state.selector.selectedIds.has(m.id));
      if (!picked.length) { alert('请至少选择一个 LoRA'); return; }
      const items = picked.map(m=>{
        const base = (m.path ? (m.path.split(/[\/\\]/).pop()||'') : (m.name||''));
        const value = base; // 仅传文件名，避免绝对路径
        const label = (m && (m.name || base)) || String(value);
        return { value, label };
      });
      const msg = { type: 'hikaze-mm-select', requestId: state.selector.requestId, payload: { kind: 'lora', items } };
      try { window.parent.postMessage(msg, '*'); } catch(_) {}
      return;
    }
    // 默认 checkpoint 单选
    const m = state.selectedModel;
    if (!m) { alert('未选择模型'); return; }
    let value = null;
    if (kind === 'checkpoint' || kind === 'checkpoints') {
      value = m.ckpt_name || null;
    } else {
      value = m.path || m.name || null;
    }
    if (!value) { alert('无有效选择'); return; }
    const label = (m && (m.name || (m.path ? m.path.split(/[\/\\]/).pop() : ''))) || String(value);
    const msg = { type: 'hikaze-mm-select', requestId: state.selector.requestId, payload: { kind, value, label } };
    try { window.parent.postMessage(msg, '*'); } catch(_) {}
  }

  async function boot(){
    console.debug('[HikazeMM] boot start');
    wire();
    await loadTypes();
    await updateAll();
    // 选择器模式 UI 调整
    if (state.selector.on){
      try { if (el.typeTabs) el.typeTabs.style.display = 'none'; } catch(_) {}
    }
    // 选择器模式下：绑定回车快捷确认
    if (state.selector.on && el.confirmBtn){
      bind(el.confirmBtn, 'click', ()=> sendSelection());
      document.addEventListener('keydown', (e)=>{
        if (e.key === 'Enter'){
          e.preventDefault();
          sendSelection();
        }
      });
    }
    console.debug('[HikazeMM] boot done');
  }

  function wire(){
    // 视图切换
    bind(el.cardViewBtn, 'click', ()=>{ state.viewMode='cards'; el.cardViewBtn && el.cardViewBtn.classList.add('active'); el.listViewBtn && el.listViewBtn.classList.remove('active'); renderModels(); }, 'cardViewBtn');
    bind(el.listViewBtn, 'click', ()=>{ state.viewMode='list'; el.listViewBtn && el.listViewBtn.classList.add('active'); el.cardViewBtn && el.cardViewBtn.classList.remove('active'); renderModels(); }, 'listViewBtn');

    // 标签模式
    qsa('input[name="tagsMode"]').forEach(r=> bind(r, 'change', (e)=>{ state.tagsMode = e.target.value; updateAll(); }, 'tagsMode'));

    // 标签下拉
    bind(el.tagDropdownBtn, 'click', ()=>{ if (el.tagDropdown) el.tagDropdown.classList.toggle('hidden'); }, 'tagDropdownBtn');
    document.addEventListener('click', (e)=>{
      try{
        if (el.tagDropdown && !el.tagDropdown.contains(e.target) && e.target!==el.tagDropdownBtn) el.tagDropdown.classList.add('hidden');
      }catch(err){ console.debug('[HikazeMM] click handler skipped', err); }
    });

    // 搜索与扫描
    bind(el.searchInput, 'input', debounce(()=>{ state.q = (el.searchInput && el.searchInput.value || '').trim(); updateAll(); }, 300), 'searchInput');
    bind(el.refreshBtn, 'click', async ()=>{
      try{
        if (!el.refreshBtn) return;
        el.refreshBtn.disabled = true; const old = el.refreshBtn.textContent; el.refreshBtn.textContent = '启动中…';
        await apiJSON('POST', '/scan/start', {full: false});
        el.refreshBtn.textContent = '已启动';
        setTimeout(()=>{ if (!el.refreshBtn) return; el.refreshBtn.textContent = old; el.refreshBtn.disabled = false; updateAll(); }, 1000);
      }catch(err){
        if (el.refreshBtn) el.refreshBtn.disabled = false; alert('启动扫描失败: ' + err.message);
      }
    }, 'refreshBtn');

    // 保存/撤销
    bind(el.saveBtn, 'click', ()=>{ saveDetail().catch(err=>alert('保存失败: '+err.message)); }, 'saveBtn');
    bind(el.revertBtn, 'click', ()=> revertDetail(), 'revertBtn');

    updateActionsState();
  }

  boot().catch(err=>{
    console.error(err);
    alert('初始化失败: ' + err.message);
  });
})();
