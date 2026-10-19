'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  handler,
  sanitizeIdentifier,
  memoryCache
} = require('../netlify/functions/detalle-sismo');

const MOCK_EVENT = {
  id: 42,
  source_uid: 'igc_2026-10-18T22:04:11.000Z',
  source_event_id: 'IGC-20261018-50411PM',
  fecha_hora: '2026-10-18T22:04:11.000Z',
  magnitud: 4.8,
  profundidad_km: 15.5,
  latitud: 7.82,
  longitud: -81.90,
  region: 'Sur de Coiba, Golfo de Chiriquí',
  ubicacion: 'Sur de Coiba',
  estado: 'REVISADO',
  fuente: 'IGC-UP',
  datos_originales: {
    zona: 'Golfo de Chiriquí',
    localidad: 'Coiba',
    detalle: 'https://sismosgeociencias.up.ac.pa/ultimosismo.html?id=test42'
  },
  primera_captura: '2026-10-18T22:05:00.000Z',
  actualizado_en: '2026-10-18T22:15:00.000Z'
};

function createMockSupabase(foundRecord = MOCK_EVENT) {
  return {
    from(table) {
      assert.equal(table, 'sismos');
      return {
        select() {
          return {
            or(condition) {
              return {
                async maybeSingle() {
                  if (condition.includes('not_found')) {
                    return { data: null, error: null };
                  }
                  return { data: foundRecord, error: null };
                }
              };
            }
          };
        }
      };
    }
  };
}

test('Sanitización de identificadores válidos e inválidos', () => {
  assert.equal(sanitizeIdentifier('igc_2026-10-18T22:04:11.000Z'), 'igc_2026-10-18T22:04:11.000Z');
  assert.equal(sanitizeIdentifier('42'), '42');
  assert.equal(sanitizeIdentifier('IGC-20261018-50411PM'), 'IGC-20261018-50411PM');
  assert.equal(sanitizeIdentifier(''), null);
  assert.equal(sanitizeIdentifier('   '), null);
  assert.equal(sanitizeIdentifier('drop table sismos;--'), null);
  assert.equal(sanitizeIdentifier('<script>'), null);
});

test('Detalle sismo: consulta exitosa por source_uid devuelve evento normalizado', async () => {
  const mockDb = createMockSupabase(MOCK_EVENT);
  const response = await handler({
    httpMethod: 'GET',
    queryStringParameters: { id: 'igc_2026-10-18T22:04:11.000Z' }
  }, {}, { supabase: mockDb, noCache: true });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, true);
  assert.equal(body.evento.id, 42);
  assert.equal(body.evento.source_uid, 'igc_2026-10-18T22:04:11.000Z');
  assert.equal(body.evento.magnitud, 4.8);
  assert.equal(body.evento.profundidad, 15.5);
  assert.equal(body.evento.estado, 'REVISADO');
  assert.equal(body.evento.detalle, 'https://sismosgeociencias.up.ac.pa/ultimosismo.html?id=test42');
});

test('Detalle sismo: identificador inexistente retorna 404', async () => {
  const mockDb = createMockSupabase(null);
  const response = await handler({
    httpMethod: 'GET',
    queryStringParameters: { id: 'not_found_event' }
  }, {}, { supabase: mockDb, noCache: true });

  assert.equal(response.statusCode, 404);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /no encontrado/i);
});

test('Detalle sismo: identificador faltante retorna 400', async () => {
  const response = await handler({
    httpMethod: 'GET',
    queryStringParameters: {}
  }, {});

  assert.equal(response.statusCode, 400);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, false);
});

test('Detalle sismo: método POST retorna 405 Method Not Allowed', async () => {
  const response = await handler({
    httpMethod: 'POST'
  }, {});

  assert.equal(response.statusCode, 405);
});

test('Detalle sismo: preflight OPTIONS retorna 204 con CORS', async () => {
  const response = await handler({
    httpMethod: 'OPTIONS'
  }, {});

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['Access-Control-Allow-Origin'], '*');
});

test('Detalle sismo: comprobación de caché en memoria', async () => {
  const mockDb = createMockSupabase(MOCK_EVENT);
  memoryCache.clear();

  const r1 = await handler({
    httpMethod: 'GET',
    queryStringParameters: { id: 'igc_cache_test' }
  }, {}, { supabase: mockDb });

  assert.equal(r1.statusCode, 200);
  assert.equal(r1.headers['X-Cache'], 'MISS');

  const r2 = await handler({
    httpMethod: 'GET',
    queryStringParameters: { id: 'igc_cache_test' }
  }, {}, { supabase: mockDb });

  assert.equal(r2.statusCode, 200);
  assert.equal(r2.headers['X-Cache'], 'HIT');
  const b2 = JSON.parse(r2.body);
  assert.equal(b2.origen, 'cache');
});
