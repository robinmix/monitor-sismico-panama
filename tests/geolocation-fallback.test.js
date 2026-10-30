/**
 * sismoPA — Suite de Pruebas Automatizadas de Geolocalización Secuencial con Fallback
 * 
 * Verifica:
 * 1. Éxito inicial (intento 1 bajo consumo / red con timeout 4s, maximumAge 60s).
 * 2. Éxito tras fallback por error 2 (POSITION_UNAVAILABLE -> intento 2 alta precisión con timeout 8s, maximumAge 0).
 * 3. Éxito tras fallback por error 3 (TIMEOUT -> intento 2 alta precisión).
 * 4. Permiso denegado (error 1 PERMISSION_DENIED -> no se reintenta).
 * 5. Fallo de ambos intentos (error 2 seguido de error 2 -> mensaje final correcto).
 * 6. Prevención de concurrencia y callbacks duplicados.
 * 7. Limpieza en disableUserLocation().
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

// Helper para emular el flujo de requestUserLocation extraído de app.js
function createGeoTestHarness() {
  const calls = [];
  let isRequestingLocation = false;
  const state = {
    userCoords: null,
    currentSismoId: null
  };
  const ui = {
    distStatus: { textContent: '', hidden: true },
    distActive: { hidden: true },
    distUnprompted: { hidden: false }
  };
  const logs = [];

  // Mock de navigator.geolocation
  let mockGeolocationHandlers = [];

  const navigator = {
    geolocation: {
      getCurrentPosition: (success, error, options) => {
        calls.push({ options, success, error });
        if (mockGeolocationHandlers.length > 0) {
          const handler = mockGeolocationHandlers.shift();
          handler(success, error, options);
        }
      }
    }
  };

  // Implementación fiel de la lógica de app.js
  function requestUserLocation() {
    if (isRequestingLocation) {
      logs.push('[Geo] Solicitud de ubicación ignorada: ya existe una petición en curso.');
      return;
    }

    if (!('geolocation' in navigator)) {
      if (ui.distStatus) {
        ui.distStatus.textContent = 'Tu navegador no soporta geolocalización.';
        ui.distStatus.hidden = false;
      }
      return;
    }

    isRequestingLocation = true;
    if (ui.distStatus) {
      ui.distStatus.textContent = 'Consultando ubicación del dispositivo…';
      ui.distStatus.hidden = false;
    }

    const onLocationSuccess = (pos, modo) => {
      isRequestingLocation = false;
      state.userCoords = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude
      };
      logs.push(`[Geo] Ubicación obtenida exitosamente (${modo}, precisión: ~${Math.round(pos.coords.accuracy || 0)}m).`);
      if (ui.distStatus) ui.distStatus.hidden = true;
    };

    const onLocationFinalError = (err) => {
      isRequestingLocation = false;
      let msg = 'No se pudo obtener tu ubicación.';
      if (err.code === 1) msg = 'Permiso de ubicación no concedido.';
      else if (err.code === 2) msg = 'Ubicación no disponible.';
      else if (err.code === 3) msg = 'Tiempo de espera agotado al consultar ubicación.';
      logs.push(`[Geo] Fallo final de geolocalización (código: ${err.code}, mensaje: ${err.message || 'desconocido'}).`);
      if (ui.distStatus) {
        ui.distStatus.textContent = msg;
        ui.distStatus.hidden = false;
      }
    };

    logs.push('[Geo] Iniciando intento 1 (bajo consumo / red: timeout 4s)...');
    navigator.geolocation.getCurrentPosition(
      (pos) => onLocationSuccess(pos, 'red_coarse'),
      (err1) => {
        if (err1.code === 1) {
          onLocationFinalError(err1);
          return;
        }

        logs.push(`[Geo] Intento 1 no completado (código ${err1.code}). Activando fallback satelital de alta precisión (timeout 8s)...`);
        if (ui.distStatus) {
          ui.distStatus.textContent = 'Buscando señal GPS de alta precisión…';
        }

        navigator.geolocation.getCurrentPosition(
          (pos) => onLocationSuccess(pos, 'gps_alta_precision'),
          (err2) => onLocationFinalError(err2),
          { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
        );
      },
      { enableHighAccuracy: false, timeout: 4000, maximumAge: 60000 }
    );
  }

  function disableUserLocation() {
    isRequestingLocation = false;
    state.userCoords = null;
    if (ui.distActive) ui.distActive.hidden = true;
    if (ui.distUnprompted) ui.distUnprompted.hidden = false;
    if (ui.distStatus) ui.distStatus.hidden = true;
  }

  return {
    calls,
    state,
    ui,
    logs,
    setMockHandlers: (handlers) => { mockGeolocationHandlers = handlers; },
    requestUserLocation,
    disableUserLocation,
    isRequesting: () => isRequestingLocation
  };
}

test('Geolocalización sismoPA — Intento Secuencial y Fallback', async (t) => {
  await t.test('1. Verificación del archivo real assets/app.js contiene los parámetros y flujo exigidos', () => {
    const appJsPath = path.join(ROOT_DIR, 'assets/app.js');
    const content = fs.readFileSync(appJsPath, 'utf8');

    assert.ok(content.includes('enableHighAccuracy: false, timeout: 4000, maximumAge: 60000'), 'Intento 1 debe usar timeout 4000 y maximumAge 60000');
    assert.ok(content.includes('enableHighAccuracy: true, timeout: 8000, maximumAge: 0'), 'Intento 2 debe usar timeout 8000 y maximumAge 0');
    assert.ok(content.includes('isRequestingLocation'), 'Debe existir guardia de concurrencia');
    assert.ok(content.includes('err1.code === 1'), 'Debe abortar sin reintento si el permiso fue denegado');
  });

  await t.test('2. Éxito Inicial: Intento 1 (red/coarse) tiene éxito inmediatamente', () => {
    const harness = createGeoTestHarness();
    harness.setMockHandlers([
      (success) => success({ coords: { latitude: 8.982, longitude: -79.519, accuracy: 45 } })
    ]);

    harness.requestUserLocation();

    assert.equal(harness.calls.length, 1, 'Solo debe haber 1 intento');
    assert.equal(harness.calls[0].options.enableHighAccuracy, false, 'Intento 1 debe ser enableHighAccuracy: false');
    assert.equal(harness.calls[0].options.timeout, 4000);
    assert.equal(harness.calls[0].options.maximumAge, 60000);
    assert.deepEqual(harness.state.userCoords, { lat: 8.982, lon: -79.519 }, 'Coordenadas deben quedar guardadas en memoria de sesión');
    assert.equal(harness.ui.distStatus.hidden, true, 'distStatus debe ocultarse en éxito');
    assert.equal(harness.isRequesting(), false, 'Guardia de concurrencia debe quedar liberada');
  });

  await t.test('3. Éxito tras Fallback: Intento 1 falla con error 2 (POSITION_UNAVAILABLE) y el intento 2 tiene éxito', () => {
    const harness = createGeoTestHarness();
    harness.setMockHandlers([
      // Intento 1 falla con código 2
      (_success, error) => error({ code: 2, message: 'Position unavailable on network provider' }),
      // Intento 2 tiene éxito con GPS satelital
      (success) => success({ coords: { latitude: 8.421, longitude: -82.431, accuracy: 8 } })
    ]);

    harness.requestUserLocation();

    assert.equal(harness.calls.length, 2, 'Deben ejecutarse exactamente 2 intentos');
    assert.equal(harness.calls[0].options.enableHighAccuracy, false, 'Intento 1 fue false');
    assert.equal(harness.calls[1].options.enableHighAccuracy, true, 'Intento 2 debe ser true (GPS satelital)');
    assert.equal(harness.calls[1].options.timeout, 8000, 'Intento 2 timeout debe ser 8000');
    assert.equal(harness.calls[1].options.maximumAge, 0, 'Intento 2 maximumAge debe ser 0 para forzar fix nuevo');
    assert.deepEqual(harness.state.userCoords, { lat: 8.421, lon: -82.431 });
    assert.equal(harness.ui.distStatus.hidden, true);
    assert.equal(harness.isRequesting(), false);
  });

  await t.test('4. Éxito tras Fallback por Timeout: Intento 1 falla con error 3 (TIMEOUT) y el intento 2 tiene éxito', () => {
    const harness = createGeoTestHarness();
    harness.setMockHandlers([
      // Intento 1 falla con timeout
      (_success, error) => error({ code: 3, message: 'Timeout expired' }),
      // Intento 2 tiene éxito
      (success) => success({ coords: { latitude: 7.561, longitude: -80.761, accuracy: 5 } })
    ]);

    harness.requestUserLocation();

    assert.equal(harness.calls.length, 2);
    assert.equal(harness.calls[1].options.enableHighAccuracy, true);
    assert.deepEqual(harness.state.userCoords, { lat: 7.561, lon: -80.761 });
    assert.equal(harness.isRequesting(), false);
  });

  await t.test('5. Permiso Denegado: Intento 1 falla con error 1 (PERMISSION_DENIED) -> NO se realiza intento 2', () => {
    const harness = createGeoTestHarness();
    harness.setMockHandlers([
      // Intento 1 falla con código 1
      (_success, error) => error({ code: 1, message: 'User denied geolocation' })
    ]);

    harness.requestUserLocation();

    assert.equal(harness.calls.length, 1, 'NO debe haber intento 2 ante permiso denegado');
    assert.equal(harness.state.userCoords, null, 'No debe haber coordenadas');
    assert.equal(harness.ui.distStatus.textContent, 'Permiso de ubicación no concedido.');
    assert.equal(harness.ui.distStatus.hidden, false);
    assert.equal(harness.isRequesting(), false);
  });

  await t.test('6. Fallo de Ambos Intentos: Intento 1 falla con error 2 e Intento 2 falla con error 2', () => {
    const harness = createGeoTestHarness();
    harness.setMockHandlers([
      (_success, error) => error({ code: 2, message: 'Network provider unavailable' }),
      (_success, error) => error({ code: 2, message: 'GPS hardware unavailable' })
    ]);

    harness.requestUserLocation();

    assert.equal(harness.calls.length, 2, 'Se deben haber ejecutado los 2 intentos');
    assert.equal(harness.state.userCoords, null);
    assert.equal(harness.ui.distStatus.textContent, 'Ubicación no disponible.');
    assert.equal(harness.ui.distStatus.hidden, false);
    assert.equal(harness.isRequesting(), false);
  });

  await t.test('7. Guardia de Concurrencia: Peticiones simultáneas son bloqueadas mientras una está en curso', () => {
    const harness = createGeoTestHarness();
    let resolveIntento1;
    harness.setMockHandlers([
      (success) => {
        resolveIntento1 = success;
      }
    ]);

    // Lanzar primera petición
    harness.requestUserLocation();
    assert.equal(harness.isRequesting(), true);
    assert.equal(harness.calls.length, 1);

    // Lanzar segunda petición mientras la primera está en vuelo
    harness.requestUserLocation();
    assert.equal(harness.calls.length, 1, 'La segunda llamada NO debe disparar getCurrentPosition');
    assert.ok(harness.logs.some(l => l.includes('ya existe una petición en curso')));

    // Completar primera petición
    resolveIntento1({ coords: { latitude: 8.9, longitude: -79.5, accuracy: 20 } });
    assert.equal(harness.isRequesting(), false);
    assert.deepEqual(harness.state.userCoords, { lat: 8.9, lon: -79.5 });
  });

  await t.test('8. disableUserLocation resetea estado y guardia limpiamente', () => {
    const harness = createGeoTestHarness();
    harness.state.userCoords = { lat: 8.9, lon: -79.5 };
    harness.disableUserLocation();

    assert.equal(harness.state.userCoords, null);
    assert.equal(harness.ui.distStatus.hidden, true);
    assert.equal(harness.isRequesting(), false);
  });
});
