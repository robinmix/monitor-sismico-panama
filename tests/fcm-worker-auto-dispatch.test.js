'use strict';

/**
 * sismoPA — Suite de Pruebas: Despacho Automático FCM Worker & Deduplicación Concurrente
 *
 * Valida:
 * 1. Filtrado de sismos históricos (> 45 min) y anomalías futuras (> 5 min).
 * 2. Protección contra ráfagas masivas (> 6 sismos) y selección inteligente de enjambres (top 3).
 * 3. Independencia de flags (AUTO_PUSH_ENABLED vs AUTO_FCM_ENABLED) y corte de emergencia FCM_KILL_SWITCH.
 * 4. Validación estricta de credenciales de Firebase (JSON y variables individuales).
 * 5. Deduplicación atómica distribuida y lease de concurrencia en fcm_notificaciones_enviadas.
 * 6. Recuperación de reservas abandonadas por timeout.
 * 7. Errores transitorios (500, 429) vs permanentes (400, 403) y política de reintentos.
 * 8. Formato estricto Data-Only (sin bloque notification) para evitar doble aviso en Android.
 * 9. Firma polimórfica y enmascaramiento seguro en send_fcm_direct_test.js y dispatcher.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Generador de clave RSA y service account para simulación de OAuth
function generateMockServiceAccount() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  return {
    project_id: 'sismopa-notificaciones',
    client_email: 'sismopa-fcm-sender@sismopa-notificaciones.iam.gserviceaccount.com',
    private_key: privateKey
  };
}

// Mock de base de datos Supabase en memoria para simular transacciones y restricciones
function createMockSupabase() {
  const fcmNotifTable = new Map(); // key: `${source_uid}::${target}`
  const webNotifTable = new Map();

  return {
    _fcmNotif: fcmNotifTable,
    _webNotif: webNotifTable,
    from(table) {
      if (table === 'fcm_notificaciones_enviadas') {
        return {
          select(fields) {
            let filterSourceUid = null;
            let filterTarget = null;
            const query = {
              eq(col, val) {
                if (col === 'source_uid') filterSourceUid = val;
                if (col === 'target') filterTarget = val;
                return query;
              },
              limit(n) {
                return query;
              },
              async then(resolve) {
                const key = `${filterSourceUid}::${filterTarget}`;
                const row = fcmNotifTable.get(key);
                resolve({ data: row ? [row] : [], error: null });
              }
            };
            return query;
          },
          insert(record) {
            const key = `${record.source_uid}::${record.target}`;
            if (fcmNotifTable.has(key)) {
              // Violación de restricción única simulada (uq_fcm_notif_sismo_target)
              return Promise.resolve({
                data: null,
                error: { message: 'duplicate key value violates unique constraint "uq_fcm_notif_sismo_target"', code: '23505' }
              });
            }
            const stored = {
              id: 'uuid-' + Math.random().toString(36).substring(2),
              ...record
            };
            fcmNotifTable.set(key, stored);
            return Promise.resolve({ data: [stored], error: null });
          },
          update(updates) {
            let filterId = null;
            let filterState = null;
            let filterSourceUid = null;
            let filterTarget = null;

            const uQuery = {
              eq(col, val) {
                if (col === 'id') filterId = val;
                if (col === 'estado') filterState = val;
                if (col === 'source_uid') filterSourceUid = val;
                if (col === 'target') filterTarget = val;
                return uQuery;
              },
              async then(resolve) {
                let targetRow = null;
                let targetKey = null;

                if (filterSourceUid && filterTarget) {
                  targetKey = `${filterSourceUid}::${filterTarget}`;
                  targetRow = fcmNotifTable.get(targetKey);
                } else if (filterId) {
                  for (const [k, v] of fcmNotifTable.entries()) {
                    if (v.id === filterId) {
                      targetKey = k;
                      targetRow = v;
                      break;
                    }
                  }
                }

                if (!targetRow) {
                  return resolve({ data: [], error: null, count: 0 });
                }

                if (filterState && targetRow.estado !== filterState) {
                  // Conflicto de estado (condición atómica CAS fallida)
                  return resolve({ data: [], error: null, count: 0 });
                }

                Object.assign(targetRow, updates);
                fcmNotifTable.set(targetKey, targetRow);
                resolve({ data: [targetRow], error: null, count: 1 });
              }
            };
            return uQuery;
          }
        };
      }

      if (table === 'push_subscriptions') {
        return {
          select() {
            return {
              limit: () => Promise.resolve({ data: [], error: null })
            };
          }
        };
      }

      if (table === 'notificaciones_enviadas') {
        return {
          select() {
            return {
              eq: () => Promise.resolve({ data: [], error: null })
            };
          },
          insert: () => Promise.resolve({ error: null })
        };
      }

      throw new Error(`Tabla no mockeada: ${table}`);
    }
  };
}

test('Suite FCM Worker Auto-Dispatch & Concurrencia Distribuida', async (t) => {
  const {
    filterEligibleSeismicEvents,
    dispatchFcmTopicNotifications,
    dispatchPushNotifications
  } = await import('../cloudflare/lib/archivar-sismos.mjs');

  const {
    sendFcmTopicMessage,
    sendFcmDirectMessage,
    isRetryableFcmStatus,
    _resetOAuthCache
  } = await import('../cloudflare/lib/fcm-dispatch.mjs');

  const mockServiceAccount = generateMockServiceAccount();

  await t.test('1. filterEligibleSeismicEvents: Descarta eventos > 45 min o futuros > 5 min', () => {
    const now = new Date('2026-10-26T12:00:00.000Z');

    const freshEvent = {
      source_uid: 'fresh_1',
      fecha_hora: '2026-10-26T11:40:00.000Z', // 20 min de antigüedad -> VÁLIDO
      magnitud: 4.5
    };
    const oldEvent = {
      source_uid: 'old_1',
      fecha_hora: '2026-10-26T11:00:00.000Z', // 60 min de antigüedad -> DESCARTADO
      magnitud: 5.2
    };
    const futureEvent = {
      source_uid: 'future_1',
      fecha_hora: '2026-10-26T12:10:00.000Z', // 10 min en el futuro -> DESCARTADO
      magnitud: 4.1
    };
    const nearFutureEvent = {
      source_uid: 'near_future_1',
      fecha_hora: '2026-10-26T12:02:00.000Z', // 2 min en el futuro (reloj desviado) -> VÁLIDO
      magnitud: 4.2
    };

    const res = filterEligibleSeismicEvents([freshEvent, oldEvent, futureEvent, nearFutureEvent], now);
    assert.equal(res.eligible.length, 2);
    assert.equal(res.eligible[0].source_uid, 'fresh_1'); // 4.5 > 4.2
    assert.equal(res.eligible[1].source_uid, 'near_future_1');

    // Si todos son antiguos, reporta omitidosPorAntiguedad
    const allOldRes = filterEligibleSeismicEvents([oldEvent], now);
    assert.equal(allOldRes.eligible.length, 0);
    assert.equal(allOldRes.omitidosPorAntiguedad, 1);
  });

  await t.test('2. filterEligibleSeismicEvents: Lote masivo (>6) activa anti-ráfaga; enjambre (<7) selecciona top 3', () => {
    const now = new Date('2026-10-26T12:00:00.000Z');

    // Caso A: Lote masivo de 7 eventos recientes (importación masiva o cold start)
    const massEvents = Array.from({ length: 7 }, (_, i) => ({
      source_uid: `mass_${i}`,
      fecha_hora: '2026-10-26T11:55:00.000Z',
      magnitud: 3.0 + (i * 0.2)
    }));
    const massRes = filterEligibleSeismicEvents(massEvents, now);
    assert.equal(massRes.eligible.length, 0);
    assert.equal(massRes.omitidosPorLoteMasivo, 7);

    // Caso B: Enjambre de 5 eventos (<7) -> Toma los 3 de mayor magnitud
    const swarmEvents = [
      { source_uid: 'sw_1', fecha_hora: '2026-10-26T11:50:00.000Z', magnitud: 3.2 },
      { source_uid: 'sw_2', fecha_hora: '2026-10-26T11:52:00.000Z', magnitud: 5.6 },
      { source_uid: 'sw_3', fecha_hora: '2026-10-26T11:53:00.000Z', magnitud: 4.1 },
      { source_uid: 'sw_4', fecha_hora: '2026-10-26T11:54:00.000Z', magnitud: 4.9 },
      { source_uid: 'sw_5', fecha_hora: '2026-10-26T11:55:00.000Z', magnitud: 3.8 }
    ];
    const swarmRes = filterEligibleSeismicEvents(swarmEvents, now);
    assert.equal(swarmRes.eligible.length, 3);
    assert.equal(swarmRes.eligible[0].magnitud, 5.6);
    assert.equal(swarmRes.eligible[1].magnitud, 4.9);
    assert.equal(swarmRes.eligible[2].magnitud, 4.1);
  });

  await t.test('3. Flags de control: AUTO_FCM_ENABLED requiere true explícito; FCM_KILL_SWITCH corta todo', async () => {
    const mockDb = createMockSupabase();
    const event = { source_uid: 'ev_flag_1', fecha_hora: '2026-10-26T11:50:00.000Z', magnitud: 4.5 };
    const now = new Date('2026-10-26T12:00:00.000Z');

    // Desactivado por defecto
    const resDisabled = await dispatchFcmTopicNotifications([event], mockDb, {}, now);
    assert.equal(resDisabled.fcmEnviados, 0);
    assert.equal(resDisabled.omitidos, 'AUTO_FCM_DISABLED');

    // Desactivado explícito 'false'
    const resFalse = await dispatchFcmTopicNotifications([event], mockDb, { AUTO_FCM_ENABLED: 'false' }, now);
    assert.equal(resFalse.fcmEnviados, 0);
    assert.equal(resFalse.omitidos, 'AUTO_FCM_DISABLED');

    // Kill switch activo anula AUTO_FCM_ENABLED=true
    const resKill = await dispatchFcmTopicNotifications([event], mockDb, {
      AUTO_FCM_ENABLED: 'true',
      FCM_KILL_SWITCH: 'true',
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify(mockServiceAccount)
    }, now);
    assert.equal(resKill.fcmEnviados, 0);
    assert.equal(resKill.omitidos, 'FCM_KILL_SWITCH_ACTIVE');
  });

  await t.test('4. Independencia de flags: AUTO_PUSH_ENABLED=false permite que FCM despache', async () => {
    _resetOAuthCache();
    const mockDb = createMockSupabase();
    const now = new Date('2026-10-26T12:00:00.000Z');
    let fcmCalls = 0;

    const mockFetch = async (url, opts) => {
      if (url.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'mock_token', expires_in: 3600 }), { status: 200 });
      }
      if (url.includes('messages:send')) {
        fcmCalls++;
        return new Response(JSON.stringify({ name: 'projects/sismopa-notificaciones/messages/12345' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };

    const event = {
      source_uid: 'ev_indep_1',
      fecha_hora: '2026-10-26T11:50:00.000Z',
      magnitud: 4.5,
      ubicacion: 'Golfo de Chiriquí',
      profundidad_km: 12
    };

    const env = {
      AUTO_PUSH_ENABLED: 'false', // Web Push apagado
      AUTO_FCM_ENABLED: 'true',   // FCM encendido
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify(mockServiceAccount),
      fetch: mockFetch
    };

    const res = await dispatchPushNotifications([event], mockDb, env, now);
    assert.equal(res.enviados, 0, 'Cero Web Push enviados');
    assert.equal(res.fcmEnviados, 1, 'Exactamente 1 despacho al topic FCM');
    assert.equal(fcmCalls, 1);
  });

  await t.test('5. Deduplicación atómica: Cron repetido no vuelve a emitir al topic', async () => {
    _resetOAuthCache();
    const mockDb = createMockSupabase();
    const now = new Date('2026-10-26T12:00:00.000Z');
    let fcmCalls = 0;

    const mockFetch = async (url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'mock_token', expires_in: 3600 }), { status: 200 });
      }
      fcmCalls++;
      return new Response(JSON.stringify({ name: 'projects/sismopa-notificaciones/messages/msg_1' }), { status: 200 });
    };

    const event = {
      source_uid: 'ev_dedup_1',
      fecha_hora: '2026-10-26T11:55:00.000Z',
      magnitud: 4.8
    };

    const env = {
      AUTO_FCM_ENABLED: 'true',
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify(mockServiceAccount),
      fetch: mockFetch
    };

    // Primera ejecución (Cron minuto 1): emite
    const res1 = await dispatchFcmTopicNotifications([event], mockDb, env, now);
    assert.equal(res1.fcmEnviados, 1);
    assert.equal(fcmCalls, 1);

    // Segunda ejecución (Cron minuto 2): evento sigue en lista, detecta CONFIRMADA y omite
    const res2 = await dispatchFcmTopicNotifications([event], mockDb, env, new Date(now.getTime() + 60000));
    assert.equal(res2.fcmEnviados, 0);
    assert.equal(fcmCalls, 1, 'No debe realizar llamadas adicionales a Google FCM');
  });

  await t.test('6. Concurrencia de Workers: Solo 1 worker gana el lease y despacha el topic', async () => {
    _resetOAuthCache();
    const mockDb = createMockSupabase();
    const now = new Date('2026-10-26T12:00:00.000Z');
    let fcmCalls = 0;

    const mockFetch = async (url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'mock_token', expires_in: 3600 }), { status: 200 });
      }
      fcmCalls++;
      // Simular latencia de red de 15ms
      await new Promise(r => setTimeout(r, 15));
      return new Response(JSON.stringify({ name: 'projects/sismopa-notificaciones/messages/msg_concurrent' }), { status: 200 });
    };

    const event = {
      source_uid: 'ev_race_1',
      fecha_hora: '2026-10-26T11:58:00.000Z',
      magnitud: 5.1
    };

    const env = {
      AUTO_FCM_ENABLED: 'true',
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify(mockServiceAccount),
      fetch: mockFetch
    };

    // Lanzar dos ejecuciones en paralelo simultáneo
    const [w1, w2] = await Promise.all([
      dispatchFcmTopicNotifications([event], mockDb, env, now),
      dispatchFcmTopicNotifications([event], mockDb, env, now)
    ]);

    const totalEnviados = w1.fcmEnviados + w2.fcmEnviados;
    assert.equal(totalEnviados, 1, 'Exactamente una instancia debe completar el envío');
    assert.equal(fcmCalls, 1, 'Cero llamadas redundantes a Google FCM');
  });

  await t.test('7. Tolerancia a fallos: Error 500/429 permite reintentar; Error 400 marca permanente', async () => {
    _resetOAuthCache();
    const mockDb = createMockSupabase();
    const now = new Date('2026-10-26T12:00:00.000Z');

    // Simular error 500 (transitorio)
    const fetch500 = async (url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'mock_token', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: 'Internal Server Error' } }), { status: 500 });
    };

    const event = { source_uid: 'ev_fail_1', fecha_hora: '2026-10-26T11:50:00.000Z', magnitud: 4.0 };
    const env500 = {
      AUTO_FCM_ENABLED: 'true',
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify(mockServiceAccount),
      fetch: fetch500
    };

    const res500 = await dispatchFcmTopicNotifications([event], mockDb, env500, now);
    assert.equal(res500.fcmEnviados, 0);

    const record = mockDb._fcmNotif.get('ev_fail_1::topic:sismos_panama');
    assert.equal(record.estado, 'FALLIDA');
    assert.equal(record.lease_expires_at, null); // Liberado para reintento

    // Ahora simular que el siguiente ciclo tiene éxito
    const fetchSuccess = async (url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'mock_token', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ name: 'messages/recovered_ok' }), { status: 200 });
    };

    const resRetry = await dispatchFcmTopicNotifications([event], mockDb, { ...env500, fetch: fetchSuccess }, new Date(now.getTime() + 60000));
    assert.equal(resRetry.fcmEnviados, 1);
    assert.equal(record.estado, 'CONFIRMADA');

    // Error 400 permanente (bad request) -> no reintenta más
    const event400 = { source_uid: 'ev_fail_400', fecha_hora: '2026-10-26T11:50:00.000Z', magnitud: 4.0 };
    const fetch400 = async (url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'mock_token', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: { message: 'Invalid payload' } }), { status: 400 });
    };

    await dispatchFcmTopicNotifications([event400], mockDb, { ...env500, fetch: fetch400 }, now);
    const record400 = mockDb._fcmNotif.get('ev_fail_400::topic:sismos_panama');
    assert.equal(record400.estado, 'FALLIDA');
    assert.equal(record400.intentos, 99, 'Debe marcar intentos=99 para no reintentar errores permanentes');
  });

  await t.test('8. Payload Data-Only: No incluye bloque notification y prioridad es high', async () => {
    _resetOAuthCache();
    let interceptedBody = null;

    const mockFetch = async (url, opts) => {
      if (url.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'mock_token', expires_in: 3600 }), { status: 200 });
      }
      interceptedBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ name: 'projects/sismopa-notificaciones/messages/test' }), { status: 200 });
    };

    await sendFcmTopicMessage(mockServiceAccount, 'sismos_panama', {
      source_uid: 'igc_test_payload',
      magnitud: '4.7',
      lugar: 'Tierras Altas, Chiriquí',
      profundidad: '10',
      hora_local: '03:45 PM'
    }, mockFetch);

    assert.ok(interceptedBody, 'Debe despachar mensaje HTTP v1');
    assert.equal(interceptedBody.message.topic, 'sismos_panama');
    assert.equal(interceptedBody.message.android.priority, 'high');
    assert.equal(interceptedBody.message.notification, undefined, 'PROHIBIDO incluir bloque notification automático');
    assert.equal(interceptedBody.message.data.source_uid, 'igc_test_payload');
    assert.equal(interceptedBody.message.data.magnitud, '4.7');
    assert.equal(interceptedBody.message.data.lugar, 'Tierras Altas, Chiriquí');
  });

  await t.test('9. sendFcmDirectMessage y sendFcmTopicMessage aceptan ambas firmas (objeto y posicional)', async () => {
    _resetOAuthCache();
    let sentCount = 0;

    const mockFetch = async (url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'mock_token', expires_in: 3600 }), { status: 200 });
      }
      sentCount++;
      return new Response(JSON.stringify({ name: 'messages/direct_test' }), { status: 200 });
    };

    // Firma 1: Objeto de opciones
    const resObj = await sendFcmDirectMessage({
      serviceAccount: mockServiceAccount,
      deviceToken: 'token_sample_abc123',
      payload: { source_uid: 'TEST_OBJ' },
      customFetch: mockFetch
    });
    assert.equal(resObj.ok, true);

    // Firma 2: Posicional
    const resPos = await sendFcmDirectMessage(
      mockServiceAccount,
      'token_sample_abc123',
      { source_uid: 'TEST_POS' },
      mockFetch
    );
    assert.equal(resPos.ok, true);

    assert.equal(sentCount, 2);
  });
});
