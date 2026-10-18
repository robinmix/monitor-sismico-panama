(() => {
  'use strict';
  const TZ = 'America/Panama';
  const API = '/.netlify/functions/sismos';
  const SOURCE = 'https://sismosgeociencias.up.ac.pa/';
  const INTERVAL_MS = 5 * 60 * 1000;
  const LIMIT = 25;
  const COLORS = ['#83a1b1', '#67b9e9', '#efb367', '#f47469'];
  const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, el]));
  const state = {events: [], source: null, loading: false, page: 1, map: null, layer: null, hasFitted: false, initialized: false};
  const f = {
    period: ui.filterPeriod, zone: ui.filterZone, town: ui.filterTown, mag: ui.filterMag,
    depth: ui.filterDepth, status: ui.filterState, from: ui.filterFrom, to: ui.filterTo,
    search: ui.filterSearch, sort: ui.filterSort
  };
  const shortDate = new Intl.DateTimeFormat('es-PA', {timeZone:TZ, day:'2-digit', month:'short'});
  const fullDate = new Intl.DateTimeFormat('es-PA', {timeZone:TZ, day:'2-digit', month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true});
  const clockFmt = new Intl.DateTimeFormat('es-PA', {timeZone:TZ,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  const isoDateFmt = new Intl.DateTimeFormat('sv-SE', {timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'});
  const hourFmt = new Intl.DateTimeFormat('en-GB', {timeZone:TZ,hour:'2-digit',hourCycle:'h23'});
  const el = (tag, classname, content) => { const n = document.createElement(tag); if (classname) n.className = classname; if (content != null) n.textContent = String(content); return n; };
  const set = (id, text) => {if (ui[id]) ui[id].textContent = text;};
  const num = n => Number(n).toLocaleString('es-PA', {maximumFractionDigits:0});
  const localDate = dt => isoDateFmt.format(dt);
  const localHour = dt => hourFmt.format(dt);
  const magnitudeClass = mag => mag >= 5 ? 'm5' : mag >= 4 ? 'm4' : mag >= 3 ? 'm3' : 'mBelow';
  const magColor = mag => mag >= 5 ? COLORS[3] : mag >= 4 ? COLORS[2] : mag >= 3 ? COLORS[1] : COLORS[0];
  const magText = n => n.toFixed(1);
  const pct = (a, total) => total ? `${Math.round(a / total * 100)}%` : '0%';
  const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const buckets = data => [data.filter(e => e.magnitud < 3).length, data.filter(e => e.magnitud >= 3 && e.magnitud < 4).length, data.filter(e => e.magnitud >= 4 && e.magnitud < 5).length, data.filter(e => e.magnitud >= 5).length];
  const sortNames = arr => arr.sort((a,b) => a.localeCompare(b,'es',{sensitivity:'base'}));

  function elapsedTime() {
    const now = new Date();
    set('panamaTime', `${clockFmt.format(now)} · PAN`);
    const latest = state.events[0];
    if (!latest) return;
    const seconds = Math.max(0, Math.floor((now.getTime() - new Date(latest.timestamp).getTime()) / 1000));
    const dd = Math.floor(seconds / 86400), hh = Math.floor(seconds % 86400 / 3600), mm = Math.floor(seconds % 3600 / 60), ss = seconds % 60;
    set('elapsedDays', String(dd).padStart(2,'0'));
    set('elapsedHours', String(hh).padStart(2,'0'));
    set('elapsedMinutes', String(mm).padStart(2,'0'));
    set('elapsedSeconds', String(ss).padStart(2,'0'));
  }

  function passesBase(event, ignoreTown = false) {
    const hours = Number(f.period.value);
    const ts = new Date(event.timestamp).getTime();
    if (hours > 0 && ts < Date.now() - hours * 3600000) return false;
    if (ts > Date.now() + 900000) return false;
    if (f.zone.value && event.zona !== f.zone.value) return false;
    if (!ignoreTown && f.town.value && event.localidad !== f.town.value) return false;
    if (f.depth.value === 'shallow' && event.profundidad >= 10) return false;
    if (f.depth.value === 'middle' && (event.profundidad < 10 || event.profundidad > 30)) return false;
    if (f.depth.value === 'deep' && event.profundidad <= 30) return false;
    if (f.status.value && event.estado.toUpperCase() !== f.status.value) return false;
    if (f.from.value && event.fecha < f.from.value) return false;
    if (f.to.value && event.fecha > f.to.value) return false;
    const query = f.search.value.trim().toLocaleLowerCase('es');
    if (query && !`${event.region} ${event.localidad} ${event.zona}`.toLocaleLowerCase('es').includes(query)) return false;
    return true;
  }
  function matchesMag(event) {
    const m = event.magnitud;
    switch(f.mag.value) {
      case 'below3':return m < 3;
      case '3':return m >= 3 && m < 4;
      case '4':return m >= 4 && m < 5;
      case '5':return m >= 5;
      default:return true;
    }
  }
  const byDateDesc = (a,b) => b.timestamp.localeCompare(a.timestamp);
  function sortedData() {
    const data = state.events.filter(e => passesBase(e) && matchesMag(e));
    switch(f.sort.value) {
      case 'largest':data.sort((a,b) => b.magnitud-a.magnitud || byDateDesc(a,b));break;
      case 'deepest':data.sort((a,b) => b.profundidad-a.profundidad || byDateDesc(a,b));break;
      default:data.sort(byDateDesc);
    }
    return data;
  }
  function populateChoices() {
    const zone = f.zone.value, town = f.town.value;
    const zones = sortNames([...new Set(state.events.map(e => e.zona))]);
    f.zone.replaceChildren(new Option('Todas las regiones',''), ...zones.map(z => new Option(z,z)));
    f.zone.value = zones.includes(zone) ? zone : '';
    updateTowns(town);
  }
  function updateTowns(oldTown = f.town.value) {
    const towns = sortNames([...new Set(state.events.filter(e => passesBase(e,true)).map(e => e.localidad))]);
    f.town.replaceChildren(new Option('Todas las localidades',''), ...towns.map(t => new Option(t,t)));
    f.town.value = towns.includes(oldTown) ? oldTown : '';
  }

  function status(type, text) {
    ui.sourceStatus.className = 'status-pill ' + type;
    ui.sourceStatus.lastChild.textContent = ` ${text}`;
  }
  function message(title, description) {
    ui.alertBox.hidden = false;
    set('alertTitle',title);
    set('alertText',description);
  }
  function hideMessage() {ui.alertBox.hidden = true;}
  async function loadData(isSilent = false) {
    if (state.loading) return;
    state.loading = true;
    if (!isSilent) status('loading','Consultando fuente');
    ui.refreshBtn.disabled = true;
    try {
      const response = await fetch(API, {cache:'no-store', headers:{Accept:'application/json'}});
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload || !Array.isArray(payload.eventos) || !payload.eventos.length) {
        throw new Error(payload?.detalle || payload?.error || `Error HTTP ${response.status}`);
      }
      const normalized = payload.eventos.filter(e => e && Number.isFinite(Number(e.magnitud)) && e.timestamp && !Number.isNaN(new Date(e.timestamp).getTime()))
        .map(e => ({...e,magnitud:Number(e.magnitud),profundidad:Number(e.profundidad),latitud:Number(e.latitud),longitud:Number(e.longitud)}))
        .sort(byDateDesc);
      if (!normalized.length) throw new Error('La fuente devolvió registros sin fecha válida.');
      state.events = normalized;
      state.source = payload;
      populateChoices();
      renderLatest();
      render();
      status(payload.desactualizado ? 'loading':'ok', payload.desactualizado ? 'Lectura anterior' : 'Datos actualizados');
      if (payload.desactualizado) message('Lectura anterior', payload.aviso || 'No fue posible actualizar la consulta.');
      else hideMessage();
      set('sourceTimestamp', `Última consulta de datos: ${fullDate.format(new Date(payload.actualizado))} · ${num(payload.totalFuente)} registros recibidos`);
      set('snapshotStatus', payload.desactualizado ? 'Datos en caché — actualización pendiente' : `Fuente leída: ${fullDate.format(new Date(payload.actualizado))}`);
    } catch(err) {
      if (state.events.length) {
        status('error','Sin actualizar');
        message('No se pudo actualizar la fuente', `Se mantienen los datos de la última consulta. Motivo: ${err.message}`);
      } else {
        status('error','Sin conexión');
        message('No se pudieron obtener los datos del IGC-UP', `${err.message}. Este proyecto necesita publicarse en Netlify con la función incluida; abrir index.html directamente no activa la conexión oficial.`);
        set('snapshotStatus','Sin conexión con la fuente');
      }
    } finally {
      state.loading = false;
      ui.refreshBtn.disabled = false;
    }
  }
  function renderLatest() {
    const e = state.events[0];
    if (!e) return;
    set('latestMagnitude',magText(e.magnitud));
    set('latestState',e.estado);
    set('latestLevel',e.magnitud >= 5 ? 'MAGNITUD ≥5' : e.magnitud >=4 ? 'MAGNITUD 4.x' : e.magnitud >=3 ? 'MAGNITUD 3.x' : 'MAGNITUD <3');
    set('latestRegion',e.region);
    set('latestDate',fullDate.format(new Date(e.timestamp)));
    set('latestDepth',`${e.profundidad} km de profundidad`);
    ui.latestLink.href = e.detalle || SOURCE;
    elapsedTime();
  }

  function renderStats(base, filtered) {
    const [low, three, four, five] = buckets(base);
    const all = base.length;
    const vals = [low,three,four,five];
    ['Below3','3','4','5'].forEach((k,i) => {set('stat'+k,num(vals[i]));set('pct'+k,pct(vals[i],all));set('legend'+k,num(vals[i]));});
    set('statTotal',num(all));
    set('statTotalHint',`${num(state.events.length)} en la lista de la fuente`);
    set('filterInfo',`${num(filtered.length)} evento${filtered.length === 1 ? '' : 's'} visible${filtered.length === 1 ? '' : 's'}`);
    set('donutTotal',num(all));
    set('recordCount',num(filtered.length));
    document.querySelectorAll('[data-magnitude]').forEach(btn => {btn.classList.toggle('is-selected',f.mag.value === btn.dataset.magnitude);btn.setAttribute('aria-pressed',String(f.mag.value === btn.dataset.magnitude));});
    if (!all) {ui.donut.style.background = 'conic-gradient(#345469 0 100%)'; return;}
    let angle = 0;
    const stops = [];
    vals.forEach((value,i) => { const ending = angle + value / all * 100; stops.push(`${COLORS[i]} ${angle}% ${ending}%`); angle = ending; });
    ui.donut.style.background = `conic-gradient(${stops.join(',')})`;
  }

  const svgNode = (tag,attrs = {},textContent = null) => {
    const node = document.createElementNS('http://www.w3.org/2000/svg',tag);
    for(const [key,value] of Object.entries(attrs)) node.setAttribute(key,String(value));
    if (textContent != null) node.textContent = String(textContent);
    return node;
  };
  function drawTimeline(data) {
    const parent = ui.timelineChart;
    parent.replaceChildren();
    const now = Date.now();
    const hours = Number(f.period.value);
    const hourly = hours > 0 && hours <= 48;
    const bins = [];
    if (hourly) {
      const groupHours = hours <= 24 ? 1 : 2;
      const binMs = groupHours * 3600000;
      const endIdx = Math.floor(now / binMs);
      const count = Math.ceil(hours / groupHours);
      for (let i = count - 1; i >= 0; i--) {
        const index = endIdx - i;
        const time = index * binMs;
        bins.push({key:index,title:fullDate.format(new Date(time)),label:`${localHour(new Date(time))}h`,value:0});
      }
      for (const e of data) {
        const key = Math.floor(new Date(e.timestamp).getTime() / binMs);
        const bin = bins.find(b => b.key === key);
        if (bin) bin.value++;
      }
    } else {
      const beginTs = hours > 0 ? now - hours * 3600000 : (data.length ? new Date(data[data.length-1].timestamp).getTime() : now - 6*86400000);
      const startDate = localDate(new Date(beginTs));
      const endDate = localDate(new Date(now));
      let dt = new Date(`${startDate}T12:00:00Z`);
      for (let i = 0; i < 14 && dt.toISOString().slice(0,10) <= endDate; i++) {
        const key = dt.toISOString().slice(0,10);
        bins.push({key,title:key,label:shortDate.format(new Date(key+'T17:00:00Z')),value:0});
        dt = new Date(dt.getTime()+86400000);
      }
      for (const e of data) {const bin = bins.find(b => b.key === e.fecha);if(bin) bin.value++;}
    }
    if (!bins.length) {parent.append(el('div','empty-plot','No hay eventos para graficar.'));return;}
    set('timelineDescription',hourly?'Por hora local':'Por día');
    set('timelineTotal',`${num(data.length)} eventos`);
    const W = 720,H = 236,left = 45,right=18,top=13,bottom=37,plotW=W-left-right,plotH=H-top-bottom;
    const svg = svgNode('svg',{class:'svg-timeline',viewBox:`0 0 ${W} ${H}`,role:'img','aria-label':'Gráfica de barras de actividad sísmica por fecha'});
    const maxV = Math.max(...bins.map(b=>b.value),1);
    const nice = maxV<=4 ? 4 : Math.ceil(maxV / 4) * 4;
    for(let tick=0;tick<=4;tick++) {
      const y=top+plotH-tick*plotH/4;
      svg.append(svgNode('line',{x1:left,y1:y,x2:W-right,y2:y,class:'chart-gridline'}));
      svg.append(svgNode('text',{x:left-12,y:y+4,'text-anchor':'end',class:'chart-label'},String(Math.round(nice*tick/4))));
    }
    const spacing=plotW/bins.length,barWidth=Math.max(5,Math.min(43,spacing*.59));
    bins.forEach((bin,i) => {
      const x=left+i*spacing+(spacing-barWidth)/2;
      const height=bin.value/nice*plotH;
      const rect=svgNode('rect',{class:'plot-bar',x,y:top+plotH-height,width:barWidth,height:Math.max(0,height),rx:2});
      rect.append(svgNode('title',{},`${bin.title}: ${bin.value} sismo${bin.value===1?'':'s'}`));
      svg.append(rect);
      const interval = Math.max(1,Math.ceil(bins.length/8));
      if(i%interval===0 || i===bins.length-1) svg.append(svgNode('text',{class:'chart-label',x:x+barWidth/2,y:H-13,'text-anchor':'middle'},bin.label));
    });
    parent.append(svg);
  }
  function makeBars(target, data, max, limit) {
    const holder = ui[target];
    holder.replaceChildren();
    const counter = new Map();
    data.forEach(e => {const key = target === 'townBars' ? e.localidad : e.zona; counter.set(key,(counter.get(key)||0)+1);});
    const list = [...counter].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0],'es')).slice(0,limit);
    if(!list.length){if(target==='regionBars')set('regionCount','0 regiones');holder.append(el('div','empty-plot','No hay sismos con esos filtros.'));return;}
    const maximum = Math.max(...list.map(x=>x[1]),1);
    for(const [name,count] of list) {
      if(target==='townBars') {
        const row = el('div','bar-row');
        const labels=el('div','bar-labels');
        labels.append(el('span','',name),el('strong','',num(count)));
        const track=el('div','bar-track');const fill=el('div','bar-fill');fill.style.width=`${Math.max(2,count/maximum*100)}%`;track.append(fill);
        row.append(labels,track);holder.append(row);
      } else {
        const block=el('div','region-item'); const title=el('div','region-item-head');
        title.append(el('span','',name),el('b','',num(count)));
        const track=el('div','region-progress');const fill=el('div');fill.style.width=`${Math.max(2,count/maximum*100)}%`;track.append(fill);
        block.append(title,track);holder.append(block);
      }
    }
    if(target==='regionBars')set('regionCount',`${counter.size} regiones`);
  }
  function makePopup(event) {
    const link=event.detalle?`<a href="${safe(event.detalle)}" target="_blank" rel="noopener noreferrer">Ficha oficial ↗</a>`:'';
    return `<div><b>M ${magText(event.magnitud)}</b><br>${safe(event.region)}<br><small>${safe(fullDate.format(new Date(event.timestamp)))} · ${safe(event.profundidad)} km</small><br>${link}</div>`;
  }
  function drawMap(data) {
    const mapped = data.filter(e => Number.isFinite(e.latitud)&&Number.isFinite(e.longitud)&&Math.abs(e.latitud)<=90&&Math.abs(e.longitud)<=180);
    set('mapCount',`${num(mapped.length)} epicentros`);
    if(typeof window.L !== 'undefined') {
      try {
        if(!state.map) {
          ui.map.replaceChildren();
          state.map=L.map(ui.map,{zoomControl:true,preferCanvas:true,scrollWheelZoom:false}).setView([8.55,-80.9],7);
          L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:17,attribution:'&copy; OpenStreetMap · Cartografía solamente'}).addTo(state.map);
          state.layer=L.layerGroup().addTo(state.map);
          state.renderer=L.canvas({padding:0.5});
          setTimeout(()=>state.map.invalidateSize(),100);
        }
        state.layer.clearLayers();
        const bounds=[];
        mapped.forEach(e => {
          const c=magColor(e.magnitud);
          const dot=L.circleMarker([e.latitud,e.longitud],{renderer:state.renderer,radius:Math.min(13,Math.max(3.5,3+e.magnitud*1.0)),color:c,weight:1,fillColor:c,fillOpacity:.64});
          dot.bindPopup(makePopup(e));dot.addTo(state.layer);bounds.push([e.latitud,e.longitud]);
        });
        if(bounds.length)state.map.fitBounds(bounds,{padding:[30,30],maxZoom:10});
        else state.map.setView([8.55,-80.9],7);
        return;
      } catch (err) {console.warn('Mapa cartográfico no disponible; activando mapa por coordenadas.',err);}
    }
    drawCoordinateMap(mapped);
  }
  function drawCoordinateMap(data) {
    if(!ui.mapFallback.isConnected)ui.map.replaceChildren(ui.mapFallback);
    const holder=ui.coordinateMap;holder.replaceChildren();
    const svg=svgNode('svg',{viewBox:'0 0 660 340',class:'coordinates-svg',role:'img','aria-label':'Ubicación aproximada de epicentros en un plano de latitud y longitud'});
    const W=660,H=340,l=57,r=17,t=13,b=35,valid=data.filter(e=>e.latitud>-10&&e.latitud<25&&e.longitud>-105&&e.longitud<-70);
    const lngs=valid.map(e=>e.longitud),lats=valid.map(e=>e.latitud);
    const minX=valid.length?Math.floor(Math.min(...lngs)-.5):-86;
    const maxX=valid.length?Math.ceil(Math.max(...lngs)+.5):-77;
    const minY=valid.length?Math.floor(Math.min(...lats)-.5):6;
    const maxY=valid.length?Math.ceil(Math.max(...lats)+.5):11;
    for(let i=0;i<=5;i++){
      const x=l+(W-l-r)*i/5;const y=t+(H-t-b)*i/5;
      svg.append(svgNode('line',{x1:x,y1:t,x2:x,y2:H-b,stroke:'#345062','stroke-dasharray':'2,6'}));
      svg.append(svgNode('line',{x1:l,y1:y,x2:W-r,y2:y,stroke:'#345062','stroke-dasharray':'2,6'}));
      svg.append(svgNode('text',{x,y:H-13,'text-anchor':'middle'},(minX+(maxX-minX)*i/5).toFixed(1)+'°'));
      svg.append(svgNode('text',{x:l-10,y:y+4,'text-anchor':'end'},(maxY-(maxY-minY)*i/5).toFixed(1)+'°'));
    }
    for(const e of valid){
      const x=l+(e.longitud-minX)/(maxX-minX||1)*(W-l-r);
      const y=t+(maxY-e.latitud)/(maxY-minY||1)*(H-t-b);
      const circle=svgNode('circle',{cx:x,cy:y,r:Math.max(3,Math.min(9,3+e.magnitud)),fill:magColor(e.magnitud)});
      circle.append(svgNode('title',{},`M ${magText(e.magnitud)} · ${e.region}`));
      svg.append(circle);
    }
    holder.append(svg);
  }
  function addCell(row, child, classname) {
    const td=el('td',classname||'');
    if(typeof child==='string')td.textContent=child;
    else td.append(child);
    row.append(td);
    return td;
  }
  function drawTable(data) {
    const total=data.length,pages=Math.max(1,Math.ceil(total/LIMIT));
    state.page=Math.max(1,Math.min(pages,state.page));
    const begin=(state.page-1)*LIMIT;
    const entries=data.slice(begin,begin+LIMIT);
    ui.recordsBody.replaceChildren();
    for(const e of entries) {
      const row=el('tr');
      const date=el('div','cell-date');date.append(el('strong','',e.fecha),el('span','',e.hora+' · PAN'));addCell(row,date);
      addCell(row,el('span','mag-chip '+magnitudeClass(e.magnitud),magText(e.magnitud)));
      const place=el('div','cell-place');place.append(el('strong','',e.localidad),el('span','',e.region));addCell(row,place);
      addCell(row,`${e.profundidad} km`);
      addCell(row,el('span','state-chip '+(e.estado.toUpperCase()==='REVISADO'?'revisado':''),e.estado));
      const cell=addCell(row,'','align-right');
      const link=el('a','table-link','Ver ↗');link.href=e.detalle||SOURCE;link.target='_blank';link.rel='noopener noreferrer';link.title='Consultar detalle en fuente oficial';cell.append(link);
      ui.recordsBody.append(row);
    }
    if(!entries.length){const row=el('tr');const td=el('td','empty-table','No hay registros que coincidan con los filtros.');td.colSpan=6;row.append(td);ui.recordsBody.append(row);}
    set('paginationText', total?`Mostrando ${num(begin+1)}–${num(Math.min(total,begin+LIMIT))} de ${num(total)}`:'No hay registros');
    set('pageNum',`${state.page} / ${pages}`);
    ui.pagePrev.disabled=state.page<=1;
    ui.pageNext.disabled=state.page>=pages;
  }
  function render() {
    if(!state.events.length)return;
    const base=state.events.filter(e=>passesBase(e));
    const filtered=sortedData();
    renderStats(base,filtered);
    drawTimeline(filtered);
    makeBars('townBars',filtered,0,9);
    makeBars('regionBars',filtered,0,9);
    drawMap(filtered);
    drawTable(filtered);
  }
  function reset() {
    f.period.value='168';f.zone.value='';f.town.value='';f.mag.value='';f.depth.value='';f.status.value='';f.from.value='';f.to.value='';f.search.value='';f.sort.value='recent';
    state.page=1;updateTowns('');render();
  }
  function csvCell(v){let t=String(v??'');if(/^[=+@\-\t\r]/.test(t)&& !/^[-]?\d+(\.\d+)?$/.test(t)) t="'"+t;return '"'+t.replace(/"/g,'""')+'"';}
  function exportCsv() {
    const data=sortedData();
    if(!data.length){message('Nada que exportar','No hay eventos correspondientes a los filtros actuales.');return;}
    const header=['Fecha','Hora local Panamá','Magnitud','Profundidad km','Región IGC-UP','Localidad de referencia','Latitud','Longitud','Estado','Enlace oficial'];
    const rows=data.map(e=>[e.fecha,e.hora,e.magnitud.toFixed(1),e.profundidad,e.zona,e.localidad,e.latitud,e.longitud,e.estado,e.detalle||SOURCE]);
    const csv='\uFEFF'+[header,...rows].map(row=>row.map(csvCell).join(';')).join('\r\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`sismos_igc_${localDate(new Date())}.csv`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),500);
  }
  function wire() {
    const list=[f.period,f.zone,f.town,f.mag,f.depth,f.status,f.from,f.to,f.sort];
    list.forEach(field=>field.addEventListener('change',()=>{state.page=1;if(field===f.zone||field===f.period||field===f.depth||field===f.status||field===f.from||field===f.to)updateTowns();render();}));
    f.search.addEventListener('input',()=>{state.page=1;updateTowns();render();});
    document.querySelectorAll('[data-magnitude]').forEach(btn=>btn.addEventListener('click',()=>{f.mag.value=(f.mag.value===btn.dataset.magnitude?'':btn.dataset.magnitude);state.page=1;render();}));
    ui.resetBtn.addEventListener('click',reset);
    ui.refreshBtn.addEventListener('click',()=>loadData());
    ui.alertRetry.addEventListener('click',()=>loadData());
    ui.csvBtn.addEventListener('click',exportCsv);
    ui.pagePrev.addEventListener('click',()=>{state.page--;drawTable(sortedData());});
    ui.pageNext.addEventListener('click',()=>{state.page++;drawTable(sortedData());});
  }
  wire();
  elapsedTime();
  setInterval(elapsedTime,1000);
  setInterval(()=>loadData(true),INTERVAL_MS);
  loadData();
})();
