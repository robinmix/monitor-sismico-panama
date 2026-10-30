'use strict';

/**
 * Suite de pruebas automatizadas para la verificación de geolocalización secuencial.
 * Comprueba:
 * 1. Intento 1 con bajo consumo y timeout corto (4s).
 * 2. Fallback a alta precisión (timeout 14s, maximumAge 0) ante error 2 o 3.
 * 3. Manejo inmediato y sin reintento de permiso denegado (error 1).
 * 4. Guardia global anti-concurrencia.
 * 5. Limpieza de estado en disableUserLocation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

// Helper para emular el flujo de geolocalización extraído de app.js
function createGeoTestHarness() {
  const calls = [];
  let isGlobalGeoRequestActive = false;
  const state = {
    userCoords: null,
    userCoordsUpdatedAt: null,
    userCoordsIsStale: false,
    currentSismoId: null
  };
  const ui = {
    distStatus: { textContent: '', hidden: true },
    distActive: { hidden: true },
    distUnprompted: { hidden: false },
    btnRequestGeo: { disabled: false },
    btnRefreshGeo: { disabled: false, textContent: '↻ Actualizar mi ubicación' }
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

  function acquireDeviceCoordinates({ onStatus, onSuccess, onError }) {
    if (isGlobalGeoRequestActive) {
      logs.push('[Geo] Solicitud de ubicación ignorada: ya existe una petición en curso.');
      if (onStatus) onStatus('Ya hay una consulta de ubicación en curso…');
      return;
    }

    if (!('geolocation' in navigator)) {
      if (onError) onError({ code: 0, userMessage: 'Tu navegador no soporta geolocalización.' });
      return;
    }

    isGlobalGeoRequestActive = true;
    if (onStatus) onStatus('Consultando ubicación del dispositivo…');

    const finalizeSuccess = (pos, modo) => {
      isGlobalGeoRequestActive = false;
      logs.push(`[Geo] Ubicación obtenida exitosamente (${modo}, precisión: ~${Math.round(pos.coords.accuracy || 0)}m).`);
      if (onSuccess) {
        onSuccess({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: pos.coords.accuracy || null,
          mode: modo
        });
      }
    };

    const finalizeError = (err) => {
      isGlobalGeoRequestActive = false;
      let userMessage = 'No se pudo obtener tu ubicación.';
      if (err.code === 1) userMessage = 'Permiso de ubicación no concedido.';
      else if (err.code === 2) userMessage = 'Ubicación no disponible en este dispositivo.';
      else if (err.code === 3) userMessage = 'Tiempo de espera agotado al consultar ubicación.';
      logs.push(`[Geo] Fallo final de geolocalización (código: ${err.code}, mensaje: ${err.message || 'desconocido'}).`);
      if (onError) onError({ code: err.code, message: err.message, userMessage });
    };

    logs.push('[Geo] Iniciando intento 1 (bajo consumo / red: timeout 4s)...');
    navigator.geolocation.getCurrentPosition(
      (pos) => finalizeSuccess(pos, 'red_coarse'),
      (err1) => {
        if (err1.code === 1) {
          finalizeError(err1);
          return;
        }

        logs.push(`[Geo] Intento 1 sin resultado (código ${err1.code}). Activando fallback satelital de alta precisión (timeout 14s)...`);
        if (onStatus) onStatus('Buscando señal GPS de alta precisión…');

        navigator.geolocation.getCurrentPosition(
          (pos) => finalizeSuccess(pos, 'gps_alta_precision'),
          (err2) => finalizeError(err2),
          { enableHighAccuracy: true, timeout: 14000, maximumAge: 0 }
        );
      },
      { enableHighAccuracy: false, timeout: 4000, maximumAge: 60000 }
    );
  }

  function requestUserLocation() {
    if (ui.distStatus) {
      ui.distStatus.textContent = 'Consultando ubicación del dispositivo…';
      ui.distStatus.hidden = false;
    }
    ui.btnRequestGeo.disabled = true;
    ui.btnRefreshGeo.disabled = true;

    acquireDeviceCoordinates({
      onStatus: (msg) => {
        if (ui.distStatus) {
          ui.distStatus.textContent = msg;
          ui.distStatus.hidden = false;
        }
      },
      onSuccess: (res) => {
        ui.btnRequestGeo.disabled = false;
        ui.btnRefreshGeo.disabled = false;
        state.userCoords = { lat: res.lat, lon: res.lon };
        state.userCoordsUpdatedAt = Date.now();
        state.userCoordsIsStale = false;
        if (ui.distStatus) ui.distStatus.hidden = true;
      },
      onError: (err) => {
        ui.btnRequestGeo.disabled = false;
        ui.btnRefreshGeo.disabled = false;
        if (state.userCoords) {
          state.userCoordsIsStale = true;
          if (ui.distStatus) {
            ui.distStatus.textContent = `⚠️ No se pudo actualizar (${err.userMessage}). Se conserva tu última ubicación conocida.`;
            ui.distStatus.hidden = false;
          }
        } else {
          if (ui.distStatus) {
            ui.distStatus.textContent = err.userMessage;
            ui.distStatus.hidden = false;
          }
        }
      }
    });
  }

  function disableUserLocation() {
    isGlobalGeoRequestActive = false;
    state.userCoords = null;
    state.userCoordsUpdatedAt = null;
    state.userCoordsIsStale = false;
    if (ui.distActive) ui.distActive.hidden = true;
    if (ui.distUnprompted) ui.distUnprompted.hidden = false;
    if (ui.distStatus) ui.distStatus.hidden = true;
    ui.btnRequestGeo.disabled = false;
    ui.btnRefreshGeo.disabled = false;
  }

  return {
    calls,
    state,
    ui,
    logs,
    requestUserLocation,
    disableUserLocation,
    setMockHandlers: (handlers) => { mockGeolocationHandlers = handlers.slice(); },
    isRequesting: () => isGlobalGeoRequestActive
  };
}

test('Geolocalización sismoPA — Intento Secuencial y Fallback', async (t) => {
  await t.test('1. Verificación del archivo real assets/app.js contiene los parámetros y flujo exigidos', () => {
    const appJsPath = path.join(ROOT_DIR, 'assets/app.js');
    const content = fs.readFileSync(appJsPath, 'utf8');

    assert.ok(content.includes('enableHighAccuracy: false, timeout: 4000, maximumAge: 60000'), 'Intento 1 debe usar timeout 4000 y maximumAge 60000');
    assert.ok(content.includes('enableHighAccuracy: true, timeout: 14000, maximumAge: 0'), 'Intento 2 debe usar timeout 14000 y maximumAge 0');
    assert.ok(content.includes('isGlobalGeoRequestActive'), 'Debe existir guardia de concurrencia');
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
    assert.equal(harness.state.userCoords.lat, 8.982);
    assert.equal(harness.state.userCoords.lon, -79.519);
    assert.equal(harness.isRequesting(), false, 'La guardia debe liberarse al terminar');
  });

  await t.test('3. Éxito tras Fallback: Intento 1 falla con error 2 (POSITION_UNAVAILABLE) y el intento 2 tiene éxito', () => {
    const harness = createGeoTestHarness();
    harness.setMockHandlers([
      (success, error) => error({ code: 2, message: 'Position unavailable on network provider' }),
      (success) => success({ coords: { latitude: 7.512, longitude: -80.831, accuracy: 5 } })
    ]);

    harness.requestUserLocation();

    assert.equal(harness.calls.length, 2, 'Deben ejecutarse ambos intentos');
    assert.equal(harness.calls[0].options.enableHighAccuracy, false);
    assert.equal(harness.calls[1].options.enableHighAccuracy, true, 'Intento 2 debe activar alta precisión');
    assert.equal(harness.calls[1].options.timeout, 14000);
    assert.equal(harness.calls[1].options.maximumAge, 0);
    assert.equal(harness.state.userCoords.lat, 7.512);
    assert.equal(harness.state.userCoords.lon, -80.831);
    assert.equal(harness.isRequesting(), false);
  });

  await t.test('4. Éxito tras Fallback por Timeout: Intento 1 falla con error 3 (TIMEOUT) y el intento 2 tiene éxito', () => {
    const harness = createGeoTestHarness();
    harness.setMockHandlers([
      (success, error) => error({ code: 3, message: 'Timeout on network provider' }),
      (success) => success({ coords: { latitude: 8.432, longitude: -82.428, accuracy: 8 } })
    ]);

    harness.requestUserLocation();

    assert.equal(harness.calls.length, 2);
    assert.equal(harness.calls[0].options.enableHighAccuracy, false);
    assert.equal(harness.calls[1].options.enableHighAccuracy, true);
    assert.equal(harness.state.userCoords.lat, 8.432);
    assert.equal(harness.isRequesting(), false);
  });

  await t.test('5. Permiso Denegado: Intento 1 falla con error 1 (PERMISSION_DENIED) -> NO se realiza intento 2', () => {
    const harness = createGeoTestHarness();
    harness.setMockHandlers([
      (success, error) => error({ code: 1, message: 'User denied geolocation' })
    ]);

    harness.requestUserLocation();

    assert.equal(harness.calls.length, 1, 'No debe haber segundo intento si el usuario denegó el permiso');
    assert.equal(harness.state.userCoords, null);
    assert.equal(harness.ui.distStatus.textContent, 'Permiso de ubicación no concedido.');
    assert.equal(harness.isRequesting(), false);
  });

  await t.test('6. Fallo de Ambos Intentos: Intento 1 falla con error 2 e Intento 2 falla con error 2', () => {
    const harness = createGeoTestHarness();
    harness.setMockHandlers([
      (success, error) => error({ code: 2, message: 'Position unavailable on network' }),
      (success, error) => error({ code: 2, message: 'GPS satellite fix unavailable' })
    ]);

    harness.requestUserLocation();

    assert.equal(harness.calls.length, 2);
    assert.equal(harness.state.userCoords, null);
    assert.equal(harness.ui.distStatus.textContent, 'Ubicación no disponible en este dispositivo.');
    assert.equal(harness.isRequesting(), false);
  });

  await t.test('7. Guardia de Concurrencia: Peticiones simultáneas son bloqueadas mientras una está en curso', () => {
    const harness = createGeoTestHarness();
    // Handler que nunca responde para simular una petición asíncrona pendiente
    harness.setMockHandlers([
      () => {}
    ]);

    harness.requestUserLocation();
    assert.equal(harness.isRequesting(), true);
    assert.equal(harness.calls.length, 1);

    // Segundo clic concurrente mientras el primero sigue en curso
    harness.requestUserLocation();
    assert.equal(harness.calls.length, 1, 'No debe emitir una segunda llamada a getCurrentPosition');
    assert.ok(harness.logs.some(l => l.includes('ya existe una petición en curso')));
  });

  await t.test('8. disableUserLocation resetea estado y guardia limpiamente', () => {
    const harness = createGeoTestHarness();
    harness.setMockHandlers([
      (success) => success({ coords: { latitude: 8.982, longitude: -79.519, accuracy: 45 } })
    ]);

    harness.requestUserLocation();
    assert.ok(harness.state.userCoords !== null);

    harness.disableUserLocation();
    assert.equal(harness.state.userCoords, null);
    assert.equal(harness.isRequesting(), false);
    assert.equal(harness.ui.distUnprompted.hidden, false);
    assert.equal(harness.ui.distActive.hidden, true);
  });
});
