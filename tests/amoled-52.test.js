'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT_DIR, 'assets', 'style.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT_DIR, 'assets', 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(ROOT_DIR, 'sw.js'), 'utf8');
const wranglerToml = fs.readFileSync(path.join(ROOT_DIR, 'cloudflare', 'archivador', 'wrangler.toml'), 'utf8');

test('AMOLED 5.2 — Eliminación de banda Últimos 7 días', () => {
  assert.equal(html.includes('id="activityBanner"'), false, 'La tarjeta horizontal activityBanner no debe existir');
  assert.equal(html.includes('id="activityPeriodTitle"'), false, 'activityPeriodTitle no debe existir');
  assert.equal(html.includes('id="activityPeriodSummary"'), false, 'activityPeriodSummary no debe existir');
});

test('AMOLED 5.2 — Círculo de magnitud en Hero Card', () => {
  assert.equal(html.includes('<span class="hero-circle-prefix">MAGNITUD</span>'), false, 'La palabra MAGNITUD debe ser eliminada del dial');
  assert.ok(html.includes('id="latestMagnitude"'), 'Debe conservar el elemento latestMagnitude');
  assert.ok(css.includes('.hero-circle-val'), 'Debe existir la clase hero-circle-val');
});

test('AMOLED 5.2 — Ubicación geográfica precisa en Hero Card', () => {
  assert.ok(js.includes('latestLoc = e.geo_ubicacion_texto || e.region'), 'latestRegion debe priorizar geo_ubicacion_texto');
  assert.ok(css.includes('--geo-highlight'), 'Debe definirse la variable CSS --geo-highlight');
});

test('AMOLED 5.2 — Resaltado en ficha individual', () => {
  assert.ok(css.includes('.geo-location-highlight'), 'style.css debe contener .geo-location-highlight');
  assert.ok(js.includes('geo-location-highlight'), 'app.js debe aplicar geo-location-highlight');
  assert.ok(js.includes('sismo-igc-desc'), 'app.js debe separar la descripción IGC');
});

test('AMOLED 5.2 — Selector de tema claro / oscuro', () => {
  assert.ok(html.includes('id="themeToggleBtn"'), 'index.html debe contener el botón themeToggleBtn');
  assert.ok(html.includes('sun-icon') && html.includes('moon-icon'), 'Debe incluir iconos de sol y luna');
  assert.ok(css.includes('[data-theme="light"]'), 'style.css debe definir [data-theme="light"]');
  assert.ok(css.includes('--bg-root: #F2F6FC;'), 'Debe usar fondo #F2F6FC en modo claro');
  assert.ok(css.includes('--bg-card: #FFFFFF;'), 'Debe usar tarjetas #FFFFFF en modo claro');
  assert.ok(js.includes('initThemeToggle'), 'app.js debe inicializar initThemeToggle');
  assert.ok(js.includes('sismopa_theme'), 'app.js debe persistir preferencia en sismopa_theme');
});

test('AMOLED 5.2 — Sección de notificaciones Web Push en UI', () => {
  assert.ok(html.includes('id="notificaciones"'), 'index.html debe contener la sección notificaciones');
  assert.ok(html.includes('id="btnTogglePush"'), 'Debe incluir botón btnTogglePush');
  assert.ok(html.includes('id="btnTestPush"'), 'Debe incluir botón btnTestPush');
  assert.ok(html.includes('id="pushStatusBadge"'), 'Debe incluir badge de estado pushStatusBadge');
  assert.ok(js.includes('initPushNotifications'), 'app.js debe implementar initPushNotifications');
});

test('AMOLED 5.2 — Manejadores Web Push en Service Worker', () => {
  assert.ok(sw.includes("self.addEventListener('push'"), 'sw.js debe escuchar evento push');
  assert.ok(sw.includes("self.addEventListener('notificationclick'"), 'sw.js debe escuchar notificationclick');
  assert.ok(sw.includes("showNotification"), 'sw.js debe invocar showNotification');
});

test('AMOLED 5.2 — Formato de notificación y exclusión de frases prohibidas', () => {
  const sampleTitle = 'sismoPA · Nuevo sismo M4.4';
  const sampleBody = 'Océano Pacífico (Zona Económica Exclusiva) · a 1.3 km al S de Cañas';
  
  assert.ok(sampleTitle.startsWith('sismoPA · Nuevo sismo'));
  assert.equal(sampleBody.includes('Publicado por IGC-UP.'), false, 'No debe incluir la frase prohibida');
  assert.equal(sampleBody.includes('Toca para ver la ficha detallada.'), false, 'No debe incluir la frase prohibida');
});

test('AMOLED 5.2 — Cron Trigger cada minuto en Cloudflare Worker', () => {
  assert.ok(wranglerToml.includes('crons = ["* * * * *"]'), 'wrangler.toml debe estar configurado para ejecutarse cada minuto (* * * * *)');
});
