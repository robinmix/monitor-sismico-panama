'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const crypto = webcrypto;

test('Web Push Security & Delivery Suite (con Diagnósticos por Fases)', async (t) => {
  const webPushMod = await import('../cloudflare/lib/web-push.mjs');
  const {
    isValidPushEndpoint,
    b64UrlToUint8,
    uint8ToB64Url,
    parsePrivateJwkSafely,
    createVapidHeader,
    encryptWebPush,
    sendWebPush,
    WebPushError
  } = webPushMod;

  const subMod = await import('../functions/api/push-subscribe.js');
  const testMod = await import('../functions/api/push-test.js');
  const vapidMod = await import('../functions/api/push-vapid-key.js');

  await t.test('1. Seguridad: Cero claves privadas VAPID en código fuente versionado', () => {
    const root = path.join(__dirname, '..');
    const filesToCheck = [
      'cloudflare/lib/web-push.mjs',
      'functions/api/push-subscribe.js',
      'functions/api/push-test.js',
      'functions/api/push-vapid-key.js',
      'assets/app.js',
      'sw.js',
      'cloudflare/archivador/worker.mjs'
    ];

    for (const f of filesToCheck) {
      const full = path.join(root, f);
      if (!fs.existsSync(full)) continue;
      const content = fs.readFileSync(full, 'utf8');
      assert.ok(!content.includes('DEFAULT_VAPID_KEYS'), `El archivo ${f} contiene DEFAULT_VAPID_KEYS`);
      assert.ok(!content.includes('OWkJpmFPF2k2I'), `El archivo ${f} contiene la clave privada comprometida`);
    }
  });

  await t.test('2. SSRF Protection: isValidPushEndpoint valida exclusivamente proveedores legítimos', () => {
    // Proveedores legítimos
    assert.ok(isValidPushEndpoint('https://fcm.googleapis.com/fcm/send/device123'));
    assert.ok(isValidPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/gAAAA...'));
    assert.ok(isValidPushEndpoint('https://push.services.mozilla.com/wpush/v1/...'));
    assert.ok(isValidPushEndpoint('https://wns2-sn1p.notify.windows.com/w/?token=...'));
    assert.ok(isValidPushEndpoint('https://web.push.apple.com/QCn35q...'));

    // Ataques SSRF y destinos no autorizados
    assert.equal(isValidPushEndpoint('http://fcm.googleapis.com/fcm/send/123'), false, 'Rechaza HTTP sin TLS');
    assert.equal(isValidPushEndpoint('https://localhost:8080/push'), false, 'Rechaza localhost');
    assert.equal(isValidPushEndpoint('https://127.0.0.1/push'), false, 'Rechaza 127.0.0.1');
    assert.equal(isValidPushEndpoint('https://169.254.169.254/latest/meta-data/'), false, 'Rechaza metadata cloud');
    assert.equal(isValidPushEndpoint('https://internal.corp/push'), false, 'Rechaza dominio interno');
    assert.equal(isValidPushEndpoint('https://malicious-server.com/endpoint'), false, 'Rechaza dominio arbitrario');
    assert.equal(isValidPushEndpoint(null), false);
    assert.equal(isValidPushEndpoint(''), false);
  });

  await t.test('3. Diagnóstico JWK: parsePrivateJwkSafely tolera variaciones de formato y detecta errores exactos', () => {
    const validJwk = {
      kty: 'EC',
      crv: 'P-256',
      x: '6QnRgiIr7sxCx2iM3FnRfqBVpr4405TKt3usExsq5n4',
      y: 'GaivoJtKmMXzoziLS80qjUz_fjpXbktjQIv7yB8bIK4',
      d: 'OWkJpmFPF2k2I-PSGqYluXq0IewUhvGjxWmIUjEuLMs'
    };

    // Caso 1: Objeto directo
    const resObj = parsePrivateJwkSafely(validJwk);
    assert.equal(resObj.kty, 'EC');
    assert.equal(resObj.d, validJwk.d);

    // Caso 2: JSON stringificado
    const resStr = parsePrivateJwkSafely(JSON.stringify(validJwk));
    assert.equal(resStr.x, validJwk.x);

    // Caso 3: Doble stringificado (Cloudflare secrets)
    const resDouble = parsePrivateJwkSafely(JSON.stringify(JSON.stringify(validJwk)));
    assert.equal(resDouble.y, validJwk.y);

    // Caso 4: Con comillas simples alrededor: '{"kty":"EC",...}'
    const resSingleQuotes = parsePrivateJwkSafely(`'${JSON.stringify(validJwk)}'`);
    assert.equal(resSingleQuotes.d, validJwk.d);

    // Caso 5: Falta variable
    assert.throws(
      () => parsePrivateJwkSafely(null),
      (err) => err instanceof WebPushError && err.code === 'VAPID_PRIVATE_KEY_MISSING' && err.phase === 'PHASE_1_VAPID_CONFIG'
    );

    // Caso 6: JSON inválido
    assert.throws(
      () => parsePrivateJwkSafely('{kty: not valid json}'),
      (err) => err instanceof WebPushError && err.code === 'VAPID_JWK_JSON_INVALID' && err.phase === 'PHASE_2_VAPID_PARSE'
    );

    // Caso 7: Faltan coordenadas
    assert.throws(
      () => parsePrivateJwkSafely({ kty: 'EC', crv: 'P-256', x: '123' }),
      (err) => err instanceof WebPushError && err.code === 'VAPID_JWK_COORDINATES_MISSING' && err.phase === 'PHASE_2_VAPID_PARSE'
    );
  });

  await t.test('4. VAPID: Falla con fases y códigos diagnósticos claros si faltan secretos', async () => {
    await assert.rejects(
      async () => createVapidHeader('https://fcm.googleapis.com', {}),
      (err) => err instanceof WebPushError && err.phase === 'PHASE_1_VAPID_CONFIG' && err.code === 'VAPID_PUBLIC_KEY_MISSING'
    );

    await assert.rejects(
      async () => createVapidHeader('https://fcm.googleapis.com', { VAPID_PUBLIC_KEY: 'abc' }),
      (err) => err instanceof WebPushError && err.phase === 'PHASE_1_VAPID_CONFIG' && err.code === 'VAPID_PRIVATE_KEY_MISSING'
    );
  });

  await t.test('5. Criptografía: Verificación RFC 8291 con vectores oficiales IETF (Apéndice A)', async () => {
    const as_public_b64 = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
    const as_private_b64 = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
    const ua_public_b64 = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
    const auth_secret_b64 = 'BTBZMqHH6r4Tts7J_aSIgg';
    const salt_b64 = 'DGv6ra1nlYgDCS1FRnbzlw';
    const expected_cipher = '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ';

    const userPubBytes = b64UrlToUint8(ua_public_b64);
    const userAuthBytes = b64UrlToUint8(auth_secret_b64);
    const fixedSalt = b64UrlToUint8(salt_b64);

    const asPrivKey = await crypto.subtle.importKey('jwk', {
      kty: 'EC', crv: 'P-256',
      x: uint8ToB64Url(b64UrlToUint8(as_public_b64).slice(1, 33)),
      y: uint8ToB64Url(b64UrlToUint8(as_public_b64).slice(33, 65)),
      d: as_private_b64
    }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);

    const userKey = await crypto.subtle.importKey(
      'raw',
      userPubBytes,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );

    const sharedSecret = await crypto.subtle.deriveBits({ name: 'ECDH', public: userKey }, asPrivKey, 256);

    const localPubBytes = b64UrlToUint8(as_public_b64);
    const prefix = new TextEncoder().encode('WebPush: info\0');
    const authInfo = new Uint8Array(prefix.length + userPubBytes.length + localPubBytes.length);
    authInfo.set(prefix, 0);
    authInfo.set(userPubBytes, prefix.length);
    authInfo.set(localPubBytes, prefix.length + userPubBytes.length);

    const sharedSecretKey = await crypto.subtle.importKey('raw', sharedSecret, { name: 'HKDF' }, false, ['deriveBits']);
    const ikm = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: userAuthBytes, info: authInfo }, sharedSecretKey, 256);

    const ikmKey = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits', 'deriveKey']);
    const cek = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: fixedSalt, info: new TextEncoder().encode('Content-Encoding: aes128gcm\0') }, ikmKey, { name: 'AES-GCM', length: 128 }, false, ['encrypt']);
    const nonce = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: fixedSalt, info: new TextEncoder().encode('Content-Encoding: nonce\0') }, ikmKey, 96);

    const plainBytes = new TextEncoder().encode('When I grow up, I want to be a watermelon');
    const record = new Uint8Array(plainBytes.length + 1);
    record.set(plainBytes, 0);
    record[plainBytes.length] = 0x02;

    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cek, record);
    const actualCipherB64 = uint8ToB64Url(new Uint8Array(ciphertext));

    assert.equal(actualCipherB64, expected_cipher, 'Cifrado AES-128-GCM exacto según RFC 8291');
  });

  await t.test('6. VAPID: Firma JWT y verificación ES256 válida con par P-256', async () => {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
    const pubJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);

    const rawPub = new Uint8Array(65);
    rawPub[0] = 0x04;
    rawPub.set(b64UrlToUint8(pubJwk.x), 1);
    rawPub.set(b64UrlToUint8(pubJwk.y), 33);
    const pubB64 = uint8ToB64Url(rawPub);

    const env = {
      VAPID_PUBLIC_KEY: pubB64,
      VAPID_PRIVATE_KEY_JWK: JSON.stringify(privJwk)
    };

    const { authorization } = await createVapidHeader('https://fcm.googleapis.com', env);
    assert.ok(authorization.startsWith('vapid t='));
    assert.ok(authorization.includes(', k='));

    const token = authorization.replace(/^vapid t=/, '').split(',')[0].trim();
    const [hB64, pB64, sB64] = token.split('.');

    const sigBytes = b64UrlToUint8(sB64);
    assert.equal(sigBytes.length, 64);

    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.publicKey,
      sigBytes,
      new TextEncoder().encode(`${hB64}.${pB64}`)
    );
    assert.ok(verified, 'Firma ES256 válida');
  });

  await t.test('7. Diagnóstico de claves de usuario: detecta p256dh y auth malformados en PHASE_5', async () => {
    // p256dh con longitud incorrecta (64 bytes en lugar de 65)
    await assert.rejects(
      async () => encryptWebPush('test', uint8ToB64Url(new Uint8Array(64)), uint8ToB64Url(new Uint8Array(16))),
      (err) => err instanceof WebPushError && err.phase === 'PHASE_5_USER_KEY_DECODE' && err.code === 'INVALID_P256DH_FORMAT'
    );

    // auth con longitud incorrecta (15 bytes en lugar de 16)
    const validPub = new Uint8Array(65);
    validPub[0] = 0x04;
    await assert.rejects(
      async () => encryptWebPush('test', uint8ToB64Url(validPub), uint8ToB64Url(new Uint8Array(15))),
      (err) => err instanceof WebPushError && err.phase === 'PHASE_5_USER_KEY_DECODE' && err.code === 'INVALID_AUTH_FORMAT'
    );
  });

  await t.test('8. Respuestas del proveedor Web Push: 201, 400, 401, 403, 404, 410, 429 con captura de texto de error', async () => {
    const origFetch = globalThis.fetch;
    const testCases = [
      { status: 201, body: '', expectedOk: true, expectedExpired: false },
      { status: 400, body: 'BadDeviceToken', expectedOk: false, expectedExpired: false },
      { status: 401, body: 'UnauthorizedRegistration', expectedOk: false, expectedExpired: false },
      { status: 403, body: 'InvalidVapidToken', expectedOk: false, expectedExpired: false },
      { status: 404, body: 'Unregistered', expectedOk: false, expectedExpired: true },
      { status: 410, body: 'ExpiredSubscription', expectedOk: false, expectedExpired: true },
      { status: 429, body: 'QuotaExceeded', expectedOk: false, expectedExpired: false }
    ];

    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const privJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
    const pubJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const rawPub = new Uint8Array(65);
    rawPub[0] = 0x04;
    rawPub.set(b64UrlToUint8(pubJwk.x), 1);
    rawPub.set(b64UrlToUint8(pubJwk.y), 33);

    const env = {
      VAPID_PUBLIC_KEY: uint8ToB64Url(rawPub),
      VAPID_PRIVATE_KEY_JWK: JSON.stringify(privJwk)
    };

    const dummySub = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/testdevice',
      keys: {
        p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        auth: 'BTBZMqHH6r4Tts7J_aSIgg'
      }
    };

    for (const tc of testCases) {
      globalThis.fetch = async () => new Response(tc.body, { status: tc.status });
      const res = await sendWebPush(dummySub, { title: 'Test' }, env);
      assert.equal(res.ok, tc.expectedOk, `Status ${tc.status} expected ok=${tc.expectedOk}`);
      assert.equal(res.status, tc.status);
      assert.equal(res.expired, tc.expectedExpired, `Status ${tc.status} expected expired=${tc.expectedExpired}`);
      if (tc.body) {
        assert.equal(res.providerDetail, tc.body);
      }
    }

    globalThis.fetch = origFetch;
  });

  await t.test('9. push-test.js propaga fase y código diagnóstico ante fallos', async () => {
    // Probar push-test con fallo simulado de Supabase no configurado
    const req = new Request('https://sismopa.pages.dev/api/push-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/device1', test_token: '123' })
    });
    const res = await testMod.onRequest({ request: req, env: {} });
    assert.equal(res.status, 503);
    const data = await res.json();
    assert.equal(data.diagnostico.fase, 'SERVER_CONFIG');
    assert.equal(data.diagnostico.codigo, 'SUPABASE_ENV_MISSING');
  });

  await t.test('10. Service Worker: Notificaciones push y apertura de ficha en click', () => {
    const swContent = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
    assert.ok(swContent.includes("self.addEventListener('push'"), 'SW maneja evento push');
    assert.ok(swContent.includes("self.addEventListener('notificationclick'"), 'SW maneja notificationclick');
    assert.ok(swContent.includes('showNotification'), 'SW muestra notificación con opciones');
    assert.ok(swContent.includes('client.focus()'), 'SW enfoca ventana abierta al pulsar');
    assert.ok(swContent.includes('clients.openWindow'), 'SW abre ventana si no existe');
  });
});
