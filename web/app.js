'use strict';

(function(){
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

  // Helpers
  const qs = (sel, root=document)=>root.querySelector(sel);
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

  // Types
  async function loadTypes(){
    const rows = await api('/types');
    state.types = rows;
    // pick default
    const preferred = ['checkpoint','lora','embedding','vae'];
    let t = rows.find(x=>preferred.includes(x.name));
    if (!t && rows.length) t = rows[0];
    state.currentType = t ? t.name : null;
    renderTypeTabs();
  }

  function renderTypeTabs(){
    el.typeTabs.innerHTML = '';
    state.types.forEach(t=>{
      el.typeTabs.appendChild(h('button', {
        class: 'tab' + (state.currentType===t.name?' active':''),
        onclick: ()=>{ state.currentType = t.name; state.selectedTags.clear(); renderTypeTabs(); updateAll(); }
      }, `${t.name} (${t.count})`));
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
    // 标签建议改为该大类全部标签
    try {
      const byTypeUrl = new URL(location.origin + '/tags/by-type');
      byTypeUrl.searchParams.set('type', state.currentType);
      const allTags = await api(byTypeUrl.pathname + '?' + byTypeUrl.searchParams.toString());
      state.tagCandidates = (Array.isArray(allTags)? allTags: []).filter(n=>typeof n==='string');
    } catch(e) {
      // 回退到 facets 名称集合
      state.tagCandidates = facets.map(f=>f.name);
    }
    renderTagDropdown(facets);
  }

  function renderTagDropdown(facets){
    el.tagDropdown.innerHTML = '';
    const items = facets.filter(f=>!['checkpoint','lora','embedding','vae','upscale','ultralytics','other'].includes(f.name));
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
    renderModels();
  }

  function renderModels(){
    el.modelsContainer.className = state.viewMode === 'cards' ? 'cards' : 'list';
    el.modelsContainer.innerHTML = '';
    if (!state.models.length){
      el.modelsContainer.appendChild(h('div', {class:'empty'}, '无结果'));
      return;
    }
    state.models.forEach(m=>{
      const tags = (m.tags||[]).filter(t=>t!==m.type);
      const isSel = !!(state.selectedModel && state.selectedModel.id === m.id);
      if (state.viewMode === 'cards'){
        const card = h('div', {class:'card' + (isSel?' selected':''), onclick:()=>selectModel(m)});
        const checkbox = h('input', {type:'checkbox', class:'select-box', onclick:(e)=>e.stopPropagation()});
        const badge = h('span', {class:'badge'}, m.type);
        const top = h('div', {class:'card-top'}, [checkbox, badge]);
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
        const row = h('div', {class:'row' + (isSel?' selected':''), onclick:()=>selectModel(m)});
        row.append(
          h('input', {type:'checkbox', class:'select-box', onclick:(e)=>e.stopPropagation()}),
          h('span', {class:'row-name'}, m.name || m.path),
          h('span', {class:'row-tags'}, tags.map(t=>h('span', {class:'tag' + (state.selectedTags.has(t)?' highlight':'')}, t)))
        );
        row.addEventListener('mouseenter', ()=>{/* optional: hover preview */});
        el.modelsContainer.appendChild(row);
      }
    });
  }

  function selectModel(m){
    state.selectedModel = JSON.parse(JSON.stringify(m)); // 拷贝以便编辑
    state.originalDetail = JSON.parse(JSON.stringify(m));
    renderDetail();
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

    const ro = (label, value)=> h('label', {class:'field'}, [h('span', {class:'label'}, label), h('input', {value: value||'', disabled: ''})]);
    const rw = (label, key)=> h('label', {class:'field'}, [h('span', {class:'label'}, label), h('input', {value: (m.extra&&m.extra[key])||'', oninput:(e)=>{ m.extra = m.extra||{}; m.extra[key]=e.target.value; }})]);
    const rwArea = (label, key, placeholder)=> h('label', {class:'field'}, [h('span', {class:'label'}, label), h('textarea', {placeholder: placeholder||'', oninput:(e)=>{ m.extra = m.extra||{}; m.extra[key]=e.target.value; }}, (m.extra&&m.extra[key])||'')]);

    // 标签编辑器（chips）
    const tagsEditor = createTagChipsEditor(m);
    const imagesEditor = createStringChipsEditor(m, 'images', '添加图片 URL 或相对路径');
    const promptsEditor = createPromptsEditor(m);
    const paramsEditor = createParamsEditor(m);

    el.detailFields.innerHTML='';
    el.detailFields.append(
      ro('类型', m.type),
      ro('路径', m.path),
      ro('Hash', m.hash_hex),
      ro('添加时间', m.created_at),
      rw('Civitai 链接', 'civitai_url'),
      rw('HuggingFace 仓库', 'hf_repo'),
      rwArea('描述', 'description', '模型描述'),
      rwArea('使用说明', 'usage', '如何使用、推荐设置等'),
      h('label', {class:'field'}, [h('span', {class:'label'}, '标签'), tagsEditor]),
      h('label', {class:'field'}, [h('span', {class:'label'}, '示例图片'), imagesEditor]),
      h('label', {class:'field'}, [h('span', {class:'label'}, 'Prompts'), promptsEditor]),
      h('div', {class:'params'}, [
        h('div', {class:'field'}, [h('span', {class:'label'}, '参数')]),
        paramsEditor,
        h('button', {class:'param-add', onclick:()=>{ const p = (m.extra=m.extra||{}, m.extra.params=m.extra.params||{}); const k = suggestParamKey(p); if (!(k in p)) p[k]=''; renderDetail(); }}, '+ 新增参数')
      ])
    );
    updateActionsState();
  }

  function updateActionsState(){
    const has = !!state.selectedModel;
    el.saveBtn.disabled = !has;
    el.revertBtn.disabled = !has;
  }

  function createStringChipsEditor(m, key, placeholder){
    const container = h('div', {class:'chips'});
    const list = Array.isArray(m.extra && m.extra[key]) ? [...m.extra[key]] : [];
    const setList = (arr)=>{ m.extra = m.extra||{}; m.extra[key] = arr; };

    const input = h('input', {class:'chips-input', placeholder: placeholder||'输入后空格/逗号/回车确认'});

    function render(){
      container.querySelectorAll('.chip').forEach(n=>n.remove());
      list.forEach((t, idx)=>{
        const chip = h('span', {class:'chip'}, [
          t,
          h('button', {class:'chip-x', title:'移除', onclick:()=>{ list.splice(idx,1); setList([...list]); render(); }}, '×')
        ]);
        container.insertBefore(chip, input);
      });
      setList([...list]);
    }

    function commit(){
      const raw = input.value.trim();
      const parts = raw.split(/[\s,]+/).map(s=>s.trim()).filter(Boolean);
      let changed = false;
      parts.forEach(p=>{ if (!list.includes(p)) { list.push(p); changed=true; } });
      if (changed) render();
      input.value = '';
    }

    input.addEventListener('keydown', (e)=>{
      if (e.key==='Enter' || e.key===' ' || e.key===','){ e.preventDefault(); commit(); }
      else if (e.key==='Backspace' && input.value===''){
        list.pop(); render();
      }
    });

    container.append(input);
    render();
    return container;
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

  function createParamsEditor(m){
    const wrap = h('div');
    const p = (m.extra && m.extra.params && typeof m.extra.params==='object') ? {...m.extra.params} : {};
    function saveBack(){ m.extra=m.extra||{}; m.extra.params = {...p}; }

    function row(key, val){
      const kInput = h('input', {class:'param-k', value:key, placeholder:'键', oninput:(e)=>{ const nv = e.target.value.trim(); if (nv && nv!==key){ delete p[key]; p[nv] = val; key = nv; } }});
      const vInput = h('input', {class:'param-v', value:val, placeholder:'值', oninput:(e)=>{ p[key] = e.target.value; }});
      const del = h('button', {class:'param-remove', title:'删除', onclick:()=>{ delete p[key]; render(); }}, '删除');
      const line = h('div', {class:'param-row'}, [kInput, vInput, del]);
      return line;
    }

    function render(){
      wrap.innerHTML = '';
      Object.entries(p).forEach(([k,v])=>{ wrap.appendChild(row(k, v)); });
      saveBack();
    }

    render();
    return wrap;
  }

  function suggestParamKey(p){
    const base = 'param'; let i=1; while ((base+i) in p) i++; return base+i;
  }

  // ...existing code...
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
    // Save extra：合并主要可编辑字段
    m.extra = m.extra || {};
    const extraPayload = {};
    ['description','usage','civitai_url','hf_repo','images','prompts','params'].forEach(k=>{
      if (m.extra[k] !== undefined) extraPayload[k] = m.extra[k];
    });
    if (Object.keys(extraPayload).length){
      const resp2 = await apiJSON('PATCH', `/models/${m.id}/extra`, extraPayload);
      m.extra = Object.assign({}, m.extra||{}, resp2);
    }
    // 更新原始快照
    state.originalDetail = JSON.parse(JSON.stringify(m));
    // 刷新列表以反映变化
    await loadModels();
    renderDetail();

    // 轻量反馈
    const txt = el.saveBtn.textContent; el.saveBtn.textContent = '已保存'; setTimeout(()=>{ el.saveBtn.textContent = txt; }, 1000);
  }

  // 选中态高亮
  function renderModels(){
    el.modelsContainer.className = state.viewMode === 'cards' ? 'cards' : 'list';
    el.modelsContainer.innerHTML = '';
    if (!state.models.length){
      el.modelsContainer.appendChild(h('div', {class:'empty'}, '无结果'));
      return;
    }
    state.models.forEach(m=>{
      const tags = (m.tags||[]).filter(t=>t!==m.type);
      const isSel = !!(state.selectedModel && state.selectedModel.id === m.id);
      if (state.viewMode === 'cards'){
        const card = h('div', {class:'card' + (isSel?' selected':''), onclick:()=>selectModel(m)});
        const checkbox = h('input', {type:'checkbox', class:'select-box', onclick:(e)=>e.stopPropagation()});
        const badge = h('span', {class:'badge'}, m.type);
        const top = h('div', {class:'card-top'}, [checkbox, badge]);
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
        const row = h('div', {class:'row' + (isSel?' selected':''), onclick:()=>selectModel(m)});
        row.append(
          h('input', {type:'checkbox', class:'select-box', onclick:(e)=>e.stopPropagation()}),
          h('span', {class:'row-name'}, m.name || m.path),
          h('span', {class:'row-tags'}, tags.map(t=>h('span', {class:'tag' + (state.selectedTags.has(t)?' highlight':'')}, t)))
        );
        row.addEventListener('mouseenter', ()=>{/* optional: hover preview */});
        el.modelsContainer.appendChild(row);
      }
    });
  }

  function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }

  async function updateAll(){
    await Promise.all([loadFacets(), loadModels()]);
  }

  async function boot(){
    wire();
    await loadTypes();
    await updateAll();
  }

  function wire(){
    el.cardViewBtn.addEventListener('click', ()=>{ state.viewMode='cards'; el.cardViewBtn.classList.add('active'); el.listViewBtn.classList.remove('active'); renderModels(); });
    el.listViewBtn.addEventListener('click', ()=>{ state.viewMode='list'; el.listViewBtn.classList.add('active'); el.cardViewBtn.classList.remove('active'); renderModels(); });

    qsa('input[name="tagsMode"]').forEach(r=> r.addEventListener('change', (e)=>{ state.tagsMode = e.target.value; updateAll(); }));

    el.tagDropdownBtn.addEventListener('click', ()=>{ el.tagDropdown.classList.toggle('hidden'); });
    document.addEventListener('click', (e)=>{ if (!el.tagDropdown.contains(e.target) && e.target!==el.tagDropdownBtn) el.tagDropdown.classList.add('hidden'); });

    el.searchInput.addEventListener('input', debounce(()=>{ state.q = el.searchInput.value.trim(); updateAll(); }, 300));
    el.refreshBtn.addEventListener('click', ()=> updateAll());

    el.saveBtn.addEventListener('click', ()=>{ saveDetail().catch(err=>alert('保存失败: '+err.message)); });
    el.revertBtn.addEventListener('click', ()=> revertDetail());
    el.confirmBtn.addEventListener('click', ()=>{ console.log('确认选择（占位）', state.selectedModel); });

    // 初始禁用态刷新
    updateActionsState();
  }

  boot().catch(err=>{
    console.error(err);
    alert('初始化失败: ' + err.message);
  });
})();
