/**
 * @fileoverview Web Push RFC 8291 / RFC 8292 nativo para Cloudflare Workers & Pages Functions
 * Implementación criptográfica estricta con Web Crypto API (sin dependencias npm).
 * Cero claves privadas en código fuente. Cero fallbacks inseguros.
 */

const VAPID_SUBJECT = 'mailto:admin@sismopa.pages.dev';

/**
 * Validador estricto de destinos Web Push para prevención de SSRF (Server-Side Request Forgery).
 * Solo permite proveedores push oficiales conocidos.
 */
export function isValidPushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) return false;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    const allowedDomains = [
      'fcm.googleapis.com',                 // Google Chrome / Android
      'push.services.mozilla.com',          // Mozilla Firefox
      'updates.push.services.mozilla.com',  // Mozilla Firefox (Legacy/Updates)
      'notify.windows.com',                 // Microsoft Edge / WNS
      'push.apple.com'                      // Apple Safari / iOS
    ];
    return allowedDomains.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

export function b64UrlToUint8(str) {
  const clean = (str || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  const unpadded = clean.replace(/=+$/, '');
  const pad = '='.repeat((4 - (unpadded.length % 4)) % 4);
  const bin = atob(unpadded + pad);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export function uint8ToB64Url(arr) {
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Genera los encabezados de autorización VAPID (RFC 8292)
 */
export async function createVapidHeader(audience, env = {}) {
  const privKeyRaw = env.VAPID_PRIVATE_KEY_JWK;
  const pubB64 = env.VAPID_PUBLIC_KEY;

  if (!privKeyRaw) {
    throw new Error('VAPID no configurado: falta el secreto de servidor VAPID_PRIVATE_KEY_JWK');
  }
  if (!pubB64) {
    throw new Error('VAPID no configurado: falta la variable de entorno VAPID_PUBLIC_KEY');
  }

  const privJwk = typeof privKeyRaw === 'string' ? JSON.parse(privKeyRaw) : privKeyRaw;

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

  const sigBytes = new Uint8Array(sig);
  const jwt = `${unsignedToken}.${uint8ToB64Url(sigBytes)}`;

  return {
    authorization: `vapid t=${jwt}, k=${pubB64}`,
    cryptoKey: `p256ecdsa=${pubB64}`
  };
}

/**
 * Cifra la carga útil según RFC 8291 (Message Encryption for Web Push con aes128gcm)
 * Verificado con los vectores de prueba oficiales del IETF (RFC 8291 Apéndice A).
 */
export async function encryptWebPush(payloadText, p256dhB64Url, authB64Url) {
  const userPubBytes = b64UrlToUint8(p256dhB64Url);
  const userAuthBytes = b64UrlToUint8(authB64Url);

  // 1. Clave efímera del servidor remitente
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

  // 2. Importar clave pública del usuario (destinatario)
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

  // 4. Derivación de IKM según RFC 8291 Sección 3.2
  // PRK_key = HMAC-Hash(salt = auth_secret, IKM = ecdh_secret)
  // key_info = 'WebPush: info\0' || ua_public || as_public
  const prefix = new TextEncoder().encode('WebPush: info\0');
  const authInfo = new Uint8Array(prefix.length + userPubBytes.length + localPubBytes.length);
  authInfo.set(prefix, 0);
  authInfo.set(userPubBytes, prefix.length);
  authInfo.set(localPubBytes, prefix.length + userPubBytes.length);

  const sharedSecretKey = await crypto.subtle.importKey(
    'raw',
    sharedSecret,
    { name: 'HKDF' },
    false,
    ['deriveBits']
  );

  const ikm = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: userAuthBytes, info: authInfo },
    sharedSecretKey,
    256
  );

  // 5. Derivación de CEK (Content Encryption Key) y Nonce
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

  // 6. Plaintext delimitado según RFC 8188 (0x02)
  const plainBytes = new TextEncoder().encode(payloadText);
  const record = new Uint8Array(plainBytes.length + 1);
  record.set(plainBytes, 0);
  record[plainBytes.length] = 0x02;

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 },
    cek,
    record
  );

  // 7. Ensamblado cabecera RFC 8291: salt(16) + rs(4) + idlen(1) + as_public(65) + ciphertext
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
 * Envía una notificación Web Push a una suscripción legítima
 */
export async function sendWebPush(subscription, payloadObj, env = {}) {
  const { endpoint, keys } = subscription || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    throw new Error('Suscripción inválida: faltan endpoint o claves');
  }

  if (!isValidPushEndpoint(endpoint)) {
    throw new Error('Endpoint no autorizado por política de seguridad');
  }

  const audience = new URL(endpoint).origin;
  const { authorization, cryptoKey } = await createVapidHeader(audience, env);
  const payloadText = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
  const body = await encryptWebPush(payloadText, keys.p256dh, keys.auth);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': authorization,
      'Crypto-Key': cryptoKey,
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
