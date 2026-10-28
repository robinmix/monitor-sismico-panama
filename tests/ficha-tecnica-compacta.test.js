const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const htmlContent = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const cssContent = fs.readFileSync(path.join(ROOT, 'assets', 'style.css'), 'utf8');
const jsContent = fs.readFileSync(path.join(ROOT, 'assets', 'app.js'), 'utf8');

test('Ficha Técnica Compacta: Eliminación de los 5 textos redundantes en index.html', () => {
  // 1. Fecha y hora local
  assert.equal(htmlContent.includes('Zona horaria América/Panamá (UTC−5)'), false, 'No debe contener subtítulo de zona horaria');
  // 2. Fecha y hora universal
  assert.equal(htmlContent.includes('Tiempo Universal Coordinado'), false, 'No debe contener subtítulo de tiempo universal');
  // 3. Profundidad
  assert.equal(htmlContent.includes('id="sismoDepthCat"'), false, 'No debe contener elemento de categoría de profundidad');
  // 4. Coordenadas
  assert.equal(htmlContent.includes('id="sismoCoordDecimal"'), false, 'No debe contener elemento de coordenadas decimales repetidas');
  // 5. Localidad
  assert.equal(htmlContent.includes('id="sismoZone"'), false, 'No debe contener elemento sismoZone descriptivo');
});

test('Ficha Técnica Compacta: Preservación de encabezados principales y valores científicos', () => {
  assert.ok(htmlContent.includes('id="sismoRegionTitle"'), 'Debe conservar id sismoRegionTitle en cabecera');
  assert.ok(htmlContent.includes('id="sismoLocationDesc"'), 'Debe conservar id sismoLocationDesc en cabecera');
  assert.ok(htmlContent.includes('id="sismoTimeLocal"'), 'Debe conservar id sismoTimeLocal');
  assert.ok(htmlContent.includes('id="sismoTimeUtc"'), 'Debe conservar id sismoTimeUtc');
  assert.ok(htmlContent.includes('id="sismoDepth"'), 'Debe conservar id sismoDepth');
  assert.ok(htmlContent.includes('id="sismoCoordinates"'), 'Debe conservar id sismoCoordinates');
  assert.ok(htmlContent.includes('id="sismoTown"'), 'Debe conservar id sismoTown');
});

test('Ficha Técnica Compacta: Sección Magnitudes de otras agencias intacta (USGS, EMSC, GFZ)', () => {
  assert.ok(htmlContent.includes('id="sismoAgenciasSection"'), 'Debe conservar sismoAgenciasSection');
  assert.ok(htmlContent.includes('id="agenciaCardUsgs"'), 'Debe conservar tarjeta USGS');
  assert.ok(htmlContent.includes('id="agenciaCardEmsc"'), 'Debe conservar tarjeta EMSC');
  assert.ok(htmlContent.includes('id="agenciaCardGfz"'), 'Debe conservar tarjeta GFZ');
});

test('Ficha Técnica Compacta: app.js asigna localidad con geo-location-highlight sin párrafo redundante', () => {
  assert.ok(jsContent.includes("ui.sismoTown.className = 'param-val geo-location-highlight'"), 'Debe mantener highlight amarillo en localidad');
  assert.ok(jsContent.includes('if (ui.sismoZone) ui.sismoZone.textContent = \'\''), 'No debe renderizar párrafo redundante en sismoZone');
});

test('Ficha Técnica Compacta: style.css optimiza espaciado y oculta param-sub sin huecos', () => {
  assert.match(cssContent, /\.param-sub\s*\{[^}]*display:\s*none\s*!important/i, 'param-sub debe estar en display: none');
  assert.match(cssContent, /\.sismo-params-grid\s*\{[^}]*gap:\s*12px\s+20px/i, 'sismo-params-grid debe tener gap optimizado');
});

test('Ficha Técnica Compacta: Versión de caché v20261028ficha1 sincronizada', () => {
  const swContent = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.ok(swContent.includes('core-v20261028ficha1') || swContent.includes('core-v20261028nav1'), 'sw.js debe sincronizar core-v20261028ficha1');
  assert.ok(htmlContent.includes('assets/style.css?v=20261028ficha1') || htmlContent.includes('assets/style.css?v=20261028nav1'), 'index.html debe solicitar style.css versionado');
  assert.ok(htmlContent.includes('assets/app.js?v=20261028ficha1') || htmlContent.includes('assets/app.js?v=20261028nav1'), 'index.html debe solicitar app.js versionado');
});
