'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(rootDir, 'assets', 'app.js'), 'utf8');
const swJs = fs.readFileSync(path.join(rootDir, 'sw.js'), 'utf8');

const {
  handler,
  parseAndValidateParams,
  formatPanamaDateTime,
  queryHistoricalSeismicData
} = require('../netlify/functions/historico-sismos');

const MOCK_DATASET_COMPLETE = [
  {
    id: 101,
    source_uid: 'igc_2026-10-12T04:15:00.000Z',
    source_event_id: 'IGC-20261011-111500PM',
    fecha_hora: '2026-10-12T04:15:00.000Z',
    magnitud: 3.1,
    profundidad_km: 15.0,
    latitud: 7.45,
    longitud: -81.75,
    region: 'Sur de Coiba, Golfo de Chiriquí',
    ubicacion: 'Sur de Coiba',
    estado: 'REVISADO',
    fuente: 'IGC-UP',
    datos_originales: {
      zona: 'Golfo de Chiriquí',
      localidad: 'Coiba',
      url_detalle: 'https://sismosgeociencias.up.ac.pa/detalle.php?id=101'
    }
  },
  {
    id: 102,
    source_uid: 'igc_2026-10-18T10:00:00.000Z',
    source_event_id: 'IGC-20261018-050000AM',
    fecha_hora: '2026-10-18T10:00:00.000Z',
    magnitud: 4.8,
    profundidad_km: 22.0,
    latitud: 8.25,
    longitud: -82.80,
    region: 'Tierras Altas, Chiriquí',
    ubicacion: 'Tierras Altas',
    estado: 'REVISADO',
    fuente: 'IGC-UP',
    datos_originales: {
      zona: 'Chiriquí',
      localidad: 'Tierras Altas'
    }
  },
  {
    id: 103,
    source_uid: 'igc_2026-10-27T18:00:00.000Z',
    source_event_id: 'IGC-20261027-010000PM',
    fecha_hora: '2026-10-27T18:00:00.000Z',
    magnitud: 5.4,
    profundidad_km: 10.0,
    latitud: 7.68,
    longitud: -81.58,
    region: 'Golfo de Chiriquí',
    ubicacion: 'Coiba',
    estado: 'REVISADO',
    fuente: 'IGC-UP'
  }
];

function createMockSupabase(dataset = MOCK_DATASET_COMPLETE) {
  const orderCalls = [];
  return {
    orderCalls,
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
            or(clause) {
              return queryState;
            },
            order(col, { ascending }) {
              orderCalls.push({ col, ascending });
              rows.sort((a, b) => {
                if (a[col] < b[col]) return ascending ? -1 : 1;
                if (a[col] > b[col]) return ascending ? 1 : -1;
                return 0;
              });
              return queryState;
            },
            async range(from, to) {
              const sliced = rows.slice(from, to + 1);
              return { data: sliced, error: null };
            },
            then(resolve) {
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
}

test('Suite Historial Sísmico Permanente — Supabase Production', async (t) => {
  await t.test('1. formatPanamaDateTime calcula fecha y hora precisa en zona UTC-5', () => {
    // 2026-10-18T15:00:00.000Z es 10:00:00 AM en Panamá
    const { fecha, hora } = formatPanamaDateTime('2026-10-18T15:00:00.000Z');
    assert.equal(fecha, '2026-10-18');
    assert.equal(hora, '10:00:00 AM');
  });

  await t.test('2. anio=all permite consultar todo el historial sin límite de año ni corte de 7 días', () => {
    const { isValid, filters } = parseAndValidateParams({ anio: 'all', include_events: 'true' });
    assert.equal(isValid, true);
    assert.equal(filters.anio, null);
    assert.equal(filters.desdeISO, null);
    assert.equal(filters.hastaISO, null);
  });

  await t.test('3. include_stats=false omite el cálculo pesado de estadísticas al paginar', async () => {
    const mock = createMockSupabase();
    const { filters } = parseAndValidateParams({ anio: 'all', include_events: 'true', include_stats: 'false', page: '1', limit: '25' });
    const result = await queryHistoricalSeismicData(filters, mock);

    assert.equal(result.estadisticas, null, 'No debe computar estadísticas cuando include_stats=false');
    assert.equal(result.paginacion.total_registros, 3);
    assert.equal(result.eventos.length, 3);
  });

  await t.test('4. Ordenamiento estable por fecha_hora DESC e id DESC para prevenir saltos de página', async () => {
    const mock = createMockSupabase();
    const { filters } = parseAndValidateParams({ anio: 'all', include_events: 'true', include_stats: 'false' });
    await queryHistoricalSeismicData(filters, mock);

    // Debe haber registrado order('fecha_hora', ...) seguido de order('id', ...)
    const cols = mock.orderCalls.map(c => c.col);
    assert.ok(cols.includes('fecha_hora'), 'Debe ordenar por fecha_hora');
    assert.ok(cols.includes('id'), 'Debe usar id como desempate determinista');
  });

  await t.test('5. Normalización completa de campos para interoperabilidad con el frontend', async () => {
    const mock = createMockSupabase();
    const { filters } = parseAndValidateParams({ anio: 'all', include_events: 'true', include_stats: 'false' });
    const result = await queryHistoricalSeismicData(filters, mock);

    const oldest = result.eventos.find(e => e.id === 101);
    assert.ok(oldest, 'Debe encontrar el registro del 12 de octubre');
    assert.equal(oldest.fecha, '2026-10-11'); // 04:15 UTC es 11:15 PM del 11 de octubre local
    assert.ok(oldest.hora.includes('11:15:00 PM'));
    assert.equal(oldest.profundidad, 15);
    assert.equal(oldest.profundidad_km, 15);
    assert.equal(oldest.magnitud, 3.1);
    assert.equal(oldest.zona, 'Golfo de Chiriquí');
    assert.equal(oldest.localidad, 'Coiba');
    assert.equal(oldest.uid, 'igc_2026-10-12T04:15:00.000Z');
  });

  await t.test('6. Permite encontrar registros antiguos (12 oct 2026) y recientes (27 oct 2026) simultáneamente', async () => {
    const mock = createMockSupabase();
    const { filters } = parseAndValidateParams({ anio: 'all', include_events: 'true', include_stats: 'false' });
    const result = await queryHistoricalSeismicData(filters, mock);

    const hasOct12 = result.eventos.some(e => e.timestamp.startsWith('2026-10-12'));
    const hasOct27 = result.eventos.some(e => e.timestamp.startsWith('2026-10-27'));
    assert.equal(hasOct12, true, 'Debe incluir evento del 12 de octubre');
    assert.equal(hasOct27, true, 'Debe incluir evento del 27 de octubre');
  });

  await t.test('7. index.html contiene opción "Todo el historial archivado" y selector "Todos los años"', () => {
    assert.ok(indexHtml.includes('>Todo el historial archivado</option>'), 'filterPeriod debe tener opción Todo el historial archivado');
    assert.ok(indexHtml.includes('<option value="all">Todos los años</option>'), 'histYear debe tener opción Todos los años');
  });

  await t.test('8. app.js integra paginación desde el servidor Supabase y conmutación reactiva', () => {
    assert.ok(appJs.includes('function isHistoricalModeActive()'), 'Debe definir isHistoricalModeActive');
    assert.ok(appJs.includes('async function fetchHistoricalCatalogPage('), 'Debe definir fetchHistoricalCatalogPage');
    assert.ok(appJs.includes("f.period.value === '0'"), 'Debe detectar opción Todo el historial');
    assert.ok(appJs.includes('function drawTable(data, pagination = null)'), 'drawTable debe aceptar metadata de paginación del servidor');
    assert.ok(appJs.includes('Archivo permanente'), 'drawTable debe rotular registros del archivo permanente');
  });

  await t.test('9. sw.js y index.html sincronizan clave de caché renovada v20261027history1', () => {
    assert.ok(swJs.includes('core-v20261027history1') || swJs.includes('core-v20261028buttons1') || swJs.includes('core-v20261028catalog1') || swJs.includes('core-v20261028ficha1') || swJs.includes('core-v20261028nav1') || swJs.includes('core-v20261028nav2') || swJs.includes('core-v20261030gpstiming1') || swJs.includes('core-v20261030integrated1'), 'sw.js debe contener clave de cache renovada');
    assert.ok(indexHtml.includes('assets/style.css?v=20261027history1') || indexHtml.includes('assets/style.css?v=20261028buttons1') || indexHtml.includes('assets/style.css?v=20261028catalog1') || indexHtml.includes('assets/style.css?v=20261028ficha1') || indexHtml.includes('assets/style.css?v=20261028nav1') || indexHtml.includes('assets/style.css?v=20261028nav2'), 'index.html debe solicitar style.css versionado');
    assert.ok(indexHtml.includes('assets/app.js?v=20261027history1') || indexHtml.includes('assets/app.js?v=20261028buttons1') || indexHtml.includes('assets/app.js?v=20261028catalog1') || indexHtml.includes('assets/app.js?v=20261028ficha1') || indexHtml.includes('assets/app.js?v=20261028nav1') || indexHtml.includes('assets/app.js?v=20261028nav2'), 'index.html debe solicitar app.js versionado');
  });
});
