'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Subrequest & DB Mock Tracker for Cloudflare Workers Free Limits Testing
function createTrackedMockSupabase(options = {}) {
  let subrequestCount = 0;
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
    getSubrequestsCount() {
      return subrequestCount;
    },
    resetSubrequestsCount() {
      subrequestCount = 0;
    },
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
            subrequestCount++;
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
            subrequestCount++;
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
            subrequestCount++;
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
                subrequestCount++;
                if (col === 'endpoint') {
                  subsStore.delete(val);
                }
                return { error: null };
              }
            };
          },
          update(updates) {
            return {
              async eq(col, val) {
                subrequestCount++;
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
            let fUid = null;
            let fEndpoint = null;
            const chain = {
              eq(col, val) {
                if (col === 'source_uid') fUid = val;
                if (col === 'endpoint') fEndpoint = val;
                return chain;
              },
              then(resolve, reject) {
                subrequestCount++;
                const found = [];
                for (const n of notifStore.values()) {
                  if (fUid && n.source_uid !== fUid) continue;
                  if (fEndpoint && n.endpoint !== fEndpoint) continue;
                  found.push({ ...n });
                }
                resolve({ data: found, error: null });
              },
              catch(reject) {
                return chain;
              }
            };
            return chain;
          },
          async insert(record) {
            subrequestCount++;
            const key = `${record.source_uid}::${record.endpoint}`;
            if (notifStore.has(key)) {
              return { error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
            }
            notifStore.set(key, { ...record });
            return { data: [record], error: null };
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
                subrequestCount++;
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
          }
        };
      }

      throw new Error(`Tabla desconocida en mock: ${table}`);
    }
  };
}

test('Suite de Validación de Límites Cloudflare Free y Latencias Web Push', async (t) => {
  const {
    runArchival,
    syncEventsToSupabase,
    dispatchPushNotifications,
    sha256Hex
  } = await import('../cloudflare/lib/archivar-sismos.mjs');

  // Claves criptográficas de prueba
  const vapidKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const vapidJwk = await crypto.subtle.exportKey('jwk', vapidKeyPair.privateKey);
  const vapidPubRaw = await crypto.subtle.exportKey('raw', vapidKeyPair.publicKey);
  const vapidPubKeyB64 = Buffer.from(vapidPubRaw).toString('base64url');
  const vapidKeyHash = await sha256Hex(vapidPubKeyB64);

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
    VAPID_PRIVATE_KEY_JWK: JSON.stringify(vapidJwk),
    VAPID_SUBJECT: 'mailto:admin@sismopa.pages.dev'
  };

  const sampleSubscriber = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/device_test_limits_1',
    p256dh: clientP256dh,
    auth: clientAuth,
    vapid_key_hash: vapidKeyHash,
    failures: 0,
    created_at: '2026-10-25T10:00:00.000Z'
  };

  await t.test('1. Presupuesto Subrequests (1 suscriptor): consumo total strictly <= 10 subrequests', async () => {
    let fetchSubrequests = 0;
    globalThis.fetch = async () => {
      fetchSubrequests++;
      return new Response('{}', { status: 201 });
    };

    const mockDb = createTrackedMockSupabase({
      subs: [sampleSubscriber]
    });

    const newEvent = {
      source_uid: 'igc_event_subreq_1',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.5,
      latitud: 8.1,
      longitud: -80.1,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    const res = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, new Date('2026-10-25T12:00:00.000Z'));
    assert.equal(res.enviados, 1);

    const supabaseSubrequests = mockDb.getSubrequestsCount();
    const totalSubrequests = fetchSubrequests + supabaseSubrequests;

    assert.ok(totalSubrequests <= 10, `Consumo total fue ${totalSubrequests}, debe ser <= 10`);
    assert.ok(totalSubrequests < 50, 'Respeta holgadamente el límite de 50 de Cloudflare Free');
  });

  await t.test('2. Presupuesto Subrequests (15 suscriptores): consumo total strictly <= 40 (holgura >= 10 bajo limite 50)', async () => {
    let fetchSubrequests = 0;
    globalThis.fetch = async () => {
      fetchSubrequests++;
      return new Response('{}', { status: 201 });
    };

    const subs15 = [];
    for (let i = 1; i <= 15; i++) {
      subs15.push({
        ...sampleSubscriber,
        endpoint: `https://fcm.googleapis.com/fcm/send/device_budget_${i}`,
        failures: 0
      });
    }

    const mockDb = createTrackedMockSupabase({
      subs: subs15
    });

    const newEvent = {
      source_uid: 'igc_event_subreq_15',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.8,
      latitud: 8.2,
      longitud: -80.2,
      profundidad_km: 12,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    const res = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, new Date('2026-10-25T12:00:00.000Z'));
    assert.equal(res.enviados, 15);

    const supabaseSubrequests = mockDb.getSubrequestsCount();
    const totalSubrequests = fetchSubrequests + supabaseSubrequests;

    assert.ok(totalSubrequests <= 40, `Consumo total fue ${totalSubrequests}, debe ser <= 40`);
    assert.ok(50 - totalSubrequests >= 10, `Margen de seguridad libre es ${50 - totalSubrequests} (debe ser >= 10)`);
  });

  await t.test('3. Concurrencia de Conexiones: maximo 5 conexiones salientes simultaneas (respeta limite de 6 de Cloudflare)', async () => {
    let currentConcurrent = 0;
    let maxObservedConcurrent = 0;

    globalThis.fetch = async () => {
      currentConcurrent++;
      if (currentConcurrent > maxObservedConcurrent) {
        maxObservedConcurrent = currentConcurrent;
      }
      // Simular latencia de red para medir solapamiento
      await new Promise(r => setTimeout(r, 20));
      currentConcurrent--;
      return new Response('{}', { status: 201 });
    };

    const subs20 = [];
    for (let i = 1; i <= 20; i++) {
      subs20.push({
        ...sampleSubscriber,
        endpoint: `https://fcm.googleapis.com/fcm/send/device_concurrency_${i}`,
        failures: 0
      });
    }

    const mockDb = createTrackedMockSupabase({
      subs: subs20
    });

    const newEvent = {
      source_uid: 'igc_event_concurrency_test',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.4,
      latitud: 8.0,
      longitud: -80.0,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    await dispatchPushNotifications([newEvent], mockDb, defaultEnv, new Date('2026-10-25T12:00:00.000Z'));

    assert.ok(maxObservedConcurrent <= 5, `Maximas conexiones observadas fueron ${maxObservedConcurrent}, debe ser <= 5`);
    assert.ok(maxObservedConcurrent > 1, 'Hubo concurrencia efectiva en lotes de 5');
  });

  await t.test('4. Límite de Ciclo Cron: con 100 suscriptores, ciclo 1 despacha exactamente 15 y difiere el resto', async () => {
    let pushCalls = 0;
    globalThis.fetch = async () => {
      pushCalls++;
      return new Response('{}', { status: 201 });
    };

    const subs100 = [];
    for (let i = 1; i <= 100; i++) {
      subs100.push({
        ...sampleSubscriber,
        endpoint: `https://fcm.googleapis.com/fcm/send/device_100_${i}`,
        failures: 0
      });
    }

    const mockDb = createTrackedMockSupabase({
      subs: subs100
    });

    const newEvent = {
      source_uid: 'igc_event_batch_limit_100',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 5.0,
      latitud: 8.3,
      longitud: -80.3,
      profundidad_km: 15,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    // Ciclo 1 sin override (plan Free por defecto)
    const res = await dispatchPushNotifications([newEvent], mockDb, defaultEnv, new Date('2026-10-25T12:00:00.000Z'));

    assert.equal(res.enviados, 15, 'Debe despachar exactamente 15 en el ciclo 1');
    assert.equal(pushCalls, 15);
    assert.equal(mockDb._notif.size, 15);
  });

  await t.test('5. Drenaje Multi-Ciclo: 100 suscriptores drenados en 7 ciclos cron (15x6 + 10) sin pérdidas ni duplicados', async () => {
    let totalPushesSent = 0;
    globalThis.fetch = async () => {
      totalPushesSent++;
      return new Response('{}', { status: 201 });
    };

    const subs100 = [];
    for (let i = 1; i <= 100; i++) {
      subs100.push({
        ...sampleSubscriber,
        endpoint: `https://fcm.googleapis.com/fcm/send/device_multi_drain_${i}`,
        failures: 0
      });
    }

    const mockDb = createTrackedMockSupabase({
      subs: subs100
    });

    const event = {
      source_uid: 'igc_event_drain_100',
      fecha_hora: '2026-10-25T12:00:00.000Z',
      magnitud: 5.1,
      latitud: 8.1,
      longitud: -80.1,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:00:30.000Z'
    };

    const batchSizes = [];
    // Simular 7 minutos consecutivos del cron
    for (let minute = 0; minute < 7; minute++) {
      const cycleTime = new Date(new Date('2026-10-25T12:01:00.000Z').getTime() + minute * 60000);
      const res = await dispatchPushNotifications([event], mockDb, defaultEnv, cycleTime);
      batchSizes.push(res.enviados);
    }

    assert.deepEqual(batchSizes, [15, 15, 15, 15, 15, 15, 10], 'Drenaje exacto en ondas de 15 y remanente de 10');
    assert.equal(totalPushesSent, 100, 'Exactamente 100 notificaciones enviadas');
    assert.equal(mockDb._notif.size, 100, 'Exactamente 100 registros en notificaciones_enviadas');

    // Minuto 8: el evento ya está 100% completado, 0 envíos adicionales
    const resExtra = await dispatchPushNotifications([event], mockDb, defaultEnv, new Date('2026-10-25T12:08:00.000Z'));
    assert.equal(resExtra.enviados, 0);
  });

  await t.test('6. Medición de Tiempos: desglose por fases (archivado vs preparación vs despacho)', async () => {
    globalThis.fetch = async (url) => {
      if (url.includes('fcm')) {
        await new Promise(r => setTimeout(r, 10)); // 10ms latencia push
        return new Response('{}', { status: 201 });
      }
      return new Response('{}', { status: 200 });
    };

    const mockDb = createTrackedMockSupabase({
      subs: [sampleSubscriber]
    });

    const testEvent = {
      source_uid: 'igc_event_bench_phase',
      source_event_id: 'IGC-BENCH',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.2,
      latitud: 8.0,
      longitud: -80.0,
      profundidad_km: 10,
      region: 'Panamá'
    };

    // 1. Tiempo de archivado
    const tArch0 = Date.now();
    await syncEventsToSupabase([testEvent], mockDb, new Date('2026-10-25T12:00:00.000Z'));
    const archDuration = Date.now() - tArch0;

    // 2. Tiempo de despacho
    const tPush0 = Date.now();
    const pushRes = await dispatchPushNotifications([testEvent], mockDb, defaultEnv, new Date('2026-10-25T12:00:00.000Z'));
    const pushDuration = Date.now() - tPush0;

    assert.equal(pushRes.enviados, 1);
    assert.ok(archDuration < 200, `Archivado tomó ${archDuration}ms (< 200ms)`);
    assert.ok(pushDuration < 500, `Despacho tomó ${pushDuration}ms (< 500ms)`);
  });

  await t.test('7. Latencia Simulada: tolerante a respuestas de 500ms y 2000ms sin timeouts ni fallos', async () => {
    const latencies = [500, 2000];

    for (const lat of latencies) {
      globalThis.fetch = async () => {
        await new Promise(r => setTimeout(r, lat));
        return new Response('{}', { status: 201 });
      };

      const mockDb = createTrackedMockSupabase({
        subs: [{ ...sampleSubscriber, endpoint: `https://fcm.googleapis.com/fcm/send/device_lat_${lat}` }]
      });

      const event = {
        source_uid: `igc_event_latency_${lat}`,
        fecha_hora: '2026-10-25T11:58:00.000Z',
        magnitud: 4.3,
        latitud: 8.0,
        longitud: -80.0,
        profundidad_km: 10,
        primera_captura: '2026-10-25T12:00:00.000Z'
      };

      const t0 = Date.now();
      const res = await dispatchPushNotifications([event], mockDb, defaultEnv, new Date('2026-10-25T12:00:00.000Z'));
      const elapsed = Date.now() - t0;

      assert.equal(res.enviados, 1);
      assert.ok(elapsed >= lat, `Tomó ${elapsed}ms, debía tomar al menos ${lat}ms`);
      assert.ok(elapsed < lat + 1000, `Finalizó limpiamente en ${elapsed}ms`);
    }
  });

  await t.test('8. Timeout de Red: petición que excede el tiempo límite aborta limpiamente sin congelar el Worker', async () => {
    globalThis.fetch = async (url, opts) => {
      // Simula socket colgado esperando que AbortSignal.timeout lo cancele
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response('{}', { status: 201 })), 1000);
        if (opts && opts.signal) {
          opts.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            const err = new Error('The operation was aborted due to timeout');
            err.name = 'TimeoutError';
            reject(err);
          });
        }
      });
    };

    const mockDb = createTrackedMockSupabase({
      subs: [sampleSubscriber]
    });

    const event = {
      source_uid: 'igc_event_timeout_test',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.7,
      latitud: 8.0,
      longitud: -80.0,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    // Envía configurando timeout de 150ms para comprobación rápida y segura
    const res = await dispatchPushNotifications([event], mockDb, { ...defaultEnv, PUSH_NETWORK_TIMEOUT_MS: 150 }, new Date('2026-10-25T12:00:00.000Z'));

    assert.equal(res.enviados, 0);
    // La reserva fue liberada para reintento
    assert.equal(mockDb._notif.size, 0);
    // Registra el fallo en el suscriptor para backoff
    assert.equal(mockDb._subs.get(sampleSubscriber.endpoint).failures, 1);
  });

  await t.test('9. Solapamiento Concurrente: 2 cron simultáneos envían exactamente 1 notificación (cero duplicados)', async () => {
    let pushDeliveries = 0;
    globalThis.fetch = async () => {
      pushDeliveries++;
      await new Promise(r => setTimeout(r, 30)); // Delay para forzar solapamiento
      return new Response('{}', { status: 201 });
    };

    const mockDb = createTrackedMockSupabase({
      subs: [sampleSubscriber]
    });

    const event = {
      source_uid: 'igc_event_overlap_test',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.8,
      latitud: 8.1,
      longitud: -80.1,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    // Dos instancias concurrentes del cron ejecutadas a la vez
    const [resA, resB] = await Promise.all([
      dispatchPushNotifications([event], mockDb, defaultEnv, new Date('2026-10-25T12:00:00.000Z')),
      dispatchPushNotifications([event], mockDb, defaultEnv, new Date('2026-10-25T12:00:00.000Z'))
    ]);

    assert.equal(resA.enviados + resB.enviados, 1, 'Exactamente 1 notificación enviada entre ambas instancias');
    assert.equal(pushDeliveries, 1);
    assert.equal(mockDb._notif.size, 1);
  });

  await t.test('10. Auditoría Temporal (Fase 4): Eventos en T-3s, T-1.5s, T-0.5s y T exacto son OMITIDOS (cero spam histórico)', async () => {
    let pushCalls = 0;
    globalThis.fetch = async () => {
      pushCalls++;
      return new Response('{}', { status: 201 });
    };

    const activationTime = new Date('2026-10-25T12:00:00.000Z');
    const actMs = activationTime.getTime();

    const mockDb = createTrackedMockSupabase({
      subs: [sampleSubscriber],
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: activationTime.toISOString()
        }
      ]
    });

    // 4 eventos capturados en o antes de la activación
    const testCases = [
      { offset: -3000, desc: 'T - 3 segundos' },
      { offset: -1500, desc: 'T - 1.5 segundos' },
      { offset: -500, desc: 'T - 0.5 segundos' },
      { offset: 0, desc: 'T exacto' }
    ];

    for (const tc of testCases) {
      const capTime = new Date(actMs + tc.offset).toISOString();
      const event = {
        source_uid: `igc_event_offset_${tc.offset}`,
        fecha_hora: '2026-10-25T11:58:00.000Z',
        magnitud: 4.5,
        latitud: 8.0,
        longitud: -80.0,
        profundidad_km: 10,
        primera_captura: capTime
      };

      const res = await dispatchPushNotifications([event], mockDb, defaultEnv, new Date('2026-10-25T12:01:00.000Z'));
      assert.equal(res.enviados, 0, `Evento en ${tc.desc} NO debe notificarse`);
    }

    assert.equal(pushCalls, 0, 'Cero peticiones de red para eventos anteriores o iguales a la activación');
  });

  await t.test('11. Auditoría Temporal (Fase 4): Eventos en T+0.5s y T+3s son NOTIFICADOS (eventos nuevos legítimos)', async () => {
    let pushCalls = 0;
    globalThis.fetch = async () => {
      pushCalls++;
      return new Response('{}', { status: 201 });
    };

    const activationTime = new Date('2026-10-25T12:00:00.000Z');
    const actMs = activationTime.getTime();

    const testCases = [
      { offset: 500, desc: 'T + 0.5 segundos' },
      { offset: 3000, desc: 'T + 3 segundos' }
    ];

    for (const tc of testCases) {
      const mockDb = createTrackedMockSupabase({
        subs: [sampleSubscriber],
        notificaciones: [
          {
            source_uid: '__SYSTEM_PUSH_ACTIVATION__',
            endpoint: '__SYSTEM__',
            enviado_en: activationTime.toISOString()
          }
        ]
      });

      const capTime = new Date(actMs + tc.offset).toISOString();
      const event = {
        source_uid: `igc_event_offset_${tc.offset}`,
        fecha_hora: '2026-10-25T11:59:00.000Z',
        magnitud: 4.6,
        latitud: 8.1,
        longitud: -80.1,
        profundidad_km: 10,
        primera_captura: capTime
      };

      const res = await dispatchPushNotifications([event], mockDb, defaultEnv, new Date('2026-10-25T12:01:00.000Z'));
      assert.equal(res.enviados, 1, `Evento en ${tc.desc} SÍ debe notificarse por ser nuevo`);
    }

    assert.equal(pushCalls, 2);
  });

  await t.test('12. Margen de 15s de Registro de Suscriptor: E-10s y E+5s reciben alerta; E+20s es excluido', async () => {
    let pushCalls = 0;
    globalThis.fetch = async () => {
      pushCalls++;
      return new Response('{}', { status: 201 });
    };

    const evCapturedTime = new Date('2026-10-25T12:00:00.000Z');
    const evMs = evCapturedTime.getTime();

    const subPre = {
      ...sampleSubscriber,
      endpoint: 'https://fcm.googleapis.com/fcm/send/device_sub_pre',
      created_at: new Date(evMs - 10000).toISOString() // Registrado 10s antes del evento
    };
    const subSync = {
      ...sampleSubscriber,
      endpoint: 'https://fcm.googleapis.com/fcm/send/device_sub_sync',
      created_at: new Date(evMs + 5000).toISOString() // Registrado 5s después (dentro de ventana de 15s)
    };
    const subPost = {
      ...sampleSubscriber,
      endpoint: 'https://fcm.googleapis.com/fcm/send/device_sub_post',
      created_at: new Date(evMs + 20000).toISOString() // Registrado 20s después (fuera de ventana de 15s)
    };

    const mockDb = createTrackedMockSupabase({
      subs: [subPre, subSync, subPost]
    });

    const event = {
      source_uid: 'igc_event_window_15s',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.9,
      latitud: 8.2,
      longitud: -80.2,
      profundidad_km: 10,
      primera_captura: evCapturedTime.toISOString()
    };

    const res = await dispatchPushNotifications([event], mockDb, defaultEnv, new Date('2026-10-25T12:01:00.000Z'));

    assert.equal(res.enviados, 2, 'Solamente deben recibir subPre y subSync (subPost fuera de 15s es excluido)');
    assert.equal(pushCalls, 2);
    assert.ok(mockDb._notif.has('igc_event_window_15s::' + subPre.endpoint));
    assert.ok(mockDb._notif.has('igc_event_window_15s::' + subSync.endpoint));
    assert.ok(!mockDb._notif.has('igc_event_window_15s::' + subPost.endpoint));
  });

  await t.test('13. Failsafe ante Fallo de Persistencia del Marcador: base de datos con error asume nowTime y bloquea sismos historicos', async () => {
    let pushCalls = 0;
    globalThis.fetch = async () => {
      pushCalls++;
      return new Response('{}', { status: 201 });
    };

    const now = new Date('2026-10-25T12:00:00.000Z');

    // Mock que lanza error al consultar o insertar __SYSTEM_PUSH_ACTIVATION__
    const mockDbFailing = {
      from(t) {
        if (t === 'notificaciones_enviadas') {
          return {
            select() {
              throw new Error('Supabase database connection failure (simulated)');
            },
            insert() {
              throw new Error('Supabase database connection failure (simulated)');
            }
          };
        }
        if (t === 'push_subscriptions') {
          return {
            select() {
              return {
                async limit(n) {
                  return { data: [sampleSubscriber], error: null };
                }
              };
            }
          };
        }
        if (t === 'sismos') {
          return { select() { return { eq() { return { data: [], error: null }; } }; } };
        }
        throw new Error('Unknown table');
      }
    };

    // Sismo histórico capturado 10 minutos antes
    const historicalEvent = {
      source_uid: 'igc_event_hist_failing_db',
      fecha_hora: '2026-10-25T11:50:00.000Z',
      magnitud: 4.8,
      latitud: 8.0,
      longitud: -80.0,
      profundidad_km: 10,
      primera_captura: '2026-10-25T11:50:00.000Z'
    };

    const res = await dispatchPushNotifications([historicalEvent], mockDbFailing, defaultEnv, now);

    assert.equal(res.enviados, 0, 'No debe notificar sismos históricos aun con fallo de Supabase');
    assert.equal(pushCalls, 0);
  });
});
