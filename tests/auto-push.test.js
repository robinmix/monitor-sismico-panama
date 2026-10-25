'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Helper para crear un cliente Supabase simulado en memoria con soporte de restricciones de unicidad
function createMockSupabase(options = {}) {
  const sismosStore = new Map((options.sismos || []).map(s => [s.source_uid, { ...s }]));
  const subsStore = new Map((options.subs || []).map(s => [s.endpoint, { ...s }]));
  const notifStore = new Map((options.notificaciones || []).map(n => [`${n.source_uid}::${n.endpoint}`, { ...n }]));

  return {
    _sismos: sismosStore,
    _subs: subsStore,
    _notif: notifStore,
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
            return {
              async limit(n) {
                const rows = Array.from(subsStore.values()).slice(0, n);
                return { data: rows, error: null };
              }
            };
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
          select(fields) {
            return {
              async eq(col, val) {
                if (col === 'source_uid') {
                  const found = [];
                  for (const n of notifStore.values()) {
                    if (n.source_uid === val) found.push({ ...n });
                  }
                  return { data: found, error: null };
                }
                return { data: [], error: null };
              }
            };
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

});
