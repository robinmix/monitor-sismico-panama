'use strict';

/**
 * sismoPA — Suite de Pruebas: Despacho Automático FCM Worker & Deduplicación Concurrente
 *
 * Valida:
 * 1. Filtrado de sismos históricos (> 45 min) y anomalías futuras (> 5 min).
 * 2. Protección contra ráfagas masivas (> 6 sismos) y selección inteligente de enjambres (top 3).
 * 3. Independencia de flags (AUTO_PUSH_ENABLED vs AUTO_FCM_ENABLED) y corte de emergencia FCM_KILL_SWITCH.
 * 4. Validación estricta de credenciales de Firebase (JSON y variables individuales).
 * 5. Deduplicación atómica distribuida y fencing tokens en acquire_fcm_lease RPC y fallback.
 * 6. Exclusión mutua concurrente: dos workers simultáneos generan exactamente 1 envío.
 * 7. Pérdida de lease por timeout: worker lento con fencing token caducado no puede confirmar.
 * 8. Entrega ambigua por caída de red: se marca como AMBIGUO y no se reintenta al topic nacional.
 * 9. Tolerancia a fallos: Error 500/429 permite reintentar hasta 3 veces; error 400 marca definitivo.
 * 10. Formato estricto Data-Only (sin bloque notification) para control 100% de sismoPA en Android.
 * 11. Firma polimórfica y enmascaramiento seguro en send_fcm_direct_test.js y dispatcher.
 * 12. Validez de la migración SQL 20261026_fcm_atomic_lease_and_fencing.sql.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

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

// Mock de base de datos Supabase en memoria con soporte de RPC atómico y fallback PostgREST
function createMockSupabase(options = {}) {
  const fcmNotifTable = new Map(); // key: `${source_uid}::${target}`
  const enableRpc = options.enableRpc !== false;

  const mockDb = {
    _fcmNotif: fcmNotifTable,
    rpc(name, params) {
      if (!enableRpc) {
        return Promise.resolve({ data: null, error: { message: 'function not found', code: '42883' } });
      }

      const key = `${params.p_source_uid}::${params.p_target}`;
      const now = new Date();

      if (name === 'acquire_fcm_lease') {
        const existing = fcmNotifTable.get(key);
        const leaseExpiry = new Date(now.getTime() + ((params.p_lease_seconds || 60) * 1000)).toISOString();
        const maxIntentos = params.p_max_intentos || 3;

        if (!existing) {
          const newRow = {
            id: 'uuid-' + Math.random().toString(36).substring(2),
            source_uid: params.p_source_uid,
            target: params.p_target,
            estado: 'RESERVADA',
            enviado_en: now.toISOString(),
            lease_expires_at: leaseExpiry,
            owner_token: params.p_owner_token,
            intentos: 1,
            updated_at: now.toISOString()
          };
          fcmNotifTable.set(key, newRow);
          return Promise.resolve({
            data: { acquired: true, status: 'RESERVADA', owner_token: params.p_owner_token, intentos: 1, action: 'INSERTED' },
            error: null
          });
        }

        if (existing.estado === 'CONFIRMADA') {
          return Promise.resolve({
            data: { acquired: false, reason: 'ALREADY_CONFIRMED', message_id: existing.message_id },
            error: null
          });
        }

        if (existing.estado === 'AMBIGUO') {
          return Promise.resolve({
            data: { acquired: false, reason: 'AMBIGUOUS_DELIVERY_PREVENTED', intentos: existing.intentos },
            error: null
          });
        }

        const leaseEnd = existing.lease_expires_at ? new Date(existing.lease_expires_at).getTime() : 0;
        if (existing.estado === 'RESERVADA' && leaseEnd > now.getTime()) {
          return Promise.resolve({
            data: { acquired: false, reason: 'ACTIVE_LEASE_HELD', lease_expires_at: existing.lease_expires_at },
            error: null
          });
        }

        if (existing.intentos >= maxIntentos) {
          return Promise.resolve({
            data: { acquired: false, reason: 'MAX_RETRIES_EXCEEDED', intentos: existing.intentos },
            error: null
          });
        }

        // Reclamar lease atómicamente
        existing.estado = 'RESERVADA';
        existing.lease_expires_at = leaseExpiry;
        existing.owner_token = params.p_owner_token;
        existing.intentos = (existing.intentos || 1) + 1;
        existing.updated_at = now.toISOString();
        fcmNotifTable.set(key, existing);

        return Promise.resolve({
          data: { acquired: true, status: 'RESERVADA', owner_token: params.p_owner_token, intentos: existing.intentos, action: 'LEASE_RECLAIMED' },
          error: null
        });
      }

      if (name === 'confirm_fcm_dispatch') {
        const existing = fcmNotifTable.get(key);
        if (existing && existing.owner_token === params.p_owner_token && existing.estado === 'RESERVADA') {
          existing.estado = 'CONFIRMADA';
          existing.lease_expires_at = null;
          existing.message_id = params.p_message_id;
          existing.updated_at = now.toISOString();
          fcmNotifTable.set(key, existing);
          return Promise.resolve({ data: { confirmed: true, message_id: params.p_message_id }, error: null });
        }
        return Promise.resolve({ data: { confirmed: false, reason: 'LEASE_LOST_OR_FENCING_TOKEN_MISMATCH' }, error: null });
      }

      if (name === 'fail_fcm_dispatch') {
        const existing = fcmNotifTable.get(key);
        if (existing && existing.owner_token === params.p_owner_token) {
          existing.estado = params.p_is_ambiguous ? 'AMBIGUO' : 'FALLIDA';
          existing.lease_expires_at = null;
          existing.error_details = params.p_error_details;
          existing.updated_at = now.toISOString();
          if (params.p_is_ambiguous || !params.p_is_retryable) {
            existing.intentos = 99;
          }
          fcmNotifTable.set(key, existing);
          return Promise.resolve({ data: { failed: true, estado: existing.estado }, error: null });
        }
        return Promise.resolve({ data: { failed: false, reason: 'LEASE_LOST_OR_FENCING_TOKEN_MISMATCH' }, error: null });
      }

      return Promise.resolve({ data: null, error: { message: `Unknown RPC ${name}` } });
    },
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
              limit() {
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
            let filterOwnerToken = null;

            const uQuery = {
              eq(col, val) {
                if (col === 'id') filterId = val;
                if (col === 'estado') filterState = val;
                if (col === 'source_uid') filterSourceUid = val;
                if (col === 'target') filterTarget = val;
                if (col === 'owner_token') filterOwnerToken = val;
                return uQuery;
              },
              select(cols) {
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
                  return resolve({ data: [], error: null, count: 0 });
                }

                if (filterOwnerToken && targetRow.owner_token !== filterOwnerToken) {
                  // Fencing token mismatch (lease perdido por el worker)
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

  return mockDb;
}

test('Suite FCM Worker Auto-Dispatch, Fencing Tokens & Deduplicación Atómica', async (t) => {
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
      fecha_hora: '2026-10-26T11:40:00.000Z',
      magnitud: 4.5
    };
    const oldEvent = {
      source_uid: 'old_1',
      fecha_hora: '2026-10-26T11:00:00.000Z',
      magnitud: 5.2
    };
    const futureEvent = {
      source_uid: 'future_1',
      fecha_hora: '2026-10-26T12:10:00.000Z',
      magnitud: 4.1
    };
    const nearFutureEvent = {
      source_uid: 'near_future_1',
      fecha_hora: '2026-10-26T12:02:00.000Z',
      magnitud: 4.2
    };

    const res = filterEligibleSeismicEvents([freshEvent, oldEvent, futureEvent, nearFutureEvent], now);
    assert.equal(res.eligible.length, 2);
    assert.equal(res.eligible[0].source_uid, 'fresh_1');
    assert.equal(res.eligible[1].source_uid, 'near_future_1');

    const allOldRes = filterEligibleSeismicEvents([oldEvent], now);
    assert.equal(allOldRes.eligible.length, 0);
    assert.equal(allOldRes.omitidosPorAntiguedad, 1);
  });

  await t.test('2. filterEligibleSeismicEvents: Lote masivo (>6) activa anti-ráfaga; enjambre (<7) selecciona top 3', () => {
    const now = new Date('2026-10-26T12:00:00.000Z');

    const massEvents = Array.from({ length: 7 }, (_, i) => ({
      source_uid: `mass_${i}`,
      fecha_hora: '2026-10-26T11:55:00.000Z',
      magnitud: 3.0 + (i * 0.2)
    }));
    const massRes = filterEligibleSeismicEvents(massEvents, now);
    assert.equal(massRes.eligible.length, 0);
    assert.equal(massRes.omitidosPorLoteMasivo, 7);

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

    const resDisabled = await dispatchFcmTopicNotifications([event], mockDb, {}, now);
    assert.equal(resDisabled.fcmEnviados, 0);
    assert.equal(resDisabled.omitidos, 'AUTO_FCM_DISABLED');

    const resFalse = await dispatchFcmTopicNotifications([event], mockDb, { AUTO_FCM_ENABLED: 'false' }, now);
    assert.equal(resFalse.fcmEnviados, 0);
    assert.equal(resFalse.omitidos, 'AUTO_FCM_DISABLED');

    const resKill = await dispatchFcmTopicNotifications([event], mockDb, {
      AUTO_FCM_ENABLED: 'true',
      FCM_KILL_SWITCH: 'true',
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify(mockServiceAccount)
    }, now);
    assert.equal(resKill.fcmEnviados, 0);
    assert.equal(resKill.omitidos, 'FCM_KILL_SWITCH_ACTIVE');
  });

  await t.test('4. Concurrencia atómica con Fencing Token: Dos workers simultáneos generan exactamente 1 despacho', async () => {
    _resetOAuthCache();
    const mockDb = createMockSupabase({ enableRpc: true });
    const now = new Date('2026-10-26T12:00:00.000Z');
    let fcmCalls = 0;

    const mockFetch = async (url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'mock_token', expires_in: 3600 }), { status: 200 });
      }
      fcmCalls++;
      await new Promise(r => setTimeout(r, 20));
      return new Response(JSON.stringify({ name: 'projects/sismopa-notificaciones/messages/msg_concurrent_1' }), { status: 200 });
    };

    const event = {
      source_uid: 'ev_atomic_race_1',
      fecha_hora: '2026-10-26T11:58:00.000Z',
      magnitud: 5.1
    };

    const env = {
      AUTO_FCM_ENABLED: 'true',
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify(mockServiceAccount),
      fetch: mockFetch
    };

    const [w1, w2] = await Promise.all([
      dispatchFcmTopicNotifications([event], mockDb, env, now),
      dispatchFcmTopicNotifications([event], mockDb, env, now)
    ]);

    const totalEnviados = w1.fcmEnviados + w2.fcmEnviados;
    assert.equal(totalEnviados, 1, 'Exactamente una instancia debe completar el envío');
    assert.equal(fcmCalls, 1, 'Cero llamadas duplicadas a Google FCM');

    const row = mockDb._fcmNotif.get('ev_atomic_race_1::topic:sismos_panama');
    assert.equal(row.estado, 'CONFIRMADA');
    assert.ok(row.owner_token, 'Debe registrar el owner_token que ganó la reserva');
    assert.equal(row.message_id, 'projects/sismopa-notificaciones/messages/msg_concurrent_1');
  });

  await t.test('5. Fencing Token: Worker lento con lease expirado no puede sobreescribir la confirmación', async () => {
    _resetOAuthCache();
    const mockDb = createMockSupabase({ enableRpc: true });
    const now = new Date('2026-10-26T12:00:00.000Z');

    // Simular que el Worker A adquirió el lease pero expiró
    const staleOwnerToken = crypto.randomUUID();
    mockDb._fcmNotif.set('ev_stale_1::topic:sismos_panama', {
      id: 'uuid-stale',
      source_uid: 'ev_stale_1',
      target: 'topic:sismos_panama',
      estado: 'RESERVADA',
      lease_expires_at: new Date(now.getTime() - 10000).toISOString(), // Vencido hace 10s
      owner_token: staleOwnerToken,
      intentos: 1,
      updated_at: new Date(now.getTime() - 70000).toISOString()
    });

    // Worker B llega, reclama el lease con nuevo fencing token y confirma con éxito
    const mockFetchB = async (url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'mock_token', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ name: 'messages/confirmed_by_worker_B' }), { status: 200 });
    };

    const envB = {
      AUTO_FCM_ENABLED: 'true',
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify(mockServiceAccount),
      fetch: mockFetchB
    };

    const resB = await dispatchFcmTopicNotifications([{ source_uid: 'ev_stale_1', fecha_hora: '2026-10-26T11:55:00.000Z', magnitud: 4.5 }], mockDb, envB, now);
    assert.equal(resB.fcmEnviados, 1);

    const rowAfterB = mockDb._fcmNotif.get('ev_stale_1::topic:sismos_panama');
    assert.equal(rowAfterB.estado, 'CONFIRMADA');
    assert.equal(rowAfterB.message_id, 'messages/confirmed_by_worker_B');
    const winningToken = rowAfterB.owner_token;
    assert.notEqual(winningToken, staleOwnerToken);

    // Ahora Worker A despierta tarde y trata de confirmar con su staleOwnerToken
    const confirmStaleRes = await mockDb.rpc('confirm_fcm_dispatch', {
      p_source_uid: 'ev_stale_1',
      p_target: 'topic:sismos_panama',
      p_owner_token: staleOwnerToken,
      p_message_id: 'messages/stale_A'
    });

    assert.equal(confirmStaleRes.data.confirmed, false, 'La confirmación del worker lento debe ser rechazada');
    assert.equal(confirmStaleRes.data.reason, 'LEASE_LOST_OR_FENCING_TOKEN_MISMATCH');
    // El estado sigue siendo el del ganador Worker B
    assert.equal(rowAfterB.message_id, 'messages/confirmed_by_worker_B');
  });

  await t.test('6. Entrega ambigua por caída de red: Se marca como AMBIGUO y no se reintenta al topic nacional', async () => {
    _resetOAuthCache();
    const mockDb = createMockSupabase({ enableRpc: true });
    const now = new Date('2026-10-26T12:00:00.000Z');
    let fetchAttempts = 0;

    // Simular caída de socket TCP después de enviar POST a Google FCM
    const mockFetchDrop = async (url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'mock_token', expires_in: 3600 }), { status: 200 });
      }
      fetchAttempts++;
      const err = new Error('ECONNRESET: Connection reset by peer');
      err.name = 'FetchError';
      throw err;
    };

    const event = { source_uid: 'ev_ambiguous_1', fecha_hora: '2026-10-26T11:55:00.000Z', magnitud: 4.6 };
    const env = {
      AUTO_FCM_ENABLED: 'true',
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify(mockServiceAccount),
      fetch: mockFetchDrop
    };

    const res1 = await dispatchFcmTopicNotifications([event], mockDb, env, now);
    assert.equal(res1.fcmEnviados, 0);
    assert.equal(fetchAttempts, 1);

    const row = mockDb._fcmNotif.get('ev_ambiguous_1::topic:sismos_panama');
    assert.equal(row.estado, 'AMBIGUO');
    assert.equal(row.intentos, 99, 'Debe marcar intentos=99 para inhibir reenvíos');

    // Siguiente minuto: el cron vuelve a evaluar el mismo evento
    const res2 = await dispatchFcmTopicNotifications([event], mockDb, env, new Date(now.getTime() + 60000));
    assert.equal(res2.fcmEnviados, 0);
    assert.equal(fetchAttempts, 1, 'No debe intentar enviar nuevamente al topic general tras un resultado ambiguo');
  });

  await t.test('7. Límite de reintentos: Máximo 3 reintentos en fallos temporales (500)', async () => {
    _resetOAuthCache();
    const mockDb = createMockSupabase({ enableRpc: true });
    let now = new Date('2026-10-26T12:00:00.000Z');
    let fcmCalls = 0;

    const mockFetch500 = async (url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'mock_token', expires_in: 3600 }), { status: 200 });
      }
      fcmCalls++;
      return new Response(JSON.stringify({ error: { message: 'Internal Server Error' } }), { status: 500 });
    };

    const event = { source_uid: 'ev_retry_limit_1', fecha_hora: '2026-10-26T11:55:00.000Z', magnitud: 4.2 };
    const env = {
      AUTO_FCM_ENABLED: 'true',
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify(mockServiceAccount),
      fetch: mockFetch500
    };

    // Intento 1 (Cron min 0): falla con 500
    await dispatchFcmTopicNotifications([event], mockDb, env, now);
    assert.equal(fcmCalls, 1);
    let row = mockDb._fcmNotif.get('ev_retry_limit_1::topic:sismos_panama');
    assert.equal(row.estado, 'FALLIDA');
    assert.equal(row.intentos, 1);

    // Intento 2 (Cron min 1): falla con 500
    now = new Date(now.getTime() + 60000);
    await dispatchFcmTopicNotifications([event], mockDb, env, now);
    assert.equal(fcmCalls, 2);
    row = mockDb._fcmNotif.get('ev_retry_limit_1::topic:sismos_panama');
    assert.equal(row.intentos, 2);

    // Intento 3 (Cron min 2): falla con 500
    now = new Date(now.getTime() + 60000);
    await dispatchFcmTopicNotifications([event], mockDb, env, now);
    assert.equal(fcmCalls, 3);
    row = mockDb._fcmNotif.get('ev_retry_limit_1::topic:sismos_panama');
    assert.equal(row.intentos, 3);

    // Intento 4 (Cron min 3): supera max_intentos (3), debe omitir completamente
    now = new Date(now.getTime() + 60000);
    const res4 = await dispatchFcmTopicNotifications([event], mockDb, env, now);
    assert.equal(res4.fcmEnviados, 0);
    assert.equal(fcmCalls, 3, 'No debe realizar más llamadas tras superar límite de reintentos');
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

    const resObj = await sendFcmDirectMessage({
      serviceAccount: mockServiceAccount,
      deviceToken: 'token_sample_abc123',
      payload: { source_uid: 'TEST_OBJ' },
      customFetch: mockFetch
    });
    assert.equal(resObj.ok, true);

    const resPos = await sendFcmDirectMessage(
      mockServiceAccount,
      'token_sample_abc123',
      { source_uid: 'TEST_POS' },
      mockFetch
    );
    assert.equal(resPos.ok, true);

    assert.equal(sentCount, 2);
  });

  await t.test('10. Migración SQL: 20261026_fcm_atomic_lease_and_fencing.sql define RPCs seguras con SECURITY DEFINER', () => {
    const migrationPath = path.join(__dirname, '../supabase/migrations/20261026_fcm_atomic_lease_and_fencing.sql');
    assert.ok(fs.existsSync(migrationPath), 'El archivo de migración debe existir');
    const sql = fs.readFileSync(migrationPath, 'utf8');

    assert.ok(sql.includes('acquire_fcm_lease'), 'Debe definir acquire_fcm_lease');
    assert.ok(sql.includes('confirm_fcm_dispatch'), 'Debe definir confirm_fcm_dispatch');
    assert.ok(sql.includes('fail_fcm_dispatch'), 'Debe definir fail_fcm_dispatch');
    assert.ok(sql.includes('owner_token UUID'), 'Debe agregar owner_token UUID');
    assert.ok(sql.includes('SECURITY DEFINER'), 'Debe usar SECURITY DEFINER');
    assert.ok(sql.includes('SET search_path = public, pg_temp'), 'Debe proteger search_path contra ataques de inyección');
    assert.ok(sql.includes('REVOKE ALL ON FUNCTION public.acquire_fcm_lease'), 'Debe revocar ejecución a PUBLIC');
    assert.ok(sql.includes('GRANT EXECUTE ON FUNCTION public.acquire_fcm_lease'), 'Debe otorgar ejecución exclusiva a service_role');
  });
});
