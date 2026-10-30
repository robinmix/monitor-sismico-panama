'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('Suite Integral de Distancia y Formato de Notificaciones Sísmicas', async (t) => {
  const {
    haversineKm,
    truncateCoordinates,
    getDistanceSuffix,
    formatDistanceString,
    formatSeismicNotification
  } = await import('../cloudflare/lib/distance-formatter.mjs');

  await t.test('Haversine: cálculo preciso entre coordenadas conocidas en Panamá', () => {
    // Panamá Centro (8.983, -79.520) a David, Chiriquí (8.427, -82.431) ~ 326 km
    const dist = haversineKm(8.983, -79.520, 8.427, -82.431);
    assert.ok(dist !== null, 'Distancia no debe ser null');
    assert.strictEqual(Math.round(dist), 326);

    // Distancia a sí mismo debe ser 0
    const zeroDist = haversineKm(8.983, -79.520, 8.983, -79.520);
    assert.strictEqual(Math.round(zeroDist), 0);
  });

  await t.test('Haversine: manejo fail-safe de valores nulos, infinitos o fuera de rango', () => {
    assert.strictEqual(haversineKm(null, -79.5, 8.5, -82.4), null);
    assert.strictEqual(haversineKm(undefined, -79.5, 8.5, -82.4), null);
    assert.strictEqual(haversineKm(NaN, -79.5, 8.5, -82.4), null);
    assert.strictEqual(haversineKm(95, -79.5, 8.5, -82.4), null, 'Latitud > 90 debe ser null');
    assert.strictEqual(haversineKm(8.5, -185, 8.5, -82.4), null, 'Longitud > 180 debe ser null');
  });

  await t.test('Truncamiento de coordenadas para privacidad (máx 3 decimales ~110m)', () => {
    const truncated = truncateCoordinates(8.9834567, -79.5201234, 3);
    assert.strictEqual(truncated.lat, 8.983);
    assert.strictEqual(truncated.lon, -79.520);

    const invalid = truncateCoordinates(null, undefined);
    assert.strictEqual(invalid.lat, null);
    assert.strictEqual(invalid.lon, null);
  });

  await t.test('getDistanceSuffix: frescura ≤ 48h GPS retorna "de ti"', () => {
    const now = Date.now();
    const freshGps = {
      modo: 'GPS',
      ubicacion_actualizada_en: new Date(now - 2 * 60 * 60 * 1000).toISOString() // 2 horas de antigüedad
    };
    assert.strictEqual(getDistanceSuffix(freshGps, now), 'de ti');
  });

  await t.test('getDistanceSuffix: frescura > 48h GPS degrada a "de tu zona"', () => {
    const now = Date.now();
    const olderGps = {
      modo: 'GPS',
      ubicacion_actualizada_en: new Date(now - 72 * 60 * 60 * 1000).toISOString() // 3 días de antigüedad
    };
    assert.strictEqual(getDistanceSuffix(olderGps, now), 'de tu zona');
  });

  await t.test('getDistanceSuffix: modo ZONA siempre retorna "de tu zona"', () => {
    const now = Date.now();
    const zona = {
      modo: 'ZONA',
      ubicacion_zona: 'Chiriquí',
      ubicacion_actualizada_en: new Date(now - 10 * 60 * 1000).toISOString()
    };
    assert.strictEqual(getDistanceSuffix(zona, now), 'de tu zona');
  });

  await t.test('getDistanceSuffix: ubicación caducada (> 30 días) retorna null', () => {
    const now = Date.now();
    const expired = {
      modo: 'GPS',
      ubicacion_actualizada_en: new Date(now - 35 * 24 * 60 * 60 * 1000).toISOString() // 35 días
    };
    assert.strictEqual(getDistanceSuffix(expired, now), null);
  });

  await t.test('formatDistanceString: redondeo a entero y distancia < 1 km', () => {
    assert.strictEqual(formatDistanceString(42.3, 'de ti'), 'A 42 km de ti');
    assert.strictEqual(formatDistanceString(41.8, 'de tu zona'), 'A 42 km de tu zona');
    assert.strictEqual(formatDistanceString(0.3, 'de ti'), 'A menos de 1 km de ti');
    assert.strictEqual(formatDistanceString(null, 'de ti'), null);
  });

  await t.test('formatSeismicNotification: Caso A — Con ubicación GPS reciente (≤ 48h)', () => {
    const now = Date.now();
    const sismo = {
      source_uid: 'igc_test_001',
      magnitud: 3.5,
      latitud: 7.58,
      longitud: -80.77,
      ubicacion_texto: '60 km al sureste de Soná',
      profundidad_km: 12
    };
    const userLocation = {
      latitud: 7.95,
      longitud: -80.77, // Aprox ~41 km al norte
      modo: 'GPS',
      ubicacion_actualizada_en: new Date(now - 1000 * 60 * 30).toISOString(), // 30 min
      personalizacion_distancia_activa: true
    };

    const res = formatSeismicNotification({ sismo, userLocation, now });

    assert.strictEqual(res.is_personalized, true);
    assert.strictEqual(res.title, 'sismoPA · Nuevo sismo');
    assert.strictEqual(res.body, 'M3.5 · A 41 km de ti · 60 km al sureste de Soná · 12 km prof.');
    assert.strictEqual(res.suffix, 'de ti');
  });

  await t.test('formatSeismicNotification: Caso B — Con zona fija o GPS > 48h', () => {
    const now = Date.now();
    const sismo = {
      source_uid: 'igc_test_002',
      magnitud: 4.2,
      latitud: 7.58,
      longitud: -80.77,
      ubicacion_texto: 'Golfo de Montijo',
      profundidad_km: 10
    };
    const userLocation = {
      latitud: 8.0,
      longitud: -80.77,
      modo: 'ZONA',
      ubicacion_zona: 'Veraguas',
      ubicacion_actualizada_en: new Date(now - 1000 * 60 * 60).toISOString(),
      personalizacion_distancia_activa: true
    };

    const res = formatSeismicNotification({ sismo, userLocation, now });

    assert.strictEqual(res.is_personalized, true);
    assert.strictEqual(res.title, 'sismoPA · Nuevo sismo');
    assert.strictEqual(res.body, 'M4.2 · A 47 km de tu zona · Golfo de Montijo · 10 km prof.');
    assert.strictEqual(res.suffix, 'de tu zona');
  });

  await t.test('formatSeismicNotification: Caso C — Sin ubicación / caducada / desactivada (Fallback)', () => {
    const sismo = {
      source_uid: 'igc_test_003',
      magnitud: 3.5,
      latitud: 7.58,
      longitud: -80.77,
      ubicacion_texto: '60 km al sureste de Soná',
      profundidad_km: 12
    };

    // Sin userLocation
    const res1 = formatSeismicNotification({ sismo, userLocation: null });
    assert.strictEqual(res1.is_personalized, false);
    assert.strictEqual(res1.title, 'sismoPA · Nuevo sismo');
    assert.strictEqual(res1.body, 'M3.5 · 60 km al sureste de Soná · 12 km prof.');

    // Con personalizacion_distancia_activa = false
    const res2 = formatSeismicNotification({
      sismo,
      userLocation: {
        latitud: 8.98,
        longitud: -79.52,
        personalizacion_distancia_activa: false
      }
    });
    assert.strictEqual(res2.is_personalized, false);
    assert.strictEqual(res2.title, 'sismoPA · Nuevo sismo');
    assert.strictEqual(res2.body, 'M3.5 · 60 km al sureste de Soná · 12 km prof.');
  });

  await t.test('formatSeismicNotification: Orden estricto de elementos [Magnitud] · [Distancia] · [Lugar]', () => {
    const now = Date.now();
    const sismo = {
      magnitud: 5.0,
      latitud: 8.4,
      longitud: -82.4,
      ubicacion_texto: '15 km al sur de David'
    };
    const userLocation = {
      latitud: 8.42,
      longitud: -82.43,
      modo: 'GPS',
      ubicacion_actualizada_en: new Date(now).toISOString(),
      personalizacion_distancia_activa: true
    };

    const res = formatSeismicNotification({ sismo, userLocation, now, options: { includeDepth: false } });

    assert.strictEqual(res.title, 'sismoPA · Nuevo sismo');
    assert.strictEqual(res.body, 'M5.0 · A 4 km de ti · 15 km al sur de David');
    assert.ok(res.body.startsWith('M5.0 · A 4 km de ti · 15 km al sur de David'));
  });
});
