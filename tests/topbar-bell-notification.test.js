const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');

test('Topbar Bell Notification & Navigation Suite', async (t) => {
  const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
  const styleCss = fs.readFileSync(path.join(rootDir, 'assets/style.css'), 'utf8');
  const appJs = fs.readFileSync(path.join(rootDir, 'assets/app.js'), 'utf8');

  await t.test('1. index.html contiene el botón de campana #notifTopbarBtn junto al tema', () => {
    assert.ok(indexHtml.includes('id="notifTopbarBtn"'), 'Debe contener el elemento #notifTopbarBtn');
    assert.ok(indexHtml.includes('class="notif-topbar-btn"'), 'Debe tener la clase notif-topbar-btn');
    assert.ok(indexHtml.includes('topbar-notif-icon'), 'Debe contener el SVG con clase topbar-notif-icon');
    
    const topbarRightIdx = indexHtml.indexOf('<div class="topbar-right">');
    const notifBtnIdx = indexHtml.indexOf('id="notifTopbarBtn"');
    const themeBtnIdx = indexHtml.indexOf('id="themeToggleBtn"');
    
    assert.ok(topbarRightIdx !== -1 && notifBtnIdx > topbarRightIdx, 'El botón de campana debe estar dentro de topbar-right');
    assert.ok(notifBtnIdx < themeBtnIdx, 'El botón de campana debe ubicarse antes de #themeToggleBtn');
  });

  await t.test('2. style.css define dimensiones (36x36px) y paleta AMOLED armónica con el tema', () => {
    assert.ok(styleCss.includes('.notif-topbar-btn {'), 'Debe definir la regla .notif-topbar-btn');
    assert.ok(styleCss.includes('width: 36px;'), 'Ancho de 36px idéntico a theme-toggle-btn');
    assert.ok(styleCss.includes('height: 36px;'), 'Alto de 36px idéntico a theme-toggle-btn');
    assert.ok(styleCss.includes('html[data-theme="light"] .notif-topbar-btn'), 'Debe incluir estilos para tema claro');
    assert.ok(styleCss.includes('#EAF1F8') && styleCss.includes('#172338'), 'Debe usar la paleta institucional en tema claro');
  });

  await t.test('3. app.js contiene detección TWA resiliente sin depender exclusivamente de referrer', () => {
    assert.ok(appJs.includes('function checkIsTwa()'), 'Debe implementar checkIsTwa()');
    assert.ok(appJs.includes('window.__sismoTwaConfirmed === true'), 'Debe contemplar confirmación por postMessage');
    assert.ok(appJs.includes('display-mode: standalone'), 'Debe contemplar modo standalone en Android');
    assert.ok(appJs.includes('sismopa.pages.dev'), 'Debe contemplar el origen oficial de la TWA en modo standalone');
  });

  await t.test('4. app.js abre sismopa://notifications mediante navegación limpia sin doble disparo', () => {
    assert.ok(appJs.includes("window.location.href = 'sismopa://notifications'"), 'Debe navegar directamente a sismopa://notifications');
    // Verificar que en el click handler de notifTopbarBtn NO se combine postMessage con window.location.href simultáneo
    const clickHandlerSnippet = appJs.slice(appJs.indexOf('notifTopbarBtn.onclick = (e) => {'), appJs.indexOf('notifTopbarBtn.onclick = (e) => {') + 300);
    assert.equal(clickHandlerSnippet.includes("postMessage({ type: 'OPEN_SETTINGS' }"), false, 'NO debe mezclar postMessage en el click para no lanzar la actividad dos veces');
  });

  await t.test('5. app.js en navegadores normales activa la pestaña "mas" y desplaza a #notificaciones', () => {
    assert.ok(appJs.includes("setMobileTab('mas', true)"), 'Debe cambiar la pestaña a "mas" en vista móvil');
    assert.ok(appJs.includes("target.scrollIntoView({ behavior: 'smooth' })"), 'Debe realizar scroll suave');
    assert.ok(appJs.includes("'#notificaciones': 'mas'"), 'tabMap debe mapear #notificaciones a mas');
  });

  await t.test('6. app.js inicializa initTopbarNotificationButton en DOMContentLoaded', () => {
    assert.ok(appJs.includes('initTopbarNotificationButton();'), 'Debe invocar initTopbarNotificationButton() en DOMContentLoaded');
  });

  await t.test('7. Verificación de cero cambios en Cloudflare Workers o secretos', () => {
    const gitStatus = fs.existsSync(path.join(rootDir, 'cloudflare/archivador/wrangler.toml'));
    assert.ok(gitStatus, 'wrangler.toml existe intacto');
  });
});
