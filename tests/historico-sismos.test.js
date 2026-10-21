'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  handler,
  parseAndValidateParams,
  calculateStatistics,
  applyFiltersToQuery,
  queryHistoricalSeismicData,
  panamaToUtc,
  toPanamaLocalDateStr,
  toPanamaLocalMonthStr,
  memoryCache
} = require('../netlify/functions/historico-sismos');

// Conjunto de datos representativo para pruebas
const MOCK_DATASET = [
  {
    id: 1,
    source_uid: 'igc_2026-10-18T15:00:00.000Z',
    source_event_id: 'IGC-20261018-100000AM',
    fecha_hora: '2026-10-18T15:00:00.000Z', // 10:00 AM Panamá
    magnitud: 2.8,
    profundidad_km: 12.0,
    latitud: 7.85,
    longitud: -81.95,
    region: 'Sur de Coiba, Golfo de Chiriquí',
    ubicacion: 'Sur de Coiba',
    estado: 'REVISADO',
    fuente: 'IGC-UP'
  },
  {
    id: 2,
    source_uid: 'igc_2026-10-18T22:30:00.000Z',
    source_event_id: 'IGC-20261018-53000PM',
    fecha_hora: '2026-10-18T22:30:00.000Z', // 5:30 PM Panamá
    magnitud: 3.5,
    profundidad_km: 25.0,
    latitud: 8.42,
    longitud: -82.68,
    region: 'Tierras Altas, Chiriquí',
    ubicacion: 'Tierras Altas',
    estado: 'REVISADO',
    fuente: 'IGC-UP'
  },
  {
    id: 3,
    source_uid: 'igc_2026-10-19T03:00:00.000Z',
    source_event_id: 'IGC-20261018-100000PM',
    fecha_hora: '2026-10-19T03:00:00.000Z', // 10:00 PM Panamá del 18 de octubre (03:00 UTC del 19)
    magnitud: 4.5,
    profundidad_km: 10.0,
    latitud: 7.20,
    longitud: -82.10,
    region: 'Sur de Coiba, Golfo de Chiriquí',
    ubicacion: 'Sur de Coiba',
    estado: 'PRELIMINAR',
    fuente: 'IGC-UP'
  },
  {
    id: 4,
    source_uid: 'igc_2026-10-15T12:00:00.000Z',
    source_event_id: 'IGC-20261015-70000AM',
    fecha_hora: '2026-10-15T12:00:00.000Z', // 7:00 AM Panamá
    magnitud: 5.2,
    profundidad_km: 35.0,
    latitud: 8.10,
    longitud: -78.30,
    region: 'Golfo de San Miguel, Darién',
    ubicacion: 'Darién',
    estado: 'REVISADO',
    fuente: 'IGC-UP'
  },
  {
    id: 5,
    source_uid: '2025-05-10T18:00:00.000Z',
    source_event_id: 'IGC-20250510-10000PM',
    fecha_hora: '2025-05-10T18:00:00.000Z', // 1:00 PM Panamá de Mayo 2025
    magnitud: 3.9,
    profundidad_km: 18.0,
    latitud: 7.55,
    longitud: -80.20,
    region: 'Las Tablas, Los Santos',
    ubicacion: 'Las Tablas',
    estado: 'REVISADO',
    fuente: 'IGC-UP'
  }
];

function createMockSupabase(dataset = MOCK_DATASET) {
  let failMode = null;

  const mock = {
    setFailMode(mode) { failMode = mode; },
    from(table) {
      assert.equal(table, 'sismos');
      return {
        select(fields, selectOpts = {}) {
          let rows = [...dataset];
          const queryState = {
            gte(col, val) {
              rows = rows.filter(r => r[col] >= val);
              return queryState;
            },
            lte(col, val) {
              rows = rows.filter(r => r[col] <= val);
              return queryState;
            },
            eq(col, val) {
              rows = rows.filter(r => String(r[col]).toUpperCase() === String(val).toUpperCase());
              return queryState;
            },
            ilike(col, pattern) {
              const clean = pattern.replace(/%/g, '').toLowerCase();
              rows = rows.filter(r => String(r[col] || '').toLowerCase().includes(clean));
              return queryState;
            },
            order(col, { ascending }) {
              rows.sort((a, b) => {
                if (a[col] < b[col]) return ascending ? -1 : 1;
                if (a[col] > b[col]) return ascending ? 1 : -1;
                return 0;
              });
              return queryState;
            },
            async range(from, to) {
              if (failMode === 'range') {
                return { data: null, error: new Error('Error simulado en range()') };
              }
              const sliced = rows.slice(from, to + 1);
              return { data: sliced, error: null };
            },
            then(resolve, reject) {
              if (failMode === 'count') {
                resolve({ count: null, data: null, error: new Error('Error simulado en count()') });
                return;
              }
              if (selectOpts.head && selectOpts.count === 'exact') {
                resolve({ count: rows.length, data: null, error: null });
              } else {
                resolve({ count: rows.length, data: rows, error: null });
              }
            }
          };
          return queryState;
        }
      };
    }
  };
  return mock;
}

// --------------------------------------------------------------------------
// 1. Fechas y Zona Horaria de Panamá (America/Panama, UTC-5)
// --------------------------------------------------------------------------
test('Zona horaria Panamá: conversión precisa de fecha local a límites UTC', () => {
  // En Panamá UTC-5, las 00:00:00 del 18 de octubre son las 05:00:00 UTC
  const inicio = panamaToUtc(2026, 10, 18, 0, 0, 0, 0);
  assert.equal(inicio.toISOString(), '2026-10-18T05:00:00.000Z');

  // Las 23:59:59.999 del 18 de octubre en Panamá son las 04:59:59.999 UTC del 19 de octubre
  const fin = panamaToUtc(2026, 10, 18, 23, 59, 59, 999);
  assert.equal(fin.toISOString(), '2026-10-19T04:59:59.999Z');
});

test('Zona horaria Panamá: sismo a las 10:00 PM del 18 de oct (03:00 UTC del 19) se agrupa en 2026-10-18 local', () => {
  // 2026-10-19T03:00:00.000Z es 10:00 PM del 18 de oct en Panamá
  const diaLocal = toPanamaLocalDateStr('2026-10-19T03:00:00.000Z');
  assert.equal(diaLocal, '2026-10-18');

  const mesLocal = toPanamaLocalMonthStr('2026-10-19T03:00:00.000Z');
  assert.equal(mesLocal, '2026-10');
});

// --------------------------------------------------------------------------
// 2. Agrupaciones por Magnitud Sin Intervalos Superpuestos
// --------------------------------------------------------------------------
test('Agrupación por magnitud: no existen solapamientos y la suma de grupos es igual al total', () => {
  const dataset = [
    { magnitud: 2.9, profundidad_km: 10, fecha_hora: '2026-10-18T10:00:00Z', region: 'R1' },
    { magnitud: 3.0, profundidad_km: 10, fecha_hora: '2026-10-18T10:00:00Z', region: 'R2' }, // límite exacto 3.0
    { magnitud: 3.9, profundidad_km: 10, fecha_hora: '2026-10-18T10:00:00Z', region: 'R3' },
    { magnitud: 4.0, profundidad_km: 10, fecha_hora: '2026-10-18T10:00:00Z', region: 'R4' }, // límite exacto 4.0
    { magnitud: 4.9, profundidad_km: 10, fecha_hora: '2026-10-18T10:00:00Z', region: 'R5' },
    { magnitud: 5.0, profundidad_km: 10, fecha_hora: '2026-10-18T10:00:00Z', region: 'R6' }, // límite exacto 5.0
    { magnitud: 6.2, profundidad_km: 10, fecha_hora: '2026-10-18T10:00:00Z', region: 'R7' }
  ];

  const stats = calculateStatistics(dataset);
  assert.equal(stats.total, 7);
  assert.equal(stats.menor_3, 1, 'M < 3.0');
  assert.equal(stats.entre_3_y_3_9, 2, '3.0 <= M < 4.0');
  assert.equal(stats.entre_4_y_4_9, 2, '4.0 <= M < 5.0');
  assert.equal(stats.mayor_igual_5, 2, 'M >= 5.0');

  // Suma de rangos debe ser exactamente igual al total
  const sumaRangos = stats.menor_3 + stats.entre_3_y_3_9 + stats.entre_4_y_4_9 + stats.mayor_igual_5;
  assert.equal(sumaRangos, stats.total);

  // Estadísticas descriptivas
  assert.equal(stats.mag_min, 2.9);
  assert.equal(stats.mag_max, 6.2);
  assert.equal(typeof stats.mag_promedio, 'number');
  assert.equal(stats.prof_promedio, 10.0);
});

// --------------------------------------------------------------------------
// 3. Consultas por Año y Mes
// --------------------------------------------------------------------------
test('Consulta por año y mes: filtra correctamente los eventos correspondientes', async () => {
  const mockDb = createMockSupabase();

  // Consultar Octubre de 2026 (hay 4 sismos en el dataset)
  const result = await queryHistoricalSeismicData({
    anio: 2026,
    mes: 10,
    desdeISO: panamaToUtc(2026, 10, 1, 0, 0, 0, 0).toISOString(),
    hastaISO: panamaToUtc(2026, 10, 31, 23, 59, 59, 999).toISOString(),
    limit: 50,
    page: 1,
    order: 'desc',
    include_events: true
  }, mockDb);

  assert.equal(result.paginacion.total_registros, 4);
  assert.equal(result.estadisticas.total, 4);
  assert.equal(result.estadisticas.menor_3, 1);
  assert.equal(result.estadisticas.entre_3_y_3_9, 1);
  assert.equal(result.estadisticas.entre_4_y_4_9, 1);
  assert.equal(result.estadisticas.mayor_igual_5, 1);
  assert.equal(result.eventos.length, 4);
});

test('Consulta por año: filtra exclusivamente el año indicado', async () => {
  const mockDb = createMockSupabase();

  // Consultar año 2025 (hay 1 sismo en Mayo 2025)
  const result = await queryHistoricalSeismicData({
    anio: 2025,
    desdeISO: panamaToUtc(2025, 1, 1, 0, 0, 0, 0).toISOString(),
    hastaISO: panamaToUtc(2025, 12, 31, 23, 59, 59, 999).toISOString(),
    limit: 50,
    page: 1,
    order: 'desc',
    include_events: true
  }, mockDb);

  assert.equal(result.paginacion.total_registros, 1);
  assert.equal(result.estadisticas.total, 1);
  assert.equal(result.eventos[0].magnitud, 3.9);
});

// --------------------------------------------------------------------------
// 4. Filtros Combinados (Magnitud, Región, Estado, Profundidad)
// --------------------------------------------------------------------------
test('Filtros combinados: región, magnitud mínima y estado', async () => {
  const mockDb = createMockSupabase();

  // Buscar en Coiba con magnitud >= 4.0
  const result = await queryHistoricalSeismicData({
    region: 'Coiba',
    min_mag: 4.0,
    page: 1,
    limit: 50,
    order: 'desc',
    include_events: true
  }, mockDb);

  assert.equal(result.paginacion.total_registros, 1);
  assert.equal(result.eventos[0].region, 'Sur de Coiba, Golfo de Chiriquí');
  assert.equal(result.eventos[0].magnitud, 4.5);
  assert.equal(result.estadisticas.total, 1);
  assert.equal(result.estadisticas.entre_4_y_4_9, 1);
});

// --------------------------------------------------------------------------
// 5. Paginación de Registros
// --------------------------------------------------------------------------
test('Paginación: respeta página, límite y navegación', async () => {
  const mockDb = createMockSupabase();

  // Página 1 con límite 2
  const p1 = await queryHistoricalSeismicData({
    limit: 2,
    page: 1,
    order: 'desc',
    include_events: true
  }, mockDb);

  assert.equal(p1.paginacion.pagina_actual, 1);
  assert.equal(p1.paginacion.limite, 2);
  assert.equal(p1.paginacion.total_registros, 5);
  assert.equal(p1.paginacion.total_paginas, 3);
  assert.equal(p1.paginacion.tiene_siguiente, true);
  assert.equal(p1.paginacion.tiene_anterior, false);
  assert.equal(p1.eventos.length, 2);

  // Estadísticas abarcan el total de 5 registros, NO solo los 2 de la página
  assert.equal(p1.estadisticas.total, 5);

  // Página 2 con límite 2
  const p2 = await queryHistoricalSeismicData({
    limit: 2,
    page: 2,
    order: 'desc',
    include_events: true
  }, mockDb);

  assert.equal(p2.paginacion.pagina_actual, 2);
  assert.equal(p2.paginacion.tiene_siguiente, true);
  assert.equal(p2.paginacion.tiene_anterior, true);
  assert.equal(p2.eventos.length, 2);

  // Los eventos de la página 2 deben ser diferentes a los de la página 1
  assert.notEqual(p1.eventos[0].id, p2.eventos[0].id);
});

// --------------------------------------------------------------------------
// 6. Validación de Parámetros y Manejo de Errores
// --------------------------------------------------------------------------
test('Validación: rechaza año inválido con error 400', async () => {
  const response = await handler({
    httpMethod: 'GET',
    queryStringParameters: { anio: 'abcd' }
  }, {}, { noCache: true });

  assert.equal(response.statusCode, 400);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, false);
  assert.match(body.detalles[0], /año/i);
});

test('Validación: rechaza mes fuera de rango (1-12) con error 400', async () => {
  const response = await handler({
    httpMethod: 'GET',
    queryStringParameters: { mes: '13' }
  }, {}, { noCache: true });

  assert.equal(response.statusCode, 400);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, false);
  assert.match(body.detalles[0], /mes/i);
});

test('Validación: rechaza min_mag > max_mag con error 400', async () => {
  const response = await handler({
    httpMethod: 'GET',
    queryStringParameters: { min_mag: '5.0', max_mag: '3.0' }
  }, {}, { noCache: true });

  assert.equal(response.statusCode, 400);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, false);
  assert.match(body.detalles[0], /magnitud mínima/i);
});

test('Validación: rechaza fecha desde inválida con error 400', async () => {
  const response = await handler({
    httpMethod: 'GET',
    queryStringParameters: { desde: '2026-02-31' } // Fecha inexistente
  }, {}, { noCache: true });

  assert.equal(response.statusCode, 400);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, false);
  assert.match(body.detalles[0], /fecha inválida/i);
});

// --------------------------------------------------------------------------
// 7. Métodos HTTP y Seguridad (CORS y Ausencia de Secretos)
// --------------------------------------------------------------------------
test('Seguridad HTTP: OPTIONS responde 204 con encabezados CORS', async () => {
  const response = await handler({
    httpMethod: 'OPTIONS'
  }, {});

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['Access-Control-Allow-Origin'], '*');
  assert.match(response.headers['Access-Control-Allow-Methods'], /GET/);
});

test('Seguridad HTTP: POST devuelve 405 Method Not Allowed', async () => {
  const response = await handler({
    httpMethod: 'POST'
  }, {});

  assert.equal(response.statusCode, 405);
  const body = JSON.parse(response.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /Método no permitido/i);
});

test('Seguridad: la respuesta jamás contiene credenciales secretas ni URLs privadas', async () => {
  const mockDb = createMockSupabase();
  const response = await handler({
    httpMethod: 'GET',
    queryStringParameters: { anio: '2026', limit: '10' }
  }, {}, { supabase: mockDb, noCache: true });

  assert.equal(response.statusCode, 200);
  const bodyStr = response.body;

  // Verificar que claves o tokens no aparezcan en la respuesta
  assert.equal(bodyStr.includes('SUPABASE_SECRET_KEY'), false);
  assert.equal(bodyStr.includes('sb_secret_'), false);
  assert.equal(bodyStr.includes('service_role'), false);
});

// --------------------------------------------------------------------------
// 8. Caché en Memoria
// --------------------------------------------------------------------------
test('Caché: segunda llamada idéntica devuelve HIT desde memoria', async () => {
  const mockDb = createMockSupabase();
  memoryCache.clear();

  // Primer llamado -> MISS
  const r1 = await handler({
    httpMethod: 'GET',
    queryStringParameters: { anio: '2026', mes: '10' }
  }, {}, { supabase: mockDb });

  assert.equal(r1.statusCode, 200);
  assert.equal(r1.headers['X-Cache'], 'MISS');

  // Segundo llamado -> HIT
  const r2 = await handler({
    httpMethod: 'GET',
    queryStringParameters: { anio: '2026', mes: '10' }
  }, {}, { supabase: mockDb });

  assert.equal(r2.statusCode, 200);
  assert.equal(r2.headers['X-Cache'], 'HIT');
  const b2 = JSON.parse(r2.body);
  assert.equal(b2.origen_datos, 'cache');
});


// --------------------------------------------------------------------------
// 9. Consulta Histórica Específica (Octubre 2026)
// --------------------------------------------------------------------------
test('Consulta histórica: octubre de 2026 calcula estadísticas válidas con datos representativos', async () => {
  const mockDb = createMockSupabase();
  const response = await handler({
    httpMethod: 'GET',
    queryStringParameters: { anio: '2026', mes: '10', include_events: 'false' }
  }, {}, { supabase: mockDb, noCache: true });

  assert.equal(response.statusCode, 200);
  const data = JSON.parse(response.body);
  assert.equal(data.ok, true);
  assert.ok(data.estadisticas);
  assert.equal(typeof data.estadisticas.total, 'number');
  assert.ok(data.estadisticas.total >= 0);
  assert.equal(data.filtros_aplicados.anio, 2026);
  assert.equal(data.filtros_aplicados.mes, 10);
  assert.ok(data.estadisticas.por_magnitud);
  assert.ok(data.estadisticas.distribucion_diaria);
});
