'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');

test('Suite Científica de Comparación Internacional de Magnitudes', async (t) => {
  const {
    haversineKm,
    validateTargetEvent,
    matchEarthquakeCandidate,
    fetchAndMatchUsgs,
    fetchAndMatchEmsc,
    fetchAndMatchGfz,
    getInternationalComparisons
  } = await import('../cloudflare/lib/comparacion-sismos.mjs');

  await t.test('1. Distancia geodésica de Haversine: cálculo preciso entre coordenadas reales de Panamá', () => {
    // Ciudad de Panamá (8.9824, -79.5199) a David, Chiriquí (8.4273, -82.4309) ~ 326 km
    const distDavid = haversineKm(8.9824, -79.5199, 8.4273, -82.4309);
    assert.ok(distDavid > 320 && distDavid < 335, `Distancia calculada: ${distDavid} km`);

    // Coiba a Tonosí (~ 115 km)
    const distCoibaTonosi = haversineKm(7.688, -81.585, 7.400, -80.440);
    assert.ok(distCoibaTonosi > 120 && distCoibaTonosi < 135, `Distancia Coiba-Tonosí: ${distCoibaTonosi} km`);

    // Misma coordenada da 0 km
    const distZero = haversineKm(7.5, -81.0, 7.5, -81.0);
    assert.equal(Math.round(distZero), 0);
  });

  await t.test('2. Validación estricta de parámetros del evento objetivo', () => {
    // Caso válido
    const valid = validateTargetEvent({
      time: '2026-10-27T15:26:02.000Z',
      lat: 7.688,
      lon: -81.585,
      mag: 5.6,
      depth: 10
    });
    assert.equal(valid.lat, 7.688);
    assert.equal(valid.lon, -81.585);
    assert.equal(valid.mag, 5.6);

    // Latitud fuera de rango
    assert.throws(() => validateTargetEvent({ time: '2026-10-27T15:26:02Z', lat: 95, lon: -80 }), /Latitud/);

    // Longitud fuera de rango
    assert.throws(() => validateTargetEvent({ time: '2026-10-27T15:26:02Z', lat: 8, lon: -195 }), /Longitud/);

    // Fecha inválida
    assert.throws(() => validateTargetEvent({ time: 'fecha_invalida', lat: 8, lon: -80 }), /Marca temporal/);
  });

  await t.test('3. Correspondencia exacta y tolerancias para un sismo real unívoco', () => {
    const target = {
      time: new Date('2026-10-27T15:26:02.000Z').getTime(),
      lat: 7.688,
      lon: -81.585,
      mag: 5.6,
      depth: 10
    };

    // Candidato de EMSC separado por 1.9s y 7.8km con magnitud distinta (M5.0 vs M5.6 de IGC)
    const emscCandidates = [
      {
        id: 'emsc_12345',
        time: new Date('2026-10-27T15:26:03.930Z').getTime(),
        lat: 7.7438,
        lon: -81.5353,
        mag: 5.0,
        magType: 'mw',
        depth: 10
      }
    ];

    const match = matchEarthquakeCandidate(target, emscCandidates, 'EMSC');
    assert.equal(match.matched, true);
    assert.equal(match.status, 'reportada');
    assert.equal(match.magnitude, 5.0);
    assert.equal(match.magText, 'M5.0');
    assert.equal(match.magType, 'mw');
    assert.ok(match.distKm < 15, 'Distancia debe ser menor a 15km');
    assert.ok(match.timeDiffSec < 3, 'Diferencia temporal debe ser menor a 3s');
  });

  await t.test('4. Descarte conservador ante dos sismos cercanos en tiempo y espacio (Ambigüedad)', () => {
    const target = {
      time: new Date('2026-10-27T15:26:02.000Z').getTime(),
      lat: 7.688,
      lon: -81.585,
      mag: 5.6
    };

    // Dos eventos de un enjambre en Panamá con tiempos y distancias muy similares
    const ambiguousCandidates = [
      {
        id: 'event_A',
        time: new Date('2026-10-27T15:26:15.000Z').getTime(),
        lat: 7.710,
        lon: -81.560,
        mag: 4.8,
        magType: 'mb'
      },
      {
        id: 'event_B',
        time: new Date('2026-10-27T15:26:22.000Z').getTime(),
        lat: 7.660,
        lon: -81.590,
        mag: 4.9,
        magType: 'mb'
      }
    ];

    // Ante ambigüedad no resoluble de forma incontrovertible:
    // NUNCA asignar magnitud arbitraria; devolver 'sin_coincidencia'
    const result = matchEarthquakeCandidate(target, ambiguousCandidates, 'TEST');
    assert.equal(result.matched, false);
    assert.equal(result.status, 'sin_coincidencia');
    assert.equal(result.ambiguous, true);
  });

  await t.test('5. Descarte de candidatos fuera de tolerancia (> 90s o > 120km)', () => {
    const target = {
      time: new Date('2026-10-27T15:26:02.000Z').getTime(),
      lat: 7.688,
      lon: -81.585,
      mag: 5.6
    };

    // Candidato ocurrido 3 minutos después (tiempo excedido)
    const lateCandidate = [{
      id: 'late',
      time: new Date('2026-10-27T15:30:00.000Z').getTime(),
      lat: 7.688,
      lon: -81.585,
      mag: 5.5
    }];
    assert.equal(matchEarthquakeCandidate(target, lateCandidate, 'USGS').matched, false);

    // Candidato ocurrido a 200 km en Costa Rica (distancia excedida)
    const farCandidate = [{
      id: 'far',
      time: new Date('2026-10-27T15:26:05.000Z').getTime(),
      lat: 9.500,
      lon: -83.500,
      mag: 5.5
    }];
    assert.equal(matchEarthquakeCandidate(target, farCandidate, 'USGS').matched, false);
  });

  await t.test('6. Sismos locales pequeños registrados exclusivamente por el IGC-UP (Sin coincidencia)', () => {
    const target = {
      time: new Date('2026-10-27T12:00:00.000Z').getTime(),
      lat: 8.500,
      lon: -80.000,
      mag: 2.1,
      depth: 5
    };

    // Las agencias internacionales no registran microsismicidad M2.1 en Panamá
    const emptyCandidates = [];
    const res = matchEarthquakeCandidate(target, emptyCandidates, 'USGS');
    assert.equal(res.matched, false);
    assert.equal(res.status, 'sin_coincidencia');
  });

  await t.test('7. Manejo resiliente de fallos HTTP y Timeouts: marca «no_disponible» sin romper la ficha', async () => {
    const target = {
      time: new Date('2026-10-27T15:26:02.000Z').getTime(),
      lat: 7.688,
      lon: -81.585
    };

    // Mock de fetch que falla con HTTP 500
    const mockFailingFetch = async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Internal Server Error' })
    });

    const res = await fetchAndMatchUsgs(target, { fetch: mockFailingFetch });
    assert.equal(res.matched, false);
    assert.equal(res.status, 'no_disponible');
    assert.equal(res.httpStatus, 500);

    // Mock de fetch que arroja AbortError (Timeout)
    const mockTimeoutFetch = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    const resTimeout = await fetchAndMatchEmsc(target, { fetch: mockTimeoutFetch });
    assert.equal(resTimeout.matched, false);
    assert.equal(resTimeout.status, 'no_disponible');
    assert.equal(resTimeout.error, 'TIMEOUT');
  });

  await t.test('8. Parser de GFZ/GEOFON en formato texto delimitado por barras (|)', async () => {
    const target = {
      time: new Date('2026-10-27T15:26:02.000Z').getTime(),
      lat: 7.688,
      lon: -81.585
    };

    const gfzMockText = `
#EventID|Time|Latitude|Longitude|Depth/km|Author|Catalog|Contributor|ContributorID|MagType|Magnitude|MagAuthor|EventLocationName|EventType
gfz2026vblz|2026-10-27T15:26:04.69|7.711|-81.558|10.0|||GFZ|gfz2026vblz|mb|5.3||Panama|earthquake
    `.trim();

    const mockGfzFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => gfzMockText
    });

    const resGfz = await fetchAndMatchGfz(target, { fetch: mockGfzFetch });
    assert.equal(resGfz.matched, true);
    assert.equal(resGfz.agency, 'GFZ');
    assert.equal(resGfz.magnitude, 5.3);
    assert.equal(resGfz.magText, 'M5.3');
    assert.equal(resGfz.magType, 'mb');
    assert.equal(resGfz.catalogId, 'gfz2026vblz');
  });

  await t.test('9. Coordinación general getInternationalComparisons: calcula TTLs dinámicos según antigüedad', async () => {
    const targetTimeMs = Date.now() - 30 * 60 * 1000;
    const targetTimeIso = new Date(targetTimeMs).toISOString();
    const matchingTimeIso = new Date(targetTimeMs + 2000).toISOString();

    // Mock con 1 agencia coincidente y 2 sin coincidencia
    const mockFetch = async (url) => {
      if (url.includes('seismicportal.eu')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            features: [{
              properties: {
                time: matchingTimeIso,
                lat: 7.69,
                lon: -81.58,
                mag: 5.1,
                magtype: 'mw'
              }
            }]
          })
        };
      }
      if (url.includes('geofon.gfz.de')) {
        return {
          ok: true,
          status: 200,
          text: async () => '#EventID|Time|Latitude|Longitude|Depth/km|Author|Catalog|Contributor|ContributorID|MagType|Magnitude\n'
        };
      }
      // USGS 403 o vacío
      return { ok: false, status: 403 };
    };

    // Evento muy reciente (< 2 horas)
    const recentTarget = {
      time: targetTimeIso,
      lat: 7.688,
      lon: -81.585,
      mag: 5.6
    };

    const compRecent = await getInternationalComparisons(recentTarget, { fetch: mockFetch });
    assert.equal(compRecent.ok, true);
    assert.equal(compRecent.agencias.emsc.matched, true);
    assert.equal(compRecent.agencias.emsc.magText, 'M5.1');
    assert.equal(compRecent.agencias.gfz.matched, false);
    assert.equal(compRecent.agencias.gfz.status, 'sin_coincidencia');
    assert.equal(compRecent.agencias.usgs.matched, false);
    assert.equal(compRecent.agencias.usgs.status, 'no_disponible');
    assert.equal(compRecent.meta.cacheTtlSeconds, 1800, 'TTL debe ser 30m para evento reciente con coincidencia');

    // Evento histórico (> 24 horas)
    const oldTarget = {
      time: new Date(Date.now() - 72 * 3600 * 1000).toISOString(),
      lat: 7.688,
      lon: -81.585,
      mag: 5.6
    };

    const compOld = await getInternationalComparisons(oldTarget, { fetch: mockFetch });
    assert.equal(compOld.meta.cacheTtlSeconds, 86400, 'TTL debe ser 24h para histórico');
  });

  await t.test('10. Endpoint Cloudflare Pages functions/api/comparacion-sismo.js valida parámetros y métodos', async () => {
    const endpointMod = await import('../functions/api/comparacion-sismo.js');
    const { onRequest } = endpointMod;

    // OPTIONS preflight
    const optRes = await onRequest({
      request: new Request('http://localhost/api/comparacion-sismo', { method: 'OPTIONS' })
    });
    assert.equal(optRes.status, 204);

    // POST rechazo
    const postRes = await onRequest({
      request: new Request('http://localhost/api/comparacion-sismo', { method: 'POST' })
    });
    assert.equal(postRes.status, 405);

    // Parámetros faltantes
    const badRes = await onRequest({
      request: new Request('http://localhost/api/comparacion-sismo?id=abc', { method: 'GET' })
    });
    assert.equal(badRes.status, 400);
  });
});
