const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'assets', 'style.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');

test('1. Pestaña Más: Cero filtros, cero catálogos y cero gráficas de actividad sísmica', () => {
  // En style.css dentro de [data-active-tab="mas"], filter-panel, chart-layout y section-regions deben estar ocultos
  const masBlock = css.match(/#dashboardView\[data-active-tab="mas"\]\s*\{([\s\S]*?)(?=#dashboardView|\n\s*@media|\n\s*\/\*)/);
  assert.ok(masBlock, 'Bloque de pestaña mas debe existir en style.css');
  
  // Buscar selector de ocultamiento de mas
  const masHiddenMatch = css.match(/#dashboardView\[data-active-tab="mas"\]\s*>\s*\.filter-panel/);
  assert.ok(masHiddenMatch, 'data-active-tab="mas" debe incluir selector para ocultar .filter-panel');
  assert.ok(css.includes('#dashboardView[data-active-tab="mas"] > .chart-layout'), 'data-active-tab="mas" debe ocultar .chart-layout');
  assert.ok(css.includes('#dashboardView[data-active-tab="mas"] > .section-regions'), 'data-active-tab="mas" debe ocultar .section-regions');
  assert.ok(css.includes('#dashboardView[data-active-tab="mas"] > .records-section'), 'data-active-tab="mas" debe ocultar .records-section');
  assert.ok(css.includes('#dashboardView[data-active-tab="mas"] > .section-notifications'), 'data-active-tab="mas" debe mostrar .section-notifications');
  assert.ok(css.includes('#dashboardView[data-active-tab="mas"] > .section-transparency'), 'data-active-tab="mas" debe mostrar .section-transparency');
});

test('2. Pestaña Historial: No duplica "07 / EVENTOS DETALLADOS" y presenta registros históricos', () => {
  assert.ok(html.includes('kicker-recent'), 'index.html debe marcar kicker-recent');
  assert.ok(html.includes('kicker-hist'), 'index.html debe incluir kicker-hist para archivo histórico');
  assert.ok(html.includes('title-recent'), 'index.html debe marcar title-recent');
  assert.ok(html.includes('title-hist'), 'index.html debe incluir title-hist para archivo histórico');
  assert.ok(html.includes('id="histRecordCount"'), 'index.html debe incluir contador específico para archivo histórico');

  // En CSS móvil para data-active-tab="historial", kicker-recent debe ocultarse y kicker-hist debe mostrarse
  assert.ok(css.includes('#dashboardView[data-active-tab="historial"] .records-head .kicker-recent'), 'Debe ocultar kicker reciente en historial');
  assert.ok(css.includes('#dashboardView[data-active-tab="historial"] .records-head .kicker-hist'), 'Debe mostrar kicker historico en historial');
  assert.ok(css.includes('#dashboardView[data-active-tab="historial"] .records-head .title-recent'), 'Debe ocultar titulo reciente en historial');
  assert.ok(css.includes('#dashboardView[data-active-tab="historial"] .records-head .title-hist'), 'Debe mostrar titulo historico en historial');
});

test('3. Escritorio: Mantiene flujo continuo y títulos recientes sin alteraciones', () => {
  // Por defecto (escritorio), kicker-recent visible y kicker-hist oculto
  assert.ok(css.includes('.records-head .kicker-recent'), 'Debe definir regla base para kicker-recent');
  assert.ok(css.includes('.records-head .kicker-hist'), 'Debe definir regla base para kicker-hist');
  assert.ok(css.includes('.records-head .title-hist'), 'Debe definir regla base para title-hist');
});

test('4. Enrutamiento y Hash Navigation: Filtros pertenecen a historial, no a más', () => {
  assert.ok(js.includes("'#filtros': 'historial'"), 'tabMap debe mapear #filtros a historial');
  assert.ok(js.includes("'#registros': 'sismos'"), 'tabMap debe mapear #registros a sismos');
  assert.ok(js.includes("'#notificaciones': 'mas'"), 'tabMap debe mapear #notificaciones a mas');
  assert.ok(js.includes("'#transparencia': 'mas'"), 'tabMap debe mapear #transparencia a mas');
});

test('5. Web Push: Estados diferenciados y claridad de mensajes', () => {
  assert.ok(js.includes('Notificaciones desactivadas'), 'Debe manejar estado Notificaciones desactivadas');
  assert.ok(js.includes('Permiso denegado'), 'Debe manejar estado Permiso denegado');
  assert.ok(js.includes('Servicio no disponible'), 'Debe manejar estado Servicio no disponible');
  assert.ok(js.includes('Error de conexión'), 'Debe manejar estado Error de conexión');
  assert.ok(js.includes('isSupported = window.isSecureContext'), 'Debe verificar contexto seguro HTTPS para Push');
});
