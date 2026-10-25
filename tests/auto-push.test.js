'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Helper para crear un cliente Supabase simulado en memoria
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

  await t.test('1. Nuevo sismo genuino (< 30 min): genera exactamente 1 notificación push estructurada', async () => {
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

    // Comprobar registro en notificaciones_enviadas
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

    // Ingesta con el mismo evento ya existente
    const syncRes = await syncEventsToSupabase([existingEvent], mockDb, now);
    assert.equal(syncRes.nuevos, 0);
    assert.equal(syncRes.nuevosRecords.length, 0);
    assert.equal(syncRes.verificados, 1);

    // Si se pasa a despacho, se omiten por no haber nuevos registros
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

    // El evento revisado NO entra en la lista de nuevosRecords
    const pushRes = await dispatchPushNotifications(syncRes.nuevosRecords, mockDb, defaultEnv, now);
    assert.equal(pushRes.enviados, 0);
    assert.equal(fetchCalls, 0);
  });

  await t.test('4. Lote histórico o arranque en frío (>3 sismos o >30 min): 0 notificaciones (anti-ráfaga)', async () => {
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return new Response('{}', { status: 201 });
    };

    const now = new Date('2026-10-25T12:00:00.000Z');
    const mockDb = createMockSupabase({
      subs: [sampleSubscriber]
    });

    // Caso A: Lote masivo de 4 eventos nuevos (>3)
    const massEvents = [1, 2, 3, 4].map(i => ({
      source_uid: `igc_2026-10-25T11:5${i}:00.000Z`,
      fecha_hora: `2026-10-25T11:5${i}:00.000Z`,
      magnitud: 3.5,
      profundidad_km: 10,
      latitud: 8.0,
      longitud: -80.0
    }));

    const massRes = await dispatchPushNotifications(massEvents, mockDb, defaultEnv, now);
    assert.equal(massRes.enviados, 0);
    assert.equal(massRes.omitidosPorLoteMasivo, 4);
    assert.equal(fetchCalls, 0);

    // Caso B: Evento único pero con antigüedad > 30 minutos (ej. 2 horas antes)
    const oldEvent = {
      source_uid: 'igc_2026-10-25T09:00:00.000Z',
      fecha_hora: '2026-10-25T09:00:00.000Z', // 3 horas antes
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

  await t.test('6. Suscriptor expirado (HTTP 410 Gone): eliminado de push_subscriptions sin fallar', async () => {
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

  await t.test('7. Error transitorio de red o HTTP 503: tolerado limpiamente sin abortar el archivado', async () => {
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

    // sub2 tuvo éxito a pesar de la falla de red en sub1
    assert.equal(result.enviados, 1);
    assert.ok(mockDb._notif.has(`${newEvent.source_uid}::${sub2.endpoint}`));
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

    // Pre-insertar en notificaciones_enviadas
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

    // Entorno por defecto sin AUTO_PUSH_ENABLED o con false
    const disabledEnv = { ...defaultEnv, AUTO_PUSH_ENABLED: 'false' };
    const result = await dispatchPushNotifications([newEvent], mockDb, disabledEnv, now);

    assert.equal(result.enviados, 0);
    assert.equal(result.omitidos, 'AUTO_PUSH_DISABLED');
    assert.equal(fetchCalls, 0);

    // Entorno vacío
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
      subs: [] // Sin suscripciones activas
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
});
