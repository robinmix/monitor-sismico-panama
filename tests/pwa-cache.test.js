/**
 * SismoData Panamá — Pruebas de integración y políticas de caché PWA / Service Worker
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const swCode = fs.readFileSync(path.join(ROOT_DIR, 'sw.js'), 'utf8');
const htmlCode = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const appCode = fs.readFileSync(path.join(ROOT_DIR, 'assets', 'app.js'), 'utf8');
const netlifyToml = fs.readFileSync(path.join(ROOT_DIR, 'netlify.toml'), 'utf8');

test('PWA SW: sw.js compila y tiene sintaxis válida', () => {
  assert.doesNotThrow(() => {
    new Function(swCode);
  });
});

test('PWA SW: Prefijo de caché acotado a sismodata y no borra cachés ajenas', () => {
  assert.match(swCode, /const CACHE_PREFIX = 'sismodata-';/);
  // Verificar que la limpieza filtra explícitamente por el prefijo sismodata
  assert.match(swCode, /name\.startsWith\(CACHE_PREFIX\)/);
});

test('PWA SW: Bypass estricto (Network-Only) para APIs de sismicidad dinámica y Supabase', () => {
  const dynamicSources = [
    '/.netlify/functions/',
    '/functions/',
    'supabase.co',
    'sismosgeociencias.up.ac.pa'
  ];
  for (const src of dynamicSources) {
    assert.ok(swCode.includes(src), `sw.js debe contener la regla de bypass para: ${src}`);
  }
  // Verificar que se despacha directamente a fetch sin pasar por la caché
  assert.match(swCode, /url\.pathname\.includes\('\/\.netlify\/functions\/'\)[\s\S]*event\.respondWith\(fetch\(req\)\)/);
});

test('PWA SW: Bypass de teselas cartográficas para no saturar Cache Storage', () => {
  assert.ok(swCode.includes('tiles.openfreemap.org'));
  assert.ok(swCode.includes('tile.openstreetmap.org'));
});

test('PWA SW: Estrategia Network-First para navegación HTML con fallback offline', () => {
  assert.match(swCode, /req\.mode === 'navigate'/);
  assert.match(swCode, /networkFirstWithTimeout\(req, CURRENT_CACHES\.core, \d+, '\.\/index\.html'\)/);
});

test('PWA SW: Estrategia Network-First para JavaScript y CSS propios del App Shell', () => {
  assert.match(swCode, /url\.pathname\.endsWith\('\/app\.js'\) \|\| url\.pathname\.endsWith\('\/style\.css'\)/);
  assert.match(swCode, /networkFirstWithTimeout\(req, CURRENT_CACHES\.core, \d+\)/);
});

test('PWA SW: Tolerancia a parámetros de versión (?v=...) mediante ignoreSearch: true', () => {
  // Debe incluir ignoreSearch en los matches
  assert.match(swCode, /caches\.match\([^)]*\{\s*ignoreSearch:\s*true\s*\}/);
});

test('PWA SW: Librerías fijas de terceros (Google Fonts, unpkg Leaflet/MapLibre) en caché vendor', () => {
  assert.match(swCode, /CURRENT_CACHES\.vendor/);
  assert.match(swCode, /staleWhileRevalidate\(req, CURRENT_CACHES\.vendor\)/);
});

test('PWA HTML: Versionado sincronizado de style.css y app.js en index.html', () => {
  const cssMatch = htmlCode.match(/href="assets\/style\.css\?v=([^"]+)"/);
  const jsMatch = htmlCode.match(/src="assets\/app\.js\?v=([^"]+)"/);

  assert.ok(cssMatch, 'style.css debe tener parámetro de versión ?v=');
  assert.ok(jsMatch, 'app.js debe tener parámetro de versión ?v=');
  assert.equal(cssMatch[1], jsMatch[1], 'style.css y app.js deben compartir la misma versión sincronizada');
});

test('PWA App: Registro no intrusivo sin recargas forzadas en interacción', () => {
  assert.match(appCode, /registration\.addEventListener\('updatefound'/);
  assert.match(appCode, /document\.addEventListener\('visibilitychange'/);
  // Verificar que NO existe window.location.reload()
  assert.ok(!appCode.includes('window.location.reload()'), 'app.js no debe forzar recargas bruscas con window.location.reload()');
});

test('PWA Privacidad: Las coordenadas de geolocalización NO se persisten en disco ni caché', () => {
  assert.ok(!swCode.includes('userCoords'), 'El Service Worker no debe manipular coordenadas de usuario');
  assert.ok(!appCode.includes('localStorage.setItem("userCoords"'), 'app.js no debe persistir coordenadas en localStorage');
  assert.ok(!appCode.includes('sessionStorage.setItem("userCoords"'), 'app.js no debe persistir coordenadas en sessionStorage');
});

test('Netlify Config: Encabezados HTTP de caché óptimos para PWA', () => {
  assert.match(netlifyToml, /for = "\/sw\.js"[\s\S]*Cache-Control = "no-cache, no-store, must-revalidate"/);
  assert.match(netlifyToml, /for = "\/"[\s\S]*Cache-Control = "public, max-age=0, must-revalidate"/);
  assert.match(netlifyToml, /for = "\/index\.html"[\s\S]*Cache-Control = "public, max-age=0, must-revalidate"/);
  assert.match(netlifyToml, /for = "\/manifest\.webmanifest"[\s\S]*Cache-Control = "public, max-age=0, must-revalidate"/);
});
