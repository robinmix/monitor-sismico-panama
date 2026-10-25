/**
 * @fileoverview Web Push RFC 8291 / RFC 8292 nativo para Cloudflare Workers
 * Implementación criptográfica completa con Web Crypto API (sin dependencias npm).
 */

const VAPID_SUBJECT = 'mailto:admin@sismopa.pages.dev';

// Claves VAPID por defecto (pueden ser sobrescritas por variables de entorno)
export const DEFAULT_VAPID_KEYS = {
  publicKey: 'BOkJ0YIiK-7MQsdojNxZ0X6gVaa-ONOUyrd7rBMbKuZ-GaivoJtKmMXzoziLS80qjUz_fjpXbktjQIv7yB8bIK4',
  privateKeyJwk: {
    kty: 'EC',
    crv: 'P-256',
    x: '6QnRgiIr7sxCx2iM3FnRfqBVpr4405TKt3usExsq5n4',
    y: 'GaivoJtKmMXzoziLS80qjUz_fjpXbktjQIv7yB8bIK4',
    d: 'OWkJpmFPF2k2I-PSGqYluXq0IewUhvGjxWmIUjEuLMs'
  }
};

function b64UrlToUint8(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.padEnd(b64.length + (4 - b64.length % 4) % 4, '=');
  const bin = atob(pad);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function uint8ToB64Url(arr) {
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Genera el encabezado de autorización VAPID (RFC 8292)
 */
export async function createVapidHeader(audience, env = {}) {
  const privJwk = env.VAPID_PRIVATE_KEY_JWK
    ? JSON.parse(env.VAPID_PRIVATE_KEY_JWK)
    : DEFAULT_VAPID_KEYS.privateKeyJwk;
  const pubB64 = env.VAPID_PUBLIC_KEY || DEFAULT_VAPID_KEYS.publicKey;

  const key = await crypto.subtle.importKey(
    'jwk',
    privJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || VAPID_SUBJECT
  };

  const enc = (obj) => uint8ToB64Url(new TextEncoder().encode(JSON.stringify(obj)));
  const unsignedToken = `${enc(header)}.${enc(claims)}`;

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(unsignedToken)
  );

  // Convert DER/IEEE signature to raw R||S 64-byte format if necessary
  const sigBytes = new Uint8Array(sig);
  let rawSig = sigBytes;
  if (sigBytes[0] === 0x30) {
    // DER format -> raw 64 bytes
    let offset = 2;
    if (sigBytes[1] & 0x80) offset += (sigBytes[1] & 0x7f);
    offset++; // 0x02
    const rLen = sigBytes[offset++];
    const r = sigBytes.slice(offset, offset + rLen);
    offset += rLen;
    offset++; // 0x02
    const sLen = sigBytes[offset++];
    const s = sigBytes.slice(offset, offset + sLen);

    rawSig = new Uint8Array(64);
    rawSig.set(r.length > 32 ? r.slice(r.length - 32) : r, 32 - Math.min(32, r.length));
    rawSig.set(s.length > 32 ? s.slice(s.length - 32) : s, 64 - Math.min(32, s.length));
  }

  const jwt = `${unsignedToken}.${uint8ToB64Url(rawSig)}`;
  return `vapid t=${jwt}, k=${pubB64}`;
}

/**
 * Cifra la carga útil según RFC 8291 (Message Encryption for Web Push con aes128gcm)
 */
export async function encryptWebPush(payloadText, p256dhB64Url, authB64Url) {
  const userPubBytes = b64UrlToUint8(p256dhB64Url);
  const userAuthBytes = b64UrlToUint8(authB64Url);

  // 1. Clave efímera del remitente
  const localKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  const localPubJwk = await crypto.subtle.exportKey('jwk', localKeyPair.publicKey);
  const localPubX = b64UrlToUint8(localPubJwk.x);
  const localPubY = b64UrlToUint8(localPubJwk.y);
  const localPubBytes = new Uint8Array(65);
  localPubBytes[0] = 0x04;
  localPubBytes.set(localPubX, 1);
  localPubBytes.set(localPubY, 33);

  // 2. Importar clave pública del usuario
  const userPubJwk = {
    kty: 'EC',
    crv: 'P-256',
    x: uint8ToB64Url(userPubBytes.slice(1, 33)),
    y: uint8ToB64Url(userPubBytes.slice(33, 65))
  };
  const userKey = await crypto.subtle.importKey(
    'jwk',
    userPubJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );

  // 3. ECDH shared secret
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: userKey },
    localKeyPair.privateKey,
    256
  );

  // 4. HKDF info context
  const authInfo = new Uint8Array([
    ...new TextEncoder().encode('WebPush: info\0'),
    ...userPubBytes,
    ...localPubBytes
  ]);

  const authKey = await crypto.subtle.importKey(
    'raw',
    userAuthBytes,
    { name: 'HKDF' },
    false,
    ['deriveBits']
  );

  const ikm = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(sharedSecret), info: authInfo },
    authKey,
    256
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey(
    'raw',
    ikm,
    { name: 'HKDF' },
    false,
    ['deriveBits', 'deriveKey']
  );

  const cek = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('Content-Encoding: aes128gcm\0') },
    ikmKey,
    { name: 'AES-GCM', length: 128 },
    false,
    ['encrypt']
  );

  const nonce = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('Content-Encoding: nonce\0') },
    ikmKey,
    96
  );

  // 5. Plaintext con delimitador de registro 0x02
  const plainBytes = new TextEncoder().encode(payloadText);
  const record = new Uint8Array(plainBytes.length + 1);
  record.set(plainBytes, 0);
  record[plainBytes.length] = 0x02; // delimiter

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    cek,
    record
  );

  // 6. Ensamblado de cabecera RFC 8291: salt(16) + rs(4) + idlen(1) + keyid(65) + ciphertext
  const recordSize = 4096;
  const rsBytes = new Uint8Array([
    (recordSize >> 24) & 0xff,
    (recordSize >> 16) & 0xff,
    (recordSize >> 8) & 0xff,
    recordSize & 0xff
  ]);

  const body = new Uint8Array(16 + 4 + 1 + 65 + ciphertext.byteLength);
  body.set(salt, 0);
  body.set(rsBytes, 16);
  body[20] = 65;
  body.set(localPubBytes, 21);
  body.set(new Uint8Array(ciphertext), 86);

  return body;
}

/**
 * Envía una notificación Web Push a una suscripción
 */
export async function sendWebPush(subscription, payloadObj, env = {}) {
  const { endpoint, keys } = subscription;
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    throw new Error('Suscripción inválida: faltan endpoint o claves');
  }

  const audience = new URL(endpoint).origin;
  const vapidHeader = await createVapidHeader(audience, env);
  const payloadText = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
  const body = await encryptWebPush(payloadText, keys.p256dh, keys.auth);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': vapidHeader,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '86400',
      'Urgency': 'high'
    },
    body
  });

  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    expired: res.status === 404 || res.status === 410
  };
}
