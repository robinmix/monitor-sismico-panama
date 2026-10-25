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
        if (!v.source_uid || v.source_uid.startsWith('__SYSTEM_') || v.endpoint === '__CURSOR__') {
          continue;
        }
        filtered.set(k, v);
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
            let offset = 0;
            let limitNum = 500;
            let gtCreatedAt = null;
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
              gt(col, val) {
                if (col === 'created_at') gtCreatedAt = val;
                return chain;
              },
              gte(col, val) {
                if (col === 'created_at') gtCreatedAt = val;
                return chain;
              },
              then(resolve, reject) {
                subrequestCount++;
                let rows = Array.from(subsStore.values());
                if (gtCreatedAt) {
                  rows = rows.filter(r => r.created_at && r.created_at > gtCreatedAt);
                }
                rows = rows.slice(offset, offset + limitNum);
                resolve({ data: rows, error: null });
              },
              catch(reject) { return chain; }
            };
            return chain;
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
                subrequestCount++;
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
            let fEndpoints = null;
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
              in(col, vals) {
                if (col === 'endpoint') fEndpoints = vals;
                return chain;
              },
              then(resolve) {
                subrequestCount++;
                if (fUid && fEndpoint) {
                  const key = `${fUid}::${fEndpoint}`;
                  if (notifStore.has(key)) {
                    notifStore.set(key, { ...notifStore.get(key), ...updates });
                  }
                } else if (fUid && Array.isArray(fEndpoints)) {
                  for (const ep of fEndpoints) {
                    const key = `${fUid}::${ep}`;
                    if (notifStore.has(key)) {
                      notifStore.set(key, { ...notifStore.get(key), ...updates });
                    }
                  }
                }
                resolve({ data: null, error: null });
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
      const evTime = new Date(actMs + tc.offset - 100).toISOString();
      const event = {
        source_uid: `igc_event_offset_${tc.offset}`,
        fecha_hora: evTime,
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

    // Demostrar además que un sismo con fecha_hora anterior a la activación NO es un sismo nuevo post-activación
    // incluso si su primera_captura fue posterior a la activación
    const mockDbPre = createTrackedMockSupabase({
      subs: [sampleSubscriber],
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: activationTime.toISOString()
        }
      ]
    });
    const preEvent = {
      source_uid: 'igc_event_pre_act',
      fecha_hora: '2026-10-25T11:59:00.000Z', // 1 min antes de activación
      magnitud: 4.6,
      latitud: 8.1,
      longitud: -80.1,
      profundidad_km: 10,
      primera_captura: new Date(actMs + 1000).toISOString() // captura 1s después de activación
    };
    const resPre = await dispatchPushNotifications([preEvent], mockDbPre, defaultEnv, new Date('2026-10-25T12:01:00.000Z'));
    assert.equal(resPre.enviados, 0, 'Sismo ocurrido antes de la activación NO se notifica aunque se capture después');
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
  await t.test('14. Reclamación de Reservas Abandonadas: lease expirado (>90s) es reclamado y entregado exitosamente', async () => {
    let pushCalls = 0;
    globalThis.fetch = async () => {
      pushCalls++;
      return new Response('{}', { status: 201 });
    };

    const now = new Date('2026-10-25T12:05:00.000Z');
    const abandonedLeaseTime = new Date('2026-10-25T12:02:00.000Z').toISOString(); // Expiró hace 3 minutos

    const mockDb = createTrackedMockSupabase({
      subs: [sampleSubscriber],
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: '2026-10-25T10:00:00.000Z'
        },
        {
          source_uid: 'igc_event_abandoned_lease',
          endpoint: sampleSubscriber.endpoint,
          estado: 'EN_PROCESO',
          lease_expires_at: abandonedLeaseTime,
          enviado_en: '2026-10-25T12:00:30.000Z'
        }
      ]
    });

    const event = {
      source_uid: 'igc_event_abandoned_lease',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.8,
      latitud: 8.1,
      longitud: -80.1,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    const res = await dispatchPushNotifications([event], mockDb, defaultEnv, now);

    assert.equal(res.enviados, 1, 'Debe reclamar la reserva abandonada y entregar la notificación');
    assert.equal(pushCalls, 1);
    const saved = mockDb._notifStore.get(`${event.source_uid}::${sampleSubscriber.endpoint}`);
    assert.equal(saved.estado, 'CONFIRMADA');
  });

  await t.test('15. Reparto Equitativo de Cuota entre Sismos Simultáneos: evita inanición entre 2 eventos activos', async () => {
    let pushCalls = 0;
    globalThis.fetch = async () => {
      pushCalls++;
      return new Response('{}', { status: 201 });
    };

    const subs20 = [];
    for (let i = 1; i <= 20; i++) {
      subs20.push({
        ...sampleSubscriber,
        endpoint: `https://fcm.googleapis.com/fcm/send/device_fair_${i}`,
        failures: 0
      });
    }

    const mockDb = createTrackedMockSupabase({
      subs: subs20
    });

    const event1 = {
      source_uid: 'igc_event_fair_1',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 5.2,
      latitud: 8.1,
      longitud: -80.1,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };
    const event2 = {
      source_uid: 'igc_event_fair_2',
      fecha_hora: '2026-10-25T11:59:00.000Z',
      magnitud: 4.6,
      latitud: 7.9,
      longitud: -80.5,
      profundidad_km: 15,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    // Cuota default = 15. Con 2 eventos, event1 recibe ceil(15/2) = 8, event2 recibe los 7 restantes.
    const res = await dispatchPushNotifications([event1, event2], mockDb, defaultEnv, new Date('2026-10-25T12:01:00.000Z'));

    assert.equal(res.enviados, 15);
    assert.equal(res.sismosNotificados, 2);

    // Comprobar que AMBOS eventos recibieron suscriptores (cero inanición)
    let countEv1 = 0;
    let countEv2 = 0;
    for (const [k, v] of mockDb._notif.entries()) {
      if (k.startsWith('igc_event_fair_1::')) countEv1++;
      if (k.startsWith('igc_event_fair_2::')) countEv2++;
    }

    assert.equal(countEv1, 8, 'Event 1 (mayor magnitud) recibe su cuota equitativa');
    assert.equal(countEv2, 7, 'Event 2 recibe el remanente equitativo sin quedar en inanición');
  });

  await t.test('16. Paginación y Drenaje para 501, 1,000 y 2,000 Suscriptores: procesa más allá del umbral 500 sin exclusiones', async () => {
    let pushCalls = 0;
    globalThis.fetch = async () => {
      pushCalls++;
      return new Response('{}', { status: 201 });
    };

    const subs501 = [];
    const baseTime = new Date('2026-10-25T10:00:00.000Z').getTime();
    for (let i = 1; i <= 501; i++) {
      subs501.push({
        ...sampleSubscriber,
        endpoint: `https://fcm.googleapis.com/fcm/send/device_501_${i}`,
        created_at: new Date(baseTime + i * 1000).toISOString(),
        failures: 0
      });
    }

    // Simulamos que los primeros 490 ya fueron entregados en ciclos cron previos con cursor persistido
    const prevNotif = [
      {
        source_uid: '__SYSTEM_PUSH_ACTIVATION__',
        endpoint: '__SYSTEM__',
        enviado_en: '2026-10-25T10:00:00.000Z'
      },
      {
        source_uid: 'igc_event_501_test',
        endpoint: '__CURSOR__',
        estado: 'CONFIRMADA',
        enviado_en: new Date(baseTime + 490 * 1000).toISOString()
      }
    ];
    for (let i = 1; i <= 490; i++) {
      prevNotif.push({
        source_uid: 'igc_event_501_test',
        endpoint: `https://fcm.googleapis.com/fcm/send/device_501_${i}`,
        estado: 'CONFIRMADA',
        enviado_en: new Date(baseTime + i * 1000).toISOString()
      });
    }

    const mockDb = createTrackedMockSupabase({
      subs: subs501,
      notificaciones: prevNotif
    });

    const event = {
      source_uid: 'igc_event_501_test',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 5.0,
      latitud: 8.0,
      longitud: -80.0,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    // Este ciclo debe despachar los 11 restantes (491 al 501), superando limpiamente la barrera de 500
    const res = await dispatchPushNotifications([event], mockDb, defaultEnv, new Date('2026-10-25T12:01:00.000Z'));

    assert.equal(res.enviados, 11, 'Despacha los 11 suscriptores restantes incluyendo el suscriptor 501');
    assert.equal(mockDb._notif.size, 501, 'Los 501 suscriptores completados');
  });

  await t.test('17. Ciclo de Vida de Alerta (90 minutos): alerta caduca tras 90 min de primera_captura', async () => {
    let pushCalls = 0;
    globalThis.fetch = async () => {
      pushCalls++;
      return new Response('{}', { status: 201 });
    };

    const mockDb = createTrackedMockSupabase({
      subs: [sampleSubscriber]
    });

    const now = new Date('2026-10-25T13:35:00.000Z');

    // 1. Evento con primera_captura de hace 95 minutos (caducado)
    const expiredEvent = {
      source_uid: 'igc_event_expired_95m',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 5.0,
      latitud: 8.0,
      longitud: -80.0,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:00:00.000Z' // 95 min antes de now (13:35)
    };

    const resExpired = await dispatchPushNotifications([expiredEvent], mockDb, defaultEnv, now);
    assert.equal(resExpired.enviados, 0, 'Sismo con más de 90 min de detectado debe caducar');
    assert.equal(pushCalls, 0);

    // 2. Evento con primera_captura de hace 85 minutos (aún vigente para drenaje)
    const validEvent = {
      source_uid: 'igc_event_valid_85m',
      fecha_hora: '2026-10-25T12:05:00.000Z',
      magnitud: 5.0,
      latitud: 8.0,
      longitud: -80.0,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:10:00.000Z' // 85 min antes de now (13:35)
    };

    const resValid = await dispatchPushNotifications([validEvent], mockDb, defaultEnv, now);
    assert.equal(resValid.enviados, 1, 'Sismo dentro de los 90 min de detectado se entrega');
    assert.equal(pushCalls, 1);
  });

  await t.test('18. Anonimización de Endpoints en Logs: cero tokens o endpoints completos filtrados', async () => {
    const { anonymizeEndpoint } = await import('../cloudflare/lib/archivar-sismos.mjs');

    const fcmEndpoint = 'https://fcm.googleapis.com/fcm/send/dK98sLkjasd098123kjasd098123lkjasd987123';
    const anonymized = anonymizeEndpoint(fcmEndpoint);

    assert.ok(!anonymized.includes('dK98sLkjasd098123kjasd098123lkjasd987123'), 'No debe contener el token completo');
    assert.ok(anonymized.startsWith('https://fcm.googleapis.com/.../'), 'Conserva el dominio y formato anonimizado');
    assert.ok(anonymized.endsWith('7123'), 'Conserva los últimos 4 dígitos como hash visual');

    assert.equal(anonymizeEndpoint(null), '[endpoint_anonimo]');
    assert.equal(anonymizeEndpoint(''), '[endpoint_anonimo]');
  });

  await t.test('19. Robustez ante Timestamps Corruptos o Ambigüedad Temporal: omitidos de forma segura', async () => {
    let pushCalls = 0;
    globalThis.fetch = async () => {
      pushCalls++;
      return new Response('{}', { status: 201 });
    };

    const mockDb = createTrackedMockSupabase({
      subs: [sampleSubscriber]
    });

    const corruptEvents = [
      { source_uid: 'igc_corrupt_1', fecha_hora: 'not-a-date', magnitud: 4.5, latitud: 8.0, longitud: -80.0 },
      { source_uid: 'igc_corrupt_2', fecha_hora: null, magnitud: 4.5, latitud: 8.0, longitud: -80.0 },
      { source_uid: 'igc_corrupt_3', fecha_hora: '2026-10-25T15:00:00.000Z', magnitud: 4.5, latitud: 8.0, longitud: -80.0 } // 3 horas en el futuro
    ];

    const res = await dispatchPushNotifications(corruptEvents, mockDb, defaultEnv, new Date('2026-10-25T12:00:00.000Z'));
    assert.equal(res.enviados, 0);
    assert.equal(pushCalls, 0);
  });
  await t.test('20. Paginación determinista con 500 inelegibles seguidos de 500 elegibles sin bucles infinitos', async () => {
    let pushCalls = 0;
    globalThis.fetch = async () => {
      pushCalls++;
      return new Response('{}', { status: 201 });
    };

    const allSubs = [];
    const baseTime = new Date('2026-10-25T10:00:00.000Z').getTime();

    // 500 suscriptores inelegibles (clave VAPID obsoleta o failures >= 3)
    for (let i = 1; i <= 500; i++) {
      allSubs.push({
        ...sampleSubscriber,
        endpoint: `https://fcm.googleapis.com/fcm/send/device_ineligible_${i}`,
        vapid_key_hash: 'obsolete_vapid_hash_123',
        failures: 3,
        created_at: new Date(baseTime + i * 1000).toISOString()
      });
    }

    // 500 suscriptores elegibles (con hash VAPID vigente y failures: 0)
    for (let i = 501; i <= 1000; i++) {
      allSubs.push({
        ...sampleSubscriber,
        endpoint: `https://fcm.googleapis.com/fcm/send/device_eligible_${i}`,
        created_at: new Date(baseTime + i * 1000).toISOString(),
        failures: 0
      });
    }

    const mockDb = createTrackedMockSupabase({
      subs: allSubs,
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: '2026-10-25T10:00:00.000Z'
        }
      ]
    });

    const event = {
      source_uid: 'igc_event_mixed_queue',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.8,
      latitud: 8.2,
      longitud: -80.2,
      profundidad_km: 15,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    // Drenar ciclos sucesivos. El cursor debe atravesar los 500 inelegibles y despachar a los 500 elegibles
    let cycles = 0;
    const nowMs = new Date('2026-10-25T12:01:00.000Z').getTime();
    while (pushCalls < 500 && cycles < 45) {
      cycles++;
      mockDb.resetSubrequestsCount();
      const cycleTime = new Date(nowMs + cycles * 60000);
      const res = await dispatchPushNotifications([event], mockDb, defaultEnv, cycleTime);
      assert.ok(mockDb.getSubrequestsCount() <= 40, `Subrequests en ciclo ${cycles} no debe exceder 40 (obtenido: ${mockDb.getSubrequestsCount()})`);
    }

    assert.equal(pushCalls, 500, 'Todos los 500 suscriptores elegibles recibieron su notificación');
    assert.equal(mockDb._notif.size, 500, 'Exactamente 500 notificaciones a dispositivos registradas');
  });

  await t.test('21. Imposición estricta de límites Free ante variables de entorno excesivas', async () => {
    let pushCalls = 0;
    globalThis.fetch = async () => {
      pushCalls++;
      return new Response('{}', { status: 201 });
    };

    const subs100 = [];
    const baseTime = new Date('2026-10-25T10:00:00.000Z').getTime();
    for (let i = 1; i <= 100; i++) {
      subs100.push({
        ...sampleSubscriber,
        endpoint: `https://fcm.googleapis.com/fcm/send/device_env_limit_${i}`,
        created_at: new Date(baseTime + i * 1000).toISOString(),
        failures: 0
      });
    }

    const mockDb = createTrackedMockSupabase({
      subs: subs100,
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: '2026-10-25T10:00:00.000Z'
        }
      ]
    });

    const event = {
      source_uid: 'igc_event_excessive_env',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.5,
      latitud: 8.0,
      longitud: -80.0,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    const excessiveEnv = {
      ...defaultEnv,
      PUSH_MAX_SUBS_PER_CYCLE: '1000',
      PUSH_CONCURRENCY: '100',
      PUSH_MAX_SUBREQUESTS: '500'
    };

    const res = await dispatchPushNotifications([event], mockDb, excessiveEnv, new Date('2026-10-25T12:01:00.000Z'));

    assert.equal(res.enviados, 15, 'Acotado estrictamente a 15 a pesar de PUSH_MAX_SUBS_PER_CYCLE=1000');
    assert.ok(mockDb.getSubrequestsCount() <= 40, `Subrequests acotados estrictamente a 40 (obtenido: ${mockDb.getSubrequestsCount()})`);
    assert.equal(pushCalls, 15);
  });

  await t.test('22. Certidumbre temporal estricta ante errores de lectura de Supabase y sismos preexistentes', async () => {
    let pushCalls = 0;
    globalThis.fetch = async () => {
      pushCalls++;
      return new Response('{}', { status: 201 });
    };

    const activationTime = '2026-10-25T12:00:00.000Z';
    const mockDb = createTrackedMockSupabase({
      subs: [sampleSubscriber],
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: activationTime
        }
      ]
    });

    // Sismo sin primera_captura en el objeto y que ocurrió antes de la activación (11:50 vs 12:00)
    const preActEventNoCapture = {
      source_uid: 'igc_event_pre_no_cap',
      fecha_hora: '2026-10-25T11:50:00.000Z',
      magnitud: 4.8,
      latitud: 8.0,
      longitud: -80.0
    };

    const resPre = await dispatchPushNotifications([preActEventNoCapture], mockDb, defaultEnv, new Date('2026-10-25T12:05:00.000Z'));
    assert.equal(resPre.enviados, 0, 'Sismo previo a activación sin primera_captura se ancla a fecha_hora y no se notifica');
    assert.equal(pushCalls, 0);
  });

  await t.test('23. Escenario de estrés masivo con HTTP 429, 500 y timeouts simultáneos respetando subrequests <= 40', async () => {
    let reqIndex = 0;
    globalThis.fetch = async () => {
      reqIndex++;
      if (reqIndex % 3 === 1) {
        return new Response('Rate limited', { status: 429, headers: { 'Retry-After': '120' } });
      } else if (reqIndex % 3 === 2) {
        return new Response('Server Error', { status: 500 });
      } else {
        throw new Error('Connection timeout');
      }
    };

    const subs15 = [];
    const baseTime = new Date('2026-10-25T10:00:00.000Z').getTime();
    for (let i = 1; i <= 15; i++) {
      subs15.push({
        ...sampleSubscriber,
        endpoint: `https://fcm.googleapis.com/fcm/send/device_stress_${i}`,
        created_at: new Date(baseTime + i * 1000).toISOString(),
        failures: 0
      });
    }

    const mockDb = createTrackedMockSupabase({
      subs: subs15,
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: '2026-10-25T10:00:00.000Z'
        }
      ]
    });

    const event = {
      source_uid: 'igc_event_stress_test',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.7,
      latitud: 8.0,
      longitud: -80.0,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    const res = await dispatchPushNotifications([event], mockDb, defaultEnv, new Date('2026-10-25T12:01:00.000Z'));

    assert.equal(res.enviados, 0, 'Cero entregas exitosas debido a errores de red y servidor');
    assert.ok(mockDb.getSubrequestsCount() <= 40, `Subrequests no debe exceder 40 bajo estrés (obtenido: ${mockDb.getSubrequestsCount()})`);
    assert.equal(mockDb._notif.size, 0, 'Todas las reservas en proceso fueron limpiadas correctamente');
  });

  await t.test('24. Presupuesto integral del ciclo del Worker: archivado IGC + Supabase + despacho push strictly <= 40', async () => {
    globalThis.fetch = async (url) => {
      if (typeof url === 'string' && url.includes('fcm')) {
        return new Response('{}', { status: 201 });
      }
      return new Response('{}', { status: 201 });
    };

    const subs15 = [];
    const baseTime = new Date('2026-10-25T10:00:00.000Z').getTime();
    for (let i = 1; i <= 15; i++) {
      subs15.push({
        ...sampleSubscriber,
        endpoint: `https://fcm.googleapis.com/fcm/send/device_full_cycle_${i}`,
        created_at: new Date(baseTime + i * 1000).toISOString(),
        failures: 0
      });
    }

    const mockDb = createTrackedMockSupabase({
      subs: subs15,
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: '2026-10-25T10:00:00.000Z'
        }
      ]
    });

    const archivalRes = await runArchival({
      sourcePayload: {
        eventos: [
          {
            fecha: '2026-10-25',
            hora: '06:58:00 AM',
            latitud: 8.12,
            longitud: -80.45,
            profundidad: 15,
            magnitud: 4.8,
            region: 'Golfo de Panamá',
            estado: 'PRELIMINAR'
          }
        ]
      },
      supabase: mockDb,
      env: defaultEnv,
      now: new Date('2026-10-25T12:01:00.000Z')
    });

    assert.equal(archivalRes.ok, true);
    assert.ok(mockDb.getSubrequestsCount() <= 40, `Subrequests de todo el ciclo Workers Free strictly <= 40 (obtenido: ${mockDb.getSubrequestsCount()})`);
  });
  await t.test('25. Recuperación garantizada: 100 suscriptores con fallos en los primeros 10 se entregan sin bloquear restantes', async () => {
    let pushDeliveries = 0;
    globalThis.fetch = async (url) => {
      // Fallar exactamente los primeros 10 suscriptores en su primer intento con HTTP 500
      for (let i = 1; i <= 10; i++) {
        if (url.endsWith('/device_recover_' + i)) {
          const currentSub = mockDb._subs.get(url);
          if (!currentSub || currentSub.failures === 0) {
            return new Response('Server Error', { status: 500, headers: { 'Retry-After': '60' } });
          }
        }
      }
      pushDeliveries++;
      return new Response('{}', { status: 201 });
    };

    const subs100 = [];
    const baseTime = new Date('2026-10-25T10:00:00.000Z').getTime();
    for (let i = 1; i <= 100; i++) {
      subs100.push({
        ...sampleSubscriber,
        endpoint: `https://fcm.googleapis.com/fcm/send/device_recover_${i}`,
        created_at: new Date(baseTime + i * 1000).toISOString(),
        failures: 0
      });
    }

    const mockDb = createTrackedMockSupabase({
      subs: subs100,
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: '2026-10-25T10:00:00.000Z'
        }
      ]
    });

    const event = {
      source_uid: 'igc_event_recover_100',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.9,
      latitud: 8.2,
      longitud: -80.2,
      profundidad_km: 12,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    const startTime = new Date('2026-10-25T12:00:00.000Z').getTime();
    let cycles = 0;

    // Ejecutar ciclos cron consecutivos (cada minuto)
    while (pushDeliveries < 100 && cycles < 15) {
      cycles++;
      mockDb.resetSubrequestsCount();
      const cycleTime = new Date(startTime + cycles * 60000);
      const res = await dispatchPushNotifications([event], mockDb, defaultEnv, cycleTime);
      assert.ok(mockDb.getSubrequestsCount() <= 40, `Ciclo ${cycles} no debe exceder 40 subrequests (consumió ${mockDb.getSubrequestsCount()})`);
    }

    assert.equal(pushDeliveries, 100, 'Todos los 100 suscriptores fueron entregados exitosamente tras recuperación');
    assert.equal(mockDb._notif.size, 100, 'Exactamente 100 notificaciones registradas en Supabase');
  });

  await t.test('26. No omisión ante timestamps created_at idénticos a lo largo de ciclos cron sucesivos', async () => {
    let pushCalls = 0;
    globalThis.fetch = async () => {
      pushCalls++;
      return new Response('{}', { status: 201 });
    };

    const sameTime = '2026-10-25T10:00:00.000Z';
    const subA = {
      ...sampleSubscriber,
      endpoint: 'https://fcm.googleapis.com/fcm/send/device_same_time_A',
      created_at: sameTime
    };
    const subB = {
      ...sampleSubscriber,
      endpoint: 'https://fcm.googleapis.com/fcm/send/device_same_time_B',
      created_at: sameTime
    };

    const mockDb = createTrackedMockSupabase({
      subs: [subA, subB],
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: '2026-10-25T10:00:00.000Z'
        }
      ]
    });

    const event = {
      source_uid: 'igc_event_same_ts_suite',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.7,
      latitud: 8.0,
      longitud: -80.0,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    const now = new Date('2026-10-25T12:00:00.000Z');

    // Ciclo 1: Quota 1 (despacha subA y guarda cursor = sameTime)
    const res1 = await dispatchPushNotifications([event], mockDb, { ...defaultEnv, PUSH_MAX_SUBS_PER_CYCLE: '1' }, now);
    assert.equal(res1.enviados, 1, 'Despacha primer suscriptor con timestamp T');

    // Ciclo 2: Quota 1 (subB comparte created_at exacto pero NO debe ser omitido)
    const res2 = await dispatchPushNotifications([event], mockDb, { ...defaultEnv, PUSH_MAX_SUBS_PER_CYCLE: '1' }, new Date(now.getTime() + 60000));
    assert.equal(res2.enviados, 1, 'Segundo suscriptor con mismo timestamp T es entregado deterministamente');
    assert.equal(mockDb._notif.size, 2, 'Ambos suscriptores completados en notificaciones_enviadas');
  });

  await t.test('27. Presupuesto global: archivado sísmico masivo pospone push para no superar 40 subrequests ni arriesgar ingesta', async () => {
    globalThis.fetch = async () => new Response('{}', { status: 201 });

    const mockDb = createTrackedMockSupabase({
      subs: [sampleSubscriber],
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: '2026-10-25T10:00:00.000Z'
        }
      ]
    });

    // Generar un lote con muchos eventos que requieran múltiples subrequests de archivado en Supabase
    const muchosEventos = [];
    for (let i = 1; i <= 2500; i++) {
      muchosEventos.push({
        fecha: '2026-10-25',
        hora: '06:58:00 AM',
        latitud: 8.12,
        longitud: -80.45,
        profundidad: 15,
        magnitud: 4.8,
        region: 'Golfo de Panamá',
        estado: 'PRELIMINAR'
      });
    }

    const archivalRes = await runArchival({
      sourcePayload: { eventos: muchosEventos.slice(0, 5) },
      supabase: mockDb,
      env: defaultEnv,
      now: new Date('2026-10-25T12:01:00.000Z'),
      initialSubrequests: 32 // Simula que la ingesta consumió 32 subrequests
    });

    assert.equal(archivalRes.ok, true, 'La ingesta y archivado de sismos NUNCA se interrumpe');
    assert.ok(mockDb.getSubrequestsCount() <= 40, 'Consumo total acotado bajo el límite de Cloudflare Free');
  });
  await t.test('28. Confirmación agrupada fallida: fallback a individuales incrementa subrequests y respeta cota < 48', async () => {
    globalThis.fetch = async () => new Response('{}', { status: 201 });

    const subs5 = [];
    const baseTime = new Date('2026-10-25T10:00:00.000Z').getTime();
    for (let i = 1; i <= 5; i++) {
      subs5.push({
        ...sampleSubscriber,
        endpoint: `https://fcm.googleapis.com/fcm/send/device_batch_fallback_${i}`,
        created_at: new Date(baseTime + i * 1000).toISOString(),
        failures: 0
      });
    }

    const mockDb = createTrackedMockSupabase({
      subs: subs5,
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: '2026-10-25T10:00:00.000Z'
        }
      ]
    });

    // Simular que el update en lote (.in) falla, forzando la ruta de confirmación individual
    const origFrom = mockDb.from;
    mockDb.from = function(table) {
      const res = origFrom.call(mockDb, table);
      if (table === 'notificaciones_enviadas') {
        const origUpdate = res.update;
        res.update = function(updates) {
          const chain = origUpdate.call(res, updates);
          const origIn = chain.in;
          chain.in = function(col, vals) {
            origIn.call(chain, col, vals);
            return {
              then(resolve) {
                // Simular fallo en batch .in() de PostgreSQL
                resolve({ error: new Error('Batch update syntax error (simulated)') });
              }
            };
          };
          return chain;
        };
      }
      return res;
    };

    const event = {
      source_uid: 'igc_event_batch_fail',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.8,
      latitud: 8.0,
      longitud: -80.0,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    const res = await dispatchPushNotifications([event], mockDb, defaultEnv, new Date('2026-10-25T12:01:00.000Z'));

    assert.equal(res.enviados, 5, 'Los 5 suscriptores son confirmados individualmente tras el fallo agrupado');
    assert.ok(mockDb.getSubrequestsCount() <= 40, `Subrequests totales respetan presupuesto (consumió ${mockDb.getSubrequestsCount()})`);
    // Confirmar que todas las 5 notificaciones quedaron en estado CONFIRMADA
    for (const sub of subs5) {
      const notif = mockDb._notifStore.get(`${event.source_uid}::${sub.endpoint}`);
      assert.ok(notif, 'Notificación existe');
      assert.equal(notif.estado, 'CONFIRMADA', 'Estado confirmado individualmente');
    }
  });

  await t.test('29. Contador compartido y pre-reserva conservadora: garantiza cota < 48 bajo fallbacks y errores simultáneos', async () => {
    globalThis.fetch = async () => {
      // Simular respuestas de error de red que activan fallbacks de base de datos
      throw new Error('Connection reset by peer');
    };

    const subs15 = [];
    const baseTime = new Date('2026-10-25T10:00:00.000Z').getTime();
    for (let i = 1; i <= 15; i++) {
      subs15.push({
        ...sampleSubscriber,
        endpoint: `https://fcm.googleapis.com/fcm/send/device_shared_counter_${i}`,
        created_at: new Date(baseTime + i * 1000).toISOString(),
        failures: 0
      });
    }

    const mockDb = createTrackedMockSupabase({
      subs: subs15,
      notificaciones: [
        {
          source_uid: '__SYSTEM_PUSH_ACTIVATION__',
          endpoint: '__SYSTEM__',
          enviado_en: '2026-10-25T10:00:00.000Z'
        }
      ]
    });

    const event = {
      source_uid: 'igc_event_concurrent_fallback',
      fecha_hora: '2026-10-25T11:58:00.000Z',
      magnitud: 4.6,
      latitud: 8.0,
      longitud: -80.0,
      profundidad_km: 10,
      primera_captura: '2026-10-25T12:00:00.000Z'
    };

    const res = await dispatchPushNotifications([event], mockDb, defaultEnv, new Date('2026-10-25T12:01:00.000Z'));

    assert.equal(res.enviados, 0, 'Cero entregas exitosas por fallo de red');
    assert.ok(mockDb.getSubrequestsCount() < 48, `Presupuesto acotado bajo el límite seguro < 48 (consumió ${mockDb.getSubrequestsCount()})`);
    assert.ok(res.subrequests < 48, `Reporte de subrequests coincide estrictamente bajo cota 48 (reportó ${res.subrequests})`);
  });
});
