/**
 * sismoPA — Despacho oficial FCM HTTP v1 para Cloudflare Workers Free.
 *
 * Implementa autenticación OAuth 2.0 mediante RS256 usando Web Crypto API nativo
 * sin dependencias externas pesadas, respetando el presupuesto de subrequests y CPU.
 */

let _cachedOAuthToken = null;
let _cachedTokenExpiry = 0;

/**
 * Convierte una clave PEM PKCS#8 en un ArrayBuffer binario.
 */
function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/[\r\n\s]/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64UrlEncode(strOrBuffer) {
  let b64;
  if (typeof strOrBuffer === 'string') {
    b64 = btoa(unescape(encodeURIComponent(strOrBuffer)));
  } else {
    const bytes = new Uint8Array(strOrBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    b64 = btoa(binary);
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Obtiene un Access Token de Google OAuth 2.0 válido por 1 hora.
 * Utiliza caché en memoria para consumir a lo sumo 1 subrequest por hora.
 */
export async function getGoogleOAuthToken(serviceAccount, customFetch = fetch) {
  const nowSec = Math.floor(Date.now() / 1000);

  // Reutilizar token si le quedan más de 5 minutos de vigencia
  if (_cachedOAuthToken && _cachedTokenExpiry > nowSec + 300) {
    return _cachedOAuthToken;
  }

  const { client_email, private_key, token_uri = 'https://oauth2.googleapis.com/token' } = serviceAccount;
  if (!client_email || !private_key) {
    throw new Error('Credenciales de cuenta de servicio de Firebase incompletas (falta client_email o private_key)');
  }

  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: client_email,
    sub: client_email,
    aud: token_uri,
    iat: nowSec,
    exp: nowSec + 3600,
    scope: 'https://www.googleapis.com/auth/firebase.messaging'
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaims = base64UrlEncode(JSON.stringify(claims));
  const unsignedToken = `${encodedHeader}.${encodedClaims}`;

  const binaryKey = pemToArrayBuffer(private_key);
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    binaryKey,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(unsignedToken)
  );

  const signedJwt = `${unsignedToken}.${base64UrlEncode(signature)}`;

  const res = await customFetch(token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedJwt}`
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`Error obteniendo OAuth Token de Google: ${res.status} ${JSON.stringify(data)}`);
  }

  _cachedOAuthToken = data.access_token;
  _cachedTokenExpiry = nowSec + (data.expires_in || 3600);
  return _cachedOAuthToken;
}

/**
 * Resetea el caché de OAuth (para pruebas unitarias).
 */
export function _resetOAuthCache() {
  _cachedOAuthToken = null;
  _cachedTokenExpiry = 0;
}

/**
 * Determina si un error HTTP de FCM es de carácter transitorio y reintentable.
 */
export function isRetryableFcmStatus(status) {
  return status === 429 || status >= 500;
}

/**
 * Envía una notificación masiva al topic FCM de sismoPA.
 * Soporta firma posicional (serviceAccount, topic, sismoPayload, customFetch)
 * o firma por objeto de opciones ({ serviceAccount, topic, payload, customFetch }).
 * Consume EXACTAMENTE 1 subrequest hacia Google FCM para todos los usuarios Android suscritos.
 */
export async function sendFcmTopicMessage(arg1, arg2, arg3, arg4) {
  let serviceAccount, topic, sismoPayload, customFetch;
  if (arg1 && typeof arg1 === 'object' && !arg1.client_email && (arg1.serviceAccount || arg1.topic || arg1.payload)) {
    serviceAccount = arg1.serviceAccount;
    topic = arg1.topic || 'sismos_panama';
    sismoPayload = arg1.payload || arg1.sismoPayload || {};
    customFetch = arg1.customFetch || fetch;
  } else {
    serviceAccount = arg1;
    topic = arg2 || 'sismos_panama';
    sismoPayload = arg3 || {};
    customFetch = arg4 || fetch;
  }

  if (!serviceAccount) {
    throw new Error('Faltan credenciales de cuenta de servicio de Firebase');
  }

  const projectId = serviceAccount.project_id || (arg1 && arg1.projectId) || 'sismopa-notificaciones';
  if (!projectId) {
    throw new Error('Falta project_id en la configuración de Firebase');
  }

  let accessToken;
  try {
    accessToken = await getGoogleOAuthToken(serviceAccount, customFetch);
  } catch (oauthErr) {
    return {
      ok: false,
      status: 401,
      oauthError: true,
      retryable: false,
      ambiguous: false,
      error: `Error de autenticación OAuth 2.0: ${oauthErr.message}`,
      details: { name: oauthErr.name, message: oauthErr.message }
    };
  }

  const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  const title = sismoPayload.title || `Sismo M ${sismoPayload.magnitud || '?'} - ${sismoPayload.lugar || 'Panamá'}`;
  const body = sismoPayload.body || `Prof: ${sismoPayload.profundidad || '?'} km | ${sismoPayload.hora_local || ''}. Toque para ver detalles.`;

  // Mensaje de datos de alta prioridad (Data-Only Message).
  // Evita que Firebase SDK y el sistema Android creen una notificación automática duplicada
  // cuando la app está en segundo plano o cerrada, delegando 100% el control a SismoFirebaseMessagingService.
  const message = {
    message: {
      topic: topic.replace(/^\/topics\//, ''),
      data: {
        source_uid: String(sismoPayload.source_uid || ''),
        magnitud: String(sismoPayload.magnitud || ''),
        latitud: String(sismoPayload.latitud || ''),
        longitud: String(sismoPayload.longitud || ''),
        lugar: String(sismoPayload.lugar || sismoPayload.ubicacion || ''),
        ubicacion: String(sismoPayload.ubicacion || sismoPayload.lugar || ''),
        profundidad: String(sismoPayload.profundidad || sismoPayload.profundidad_km || ''),
        hora_local: String(sismoPayload.hora_local || ''),
        url: String(sismoPayload.url || `https://sismopa.pages.dev/?sismo=${sismoPayload.source_uid || ''}`),
        title,
        body
      },
      android: {
        priority: 'high'
      }
    }
  };

  let res;
  try {
    res = await customFetch(fcmUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(message)
    });
  } catch (netErr) {
    // Error de red, caída de socket o timeout mientras se esperaba la respuesta de Google FCM.
    // Esto es un resultado de entrega AMBIGUO: Google pudo haber recibido el mensaje y
    // comenzado la distribución masiva al topic. Reintentar podría duplicar el aviso nacional.
    return {
      ok: false,
      status: 0,
      ambiguous: true,
      retryable: false,
      error: `Error de red con Google FCM (entrega ambigua): ${netErr.message}`,
      details: { name: netErr.name, message: netErr.message }
    };
  }

  const resData = await res.json().catch(() => ({}));

  if (!res.ok) {
    const retryAfterHeader = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
    return {
      ok: false,
      status: res.status,
      retryable: isRetryableFcmStatus(res.status),
      ambiguous: false,
      retryAfter: retryAfterHeader,
      error: resData.error?.message || `FCM Error HTTP ${res.status}`,
      details: resData
    };
  }

  return {
    ok: true,
    status: 200,
    ambiguous: false,
    messageId: resData.name
  };
}

/**
 * Envía una notificación directa a un dispositivo específico por token FCM (para pruebas individuales).
 * Soporta firma posicional (serviceAccount, token, sismoPayload, customFetch)
 * o firma por objeto de opciones ({ serviceAccount, deviceToken, payload, customFetch }).
 */
export async function sendFcmDirectMessage(arg1, arg2, arg3, arg4) {
  let serviceAccount, token, sismoPayload, customFetch;
  if (arg1 && typeof arg1 === 'object' && !arg1.client_email && (arg1.serviceAccount || arg1.deviceToken || arg1.token || arg1.payload)) {
    serviceAccount = arg1.serviceAccount;
    token = arg1.deviceToken || arg1.token;
    sismoPayload = arg1.payload || arg1.sismoPayload || {};
    customFetch = arg1.customFetch || fetch;
  } else {
    serviceAccount = arg1;
    token = arg2;
    sismoPayload = arg3 || {};
    customFetch = arg4 || fetch;
  }

  if (!serviceAccount) {
    throw new Error('Faltan credenciales de cuenta de servicio de Firebase');
  }
  if (!token) {
    throw new Error('Falta el token de registro del dispositivo objetivo');
  }

  const projectId = serviceAccount.project_id || (arg1 && arg1.projectId) || 'sismopa-notificaciones';
  if (!projectId) {
    throw new Error('Falta project_id en la configuración de Firebase');
  }

  let accessToken;
  try {
    accessToken = await getGoogleOAuthToken(serviceAccount, customFetch);
  } catch (oauthErr) {
    return {
      ok: false,
      status: 401,
      oauthError: true,
      retryable: false,
      ambiguous: false,
      error: `Error de autenticación OAuth 2.0: ${oauthErr.message}`,
      details: { name: oauthErr.name, message: oauthErr.message }
    };
  }

  const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  const title = sismoPayload.title || `[PRUEBA] sismoPA — Notificación nativa`;
  const body = sismoPayload.body || `Prueba de recepción de alertas sísmicas en Android sin intermediación de navegador.`;

  const message = {
    message: {
      token: token.trim(),
      data: {
        source_uid: String(sismoPayload.source_uid || 'TEST_FCM'),
        magnitud: String(sismoPayload.magnitud || ''),
        latitud: String(sismoPayload.latitud || ''),
        longitud: String(sismoPayload.longitud || ''),
        lugar: String(sismoPayload.lugar || sismoPayload.ubicacion || ''),
        ubicacion: String(sismoPayload.ubicacion || sismoPayload.lugar || ''),
        url: String(sismoPayload.url || 'https://sismopa.pages.dev/'),
        title,
        body
      },
      android: {
        priority: 'high'
      }
    }
  };

  let res;
  try {
    res = await customFetch(fcmUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify(message)
    });
  } catch (netErr) {
    return {
      ok: false,
      status: 0,
      ambiguous: true,
      retryable: false,
      error: `Error de red con Google FCM (entrega ambigua): ${netErr.message}`,
      details: { name: netErr.name, message: netErr.message }
    };
  }

  const resData = await res.json().catch(() => ({}));
  if (!res.ok) {
    const retryAfterHeader = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
    return {
      ok: false,
      status: res.status,
      retryable: isRetryableFcmStatus(res.status),
      ambiguous: false,
      retryAfter: retryAfterHeader,
      error: resData.error?.message || `FCM Error HTTP ${res.status}`,
      details: resData
    };
  }

  return {
    ok: true,
    status: 200,
    ambiguous: false,
    messageId: resData.name
  };
}
