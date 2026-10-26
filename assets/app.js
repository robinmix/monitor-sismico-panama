(() => {
  'use strict';
  const APP_BUILD_VERSION = '20261025syntaxfix1';
  console.info(`[sismoPA] Monitor Sísmico activo (${APP_BUILD_VERSION})`);
  const TZ = 'America/Panama';
  const IS_LOCAL = typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  const PROD_BASE = 'https://sismospma.netlify.app';

  const API = '/api/sismos';
  const HISTORICO_API = IS_LOCAL
    ? `${PROD_BASE}/api/historico-sismos`
    : '/api/historico-sismos';
  const DETALLE_API = IS_LOCAL
    ? `${PROD_BASE}/api/detalle-sismo`
    : '/api/detalle-sismo';
  const SOURCE = 'https://sismosgeociencias.up.ac.pa/';
  const INTERVAL_MS = 5 * 60 * 1000;
  const LIMIT = 25;
  const COLORS = ['#31E8D0', '#39E59A', '#FF9A32', '#FF5266'];
  const NEUTRAL_COLOR = '#839AB5';
  const ui = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, el]));
  const state = {
    events: [],
    source: null,
    loading: false,
    page: 1,
    map: null,
    layer: null,
    generalMapLibre: null,
    generalMapLoaded: false,
    generalMapSource: null,
    generalMapPopup: null,
    generalResizeObs: null,
    hasFitted: false,
    initialized: false,
    sismoMap: null,
    sismoLayer: null,
    sismoMapLibre: null,
    sismoMapLoaded: false,
    sismoPopup: null,
    sismoResizeObs: null,
    currentSismoId: null,
    historicalData: null,
    historicalLoading: false,
    historicalRequestId: 0,
    historicalAbortCtrl: null,
    lastHistoricalKey: null,
    userCoords: null,
    userLeafletMarker: null,
    deferredPwaPrompt: null,
    activeMobileTab: 'sismos'
  };
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
  const isValidMag = mag => typeof mag === 'number' && !Number.isNaN(mag) && mag > 0;
  const magnitudeClass = mag => {
    if (!isValidMag(mag)) return 'mNeutral';
    if (mag >= 5.0) return 'm5';
    if (mag >= 4.0) return 'm4';
    if (mag >= 3.0) return 'm3';
    return 'mBelow';
  };
  const getThemeColors = () => {
    const isLight = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light';
    return isLight
      ? ['#0F766E', '#15803D', '#C2410C', '#DC2626']
      : ['#31E8D0', '#39E59A', '#FF9A32', '#FF5266'];
  };
  const magColor = mag => {
    if (!isValidMag(mag)) return (typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light' ? '#52647A' : NEUTRAL_COLOR);
    const colors = getThemeColors();
    if (mag >= 5.0) return colors[3];
    if (mag >= 4.0) return colors[2];
    if (mag >= 3.0) return colors[1];
    return colors[0];
  };
  const magText = n => Number(n).toFixed(1);
  const pct = (a, total) => total ? `${Math.round(a / total * 100)}%` : '0%';
  const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const buckets = data => [data.filter(e => e.magnitud < 3).length, data.filter(e => e.magnitud >= 3 && e.magnitud < 4).length, data.filter(e => e.magnitud >= 4 && e.magnitud < 5).length, data.filter(e => e.magnitud >= 5).length];
  const sortNames = arr => arr.sort((a,b) => a.localeCompare(b,'es',{sensitivity:'base'}));
  const getEventUid = e => e.source_uid || e.uid || ('igc_' + (e.timestamp || e.fecha_hora));

  // Constante y utilidades geodésicas Haversine (R = 6371.0088 km según IUGG)
  const EARTH_RADIUS_KM = 6371.0088;
  function haversineKm(lat1, lon1, lat2, lon2) {
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
    const nLat1 = Number(lat1);
    const nLon1 = Number(lon1);
    const nLat2 = Number(lat2);
    const nLon2 = Number(lon2);
    if (isNaN(nLat1) || isNaN(nLon1) || isNaN(nLat2) || isNaN(nLon2)) return null;
    if (nLat1 < -90 || nLat1 > 90 || nLat2 < -90 || nLat2 > 90) return null;
    if (nLon1 < -180 || nLon1 > 180 || nLon2 < -180 || nLon2 > 180) return null;
    const toRad = deg => (deg * Math.PI) / 180;
    const dLat = toRad(nLat2 - nLat1);
    const dLon = toRad(nLon2 - nLon1);
    const sinDLat2 = Math.sin(dLat / 2);
    const sinDLon2 = Math.sin(dLon / 2);
    const a = sinDLat2 * sinDLat2 +
              Math.cos(toRad(nLat1)) * Math.cos(toRad(nLat2)) *
              sinDLon2 * sinDLon2;
    const clampedA = Math.min(1, Math.max(0, a));
    return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(clampedA), Math.sqrt(1 - clampedA));
  }

  function formatDistanceKm(km) {
    if (km == null || isNaN(km) || km < 0) return '';
    return `${Number(km).toFixed(1)} km`;
  }

  function formatCardDate(fecha, hora) {
    let datePart = fecha || '';
    if (fecha && String(fecha).includes('-')) {
      const parts = String(fecha).split('-');
      if (parts.length === 3) datePart = `${parts[2]}/${parts[1]}`;
    }
    let timePart = '';
    if (hora) {
      const m = String(hora).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)?$/i);
      timePart = m ? `${m[1]}:${m[2]}${m[3] ? ' ' + m[3].toUpperCase() : ''}` : String(hora).slice(0, 5);
    }
    return timePart ? `${datePart} · ${timePart}` : (datePart || '—');
  }

  function updateUserDistanceDisplay() {
    if (!ui.userDistanceCard) return;
    if (state.userCoords && state.events.length) {
      const e = state.events[0];
      const lat = Number(e.latitud ?? e.lat);
      const lon = Number(e.longitud ?? e.lon);
      const d = haversineKm(state.userCoords.lat, state.userCoords.lon, lat, lon);
      if (d != null) {
        set('distValue', formatDistanceKm(d));
        if (ui.distUnprompted) ui.distUnprompted.hidden = true;
        if (ui.distActive) ui.distActive.hidden = false;
        if (ui.distStatus) ui.distStatus.hidden = true;
        return;
      }
    }
    if (ui.distUnprompted) ui.distUnprompted.hidden = false;
    if (ui.distActive) ui.distActive.hidden = true;
  }

  function requestUserLocation() {
    if (!('geolocation' in navigator)) {
      if (ui.distStatus) {
        ui.distStatus.textContent = 'Tu navegador no soporta geolocalización.';
        ui.distStatus.hidden = false;
      }
      return;
    }
    if (ui.distStatus) {
      ui.distStatus.textContent = 'Consultando ubicación del dispositivo…';
      ui.distStatus.hidden = false;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        // Almacenamiento EXCLUSIVO en memoria de sesión (sin persistencia en localStorage ni servidores)
        state.userCoords = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude
        };
        if (ui.distStatus) ui.distStatus.hidden = true;
        updateUserDistanceDisplay();
        render();
        updateUserLocationOnMap();
        if (state.currentSismoId) {
          updateFichaDistance();
        }
      },
      (err) => {
        let msg = 'No se pudo obtener tu ubicación.';
        if (err.code === 1) msg = 'Permiso de ubicación no concedido.';
        else if (err.code === 2) msg = 'Ubicación no disponible.';
        else if (err.code === 3) msg = 'Tiempo de espera agotado al consultar ubicación.';
        if (ui.distStatus) {
          ui.distStatus.textContent = msg;
          ui.distStatus.hidden = false;
          setTimeout(() => { if (!state.userCoords && ui.distStatus) ui.distStatus.hidden = true; }, 5000);
        }
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
    );
  }

  function disableUserLocation() {
    state.userCoords = null;
    if (ui.distActive) ui.distActive.hidden = true;
    if (ui.distUnprompted) ui.distUnprompted.hidden = false;
    if (ui.distStatus) ui.distStatus.hidden = true;
    updateUserDistanceDisplay();
    render();
    updateUserLocationOnMap();
    if (ui.sismoDistanceParam) ui.sismoDistanceParam.hidden = true;
  }

  function updateFichaDistance(e, lat, lon) {
    if (!ui.sismoDistanceParam) return;
    if (!state.userCoords) {
      ui.sismoDistanceParam.hidden = true;
      return;
    }
    const evt = e || (state.events.find(x => getEventUid(x) === state.currentSismoId));
    if (!evt) return;
    const evtLat = lat != null ? lat : Number(evt.latitud ?? evt.lat);
    const evtLon = lon != null ? lon : Number(evt.longitud ?? evt.lon);
    const d = haversineKm(state.userCoords.lat, state.userCoords.lon, evtLat, evtLon);
    if (d != null) {
      ui.sismoDistanceParam.hidden = false;
      ui.sismoDistanceVal.textContent = `A ${formatDistanceKm(d)} de tu ubicación`;
    } else {
      ui.sismoDistanceParam.hidden = true;
    }
  }

  function updateUserLocationOnMap() {
    if (state.generalMapLibre && state.generalMapLoaded) {
      const map = state.generalMapLibre;
      const geojson = state.userCoords ? {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [state.userCoords.lon, state.userCoords.lat]
          },
          properties: {
            title: 'Tu ubicación aproximada'
          }
        }]
      } : {
        type: 'FeatureCollection',
        features: []
      };

      const src = map.getSource('user-location-src');
      if (src) {
        src.setData(geojson);
      } else if (state.userCoords) {
        map.addSource('user-location-src', {
          type: 'geojson',
          data: geojson
        });

        map.addLayer({
          id: 'user-location-halo',
          type: 'circle',
          source: 'user-location-src',
          paint: {
            'circle-radius': 14,
            'circle-color': '#36DDF3',
            'circle-opacity': 0.22,
            'circle-stroke-width': 1.5,
            'circle-stroke-color': '#36DDF3',
            'circle-stroke-opacity': 0.5
          }
        });

        map.addLayer({
          id: 'user-location-dot',
          type: 'circle',
          source: 'user-location-src',
          paint: {
            'circle-radius': 5.5,
            'circle-color': '#36DDF3',
            'circle-stroke-width': 2,
            'circle-stroke-color': '#0B1116'
          }
        });
      }
    }

    if (state.map && typeof L !== 'undefined') {
      if (state.userLeafletMarker) {
        state.map.removeLayer(state.userLeafletMarker);
        state.userLeafletMarker = null;
      }
      if (state.userCoords) {
        state.userLeafletMarker = L.circleMarker([state.userCoords.lat, state.userCoords.lon], {
          radius: 7,
          fillColor: '#36DDF3',
          color: '#ffffff',
          weight: 2,
          opacity: 1,
          fillOpacity: 0.9
        }).addTo(state.map);
      }
    }
  }

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
    ui.sourceStatus.title = text;
    ui.sourceStatus.setAttribute('aria-label', text);
    const textEl = ui.sourceStatus.querySelector('.status-text');
    if (textEl) {
      textEl.textContent = text;
    } else {
      ui.sourceStatus.lastChild.textContent = ` ${text}`;
    }
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
        .map(e => ({
          ...e,
          uid: getEventUid(e),
          magnitud: Number(e.magnitud),
          profundidad: Number(e.profundidad),
          latitud: Number(e.latitud),
          longitud: Number(e.longitud)
        }))
        .sort(byDateDesc);
      if (!normalized.length) throw new Error('La fuente devolvió registros sin fecha válida.');
      state.events = normalized;
      state.source = payload;
      populateChoices();
      renderLatest();
      render();
      handleRouting();
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
        message('No se pudieron obtener los datos del IGC-UP', `${err.message}. Este proyecto necesita las funciones de servidor activas para consultar los sismos.`);
        set('snapshotStatus','Sin conexión con la fuente');
      }
    } finally {
      state.loading = false;
      ui.refreshBtn.disabled = false;
    }
  }

  
  function formatRelativeTime(timestamp) {
    if (!timestamp) return '—';
    const diffMs = Date.now() - new Date(timestamp).getTime();
    if (diffMs < 0) return 'Hace un momento';
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHours = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffDays > 0) {
      const remHours = diffHours % 24;
      return diffDays === 1 
        ? (remHours > 0 ? `Hace 1 d ${remHours} h` : 'Hace 1 día')
        : `Hace ${diffDays} días`;
    }
    if (diffHours > 0) {
      const remMin = diffMin % 60;
      return `Hace ${diffHours} h ${remMin} min`;
    }
    if (diffMin > 0) {
      return `Hace ${diffMin} min`;
    }
    return 'Hace unos segundos';
  }

  function formatCardTimestamp(timestamp) {
    if (!timestamp) return '—';
    const d = new Date(timestamp);
    const now = new Date();
    const panamaNow = new Date(now.getTime() - (5 * 3600000));
    const panamaD = new Date(d.getTime() - (5 * 3600000));
    
    const isToday = panamaNow.getUTCDate() === panamaD.getUTCDate() &&
                    panamaNow.getUTCMonth() === panamaD.getUTCMonth() &&
                    panamaNow.getUTCFullYear() === panamaD.getUTCFullYear();
                    
    const yesterday = new Date(panamaNow.getTime() - 86400000);
    const isYesterday = yesterday.getUTCDate() === panamaD.getUTCDate() &&
                        yesterday.getUTCMonth() === panamaD.getUTCMonth() &&
                        yesterday.getUTCFullYear() === panamaD.getUTCFullYear();

    let hours = panamaD.getUTCHours();
    const minutes = String(panamaD.getUTCMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'p. m.' : 'a. m.';
    hours = hours % 12 || 12;
    const timeStr = `${hours}:${minutes} ${ampm}`;

    if (isToday) return `Hoy, ${timeStr}`;
    if (isYesterday) return `Ayer, ${timeStr}`;
    
    const day = panamaD.getUTCDate();
    const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    const month = months[panamaD.getUTCMonth()];
    return `${day} ${month}, ${timeStr}`;
  }

  function magnitudeCategoryName(mag) {
    const m = Number(mag);
    if (m >= 5.0) return 'Fuerte';
    if (m >= 4.0) return 'Moderado';
    if (m >= 3.0) return 'Ligero';
    return 'Menor';
  }

  function renderLatest() {
    const e = state.events[0];
    if (!e) return;
    set('latestMagnitude',magText(e.magnitud));
    set('latestState',e.estado);
    set('latestLevel',e.magnitud >= 5 ? 'MAGNITUD ≥5' : e.magnitud >=4 ? 'MAGNITUD 4.x' : e.magnitud >=3 ? 'MAGNITUD 3.x' : 'MAGNITUD <3');
    const latestLoc = e.geo_ubicacion_texto || e.region || 'Actividad sísmica reciente';
    set('latestRegion', latestLoc);
    set('latestDate',fullDate.format(new Date(e.timestamp)));
    set('latestDepth',`${e.profundidad} km de profundidad`);
    if (ui.lastEventPanel) {
      ui.lastEventPanel.dataset.magRange = magnitudeClass(e.magnitud);
    }
    if (ui.heroMagCircle) {
      ui.heroMagCircle.className = 'hero-circle-dial ' + magnitudeClass(e.magnitud);
    }
    if (ui.heroDetailBtn) {
      const uid = e.source_uid || e.id || `${e.fecha}|${e.hora}|${e.latitud}|${e.longitud}|${e.magnitud}`;
      ui.heroDetailBtn.href = `#/sismo/${encodeURIComponent(uid)}`;
    }
    elapsedTime();
    updateUserDistanceDisplay();
  }

  function renderStats(base, filtered) {
    const [low, three, four, five] = buckets(base);
    const all = base.length;
    const vals = [low,three,four,five];
    ['Below3','3','4','5'].forEach((k,i) => {set('stat'+k,num(vals[i]));set('pct'+k,pct(vals[i],all));set('legend'+k,num(vals[i]));});
    set('statTotal',num(all));
    set('statTotalHint',`${num(state.events.length)} en la lista de la fuente`);
    if (all) {
      const pLow = (low / all * 100);
      const p3 = (three / all * 100);
      const p4 = (four / all * 100);
      const p5 = (five / all * 100);
      const bLow = document.getElementById('distBarBelow3');
      const b3 = document.getElementById('distBar3');
      const b4 = document.getElementById('distBar4');
      const b5 = document.getElementById('distBar5');
      if (bLow) bLow.style.width = `${pLow}%`;
      if (b3) b3.style.width = `${p3}%`;
      if (b4) b4.style.width = `${p4}%`;
      if (b5) b5.style.width = `${p5}%`;
      set('distLeg3', `${Math.round(p3)}% Menores (M3.x)`);
      set('distLeg4', `${Math.round(p4)}% Moderados (M4.x)`);
      set('distLeg5', `${Math.round(p5)}% Fuertes (≥5)`);
    }
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
    const W = 520, H = 160, left = 36, right = 12, top = 10, bottom = 26, plotW = W - left - right, plotH = H - top - bottom;
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
    data.forEach(e => {
      let key;
      if (target === 'townBars') {
        key = e.geo_poblado_ref || e.localidad || 'Sin referencia';
      } else {
        key = e.geo_provincia || (e.geo_tipo === 'MARITIMO' ? (e.geo_zona_maritima ? 'Marítimo (' + e.geo_zona_maritima.split('(')[0].trim() + ')' : 'Marítimo') : (e.zona || 'Sin clasificar'));
      }
      counter.set(key, (counter.get(key) || 0) + 1);
    });
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
    const uid = getEventUid(event);
    return `<div class="popup-card">
      <div class="popup-top">
        <span class="popup-mag ${magnitudeClass(event.magnitud)}" style="color:${magColor(event.magnitud)};">M ${magText(event.magnitud)}</span>
        <span class="popup-state mono">${safe(event.estado || '')}</span>
      </div>
      <div class="popup-title">${safe(event.geo_ubicacion_texto || event.region)}</div>
      <div class="popup-meta mono">
        <span>${safe(fullDate.format(new Date(event.timestamp)))}</span>
        <span>Profundidad: <b>${safe(event.profundidad)} km</b></span>
      </div>
      <div class="popup-actions">
        <a href="#/sismo/${encodeURIComponent(uid)}" class="popup-btn-epicenter">Ver ficha técnica →</a>
      </div>
    </div>`;
  }

  function drawMap(data) {
    const mapped = data.filter(e => Number.isFinite(e.latitud) && Number.isFinite(e.longitud) && Math.abs(e.latitud) <= 90 && Math.abs(e.longitud) <= 180);
    set('mapCount', `${num(mapped.length)} epicentros`);

    const hasMapLibre = typeof window.maplibregl !== 'undefined';
    const isSupported = hasMapLibre && (typeof maplibregl.supported === 'function' ? maplibregl.supported() : true);

    if (isSupported) {
      if (ui.generalMapFallback) ui.generalMapFallback.hidden = true;
      renderGeneralMapLibre(mapped);
      return;
    }

    if (typeof window.L !== 'undefined') {
      if (ui.generalMapFallback) ui.generalMapFallback.hidden = true;
      drawLeafletMap(mapped);
      return;
    }

    if (ui.generalMapFallback) ui.generalMapFallback.hidden = false;
    drawCoordinateMap(mapped);
  }

  function eventsToGeoJSON(events) {
    return {
      type: 'FeatureCollection',
      features: events.map(e => {
        const mag = Number(e.magnitud) || 0;
        const color = magColor(mag);
        const uid = getEventUid(e);
        return {
          type: 'Feature',
          geometry: {
            type: 'Point',
            coordinates: [Number(e.longitud), Number(e.latitud)]
          },
          properties: {
            uid: uid,
            mag: mag,
            color: color,
            radius: Math.min(14, Math.max(3.8, 2.5 + mag * 1.5)),
            region: e.region || '',
            localidad: e.localidad || '',
            profundidad: e.profundidad,
            estado: e.estado || '',
            timestamp: e.timestamp || '',
            fecha: e.fecha || '',
            hora: e.hora || '',
            detalle: e.detalle || '',
            geo_tipo: e.geo_tipo || '',
            geo_provincia: e.geo_provincia || '',
            geo_ubicacion_texto: e.geo_ubicacion_texto || '',
            geo_zona_maritima: e.geo_zona_maritima || '',
            geo_poblado_ref: e.geo_poblado_ref || ''
          }
        };
      })
    };
  }

  async function renderGeneralMapLibre(mapped) {
    const geojsonData = eventsToGeoJSON(mapped);

    // Si el mapa ya está cargado, actualizar los datos del source GeoJSON reactivamente
    if (state.generalMapLibre && state.generalMapLoaded) {
      const src = state.generalMapLibre.getSource('general-epicenters');
      if (src) {
        src.setData(geojsonData);
      }
      return;
    }

    // Si ya se está inicializando, guardar para cuando termine
    if (state.generalMapLibre && !state.generalMapLoaded) {
      return;
    }

    const container = ui.map;
    if (!container) return;
    container.replaceChildren();

    const style = await loadCustomOfmStyle();

    const map = new maplibregl.Map({
      container: container,
      style: style,
      center: [-80.2, 8.4],
      zoom: 6.8,
      minZoom: 5.5,
      maxZoom: 16,
      maxBounds: [[-86.5, 4.5], [-75.0, 12.0]],
      attributionControl: false
    });

    state.generalMapLibre = map;
    if (typeof window !== 'undefined') window.__generalMapLibre = map;
    if (IS_LOCAL && typeof window !== 'undefined') {
      window.__sismoState = state;
      window.__updateUserDistanceDisplay = updateUserDistanceDisplay;
      window.__render = render;
    }

    // Controles de navegación y atribución
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true }), 'bottom-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');

    map.on('load', () => {
      state.generalMapLoaded = true;

      // 1. Límites de placas tectónicas (PB2002)
      map.addSource('general-tectonic-boundaries', {
        type: 'geojson',
        data: 'assets/data/tectonic-boundaries.geojson'
      });
      map.addLayer({
        id: 'general-tectonic-boundaries-line',
        type: 'line',
        source: 'general-tectonic-boundaries',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'visibility': ui.generalTogglePlates?.checked !== false ? 'visible' : 'none'
        },
        paint: {
          'line-color': '#C68BEB',
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.4, 8, 2.4, 12, 3.5],
          'line-opacity': 0.85
        }
      });

      // 2. Etiquetas de placas tectónicas
      map.addSource('general-tectonic-labels', {
        type: 'geojson',
        data: 'assets/data/tectonic-labels.geojson'
      });
      map.addLayer({
        id: 'general-tectonic-labels-text',
        type: 'symbol',
        source: 'general-tectonic-labels',
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 11,
          'text-letter-spacing': 0.08,
          'text-max-width': 8,
          'visibility': ui.generalToggleLabels?.checked !== false ? 'visible' : 'none'
        },
        paint: {
          'text-color': '#C68BEB',
          'text-halo-color': '#111417',
          'text-halo-width': 1.6
        }
      });

      // 3. Fallas geológicas activas (GEM)
      map.addSource('general-geological-faults', {
        type: 'geojson',
        data: 'assets/data/geological-faults.geojson'
      });
      map.addLayer({
        id: 'general-geological-faults-line',
        type: 'line',
        source: 'general-geological-faults',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'visibility': ui.generalToggleFaults?.checked !== false ? 'visible' : 'none'
        },
        paint: {
          'line-color': '#D99B69',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 8, 1.5, 12, 2.4],
          'line-dasharray': [3, 2],
          'line-opacity': 0.75
        }
      });

      // 4. Epicentros registrados
      map.addSource('general-epicenters', {
        type: 'geojson',
        data: geojsonData
      });

      // Halo sutil bajo círculos para mejorar contraste
      map.addLayer({
        id: 'general-epicenters-halo',
        type: 'circle',
        source: 'general-epicenters',
        layout: {
          'visibility': ui.generalToggleEpicenters?.checked !== false ? 'visible' : 'none'
        },
        paint: {
          'circle-radius': ['get', 'radius'],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.25,
          'circle-blur': 0.4
        }
      });

      // Puntos de epicentro
      map.addLayer({
        id: 'general-epicenters-circle',
        type: 'circle',
        source: 'general-epicenters',
        layout: {
          'visibility': ui.generalToggleEpicenters?.checked !== false ? 'visible' : 'none'
        },
        paint: {
          'circle-radius': ['get', 'radius'],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.85,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 0.8,
          'circle-stroke-opacity': 0.8
        }
      });

      // Popup interactivo al hacer clic
      const popup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: true,
        offset: 12,
        className: 'maplibre-sismo-popup'
      });
      state.generalMapPopup = popup;

      map.on('click', 'general-epicenters-circle', (e) => {
        if (!e.features || !e.features.length) return;
        const feat = e.features[0];
        const props = feat.properties;
        const coords = feat.geometry.coordinates.slice();

        const tsDate = props.timestamp ? new Date(props.timestamp) : null;
        const dateStr = tsDate && !isNaN(tsDate) ? fullDate.format(tsDate) : (props.fecha + ' ' + props.hora);

        const html = `<div class="popup-card">
          <div class="popup-top">
            <span class="popup-mag ${magnitudeClass(props.mag)}" style="color:${props.color};">M ${magText(props.mag)}</span>
            <span class="popup-state mono">${safe(props.estado)}</span>
          </div>
          <div class="popup-title">${safe(props.geo_ubicacion_texto || props.region)}</div>
          <div class="popup-meta mono">
            <span>${safe(dateStr)}</span>
            <span>Profundidad: <b>${props.profundidad} km</b></span>
          </div>
          <div class="popup-actions">
            <a href="#/sismo/${encodeURIComponent(props.uid)}" class="popup-btn-epicenter">Ver ficha técnica →</a>
          </div>
        </div>`;

        popup.setLngLat(coords).setHTML(html).addTo(map);
      });

      map.on('mouseenter', 'general-epicenters-circle', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'general-epicenters-circle', () => {
        map.getCanvas().style.cursor = '';
      });

      updateUserLocationOnMap();
      map.resize();
    });

    if (typeof ResizeObserver !== 'undefined' && ui.generalMapWrap && !state.generalResizeObs) {
      state.generalResizeObs = new ResizeObserver(() => {
        if (state.generalMapLibre) state.generalMapLibre.resize();
      });
      state.generalResizeObs.observe(ui.generalMapWrap);
    }
  }

  function drawLeafletMap(mapped) {
    try {
      if (!state.map) {
        ui.map.replaceChildren();
        state.map = L.map(ui.map, {
          zoomControl: true,
          preferCanvas: true,
          scrollWheelZoom: false
        }).setView([8.4, -80.2], 7);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 17,
          attribution: '&copy; OpenStreetMap · Cartografía solamente'
        }).addTo(state.map);

        state.layer = L.layerGroup().addTo(state.map);
        state.renderer = L.canvas({ padding: 0.5 });
        setTimeout(() => state.map.invalidateSize(), 100);
      }
      state.layer.clearLayers();
      mapped.forEach(e => {
        const c = magColor(e.magnitud);
        const dot = L.circleMarker([e.latitud, e.longitud], {
          renderer: state.renderer,
          radius: Math.min(13, Math.max(3.5, 3 + e.magnitud * 1.0)),
          color: c,
          weight: 1,
          fillColor: c,
          fillOpacity: 0.64
        });
        dot.bindPopup(makePopup(e));
        dot.addTo(state.layer);
      });
      state.map.setView([8.4, -80.2], 7);
      updateUserLocationOnMap();
    } catch (err) {
      console.warn('Mapa Leaflet no disponible; activando mapa por coordenadas.', err);
      drawCoordinateMap(mapped);
    }
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
      svg.append(svgNode('line',{x1:x,y1:t,x2:x,y2:H-b,stroke:'#2B353D','stroke-dasharray':'2,4'}));
      svg.append(svgNode('line',{x1:l,y1:y,x2:W-r,y2:y,stroke:'#2B353D','stroke-dasharray':'2,4'}));
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

  function syncRecordsA11y() {
    if (typeof window === 'undefined') return;
    const isMobile = window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
    if (ui.desktopRecordsWrap) ui.desktopRecordsWrap.setAttribute('aria-hidden', isMobile ? 'true' : 'false');
    if (ui.mobileRecordsList) ui.mobileRecordsList.setAttribute('aria-hidden', isMobile ? 'false' : 'true');
  }

  function drawTable(data) {
    const total = data.length, pages = Math.max(1, Math.ceil(total / LIMIT));
    state.page = Math.max(1, Math.min(pages, state.page));
    const begin = (state.page - 1) * LIMIT;
    const entries = data.slice(begin, begin + LIMIT);
    ui.recordsBody.replaceChildren();
    if (ui.mobileRecordsList) ui.mobileRecordsList.replaceChildren();

    const hasUserGeo = Boolean(state.userCoords);
    if (ui.colDistanceTh) ui.colDistanceTh.hidden = !hasUserGeo;

    syncRecordsA11y();

    for (const e of entries) {
      const uid = getEventUid(e);
      let distFormatted = null;
      if (hasUserGeo) {
        const d = haversineKm(state.userCoords.lat, state.userCoords.lon, e.latitud ?? e.lat, e.longitud ?? e.lon);
        if (d != null) {
          distFormatted = formatDistanceKm(d);
        }
      }

      // --- FILA DE TABLA (VISTA ESCRITORIO) ---
      const row = el('tr');
      const date = el('div', 'cell-date');
      date.append(el('strong', '', e.fecha), el('span', '', e.hora + ' · PAN'));
      addCell(row, date);

      addCell(row, el('span', 'mag-chip ' + magnitudeClass(e.magnitud), magText(e.magnitud)));

      const place = el('div', 'cell-place');
      const deskTitle = e.geo_tipo === 'MARITIMO'
        ? (e.geo_zona_maritima || 'Marítimo')
        : (e.geo_corregimiento && e.geo_provincia
            ? (e.geo_corregimiento + ', ' + (e.geo_distrito ? e.geo_distrito + ' · ' : '') + e.geo_provincia)
            : (e.geo_provincia || e.localidad));
      const deskSub = e.geo_ubicacion_texto || e.region;
      place.append(el('strong', '', deskTitle || e.localidad), el('span', '', deskSub));
      if (hasUserGeo && distFormatted) {
        place.append(el('span', 'mobile-dist', ` · a ${distFormatted}`));
      }
      addCell(row, place);

      if (hasUserGeo) {
        addCell(row, el('span', 'cell-distance mono', distFormatted || '—'));
      }

      addCell(row, `${e.profundidad} km`);
      addCell(row, el('span', 'state-chip ' + (e.estado.toUpperCase() === 'REVISADO' ? 'revisado' : ''), e.estado));

      const cell = addCell(row, '', 'align-right');
      const fichaLink = el('a', 'table-action-btn', 'Ficha');
      fichaLink.href = `#/sismo/${encodeURIComponent(uid)}`;
      fichaLink.title = `Abrir ficha técnica del sismo M${e.magnitud} en ${e.localidad}`;
      cell.append(fichaLink);
      ui.recordsBody.append(row);

      // --- TARJETA COMPACTA RESPONSIVA (VISTA MÓVIL) ---
      if (ui.mobileRecordsList) {
        const card = el('article', 'sismo-mobile-card');

        // Badge circular de magnitud (a la izquierda)
        const magBadge = el('span', 'card-mag-badge ' + magnitudeClass(e.magnitud), magText(e.magnitud));
        card.append(magBadge);

        // Columna central con información del sismo
        const infoStack = el('div', 'card-info-stack');

        const placeRow = el('div', 'card-place-line');
        const primaryCardTitle = e.geo_tipo === 'MARITIMO'
          ? (e.geo_zona_maritima ? e.geo_zona_maritima.split('(')[0].trim() : 'Océano Pacífico')
          : (e.geo_tipo === 'INSULAR'
              ? (e.geo_poblado_ref || e.geo_corregimiento || e.localidad)
              : (e.geo_tipo === 'FRONTERIZO'
                  ? (e.geo_provincia || 'Región Fronteriza')
                  : (e.geo_corregimiento && e.geo_provincia
                      ? (e.geo_corregimiento + ', ' + e.geo_provincia)
                      : (e.geo_provincia || e.localidad))));

        placeRow.append(el('strong', 'card-place-name', primaryCardTitle || e.localidad));
        placeRow.append(el('span', 'state-chip ' + (e.estado.toUpperCase() === 'REVISADO' ? 'revisado' : ''), e.estado));
        infoStack.append(placeRow);

        const subCardText = e.geo_ubicacion_texto || e.region;
        infoStack.append(el('div', 'card-region-name', subCardText));

        // Metadatos técnicos (tiempo, profundidad, distancia)
        const paramsGrid = el('div', 'card-params-grid');

        const paramTime = el('div', 'card-param-item');
        paramTime.append(el('span', 'card-param-lbl', 'HORA (UTC−5)'));
        paramTime.append(el('span', 'card-param-txt mono', formatCardDate(e.fecha, e.hora)));
        paramsGrid.append(paramTime);

        const paramDepth = el('div', 'card-param-item');
        paramDepth.append(el('span', 'card-param-lbl', 'PROFUNDIDAD'));
        paramDepth.append(el('span', 'card-param-txt mono', `${e.profundidad} km`));
        paramsGrid.append(paramDepth);

        const paramDist = el('div', 'card-param-item');
        paramDist.append(el('span', 'card-param-lbl', 'DISTANCIA'));
        const distSpan = el('span', 'card-param-txt mono ' + (distFormatted ? 'dist-active' : 'dist-empty'));
        distSpan.textContent = distFormatted ? `📍 ${distFormatted}` : '📍 —';
        if (!distFormatted) distSpan.title = 'Ubicación no activada o no disponible';
        paramDist.append(distSpan);
        paramsGrid.append(paramDist);

        infoStack.append(paramsGrid);
        card.append(infoStack);

        // Botón de acción táctil Ver ficha técnica (a la derecha)
        const actionRow = el('div', 'card-action-row');
        const cardFichaLink = el('a', 'card-ficha-btn', 'Ficha ›');
        cardFichaLink.title = 'Ver ficha →';
        cardFichaLink.href = `#/sismo/${encodeURIComponent(uid)}`;
        cardFichaLink.setAttribute('aria-label', `Ver ficha técnica del sismo M${e.magnitud} en ${e.localidad}`);
        actionRow.append(cardFichaLink);
        card.append(actionRow);

        ui.mobileRecordsList.append(card);
      }
    }

    if (!entries.length) {
      const row = el('tr');
      const td = el('td', 'empty-table', 'No hay registros que coincidan con los filtros.');
      td.colSpan = hasUserGeo ? 7 : 6;
      row.append(td);
      ui.recordsBody.append(row);

      if (ui.mobileRecordsList) {
        const emptyDiv = el('div', 'empty-cards', 'No hay registros que coincidan con los filtros de búsqueda.');
        ui.mobileRecordsList.append(emptyDiv);
      }
    }

    set('paginationText', total ? `Mostrando ${num(begin + 1)}–${num(Math.min(total, begin + LIMIT))} de ${num(total)}` : 'No hay registros');
    set('pageNum', `${state.page} / ${pages}`);
    ui.pagePrev.disabled = state.page <= 1;
    ui.pageNext.disabled = state.page >= pages;
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
    const header=['Fecha','Hora local Panamá','Magnitud','Profundidad km','Región IGC-UP','Localidad de referencia','Latitud','Longitud','Estado','Identificador UID','Enlace oficial'];
    const rows=data.map(e=>[e.fecha,e.hora,magText(e.magnitud),e.profundidad,e.zona,e.localidad,e.latitud,e.longitud,e.estado,getEventUid(e),e.detalle||SOURCE]);
    const csv='\uFEFF'+[header,...rows].map(row=>row.map(csvCell).join(';')).join('\r\n');
    const blob=new Blob([csv],{type:'text/csv;charset=utf-8'});
    const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`sismos_igc_${localDate(new Date())}.csv`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),500);
  }

  /* ------------------------------------------------------------------------
     MÓDULO A — FICHA INDIVIDUAL DE EVENTO SÍSMICO
     ------------------------------------------------------------------------ */
  async function showSismoDetail(id) {
    if (!id) return;
    state.currentSismoId = id;
    ui.dashboardView.hidden = true;
    ui.sismoView.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });

    const cleanId = decodeURIComponent(id).trim();

    // 1. Buscar en eventos cargados en memoria
    const found = state.events.find(e =>
      getEventUid(e) === cleanId ||
      e.id === cleanId ||
      e.source_uid === cleanId ||
      ('igc_' + e.timestamp) === cleanId
    );

    if (found) {
      ui.sismoLoading.hidden = true;
      ui.sismoNotFound.hidden = true;
      ui.sismoCardContent.hidden = false;
      renderSismoDetail(found);
      return;
    }

    // 2. Si no está en memoria, consultar endpoint de detalle en Supabase
    ui.sismoLoading.hidden = false;
    ui.sismoNotFound.hidden = true;
    ui.sismoCardContent.hidden = true;

    try {
      const resp = await fetch(`${DETALLE_API}?id=${encodeURIComponent(cleanId)}`, {
        headers: { Accept: 'application/json' }
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data || !data.ok || !data.evento) {
        throw new Error(data?.error || 'Evento no encontrado en el archivo histórico');
      }

      const ev = data.evento;
      ui.sismoLoading.hidden = true;
      ui.sismoNotFound.hidden = true;
      ui.sismoCardContent.hidden = false;
      renderSismoDetail(ev);
    } catch (err) {
      ui.sismoLoading.hidden = true;
      ui.sismoCardContent.hidden = true;
      ui.sismoNotFound.hidden = false;
    }
  }

  function closeSismoDetail(updateHash = true) {
    ui.sismoView.hidden = true;
    ui.dashboardView.hidden = false;
    if (updateHash && window.location.hash.startsWith('#/sismo/')) {
      const returnTab = state.activeMobileTab || 'sismos';
      window.location.hash = `#${returnTab}`;
    }
    setTimeout(() => {
      if (state.generalMapLibre) state.generalMapLibre.resize();
      if (state.map) state.map.invalidateSize();
    }, 150);
  }

  function renderSismoDetail(e) {
    const mag = Number(e.magnitud);
    const rawProf = e.profundidad !== undefined ? e.profundidad : e.profundidad_km;
    const prof = Number(rawProf);
    const ts = e.timestamp || e.fecha_hora;
    const dateObj = new Date(ts);
    const uid = getEventUid(e);

    // Magnitud y estado
    ui.sismoMagChip.textContent = `M ${magText(mag)}`;
    ui.sismoMagChip.className = `sismo-mag-chip ${magnitudeClass(mag)}`;
    ui.sismoStateChip.textContent = String(e.estado || 'REVISADO').toUpperCase();
    ui.sismoLevelText.className = `sismo-level-badge ${magnitudeClass(mag)}`;
    ui.sismoLevelText.textContent = mag >= 5 ? 'Sismo fuerte (M ≥ 5.0)' :
                                    mag >= 4 ? 'Sismo moderado (M 4.0–4.9)' :
                                    mag >= 3 ? 'Sismo menor (M 3.0–3.9)' :
                                    'Microactividad sísmica (M < 3.0)';

    // Título y ubicación
    const detailTitle = e.geo_tipo === 'MARITIMO'
      ? (e.geo_zona_maritima || e.region)
      : (e.geo_corregimiento && e.geo_distrito
          ? (e.geo_corregimiento + ', ' + e.geo_distrito + ' (' + e.geo_provincia + ')')
          : (e.geo_provincia || e.region));
    ui.sismoRegionTitle.textContent = detailTitle || e.region || 'Región geocientífica de Panamá';
    if (e.geo_ubicacion_texto) {
      ui.sismoLocationDesc.innerHTML = '';
      const geoSpan = document.createElement('span');
      geoSpan.className = 'geo-location-highlight';
      geoSpan.textContent = e.geo_ubicacion_texto;
      ui.sismoLocationDesc.appendChild(geoSpan);

      const igcDesc = e.ubicacion || e.region;
      if (igcDesc) {
        const igcSpan = document.createElement('span');
        igcSpan.className = 'sismo-igc-desc';
        igcSpan.textContent = ' · [Registro IGC: ' + igcDesc + ']';
        ui.sismoLocationDesc.appendChild(igcSpan);
      }
    } else {
      ui.sismoLocationDesc.textContent = e.ubicacion || e.region || 'Sin descripción adicional reportada';
    }

    // Parámetros técnicos
    const isValidDate = !isNaN(dateObj.getTime());
    ui.sismoTimeLocal.textContent = isValidDate ? `${fullDate.format(dateObj)}` : `${e.fecha || ''} ${e.hora || ''}`;
    ui.sismoTimeUtc.textContent = isValidDate ? `${dateObj.toISOString().replace('T', ' ').slice(0, 19)} UTC` : '—';
    ui.sismoDepth.textContent = isNaN(prof) ? '—' : `${prof} km`;
    ui.sismoDepthCat.textContent = isNaN(prof) ? 'Sin dato' : 'Profundidad hipocentral';

    const lat = Number(e.latitud);
    const lon = Number(e.longitud);
    const latStr = `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}`;
    const lonStr = `${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;
    ui.sismoCoordinates.textContent = `${latStr}, ${lonStr}`;
    ui.sismoCoordDecimal.textContent = `Latitud: ${lat.toFixed(5)} · Longitud: ${lon.toFixed(5)}`;
    ui.sismoMapCoords.textContent = `${lat.toFixed(3)}°, ${lon.toFixed(3)}° · ${prof} km`;

    if (e.geo_poblado_ref) {
      ui.sismoTown.className = 'param-val geo-location-highlight';
      ui.sismoTown.textContent = `${e.geo_poblado_ref} (${e.geo_distancia_km} km ${e.geo_rumbo || ''})`.trim();
    } else {
      ui.sismoTown.className = 'param-val';
      ui.sismoTown.textContent = e.localidad || 'Localidad de referencia no especificada';
    }
    ui.sismoZone.textContent = e.geo_tipo === 'MARITIMO'
      ? ('Clasificación: Marítimo · ' + (e.geo_zona_maritima || 'ZEE') + ' [IGC: ' + e.region + ']')
      : (e.geo_provincia
          ? ('Provincia: ' + e.geo_provincia + (e.geo_distrito ? ' · Distrito de ' + e.geo_distrito : '') + (e.geo_corregimiento ? ' · Corr. ' + e.geo_corregimiento : '') + ' [IGC: ' + e.region + ']')
          : (e.zona ? ('Zonificación: ' + e.zona) : 'Región tectónica de Panamá'));

    // Distancia geográfica al visitante si la geolocalización está activa
    updateFichaDistance(e, lat, lon);

    ui.sismoUidText.textContent = uid;

    // Color del indicador
    ui.sismoMapLegendDot.style.background = magColor(mag);

    // Cartografía interactiva vectorial del epicentro con MapLibre GL JS y OpenFreeMap
    renderSismoMapLibre(e, lat, lon, mag, prof, isValidDate, dateObj);
  }

  let cachedOfmStyle = null;
  async function loadCustomOfmStyle() {
    if (cachedOfmStyle) return cachedOfmStyle;
    try {
      const resp = await fetch('https://tiles.openfreemap.org/styles/dark');
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const style = await resp.json();
      style.layers.forEach(layer => {
        if (layer.id === 'background') {
          layer.paint = { ...layer.paint, 'background-color': '#111417' };
        } else if (layer.id === 'water' || layer.id.includes('ocean')) {
          if (layer.paint && layer.paint['fill-color']) {
            layer.paint['fill-color'] = '#132A40';
          }
        } else if (layer.id.includes('boundary') || layer.id.includes('admin')) {
          if (layer.paint && layer.paint['line-color']) {
            layer.paint['line-color'] = '#343D46';
          }
        } else if (layer.id.includes('road') || layer.id.includes('transportation')) {
          if (layer.paint && layer.paint['line-color']) {
            layer.paint['line-color'] = '#39454D';
          }
        } else if (layer.type === 'symbol' && layer.layout && layer.layout['text-field']) {
          if (layer.paint && layer.paint['text-color']) {
            layer.paint['text-color'] = '#AEBCC6';
          }
        }
      });
      cachedOfmStyle = style;
      return style;
    } catch (err) {
      console.warn('Error cargando estilo Dark de OpenFreeMap, usando URL directa:', err);
      return 'https://tiles.openfreemap.org/styles/dark';
    }
  }

  async function renderSismoMapLibre(e, lat, lon, mag, prof, isValidDate, dateObj) {
    const color = magColor(mag);
    if (ui.layerLegendDot) ui.layerLegendDot.style.background = color;

    // Verificar soporte de WebGL y disponibilidad de MapLibre GL
    const hasMapLibre = typeof window.maplibregl !== 'undefined';
    const isSupported = hasMapLibre && (typeof maplibregl.supported === 'function' ? maplibregl.supported() : true);

    if (!isSupported) {
      if (ui.sismoMapFallback) ui.sismoMapFallback.hidden = false;
      renderSismoLeafletFallback(e, lat, lon, mag, prof, isValidDate, dateObj);
      return;
    }
    if (ui.sismoMapFallback) ui.sismoMapFallback.hidden = true;

    const popupHtml = `<div class="popup-card">
      <div class="popup-top">
        <span class="popup-mag ${magnitudeClass(mag)}" style="color:${color};">M ${magText(mag)}</span>
        <span class="popup-state mono">${safe(e.estado || 'REVISADO')}</span>
      </div>
      <div class="popup-title">${safe(e.region)}</div>
      <div class="popup-meta mono">
        <span>${safe(isValidDate ? fullDate.format(dateObj) : '')}</span>
        <span>Profundidad: <b>${prof} km</b></span>
      </div>
    </div>`;

    const epicenterGeoJSON = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          mag: mag,
          color: color,
          radius: Math.min(13, Math.max(7, 5 + mag * 1.5))
        }
      }]
    };

    if (state.sismoMapLibre && state.sismoMapLoaded) {
      // Actualizar instancia activa de MapLibre de forma fluida
      state.sismoMapLibre.jumpTo({ center: [lon, lat], zoom: 8.5 });
      const src = state.sismoMapLibre.getSource('sismo-epicenter');
      if (src) src.setData(epicenterGeoJSON);
      if (state.sismoMapLibre.getLayer('sismo-point')) {
        state.sismoMapLibre.setPaintProperty('sismo-point', 'circle-color', color);
        state.sismoMapLibre.setPaintProperty('sismo-point', 'circle-radius', Math.min(13, Math.max(7, 5 + mag * 1.5)));
      }
      if (state.sismoMapLibre.getLayer('sismo-ring')) {
        state.sismoMapLibre.setPaintProperty('sismo-ring', 'circle-stroke-color', color);
        state.sismoMapLibre.setPaintProperty('sismo-ring', 'circle-color', color);
      }
      if (state.sismoPopup) {
        state.sismoPopup.setLngLat([lon, lat]).setHTML(popupHtml);
        if (!state.sismoPopup.isOpen()) state.sismoPopup.addTo(state.sismoMapLibre);
      }
      setTimeout(() => { if (state.sismoMapLibre) state.sismoMapLibre.resize(); }, 120);
      return;
    }

    // Inicializar nueva instancia MapLibre
    if (state.sismoMapLibre) {
      try { state.sismoMapLibre.remove(); } catch {}
      state.sismoMapLibre = null;
      state.sismoMapLoaded = false;
    }

    ui.sismoMap.replaceChildren();

    const customStyle = await loadCustomOfmStyle();

    const map = new maplibregl.Map({
      container: ui.sismoMap,
      style: customStyle,
      center: [lon, lat],
      zoom: 8.5,
      minZoom: 3,
      maxZoom: 16,
      attributionControl: false
    });

    state.sismoMapLibre = map;
    state.sismoMapLoaded = false;

    // Controles de navegación y atribución compactos
    map.addControl(new maplibregl.NavigationControl({ showCompass: true, showZoom: true }), 'top-left');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    map.on('load', () => {
      state.sismoMapLoaded = true;

      // 1. Capa de límites tectónicos (PB2002)
      map.addSource('tectonic-boundaries', {
        type: 'geojson',
        data: 'assets/data/tectonic-boundaries.geojson'
      });
      map.addLayer({
        id: 'tectonic-boundaries-line',
        type: 'line',
        source: 'tectonic-boundaries',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'visibility': ui.layerTogglePlates?.checked ? 'visible' : 'none'
        },
        paint: {
          'line-color': '#C68BEB',
          'line-width': ['interpolate', ['linear'], ['zoom'], 4, 1.4, 8, 2.4, 12, 3.5],
          'line-opacity': 0.85
        }
      });

      // 2. Capa de etiquetas de placas tectónicas
      map.addSource('tectonic-labels', {
        type: 'geojson',
        data: 'assets/data/tectonic-labels.geojson'
      });
      map.addLayer({
        id: 'tectonic-labels-text',
        type: 'symbol',
        source: 'tectonic-labels',
        layout: {
          'text-field': ['get', 'name'],
          'text-size': 11,
          'text-letter-spacing': 0.08,
          'text-max-width': 8,
          'visibility': ui.layerToggleLabels?.checked ? 'visible' : 'none'
        },
        paint: {
          'text-color': '#C68BEB',
          'text-halo-color': '#111417',
          'text-halo-width': 1.6
        }
      });

      // 3. Capa de fallas geológicas activas (GEM)
      map.addSource('geological-faults', {
        type: 'geojson',
        data: 'assets/data/geological-faults.geojson'
      });
      map.addLayer({
        id: 'geological-faults-line',
        type: 'line',
        source: 'geological-faults',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
          'visibility': ui.layerToggleFaults?.checked ? 'visible' : 'none'
        },
        paint: {
          'line-color': '#D99B69',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.8, 8, 1.5, 12, 2.4],
          'line-dasharray': [3, 2],
          'line-opacity': 0.75
        }
      });

      // 4. Capa de epicentro registrado
      map.addSource('sismo-epicenter', {
        type: 'geojson',
        data: epicenterGeoJSON
      });

      // Anillo visual de énfasis relativo a magnitud (no representa radio de daño)
      map.addLayer({
        id: 'sismo-ring',
        type: 'circle',
        source: 'sismo-epicenter',
        layout: {
          'visibility': ui.layerToggleEpicenter?.checked ? 'visible' : 'none'
        },
        paint: {
          'circle-radius': 28,
          'circle-color': color,
          'circle-opacity': 0.08,
          'circle-stroke-color': color,
          'circle-stroke-width': 1.2,
          'circle-stroke-opacity': 0.45
        }
      });

      // Marcador central del epicentro
      map.addLayer({
        id: 'sismo-point',
        type: 'circle',
        source: 'sismo-epicenter',
        layout: {
          'visibility': ui.layerToggleEpicenter?.checked ? 'visible' : 'none'
        },
        paint: {
          'circle-radius': Math.min(13, Math.max(7, 5 + mag * 1.5)),
          'circle-color': color,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
          'circle-opacity': 0.95
        }
      });

      // Popup informativo sobre el epicentro
      const popup = new maplibregl.Popup({
        closeButton: true,
        closeOnClick: false,
        offset: 14,
        className: 'maplibre-sismo-popup'
      })
        .setLngLat([lon, lat])
        .setHTML(popupHtml)
        .addTo(map);

      state.sismoPopup = popup;

      // Interacción con el marcador
      map.on('click', 'sismo-point', () => {
        popup.setLngLat([lon, lat]).addTo(map);
      });
      map.on('mouseenter', 'sismo-point', () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', 'sismo-point', () => {
        map.getCanvas().style.cursor = '';
      });

      map.resize();
    });

    // ResizeObserver para mantener el canvas ajustado al contenedor
    if (typeof ResizeObserver !== 'undefined' && ui.sismoMapWrap && !state.sismoResizeObs) {
      state.sismoResizeObs = new ResizeObserver(() => {
        if (state.sismoMapLibre) state.sismoMapLibre.resize();
      });
      state.sismoResizeObs.observe(ui.sismoMapWrap);
    }
  }

  function renderSismoLeafletFallback(e, lat, lon, mag, prof, isValidDate, dateObj) {
    if (typeof window.L === 'undefined') return;
    try {
      if (!state.sismoMap) {
        ui.sismoMap.replaceChildren();
        state.sismoMap = L.map(ui.sismoMap, {
          zoomControl: true,
          scrollWheelZoom: false,
          preferCanvas: true
        }).setView([lat, lon], 9);

        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 18,
          attribution: '&copy; OpenStreetMap'
        }).addTo(state.sismoMap);

        state.sismoLayer = L.layerGroup().addTo(state.sismoMap);
      } else {
        state.sismoLayer.clearLayers();
        state.sismoMap.setView([lat, lon], 9);
      }

      const color = magColor(mag);
      const marker = L.circleMarker([lat, lon], {
        radius: Math.min(14, Math.max(6, 4 + mag * 1.5)),
        color: '#ffffff',
        weight: 2,
        fillColor: color,
        fillOpacity: 0.95
      });

      const popupHtml = `<div class="popup-card">
        <div class="popup-top">
          <span class="popup-mag ${magnitudeClass(mag)}" style="color:${color};">M ${magText(mag)}</span>
          <span class="popup-state mono">${safe(e.estado || '')}</span>
        </div>
        <div class="popup-title">${safe(e.region)}</div>
        <div class="popup-meta mono">
          <span>${safe(isValidDate ? fullDate.format(dateObj) : '')}</span>
          <span>Profundidad: <b>${prof} km</b></span>
        </div>
      </div>`;
      marker.bindPopup(popupHtml);
      marker.addTo(state.sismoLayer);

      setTimeout(() => {
        if (state.sismoMap) {
          state.sismoMap.invalidateSize();
          marker.openPopup();
        }
      }, 150);
    } catch (err) {
      console.warn('Error en fallback Leaflet:', err);
    }
  }

  function wireMapLayers() {
    if (ui.sismoLayersBtn && ui.sismoLayersPopover) {
      ui.sismoLayersBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const isHidden = ui.sismoLayersPopover.hidden;
        ui.sismoLayersPopover.hidden = !isHidden;
        ui.sismoLayersBtn.setAttribute('aria-expanded', String(!isHidden));
      });

      document.addEventListener('click', (ev) => {
        if (ui.sismoLayersWidget && !ui.sismoLayersWidget.contains(ev.target)) {
          ui.sismoLayersPopover.hidden = true;
          ui.sismoLayersBtn.setAttribute('aria-expanded', 'false');
        }
      });
    }

    const setVisibility = (layerId, visible) => {
      if (state.sismoMapLibre && state.sismoMapLoaded && state.sismoMapLibre.getLayer(layerId)) {
        state.sismoMapLibre.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
      }
    };

    if (ui.layerToggleEpicenter) {
      ui.layerToggleEpicenter.addEventListener('change', (ev) => {
        const vis = ev.target.checked;
        setVisibility('sismo-point', vis);
        setVisibility('sismo-ring', vis);
        if (state.sismoPopup) {
          if (vis && !state.sismoPopup.isOpen() && state.sismoMapLibre) {
            state.sismoPopup.addTo(state.sismoMapLibre);
          } else if (!vis && state.sismoPopup.isOpen()) {
            state.sismoPopup.remove();
          }
        }
      });
    }

    if (ui.layerTogglePlates) {
      ui.layerTogglePlates.addEventListener('change', (ev) => {
        setVisibility('tectonic-boundaries-line', ev.target.checked);
      });
    }

    if (ui.layerToggleLabels) {
      ui.layerToggleLabels.addEventListener('change', (ev) => {
        setVisibility('tectonic-labels-text', ev.target.checked);
      });
    }

    if (ui.layerToggleFaults) {
      ui.layerToggleFaults.addEventListener('change', (ev) => {
        setVisibility('geological-faults-line', ev.target.checked);
      });
    }

    // Controles de capas para el mapa general
    if (ui.generalLayersBtn && ui.generalLayersPopover) {
      ui.generalLayersBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const isHidden = ui.generalLayersPopover.hidden;
        ui.generalLayersPopover.hidden = !isHidden;
        ui.generalLayersBtn.setAttribute('aria-expanded', String(!isHidden));
      });

      document.addEventListener('click', (ev) => {
        if (ui.generalLayersWidget && !ui.generalLayersWidget.contains(ev.target)) {
          ui.generalLayersPopover.hidden = true;
          ui.generalLayersBtn.setAttribute('aria-expanded', 'false');
        }
      });
    }

    const setGeneralVisibility = (layerId, visible) => {
      if (state.generalMapLibre && state.generalMapLoaded && state.generalMapLibre.getLayer(layerId)) {
        state.generalMapLibre.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
      }
    };

    if (ui.generalToggleEpicenters) {
      ui.generalToggleEpicenters.addEventListener('change', (ev) => {
        const vis = ev.target.checked;
        setGeneralVisibility('general-epicenters-circle', vis);
        setGeneralVisibility('general-epicenters-halo', vis);
        if (state.generalMapPopup) {
          if (!vis && state.generalMapPopup.isOpen()) {
            state.generalMapPopup.remove();
          }
        }
      });
    }

    if (ui.generalTogglePlates) {
      ui.generalTogglePlates.addEventListener('change', (ev) => {
        setGeneralVisibility('general-tectonic-boundaries-line', ev.target.checked);
      });
    }

    if (ui.generalToggleLabels) {
      ui.generalToggleLabels.addEventListener('change', (ev) => {
        setGeneralVisibility('general-tectonic-labels-text', ev.target.checked);
      });
    }

    if (ui.generalToggleFaults) {
      ui.generalToggleFaults.addEventListener('change', (ev) => {
        setGeneralVisibility('general-geological-faults-line', ev.target.checked);
      });
    }
  }

  /* ------------------------------------------------------------------------
     MÓDULO B — DASHBOARD DE ESTADÍSTICAS HISTÓRICAS
     ------------------------------------------------------------------------ */
  async function loadHistoricalData(force = false) {
    const year = ui.histYear.value || '2026';
    const month = ui.histMonth.value || '';
    const queryKey = `${year}-${month}`;

    // Evitar peticiones duplicadas idénticas si ya está cargando o ya se cargó sin cambios
    if (state.historicalLoading && state.lastHistoricalKey === queryKey && !force) {
      return;
    }
    if (!force && state.historicalData && state.lastHistoricalKey === queryKey) {
      return;
    }

    // Cancelar cualquier petición en vuelo previa para evitar respuestas obsoletas
    if (state.historicalAbortCtrl) {
      state.historicalAbortCtrl.abort();
    }
    const abortCtrl = new AbortController();
    state.historicalAbortCtrl = abortCtrl;

    const currentRequestId = ++state.historicalRequestId;
    state.historicalLoading = true;
    state.lastHistoricalKey = queryKey;
    ui.histPeriodLabel.textContent = 'Consultando base de datos histórica…';
    ui.histDataOrigin.textContent = '';
    ui.histFilterBtn.disabled = true;

    let url = `${HISTORICO_API}?anio=${encodeURIComponent(year)}&include_events=false`;
    if (month) {
      url += `&mes=${encodeURIComponent(month)}`;
    }

    try {
      const resp = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: abortCtrl.signal
      });
      const data = await resp.json().catch(() => null);

      // Si llegó otra petición posterior mientras esta respondía, ignorar respuesta obsoleta
      if (currentRequestId !== state.historicalRequestId) {
        return;
      }

      if (!resp.ok || !data || !data.ok || !data.estadisticas) {
        throw new Error(data?.error || `Error HTTP ${resp.status}`);
      }

      state.historicalData = data;
      renderHistoricalDashboard(data);
      ui.histDataOrigin.textContent = data.origen_datos === 'cache' ? '⚡ Caché' : '● Supabase';
    } catch (err) {
      if (err.name === 'AbortError') {
        // Petición cancelada intencionalmente por un cambio de filtro más reciente
        return;
      }
      if (currentRequestId === state.historicalRequestId) {
        ui.histPeriodLabel.replaceChildren();
        const errSpan = document.createElement('span');
        errSpan.textContent = 'No se pudo consultar el archivo histórico. ';
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'hist-inline-retry-btn';
        retryBtn.textContent = '↻ Reintentar';
        retryBtn.setAttribute('aria-label', 'Reintentar consulta del historial');
        retryBtn.addEventListener('click', () => loadHistoricalData(true));
        ui.histPeriodLabel.append(errSpan, retryBtn);

        ui.histDataOrigin.textContent = '⚠️ Error de conexión';
        ui.histTotal.textContent = '—';
        ui.histCoverageDetail.textContent = 'Error al consultar datos';
        ui.histMagMax.textContent = '—';
        ui.histMagMin.textContent = '—';
        ui.histMagAvg.textContent = '—';
        ui.histDepthAvg.textContent = '—';
        ui.histOldestDate.textContent = '—';
        ui.histOldestInfo.textContent = 'Error de consulta';
        if (ui.histMonthlyChart) ui.histMonthlyChart.innerHTML = '<div class="hist-empty-notice">Error al cargar datos mensuales.</div>';
        if (ui.histDailyChart) ui.histDailyChart.innerHTML = '<div class="hist-empty-notice">Error al cargar distribución diaria.</div>';
        if (ui.histMagBars) ui.histMagBars.innerHTML = '<div class="hist-empty-notice">Error al cargar magnitudes.</div>';
        if (ui.histRegionsTable) ui.histRegionsTable.innerHTML = '<div class="hist-empty-notice">Error al cargar regiones.</div>';
      }
    } finally {
      if (currentRequestId === state.historicalRequestId) {
        state.historicalLoading = false;
        ui.histFilterBtn.disabled = false;
      }
    }
  }

  function renderHistoricalDashboard(data) {
    const stats = data.estadisticas;
    const filters = data.filtros_aplicados;

    const monthNames = ['', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
    const periodName = filters.mes ? `${monthNames[filters.mes]} de ${filters.anio}` : `Año completo ${filters.anio}`;

    if (!stats || stats.total === 0) {
      ui.histPeriodLabel.textContent = `${periodName} · Período sin registros`;
      ui.histDataOrigin.textContent = 'ℹ️ Sin registros';
      ui.histTotal.textContent = '0';
      ui.histCoverageDetail.textContent = 'El archivo histórico inició el 12 de octubre de 2026';
      ui.histMagMax.textContent = '—';
      ui.histMagMin.textContent = '—';
      ui.histMagAvg.textContent = '—';
      ui.histDepthAvg.textContent = '—';
      ui.histOldestDate.textContent = 'Sin datos';
      ui.histOldestInfo.textContent = 'Sin eventos en este período';
      if (ui.histMonthlyChart) ui.histMonthlyChart.innerHTML = '<div class="hist-empty-notice">Sin eventos en este período.</div>';
      if (ui.histDailyChart) ui.histDailyChart.innerHTML = '<div class="hist-empty-notice">Sin eventos en este período.</div>';
      if (ui.histMagBars) ui.histMagBars.innerHTML = '<div class="hist-empty-notice">Sin eventos en este período.</div>';
      if (ui.histRegionsTable) ui.histRegionsTable.innerHTML = '<div class="hist-empty-notice">Sin eventos en este período.</div>';
      return;
    }

    ui.histPeriodLabel.textContent = `Mostrando: ${periodName}`;

    ui.histTotal.textContent = num(stats.total);
    ui.histCoverageDetail.textContent = stats.total === 1 ? '1 evento registrado' : `${num(stats.total)} eventos registrados`;
    ui.histMagMax.textContent = stats.mag_max != null ? Number(stats.mag_max).toFixed(1) : '—';
    ui.histMagMin.textContent = stats.mag_min != null ? Number(stats.mag_min).toFixed(1) : '—';
    ui.histMagAvg.textContent = stats.mag_promedio != null ? Number(stats.mag_promedio).toFixed(2) : '—';
    ui.histDepthAvg.textContent = stats.prof_promedio != null ? `${Number(stats.prof_promedio).toFixed(1)} km` : '—';

    // Determinar fecha más antigua a partir de la distribución diaria o datos históricos
    const dailyKeys = Object.keys(stats.distribucion_diaria || {}).sort();
    if (dailyKeys.length > 0) {
      ui.histOldestDate.textContent = dailyKeys[0];
      ui.histOldestInfo.textContent = 'Primer registro en período';
    } else {
      ui.histOldestDate.textContent = 'Sin datos';
      ui.histOldestInfo.textContent = 'Fuera de cobertura';
    }

    drawHistMonthlyChart(stats, filters);
    drawHistDailyChart(stats);
    renderHistMagBars(stats);
    renderHistRegions(stats);
  }

  function drawHistMonthlyChart(stats, filters) {
    const parent = ui.histMonthlyChart;
    parent.replaceChildren();
    const year = Number(filters.anio || 2026);
    const monthLabels = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    const bins = [];
    const dist = stats.distribucion_mensual || {};

    let totalInYear = 0;
    for (let m = 1; m <= 12; m++) {
      const mKey = `${year}-${String(m).padStart(2, '0')}`;
      const val = dist[mKey] || 0;
      totalInYear += val;
      // Para 2026, el archivado inició en Octubre (mes 10) con datos acumulados desde el 12 de octubre.
      // Meses 1 a 9 no disponen de cobertura histórica archivada.
      const hasCoverage = !(year === 2026 && m < 10);
      bins.push({
        month: m,
        key: mKey,
        label: monthLabels[m - 1],
        value: val,
        hasCoverage
      });
    }

    set('histMonthlyTotal', `${num(totalInYear)} sismos en ${year}`);

    const W = 520, H = 160, left = 36, right = 12, top = 10, bottom = 24;
    const plotW = W - left - right, plotH = H - top - bottom;
    const svg = svgNode('svg', { class: 'svg-hist-chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Distribución mensual de sismos' });

    const maxV = Math.max(...bins.map(b => b.value), 4);
    const nice = Math.ceil(maxV / 4) * 4;

    for (let tick = 0; tick <= 4; tick++) {
      const y = top + plotH - tick * plotH / 4;
      svg.append(svgNode('line', { x1: left, y1: y, x2: W - right, y2: y, class: 'chart-gridline' }));
      svg.append(svgNode('text', { x: left - 10, y: y + 4, 'text-anchor': 'end', class: 'chart-label' }, String(Math.round(nice * tick / 4))));
    }

    const spacing = plotW / 12;
    const barWidth = Math.max(14, spacing * 0.65);

    bins.forEach((b, i) => {
      const x = left + i * spacing + (spacing - barWidth) / 2;
      const height = b.hasCoverage ? (b.value / nice * plotH) : plotH;
      const y = b.hasCoverage ? (top + plotH - height) : top;

      if (!b.hasCoverage) {
        const rect = svgNode('rect', {
          class: 'hist-bar-no-coverage',
          x,
          y,
          width: barWidth,
          height: plotH,
          rx: 2
        });
        rect.append(svgNode('title', {}, `${b.label} ${year}: Sin cobertura histórica archivada en este observatorio`));
        svg.append(rect);
      } else {
        const rect = svgNode('rect', {
          class: 'plot-bar hist-bar',
          x,
          y,
          width: barWidth,
          height: Math.max(0, height),
          rx: 2
        });
        rect.append(svgNode('title', {}, `${b.label} ${year}: ${b.value} sismo${b.value === 1 ? '' : 's'} archivado${b.value === 1 ? '' : 's'}`));
        svg.append(rect);
      }

      svg.append(svgNode('text', { class: 'chart-label', x: x + barWidth / 2, y: H - 12, 'text-anchor': 'middle' }, b.label));
    });

    parent.append(svg);
  }

  function drawHistDailyChart(stats) {
    const parent = ui.histDailyChart;
    parent.replaceChildren();
    const daily = stats.distribucion_diaria || {};
    const days = Object.keys(daily).sort();

    if (!days.length) {
      parent.append(el('div', 'empty-plot', 'No hay registros diarios para graficar en este período.'));
      set('histDailyTotal', '0 días');
      return;
    }

    const totalInDays = days.reduce((sum, d) => sum + (daily[d] || 0), 0);
    set('histDailyTotal', `${num(days.length)} días registrados · ${num(totalInDays)} sismos`);

    const W = 520, H = 160, left = 36, right = 12, top = 10, bottom = 24;
    const plotW = W - left - right, plotH = H - top - bottom;
    const svg = svgNode('svg', { class: 'svg-hist-chart', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Actividad sísmica diaria' });

    const maxV = Math.max(...days.map(d => daily[d]), 4);
    const nice = Math.ceil(maxV / 4) * 4;

    for (let tick = 0; tick <= 4; tick++) {
      const y = top + plotH - tick * plotH / 4;
      svg.append(svgNode('line', { x1: left, y1: y, x2: W - right, y2: y, class: 'chart-gridline' }));
      svg.append(svgNode('text', { x: left - 10, y: y + 4, 'text-anchor': 'end', class: 'chart-label' }, String(Math.round(nice * tick / 4))));
    }

    const spacing = plotW / days.length;
    const barWidth = Math.max(4, Math.min(32, spacing * 0.7));

    days.forEach((dayStr, i) => {
      const count = daily[dayStr] || 0;
      const x = left + i * spacing + (spacing - barWidth) / 2;
      const height = count / nice * plotH;
      const y = top + plotH - height;

      const rect = svgNode('rect', {
        class: 'plot-bar hist-bar',
        x,
        y,
        width: barWidth,
        height: Math.max(0, height),
        rx: 2
      });
      rect.append(svgNode('title', {}, `${dayStr}: ${count} sismo${count === 1 ? '' : 's'}`));
      svg.append(rect);

      const interval = Math.max(1, Math.ceil(days.length / 8));
      if (i % interval === 0 || i === days.length - 1) {
        const parts = dayStr.split('-');
        const shortLabel = parts.length === 3 ? `${parts[2]}/${parts[1]}` : dayStr;
        svg.append(svgNode('text', { class: 'chart-label', x: x + barWidth / 2, y: H - 12, 'text-anchor': 'middle' }, shortLabel));
      }
    });

    parent.append(svg);
  }

  function renderHistMagBars(stats) {
    const parent = ui.histMagBars;
    parent.replaceChildren();
    const total = stats.total || 0;
    const brackets = [
      { key: 'menor_3', label: 'Menor de 3.0', count: stats.menor_3 || 0, color: COLORS[0], text: 'Microactividad' },
      { key: 'entre_3_y_3_9', label: '3.0 a 3.9', count: stats.entre_3_y_3_9 || 0, color: COLORS[1], text: 'Sismos menores' },
      { key: 'entre_4_y_4_9', label: '4.0 a 4.9', count: stats.entre_4_y_4_9 || 0, color: COLORS[2], text: 'Sismos moderados' },
      { key: 'mayor_igual_5', label: '5.0 o superior', count: stats.mayor_igual_5 || 0, color: COLORS[3], text: 'Sismos fuertes' }
    ];

    brackets.forEach(b => {
      const row = el('div', 'hist-mag-row');
      const labelRow = el('div', 'hist-mag-label-row');

      const tag = el('span', 'hist-mag-tag');
      const dot = el('span', 'legend-dot');
      dot.style.background = b.color;
      dot.style.width = '8px';
      dot.style.height = '8px';
      dot.style.borderRadius = '50%';
      dot.style.display = 'inline-block';
      tag.append(dot, el('span', '', b.label));

      const countWrap = el('div');
      const countEl = el('span', 'hist-mag-count', num(b.count));
      const pctEl = el('span', 'hist-mag-pct', total ? ` (${(b.count / total * 100).toFixed(1)}%)` : ' (0%)');
      countWrap.append(countEl, pctEl);

      labelRow.append(tag, countWrap);

      const track = el('div', 'hist-mag-track');
      const fill = el('div', 'hist-mag-fill');
      fill.style.background = b.color;
      fill.style.width = total ? `${Math.max(1, b.count / total * 100)}%` : '0%';
      track.append(fill);

      row.append(labelRow, track);
      parent.append(row);
    });
  }

  function renderHistRegions(stats) {
    const parent = ui.histRegionBars;
    parent.replaceChildren();
    const regions = Object.entries(stats.por_region || {}).slice(0, 8);
    set('histRegionTotal', `${num(Object.keys(stats.por_region || {}).length)} regiones`);

    if (!regions.length) {
      parent.append(el('div', 'empty-plot', 'Sin datos regionales en este período.'));
      return;
    }

    const maxCount = Math.max(...regions.map(r => r[1]), 1);

    regions.forEach(([name, count]) => {
      const row = el('div', 'bar-row');
      const labels = el('div', 'bar-labels');
      labels.append(el('span', '', name), el('strong', '', num(count)));
      const track = el('div', 'bar-track');
      const fill = el('div', 'bar-fill');
      fill.style.width = `${Math.max(2, count / maxCount * 100)}%`;
      track.append(fill);
      row.append(labels, track);
      parent.append(row);
    });
  }

  /* ------------------------------------------------------------------------
     ESTRUCTURA DE NAVEGACIÓN MÓVIL ANDROID (BOTTOM NAVIGATION)
     ------------------------------------------------------------------------ */
  function setMobileTab(tabId, updateHash = true) {
    const validTabs = ['sismos', 'mapa', 'cerca', 'historial', 'mas', 'registros'];
    if (!validTabs.includes(tabId)) tabId = 'sismos';
    state.activeMobileTab = tabId;

    if (ui.dashboardView) {
      ui.dashboardView.setAttribute('data-active-tab', tabId);
    }

    const buttons = document.querySelectorAll('.mobile-nav-btn');
    buttons.forEach((btn) => {
      const isTarget = btn.getAttribute('data-tab') === tabId || (tabId === 'registros' && btn.getAttribute('data-tab') === 'sismos');
      btn.classList.toggle('active', isTarget);
      btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
    });

    if (tabId === 'mapa') {
      setTimeout(() => {
        if (state.generalMapLibre) state.generalMapLibre.resize();
        if (state.map) state.map.invalidateSize();
      }, 120);
    } else if (tabId === 'historial') {
      if (!state.historicalData) {
        loadHistoricalData();
      }
    }

    if (ui.sismoView && !ui.sismoView.hidden) {
      closeSismoDetail(false);
    }

    if (updateHash && window.location.hash !== `#${tabId}`) {
      window.location.hash = `#${tabId}`;
    }
  }

  /* ------------------------------------------------------------------------
     ENRUTAMIENTO Y VINCULACIÓN DE EVENTOS
     ------------------------------------------------------------------------ */
  function handleRouting() {
    const hash = window.location.hash || '';
    if (hash.startsWith('#/sismo/')) {
      const id = hash.slice('#/sismo/'.length).trim();
      showSismoDetail(id);
    } else {
      closeSismoDetail(false);
      const tabMap = {
        '': 'sismos',
        '#inicio': 'sismos',
        '#resumen': 'sismos',
        '#sismos': 'sismos',
        '#registros': 'registros',
        '#mapa': 'mapa',
        '#geografia': 'mapa',
        '#cerca': 'cerca',
        '#historial': 'historial',
        '#historico': 'historial',
        '#mas': 'mas',
        '#filtros': 'mas',
        '#notificaciones': 'mas'
      };
      const targetTab = tabMap[hash] || 'sismos';
      setMobileTab(targetTab, false);

      if (hash === '#registros') {
        setTimeout(() => {
          const target = document.getElementById('registros');
          if (target) target.scrollIntoView({ behavior: 'smooth' });
        }, 80);
      } else if (hash === '#notificaciones') {
        setTimeout(() => {
          const target = document.getElementById('notificaciones');
          if (target) target.scrollIntoView({ behavior: 'smooth' });
        }, 80);
      }

      if ((hash === '#historico' || hash === '#historial' || targetTab === 'historial') && !state.historicalData) {
        loadHistoricalData();
      }
    }
  }

  function wire() {
    const list = [f.period, f.zone, f.town, f.mag, f.depth, f.status, f.from, f.to, f.sort];
    list.forEach(field => field.addEventListener('change', () => {
      state.page = 1;
      if (field === f.zone || field === f.period || field === f.depth || field === f.status || field === f.from || field === f.to) updateTowns();
      render();
    }));

    f.search.addEventListener('input', () => { state.page = 1; updateTowns(); render(); });

    document.querySelectorAll('[data-magnitude]').forEach(btn => btn.addEventListener('click', () => {
      f.mag.value = (f.mag.value === btn.dataset.magnitude ? '' : btn.dataset.magnitude);
      state.page = 1;
      render();
    }));

    ui.resetBtn.addEventListener('click', reset);
    ui.refreshBtn.addEventListener('click', () => loadData());
    ui.alertRetry.addEventListener('click', () => loadData());
    ui.csvBtn.addEventListener('click', exportCsv);
    ui.pagePrev.addEventListener('click', () => { state.page--; drawTable(sortedData()); });
    ui.pageNext.addEventListener('click', () => { state.page++; drawTable(sortedData()); });

    // Acciones de la Ficha Individual
    ui.sismoBackBtn.addEventListener('click', () => closeSismoDetail(true));
    ui.sismoNotFoundBackBtn.addEventListener('click', () => closeSismoDetail(true));

    ui.sismoCopyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(window.location.href);
        set('sismoCopyText', '✓ ¡Enlace copiado!');
        setTimeout(() => set('sismoCopyText', 'Copiar enlace'), 2500);
      } catch {
        set('sismoCopyText', 'Error al copiar');
        setTimeout(() => set('sismoCopyText', 'Copiar enlace'), 2500);
      }
    });

    // Acciones del Dashboard Histórico
    ui.histFilterBtn.addEventListener('click', () => loadHistoricalData(true));
    ui.histYear.addEventListener('change', () => loadHistoricalData(true));
    ui.histMonth.addEventListener('change', () => loadHistoricalData(true));

    ui.navHistorico.addEventListener('click', () => {
      if (!state.historicalData) loadHistoricalData();
    });

    // Geolocalización y cálculo de distancia (almacenamiento exclusivo en sesión volátil)
    if (ui.btnRequestGeo) ui.btnRequestGeo.addEventListener('click', requestUserLocation);
    if (ui.btnRefreshGeo) ui.btnRefreshGeo.addEventListener('click', requestUserLocation);
    if (ui.btnDisableGeo) ui.btnDisableGeo.addEventListener('click', disableUserLocation);

    // Navegación móvil tipo aplicación Android
    document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        const tab = btn.getAttribute('data-tab');
        if (tab) setMobileTab(tab, true);
      });
    });

    // Progressive Web App (PWA) e instalación en dispositivo
    wirePwaAndServiceWorker();

    wireMapLayers();
    window.addEventListener('hashchange', handleRouting);
    if (typeof window !== 'undefined' && window.matchMedia) {
      window.matchMedia('(max-width: 640px)').addEventListener('change', syncRecordsA11y);
    }
    handleRouting();
  }

  function wirePwaAndServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').then((registration) => {
          // Monitoreo de nuevas versiones sin forzar recargas inesperadas mientras el usuario interactúa
          registration.addEventListener('updatefound', () => {
            const installingWorker = registration.installing;
            if (!installingWorker) return;
            installingWorker.addEventListener('statechange', () => {
              if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                console.info('[PWA] Nueva versión disponible en segundo plano. Se activará limpiamente en la próxima apertura sin interrumpir la sesión activa.');
              }
            });
          });

          // Comprobar si hay actualizaciones al volver al primer plano (foreground)
          document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
              registration.update().catch(() => {});
            }
          });
        }).catch((err) => {
          console.warn('[PWA] Service Worker registration failed:', err);
        });
      });
    }

    const isIos = /iphone|ipad|ipod/.test(window.navigator.userAgent.toLowerCase());
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

    if (!isStandalone) {
      // Flujo Chromium / Android con beforeinstallprompt
      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        state.deferredPwaPrompt = e;
        if (ui.pwaInstallBtn) ui.pwaInstallBtn.hidden = false;
      });

      window.addEventListener('appinstalled', () => {
        state.deferredPwaPrompt = null;
        if (ui.pwaInstallBtn) ui.pwaInstallBtn.hidden = true;
      });

      // Detección iOS Safari (no soporta beforeinstallprompt nativo)
      if (isIos && ui.pwaInstallBtn) {
        ui.pwaInstallBtn.hidden = false;
      }
    }

    if (ui.pwaInstallBtn) {
      ui.pwaInstallBtn.addEventListener('click', async () => {
        if (state.deferredPwaPrompt) {
          state.deferredPwaPrompt.prompt();
          const { outcome } = await state.deferredPwaPrompt.userChoice;
          if (outcome === 'accepted') {
            ui.pwaInstallBtn.hidden = true;
          }
          state.deferredPwaPrompt = null;
        } else if (isIos) {
          if (ui.iosInstallModal) ui.iosInstallModal.hidden = false;
        } else {
          // Fallback informativo si el navegador no expuso prompt nativo ni es iOS
          if (ui.iosInstallModal) ui.iosInstallModal.hidden = false;
        }
      });
    }

    if (ui.iosModalCloseBtn) {
      ui.iosModalCloseBtn.addEventListener('click', () => {
        if (ui.iosInstallModal) ui.iosInstallModal.hidden = true;
      });
    }
    if (ui.iosModalOkBtn) {
      ui.iosModalOkBtn.addEventListener('click', () => {
        if (ui.iosInstallModal) ui.iosInstallModal.hidden = true;
      });
    }
    if (ui.iosModalBackdrop) {
      ui.iosModalBackdrop.addEventListener('click', () => {
        if (ui.iosInstallModal) ui.iosInstallModal.hidden = true;
      });
    }
  }

  wire();
  elapsedTime();
  setInterval(elapsedTime, 1000);
  setInterval(() => loadData(true), INTERVAL_MS);
  loadData();

  /* ==========================================================================
     SELECTOR DE TEMA CLARO / OSCURO
     ========================================================================== */
  function initThemeToggle() {
    const btn = document.getElementById('themeToggleBtn');
    if (!btn) return;

    function applyTheme(theme) {
      if (theme === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        btn.setAttribute('aria-label', 'Cambiar a modo oscuro');
        btn.title = 'Cambiar a modo oscuro';
      } else {
        document.documentElement.removeAttribute('data-theme');
        btn.setAttribute('aria-label', 'Cambiar a modo claro');
        btn.title = 'Cambiar a modo claro';
      }
    }

    const currentTheme = localStorage.getItem('sismopa_theme') || 'dark';
    applyTheme(currentTheme);

    btn.addEventListener('click', () => {
      const isLight = document.documentElement.getAttribute('data-theme') === 'light';
      const newTheme = isLight ? 'dark' : 'light';
      applyTheme(newTheme);
      try {
        localStorage.setItem('sismopa_theme', newTheme);
      } catch (e) {}
      if (state.events && state.events.length) {
        try {
          renderCharts(filteredEvents());
          renderMetrics(filteredEvents());
        } catch (e) {}
      }
    });
  }

  /* ==========================================================================
     NOTIFICACIONES WEB PUSH DE SISMOS
     ========================================================================== */
  function urlB64ToUint8Array(base64String) {
    const clean = (base64String || '').trim().replace(/-/g, '+').replace(/_/g, '/');
    const unpadded = clean.replace(/=+$/, '');
    const padding = '='.repeat((4 - (unpadded.length % 4)) % 4);
    const rawData = window.atob(unpadded + padding);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  function bufferToB64Url(buffer) {
    if (!buffer) return '';
    const bytes = new Uint8Array(buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function getEndpointTokenKey(endpoint) {
    let hash = 0;
    for (let i = 0; i < endpoint.length; i++) hash = ((hash << 5) - hash + endpoint.charCodeAt(i)) | 0;
    return 'sismopa_push_tok_' + Math.abs(hash);
  }

  /* ==========================================================================
     DETECCIÓN DE ENTORNO ANDROID TWA (ROBUSTA Y MULTI-CRITERIO)
     ========================================================================== */
  function checkIsTwa() {
    const isAndroidDevice = /Android/i.test(navigator.userAgent);
    if (!isAndroidDevice) return false;

    // 1. Confirmación directa recibida por canal nativo postMessage
    if (window.__sismoTwaConfirmed === true) return true;

    // 2. Referrer del paquete oficial Android
    const hasAndroidAppReferrer = Boolean(document.referrer && document.referrer.startsWith('android-app://pa.sismodata.app'));
    if (hasAndroidAppReferrer) {
      try { localStorage.setItem('sismopa_twa_verified', '1'); } catch (_) {}
      return true;
    }

    // 3. Parámetro inyectado en URL de inicio por LauncherActivity
    if (window.location.search.includes('platform=android_twa')) {
      try { localStorage.setItem('sismopa_twa_verified', '1'); } catch (_) {}
      return true;
    }

    // 4. Modo de visualización standalone (TWA / WebAPK en Android)
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (isStandalone) {
      const isVerified = localStorage.getItem('sismopa_twa_verified') === '1';
      const isOfficialHost = window.location.hostname === 'sismopa.pages.dev' || window.location.hostname.endsWith('.pages.dev');
      if (isVerified || isOfficialHost) {
        return true;
      }
    }

    return false;
  }

  /* ==========================================================================
     BOTÓN DE ACCESO RÁPIDO A NOTIFICACIONES EN CABECERA (TOPBAR BELL)
     ========================================================================== */
  function initTopbarNotificationButton() {
    const notifTopbarBtn = document.getElementById('notifTopbarBtn');
    if (!notifTopbarBtn) return;

    function applyButtonState() {
      const isTwa = checkIsTwa();

      if (isTwa) {
        // En APK Android TWA: enlace directo mediante deep link nativo sismopa://
        notifTopbarBtn.href = 'sismopa://notifications';
        notifTopbarBtn.setAttribute('aria-label', 'Abrir alertas sísmicas sismoPA');
        notifTopbarBtn.setAttribute('title', 'Alertas sísmicas sismoPA');

        notifTopbarBtn.onclick = (e) => {
          // Acción directa del usuario: navegar al scheme nativo sismopa://
          // NUNCA disparar postMessage simultáneo aquí para evitar que Android lance la pantalla dos veces
          e.preventDefault();
          window.location.href = 'sismopa://notifications';
        };
      } else {
        // En navegadores normales (escritorio y móvil): dirigir al panel Web Push existente
        notifTopbarBtn.href = '#notificaciones';
        notifTopbarBtn.setAttribute('aria-label', 'Configurar alertas sísmicas');
        notifTopbarBtn.setAttribute('title', 'Alertas sísmicas');

        notifTopbarBtn.onclick = (e) => {
          e.preventDefault();
          // En vista móvil, activar la pestaña 'mas' donde reside la sección de notificaciones
          if (typeof setMobileTab === 'function') {
            setMobileTab('mas', true);
          }
          const notifSection = document.getElementById('notificaciones');
          if (notifSection) {
            setTimeout(() => {
              notifSection.scrollIntoView({ behavior: 'smooth' });
            }, 60);
          }
          if (window.location.hash !== '#notificaciones') {
            try {
              history.pushState(null, '', '#notificaciones');
            } catch (_) {
              window.location.hash = '#notificaciones';
            }
          }
        };
      }
    }

    applyButtonState();

    // Si el canal nativo confirma la identidad TWA vía postMessage en cualquier momento, sincronizar estado
    window.addEventListener('message', (event) => {
      try {
        const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (msg && msg.type === 'SISMO_FCM_STATUS') {
          window.__sismoTwaConfirmed = true;
          try { localStorage.setItem('sismopa_twa_verified', '1'); } catch (_) {}
          applyButtonState();
        }
      } catch (_) {}
    });
  }

  async function initPushNotifications() {
    const badge = document.getElementById('pushStatusBadge');
    const detail = document.getElementById('pushStatusDetail');
    const btnToggle = document.getElementById('btnTogglePush');
    const btnTest = document.getElementById('btnTestPush');
    const nativeDeepLink = document.getElementById('btnNativeSettingsDeepLink');
    if (!badge || !btnToggle) return;

    const isTwa = checkIsTwa();
    if (isTwa) {
      try { localStorage.setItem('sismopa_platform', 'android_twa'); } catch (e) {}

      if (window.location.search.includes('fcm_status=active')) {
        try { localStorage.setItem('sismopa_fcm_active', '1'); } catch (e) {}
      } else if (window.location.search.includes('fcm_status=inactive')) {
        try { localStorage.removeItem('sismopa_fcm_active'); } catch (e) {}
      }

      function safeMigrateWebPushToFcm() {
        const isFcmConfirmedActive = localStorage.getItem('sismopa_fcm_active') === '1';
        if (!isFcmConfirmedActive) return;

        if ('serviceWorker' in navigator && 'PushManager' in window) {
          navigator.serviceWorker.ready.then(async (reg) => {
            try {
              const sub = await reg.pushManager.getSubscription();
              if (sub) {
                console.log('[TWA] FCM nativo confirmado activo; liberando Web Push local de la APK');
                await sub.unsubscribe();
                fetch('/api/push-unsubscribe', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ endpoint: sub.endpoint })
                }).catch(() => {});
              }
            } catch (errClean) {
              console.warn('[TWA] Transición Web Push omitida:', errClean);
            }
          }).catch(() => {});
        }
      }

      safeMigrateWebPushToFcm();

      window.addEventListener('message', (event) => {
        try {
          const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
          if (msg && msg.type === 'SISMO_FCM_STATUS') {
            if (msg.active) {
              localStorage.setItem('sismopa_fcm_active', '1');
              safeMigrateWebPushToFcm();
            } else {
              localStorage.removeItem('sismopa_fcm_active');
            }
            renderTwaFcmState();
          }
        } catch (e) {}
      });

      function renderTwaFcmState() {
        const isActive = localStorage.getItem('sismopa_fcm_active') === '1';
        if (isActive) {
          badge.textContent = 'Activas (App sismoPA)';
          badge.className = 'notif-status-badge active';
          detail.textContent = 'Alertas oficiales activas en tu teléfono Android con icono propio y sonido prioritario.';
          btnToggle.textContent = 'Gestionar en app sismoPA';
          btnToggle.className = 'btn-push-toggle active';
          btnToggle.disabled = false;
        } else {
          badge.textContent = 'Desactivadas';
          badge.className = 'notif-status-badge inactive';
          detail.textContent = '¡Novedad! Ahora puedes recibir alertas sísmicas oficiales instantáneas con icono propio de sismoPA directamente en tu teléfono.';
          btnToggle.textContent = 'Configurar alertas sismoPA';
          btnToggle.className = 'btn-push-toggle';
          btnToggle.disabled = false;
        }
        if (btnTest) btnTest.hidden = true;
        if (nativeDeepLink) nativeDeepLink.style.display = 'inline-flex';
      }

      renderTwaFcmState();

      btnToggle.onclick = () => {
        window.location.href = 'sismopa://notifications';
      };

      return;
    }

    const isSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (!isSupported) {
      badge.textContent = 'No soportado';
      badge.className = 'notif-status-badge inactive';
      detail.textContent = 'Este navegador o plataforma no admite la API estándar de notificaciones Web Push.';
      btnToggle.disabled = true;
      btnToggle.textContent = 'No disponible';
      return;
    }

    async function getVapidPublicKey() {
      try {
        const res = await fetch('/api/push-vapid-key');
        const data = await res.json();
        if (res.ok && data.ok && data.vapidPublicKey) {
          return data.vapidPublicKey;
        }
        return null;
      } catch (err) {
        return null;
      }
    }

    async function checkSubscription() {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();

        if (Notification.permission === 'denied') {
          badge.textContent = 'Bloqueadas';
          badge.className = 'notif-status-badge denied';
          detail.textContent = 'El permiso fue denegado en el navegador. Para recibirlas, permite las notificaciones en la configuración del sitio.';
          btnToggle.textContent = 'Permiso denegado';
          btnToggle.className = 'btn-push-toggle disabled';
          btnToggle.disabled = true;
          if (btnTest) btnTest.hidden = true;
          return null;
        }

        if (!sub) {
          badge.textContent = 'Desactivadas';
          badge.className = 'notif-status-badge inactive';
          detail.textContent = 'Activa las notificaciones voluntarias para recibir alertas de actividad sísmica en este dispositivo.';
          btnToggle.textContent = 'Activar notificaciones';
          btnToggle.className = 'btn-push-toggle';
          btnToggle.disabled = false;
          if (btnTest) btnTest.hidden = true;
          return null;
        }

        // Comprobar si la suscripción usa una clave VAPID anterior
        const serverKey = await getVapidPublicKey();
        let isOutdated = false;
        if (serverKey && sub.options && sub.options.applicationServerKey) {
          const localKey = bufferToB64Url(sub.options.applicationServerKey);
          if (localKey && localKey !== serverKey) {
            isOutdated = true;
          }
        }

        const tokKey = getEndpointTokenKey(sub.endpoint);
        const hasToken = !!localStorage.getItem(tokKey);

        if (isOutdated) {
          badge.textContent = 'Actualización requerida';
          badge.className = 'notif-status-badge denied';
          detail.textContent = 'Tu suscripción utiliza credenciales de seguridad anteriores. Pulsa «Reactivar notificaciones» para actualizarla.';
          btnToggle.textContent = 'Reactivar notificaciones';
          btnToggle.className = 'btn-push-toggle active';
          btnToggle.disabled = false;
          if (btnTest) btnTest.hidden = true;
          return sub;
        }

        if (!hasToken) {
          badge.textContent = 'Sincronización requerida';
          badge.className = 'notif-status-badge inactive';
          detail.textContent = 'La suscripción requiere registrarse con el servidor para autorizar pruebas. Pulsa «Reactivar notificaciones».';
          btnToggle.textContent = 'Reactivar notificaciones';
          btnToggle.className = 'btn-push-toggle active';
          btnToggle.disabled = false;
          if (btnTest) btnTest.hidden = true;
          return sub;
        }

        // Suscripción vigente, autorizada y confirmada
        badge.textContent = 'Activas';
        badge.className = 'notif-status-badge active';
        detail.textContent = 'Recibirás avisos inmediatos en este dispositivo cada vez que el IGC-UP publique un nuevo sismo.';
        btnToggle.textContent = 'Desactivar notificaciones';
        btnToggle.className = 'btn-push-toggle active';
        btnToggle.disabled = false;
        if (btnTest) btnTest.hidden = false;
        return sub;
      } catch (err) {
        console.warn('[Push] Error comprobando estado:', err);
        return null;
      }
    }

    btnToggle.addEventListener('click', async () => {
      btnToggle.disabled = true;
      try {
        const reg = await navigator.serviceWorker.ready;
        const currentSub = await reg.pushManager.getSubscription();
        const serverKey = await getVapidPublicKey();

        let isOutdated = false;
        if (currentSub && serverKey && currentSub.options && currentSub.options.applicationServerKey) {
          const localKey = bufferToB64Url(currentSub.options.applicationServerKey);
          if (localKey && localKey !== serverKey) {
            isOutdated = true;
          }
        }
        const tokKey = currentSub ? getEndpointTokenKey(currentSub.endpoint) : '';
        const hasToken = currentSub ? !!localStorage.getItem(tokKey) : false;

        if (currentSub && !isOutdated && hasToken) {
          // Desactivación voluntaria
          await currentSub.unsubscribe();
          try {
            await fetch('/api/push-subscribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'unsubscribe', endpoint: currentSub.endpoint })
            });
          } catch (e) {}
          localStorage.removeItem(tokKey);
          await checkSubscription();
        } else {
          // Activación o Renovación/Reactivación
          if (currentSub) {
            // Limpiar suscripción anterior
            try {
              await currentSub.unsubscribe();
              await fetch('/api/push-subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'unsubscribe', endpoint: currentSub.endpoint })
              });
            } catch (e) {}
            if (tokKey) localStorage.removeItem(tokKey);
          }

          const perm = await Notification.requestPermission();
          if (perm !== 'granted') {
            await checkSubscription();
            return;
          }

          if (!serverKey) {
            throw new Error('El servicio VAPID no está activo en el servidor. Intenta en unos minutos.');
          }

          const newSub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlB64ToUint8Array(serverKey)
          });

          // Registrar en servidor y obtener test_token
          const subRes = await fetch('/api/push-subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'subscribe', subscription: newSub })
          });
          const subData = await subRes.json();
          if (!subRes.ok || !subData.ok) {
            throw new Error(subData.error || 'Error al registrar suscripción en la base de datos');
          }

          if (subData.test_token) {
            localStorage.setItem(getEndpointTokenKey(newSub.endpoint), subData.test_token);
          }

          await checkSubscription();
        }
      } catch (err) {
        console.error('[Push] Error al alternar notificaciones:', err);
        if (err.name === 'AbortError' || err.message?.includes('push service error')) {
          detail.textContent = 'El servicio Push del navegador no pudo conectar con los servidores de mensajería (FCM/Google). En computadoras esto ocurre comúnmente por políticas de red, firewall, VPN o perfiles de invitado en Chrome.';
        } else {
          detail.textContent = 'No se pudo completar la suscripción: ' + (err.message || 'Error de conexión');
        }
      } finally {
        btnToggle.disabled = false;
      }
    });

    if (btnTest) {
      btnTest.addEventListener('click', async () => {
        btnTest.disabled = true;
        btnTest.textContent = 'Enviando prueba…';
        try {
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.getSubscription();
          if (!sub) throw new Error('No hay suscripción activa');

          const testToken = localStorage.getItem(getEndpointTokenKey(sub.endpoint));
          if (!testToken) throw new Error('Credencial de prueba no encontrada. Pulsa «Reactivar notificaciones».');

          const res = await fetch('/api/push-test', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint, test_token: testToken })
          });
          const data = await res.json();
          if (!res.ok || !data.ok) {
            const diag = data.diagnostico ? (' (' + data.diagnostico.fase + ': ' + data.diagnostico.codigo + ')') : '';
            throw new Error((data.error || 'Fallo en envío de prueba') + diag);
          }
          btnTest.textContent = '¡Prueba enviada!';
          setTimeout(() => { btnTest.textContent = 'Probar en este dispositivo'; btnTest.disabled = false; }, 3000);
        } catch (err) {
          alert('Notificación de prueba: ' + err.message);
          btnTest.textContent = 'Probar en este dispositivo';
          btnTest.disabled = false;
        }
      });
    }

    await checkSubscription();
  }

  // Inicializar funciones nuevas al cargar
  window.addEventListener('DOMContentLoaded', () => {
    initThemeToggle();
    initTopbarNotificationButton();
    initPushNotifications();
  });

})();
