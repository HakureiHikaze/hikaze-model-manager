'use strict';

// Archived original of /web/selector-checkpoint.js
(function(){
  try { if (typeof window !== 'undefined' && window.top === window) { console.debug('[HikazeMM] selector-checkpoint.js top window, skip'); return; } } catch(_){ }

  const urlParams = new URLSearchParams(location.search || '');
  const requestId = urlParams.get('requestId') || '';

  const state = {
    selector: { on: true, kind: 'checkpoint', requestId, selectedIds: new Set() },
    types: [], currentType: 'checkpoint', q: '', selectedTags: new Set(), tagsMode: 'all',
    viewMode: 'cards', models: [], total: 0, selectedModel: null, originalDetail: null, tagCandidates: []
  };

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

  function bind(t,e,h){ if(!t) return; try{ t.addEventListener(e,h); }catch(_){} }
  const qsa=(s,r=document)=>Array.from(r.querySelectorAll(s));
  const h=(tag,props={},...children)=>{ const e=document.createElement(tag); Object.entries(props||{}).forEach(([k,v])=>{ if(k==='class') e.className=v; else if(k==='dataset') Object.assign(e.dataset,v); else if(k.startsWith('on')&&typeof v==='function') e.addEventListener(k.slice(2),v); else if(k==='style'&&typeof v==='object') Object.assign(e.style,v); else if(v!==undefined&&v!==null) e.setAttribute(k,v); }); children.flat().forEach(c=>{ if(c==null) return; if(typeof c==='string') e.appendChild(document.createTextNode(c)); else e.appendChild(c); }); return e; };
  function formatMs(ms){ const n=Number(ms); if(!isFinite(n)||n<=0) return '—'; try{ return new Date(n).toLocaleString(); }catch(_){ return String(ms);} }
  function formatSize(b){ const n=Number(b); if(!isFinite(n)||n<0) return '—'; const u=['B','KB','MB','GB','TB']; let v=n,i=0; while(v>=1024&&i<u.length-1){ v/=1024;i++; } return (i===0? v: v.toFixed(1))+' '+u[i]; }

  async function api(p){ const r=await fetch(p); if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }

  async function loadTypes(){
    const rows=await api('/types');
    state.types=rows;
    const want=['checkpoint','checkpoints'];
    const hit=rows.find(x=> want.includes(String(x.name||'').toLowerCase()));
    state.currentType = hit ? hit.name : (state.currentType || 'checkpoint');
    renderTypeTabs();
    try { if (el.typeTabs) el.typeTabs.style.display='none'; } catch(_){ }
  }
  function renderTypeTabs(){ if(!el.typeTabs) return; el.typeTabs.innerHTML=''; }

  async function loadFacets(){
    const t=state.currentType || 'checkpoint';
    const selected=Array.from(state.selectedTags).join(',');
    const url=new URL(location.origin + '/tags/facets');
    if(t) url.searchParams.set('type', t);
    if(state.q) url.searchParams.set('q', state.q);
    if(selected) url.searchParams.set('selected', selected);
    url.searchParams.set('mode', state.tagsMode);
    const facets=await api(url.pathname + '?' + url.searchParams.toString());
    renderTagDropdown(facets);
  }
  function renderTagDropdown(facets){
    if(!el.tagDropdown) return; el.tagDropdown.innerHTML='';
    const items=(facets||[]).filter(f=> String(f.name)!==String(state.currentType||''));
    if(!items.length){ el.tagDropdown.appendChild(h('div',{class:'empty'},'暂无可筛选标签')); return; }
    items.forEach(f=>{
      const active=state.selectedTags.has(f.name);
      const disabled=!active && f.count===0;
      const btn=h('button',{class:'tag-item'+(active?' active':'')+(disabled?' disabled':''),onclick:()=>{ if(disabled) return; if(active) state.selectedTags.delete(f.name); else state.selectedTags.add(f.name); updateAll(); }}, `${f.name} (${f.count})`);
      el.tagDropdown.appendChild(btn);
    });
  }

  async function loadModels(){
    const url=new URL(location.origin + '/models');
    url.searchParams.set('type', state.currentType || 'checkpoint');
    if(state.q) url.searchParams.set('q', state.q);
    if(state.selectedTags.size>0) url.searchParams.append('tags', Array.from(state.selectedTags).join(','));
    url.searchParams.set('tags_mode', state.tagsMode);
    url.searchParams.set('limit', '100');
    const data=await api(url.pathname + '?' + url.searchParams.toString());
    state.models=data.items||[]; state.total=data.total||0;
    renderModels();
  }

  const hoverPreview={ el:null, timer:null, pos:{x:0,y:0} };
  function createHoverEl(){ if(hoverPreview.el) return hoverPreview.el; const box=document.createElement('div'); box.id='hikaze-hover-preview'; Object.assign(box.style,{position:'fixed',zIndex:'9999',pointerEvents:'none',background:'#000',border:'1px solid #444',borderRadius:'6px',boxShadow:'0 6px 16px rgba(0,0,0,0.35)',padding:'4px',maxWidth:'280px',maxHeight:'280px',display:'none'}); const img=document.createElement('img'); Object.assign(img.style,{maxWidth:'272px',maxHeight:'272px',display:'block',objectFit:'contain'}); box.appendChild(img); document.body.appendChild(box); hoverPreview.el=box; return box; }
  function positionPreview(){ const elp=hoverPreview.el; if(!elp) return; const pad=12, offset=16; let x=hoverPreview.pos.x+offset; let y=hoverPreview.pos.y+offset; const rect=elp.getBoundingClientRect(); const ww=window.innerWidth, wh=window.innerHeight; if(x+rect.width+pad>ww) x=Math.max(pad, ww-rect.width-pad); if(y+rect.height+pad>wh) y=Math.max(pad, wh-rect.height-pad); elp.style.left=x+'px'; elp.style.top=y+'px'; }
  function trackMouse(e){ hoverPreview.pos.x=e.clientX; hoverPreview.pos.y=e.clientY; if(hoverPreview.el && hoverPreview.el.style.display==='block') positionPreview(); }
  function removePreview(){ if(hoverPreview.timer){ clearTimeout(hoverPreview.timer); hoverPreview.timer=null; } if(hoverPreview.el) hoverPreview.el.style.display='none'; }
  function schedulePreview(m){ if(hoverPreview.timer){ clearTimeout(hoverPreview.timer); hoverPreview.timer=null; } removePreview(); const url=(m&&m.images&&m.images[0])? m.images[0]: null; if(!url) return; hoverPreview.timer=setTimeout(()=>{ const box=createHoverEl(); const img=box.querySelector('img'); img.onload=()=>{ box.style.display='block'; positionPreview(); }; img.onerror=()=>{ box.style.display='none'; }; img.src=url; },350); }

  function renderModels(){
    const box = el.modelsContainer; if(!box) return; box.className = state.viewMode==='cards'?'cards':'list'; box.innerHTML=''; if(!state.models.length){ box.appendChild(h('div',{class:'empty'},'无结果')); return; }
    state.models.forEach(m=>{
      const tags=(m.tags||[]).filter(t=>t!==m.type);
      const isSel=!!(state.selectedModel && state.selectedModel.id===m.id);
      if(state.viewMode==='cards'){
        const card=h('div',{class:'card'+(isSel?' selected':''), onclick:()=>selectModel(m)});
        const badge=h('span',{class:'badge'}, m.type);
        const top=h('div',{class:'card-top'}, [badge]);
        const bg=h('div',{class:'bg'});
        const name=h('div',{class:'name'}, m.name || m.path);
        const tagRow=h('div',{class:'tags'}, tags.map(t=>h('span',{class:'tag'+(state.selectedTags.has(t)?' highlight':'')}, t)));
        card.append(top,bg,name,tagRow);
        if(m.images && m.images.length){ card.style.backgroundImage=`url(${m.images[0]})`; } else { card.classList.add('no-image'); }
        box.appendChild(card);
      } else {
        const row=h('div',{class:'row'+(isSel?' selected':''), onclick:()=>selectModel(m)});
        row.append(
          h('span',{class:'row-name'}, m.name || m.path),
          h('span',{class:'row-tags'}, tags.map(t=>h('span',{class:'tag'+(state.selectedTags.has(t)?' highlight':'')}, t)))
        );
        row.addEventListener('mouseenter',(e)=>{ trackMouse(e); schedulePreview(m); });
        row.addEventListener('mousemove',(e)=>{ trackMouse(e); });
        row.addEventListener('mouseleave',()=>{ removePreview(); });
        box.appendChild(row);
      }
    });
    updateActionsState();
  }

  function selectModel(m){ state.selectedModel = JSON.parse(JSON.stringify(m)); state.originalDetail = JSON.parse(JSON.stringify(m)); renderDetail(); renderModels(); }

  function renderDetail(){
    const m=state.selectedModel; if(!m){ el.detailName.textContent='未选择'; el.detailFields.innerHTML=''; el.detailImage.style.backgroundImage=''; updateActionsState(); return; }
    el.detailName.textContent=m.name || m.path;
    const img=(m.images && m.images[0])? m.images[0]: null; el.detailImage.style.backgroundImage = img? `url(${img})`: '';
    const ro=(label,value)=> h('label',{class:'field'}, [h('span',{class:'label'},label), h('input',{value:(value===undefined||value===null||value==='')?'—':String(value), disabled:''})]);
    el.detailFields.innerHTML='';
    el.detailFields.append(
      ro('类型', m.type),
      ro('文件名', m.name || (m.path? m.path.split(/[\\\/]/).pop(): '—')),
      ro('路径', m.path),
      ro('大小', formatSize(m.size_bytes)),
      ro('添加时间', formatMs(m.created_at))
    );
    updateActionsState();
  }

  function updateActionsState(){
    if(!el.confirmBtn) return; const m=state.selectedModel; let can=false; if(m && (m.ckpt_name || m.path)) can = true; el.confirmBtn.disabled = !can;
    if(el.saveBtn) el.saveBtn.style.display='none'; if(el.revertBtn) el.revertBtn.style.display='none';
  }

  function sendSelection(){
    const m=state.selectedModel; if(!m){ alert('未选择模型'); return; }
    const value = m.ckpt_name || m.path || m.name; if(!value){ alert('无有效选择'); return; }
    const label = (m && (m.name || (m.path ? m.path.split(/[\\\/]/).pop() : ''))) || String(value);
    const msg = { type: 'hikaze-mm-select', requestId: state.selector.requestId, payload: { kind: 'checkpoint', value, label } };
    try { window.parent.postMessage(msg, '*'); } catch(_){ }
  }

  function debounce(fn,ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }
  async function updateAll(){ await Promise.all([loadFacets(), loadModels()]); }

  function wire(){
    bind(el.cardViewBtn,'click',()=>{ state.viewMode='cards'; el.cardViewBtn&&el.cardViewBtn.classList.add('active'); el.listViewBtn&&el.listViewBtn.classList.remove('active'); renderModels(); });
    bind(el.listViewBtn,'click',()=>{ state.viewMode='list'; el.listViewBtn&&el.listViewBtn.classList.add('active'); el.cardViewBtn&&el.cardViewBtn.classList.remove('active'); renderModels(); });
    qsa('input[name="tagsMode"]').forEach(r=> bind(r,'change',(e)=>{ state.tagsMode=e.target.value; updateAll(); }));
    bind(el.tagDropdownBtn,'click',()=>{ if(el.tagDropdown) el.tagDropdown.classList.toggle('hidden'); });
    document.addEventListener('click',(e)=>{ try{ if(el.tagDropdown && !el.tagDropdown.contains(e.target) && e.target!==el.tagDropdownBtn) el.tagDropdown.classList.add('hidden'); }catch(_){ } });
    bind(el.searchInput,'input', debounce(()=>{ state.q=(el.searchInput && el.searchInput.value || '').trim(); updateAll(); },300));
    bind(el.refreshBtn,'click', async()=>{ try{ if(!el.refreshBtn) return; el.refreshBtn.disabled=true; const old=el.refreshBtn.textContent; el.refreshBtn.textContent='启动中…'; await fetch('/scan/start',{method:'POST',headers:{'Content-Type':'application/json'},body: JSON.stringify({full:false})}); el.refreshBtn.textContent='已启动'; setTimeout(()=>{ if(!el.refreshBtn) return; el.refreshBtn.textContent=old; el.refreshBtn.disabled=false; updateAll(); },1000); }catch(err){ if(el.refreshBtn) el.refreshBtn.disabled=false; alert('启动扫描失败: '+err.message); } });
    if(el.confirmBtn){ bind(el.confirmBtn,'click',()=> sendSelection()); document.addEventListener('keydown',(e)=>{ if(e.key==='Enter'){ e.preventDefault(); sendSelection(); } }); }
  }

  async function boot(){
    wire(); await loadTypes(); await updateAll();
  }

  boot().catch(err=>{ console.error(err); alert('初始化失败: '+err.message); });
})();
