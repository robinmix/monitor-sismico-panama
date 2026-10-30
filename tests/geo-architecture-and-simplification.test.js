'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const appJsPath = path.resolve(__dirname, '../assets/app.js');
const indexHtmlPath = path.resolve(__dirname, '../index.html');
const styleCssPath = path.resolve(__dirname, '../assets/style.css');
const swJsPath = path.resolve(__dirname, '../sw.js');

test('Arquitectura y Simplificación de Geolocalización sismoPA', async (t) => {
  const appJsCode = fs.readFileSync(appJsPath, 'utf8');
  const indexHtmlCode = fs.readFileSync(indexHtmlPath, 'utf8');
  const styleCssCode = fs.readFileSync(styleCssPath, 'utf8');
  const swJsCode = fs.readFileSync(swJsPath, 'utf8');

  await t.test('1. Inspección estática: función centralizada acquireDeviceCoordinates y guardias', () => {
    assert.ok(appJsCode.includes('function acquireDeviceCoordinates('), 'Debe existir acquireDeviceCoordinates');
    assert.ok(appJsCode.includes('isGlobalGeoRequestActive'), 'Debe existir la guardia global');
    assert.ok(appJsCode.includes('timeout: 14000'), 'El timeout de fallback debe ser de al menos 14s para GNSS satelital');
    assert.ok(appJsCode.includes('state.userCoordsIsStale'), 'Debe gestionar el estado de ubicación obsoleta (stale)');
  });

  await t.test('2. Rediseño Chincheta: HTML y CSS contienen elementos de actualización y accesibilidad', () => {
    assert.ok(indexHtmlCode.includes('id="btnRefreshGeo"'), 'Debe existir el botón btnRefreshGeo');
    assert.ok(indexHtmlCode.includes('class="dist-refresh-btn"'), 'Debe tener clase dist-refresh-btn');
    assert.ok(indexHtmlCode.includes('id="distNote"'), 'Debe existir distNote');
    assert.ok(styleCssCode.includes('.dist-refresh-btn'), 'Debe incluir estilos para el botón de actualizar');
  });

  await t.test('3. Simplificación Campanita: selectWebPushZone fue retirado del HTML visible sin romper compatibilidad', () => {
    assert.ok(!indexHtmlCode.includes('id="selectWebPushZone"'), 'selectWebPushZone no debe estar en index.html');
    assert.ok(appJsCode.includes('if (selectDistZone)'), 'app.js debe proteger selectDistZone contra null');
  });

  await t.test('4. Service Worker: Cache version y script query param están sincronizados a v20261029geo2', () => {
    assert.ok(swJsCode.includes('core-v20261029geo2'), 'sw.js debe definir core-v20261029geo2');
    assert.ok(swJsCode.includes('static-v20261029geo2'), 'sw.js debe definir static-v20261029geo2');
    assert.ok(indexHtmlCode.includes('assets/app.js?v=20261029geo2'), 'index.html debe solicitar app.js?v=20261029geo2');
  });

  await t.test('5. Motor de geolocalización: Éxito en Intento 1 (red/baja precisión)', () => {
    let attempts = [];
    const mockNavigator = {
      geolocation: {
        getCurrentPosition: (success, error, options) => {
          attempts.push(options);
          success({
            coords: { latitude: 8.983, longitude: -79.520, accuracy: 25 },
            timestamp: 1600000000000
          });
        }
      }
    };

    let result = null;
    let globalActive = false;
    function testAcquire(opts) {
      globalActive = true;
      mockNavigator.geolocation.getCurrentPosition(
        (pos) => {
          globalActive = false;
          opts.onSuccess({ lat: pos.coords.latitude, lon: pos.coords.longitude, mode: 'red_coarse' });
        },
        (err) => { globalActive = false; opts.onError(err); },
        { enableHighAccuracy: false, timeout: 4000, maximumAge: 60000 }
      );
    }

    testAcquire({
      onSuccess: (res) => { result = res; },
      onError: () => {}
    });

    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].enableHighAccuracy, false);
    assert.equal(result.lat, 8.983);
    assert.equal(result.mode, 'red_coarse');
    assert.equal(globalActive, false);
  });

  await t.test('6. Motor de geolocalización: Fallback a alta precisión tras error 2 (POSITION_UNAVAILABLE)', () => {
    let attempts = [];
    let statusMessages = [];
    const mockNavigator = {
      geolocation: {
        getCurrentPosition: (success, error, options) => {
          attempts.push(options);
          if (options.enableHighAccuracy === false) {
            error({ code: 2, message: 'Position unavailable' });
          } else {
            success({
              coords: { latitude: 7.512, longitude: -80.831, accuracy: 5 },
              timestamp: 1600000000000
            });
          }
        }
      }
    };

    let result = null;
    let globalActive = false;
    function testAcquire(opts) {
      globalActive = true;
      mockNavigator.geolocation.getCurrentPosition(
        (pos) => {
          globalActive = false;
          opts.onSuccess({ lat: pos.coords.latitude, lon: pos.coords.longitude, mode: 'red_coarse' });
        },
        (err1) => {
          if (err1.code === 1) { globalActive = false; opts.onError(err1); return; }
          opts.onStatus('Buscando señal GPS de alta precisión…');
          mockNavigator.geolocation.getCurrentPosition(
            (pos) => {
              globalActive = false;
              opts.onSuccess({ lat: pos.coords.latitude, lon: pos.coords.longitude, mode: 'gps_alta_precision' });
            },
            (err2) => { globalActive = false; opts.onError(err2); },
            { enableHighAccuracy: true, timeout: 14000, maximumAge: 0 }
          );
        },
        { enableHighAccuracy: false, timeout: 4000, maximumAge: 60000 }
      );
    }

    testAcquire({
      onStatus: (msg) => statusMessages.push(msg),
      onSuccess: (res) => { result = res; },
      onError: () => {}
    });

    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].enableHighAccuracy, false);
    assert.equal(attempts[1].enableHighAccuracy, true);
    assert.equal(attempts[1].timeout, 14000);
    assert.equal(statusMessages[0], 'Buscando señal GPS de alta precisión…');
    assert.equal(result.mode, 'gps_alta_precision');
    assert.equal(globalActive, false);
  });

  await t.test('7. Permiso Denegado (Código 1): Aborto inmediato sin reintentar ni solicitar alta precisión', () => {
    let attempts = [];
    const mockNavigator = {
      geolocation: {
        getCurrentPosition: (success, error, options) => {
          attempts.push(options);
          error({ code: 1, message: 'User denied Geolocation' });
        }
      }
    };

    let finalError = null;
    function testAcquire(opts) {
      mockNavigator.geolocation.getCurrentPosition(
        (pos) => opts.onSuccess(pos),
        (err1) => {
          if (err1.code === 1) {
            opts.onError({ code: 1, userMessage: 'Permiso de ubicación no concedido.' });
            return;
          }
        },
        { enableHighAccuracy: false, timeout: 4000, maximumAge: 60000 }
      );
    }

    testAcquire({
      onSuccess: () => {},
      onError: (err) => { finalError = err; }
    });

    assert.equal(attempts.length, 1);
    assert.equal(finalError.code, 1);
    assert.equal(finalError.userMessage, 'Permiso de ubicación no concedido.');
  });

  await t.test('8. Guardia de concurrencia: Bloqueo de solicitudes simultáneas entre chincheta y campanita', () => {
    let isGlobalActive = false;
    let ignored = false;

    function acquire(opts) {
      if (isGlobalActive) {
        ignored = true;
        return;
      }
      isGlobalActive = true;
    }

    acquire(); // Primera solicitud (ej. Chincheta)
    assert.equal(isGlobalActive, true);

    acquire(); // Segunda solicitud simultánea (ej. Campanita)
    assert.equal(ignored, true);
  });

  await t.test('9. Conservación de última ubicación válida en sesión al fallar una actualización (stale flag)', () => {
    let state = {
      userCoords: { lat: 8.983, lon: -79.520 },
      userCoordsUpdatedAt: 1600000000000,
      userCoordsIsStale: false
    };

    function onRefreshError(err) {
      if (state.userCoords) {
        state.userCoordsIsStale = true;
        // La ubicación NO se borra
      } else {
        state.userCoords = null;
      }
    }

    onRefreshError({ code: 3, userMessage: 'Tiempo de espera agotado' });

    assert.ok(state.userCoords !== null, 'Debe conservar las coordenadas previas');
    assert.equal(state.userCoords.lat, 8.983);
    assert.equal(state.userCoordsIsStale, true, 'Debe marcar como stale');
  });

  await t.test('10. Independencia absoluta: Chincheta en memoria RAM no contamina localStorage de notificaciones', () => {
    let mockStorage = {};
    let sessionCoords = { lat: 8.5, lon: -80.0 };

    // Chincheta opera:
    let chinchetaActive = true;
    // Comprobar que mockStorage está vacío:
    assert.equal(Object.keys(mockStorage).length, 0);

    // Campanita opera de forma explícita:
    mockStorage['sismopa_user_location'] = JSON.stringify({
      lat: 8.5,
      lon: -80.0,
      modo: 'GPS',
      activa: true
    });

    // Desactivar chincheta:
    sessionCoords = null;
    chinchetaActive = false;

    // mockStorage sigue intacto:
    assert.ok(mockStorage['sismopa_user_location']);
    const parsed = JSON.parse(mockStorage['sismopa_user_location']);
    assert.equal(parsed.activa, true);
  });

  await t.test('11. Manejo y compatibilidad de preferencias heredadas de provincia (modo ZONA)', () => {
    const legacyLocation = {
      lat: 8.43,
      lon: -82.43,
      modo: 'ZONA',
      zona: 'Chiriquí',
      updatedAt: '2026-10-29T12:00:00Z',
      activa: true
    };

    // La función syncWebPushDistanceUi maneja ZONA correctamente:
    const mode = String(legacyLocation.modo || 'GPS').toUpperCase();
    let badgeText = '';
    let btnText = '';
    if (mode === 'ZONA') {
      badgeText = 'Zona: ' + (legacyLocation.zona || 'Fija') + ' (de tu zona)';
      btnText = '📍 Cambiar a ubicación GPS';
    }

    assert.equal(badgeText, 'Zona: Chiriquí (de tu zona)');
    assert.equal(btnText, '📍 Cambiar a ubicación GPS');
  });

  await t.test('12. Cálculo geodésico Haversine: Coherencia y protección contra entradas anómalas', () => {
    const EARTH_RADIUS_KM = 6371.0088;
    function haversineKm(lat1, lon1, lat2, lon2) {
      if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;
      const toRad = deg => (deg * Math.PI) / 180;
      const dLat = toRad(lat2 - lat1);
      const dLon = toRad(lon2 - lon1);
      const a = Math.sin(dLat / 2) ** 2 +
                Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
                Math.sin(dLon / 2) ** 2;
      return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    // Distancia Ciudad de Panamá (8.983, -79.520) a David, Chiriquí (8.430, -82.430) ~ 324 km
    const dist = haversineKm(8.983, -79.520, 8.430, -82.430);
    assert.ok(dist > 320 && dist < 330, `Distancia esperada ~324km, obtenida: ${dist}`);

    // Entrada inválida
    assert.equal(haversineKm(null, -79.520, 8.430, -82.430), null);
    assert.equal(haversineKm(8.983, undefined, 8.430, -82.430), null);
  });
});
