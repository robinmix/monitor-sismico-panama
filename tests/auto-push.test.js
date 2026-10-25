'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Helper para crear un cliente Supabase simulado en memoria con soporte de restricciones de unicidad
function createMockSupabase(options = {}) {
  const sismosStore = new Map((options.sismos || []).map(s => [s.source_uid, { ...s }]));
  const subsStore = new Map((options.subs || []).map(s => [s.endpoint, { ...s }]));
  const initialNotif = options.isFirstActivation
    ? (options.notificaciones || [])
    : (options.notificaciones !== undefined
        ? options.notificaciones
        : [
            {
              source_uid: '__SYSTEM_PUSH_ACTIVATION__',
              endpoint: '__SYSTEM__',
              enviado_en: '2026-10-25T10:00:00.000Z'
            }
          ]);
  const notifStore = new Map(initialNotif.map(n => [`${n.source_uid}::${n.endpoint}`, { ...n }]));

  return {
    _sismos: sismosStore,
    _subs: subsStore,
    _notifStore: notifStore,
    get _notif() {
      const filtered = new Map();
      for (const [k, v] of notifStore.entries()) {
        if (!v.source_uid || !v.source_uid.startsWith('__SYSTEM_')) {
          filtered.set(k, v);
        }
      }
      return filtered;
    },
    from(table) {
      if (table === 'sismos') {
        return {
          select(fields) {
            return {
              async in(col, values) {
                const found = [];
                if (col === 'source_uid') {
                  for (const v of values) {
                    if (sismosStore.has(v)) found.push({ ...sismosStore.get(v) });
                  }
                } else if (col === 'fecha_hora') {
                  for (const v of values) {
                    for (const item of sismosStore.values()) {
                      if (item.fecha_hora === v) found.push({ ...item });
                    }
                  }
                }
                return { data: found, error: null };
              },
              async eq(col, val) {
                if (col === 'source_uid') {
                  const s = sismosStore.get(val);
                  return { data: s ? [{ ...s }] : [], error: null };
                }
                return { data: [], error: null };
              }
            };
          },
          async upsert(records, opts = {}) {
            for (const r of (Array.isArray(records) ? records : [records])) {
              sismosStore.set(r.source_uid, { ...r });
            }
            return { data: records, error: null };
          }
        };
      }

      if (table === 'push_subscriptions') {
        return {
          select(fields) {
            let offset = 0;
            let limitNum = 500;
            const chain = {
              order(col, opts = {}) { return chain; },
              range(from, to) {
                offset = from;
                limitNum = to - from + 1;
                return chain;
              },
              limit(n) {
                limitNum = n;
                return chain;
              },
              then(resolve, reject) {
                const rows = Array.from(subsStore.values()).slice(offset, offset + limitNum);
                resolve({ data: rows, error: null });
              },
              catch(reject) { return chain; }
            };
            return chain;
          },
          delete() {
            return {
              async eq(col, val) {
                if (col === 'endpoint') {
                  subsStore.delete(val);
                }
                return { error: null };
              }
            };
          },
          async upsert(records, opts = {}) {
            for (const r of (Array.isArray(records) ? records : [records])) {
              subsStore.set(r.endpoint, { ...r });
            }
            return { data: records, error: null };
          },
          update(updates) {
            return {
              async eq(col, val) {
                if (col === 'endpoint' && subsStore.has(val)) {
                  const existing = subsStore.get(val);
                  subsStore.set(val, { ...existing, ...updates });
                }
                return { data: null, error: null };
              }
            };
          }
        };
      }

      if (table === 'notificaciones_enviadas') {
        return {
          select(fields, selectOpts = {}) {
            let fUid = null;
            let fEndpoint = null;
            const chain = {
              eq(col, val) {
                if (col === 'source_uid') fUid = val;
                if (col === 'endpoint') fEndpoint = val;
                return chain;
              },
              then(resolve, reject) {
                const found = [];
                for (const n of notifStore.values()) {
                  if (fUid && n.source_uid !== fUid) continue;
                  if (fEndpoint && n.endpoint !== fEndpoint) continue;
                  found.push({ ...n });
                }
                resolve({ data: found, count: found.length, error: null });
              },
              catch(reject) {
                return chain;
              }
            };
            return chain;
          },
          update(updates) {
            let fUid = null;
            let fEndpoint = null;
            const chain = {
              eq(col, val) {
                if (col === 'source_uid') fUid = val;
                if (col === 'endpoint') fEndpoint = val;
                if (fUid && fEndpoint) {
                  const key = `${fUid}::${fEndpoint}`;
                  if (notifStore.has(key)) {
                    notifStore.set(key, { ...notifStore.get(key), ...updates });
                  }
                }
                return chain;
              },
              then(resolve) {
                resolve({ data: null, error: null });
              }
            };
            return chain;
          },
          async insert(record) {
            const r = Array.isArray(record) ? record[0] : record;
            const key = `${r.source_uid}::${r.endpoint}`;
            if (notifStore.has(key)) {
              return { data: null, error: { code: '23505', message: 'duplicate key violates unique constraint' } };
            }
            notifStore.set(key, { ...r });
            return { data: [r], error: null };
          },
          delete() {
            let fUid = null;
            let fEndpoint = null;
            const chain = {
              eq(col, val) {
                if (col === 'source_uid') fUid = val;
                if (col === 'endpoint') fEndpoint = val;
                if (fUid && fEndpoint) {
                  notifStore.delete(`${fUid}::${fEndpoint}`);
                }
                return chain;
              },
              then(resolve, reject) {
                if (fUid && fEndpoint) {
                  notifStore.delete(`${fUid}::${fEndpoint}`);
                }
                resolve({ error: null });
              },
              catch(reject) {
                return chain;
              }
            };
            return chain;
          },
          async upsert(records, opts = {}) {
            for (const r of (Array.isArray(records) ? records : [records])) {
              notifStore.set(`${r.source_uid}::${r.endpoint}`, { ...r });
            }
            return { data: records, error: null };
          }
        };
      }

      throw new Error(`Tabla desconocida en mock: ${table}`);
    }
  };
}

test('Suite Integral de Notificaciones Automáticas Web Push (Fase 2)', async (t) => {
  const {
    runArchival,
    syncEventsToSupabase,
    dispatchPushNotifications,
    sha256Hex
  } = await import('../cloudflare/lib/archivar-sismos.mjs');

  const workerMod = await import('../cloudflare/archivador/worker.mjs');
  const worker = workerMod.default;

  // Generar claves criptográficas efímeras para pruebas seguras
  const vapidKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const vapidJwk = await crypto.subtle.exportKey('jwk', vapidKeyPair.privateKey);
  const vapidPubRaw = await crypto.subtle.exportKey('raw', vapidKeyPair.publicKey);
  const vapidPubKeyB64 = Buffer.from(vapidPubRaw).toString('base64url');
  const vapidKeyHash = await sha256Hex(vapidPubKeyB64);

  // Generar claves de cliente de prueba
  const clientEcdh = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );
  const clientPubRaw = await crypto.subtle.exportKey('raw', clientEcdh.publicKey);
  const clientP256dh = Buffer.from(clientPubRaw).toString('base64url');
  const clientAuth = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');

  const defaultEnv = {
    AUTO_PUSH_ENABLED: 'true',
    VAPID_PUBLIC_KEY: vapidPubKeyB64,
    VAPID_PRIVATE_KEY_JWK: JSON.stringify(vapidJwk)
  };

  const sampleSubscriber = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/device_alpha_1',
    p256dh: clientP256dh,
    auth: clientAuth,
    vapid_key_hash: vapidKeyHash
  };

  // Mock global de fetch para interceptar envíos a FCM / Mozilla
  const originalFetch = globalThis.fetch;

  t.afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  await t.test('1. Nuevo sismo genuino (< 45 min): genera exactamente 1 notificación push estructurada', async () => {
    let pushPayloadSent = null;
    let pushEndpointSent = null;

    globalThis.fetch = async (url, opts) => {
      pushEndpointSent = url;
      pushPayloadSent = opts;
      return new Response('{}', { status: 201 });
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [sampleSubscriber]
    });

    const newEvent = {
      source_uid: 'igc_2026-10-25T11:55:00.000Z',
      source_event_id: 'IGC-20261025-065500AM',
      fecha_hora: '2026-10-25T11:55:00.000Z', // 5 minutos de antigüedad
      magnitud: 4.8,
      profundidad_km: 12,
      latitud: 8.23456,
      longitud: -82.45678,
      region: 'Chiriquí',
      ubicacion: 'Localizado en Panamá a 15km al norte de David',
      estado: 'REVISADO',
      fuente: 'IGC-UP'
    };

    const result = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, now);

    assert.equal(result.enviados, 1);
    assert.equal(result.sismosNotificados, 1);
    assert.equal(pushEndpointSent, sampleSubscriber.endpoint);
    assert.ok(pushPayloadSent.headers.Authorization.startsWith('vapid t='));
    assert.equal(pushPayloadSent.headers['Content-Encoding'], 'aes128gcm');

    // Comprobar reserva y confirmación en notificaciones_enviadas
    assert.equal(mockDb._notif.size, 1);
    const notifRow = mockDb._notif.get(`${newEvent.source_uid}::${sampleSubscriber.endpoint}`);
    assert.ok(notifRow);
    assert.equal(notifRow.source_uid, newEvent.source_uid);
  });

  await t.test('2. Sismo repetido en la siguiente corrida del cron: 0 notificaciones push', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('{}', { status: 201 });
    };

    const now = new Date('2026-10-25T12:01:00.000Z');
    const existingEvent = {
      source_uid: 'igc_2026-10-25T11:55:00.000Z',
      fecha_hora: '2026-10-25T11:55:00.000Z',
      magnitud: 4.8,
      profundidad_km: 12,
      latitud: 8.23456,
      longitud: -82.45678,
      estado: 'REVISADO',
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    const mockDb = createMockSupabase({
      sismos: [existingEvent],
      subs: [sampleSubscriber],
      notificaciones: [{ source_uid: existingEvent.source_uid, endpoint: sampleSubscriber.endpoint }]
    });

    const syncRes = await syncEventsToSupabase([existingEvent], mockDb, now);
    assert.equal(syncRes.nuevos, 0);
    assert.equal(syncRes.nuevosRecords.length, 0);
    assert.equal(syncRes.verificados, 1);

    const pushRes = await dispatchPushNotifications(syncRes.nuevosRecords, mockDb, defaultEnv, now);
    assert.equal(pushRes.enviados, 0);
    assert.equal(fetchCalls, 0);
  });

  await t.test('3. Revisión de sismo (PRELIMINAR -> REVISADO): actualiza registro pero NO notifica como nuevo', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('{}', { status: 201 });
    };

    const now = new Date('2026-10-25T12:05:00.000Z');
    const preliminaryDbEvent = {
      source_uid: 'igc_2026-10-25T11:55:00.000Z',
      fecha_hora: '2026-10-25T11:55:00.000Z',
      magnitud: 4.5,
      profundidad_km: 10,
      latitud: 8.23456,
      longitud: -82.45678,
      estado: 'PRELIMINAR',
      primera_captura: '2026-10-25T11:56:00.000Z'
    };

    const mockDb = createMockSupabase({
      sismos: [preliminaryDbEvent],
      subs: [sampleSubscriber]
    });

    const revisedIncomingEvent = {
      ...preliminaryDbEvent,
      magnitud: 4.7,
      profundidad_km: 14,
      estado: 'REVISADO'
    };

    const syncRes = await syncEventsToSupabase([revisedIncomingEvent], mockDb, now);
    assert.equal(syncRes.nuevos, 0);
    assert.equal(syncRes.nuevosRecords.length, 0);
    assert.equal(syncRes.actualizados, 1);

    const pushRes = await dispatchPushNotifications(syncRes.nuevosRecords, mockDb, defaultEnv, now);
    assert.equal(pushRes.enviados, 0);
    assert.equal(fetchCalls, 0);
  });

  await t.test('4. Lote histórico o arranque en frío (>6 sismos recientes o >45 min): 0 notificaciones (anti-ráfaga)', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('{}', { status: 201 });
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [sampleSubscriber]
    });

    // Caso A: Lote masivo de 7 eventos recientes (> 6)
    const massEvents = [1, 2, 3, 4, 5, 6, 7].map(i => ({
      source_uid: `igc_2026-10-25T11:5${i}:00.000Z`,
      fecha_hora: `2026-10-25T11:5${i}:00.000Z`,
      magnitud: 3.5,
      profundidad_km: 10,
      latitud: 8.0,
      longitud: -80.0
    }));

    const massRes = await dispatchPushNotifications(massEvents, mockDb, defaultEnv, now);
    assert.equal(massRes.enviados, 0);
    assert.equal(massRes.omitidosPorLoteMasivo, 7);
    assert.equal(fetchCalls, 0);

    // Caso B: Evento único pero con antigüedad > 45 minutos (ej. 3 horas antes)
    const oldEvent = {
      source_uid: 'igc_2026-10-25T09:00:00.000Z',
      fecha_hora: '2026-10-25T09:00:00.000Z',
      magnitud: 4.0,
      profundidad_km: 15,
      latitud: 8.0,
      longitud: -80.0
    };

    const oldRes = await dispatchPushNotifications([oldEvent], mockDb, defaultEnv, now);
    assert.equal(oldRes.enviados, 0);
    assert.equal(oldRes.omitidosPorAntiguedad, 1);
    assert.equal(fetchCalls, 0);
  });

  await t.test('5. Dos sismos genuinamente distintos en ventana de 1 minuto: ambos reciben notificación', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('{}', { status: 201 });
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [sampleSubscriber]
    });

    const twoEvents = [
      {
        source_uid: 'igc_2026-10-25T11:57:00.000Z',
        fecha_hora: '2026-10-25T11:57:00.000Z',
        magnitud: 4.2,
        profundidad_km: 10,
        latitud: 8.5,
        longitud: -82.4,
        ubicacion: 'Chiriquí'
      },
      {
        source_uid: 'igc_2026-10-25T11:58:00.000Z',
        fecha_hora: '2026-10-25T11:58:00.000Z',
        magnitud: 3.6,
        profundidad_km: 25,
        latitud: 7.8,
        longitud: -78.1,
        ubicacion: 'Darién'
      }
    ];

    const result = await dispatchPushNotifications(twoEvents, mockDb, defaultEnv, now);
    assert.equal(result.enviados, 2);
    assert.equal(result.sismosNotificados, 2);
    assert.equal(fetchCalls, 2);
    assert.equal(mockDb._notif.size, 2);
  });

  await t.test('6. Suscriptor expirado (HTTP 410 Gone) o clave inválida (HTTP 401): eliminado de push_subscriptions', async () => {
    globalThis.fetch = async () => {
      return new Response('{"error":"unregistered"}', { status: 410 });
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [sampleSubscriber]
    });

    const newEvent = {
      source_uid: 'igc_2026-10-25T11:55:00.000Z',
      fecha_hora: '2026-10-25T11:55:00.000Z',
      magnitud: 4.0,
      profundidad_km: 10,
      latitud: 8.0,
      longitud: -80.0
    };

    assert.equal(mockDb._subs.size, 1);
    const result = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, now);

    assert.equal(result.enviados, 0);
    // El suscriptor expirado debe haber sido eliminado de la tabla
    assert.equal(mockDb._subs.size, 0);
  });

  await t.test('7. Error transitorio de red: tolerado sin abortar y liberando reserva para reintento', async () => {
    const sub2 = {
      ...sampleSubscriber,
      endpoint: 'https://fcm.googleapis.com/fcm/send/device_beta_2'
    };

    globalThis.fetch = async (url) => {
      if (url.includes('device_alpha_1')) {
        throw new Error('Connection reset by peer');
      }
      return new Response('{}', { status: 201 });
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [sampleSubscriber, sub2]
    });

    const newEvent = {
      source_uid: 'igc_2026-10-25T11:55:00.000Z',
      fecha_hora: '2026-10-25T11:55:00.000Z',
      magnitud: 4.0,
      profundidad_km: 10,
      latitud: 8.0,
      longitud: -80.0
    };

    const result = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, now);

    // sub2 tuvo éxito a pesar de la falla en sub1
    assert.equal(result.enviados, 1);
    assert.ok(mockDb._notif.has(`${newEvent.source_uid}::${sub2.endpoint}`));
    // sub1 liberó su reserva para que la siguiente corrida pueda reintentarlo
    assert.ok(!mockDb._notif.has(`${newEvent.source_uid}::${sampleSubscriber.endpoint}`));
  });

  await t.test('8. Fuente IGC-UP vacía o con error: 0 alertas falsas', async () => {
    const mockDb = createMockSupabase({
      subs: [sampleSubscriber]
    });

    await assert.rejects(
      async () => {
        await runArchival({
          sourcePayload: { eventos: [] },
          supabase: mockDb,
          env: defaultEnv
        });
      },
      /La fuente oficial IGC-UP no devolvió registros sísmicos/
    );

    assert.equal(mockDb._notif.size, 0);
  });

  await t.test('9. Deduplicación por notificaciones_enviadas: evita notificaciones repetidas', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('{}', { status: 201 });
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const newEvent = {
      source_uid: 'igc_2026-10-25T11:55:00.000Z',
      fecha_hora: '2026-10-25T11:55:00.000Z',
      magnitud: 4.0,
      profundidad_km: 10,
      latitud: 8.0,
      longitud: -80.0
    };

    const mockDb = createMockSupabase({
      subs: [sampleSubscriber],
      notificaciones: [{ source_uid: newEvent.source_uid, endpoint: sampleSubscriber.endpoint }]
    });

    const result = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, now);
    assert.equal(result.enviados, 0);
    assert.equal(fetchCalls, 0);
  });

  await t.test('10. Flag AUTO_PUSH_ENABLED=false (o ausente): 0 envíos reales a dispositivos', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('{}', { status: 201 });
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [sampleSubscriber]
    });

    const newEvent = {
      source_uid: 'igc_2026-10-25T11:55:00.000Z',
      fecha_hora: '2026-10-25T11:55:00.000Z',
      magnitud: 4.0,
      profundidad_km: 10,
      latitud: 8.0,
      longitud: -80.0
    };

    const disabledEnv = { ...defaultEnv, AUTO_PUSH_ENABLED: 'false' };
    const result = await dispatchPushNotifications([newEvent], mockDb, disabledEnv, now);

    assert.equal(result.enviados, 0);
    assert.equal(result.omitidos, 'AUTO_PUSH_DISABLED');
    assert.equal(fetchCalls, 0);

    const emptyEnvResult = await dispatchPushNotifications([newEvent], mockDb, {}, now);
    assert.equal(emptyEnvResult.enviados, 0);
    assert.equal(emptyEnvResult.omitidos, 'AUTO_PUSH_DISABLED');
    assert.equal(fetchCalls, 0);
  });

  await t.test('11. Suscriptor con hash VAPID incompatible: excluido de envíos', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('{}', { status: 201 });
    };

    const incompatibleSubscriber = {
      ...sampleSubscriber,
      vapid_key_hash: 'hash_obsoleto_o_ajeno_1234567890abcdef'
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [incompatibleSubscriber]
    });

    const newEvent = {
      source_uid: 'igc_2026-10-25T11:55:00.000Z',
      fecha_hora: '2026-10-25T11:55:00.000Z',
      magnitud: 4.0,
      profundidad_km: 10,
      latitud: 8.0,
      longitud: -80.0
    };

    const result = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, now);
    assert.equal(result.enviados, 0);
    assert.equal(result.motivo, 'Sin suscripciones compatibles con la clave VAPID actual');
    assert.equal(fetchCalls, 0);
  });

  await t.test('12. Suscriptor desuscrito: no figura en la base de datos y no recibe alertas', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('{}', { status: 201 });
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: []
    });

    const newEvent = {
      source_uid: 'igc_2026-10-25T11:55:00.000Z',
      fecha_hora: '2026-10-25T11:55:00.000Z',
      magnitud: 4.0,
      profundidad_km: 10,
      latitud: 8.0,
      longitud: -80.0
    };

    const result = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, now);
    assert.equal(result.enviados, 0);
    assert.equal(result.motivo, 'Sin suscripciones activas');
    assert.equal(fetchCalls, 0);
  });

  await t.test('13. Concurrencia estricta: dos ejecuciones simultáneas envían EXACTAMENTE 1 notificación (cero duplicados)', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      // Simular latencia de red de 20ms
      await new Promise(r => setTimeout(r, 20));
      return new Response('{}', { status: 201 });
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [sampleSubscriber]
    });

    const concurrentEvent = {
      source_uid: 'igc_2026-10-25T11:55:00.000Z',
      fecha_hora: '2026-10-25T11:55:00.000Z',
      magnitud: 5.1,
      profundidad_km: 15,
      latitud: 7.2,
      longitud: -81.9,
      ubicacion: 'Golfo de Chiriquí'
    };

    // Lanzar dos instancias en paralelo simultáneo
    const [res1, res2] = await Promise.all([
      dispatchPushNotifications([concurrentEvent], mockDb, defaultEnv, now),
      dispatchPushNotifications([concurrentEvent], mockDb, defaultEnv, now)
    ]);

    // La suma de enviados entre ambas instancias debe ser exactamente 1
    assert.equal(res1.enviados + res2.enviados, 1);
    assert.equal(fetchCalls, 1, 'fetch fue llamado exactamente 1 vez por la exclusión mutua');
    assert.equal(mockDb._notif.size, 1);
  });

  await t.test('14. Enjambre sísmico real (4 eventos en 20 min): notifica los 3 de mayor magnitud sin descartar el enjambre', async () => {
    let notifiedTitles = [];
    globalThis.fetch = async (url, opts) => {
      return new Response('{}', { status: 201 });
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [sampleSubscriber]
    });

    const swarmEvents = [
      { source_uid: 'igc_swarm_1', fecha_hora: '2026-10-25T11:45:00.000Z', magnitud: 3.8, profundidad_km: 10, latitud: 8.1, longitud: -82.3 },
      { source_uid: 'igc_swarm_2', fecha_hora: '2026-10-25T11:50:00.000Z', magnitud: 4.9, profundidad_km: 12, latitud: 8.2, longitud: -82.4 }, // Principal
      { source_uid: 'igc_swarm_3', fecha_hora: '2026-10-25T11:52:00.000Z', magnitud: 4.1, profundidad_km: 10, latitud: 8.1, longitud: -82.3 },
      { source_uid: 'igc_swarm_4', fecha_hora: '2026-10-25T11:55:00.000Z', magnitud: 3.5, profundidad_km: 15, latitud: 8.1, longitud: -82.3 }
    ];

    const result = await dispatchPushNotifications(swarmEvents, mockDb, defaultEnv, now);

    // Debe despachar hasta 3 eventos priorizados por magnitud (M4.9, M4.1, M3.8), no 0
    assert.equal(result.enviados, 3);
    assert.equal(result.sismosNotificados, 3);
    assert.ok(mockDb._notif.has(`igc_swarm_2::${sampleSubscriber.endpoint}`)); // M4.9
    assert.ok(mockDb._notif.has(`igc_swarm_3::${sampleSubscriber.endpoint}`)); // M4.1
    assert.ok(mockDb._notif.has(`igc_swarm_1::${sampleSubscriber.endpoint}`)); // M3.8
  });

  await t.test('15. Prueba integral de Cloudflare Worker scheduled(): ejecuta ciclo completo aislado', async () => {
    let pushDispatched = false;
    globalThis.fetch = async (url) => {
      pushDispatched = true;
      return new Response('{}', { status: 201 });
    };

    const mockDb = createMockSupabase({
      subs: [sampleSubscriber]
    });

    const recentTs = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const simulatedIgcPayload = {
      eventos: [
        {
          fecha: '2026-10-25',
          hora: '6:50:00AM',
          timestamp: recentTs,
          latitud: 8.12345,
          longitud: -82.34567,
          profundidad: 11,
          magnitud: 4.6,
          region: 'Chiriquí a 10km al norte de David',
          estado: 'PRELIMINAR'
        }
      ]
    };

    const mockEnv = {
      SUPABASE_URL: 'https://mock.supabase.co',
      SUPABASE_SECRET_KEY: 'mock-secret',
      supabaseClient: mockDb,
      sourcePayload: simulatedIgcPayload,
      AUTO_PUSH_ENABLED: 'true',
      VAPID_PUBLIC_KEY: vapidPubKeyB64,
      VAPID_PRIVATE_KEY_JWK: JSON.stringify(vapidJwk)
    };

    let waitedPromise = null;
    const mockCtx = {
      waitUntil(p) {
        waitedPromise = p;
      }
    };

    // Invocar el manejador scheduled() del worker
    await worker.scheduled({}, mockEnv, mockCtx);
    assert.ok(waitedPromise, 'scheduled() debe registrar una promesa con ctx.waitUntil');

    const result = await waitedPromise;
    assert.equal(result.ok, true);
    assert.equal(result.nuevos, 1);
    assert.equal(result.push.enviados, 1);
    assert.equal(pushDispatched, true);
    assert.equal(mockDb._sismos.size, 1);
    assert.equal(mockDb._notif.size, 1);
  });
  await t.test('16. Suscriptor legado sin vapid_key_hash (NULL): excluido de envíos automáticos hasta renovación en la app', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('{}', { status: 201 });
    };

    const legacySubscriber = {
      ...sampleSubscriber,
      vapid_key_hash: null, // Suscripción histórica sin columna/hash
      failures: 0
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [legacySubscriber]
    });

    const newEvent = {
      source_uid: 'igc_2026-10-25T11:55:00.000Z',
      fecha_hora: '2026-10-25T11:55:00.000Z',
      magnitud: 4.1,
      profundidad_km: 15,
      latitud: 8.1,
      longitud: -80.1
    };

    const result = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, now);
    assert.equal(result.enviados, 0);
    assert.equal(result.motivo, 'Sin suscripciones compatibles con la clave VAPID actual');
    assert.equal(fetchCalls, 0);
    assert.equal(mockDb._notif.size, 0);
  });

  await t.test('17. Reintentos entre 2 ciclos cron consecutivos: fallo 503 en corrida 1 se reintenta y entrega en corrida 2 aun con sismo archivado', async () => {
    let pushAttempts = 0;
    globalThis.fetch = async () => {
      pushAttempts++;
      if (pushAttempts === 1) {
        // En la corrida 1 el proveedor push retorna 503 Service Unavailable
        return new Response('Service Unavailable', { status: 503 });
      }
      // En la corrida 2 el proveedor push se recupera
      return new Response('{}', { status: 201 });
    };

    const nowRun1 = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [{ ...sampleSubscriber, failures: 0 }]
    });

    const incomingFeed = {
      eventos: [
        {
          fecha: '2026-10-25',
          hora: '06:55:00', // 11:55 UTC (hace 5 min)
          latitud: 8.1234,
          longitud: -80.4567,
          profundidad: 12,
          magnitud: 4.5,
          estado: 'REVISADO',
          region: 'Panamá - Azuero'
        }
      ]
    };

    // CORRIDA 1: Sismo ingresa por primera vez. Supabase lo archiva como nuevo. Push intenta enviar pero falla con 503.
    const run1 = await runArchival({
      sourcePayload: incomingFeed,
      supabase: mockDb,
      env: defaultEnv,
      now: nowRun1
    });

    assert.equal(run1.nuevos, 1);
    assert.equal(run1.push.enviados, 0);
    assert.equal(pushAttempts, 1);
    // La reserva en notificaciones_enviadas fue liberada y failures incrementado a 1
    assert.equal(mockDb._notif.size, 0);
    assert.equal(mockDb._subs.get(sampleSubscriber.endpoint).failures, 1);

    // CORRIDA 2 (1 minuto después): Sismo sigue en el feed del IGC-UP. Ya está en Supabase (verificados: 1, nuevos: 0).
    const nowRun2 = new Date('2026-10-25T12:01:00.000Z');
    const run2 = await runArchival({
      sourcePayload: incomingFeed,
      supabase: mockDb,
      env: defaultEnv,
      now: nowRun2
    });

    assert.equal(run2.nuevos, 0);
    assert.equal(run2.verificados, 1);
    assert.equal(run2.push.enviados, 1);
    assert.equal(pushAttempts, 2);
    // Notificación entregada, reserva consolidada y contador de failures restablecido a 0
    assert.equal(mockDb._notif.size, 1);
    assert.equal(mockDb._subs.get(sampleSubscriber.endpoint).failures, 0);
  });

  await t.test('18. Deduplicación entre corridas consecutivas: sismo entregado en ciclo 1 no genera duplicados en ciclo 2', async () => {
    let pushAttempts = 0;
    globalThis.fetch = async () => {
      pushAttempts++;
      return new Response('{}', { status: 201 });
    };

    const nowRun1 = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [{ ...sampleSubscriber, failures: 0 }]
    });

    const incomingFeed = {
      eventos: [
        {
          fecha: '2026-10-25',
          hora: '06:58:00', // 11:58 UTC (hace 2 min)
          latitud: 7.95,
          longitud: -81.25,
          profundidad: 18,
          magnitud: 4.8,
          estado: 'REVISADO',
          region: 'Golfo de Montijo'
        }
      ]
    };

    // Ciclo 1: Envío exitoso
    const run1 = await runArchival({
      sourcePayload: incomingFeed,
      supabase: mockDb,
      env: defaultEnv,
      now: nowRun1
    });

    assert.equal(run1.nuevos, 1);
    assert.equal(run1.push.enviados, 1);
    assert.equal(pushAttempts, 1);
    assert.equal(mockDb._notif.size, 1);

    // Ciclo 2 (1 minuto después): No debe volver a notificar al mismo dispositivo
    const nowRun2 = new Date('2026-10-25T12:01:00.000Z');
    const run2 = await runArchival({
      sourcePayload: incomingFeed,
      supabase: mockDb,
      env: defaultEnv,
      now: nowRun2
    });

    assert.equal(run2.nuevos, 0);
    assert.equal(run2.verificados, 1);
    assert.equal(run2.push.enviados, 0);
    assert.equal(pushAttempts, 1); // Cero llamadas fetch adicionales
    assert.equal(mockDb._notif.size, 1);
  });

  await t.test('19. Tratamiento de HTTP 429 Too Many Requests: no marca como entregado, libera reserva e incrementa failures', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('Too Many Requests', { status: 429 });
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [{ ...sampleSubscriber, failures: 0 }]
    });

    const newEvent = {
      source_uid: 'igc_2026-10-25T11:52:00.000Z',
      fecha_hora: '2026-10-25T11:52:00.000Z',
      magnitud: 4.2,
      profundidad_km: 10,
      latitud: 8.5,
      longitud: -82.3
    };

    const result = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, now);
    assert.equal(result.enviados, 0);
    assert.equal(fetchCalls, 1);
    // Reserva liberada (no entregado) y fallo registrado
    assert.equal(mockDb._notif.size, 0);
    assert.equal(mockDb._subs.get(sampleSubscriber.endpoint).failures, 1);
  });

  await t.test('20. Límite de reintentos (circuit breaker): suscriptor con failures >= 3 es omitido de envíos automáticos', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('{}', { status: 201 });
    };

    const deadSubscriber = {
      ...sampleSubscriber,
      failures: 3 // Umbral máximo de fallos alcanzado
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [deadSubscriber]
    });

    const newEvent = {
      source_uid: 'igc_2026-10-25T11:56:00.000Z',
      fecha_hora: '2026-10-25T11:56:00.000Z',
      magnitud: 4.0,
      profundidad_km: 11,
      latitud: 8.3,
      longitud: -81.5
    };

    const result = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, now);
    assert.equal(result.enviados, 0);
    assert.equal(result.motivo, 'Sin suscripciones compatibles con la clave VAPID actual');
    assert.equal(fetchCalls, 0);
  });

  await t.test('21. Suscriptor permanente no válido (HTTP 404 Not Found): eliminado de push_subscriptions y reserva limpia', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('Not Found', { status: 404 });
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [{ ...sampleSubscriber, failures: 0 }]
    });

    const newEvent = {
      source_uid: 'igc_2026-10-25T11:57:00.000Z',
      fecha_hora: '2026-10-25T11:57:00.000Z',
      magnitud: 3.9,
      profundidad_km: 9,
      latitud: 8.4,
      longitud: -82.1
    };

    const result = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, now);
    assert.equal(result.enviados, 0);
    assert.equal(fetchCalls, 1);
    // Eliminado definitivamente de la base de datos
    assert.equal(mockDb._subs.size, 0);
    assert.equal(mockDb._notif.size, 0);
  });

  await t.test('22. Primera activación de Web Push con 1 a 6 sismos ya archivados en Supabase: cero notificaciones históricas', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('{}', { status: 201 });
    };

    const activationTime = new Date('2026-10-25T12:00:00.000Z');

    // 3 sismos existentes ya archivados en Supabase con primera_captura anterior a la activación
    const archivedEvents = [
      {
        source_uid: 'igc_hist_1',
        fecha_hora: '2026-10-25T11:35:00.000Z',
        magnitud: 4.8,
        latitud: 8.1,
        longitud: -80.1,
        profundidad_km: 12,
        primera_captura: '2026-10-25T11:36:00.000Z' // 24 min antes de activación
      },
      {
        source_uid: 'igc_hist_2',
        fecha_hora: '2026-10-25T11:45:00.000Z',
        magnitud: 4.2,
        latitud: 8.2,
        longitud: -80.2,
        profundidad_km: 15,
        primera_captura: '2026-10-25T11:46:00.000Z' // 14 min antes de activación
      },
      {
        source_uid: 'igc_hist_3',
        fecha_hora: '2026-10-25T11:55:00.000Z',
        magnitud: 3.9,
        latitud: 8.3,
        longitud: -80.3,
        profundidad_km: 10,
        primera_captura: '2026-10-25T11:56:00.000Z' // 4 min antes de activación
      }
    ];

    const mockDb = createMockSupabase({
      sismos: archivedEvents,
      subs: [sampleSubscriber],
      isFirstActivation: true
    });

    // Se activa AUTO_PUSH_ENABLED por primera vez
    const result = await dispatchPushNotifications(archivedEvents, mockDb, defaultEnv, activationTime);

    assert.equal(result.enviados, 0, 'No debe enviar notificaciones para sismos conocidos antes de la activación');
    assert.equal(result.omitidosHistoricosPreActivacion, 3, 'Los 3 eventos deben omitirse por ser históricos pre-activación');
    assert.equal(fetchCalls, 0, 'Cero peticiones de red al servicio push');
    // Hito de activación persistido en notificaciones_enviadas
    assert.ok(mockDb._notifStore.has('__SYSTEM_PUSH_ACTIVATION__::__SYSTEM__'));
  });

  await t.test('23. Evento nuevo posterior a la primera activación: se envía exitosamente y conserva reintentos cron', async () => {
    let pushAttempts = 0;
    globalThis.fetch = async () => {
      pushAttempts++;
      if (pushAttempts === 1) {
        return new Response('Gateway Timeout', { status: 504 }); // Falla transitoria en ciclo 1
      }
      return new Response('{}', { status: 201 }); // Éxito en ciclo 2
    };

    const activationTime = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [{ ...sampleSubscriber, failures: 0 }],
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: activationTime.toISOString()
        }
      ]
    });

    // Evento genuinamente nuevo capturado a las 12:05 (posterior a la activación de las 12:00)
    const newEvent = {
      source_uid: 'igc_post_act_1',
      fecha_hora: '2026-10-25T12:04:00.000Z',
      magnitud: 4.6,
      latitud: 8.25,
      longitud: -80.5,
      profundidad_km: 11,
      primera_captura: '2026-10-25T12:05:00.000Z'
    };

    // Ciclo 1: intento de despacho falla con 504
    const res1 = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, new Date('2026-10-25T12:05:00.000Z'));
    assert.equal(res1.enviados, 0);
    assert.equal(pushAttempts, 1);
    // Reserva liberada para reintento y fallo registrado
    assert.ok(!mockDb._notif.has('igc_post_act_1::' + sampleSubscriber.endpoint));

    // Ciclo 2 (1 min después): reintento legítimo conservado
    const res2 = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, new Date('2026-10-25T12:06:00.000Z'));
    assert.equal(res2.enviados, 1);
    assert.equal(pushAttempts, 2);
    assert.ok(mockDb._notif.has('igc_post_act_1::' + sampleSubscriber.endpoint));
    assert.equal(mockDb._subs.get(sampleSubscriber.endpoint).failures, 0);
  });

  await t.test('24. Alta de suscriptor posterior al evento: no recibe sismos capturados antes de su registro', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('{}', { status: 201 });
    };

    const eventTime = new Date('2026-10-25T12:00:00.000Z');
    const existingSubscriber = {
      ...sampleSubscriber,
      endpoint: 'https://fcm.googleapis.com/fcm/send/device_veteran_1',
      created_at: '2026-10-25T11:00:00.000Z' // Registrado 1 hora antes del evento
    };

    const newLateSubscriber = {
      ...sampleSubscriber,
      endpoint: 'https://fcm.googleapis.com/fcm/send/device_latecomer_2',
      created_at: '2026-10-25T12:05:00.000Z' // Registrado 5 minutos DESPUÉS del evento
    };

    const mockDb = createMockSupabase({
      subs: [existingSubscriber, newLateSubscriber],
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: '2026-10-25T10:00:00.000Z'
        }
      ]
    });

    const newEvent = {
      source_uid: 'igc_event_1200',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.4,
      latitud: 7.9,
      longitud: -81.0,
      profundidad_km: 14,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    // Cron se ejecuta a las 12:06 (después de que newLateSubscriber se registró a las 12:05)
    const result = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, new Date('2026-10-25T12:06:00.000Z'));

    assert.equal(result.enviados, 1, 'Solamente debe notificar al suscriptor preexistente');
    assert.equal(fetchCalls, 1);
    assert.ok(mockDb._notif.has('igc_event_1200::' + existingSubscriber.endpoint));
    assert.ok(!mockDb._notif.has('igc_event_1200::' + newLateSubscriber.endpoint), 'El nuevo suscriptor no debe recibir sismos anteriores');
  });

  await t.test('25. Circuit breaker: cabecera Retry-After de HTTP 429 activa cooldown y recupera automáticamente al cerrar circuito', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      if (fetchCalls === 1) {
        // Respuesta 429 con cabecera Retry-After: 120 (segundos)
        const headers = new Headers();
        headers.set('Retry-After', '120');
        return new Response('Rate Limited', { status: 429, headers });
      }
      return new Response('{}', { status: 201 });
    };

    const now0 = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [{ ...sampleSubscriber, failures: 0 }],
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: '2026-10-25T10:00:00.000Z'
        }
      ]
    });

    const newEvent = {
      source_uid: 'igc_event_circuit_1',
      fecha_hora: '2026-10-25T11:59:00.000Z',
      magnitud: 4.1,
      latitud: 8.1,
      longitud: -80.4,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    // 1. Intento inicial a las 12:00:00 -> Recibe 429 con Retry-After: 120
    const res1 = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, now0);
    assert.equal(res1.enviados, 0);
    assert.equal(fetchCalls, 1);

    const subAfter429 = mockDb._subs.get(sampleSubscriber.endpoint);
    assert.equal(subAfter429.failures, 1);
    assert.ok(subAfter429.retry_after, 'Debe establecer retry_after');
    assert.equal(new Date(subAfter429.retry_after).getTime(), now0.getTime() + 120000);

    // 2. Corrida cron 1 min después (12:01:00, dentro del cooldown de 120s): circuito ABIERTO, suscriptor omitido
    const now1min = new Date('2026-10-25T12:01:00.000Z');
    const res2 = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, now1min);
    assert.equal(res2.enviados, 0);
    assert.equal(fetchCalls, 1, 'No debe realizar llamadas fetch mientras el circuito está en cooldown');

    // 3. Corrida cron 3 min después (12:03:00, cooldown de 120s ya expiró): circuito HALF-OPEN -> reintento
    const now3min = new Date('2026-10-25T12:03:00.000Z');
    const res3 = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, now3min);
    assert.equal(res3.enviados, 1);
    assert.equal(fetchCalls, 2);

    // Circuito restablecido (CERRADO / saludable)
    const subRecovered = mockDb._subs.get(sampleSubscriber.endpoint);
    assert.equal(subRecovered.failures, 0);
    assert.equal(subRecovered.retry_after, null);
  });

  await t.test('26. Circuit breaker: backoff progresivo ante fallos consecutivos y resiliencia ante errores de Supabase', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('Internal Server Error', { status: 500 }); // Siempre falla
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [{ ...sampleSubscriber, failures: 2 }], // Ya acumulaba 2 fallos previos
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: '2026-10-25T10:00:00.000Z'
        }
      ]
    });

    const newEvent = {
      source_uid: 'igc_event_backoff_1',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.3,
      latitud: 8.0,
      longitud: -80.5,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    // Al llegar a 3 fallos sin cabecera Retry-After, aplica escalón de backoff (300 segundos = 5 minutos)
    const res = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, now);
    assert.equal(res.enviados, 0);
    assert.equal(fetchCalls, 1);

    const sub = mockDb._subs.get(sampleSubscriber.endpoint);
    assert.equal(sub.failures, 3);
    assert.ok(sub.retry_after);
    assert.equal(new Date(sub.retry_after).getTime(), now.getTime() + 300000);
  });

  await t.test('27. HTTP 401/403 VAPID Auth Error: NUNCA elimina la suscripción; aplica cooldown y preserva suscriptor', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      // Simulamos que el proveedor rechaza la cabecera VAPID por token expirado o desajuste de clave
      return new Response('{"error":"Invalid VAPID credentials"}', { status: 401 });
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [{ ...sampleSubscriber, failures: 0 }],
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: '2026-10-25T10:00:00.000Z'
        }
      ]
    });

    const newEvent = {
      source_uid: 'igc_event_401_test',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.5,
      latitud: 8.0,
      longitud: -80.0,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    const res = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, now);
    assert.equal(res.enviados, 0);
    assert.equal(fetchCalls, 1);

    // CRÍTICO: La suscripción NO fue eliminada (evita borrado masivo por problema VAPID global)
    assert.equal(mockDb._subs.size, 1);
    const sub = mockDb._subs.get(sampleSubscriber.endpoint);
    assert.equal(sub.failures, 1);
    assert.ok(sub.retry_after, 'Debe haber recibido cooldown para reintentar tras resolver VAPID');
    // Reserva en notificaciones_enviadas liberada
    assert.equal(mockDb._notif.size, 0);
  });

  await t.test('28. HTTP 500/502/503/504 Server Error: tratado como transitorio con cooldown sin eliminar la suscripción', async () => {
    const statusCodes = [500, 502, 503, 504];

    for (const code of statusCodes) {
      let fetchCalls = 0;
      globalThis.fetch = async () => {
        fetchCalls++;
        return new Response('Gateway Error', { status: code });
      };

      const now = new Date('2026-10-25T12:00:00.000Z');
      const mockDb = createMockSupabase({
        subs: [{ ...sampleSubscriber, failures: 0 }],
        notificaciones: [
          {
            source_uid: '__SYSTEM_PUSH_ACTIVATION__',
            endpoint: '__SYSTEM__',
            enviado_en: '2026-10-25T10:00:00.000Z'
          }
        ]
      });

      const newEvent = {
        source_uid: `igc_event_${code}_test`,
        fecha_hora: '2026-10-25T11:58:00.000Z',
        magnitud: 4.1,
        latitud: 8.1,
        longitud: -80.1,
        profundidad_km: 10,
        primera_captura: '2026-10-25T12:00:00.000Z'
      };

      const res = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, now);
      assert.equal(res.enviados, 0);
      assert.equal(fetchCalls, 1);
      assert.equal(mockDb._subs.size, 1, `Error HTTP ${code} no debe eliminar la suscripción`);
      assert.equal(mockDb._notif.size, 0, `Error HTTP ${code} debe liberar la reserva para reintento cron`);
      assert.equal(mockDb._subs.get(sampleSubscriber.endpoint).failures, 1);
    }
  });

  await t.test('29. Escalabilidad: 100 suscriptores procesados en lotes concurrentes rápidos sin demoras', async () => {
    let pushDeliveries = 0;
    globalThis.fetch = async () => {
      pushDeliveries++;
      return new Response('{}', { status: 201 });
    };

    const subs100 = [];
    for (let i = 1; i <= 100; i++) {
      subs100.push({
        ...sampleSubscriber,
        endpoint: `https://fcm.googleapis.com/fcm/send/device_bulk_${i}`,
        failures: 0
      });
    }

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: subs100,
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: '2026-10-25T10:00:00.000Z'
        }
      ]
    });

    const newEvent = {
      source_uid: 'igc_event_100_subs',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.9,
      latitud: 8.2,
      longitud: -80.2,
      profundidad_km: 12,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    const t0 = Date.now();
    const res = await dispatchPushNotifications([newEvent], mockDb, { ...defaultEnv, PUSH_MAX_SUBS_PER_CYCLE: 100 }, now);
    const duration = Date.now() - t0;

    assert.equal(res.enviados, 100);
    assert.equal(pushDeliveries, 100);
    assert.equal(mockDb._notif.size, 100);
    // Debe completarse rápidamente gracias a PUSH_CONCURRENCY
    assert.ok(duration < 2000, `100 suscripciones deben despacharse en menos de 2s (tomó ${duration}ms)`);
  });

  await t.test('30. Escalabilidad masiva: 1,000 suscriptores concurrentes procesados de forma segura', async () => {
    let pushDeliveries = 0;
    globalThis.fetch = async () => {
      pushDeliveries++;
      return new Response('{}', { status: 201 });
    };

    const subs1000 = [];
    for (let i = 1; i <= 1000; i++) {
      subs1000.push({
        ...sampleSubscriber,
        endpoint: `https://fcm.googleapis.com/fcm/send/device_mega_${i}`,
        failures: 0
      });
    }

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: subs1000,
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: '2026-10-25T10:00:00.000Z'
        }
      ]
    });

    const newEvent = {
      source_uid: 'igc_event_1000_subs',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 5.2,
      latitud: 8.3,
      longitud: -80.3,
      profundidad_km: 15,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    const res = await dispatchPushNotifications([newEvent], mockDb, { ...defaultEnv, PUSH_MAX_SUBS_PER_CYCLE: 500 }, now);

    assert.equal(res.enviados, 500, 'Debe despachar hasta el límite de 500 suscriptores por lote cron sin saturar');
    assert.equal(pushDeliveries, 500);
    assert.equal(mockDb._notif.size, 500);
  });

  await t.test('31. Fallback Supabase: columnas de circuit breaker no migradas (error 42703) degradan transparentemente', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('Too Many Requests', { status: 429 });
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const subsStore = new Map([[sampleSubscriber.endpoint, { ...sampleSubscriber, failures: 0 }]]);
    const notifStore = new Map([['__SYSTEM_PUSH_ACTIVATION__::__SYSTEM__', { source_uid: '__SYSTEM_PUSH_ACTIVATION__', endpoint: '__SYSTEM__', enviado_en: '2026-10-25T10:00:00.000Z' }]]);

    // Simulador Supabase que arroja 42703 (columna inexistente) si se intenta consultar o actualizar retry_after
    const mockDbUnmigrated = {
      _notif: notifStore,
      from(t) {
        if (t === 'notificaciones_enviadas') {
          return {
            select() {
              const chain = {
                eq() { return chain; },
                then(resolve) { resolve({ data: [{ source_uid: '__SYSTEM_PUSH_ACTIVATION__', endpoint: '__SYSTEM__', enviado_en: '2026-10-25T10:00:00.000Z' }], error: null }); }
              };
              return chain;
            },
            delete() {
              const chain = { eq() { return chain; } };
              return chain;
            },
            insert() { return { data: [], error: null }; }
          };
        }
        if (t === 'push_subscriptions') {
          return {
            select(fields) {
              return {
                async limit(n) {
                  if (fields.includes('retry_after')) {
                    return { data: null, error: { code: '42703', message: 'column retry_after does not exist' } };
                  }
                  return { data: Array.from(subsStore.values()).slice(0, n), error: null };
                }
              };
            },
            update(payload) {
              return {
                async eq(col, val) {
                  if (payload.retry_after !== undefined) {
                    return { data: null, error: { code: '42703', message: 'column retry_after does not exist' } };
                  }
                  if (subsStore.has(val)) {
                    subsStore.set(val, { ...subsStore.get(val), ...payload });
                  }
                  return { data: null, error: null };
                }
              };
            }
          };
        }
        if (t === 'sismos') {
          return { select() { return { eq() { return { data: [], error: null }; } }; } };
        }
        throw new Error('Tabla desconocida');
      }
    };

    const newEvent = {
      source_uid: 'igc_event_unmigrated_test',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.1,
      latitud: 8.0,
      longitud: -80.0,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    // No debe lanzar excepción, debe ejecutar fallback limpio
    const res = await dispatchPushNotifications([newEvent], mockDbUnmigrated, defaultEnv, now);
    assert.equal(res.enviados, 0);
    assert.equal(fetchCalls, 1);
    // El contador de fallos se actualizó exitosamente mediante el fallback
    assert.equal(subsStore.get(sampleSubscriber.endpoint).failures, 1);
  });

  await t.test('32. Retry-After con fecha HTTP RFC 7231 (ej. "Sun, 25 Oct 2026 12:02:00 GMT") parseado correctamente', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      const headers = new Headers();
      headers.set('Retry-After', 'Sun, 25 Oct 2026 12:02:00 GMT'); // Fecha absoluta a 120s en el futuro
      return new Response('Rate Limited', { status: 429, headers });
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [{ ...sampleSubscriber, failures: 0 }],
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: '2026-10-25T10:00:00.000Z'
        }
      ]
    });

    const newEvent = {
      source_uid: 'igc_event_http_date_test',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.3,
      latitud: 8.0,
      longitud: -80.0,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    const res = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, now);
    assert.equal(res.enviados, 0);
    assert.equal(fetchCalls, 1);

    const sub = mockDb._subs.get(sampleSubscriber.endpoint);
    assert.ok(sub.retry_after);
    assert.equal(new Date(sub.retry_after).getTime(), new Date('2026-10-25T12:02:00.000Z').getTime());
  });

  await t.test('33. Idempotencia y tolerancia de reinicio del Worker: eventos ya reservados o completados jamás se duplican', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('{}', { status: 201 });
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [{ ...sampleSubscriber, failures: 0 }],
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: '2026-10-25T10:00:00.000Z'
        },
        {
          // Simula que una ejecución anterior completó la entrega para este evento
          source_uid: 'igc_event_idempotency_1',
          endpoint: sampleSubscriber.endpoint,
          enviado_en: '2026-10-25T11:59:00.000Z'
        }
      ]
    });

    const event = {
      source_uid: 'igc_event_idempotency_1',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.2,
      latitud: 8.1,
      longitud: -80.1,
      profundidad_km: 10,
      primera_captura: '2026-10-25T11:59:00.000Z'
    };

    // Al reiniciar o correr en el siguiente cron, detecta que ya fue enviado
    const res = await dispatchPushNotifications([event], mockDb, defaultEnv, now);
    assert.equal(res.enviados, 0);
    assert.equal(fetchCalls, 0, 'Jamás debe llamar a fetch para un evento previamente entregado');
    assert.equal(mockDb._notif.size, 1);
  });

});
