'use strict';

import { enrichEvents } from './geo-resolver.mjs';

// ÚNICA fuente de eventos sísmicos: Instituto de Geociencias, Universidad de Panamá.
const SOURCE_URLS = [
  'https://sismosgeociencias.up.ac.pa/',
  'https://www.sismosgeociencias.up.ac.pa/'
];
const TTL_MS = 3 * 60 * 1000;
let cached = null;
let pending = null;

function decodeEntities(input = '') {
  const named = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ', aacute:'á', eacute:'é', iacute:'í', oacute:'ó', uacute:'ú', Aacute:'Á', Eacute:'É', Iacute:'Í', Oacute:'Ó', Uacute:'Ú', ntilde:'ñ', Ntilde:'Ñ', deg:'°', ndash:'–', mdash:'—', '#39':"'" };
  return String(input).replace(/&(#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, (full, key) => {
    if (key.startsWith('#')) {
      const hex = /^#x/i.test(key);
      const n = parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : full;
    }
    return named[key] ?? full;
  });
}
function cleanHtml(input = '') {
  return decodeEntities(String(input).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}
function numberOf(input) {
  const n = Number.parseFloat(String(input).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function dateFromLocal(fecha, hora) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  const t = /^(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?$/i.exec(hora);
  if (!d || !t) return null;
  let hh = Number(t[1]);
  const mm = Number(t[2]);
  const ss = Number(t[3]);
  if (t[4]) hh = (hh % 12) + (t[4].toUpperCase() === 'PM' ? 12 : 0);
  if (hh > 23 || mm > 59 || ss > 59) return null;
  // Panamá utiliza UTC-05:00 durante todo el año.
  const ts = Date.UTC(+d[1], +d[2] - 1, +d[3], hh + 5, mm, ss);
  const dt = new Date(ts);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString();
}
function classifyRegion(raw) {
  const str = raw.replace(/^Localizado\s+en\s+/i, '').trim();
  const zone = str.match(/^(.+?)\s+a\s+\d+(?:[.,]\d+)?\s*km\b/i);
  const place = str.match(/\b\d+(?:[.,]\d+)?\s*km\s+al?\s+[^,]*?\s+de\s+([^\d,]+)$/i);
  return {
    zona: zone ? zone[1].trim() : str.split(/\s+a\s+\d+\s*km\b/i)[0].trim() || 'Sin clasificar',
    localidad: place ? place[1].trim() : 'Sin localidad especificada'
  };
}
function safeDetailUrl(fragment) {
  if (!fragment) return null;
  try {
    const url = new URL(decodeEntities(fragment), SOURCE_URLS[0]);
    return /(^|\.)sismosgeociencias\.up\.ac\.pa$/i.test(url.hostname) && url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}
function parseEvents(html) {
  const results = [];
  const seen = new Set();
  const rowRE = /<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi;
  for (const match of html.matchAll(rowRE)) {
    const row = match[1];
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td\s*>/gi)].map(m => m[1]);
    if (cells.length < 8) continue;
    const texts = cells.map(cleanHtml);
    // Se identifican columnas por sus valores para tolerar columnas extra/ocultas.
    const fechaIdx = texts.findIndex(c => /^\d{4}-\d{2}-\d{2}$/.test(c));
    if (fechaIdx < 1 || texts.length < fechaIdx + 7) continue;
    const estado = texts[fechaIdx - 1];
    const fecha = texts[fechaIdx];
    const hora = texts[fechaIdx + 1];
    const latitud = numberOf(texts[fechaIdx + 2]);
    const longitud = numberOf(texts[fechaIdx + 3]);
    const profundidad = numberOf(texts[fechaIdx + 4]);
    const magnitud = numberOf(texts[fechaIdx + 5]);
    const region = texts[fechaIdx + 6];
    const timestamp = dateFromLocal(fecha, hora);
    if (!timestamp || latitud === null || longitud === null || profundidad === null || magnitud === null ||
        Math.abs(latitud) > 90 || Math.abs(longitud) > 180 || magnitud < -2 || magnitud > 10 || profundidad < 0 || !region) continue;
    const key = [fecha, hora, latitud, longitud, magnitud].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    let detail = null;
    const detailCell = cells[fechaIdx + 7] || '';
    const link = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i.exec(detailCell);
    if (link) detail = safeDetailUrl(link[1] || link[2] || link[3]);
    const location = classifyRegion(region);
    results.push({
      id: key,
      estado,
      fecha,
      hora,
      timestamp,
      latitud,
      longitud,
      profundidad,
      magnitud,
      region,
      zona: location.zona,
      localidad: location.localidad,
      detalle: detail
    });
  }
  results.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return enrichEvents(results);
}
async function requestSource() {
  const errors = [];
  for (const url of SOURCE_URLS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 11500);
      let response;
      try {
        response = await fetch(url, { signal: controller.signal, headers: { Accept:'text/html', 'User-Agent':'MonitorSismicoIGC/1.0 (+informacion publica; uso respetuoso)' }, redirect: 'follow' });
      } finally { clearTimeout(timeout); }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const events = parseEvents(html);
      if (!events.length) throw new Error('No se reconocieron filas de la tabla; posiblemente cambió el formato de la fuente.');
      return { fuente:'IGC-UP', url, actualizado: new Date().toISOString(), totalFuente: events.length, eventos: events };
    } catch (error) { errors.push(`${new URL(url).hostname}: ${error.message}`); }
  }
  throw new Error(errors.join(' | '));
}
function json(statusCode, body) {
  return {statusCode, headers: { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60, stale-while-revalidate=120', 'Access-Control-Allow-Origin':'*', 'X-Content-Type-Options':'nosniff'}, body:JSON.stringify(body)};
}
async function handler() {
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) return json(200, cached.data);
  try {
    if (!pending) pending = requestSource().finally(() => { pending = null; });
    const data = await pending;
    cached = { fetchedAt: Date.now(), data };
    return json(200, data);
  } catch (e) {
    if (cached && Date.now() - cached.fetchedAt < 40 * 60 * 1000) return json(200, {...cached.data, desactualizado:true, aviso:'No se pudo consultar de nuevo al IGC-UP. Se muestra la última lectura obtenida.', detalleError:e.message});
    return json(502, { error:'No se pudieron leer los sismos del sitio oficial.', detalle:e.message, fuente:SOURCE_URLS[0] });
  }
}
export { handler, parseEvents, dateFromLocal, classifyRegion, requestSource };
