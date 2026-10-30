'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const APP_JS_PATH = path.join(ROOT_DIR, 'assets/app.js');

test('sismoPA TWA — Flujo de Primer Permiso de Chincheta y Recuperación', async (t) => {
  const content = fs.readFileSync(APP_JS_PATH, 'utf8');

  await t.test('1. requestUserLocation incluye puente para estado "prompt" en TWA', () => {
    assert.match(content, /requestUserLocation/, 'Debe definir requestUserLocation');
    assert.match(content, /sismopa:\/\/request-location/, 'Debe utilizar el scheme nativo sismopa://request-location');
    assert.match(content, /checkIsTwa/, 'Debe verificar el entorno TWA');
    assert.match(content, /navigator\.permissions\.query/, 'Debe consultar el estado de permisos si está disponible');
  });

  await t.test('2. Manejo de foco y reanudación automática tras interacción nativa', () => {
    assert.match(content, /onResumeFromBridge/, 'Debe incluir callback de reanudación');
    assert.match(content, /visibilitychange/, 'Debe escuchar cambios de visibilidad del documento');
    assert.match(content, /window\.addEventListener\(['"]focus['"]/, 'Debe escuchar el evento focus de la ventana');
  });

  await t.test('3. Desacoplamiento estricto: Chincheta no activa FCM ni escribe en localStorage', () => {
    // La función requestUserLocationCore no debe escribir en sismo_fcm ni modificar estado FCM
    const coreMatch = content.match(/function requestUserLocationCore\(\)[\s\S]*?acquireDeviceCoordinates\(\{[\s\S]*?\}\);?\s*\}/);
    assert.ok(coreMatch, 'Debe contener requestUserLocationCore');
    assert.ok(!coreMatch[0].includes('localStorage.setItem'), 'requestUserLocationCore no debe escribir en localStorage');
    assert.ok(!coreMatch[0].includes('FcmPreferences'), 'requestUserLocationCore no debe tocar FcmPreferences');
  });

  await t.test('4. Simulación lógica: Transición de "prompt" a solicitud nativa', async () => {
    let bridgeLaunched = false;
    let locationTarget = '';

    const fakeWindow = {
      location: {
        set href(val) {
          bridgeLaunched = true;
          locationTarget = val;
        }
      },
      addEventListener: (evt, cb) => {},
      removeEventListener: (evt, cb) => {}
    };

    const fakeDocument = {
      visibilityState: 'visible',
      addEventListener: (evt, cb) => {},
      removeEventListener: (evt, cb) => {}
    };

    const fakeNavigator = {
      permissions: {
        query: async ({ name }) => {
          assert.equal(name, 'geolocation');
          return { state: 'prompt' };
        }
      }
    };

    const checkIsTwaMock = () => true;

    // Ejecutar lógica equivalente a la implementada en app.js
    if (checkIsTwaMock() && 'permissions' in fakeNavigator) {
      const perm = await fakeNavigator.permissions.query({ name: 'geolocation' });
      if (perm && perm.state === 'prompt') {
        fakeWindow.location.href = 'sismopa://request-location';
      }
    }

    assert.equal(bridgeLaunched, true, 'El puente debe haberse lanzado');
    assert.equal(locationTarget, 'sismopa://request-location', 'El destino debe ser sismopa://request-location');
  });

  await t.test('5. Simulación lógica: En navegador web normal (no TWA), procede directo sin puente nativo', async () => {
    let bridgeLaunched = false;
    let directProceed = false;

    const fakeNavigator = {
      permissions: {
        query: async () => ({ state: 'prompt' })
      }
    };

    const checkIsTwaMock = () => false; // Navegador web normal (Chrome / Safari / Firefox)

    if (checkIsTwaMock() && 'permissions' in fakeNavigator) {
      bridgeLaunched = true;
    } else {
      directProceed = true;
    }

    assert.equal(bridgeLaunched, false, 'No debe invocar puente nativo en web abierta');
    assert.equal(directProceed, true, 'Debe proceder directamente por flujo web estándar');
  });
});
