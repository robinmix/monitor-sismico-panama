/**
 * @fileoverview Web Push RFC 8291 / RFC 8292 nativo para Cloudflare Workers & Pages Functions
 * Implementación criptográfica estricta con Web Crypto API (sin dependencias npm).
 * Diagnóstico seguro por fases. Cero claves privadas en logs o respuestas.
 */

const VAPID_SUBJECT = 'mailto:rbtservices507@gmail.com';

export class WebPushError extends Error {
  constructor(phase, code, message, originalError = null) {
    super(message);
    this.name = 'WebPushError';
    this.phase = phase;
    this.code = code;
    if (originalError && originalError.stack) {
      this.stack = `${this.name}: ${message} (${phase}:${code})\nCaused by: ${originalError.stack}`;
    }
  }
}

/**
 * Validador estricto de destinos Web Push para prevención de SSRF (Server-Side Request Forgery).
 * Solo permite proveedores push oficiales reconocidos.
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
 * Parsea y normaliza un JWK privado de forma segura, admitiendo strings simples,
 * dobles escapes de JSON o caracteres de envoltura accidentales.
 */
export function parsePrivateJwkSafely(privKeyRaw) {
  if (!privKeyRaw) {
    throw new WebPushError(
      'PHASE_1_VAPID_CONFIG',
      'VAPID_PRIVATE_KEY_MISSING',
      'Falta la variable/secreto VAPID_PRIVATE_KEY_JWK en el entorno de Cloudflare'
    );
  }

  let jwk = privKeyRaw;
  if (typeof jwk === 'string') {
    jwk = jwk.trim();
    // Eliminar posibles comillas simples o envoltorios
    if (jwk.startsWith("'") && jwk.endsWith("'")) {
      jwk = jwk.slice(1, -1).trim();
    }
    try {
      jwk = JSON.parse(jwk);
      // Caso de doble stringificación en Cloudflare secrets
      if (typeof jwk === 'string') {
        jwk = JSON.parse(jwk.trim());
      }
    } catch (err) {
      throw new WebPushError(
        'PHASE_2_VAPID_PARSE',
        'VAPID_JWK_JSON_INVALID',
        `No se pudo parsear el JSON de VAPID_PRIVATE_KEY_JWK: ${err.message}`,
        err
      );
    }
  }

  if (!jwk || typeof jwk !== 'object') {
    throw new WebPushError(
      'PHASE_2_VAPID_PARSE',
      'VAPID_JWK_NOT_OBJECT',
      'El secreto VAPID_PRIVATE_KEY_JWK no produjo un objeto JWK válido tras su lectura'
    );
  }

  // Normalizar parámetros estrictos para WebCrypto P-256 ECDSA
  const cleanX = typeof jwk.x === 'string' ? jwk.x.trim() : '';
  const cleanY = typeof jwk.y === 'string' ? jwk.y.trim() : '';
  const cleanD = typeof jwk.d === 'string' ? jwk.d.trim() : '';

  if (!cleanX || !cleanY || !cleanD) {
    throw new WebPushError(
      'PHASE_2_VAPID_PARSE',
      'VAPID_JWK_COORDINATES_MISSING',
      'El JWK privado carece de alguna de las coordenadas obligatorias x, y o d'
    );
  }

  return {
    kty: 'EC',
    crv: 'P-256',
    x: cleanX,
    y: cleanY,
    d: cleanD,
    ext: true
  };
}

/**
 * Genera los encabezados de autorización VAPID (RFC 8292) con diagnósticos seguros.
 */
export async function createVapidHeader(audience, env = {}) {
  const pubRaw = env.VAPID_PUBLIC_KEY;
  if (!pubRaw) {
    throw new WebPushError(
      'PHASE_1_VAPID_CONFIG',
      'VAPID_PUBLIC_KEY_MISSING',
      'Falta la variable de entorno VAPID_PUBLIC_KEY en Cloudflare'
    );
  }

  let pubB64 = String(pubRaw).trim();
  if ((pubB64.startsWith('"') && pubB64.endsWith('"')) || (pubB64.startsWith("'") && pubB64.endsWith("'"))) {
    pubB64 = pubB64.slice(1, -1).trim();
  }

  const normalizedJwk = parsePrivateJwkSafely(env.VAPID_PRIVATE_KEY_JWK);

  // Fase 3: Importación criptográfica de la clave privada VAPID
  let key;
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      normalizedJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
  } catch (err) {
    throw new WebPushError(
      'PHASE_3_VAPID_IMPORT',
      'ECDSA_PRIVATE_IMPORT_FAILED',
      `Fallo al importar clave privada VAPID en WebCrypto (${err.name}: ${err.message})`,
      err
    );
  }

  // Fase 4: Creación y firma del JWT ES256
  let unsignedToken;
  let sig;
  try {
    const header = { typ: 'JWT', alg: 'ES256' };
    const claims = {
      aud: audience,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: env.VAPID_SUBJECT || VAPID_SUBJECT
    };

    const enc = (obj) => uint8ToB64Url(new TextEncoder().encode(JSON.stringify(obj)));
    unsignedToken = `${enc(header)}.${enc(claims)}`;

    sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(unsignedToken)
    );
  } catch (err) {
    throw new WebPushError(
      'PHASE_4_VAPID_SIGN',
      'ES256_SIGNATURE_FAILED',
      `Fallo al firmar el token JWT VAPID con ES256 (${err.name}: ${err.message})`,
      err
    );
  }

  const sigBytes = new Uint8Array(sig);
  const jwt = `${unsignedToken}.${uint8ToB64Url(sigBytes)}`;

  // Según RFC 8292 estándar final, Authorization vapid t=..., k=... es el formato canónico
  return {
    authorization: `vapid t=${jwt}, k=${pubB64}`
  };
}

/**
 * Cifra la carga útil según RFC 8291 (Message Encryption for Web Push con aes128gcm)
 * con diagnóstico por fases.
 */
export async function encryptWebPush(payloadText, p256dhB64Url, authB64Url) {
  // Fase 5: Decodificación y validación de claves del destinatario
  let userPubBytes;
  let userAuthBytes;
  try {
    userPubBytes = b64UrlToUint8(p256dhB64Url);
    userAuthBytes = b64UrlToUint8(authB64Url);
  } catch (err) {
    throw new WebPushError(
      'PHASE_5_USER_KEY_DECODE',
      'BASE64_DECODE_FAILED',
      `Error al decodificar claves de suscripción en base64url (${err.message})`,
      err
    );
  }

  if (userPubBytes.length !== 65 || userPubBytes[0] !== 0x04) {
    throw new WebPushError(
      'PHASE_5_USER_KEY_DECODE',
      'INVALID_P256DH_FORMAT',
      `Clave p256dh inválida: longitud esperada 65 bytes (0x04 uncompressed), recibidos ${userPubBytes.length} bytes`
    );
  }

  if (userAuthBytes.length !== 16) {
    throw new WebPushError(
      'PHASE_5_USER_KEY_DECODE',
      'INVALID_AUTH_FORMAT',
      `Clave auth inválida: longitud esperada 16 bytes, recibidos ${userAuthBytes.length} bytes`
    );
  }

  // Fase 6: Generación de clave efímera del remitente
  let localKeyPair;
  let localPubBytes;
  try {
    localKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );

    const localPubRaw = await crypto.subtle.exportKey('raw', localKeyPair.publicKey);
    localPubBytes = new Uint8Array(localPubRaw);
  } catch (err) {
    throw new WebPushError(
      'PHASE_6_ECDH_KEY_GEN',
      'EPHEMERAL_KEY_FAILED',
      `Error generando clave efímera ECDH P-256 (${err.name}: ${err.message})`,
      err
    );
  }

  // Fase 7: Importación de clave pública del destinatario
  let userKey;
  try {
    userKey = await crypto.subtle.importKey(
      'raw',
      userPubBytes,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );
  } catch (err) {
    throw new WebPushError(
      'PHASE_7_USER_KEY_IMPORT',
      'USER_PUBKEY_IMPORT_FAILED',
      `Error al importar clave pública de usuario para ECDH (${err.name}: ${err.message})`,
      err
    );
  }

  // Fase 8: Derivación de secreto compartido ECDH
  let sharedSecret;
  try {
    sharedSecret = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: userKey },
      localKeyPair.privateKey,
      256
    );
  } catch (err) {
    throw new WebPushError(
      'PHASE_8_ECDH_DERIVE',
      'ECDH_DERIVATION_FAILED',
      `Error al derivar secreto compartido ECDH (${err.name}: ${err.message})`,
      err
    );
  }

  // Fase 9: Derivación de IKM según RFC 8291 Sección 3.2
  // PRK_key = HMAC-Hash(salt = auth_secret, IKM = ecdh_secret)
  // key_info = 'WebPush: info\0' || ua_public || as_public
  let ikm;
  try {
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

    ikm = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: userAuthBytes, info: authInfo },
      sharedSecretKey,
      256
    );
  } catch (err) {
    throw new WebPushError(
      'PHASE_9_HKDF_DERIVE',
      'IKM_DERIVATION_FAILED',
      `Error en derivación HKDF de IKM RFC 8291 (${err.name}: ${err.message})`,
      err
    );
  }

  // Fase 10: Derivación de CEK y Nonce
  let salt;
  let cek;
  let nonce;
  try {
    salt = crypto.getRandomValues(new Uint8Array(16));
    const ikmKey = await crypto.subtle.importKey(
      'raw',
      ikm,
      { name: 'HKDF' },
      false,
      ['deriveBits', 'deriveKey']
    );

    cek = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('Content-Encoding: aes128gcm\0') },
      ikmKey,
      { name: 'AES-GCM', length: 128 },
      false,
      ['encrypt']
    );

    nonce = await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('Content-Encoding: nonce\0') },
      ikmKey,
      96
    );
  } catch (err) {
    throw new WebPushError(
      'PHASE_10_AES_DERIVE',
      'CEK_NONCE_DERIVATION_FAILED',
      `Error al derivar CEK o Nonce para AES-GCM (${err.name}: ${err.message})`,
      err
    );
  }

  // Fase 11: Cifrado simétrico AES-GCM-128 con delimitador de registro 0x02
  let ciphertext;
  try {
    const plainBytes = new TextEncoder().encode(payloadText);
    const record = new Uint8Array(plainBytes.length + 1);
    record.set(plainBytes, 0);
    record[plainBytes.length] = 0x02;

    ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, tagLength: 128 },
      cek,
      record
    );
  } catch (err) {
    throw new WebPushError(
      'PHASE_11_AES_ENCRYPT',
      'AES_GCM_ENCRYPT_FAILED',
      `Error al cifrar el payload con AES-GCM-128 (${err.name}: ${err.message})`,
      err
    );
  }

  // Fase 12: Ensamblado binario de cabecera RFC 8291
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
 * Envía una notificación Web Push a una suscripción con diagnósticos completos.
 */
export async function sendWebPush(subscription, payloadObj, env = {}) {
  const { endpoint, keys } = subscription || {};
  if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
    throw new WebPushError(
      'PHASE_5_USER_KEY_DECODE',
      'SUBSCRIPTION_PAYLOAD_INVALID',
      'Suscripción inválida: faltan endpoint o claves p256dh/auth'
    );
  }

  if (!isValidPushEndpoint(endpoint)) {
    throw new WebPushError(
      'PHASE_13_PUSH_DISPATCH',
      'ENDPOINT_NOT_PERMITTED',
      'Endpoint no permitido por política de seguridad SSRF'
    );
  }

  const audience = new URL(endpoint).origin;
  const { authorization } = await createVapidHeader(audience, env);
  const payloadText = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
  const body = await encryptWebPush(payloadText, keys.p256dh, keys.auth);

  // Convertir Uint8Array a ArrayBuffer estándar para máxima compatibilidad con Fetch API
  const payloadArrayBuffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);

  let res;
  try {
    const timeoutMs = Number(env?.PUSH_NETWORK_TIMEOUT_MS) || 8000;
    const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined;

    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': '86400',
        'Urgency': 'high'
      },
      body: payloadArrayBuffer,
      signal
    });
  } catch (err) {
    throw new WebPushError(
      'PHASE_13_PUSH_DISPATCH',
      'PROVIDER_NETWORK_ERROR',
      `Fallo de conexión de red con el proveedor push (${err.name}: ${err.message})`,
      err
    );
  }

  const providerResponseText = await res.text().catch(() => '');

  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    expired: res.status === 404 || res.status === 410,
    authError: res.status === 401 || res.status === 403,
    retryAfter: res.headers ? res.headers.get('Retry-After') : null,
    providerDetail: providerResponseText ? providerResponseText.slice(0, 200).trim() : ''
  };
}
