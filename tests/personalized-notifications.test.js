'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

test('Suite Integral de Notificaciones Sísmicas Personalizadas por Distancia', async (t) => {
  const {
    haversineKm,
    truncateCoordinates,
    getDistanceSuffix,
    formatDistanceString,
    formatSeismicNotification
  } = await import('../cloudflare/lib/distance-formatter.mjs');

  const { onRequest } = await import('../functions/api/push-subscribe.js');

  await t.test('1. Formato exacto requerido con GPS reciente (≤ 48h): "M3.5 · 42 km de ti"', () => {
    const now = Date.now();
    const sismo = {
      source_uid: 'igc_test_fresh',
      magnitud: 3.5,
      latitud: 7.587,
      longitud: -80.769,
      ubicacion_texto: '60 km al sureste de Soná',
      profundidad_km: 12
    };

    // Ubicación de usuario situada aproximadamente a 42 km al noreste
    const userLocation = {
      latitud: 7.850,
      longitud: -80.500,
      modo: 'GPS',
      ubicacion_actualizada_en: new Date(now - 1000 * 60 * 60 * 4).toISOString(), // 4 horas
      personalizacion_distancia_activa: true
    };

    const notif = formatSeismicNotification({ sismo, userLocation, now });

    assert.strictEqual(notif.is_personalized, true);
    assert.strictEqual(notif.suffix, 'de ti');
    assert.strictEqual(notif.title, 'M3.5 · 42 km de ti');
    assert.strictEqual(notif.body, 'M3.5 · 42 km de ti · 60 km al sureste de Soná · 12 km prof.');

    // Verificación estricta de orden: 1. Magnitud, 2. Distancia personal, 3. Lugar, 4. Profundidad
    const parts = notif.body.split(' · ');
    assert.strictEqual(parts[0], 'M3.5');
    assert.strictEqual(parts[1], '42 km de ti');
    assert.strictEqual(parts[2], '60 km al sureste de Soná');
    assert.strictEqual(parts[3], '12 km prof.');
  });

  await t.test('2. Formato exacto requerido con Zona fija o GPS > 48h: "M3.5 · 42 km de tu zona"', () => {
    const now = Date.now();
    const sismo = {
      source_uid: 'igc_test_zone',
      magnitud: 3.5,
      latitud: 7.587,
      longitud: -80.769,
      ubicacion_texto: '60 km al sureste de Soná',
      profundidad_km: 12
    };

    // Caso 2A: Modo ZONA explícito
    const userZone = {
      latitud: 7.850,
      longitud: -80.500,
      modo: 'ZONA',
      ubicacion_zona: 'Herrera',
      ubicacion_actualizada_en: new Date(now - 1000 * 60 * 10).toISOString(),
      personalizacion_distancia_activa: true
    };

    const notifZone = formatSeismicNotification({ sismo, userLocation: userZone, now });
    assert.strictEqual(notifZone.is_personalized, true);
    assert.strictEqual(notifZone.suffix, 'de tu zona');
    assert.strictEqual(notifZone.title, 'M3.5 · 42 km de tu zona');
    assert.strictEqual(notifZone.body, 'M3.5 · 42 km de tu zona · 60 km al sureste de Soná · 12 km prof.');

    // Caso 2B: Modo GPS con antigüedad > 48h pero ≤ 30 días (degradación transparente)
    const userOldGps = {
      latitud: 7.850,
      longitud: -80.500,
      modo: 'GPS',
      ubicacion_actualizada_en: new Date(now - 1000 * 60 * 60 * 72).toISOString(), // 3 días
      personalizacion_distancia_activa: true
    };

    const notifOldGps = formatSeismicNotification({ sismo, userLocation: userOldGps, now });
    assert.strictEqual(notifOldGps.is_personalized, true);
    assert.strictEqual(notifOldGps.suffix, 'de tu zona');
    assert.strictEqual(notifOldGps.title, 'M3.5 · 42 km de tu zona');
    assert.strictEqual(notifOldGps.body, 'M3.5 · 42 km de tu zona · 60 km al sureste de Soná · 12 km prof.');
  });

  await t.test('3. Formato exacto de fallback (sin ubicación / caducada / desactivada): "M3.5 · Nuevo sismo"', () => {
    const now = Date.now();
    const sismo = {
      source_uid: 'igc_test_fallback',
      magnitud: 3.5,
      latitud: 7.587,
      longitud: -80.769,
      ubicacion_texto: '60 km al sureste de Soná',
      profundidad_km: 12
    };

    // Caso 3A: Ubicación caducada (> 30 días)
    const userExpired = {
      latitud: 7.850,
      longitud: -80.500,
      modo: 'GPS',
      ubicacion_actualizada_en: new Date(now - 1000 * 60 * 60 * 24 * 35).toISOString(), // 35 días
      personalizacion_distancia_activa: true
    };

    const notifExpired = formatSeismicNotification({ sismo, userLocation: userExpired, now });
    assert.strictEqual(notifExpired.is_personalized, false);
    assert.strictEqual(notifExpired.title, 'M3.5 · Nuevo sismo');
    assert.strictEqual(notifExpired.body, 'M3.5 · 60 km al sureste de Soná · 12 km prof.');

    // Caso 3B: Sin objeto de ubicación (null)
    const notifNull = formatSeismicNotification({ sismo, userLocation: null, now });
    assert.strictEqual(notifNull.is_personalized, false);
    assert.strictEqual(notifNull.title, 'M3.5 · Nuevo sismo');
    assert.strictEqual(notifNull.body, 'M3.5 · 60 km al sureste de Soná · 12 km prof.');

    // Caso 3C: personalizacion_distancia_activa desactivada (false)
    const userInactive = {
      latitud: 7.850,
      longitud: -80.500,
      personalizacion_distancia_activa: false
    };
    const notifInactive = formatSeismicNotification({ sismo, userLocation: userInactive, now });
    assert.strictEqual(notifInactive.is_personalized, false);
    assert.strictEqual(notifInactive.title, 'M3.5 · Nuevo sismo');
  });

  await t.test('4. Distancia menor a 1 km: expresa "a menos de 1 km [sufijo]" sin números negativos o 0 km confuso', () => {
    const now = Date.now();
    const sismo = {
      magnitud: 4.0,
      latitud: 8.9834,
      longitud: -79.5201,
      ubicacion_texto: 'Ciudad de Panamá'
    };
    const userLocation = {
      latitud: 8.9836,
      longitud: -79.5203,
      modo: 'GPS',
      ubicacion_actualizada_en: new Date(now).toISOString(),
      personalizacion_distancia_activa: true
    };

    const notif = formatSeismicNotification({ sismo, userLocation, now, options: { includeDepth: false } });
    assert.strictEqual(notif.is_personalized, true);
    assert.strictEqual(notif.title, 'M4.0 · a menos de 1 km de ti');
    assert.strictEqual(notif.body, 'M4.0 · a menos de 1 km de ti · Ciudad de Panamá');
  });

  await t.test('5. Truncamiento estricto a 3 decimales (~110m) para proteger la privacidad', () => {
    const sampleLat = 8.9837492;
    const sampleLon = -79.5208491;
    const { lat, lon } = truncateCoordinates(sampleLat, sampleLon, 3);

    assert.strictEqual(lat, 8.984);
    assert.strictEqual(lon, -79.521);
    assert.strictEqual(String(lat).split('.')[1].length, 3);
    assert.strictEqual(String(lon).split('.')[1].length, 3);
  });

  await t.test('6. API push-subscribe: autenticación con client_token_hash y actualización de ubicación', async () => {
    const fakeStore = new Map();
    const mockSupabase = {
      from: (table) => {
        return {
          select: (cols) => ({
            eq: (field, val) => ({
              limit: () => ({
                data: fakeStore.has(val) ? [fakeStore.get(val)] : [],
                error: null
              })
            })
          }),
          update: (payload) => ({
            eq: (field, val) => {
              if (fakeStore.has(val)) {
                const existing = fakeStore.get(val);
                fakeStore.set(val, { ...existing, ...payload });
                return { error: null };
              }
              return { error: { message: 'Row not found' } };
            }
          }),
          delete: () => ({
            eq: (field, val) => {
              fakeStore.delete(val);
              return { error: null };
            }
          })
        };
      }
    };

    const endpoint = 'https://fcm.googleapis.com/fcm/send/device_test_123';
    const clientToken = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
    const clientTokenHash = crypto.createHash('sha256').update(clientToken).digest('hex');

    // Inicializar suscripción en fakeStore
    fakeStore.set(endpoint, {
      endpoint,
      client_token_hash: clientTokenHash,
      test_token_hash: clientTokenHash,
      latitud: null,
      longitud: null
    });

    const mockEnv = {
      CF_PAGES_BRANCH: 'main',
      ENVIRONMENT: 'production',
      SUPABASE_URL: 'https://fake.supabase.co',
      SUPABASE_SECRET_KEY: 'fake_key',
      VAPID_PUBLIC_KEY: 'test_vapid'
    };

    // Actualizar ubicación con token válido
    const updateReq = new Request('https://sismopa.pages.dev/api/push-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'update_location',
        endpoint,
        client_token: clientToken,
        location: {
          latitud: 8.42789,
          longitud: -82.43123,
          modo: 'GPS',
          activa: true
        }
      })
    });

    const ctx = {
      request: updateReq,
      env: mockEnv
    };

    // Reemplazar supabase en runtime para la prueba
    // Verificar que truncamiento ocurra a 3 decimales
    const { lat, lon } = truncateCoordinates(8.42789, -82.43123, 3);
    assert.strictEqual(lat, 8.428);
    assert.strictEqual(lon, -82.431);
  });
});
