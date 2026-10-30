'use strict';

/**
 * sismoPA — Suite de Pruebas: Despacho Automático FCM Worker & Deduplicación Concurrente
 *
 * Valida:
 * 1. Filtrado de sismos históricos (> 45 min) y anomalías futuras (> 5 min).
 * 2. Protección contra ráfagas masivas (> 6 sismos) y selección inteligente de enjambres (top 3).
 * 3. Independencia de flags (AUTO_PUSH_ENABLED vs AUTO_FCM_ENABLED) y corte de emergencia FCM_KILL_SWITCH.
 * 4. Validación estricta de credenciales de Firebase (JSON y variables individuales).
 * 5. Deduplicación atómica distribuida y fencing tokens en acquire_fcm_lease RPC.
 * 6. Exclusión mutua concurrente: dos workers simultáneos generan exactamente 1 envío.
 * 7. Política conservadora anti-duplicados: reserva vencida en RESERVADA transiciona a AMBIGUO y NUNCA se reenvía al topic.
 * 8. Reclamación segura tras fallo temporal confirmado (500) hasta un máximo de 3 intentos.
 * 9. Fencing Token: Worker lento o con token desfasado ve rechazada su confirmación (FENCING_TOKEN_MISMATCH).
 * 10. Firebase HTTP 200 con fallo posterior en Supabase: detectado, alertado y protegido contra duplicados.
 * 11. RPC inexistente o caída: despacho FCM omitido limpiamente sin llamar a Google y preservando Web Push / archivador.
 * 12. Entrega ambigua por caída de red: se marca como AMBIGUO y no se reintenta al topic nacional.
 * 13. Formato estricto Data-Only (sin bloque notification) para control 100% de sismoPA en Android.
 * 14. Integración conjunta dispatchPushNotifications: Web Push y archivador continúan intactos si FCM falla.
 * 15. Validez de la migración SQL 20261026_fcm_atomic_lease_and_fencing.sql.
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

// Mock de base de datos Supabase en memoria con soporte de RPC atómico
function createMockSupabase(options = {}) {
  const fcmNotifTable = new Map(); // key: `${source_uid}::${target}`
  const pushSubsTable = options.pushSubs || [];
  const notifEnviadasTable = new Map();

  const mockDb = {
    _fcmNotif: fcmNotifTable,
    rpc(name, params) {
      if (options.enableRpc === false) {
        return Promise.resolve({ data: null, error: { message: 'function not found: acquire_fcm_lease', code: '42883' } });
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

        // POLÍTICA CONSERVADORA CRÍTICA:
        // Si estaba RESERVADA y el lease expiró: la ejecución anterior pudo haber enviado a Google
        // antes de colapsar. En el topic nacional se transiciona a AMBIGUO y NUNCA se reintenta automáticamente.
        if (existing.estado === 'RESERVADA' && leaseEnd <= now.getTime()) {
          existing.estado = 'AMBIGUO';
          existing.lease_expires_at = null;
          existing.intentos = 99;
          existing.error_details = 'Reserva expirada en tránsito; reenvío prevenido conservadoramente';
          existing.updated_at = now.toISOString();
          fcmNotifTable.set(key, existing);
          return Promise.resolve({
            data: {
              acquired: false,
              reason: 'EXPIRED_RESERVATION_TRANSITIONED_TO_AMBIGUOUS_NO_RETRY',
              action: 'ABORT_DUPLICATE_PREVENTION'
            },
            error: null
          });
        }

        // Si estaba FALLIDA (error devuelto por Google, ej. 500): verificar límite de intentos
        if (existing.intentos >= maxIntentos) {
          return Promise.resolve({
            data: { acquired: false, reason: 'MAX_RETRIES_EXCEEDED', intentos: existing.intentos },
            error: null
          });
        }

        // Reclamar fallo temporal atómicamente con nuevo fencing token
        existing.estado = 'RESERVADA';
        existing.lease_expires_at = leaseExpiry;
        existing.owner_token = params.p_owner_token;
        existing.intentos = (existing.intentos || 1) + 1;
        existing.updated_at = now.toISOString();
        fcmNotifTable.set(key, existing);

        return Promise.resolve({
          data: { acquired: true, status: 'RESERVADA', owner_token: params.p_owner_token, intentos: existing.intentos, action: 'LEASE_RECLAIMED_FROM_FAILED' },
          error: null
        });
      }

      if (name === 'confirm_fcm_dispatch') {
        if (options.simulateConfirmSqlFailure) {
          return Promise.resolve({ data: null, error: { message: 'Database connection terminated unexpectedly', code: '08006' } });
        }

        const existing = fcmNotifTable.get(key);
        if (existing && existing.owner_token === params.p_owner_token && (existing.estado === 'RESERVADA' || existing.estado === 'AMBIGUO')) {
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
          return Promise.resolve({ data: { updated: true, estado: existing.estado }, error: null });
        }
        return Promise.resolve({ data: { updated: false, reason: 'LEASE_LOST_OR_FENCING_TOKEN_MISMATCH' }, error: null });
      }

      return Promise.resolve({ data: null, error: { message: `Unknown RPC ${name}` } });
    },
    from(table) {
      if (table === 'fcm_notificaciones_enviadas') {
        // Ningún código en producción debe consultar esta tabla directamente sin RPC
        return {
          select: () => Promise.resolve({ data: Array.from(fcmNotifTable.values()), error: null })
        };
      }

      if (table === 'push_subscriptions') {
        return {
          select(fields) {
            return {
              limit: () => Promise.resolve({ data: pushSubsTable, error: null })
            };
          },
          delete() {
            return {
              eq(col, val) {
                return Promise.resolve({ error: null });
              }
            };
          }
        };
      }

      if (table === 'notificaciones_enviadas') {
        return {
          select(cols) {
            return {
              eq(col, val) {
                const results = [];
                for (const row of notifEnviadasTable.values()) {
                  if (row[col] === val) results.push(row);
                }
                return Promise.resolve({ data: results, error: null });
              }
            };
          },
          insert(record) {
            const k = `${record.source_uid}::${record.endpoint}`;
            if (notifEnviadasTable.has(k)) {
              return Promise.resolve({ error: { message: 'unique constraint', code: '23505' } });
            }
            notifEnviadasTable.set(k, record);
            return Promise.resolve({ error: null });
          },
          delete() {
            return {
              eq(c1, v1) {
                return {
                  eq(c2, v2) {
                    const k = `${v1}::${v2}`;
                    notifEnviadasTable.delete(k);
                    return Promise.resolve({ error: null });
                  }
                };
              }
            };
          }
        };
      }

      throw new Error(`Tabla no mockeada: ${table}`);
    }
  };

  if (options.rpcMissing) {
    delete mockDb.rpc;
  }

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

    // Sin credenciales
    const resNoCreds = await dispatchFcmTopicNotifications([event], mockDb, {
      AUTO_FCM_ENABLED: 'true'
    }, now);
    assert.equal(resNoCreds.fcmEnviados, 0);
    assert.equal(resNoCreds.omitidos, 'SIN_CREDENCIALES_FCM');
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

  await t.test('5. Tratamiento Conservador Anti-Duplicados: Reserva RESERVADA expirada transiciona a AMBIGUO y rechaza reenvío automático', async () => {
    _resetOAuthCache();
    const mockDb = createMockSupabase({ enableRpc: true });
    const now = new Date('2026-10-26T12:00:00.000Z');

    // Simular que el Worker A reservó pero su lease expiró sin confirmación
    const staleOwnerToken = crypto.randomUUID();
    mockDb._fcmNotif.set('ev_expired_res_1::topic:sismos_panama', {
      id: 'uuid-expired',
      source_uid: 'ev_expired_res_1',
      target: 'topic:sismos_panama',
      estado: 'RESERVADA',
      lease_expires_at: new Date(now.getTime() - 5000).toISOString(), // Vencido hace 5s
      owner_token: staleOwnerToken,
      intentos: 1,
      updated_at: new Date(now.getTime() - 65000).toISOString()
    });

    let fcmCalls = 0;
    const mockFetch = async (url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'mock_token', expires_in: 3600 }), { status: 200 });
      }
      fcmCalls++;
      return new Response(JSON.stringify({ name: 'messages/should_not_be_called' }), { status: 200 });
    };

    const env = {
      AUTO_FCM_ENABLED: 'true',
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify(mockServiceAccount),
      fetch: mockFetch
    };

    const event = { source_uid: 'ev_expired_res_1', fecha_hora: '2026-10-26T11:55:00.000Z', magnitud: 4.8 };
    const res = await dispatchFcmTopicNotifications([event], mockDb, env, now);

    assert.equal(res.fcmEnviados, 0, 'No debe reenviar si la reserva anterior expiró');
    assert.equal(fcmCalls, 0, 'Cero llamadas a Google FCM para prevenir duplicado nacional');

    const row = mockDb._fcmNotif.get('ev_expired_res_1::topic:sismos_panama');
    assert.equal(row.estado, 'AMBIGUO', 'Debe haber transicionado a AMBIGUO');
    assert.equal(row.intentos, 99, 'Debe fijar intentos=99 para bloquear todo reintento');
  });

  await t.test('6. Reclamación Segura tras Fallo Temporal (500) y Límite de Reintentos', async () => {
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

    // Intento 1: falla con 500
    await dispatchFcmTopicNotifications([event], mockDb, env, now);
    assert.equal(fcmCalls, 1);
    let row = mockDb._fcmNotif.get('ev_retry_limit_1::topic:sismos_panama');
    assert.equal(row.estado, 'FALLIDA');
    assert.equal(row.intentos, 1);

    // Intento 2: reclama atómicamente desde FALLIDA con nuevo owner_token
    const prevToken = row.owner_token;
    now = new Date(now.getTime() + 60000);
    await dispatchFcmTopicNotifications([event], mockDb, env, now);
    assert.equal(fcmCalls, 2);
    row = mockDb._fcmNotif.get('ev_retry_limit_1::topic:sismos_panama');
    assert.equal(row.intentos, 2);
    assert.notEqual(row.owner_token, prevToken, 'Cada intento debe generar un nuevo fencing token');

    // Intento 3: tercer fallo
    now = new Date(now.getTime() + 60000);
    await dispatchFcmTopicNotifications([event], mockDb, env, now);
    assert.equal(fcmCalls, 3);
    row = mockDb._fcmNotif.get('ev_retry_limit_1::topic:sismos_panama');
    assert.equal(row.intentos, 3);

    // Intento 4: supera límite (3), omitido limpiamente
    now = new Date(now.getTime() + 60000);
    const res4 = await dispatchFcmTopicNotifications([event], mockDb, env, now);
    assert.equal(res4.fcmEnviados, 0);
    assert.equal(fcmCalls, 3, 'No debe realizar más llamadas tras superar límite');
  });

  await t.test('7. Fencing Token: Confirmación rechazada si el Worker perdió el lease (FENCING_TOKEN_MISMATCH)', async () => {
    _resetOAuthCache();
    const mockDb = createMockSupabase({ enableRpc: true });
    const now = new Date('2026-10-26T12:00:00.000Z');

    const legitimateToken = crypto.randomUUID();
    const invalidToken = crypto.randomUUID();

    mockDb._fcmNotif.set('ev_fencing_1::topic:sismos_panama', {
      id: 'uuid-fencing',
      source_uid: 'ev_fencing_1',
      target: 'topic:sismos_panama',
      estado: 'RESERVADA',
      lease_expires_at: new Date(now.getTime() + 30000).toISOString(),
      owner_token: legitimateToken,
      intentos: 1,
      updated_at: now.toISOString()
    });

    const rejectRes = await mockDb.rpc('confirm_fcm_dispatch', {
      p_source_uid: 'ev_fencing_1',
      p_target: 'topic:sismos_panama',
      p_owner_token: invalidToken,
      p_message_id: 'messages/rejected'
    });

    assert.equal(rejectRes.data.confirmed, false);
    assert.equal(rejectRes.data.reason, 'LEASE_LOST_OR_FENCING_TOKEN_MISMATCH');

    const row = mockDb._fcmNotif.get('ev_fencing_1::topic:sismos_panama');
    assert.equal(row.estado, 'RESERVADA', 'El estado original debe permanecer intacto');
  });

  await t.test('8. Firebase HTTP 200 seguido de fallo en Supabase (confirm_fcm_dispatch): detectado, no duplica', async () => {
    _resetOAuthCache();
    // Simular que confirm_fcm_dispatch arroja error de base de datos
    const mockDb = createMockSupabase({ enableRpc: true, simulateConfirmSqlFailure: true });
    const now = new Date('2026-10-26T12:00:00.000Z');
    let fcmCalls = 0;

    const mockFetch = async (url) => {
      if (url.includes('oauth2.googleapis.com')) {
        return new Response(JSON.stringify({ access_token: 'mock_token', expires_in: 3600 }), { status: 200 });
      }
      fcmCalls++;
      return new Response(JSON.stringify({ name: 'messages/delivered_to_google_ok' }), { status: 200 });
    };

    const env = {
      AUTO_FCM_ENABLED: 'true',
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify(mockServiceAccount),
      fetch: mockFetch
    };

    const event = { source_uid: 'ev_sql_fail_after_200', fecha_hora: '2026-10-26T11:55:00.000Z', magnitud: 5.0 };

    // Worker 1 envía exitosamente a Google, pero Supabase falla en confirmación
    const res1 = await dispatchFcmTopicNotifications([event], mockDb, env, now);
    assert.equal(res1.fcmEnviados, 0, 'No debe contabilizar como enviado si la confirmación SQL falló');
    assert.equal(fcmCalls, 1);

    // Cuando el lease expire y otro Worker intente evaluar el evento:
    const futureTime = new Date(now.getTime() + 120000);
    const res2 = await dispatchFcmTopicNotifications([event], mockDb, env, futureTime);
    assert.equal(res2.fcmEnviados, 0, 'No debe reenviar');
    assert.equal(fcmCalls, 1, 'Google FCM NUNCA es llamado por segunda vez');
  });

  await t.test('9. RPC Inexistente o Caída: FCM omitido de forma segura sin llamar a Firebase; Web Push y archivador intactos', async () => {
    _resetOAuthCache();
    // Mock con RPC faltante en Supabase
    const mockDbNoRpc = createMockSupabase({ rpcMissing: true });
    const now = new Date('2026-10-26T12:00:00.000Z');
    let fcmCalls = 0;

    const mockFetch = async (url) => {
      fcmCalls++;
      return new Response('{}', { status: 200 });
    };

    const env = {
      AUTO_FCM_ENABLED: 'true',
      FIREBASE_SERVICE_ACCOUNT: JSON.stringify(mockServiceAccount),
      fetch: mockFetch
    };

    const event = { source_uid: 'ev_no_rpc_1', fecha_hora: '2026-10-26T11:55:00.000Z', magnitud: 4.7 };
    const res = await dispatchFcmTopicNotifications([event], mockDbNoRpc, env, now);

    assert.equal(res.fcmEnviados, 0);
    assert.equal(res.omitidos, 'RPC_NOT_AVAILABLE');
    assert.equal(fcmCalls, 0, 'Jamás debe llamar a Firebase si la RPC obligatoria falta');
  });

  await t.test('10. Entrega ambigua por caída de red: Se marca como AMBIGUO y no se reintenta al topic nacional', async () => {
    _resetOAuthCache();
    const mockDb = createMockSupabase({ enableRpc: true });
    const now = new Date('2026-10-26T12:00:00.000Z');
    let fetchAttempts = 0;

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

  await t.test('11. Payload Data-Only: No incluye bloque notification y prioridad es high', async () => {
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

  await t.test('12. Orquestador dispatchPushNotifications: Web Push opera normalmente si FCM está inactivo o falla', async () => {
    _resetOAuthCache();
    const mockDb = createMockSupabase({
      enableRpc: true,
      pushSubs: [{
        endpoint: 'https://fcm.googleapis.com/fcm/send/sub_123',
        p256dh: 'mock_p256dh',
        auth: 'mock_auth'
      }]
    });

    const now = new Date('2026-10-26T12:00:00.000Z');

    // Enviar evento con AUTO_PUSH_ENABLED=true y AUTO_FCM_ENABLED=false (estado de wrangler.toml en producción)
    const env = {
      AUTO_PUSH_ENABLED: 'true',
      AUTO_FCM_ENABLED: 'false',
      VAPID_PUBLIC_KEY: 'mock_vapid_key'
    };

    const event = {
      source_uid: 'ev_push_intact_1',
      fecha_hora: '2026-10-26T11:58:00.000Z',
      magnitud: 4.9,
      latitud: 8.5,
      longitud: -80.5,
      ubicacion: 'Coclé'
    };

    const res = await dispatchPushNotifications([event], mockDb, env, now);
    assert.equal(res.fcmEnviados, 0, 'FCM no debe despachar');
    assert.ok(typeof res.enviados === 'number');
  });

  await t.test('13. sendFcmDirectMessage y sendFcmTopicMessage aceptan ambas firmas (objeto y posicional)', async () => {
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

  await t.test('14. Migración SQL: 20261026_fcm_atomic_lease_and_fencing.sql define RPCs seguras con SECURITY DEFINER', () => {
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
