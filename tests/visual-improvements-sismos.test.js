const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve('C:/Users/robin/OneDrive/Documentos/GitHub/frontend-pages-worktree');

test('Suite Visual Improvements — Pantalla Principal Sismos', async (t) => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'assets/style.css'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'assets/app.js'), 'utf8');

  await t.test('1. Eliminar información visual redundante: Fuente leída', () => {
    // .last-foot must be hidden in CSS
    assert.match(css, /\.last-foot\s*\{\s*display:\s*none\s*!important;\s*\}/, '.last-foot debe estar oculto en CSS');
    // index.html has display: none style
    assert.match(html, /class="last-foot"\s+style="display:\s*none;"/, 'last-foot debe tener display:none en markup');
    // app.js still contains the internal logic
    assert.ok(js.includes("set('snapshotStatus'"), 'app.js debe conservar la llamada interna sin romper el código');
  });

  await t.test('2. Centrar y mejorar el contador de tiempo transcurrido', () => {
    // .timer-box is centered
    assert.match(css, /\.timer-box\s*\{[^}]*text-align:\s*center;/, '.timer-box debe tener text-align center');
    // .timer-label is centered
    assert.match(css, /\.timer-label\s*\{[^}]*text-align:\s*center;/, '.timer-label debe tener text-align center');
    // .live-counter is centered
    assert.match(css, /\.live-counter\s*\{[^}]*justify-content:\s*center;/, '.live-counter debe tener justify-content center');
    // .counter-unit strong has tabular numbers and font-size >= 24px
    assert.match(css, /\.counter-unit strong\s*\{[^}]*font-variant-numeric:\s*tabular-nums;/, 'counter strong debe tener tabular-nums');
    assert.match(css, /\.counter-unit strong\s*\{[^}]*font-weight:\s*800;/, 'counter strong debe tener font-weight 800');
  });

  await t.test('3. Título de estadísticas dinámico y "SISMOS EN LOS ÚLTIMOS 7 DÍAS"', () => {
    // index.html has statTotalTitle with 7 days text
    assert.match(html, /<span id="statTotalTitle">SISMOS EN LOS ÚLTIMOS 7 DÍAS<\/span>/, 'Encabezado inicial debe ser SISMOS EN LOS ÚLTIMOS 7 DÍAS');
    // app.js has dynamic period title updater
    assert.ok(js.includes('periodHours === 168'), 'app.js debe evaluar 168 horas');
    assert.ok(js.includes("'SISMOS EN LOS ÚLTIMOS 7 DÍAS'"), 'app.js debe asignar SISMOS EN LOS ÚLTIMOS 7 DÍAS para 168h');
    assert.ok(js.includes("'SISMOS EN TODO EL HISTORIAL'"), 'app.js debe asignar SISMOS EN TODO EL HISTORIAL para 0');
    assert.ok(js.includes("set('statTotalTitle'"), 'app.js debe actualizar statTotalTitle');
  });

  await t.test('4. Eliminar texto redundante: en la lista de la fuente', () => {
    // #statTotalHint must be hidden in CSS and markup
    assert.match(css, /#statTotalHint\s*\{\s*display:\s*none\s*!important;\s*\}/, '#statTotalHint debe estar oculto en CSS');
    assert.match(html, /id="statTotalHint"\s+style="display:\s*none;"/, '#statTotalHint debe tener display:none en markup');
    // Internal data remains intact in app.js
    assert.ok(js.includes("set('statTotalHint'"), 'app.js debe seguir actualizando internamente statTotalHint');
  });

  await t.test('5. Parámetros de geolocalización GPS intactos', () => {
    assert.ok(js.includes('timeout: 8000') && js.includes('maximumAge: 300000'), 'GPS Intento 1 intacto');
    assert.ok(js.includes('timeout: 20000') && js.includes('maximumAge: 60000'), 'GPS Intento 2 intacto');
  });
});
