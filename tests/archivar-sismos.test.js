'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeEvents,
  generateSourceUid,
  syncEventsToSupabase,
  runArchival,
  rawHandler
} = require('../netlify/functions/archivar-sismos');

// Mock simple de Supabase en memoria para pruebas unitarias sin tocar producción
function createMockSupabase(initialData = []) {
  const store = new Map();
  for (const item of initialData) {
    store.set(item.source_uid, { ...item });
  }

  let failSelect = false;
  let failUpsert = false;

  return {
    _store: store,
    setFailSelect(val) { failSelect = val; },
    setFailUpsert(val) { failUpsert = val; },
    from(table) {
      assert.equal(table, 'sismos');
      return {
        select(fields) {
          return {
            async in(column, values) {
              if (failSelect) {
                return { data: null, error: new Error('Error de conexión con Supabase (simulado)') };
              }
              const found = [];
              if (column === 'source_uid') {
                for (const val of values) {
                  if (store.has(val)) {
                    found.push({ ...store.get(val) });
                  }
                }
              } else if (column === 'fecha_hora') {
                for (const val of values) {
                  for (const item of store.values()) {
                    if (item.fecha_hora === val) {
                      found.push({ ...item });
                    }
                  }
                }
              }
              return { data: found, error: null };
            }
          };
        },
        async upsert(records, options = {}) {
          if (failUpsert) {
            return { data: null, error: new Error('Error de escritura en Supabase (simulado)') };
          }
          assert.equal(options.onConflict, 'source_uid');
          for (const rec of records) {
            assert.ok(rec.source_uid, 'El registro debe tener source_uid');
            store.set(rec.source_uid, { ...rec });
          }
          return { data: records, error: null };
        }
      };
    }
  };
}

// --------------------------------------------------------------------------
// 1. Normalización y Validación de Datos
// --------------------------------------------------------------------------
test('Normalización de eventos y cálculo de zona horaria Panamá (UTC-5)', () => {
  const raw = [
    {
      fecha: '2026-10-18',
      hora: '5:04:11PM',
      latitud: 7.53921,
      longitud: -80.22578,
      profundidad: 5,
      magnitud: 3.5,
      region: 'Localizado en Panamá a 25km al sur de Las Tablas',
      zona: 'Panamá',
      localidad: 'Las Tablas',
      estado: 'PRELIMINAR',
      detalle: 'https://sismosgeociencias.up.ac.pa/ultimosismo.html?id=test'
    }
  ];

  const { normalized, descartados } = normalizeEvents(raw);
  assert.equal(descartados, 0);
  assert.equal(normalized.length, 1);

  const e = normalized[0];
  // 5:04:11 PM en UTC-5 corresponde a 22:04:11 UTC
  assert.equal(e.fecha_hora, '2026-10-18T22:04:11.000Z');
  assert.equal(e.source_uid, 'igc_2026-10-18T22:04:11.000Z');
  assert.equal(e.source_event_id, 'IGC-20261018-50411PM');
  assert.equal(e.magnitud, 3.5);
  assert.equal(e.profundidad_km, 5);
  assert.equal(e.latitud, 7.53921);
  assert.equal(e.longitud, -80.22578);
  assert.equal(e.region, 'Panamá');
  assert.equal(e.ubicacion, 'Localizado en Panamá a 25km al sur de Las Tablas');
  assert.equal(e.estado, 'PRELIMINAR');
  assert.equal(e.fuente, 'IGC-UP');
  assert.ok(e.datos_originales);
  assert.equal(e.datos_originales.zona_horaria, 'America/Panama');
});

test('Descarte de datos incompletos o corruptos', () => {
  const invalidRows = [
    null,
    {},
    // Latitud fuera de rango (-90 a 90)
    { fecha: '2026-10-18', hora: '1:00:00PM', latitud: 120.5, longitud: -80, profundidad: 10, magnitud: 3.0, region: 'Panamá' },
    // Longitud fuera de rango (-180 a 180)
    { fecha: '2026-10-18', hora: '1:00:00PM', latitud: 8.5, longitud: -200, profundidad: 10, magnitud: 3.0, region: 'Panamá' },
    // Magnitud absurda
    { fecha: '2026-10-18', hora: '1:00:00PM', latitud: 8.5, longitud: -80, profundidad: 10, magnitud: 99.9, region: 'Panamá' },
    // Profundidad negativa
    { fecha: '2026-10-18', hora: '1:00:00PM', latitud: 8.5, longitud: -80, profundidad: -5, magnitud: 3.0, region: 'Panamá' },
    // Fecha u hora inválida
    { fecha: 'fecha-mala', hora: 'hora-mala', latitud: 8.5, longitud: -80, profundidad: 10, magnitud: 3.0, region: 'Panamá' }
  ];

  const { normalized, descartados } = normalizeEvents(invalidRows);
  assert.equal(normalized.length, 0);
  assert.equal(descartados, invalidRows.length);
});

// --------------------------------------------------------------------------
// 2. Detección de Duplicados, Consolidación y Eventos Distantes
// --------------------------------------------------------------------------
test('Consolida versión PRELIMINAR y REVISADA del mismo sismo en el mismo segundo (< 35 km)', () => {
  const raw = [
    // Registro preliminar
    {
      fecha: '2026-10-16',
      hora: '1:43:47PM',
      latitud: 7.24313,
      longitud: -80.40283,
      profundidad: 10,
      magnitud: 3.7,
      region: 'Localizado en Panamá a 18km al sur de Tonosí',
      zona: 'Panamá',
      localidad: 'Tonosí',
      estado: 'PRELIMINAR'
    },
    // Registro revisado por analista (mismo segundo, distancia ~3.8 km)
    {
      fecha: '2026-10-16',
      hora: '1:43:47PM',
      latitud: 7.26850,
      longitud: -80.43067,
      profundidad: 12,
      magnitud: 3.6,
      region: 'Localizado en Panamá a 15km al sur de Tonosí',
      zona: 'Panamá',
      localidad: 'Tonosí',
      estado: 'REVISADO'
    }
  ];

  const { normalized, descartados } = normalizeEvents(raw);
  assert.equal(descartados, 0);
  // Debe consolidarse en UN único registro
  assert.equal(normalized.length, 1);
  const result = normalized[0];
  assert.equal(result.estado, 'REVISADO', 'Debe preferir el estado REVISADO');
  assert.equal(result.magnitud, 3.6, 'Debe tomar la magnitud revisada');
  assert.equal(result.profundidad_km, 12, 'Debe tomar la profundidad revisada');
  assert.equal(result.latitud, 7.26850);
});

test('Distingue dos eventos reales simultáneos en regiones distantes (>= 35 km) sin fusionarlos y genera incidencia', () => {
  const raw = [
    // Evento en Chiriquí (Oeste de Panamá)
    {
      fecha: '2026-10-17',
      hora: '2:00:00AM',
      latitud: 8.30000,
      longitud: -82.75000,
      profundidad: 10,
      magnitud: 4.0,
      region: 'Región Fronteriza Panamá-Costa Rica',
      zona: 'Región Fronteriza',
      localidad: 'Puerto Armuelles',
      estado: 'REVISADO'
    },
    // Evento simultáneo en Darién (Este de Panamá, > 500 km de distancia)
    {
      fecha: '2026-10-17',
      hora: '2:00:00AM',
      latitud: 7.90000,
      longitud: -78.10000,
      profundidad: 15,
      magnitud: 3.8,
      region: 'Panamá a 50km al sur de Yaviza',
      zona: 'Panamá',
      localidad: 'Yaviza',
      estado: 'REVISADO'
    }
  ];

  const { normalized } = normalizeEvents(raw);
  assert.equal(normalized.length, 2, 'Debe conservar ambos eventos distantes sin fusionarlos');
  assert.notEqual(normalized[0].source_uid, normalized[1].source_uid, 'Deben tener source_uid diferentes');

  // Comprobar que se generó la incidencia de conciliación en datos_originales
  assert.ok(normalized[0].datos_originales.incidencia_conciliacion);
  assert.equal(normalized[0].datos_originales.incidencia_conciliacion.tipo, 'SIMULTANEO_DISTANTE');
  assert.ok(normalized[0].datos_originales.incidencia_conciliacion.distancia_aprox_km > 500);

  assert.ok(normalized[1].datos_originales.incidencia_conciliacion);
  assert.equal(normalized[1].datos_originales.incidencia_conciliacion.tipo, 'SIMULTANEO_DISTANTE');
});

test('Estabilidad de source_uid: no cambia entre ejecuciones cuando una segunda fila simultánea aparece o desaparece en la descarga', async () => {
  const eventoA_preliminar = {
    fecha: '2026-10-16',
    hora: '1:43:47PM',
    latitud: 7.24313,
    longitud: -80.40283,
    profundidad: 10,
    magnitud: 3.7,
    region: 'Tonosí',
    estado: 'PRELIMINAR'
  };

  const eventoA_revisado = {
    fecha: '2026-10-16',
    hora: '1:43:47PM',
    latitud: 7.26850,
    longitud: -80.43067,
    profundidad: 12,
    magnitud: 3.6,
    region: 'Tonosí',
    estado: 'REVISADO'
  };

  const supabase = createMockSupabase();

  // Ejecución 1: Solo aparece la fila preliminar en el IGC-UP
  const norm1 = normalizeEvents([eventoA_preliminar]).normalized;
  await syncEventsToSupabase(norm1, supabase, new Date('2026-10-16T18:45:00Z'));
  assert.equal(supabase._store.size, 1);
  const uidOriginal = [...supabase._store.values()][0].source_uid;

  // Ejecución 2: Coexisten ambas filas en la web del IGC-UP
  const norm2 = normalizeEvents([eventoA_preliminar, eventoA_revisado]).normalized;
  await syncEventsToSupabase(norm2, supabase, new Date('2026-10-16T19:15:00Z'));
  assert.equal(supabase._store.size, 1, 'No debe duplicar el registro en la base de datos');
  const uidPaso2 = [...supabase._store.values()][0].source_uid;
  assert.equal(uidPaso2, uidOriginal, 'El source_uid debe mantenerse idéntico');
  assert.equal([...supabase._store.values()][0].estado, 'REVISADO');

  // Ejecución 3: El instituto elimina la fila preliminar, solo queda la revisada
  const norm3 = normalizeEvents([eventoA_revisado]).normalized;
  await syncEventsToSupabase(norm3, supabase, new Date('2026-10-16T19:45:00Z'));
  assert.equal(supabase._store.size, 1, 'No debe duplicar el registro al quedar sola la fila revisada');
  const uidPaso3 = [...supabase._store.values()][0].source_uid;
  assert.equal(uidPaso3, uidOriginal, 'El source_uid debe mantenerse idéntico en todas las ejecuciones');
});

// --------------------------------------------------------------------------
// 3. Sincronización con Supabase (Primera Carga, Repetición y Revisiones)
// --------------------------------------------------------------------------
test('Primera importación: todos los registros son insertados como nuevos', async () => {
  const supabase = createMockSupabase();
  const rawEvents = [
    {
      fecha: '2026-10-18',
      hora: '4:10:41PM',
      latitud: 7.34655,
      longitud: -80.45809,
      profundidad: 5,
      magnitud: 4.1,
      region: 'Localizado en Panamá a 7km al sur de Tonosí',
      zona: 'Panamá',
      localidad: 'Tonosí',
      estado: 'PRELIMINAR'
    },
    {
      fecha: '2026-10-18',
      hora: '3:20:15PM',
      latitud: 8.83230,
      longitud: -80.80643,
      profundidad: 10,
      magnitud: 3.9,
      region: 'Localizado en Panamá a 46km al noreste de Santa Fe',
      zona: 'Panamá',
      localidad: 'Santa Fe',
      estado: 'PRELIMINAR'
    }
  ];

  const { normalized } = normalizeEvents(rawEvents);
  const t0 = new Date('2026-10-18T21:30:00Z');
  const result = await syncEventsToSupabase(normalized, supabase, t0);

  assert.equal(result.nuevos, 2);
  assert.equal(result.actualizados, 0);
  assert.equal(result.verificados, 0);
  assert.equal(result.total, 2);
  assert.equal(supabase._store.size, 2);

  const stored = [...supabase._store.values()][0];
  assert.equal(stored.primera_captura, t0.toISOString());
  assert.equal(stored.ultima_verificacion, t0.toISOString());
  assert.equal(stored.actualizado_en, t0.toISOString());
});

test('Ejecución repetida sin cambios: no duplica ni modifica primera_captura', async () => {
  const t0 = new Date('2026-10-18T21:30:00Z');
  const t1 = new Date('2026-10-18T22:00:00Z'); // 30 minutos después

  const rawEvents = [
    {
      fecha: '2026-10-18',
      hora: '4:10:41PM',
      latitud: 7.34655,
      longitud: -80.45809,
      profundidad: 5,
      magnitud: 4.1,
      region: 'Localizado en Panamá a 7km al sur de Tonosí',
      zona: 'Panamá',
      localidad: 'Tonosí',
      estado: 'PRELIMINAR'
    }
  ];

  const { normalized } = normalizeEvents(rawEvents);
  const supabase = createMockSupabase();

  // 1a corrida
  await syncEventsToSupabase(normalized, supabase, t0);
  assert.equal(supabase._store.size, 1);

  // 2a corrida 30 min después
  const result2 = await syncEventsToSupabase(normalized, supabase, t1);
  assert.equal(result2.nuevos, 0, 'No debe haber eventos nuevos');
  assert.equal(result2.actualizados, 0, 'No debe haber eventos actualizados');
  assert.equal(result2.verificados, 1, 'Debe verificar el evento existente');
  assert.equal(supabase._store.size, 1, 'El conteo en la base de datos debe ser exactamente 1');

  const stored = [...supabase._store.values()][0];
  assert.equal(stored.primera_captura, t0.toISOString(), 'primera_captura DEBE permanecer intacta');
  assert.equal(stored.ultima_verificacion, t1.toISOString(), 'ultima_verificacion debe actualizarse');
});

test('Revisión de magnitud/profundidad: actualiza valores y conserva primera_captura', async () => {
  const t0 = new Date('2026-10-18T21:30:00Z');
  const t1 = new Date('2026-10-18T22:00:00Z');

  const preliminar = [
    {
      fecha: '2026-10-18',
      hora: '4:10:41PM',
      latitud: 7.34655,
      longitud: -80.45809,
      profundidad: 5,
      magnitud: 4.1,
      region: 'Tonosí',
      estado: 'PRELIMINAR'
    }
  ];

  const revisado = [
    {
      fecha: '2026-10-18',
      hora: '4:10:41PM',
      latitud: 7.34900, // Coordenada refinada
      longitud: -80.46100,
      profundidad: 8,   // Profundidad revisada (era 5)
      magnitud: 4.3,    // Magnitud revisada (era 4.1)
      region: 'Tonosí',
      estado: 'REVISADO' // Estado revisado
    }
  ];

  const supabase = createMockSupabase();

  // Ingesta inicial
  await syncEventsToSupabase(normalizeEvents(preliminar).normalized, supabase, t0);
  assert.equal(supabase._store.size, 1);

  // Ingesta de la revisión
  const resultRevision = await syncEventsToSupabase(normalizeEvents(revisado).normalized, supabase, t1);

  assert.equal(resultRevision.nuevos, 0, 'No debe crear un evento nuevo por cambio de magnitud');
  assert.equal(resultRevision.actualizados, 1, 'Debe detectar el evento como actualizado');
  assert.equal(supabase._store.size, 1, 'No debe haber filas duplicadas');

  const stored = [...supabase._store.values()][0];
  assert.equal(stored.magnitud, 4.3, 'Debe actualizar magnitud a 4.3');
  assert.equal(stored.profundidad_km, 8, 'Debe actualizar profundidad a 8');
  assert.equal(stored.estado, 'REVISADO', 'Debe actualizar estado a REVISADO');
  assert.equal(stored.primera_captura, t0.toISOString(), 'primera_captura debe conservarse');
  assert.equal(stored.actualizado_en, t1.toISOString(), 'actualizado_en debe marcar la hora de la revisión');
  assert.equal(stored.ultima_verificacion, t1.toISOString());
});

// --------------------------------------------------------------------------
// 4. Manejo de Errores e Incidencias de Fuente y Supabase
// --------------------------------------------------------------------------
test('Fallo de fuente vacía lanza error y no realiza cambios en Supabase', async () => {
  const supabase = createMockSupabase();

  await assert.rejects(
    async () => {
      await runArchival({
        supabase,
        sourcePayload: { eventos: [] }
      });
    },
    /no devolvió registros sísmicos/i
  );

  assert.equal(supabase._store.size, 0);
});

test('Error temporal en consulta de Supabase propaga la excepción limpiamente', async () => {
  const supabase = createMockSupabase();
  supabase.setFailSelect(true);

  const raw = [
    {
      fecha: '2026-10-18',
      hora: '4:10:41PM',
      latitud: 7.34655,
      longitud: -80.45809,
      profundidad: 5,
      magnitud: 4.1,
      region: 'Tonosí',
      estado: 'PRELIMINAR'
    }
  ];

  await assert.rejects(
    async () => {
      await syncEventsToSupabase(normalizeEvents(raw).normalized, supabase);
    },
    /Fallo consultando registros por UID en Supabase/i
  );
});

test('Error temporal en escritura de Supabase propaga la excepción limpiamente', async () => {
  const supabase = createMockSupabase();
  supabase.setFailUpsert(true);

  const raw = [
    {
      fecha: '2026-10-18',
      hora: '4:10:41PM',
      latitud: 7.34655,
      longitud: -80.45809,
      profundidad: 5,
      magnitud: 4.1,
      region: 'Tonosí',
      estado: 'PRELIMINAR'
    }
  ];

  await assert.rejects(
    async () => {
      await syncEventsToSupabase(normalizeEvents(raw).normalized, supabase);
    },
    /Fallo guardando lote en Supabase/i
  );
});

test('Variables de entorno faltantes arrojan error claro y seguro', async () => {
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_SECRET_KEY;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SECRET_KEY;

  try {
    await assert.rejects(
      async () => {
        await runArchival({
          sourcePayload: {
            eventos: [
              {
                fecha: '2026-10-18',
                hora: '4:10:41PM',
                latitud: 7.34655,
                longitud: -80.45809,
                profundidad: 5,
                magnitud: 4.1,
                region: 'Tonosí',
                estado: 'PRELIMINAR'
              }
            ]
          }
        });
      },
      /Configuración incompleta: SUPABASE_URL o SUPABASE_SECRET_KEY no están definidas/i
    );
  } finally {
    if (oldUrl) process.env.SUPABASE_URL = oldUrl;
    if (oldKey) process.env.SUPABASE_SECRET_KEY = oldKey;
  }
});

// --------------------------------------------------------------------------
// 5. Seguridad: Bloqueo Estricto de Peticiones HTTP Públicas
// --------------------------------------------------------------------------
test('Seguridad: peticiones HTTP públicas directas son bloqueadas con 403 Forbidden', async () => {
  const publicRequest = {
    httpMethod: 'GET',
    path: '/.netlify/functions/archivar-sismos',
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'host': 'sismospma.netlify.app'
    }
  };

  const response = await rawHandler(publicRequest, {});
  assert.equal(response.statusCode, 403, 'Debe devolver código 403 Forbidden');
  const body = JSON.parse(response.body);
  assert.equal(body.ok, false);
  assert.match(body.error, /Acceso denegado/i);
});

test('Seguridad: llamada legítima del planificador nativo de Netlify (sin httpMethod) es admitida', async () => {
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';

  try {
    // Invocación nativa por el planificador de Netlify
    const scheduledEvent = { next_run: '2026-10-18T23:00:00Z' };
    const response = await rawHandler(scheduledEvent, {});
    // No debe ser rechazado con 403
    assert.notEqual(response.statusCode, 403, 'No debe ser bloqueado con 403');
  } finally {
    if (oldUrl) process.env.SUPABASE_URL = oldUrl; else delete process.env.SUPABASE_URL;
    if (oldKey) process.env.SUPABASE_SECRET_KEY = oldKey; else delete process.env.SUPABASE_SECRET_KEY;
  }
});

test('Seguridad: llamada interna Netlify Run Now (x-nf-event: schedule) es admitida', async () => {
  const oldUrl = process.env.SUPABASE_URL;
  const oldKey = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';

  try {
    // Invocación interna desde el panel Netlify o Netlify CLI
    const netlifyEvent = {
      httpMethod: 'POST',
      headers: {
        'x-nf-event': 'schedule'
      }
    };
    const response = await rawHandler(netlifyEvent, {});
    // No debe ser rechazado con 403
    assert.notEqual(response.statusCode, 403, 'No debe ser bloqueado con 403');
  } finally {
    if (oldUrl) process.env.SUPABASE_URL = oldUrl; else delete process.env.SUPABASE_URL;
    if (oldKey) process.env.SUPABASE_SECRET_KEY = oldKey; else delete process.env.SUPABASE_SECRET_KEY;
  }
});
