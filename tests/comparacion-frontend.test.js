const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');

const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(rootDir, 'assets', 'style.css'), 'utf8');
const appJs = fs.readFileSync(path.join(rootDir, 'assets', 'app.js'), 'utf8');

test('Suite Frontend — Comparación Internacional de Magnitudes', async (t) => {
  await t.test('1. index.html elimina campos visibles de UID y Fuente Científica', () => {
    assert.equal(indexHtml.includes('>FUENTE CIENTÍFICA — IGC-UP<'), false, 'No debe tener etiqueta visible de fuente cientifica');
    assert.equal(indexHtml.includes('>IDENTIFICADOR ESTABLE (UID)<'), false, 'No debe tener etiqueta visible de UID');
    // Debe preservar el elemento con id sismoUidText oculto para mantener compatibilidad JS interna
    assert.ok(indexHtml.includes('id="sismoUidText" hidden'), 'Debe conservar id sismoUidText con atributo hidden');
  });

  await t.test('2. index.html contiene sección compacta con exactamente 3 recuadros (USGS, EMSC, GFZ)', () => {
    assert.ok(indexHtml.includes('id="sismoAgenciasSection"'), 'Debe existir id sismoAgenciasSection');
    assert.ok(indexHtml.includes('Magnitudes de otras agencias'), 'Debe contener título exacto');
    assert.ok(indexHtml.includes('id="agenciaCardUsgs"'), 'Debe contener recuadro USGS');
    assert.ok(indexHtml.includes('id="agenciaCardEmsc"'), 'Debe contener recuadro EMSC');
    assert.ok(indexHtml.includes('id="agenciaCardGfz"'), 'Debe contener recuadro GFZ');

    // Extraer bloque de agencias
    const startIdx = indexHtml.indexOf('id="sismoAgenciasSection"');
    const endIdx = indexHtml.indexOf('<!-- /COMPARACIÓN INTERNACIONAL DE MAGNITUDES -->', startIdx) !== -1
      ? indexHtml.indexOf('<!-- /COMPARACIÓN INTERNACIONAL DE MAGNITUDES -->', startIdx)
      : indexHtml.indexOf('</article>', startIdx);
    const agenciasBlock = indexHtml.slice(startIdx, endIdx);

    // Cero enlaces o botones interactivos hacia agencias externas
    assert.equal(agenciasBlock.includes('<a '), false, 'Los recuadros no deben contener enlaces <a>');
    assert.equal(agenciasBlock.includes('<button'), false, 'Los recuadros no deben contener botones <button>');
  });

  await t.test('3. index.html incluye transparencia y atribución científica a catálogos internacionales', () => {
    assert.ok(indexHtml.includes('USGS'), 'Debe citar USGS en fuentes');
    assert.ok(indexHtml.includes('EMSC'), 'Debe citar EMSC en fuentes');
    assert.ok(indexHtml.includes('GFZ'), 'Debe citar GFZ en fuentes');
    assert.ok(indexHtml.includes('Catálogos Sísmicos Internacionales:'), 'Debe tener acápite de catálogos internacionales');
  });

  await t.test('4. style.css implementa estilos AMOLED 5.2 y soporte tema claro', () => {
    assert.ok(styleCss.includes('.sismo-agencias-section'), 'Debe incluir clase .sismo-agencias-section');
    assert.ok(styleCss.includes('.sismo-agencias-grid'), 'Debe incluir grid responsive de 3 columnas');
    assert.ok(styleCss.includes('.sismo-agencia-card'), 'Debe incluir estilos para las tarjetas');
    assert.ok(styleCss.includes('min-height: 68px') || styleCss.includes('min-height: 64px'), 'Debe prevenir Cumulative Layout Shift (CLS)');

    // Tema claro
    assert.ok(styleCss.includes('html[data-theme="light"] .sismo-agencia-card'), 'Debe incluir overrides para tema claro');
  });

  await t.test('5. app.js contiene motor de consulta bajo demanda y caché en memoria', () => {
    assert.ok(appJs.includes('const agencyComparisonCache = new Map();'), 'Debe declarar caché en memoria Map');
    assert.ok(appJs.includes('function resetAgencyBoxes()'), 'Debe tener función resetAgencyBoxes');
    assert.ok(appJs.includes('function applyAgencyData('), 'Debe tener función applyAgencyData');
    assert.ok(appJs.includes('async function loadInternationalComparisons(e, uid)'), 'Debe tener función loadInternationalComparisons');
    assert.ok(appJs.includes('loadInternationalComparisons(e, uid);'), 'renderSismoDetail debe invocar loadInternationalComparisons');
  });

  await t.test('6. app.js maneja descarte de carreras si el usuario cambia de ficha rápidamente', () => {
    assert.ok(appJs.includes('let activeComparisonRequestId = null;'), 'Debe rastrear activeComparisonRequestId');
    assert.ok(appJs.includes('if (activeComparisonRequestId === uid)'), 'Debe comprobar que la respuesta coincida con la ficha activa');
  });
});
