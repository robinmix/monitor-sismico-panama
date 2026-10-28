const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'index.html');
const CSS_PATH = path.join(ROOT, 'assets', 'style.css');
const JS_PATH = path.join(ROOT, 'assets', 'app.js');
const MANIFEST_PATH = path.join(ROOT, 'manifest.webmanifest');

const htmlContent = fs.readFileSync(HTML_PATH, 'utf-8');
const cssContent = fs.readFileSync(CSS_PATH, 'utf-8');
const jsContent = fs.readFileSync(JS_PATH, 'utf-8');
const manifestContent = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));

test('PWA Mobile Nav: viewport incluye viewport-fit=cover para Android notch y safe areas', () => {
  assert.match(
    htmlContent,
    /<meta\s+name=["']viewport["']\s+content=["'][^"']*viewport-fit=cover[^"']*["']/i,
    'Debe declarar viewport-fit=cover en la etiqueta meta viewport'
  );
});

test('PWA Mobile Nav: manifest.webmanifest incluye "id": "/" explícito y consistente', () => {
  assert.equal(manifestContent.id, '/', 'El id del manifest debe ser "/"');
  assert.equal(manifestContent.display, 'standalone', 'El modo de visualización debe ser standalone');
  assert.ok(Array.isArray(manifestContent.icons) && manifestContent.icons.length >= 2, 'Debe incluir al menos iconos 192 y 512');
});

test('PWA Mobile Nav: index.html contiene los 5 botones de navegación móvil requeridos', () => {
  assert.ok(htmlContent.includes('id="mobileBottomNav"'), 'Debe existir contenedor mobileBottomNav');
  const requiredTabs = ['sismos', 'mapa', 'cerca', 'historial', 'mas'];
  for (const tab of requiredTabs) {
    const pattern = new RegExp(`data-tab=["']${tab}["']`, 'i');
    assert.match(htmlContent, pattern, `Debe existir botón para pestaña "${tab}"`);
  }
});

test('PWA Mobile Nav: barra inferior está oculta por defecto en escritorio (> 640px)', () => {
  const baseHiddenMatch = cssContent.match(/\.mobile-bottom-nav\s*\{[^}]*display:\s*none/);
  assert.ok(baseHiddenMatch, 'La barra inferior móvil debe estar en display: none para escritorio');
});

test('PWA Mobile Nav: en móvil (<= 640px) la barra inferior es fija y respeta safe areas', () => {
  const media640Index = cssContent.indexOf('@media (max-width: 640px)');
  assert.ok(media640Index > 0, 'Debe existir bloque @media (max-width: 640px)');
  const media640Content = cssContent.slice(media640Index);

  assert.ok(media640Content.includes('.mobile-bottom-nav'), 'Debe estilizar .mobile-bottom-nav en <= 640px');
  assert.ok(media640Content.includes('position: fixed'), 'Debe tener position: fixed');
  assert.ok(media640Content.includes('env(safe-area-inset-bottom'), 'Debe contemplar env(safe-area-inset-bottom)');
  assert.ok(media640Content.includes('min-height: 48px'), 'Los botones deben tener tamaño táctil accesible (mínimo 48px)');
});

test('PWA Mobile Nav: el contenedor .page-shell tiene relleno inferior protector en móvil', () => {
  const media640Index = cssContent.indexOf('@media (max-width: 640px)');
  const media640Content = cssContent.slice(media640Index);
  assert.match(
    media640Content,
    /\.page-shell\s*\{[^}]*padding:[^}]*calc\(\s*76px\s*\+\s*env\(safe-area-inset-bottom/i,
    'El padding-bottom de .page-shell debe evitar que la barra fija tape contenido'
  );
});

test('PWA Mobile Nav: la barra superior (topbar) es fija y respeta env(safe-area-inset-top)', () => {
  const media640Index = cssContent.indexOf('@media (max-width: 640px)');
  const media640Content = cssContent.slice(media640Index);
  assert.match(
    media640Content,
    /\.topbar\s*\{[^}]*position:\s*sticky/i,
    'La topbar móvil debe ser fija/sticky'
  );
  assert.ok(
    media640Content.includes('env(safe-area-inset-top'),
    'La topbar debe proteger el área del notch/status bar superior con env(safe-area-inset-top)'
  );
});

test('PWA Mobile Nav: control dinámico de pestañas en CSS para sismos, mapa, cerca, historial y mas', () => {
  const media640Index = cssContent.indexOf('@media (max-width: 640px)');
  const media640Content = cssContent.slice(media640Index);

  assert.ok(media640Content.includes('[data-active-tab="sismos"]'), 'Debe tener regla para pestaña sismos');
  assert.ok(media640Content.includes('[data-active-tab="mapa"]'), 'Debe tener regla para pestaña mapa');
  assert.ok(media640Content.includes('[data-active-tab="cerca"]'), 'Debe tener regla para pestaña cerca');
  assert.ok(media640Content.includes('[data-active-tab="historial"]'), 'Debe tener regla para pestaña historial');
  assert.ok(media640Content.includes('[data-active-tab="mas"]'), 'Debe tener regla para pestaña mas');
});

test('PWA Mobile Nav: app.js contiene setMobileTab, activeMobileTab y soporte de navegación por hash', () => {
  assert.ok(jsContent.includes('function setMobileTab('), 'Debe implementar la función setMobileTab');
  assert.ok(jsContent.includes("activeMobileTab: 'sismos'"), 'state debe inicializar activeMobileTab');
  assert.ok(jsContent.includes("tabMap"), 'handleRouting debe mapear hashes a pestañas móviles');
  assert.ok(jsContent.includes("closeSismoDetail"), 'closeSismoDetail debe restaurar la pestaña activa');
});

test('PWA Mobile Cards: index.html contiene contenedores separados para tabla de escritorio y tarjetas móviles', () => {
  assert.ok(htmlContent.includes('id="desktopRecordsWrap"'), 'Debe existir contenedor desktopRecordsWrap');
  assert.ok(htmlContent.includes('id="mobileRecordsList"'), 'Debe existir contenedor mobileRecordsList');
});

test('PWA Mobile Cards: style.css oculta tarjetas móviles en escritorio y tabla en móviles', () => {
  const baseCardsMatch = cssContent.match(/\.mobile-records-list\s*\{[^}]*display:\s*none/);
  assert.ok(baseCardsMatch, 'Las tarjetas móviles deben estar ocultas en escritorio');

  const media640Index = cssContent.indexOf('@media (max-width: 640px)');
  const media640Content = cssContent.slice(media640Index);

  assert.ok(media640Content.includes('.desktop-only-table'), 'Debe estilizar .desktop-only-table en móvil');
  assert.match(media640Content, /\.desktop-only-table\s*\{[^}]*display:\s*none/i, 'La tabla debe ocultarse en móvil');
  assert.match(media640Content, /\.mobile-records-list\s*\{[^}]*display:\s*flex/i, 'Las tarjetas deben mostrarse en móvil');
});

test('PWA Mobile Cards: style.css incluye clases para diseño compacto (magnitud, parámetros y botón ver ficha)', () => {
  assert.ok(cssContent.includes('.sismo-mobile-card'), 'Debe definir clase .sismo-mobile-card');
  assert.ok(cssContent.includes('.card-mag-badge'), 'Debe definir clase .card-mag-badge');
  assert.ok(cssContent.includes('.card-params-grid'), 'Debe definir clase .card-params-grid');
  assert.ok(cssContent.includes('.card-ficha-btn'), 'Debe definir clase .card-ficha-btn');
});

test('PWA Mobile Cards: app.js genera las tarjetas con botón Ver Ficha y metadatos completos', () => {
  assert.ok(jsContent.includes('ui.mobileRecordsList.replaceChildren()'), 'drawTable debe resetear tarjetas móviles');
  assert.ok(jsContent.includes('card-mag-badge'), 'drawTable debe incluir badge de magnitud');
  assert.ok(jsContent.includes('card-chevron') || jsContent.includes('Ver ficha →'), 'drawTable debe incluir indicador de apertura de ficha (chevron o botón)');
  assert.ok(jsContent.includes('syncRecordsA11y'), 'Debe incluir función syncRecordsA11y para evitar duplicación de lectura en accesibilidad');
});

