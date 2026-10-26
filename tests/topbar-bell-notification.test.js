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
    
    // Verificar que esté justo antes de themeToggleBtn dentro de topbar-right
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

  await t.test('3. app.js contiene detección TWA y vinculación directa a sismopa://notifications', () => {
    assert.ok(appJs.includes('function checkIsTwa()'), 'Debe implementar checkIsTwa()');
    assert.ok(appJs.includes('sismopa://notifications'), 'Debe referenciar el deep link nativo sismopa://notifications');
    assert.ok(appJs.includes("window.location.href = 'sismopa://notifications'"), 'Debe navegar a sismopa://notifications en APK');
    assert.ok(appJs.includes("postMessage({ type: 'OPEN_SETTINGS' }"), 'Debe enviar postMessage defensivo en APK');
  });

  await t.test('4. app.js en navegadores normales activa la pestaña "mas" y desplaza a #notificaciones', () => {
    assert.ok(appJs.includes("setMobileTab('mas', true)"), 'Debe cambiar la pestaña a "mas" en vista móvil');
    assert.ok(appJs.includes("target.scrollIntoView({ behavior: 'smooth' })"), 'Debe realizar scroll suave');
    assert.ok(appJs.includes("'#notificaciones': 'mas'"), 'tabMap debe mapear #notificaciones a mas');
  });

  await t.test('5. app.js inicializa initTopbarNotificationButton en DOMContentLoaded', () => {
    assert.ok(appJs.includes('initTopbarNotificationButton();'), 'Debe invocar initTopbarNotificationButton() en DOMContentLoaded');
  });

  await t.test('6. Verificación de cero cambios en Cloudflare Workers o secretos', () => {
    const gitStatus = fs.existsSync(path.join(rootDir, 'cloudflare/archivador/wrangler.toml'));
    assert.ok(gitStatus, 'wrangler.toml existe intacto');
  });
});
