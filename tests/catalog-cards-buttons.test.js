const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const htmlContent = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const cssContent = fs.readFileSync(path.join(ROOT, 'assets', 'style.css'), 'utf8');
const jsContent = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');

test('Catálogo móvil: Tarjetas son superficies completas pulsables con rol button y tabindex 0', () => {
  assert.ok(jsContent.includes("card.setAttribute('role', 'button')"), 'Tarjeta debe tener role="button"');
  assert.ok(jsContent.includes("card.setAttribute('tabindex', '0')"), 'Tarjeta debe tener tabindex="0"');
  assert.ok(jsContent.includes("card.addEventListener('click', openCardFicha)"), 'Tarjeta debe tener listener de click');
  assert.ok(jsContent.includes("card.addEventListener('keydown'"), 'Tarjeta debe tener listener de teclado');
  assert.ok(jsContent.includes("evt.key === 'Enter' || evt.key === ' '"), 'Debe admitir activación con Enter y Espacio');
});

test('Catálogo móvil: Indicador visual discreto chevron (sin texto adicional) e icono SVG', () => {
  assert.ok(jsContent.includes('card-chevron'), 'drawTable debe generar span.card-chevron');
  assert.ok(cssContent.includes('.card-chevron'), 'style.css debe definir estilos para .card-chevron');
  assert.ok(jsContent.includes('polyline points="9 18 15 12 9 6"'), 'Chevron SVG debe estar presente en app.js');
});

test('Catálogo móvil: Eliminación de botón Ficha y optimización de espacio vertical', () => {
  assert.ok(cssContent.includes('.card-action-row,'), 'style.css debe contemplar .card-action-row');
  assert.match(cssContent, /\.card-action-row,\s*\.card-ficha-btn\s*\{[^}]*display:\s*none\s*!important/i, 'card-action-row y card-ficha-btn deben tener display: none');
  assert.match(cssContent, /\.sismo-mobile-card\s*\{[^}]*grid-template-columns:\s*46px\s+1fr\s+18px/i, 'La tarjeta debe usar 3 columnas compactas');
});

test('Botones: Exportar CSV (#242624, borde #727870, texto #F2F0EA, peso 700)', () => {
  assert.match(cssContent, /\.download-button\s*\{[^}]*background:\s*#242624;/i, 'Exportar CSV debe tener fondo #242624');
  assert.match(cssContent, /\.download-button\s*\{[^}]*border:\s*1px solid #727870;/i, 'Exportar CSV debe tener borde #727870');
  assert.match(cssContent, /\.download-button\s*\{[^}]*color:\s*#F2F0EA;/i, 'Exportar CSV debe tener texto #F2F0EA');
  assert.match(cssContent, /\.download-button\s*\{[^}]*font-weight:\s*700;/i, 'Exportar CSV debe tener font-weight 700');
});

test('Botones: Actualizar (#454A45, texto #FFFFFF, peso 700 y hover #525852)', () => {
  assert.match(cssContent, /\.refresh-button\s*\{[^}]*background:\s*#454A45;/i, 'Actualizar debe tener fondo #454A45');
  assert.match(cssContent, /\.refresh-button\s*\{[^}]*color:\s*#FFFFFF;/i, 'Actualizar debe tener texto #FFFFFF');
  assert.match(cssContent, /\.refresh-button\s*\{[^}]*font-weight:\s*700;/i, 'Actualizar debe tener font-weight 700');
  assert.match(cssContent, /\.refresh-button:hover:not\(:disabled\)\s*\{[^}]*background:\s*#525852;/i, 'Actualizar hover debe ser #525852');
});

test('Tema Claro: Contraste y variantes adecuadas para botones y tarjetas', () => {
  assert.match(cssContent, /html\[data-theme="light"\]\s+\.download-button\s*\{[^}]*background:\s*#E8ECEF/i, 'Exportar CSV en tema claro debe usar fondo suave de alto contraste');
  assert.match(cssContent, /html\[data-theme="light"\]\s+\.refresh-button\s*\{[^}]*background:\s*#172338/i, 'Actualizar en tema claro debe usar pizarra #172338');
  assert.match(cssContent, /html\[data-theme="light"\]\s+\.sismo-mobile-card\s*\{[^}]*background:\s*#FFFFFF/i, 'Tarjeta en tema claro debe ser fondo blanco #FFFFFF');
});

test('Caché y Service Worker: Sincronización v20261028catalog1', () => {
  const swContent = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.ok(swContent.includes('core-v20261028catalog1') || swContent.includes('core-v20261028ficha1') || swContent.includes('core-v20261028nav1') || swContent.includes('core-v20261028nav2') || swContent.includes('core-v20261028nav2'), 'sw.js debe contener clave de caché renovada');
  assert.ok(htmlContent.includes('assets/style.css?v=20261028catalog1') || htmlContent.includes('assets/style.css?v=20261028ficha1') || htmlContent.includes('assets/style.css?v=20261028nav1') || htmlContent.includes('assets/style.css?v=20261028nav2'), 'index.html debe solicitar style.css versionado');
  assert.ok(htmlContent.includes('assets/app.js?v=20261028catalog1') || htmlContent.includes('assets/app.js?v=20261028ficha1') || htmlContent.includes('assets/app.js?v=20261028nav1') || htmlContent.includes('assets/app.js?v=20261028nav2'), 'index.html debe solicitar app.js versionado');
});
