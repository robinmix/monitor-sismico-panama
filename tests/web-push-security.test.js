'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { webcrypto } = require('crypto');
const crypto = webcrypto;

test('Web Push Security & Delivery Suite', async (t) => {
  const webPushMod = await import('../cloudflare/lib/web-push.mjs');
  const {
    isValidPushEndpoint,
    b64UrlToUint8,
    uint8ToB64Url,
    createVapidHeader,
    encryptWebPush,
    sendWebPush
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

  await t.test('3. VAPID: Falla limpiamente si no están configurados los secretos de servidor', async () => {
    await assert.rejects(
      async () => createVapidHeader('https://fcm.googleapis.com', {}),
      /VAPID_PRIVATE_KEY_JWK/
    );

    await assert.rejects(
      async () => createVapidHeader('https://fcm.googleapis.com', { VAPID_PRIVATE_KEY_JWK: '{}' }),
      /VAPID_PUBLIC_KEY/
    );
  });

  await t.test('4. Criptografía: Verificación RFC 8291 con vectores oficiales IETF (Apéndice A)', async () => {
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

    const userPubJwk = {
      kty: 'EC', crv: 'P-256',
      x: uint8ToB64Url(userPubBytes.slice(1, 33)),
      y: uint8ToB64Url(userPubBytes.slice(33, 65))
    };
    const userKey = await crypto.subtle.importKey('jwk', userPubJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);

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

  await t.test('5. VAPID: Firma JWT y verificación ES256 válida con par P-256', async () => {
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

    const { authorization, cryptoKey } = await createVapidHeader('https://fcm.googleapis.com', env);
    assert.ok(authorization.startsWith('vapid t='));
    assert.ok(cryptoKey.startsWith('p256ecdsa='));

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

  await t.test('6. Endpoint /api/push-vapid-key: responde 503 sin clave y 200 con clave', async () => {
    const resNoKey = await vapidMod.onRequest({ request: new Request('https://sismopa.pages.dev/api/push-vapid-key'), env: {} });
    assert.equal(resNoKey.status, 503);

    const resKey = await vapidMod.onRequest({
      request: new Request('https://sismopa.pages.dev/api/push-vapid-key'),
      env: { VAPID_PUBLIC_KEY: 'TEST_KEY' }
    });
    assert.equal(resKey.status, 200);
    const data = await resKey.json();
    assert.equal(data.vapidPublicKey, 'TEST_KEY');
  });

  await t.test('7. Respuestas del proveedor Web Push: 201, 400, 401, 403, 404, 410, 429', async () => {
    const origFetch = globalThis.fetch;
    const testCases = [
      { status: 201, expectedOk: true, expectedExpired: false },
      { status: 400, expectedOk: false, expectedExpired: false },
      { status: 401, expectedOk: false, expectedExpired: false },
      { status: 403, expectedOk: false, expectedExpired: false },
      { status: 404, expectedOk: false, expectedExpired: true },
      { status: 410, expectedOk: false, expectedExpired: true },
      { status: 429, expectedOk: false, expectedExpired: false }
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
      globalThis.fetch = async () => new Response(null, { status: tc.status });
      const res = await sendWebPush(dummySub, { title: 'Test' }, env);
      assert.equal(res.ok, tc.expectedOk, `Status ${tc.status} expected ok=${tc.expectedOk}`);
      assert.equal(res.status, tc.status);
      assert.equal(res.expired, tc.expectedExpired, `Status ${tc.status} expected expired=${tc.expectedExpired}`);
    }

    globalThis.fetch = origFetch;
  });

  await t.test('8. Endpoints /api/push-subscribe y /api/push-test rechazan métodos y URLs maliciosas', async () => {
    // Método no permitido en subscribe
    const resGetSub = await subMod.onRequest({ request: new Request('https://sismopa.pages.dev/api/push-subscribe', { method: 'GET' }), env: {} });
    assert.equal(resGetSub.status, 405);

    // SSRF en subscribe
    const resSsrfSub = await subMod.onRequest({
      request: new Request('https://sismopa.pages.dev/api/push-subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: 'https://169.254.169.254/secret' })
      }),
      env: {}
    });
    assert.equal(resSsrfSub.status, 400);

    // Método no permitido en push-test
    const resGetTest = await testMod.onRequest({ request: new Request('https://sismopa.pages.dev/api/push-test', { method: 'GET' }), env: {} });
    assert.equal(resGetTest.status, 405);

    // SSRF en push-test
    const resSsrfTest = await testMod.onRequest({
      request: new Request('https://sismopa.pages.dev/api/push-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: 'http://malicious.com' })
      }),
      env: {}
    });
    assert.equal(resSsrfTest.status, 400);
  });

  await t.test('9. Service Worker: Notificaciones push y apertura de ficha en click', () => {
    const swContent = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
    assert.ok(swContent.includes("self.addEventListener('push'"), 'SW maneja evento push');
    assert.ok(swContent.includes("self.addEventListener('notificationclick'"), 'SW maneja notificationclick');
    assert.ok(swContent.includes('showNotification'), 'SW muestra notificación con opciones');
    assert.ok(swContent.includes('client.focus()'), 'SW enfoca ventana abierta al pulsar');
    assert.ok(swContent.includes('clients.openWindow'), 'SW abre ventana si no existe');
  });
});
