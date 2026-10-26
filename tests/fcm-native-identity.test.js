'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');

test('FCM Native Identity & Architecture Suite', async (t) => {
  const fcmSubscribeMod = await import('../functions/api/fcm-subscribe.js');
  const fcmDispatchMod = await import('../cloudflare/lib/fcm-dispatch.mjs');

  const { isValidFcmToken } = fcmSubscribeMod;
  const {
    getGoogleOAuthToken,
    sendFcmTopicMessage,
    sendFcmDirectMessage,
    _resetOAuthCache
  } = fcmDispatchMod;

  await t.test('1. AndroidManifest.xml fuente declara servicios, permisos e iconos requeridos', () => {
    const manifestPath = path.join(rootDir, 'android-twa/app/src/main/AndroidManifest.xml');
    assert.ok(fs.existsSync(manifestPath), 'AndroidManifest.xml debe existir');
    const content = fs.readFileSync(manifestPath, 'utf8');

    // Permiso de notificaciones Android 13+
    assert.ok(
      content.includes('android.permission.POST_NOTIFICATIONS'),
      'Debe declarar android.permission.POST_NOTIFICATIONS'
    );

    // SismoFirebaseMessagingService nativo
    assert.ok(
      content.includes('SismoFirebaseMessagingService'),
      'Debe registrar el servicio nativo SismoFirebaseMessagingService'
    );
    assert.ok(
      content.includes('com.google.firebase.MESSAGING_EVENT'),
      'Debe incluir intent-filter para MESSAGING_EVENT'
    );

    // Fallback y delegación de navegador
    assert.ok(
      content.includes('androidx.browser.customtabs.PostMessageService'),
      'Debe declarar PostMessageService para comunicación TWA bidireccional'
    );
    assert.ok(
      content.includes('NotificationPermissionRequestActivity'),
      'Debe declarar NotificationPermissionRequestActivity para delegación segura en Android 13+'
    );

    // Icono y canal por defecto
    assert.ok(
      content.includes('@drawable/ic_notification_icon'),
      'Debe configurar ic_notification_icon como icono de notificación'
    );
    assert.ok(
      content.includes('sismo_alertas_channel'),
      'Debe configurar sismo_alertas_channel como canal por defecto'
    );
  });

  await t.test('2. Merged AndroidManifest.xml de release bundle contiene la integración completa', () => {
    const mergedManifestPath = path.join(
      rootDir,
      'android-twa/app/build/intermediates/bundle_manifest/release/processApplicationManifestReleaseForBundle/AndroidManifest.xml'
    );

    if (fs.existsSync(mergedManifestPath)) {
      const content = fs.readFileSync(mergedManifestPath, 'utf8');
      assert.ok(content.includes('android.permission.POST_NOTIFICATIONS'), 'Merged manifest debe incluir POST_NOTIFICATIONS');
      assert.ok(content.includes('pa.sismodata.app.SismoFirebaseMessagingService'), 'Merged manifest debe incluir SismoFirebaseMessagingService con paquete completo');
      assert.ok(content.includes('androidx.browser.customtabs.PostMessageService'), 'Merged manifest debe incluir PostMessageService');
      assert.ok(content.includes('com.google.androidbrowserhelper.trusted.NotificationPermissionRequestActivity'), 'Merged manifest debe incluir NotificationPermissionRequestActivity');
      assert.ok(content.includes('sismo_alertas_channel'), 'Merged manifest debe incluir sismo_alertas_channel');
    }
  });

  await t.test('3. build.gradle de app tiene versión 1.0.7, versionCode 8 y dependencias Firebase', () => {
    const gradlePath = path.join(rootDir, 'android-twa/app/build.gradle');
    assert.ok(fs.existsSync(gradlePath), 'app/build.gradle debe existir');
    const content = fs.readFileSync(gradlePath, 'utf8');

    assert.ok(content.includes('versionCode 8'), 'versionCode debe ser 8');
    assert.ok(content.includes('versionName "1.0.7"'), 'versionName debe ser 1.0.7');
    assert.ok(content.includes("id 'com.google.gms.google-services'"), 'Debe aplicar plugin com.google.gms.google-services');
    assert.ok(content.includes('firebase-bom'), 'Debe incluir Firebase BoM');
    assert.ok(content.includes('firebase-messaging'), 'Debe incluir firebase-messaging');
  });

  await t.test('4. google-services.json oficial apunta a sismopa-notificaciones y paquete pa.sismodata.app', () => {
    const gsPath = path.join(rootDir, 'android-twa/app/google-services.json');
    assert.ok(fs.existsSync(gsPath), 'google-services.json debe existir');

    const parsed = JSON.parse(fs.readFileSync(gsPath, 'utf8'));
    assert.equal(parsed.project_info?.project_id, 'sismopa-notificaciones', 'El project_id debe ser sismopa-notificaciones');
    assert.equal(parsed.project_info?.project_number, '829586447612', 'El project_number oficial debe coincidir');
    assert.ok(Array.isArray(parsed.client), 'Debe contener arreglo de clientes');

    const client = parsed.client.find(
      c => c.client_info?.android_client_info?.package_name === 'pa.sismodata.app'
    );
    assert.ok(client, 'Debe estar configurado para el paquete oficial pa.sismodata.app');
    assert.ok(client.client_info?.mobilesdk_app_id.includes('829586447612'), 'mobilesdk_app_id debe pertenecer al proyecto oficial');
  });

  await t.test('5. Clases Java nativas gestionan consentimiento voluntario, auto-init y deduplicación', () => {
    const javaDir = path.join(rootDir, 'android-twa/app/src/main/java/pa/sismodata/app');

    const fcmService = path.join(javaDir, 'SismoFirebaseMessagingService.java');
    assert.ok(fs.existsSync(fcmService), 'SismoFirebaseMessagingService.java debe existir');
    const serviceCode = fs.readFileSync(fcmService, 'utf8');
    assert.ok(serviceCode.includes('extends FirebaseMessagingService'), 'Debe heredar de FirebaseMessagingService');
    assert.ok(serviceCode.includes('isOptedIn'), 'Debe verificar consentimiento voluntario antes de procesar');
    assert.ok(serviceCode.includes('isAlreadyNotified'), 'Debe incluir deduplicación local de eventos');
    assert.ok(serviceCode.includes('markAsNotified'), 'Debe marcar sismos notificados para evitar repeticiones');
    assert.ok(serviceCode.includes('R.drawable.ic_notification_icon'), 'Debe usar ic_notification_icon');

    const notifHelper = path.join(javaDir, 'SismoNotificationHelper.java');
    assert.ok(fs.existsSync(notifHelper), 'SismoNotificationHelper.java debe existir');
    const helperCode = fs.readFileSync(notifHelper, 'utf8');
    assert.ok(helperCode.includes('sismo_alertas_channel'), 'Debe definir sismo_alertas_channel');
    assert.ok(helperCode.includes('IMPORTANCE_HIGH'), 'Debe usar importancia HIGH');

    const fcmPrefs = path.join(javaDir, 'FcmPreferences.java');
    assert.ok(fs.existsSync(fcmPrefs), 'FcmPreferences.java debe existir');
    const prefsCode = fs.readFileSync(fcmPrefs, 'utf8');
    assert.ok(prefsCode.includes('isAlreadyNotified'), 'FcmPreferences debe implementar isAlreadyNotified');

    const appCode = fs.readFileSync(path.join(javaDir, 'Application.java'), 'utf8');
    assert.ok(appCode.includes('setAutoInitEnabled'), 'Application.java debe controlar setAutoInitEnabled según consentimiento');

    const launcher = path.join(javaDir, 'LauncherActivity.java');
    assert.ok(fs.existsSync(launcher), 'LauncherActivity.java debe existir');
    const launcherCode = fs.readFileSync(launcher, 'utf8');
    assert.ok(launcherCode.includes('"platform", "android_twa"') || launcherCode.includes('platform=android_twa'), 'Debe comunicar plataforma android_twa a la PWA');
    assert.ok(launcherCode.includes('sismos_panama'), 'Debe gestionar suscripción al topic sismos_panama');

    const settingsActivity = path.join(javaDir, 'SismoNotificationSettingsActivity.java');
    assert.ok(fs.existsSync(settingsActivity), 'SismoNotificationSettingsActivity.java debe existir');
    const settingsCode = fs.readFileSync(settingsActivity, 'utf8');
    assert.ok(settingsCode.includes('setAutoInitEnabled(true)'), 'Debe activar auto-init al suscribirse voluntariamente');
    assert.ok(settingsCode.includes('setAutoInitEnabled(false)'), 'Debe desactivar auto-init al revocar suscripción');
  });

  await t.test('6. FCM API: isValidFcmToken valida estrictamente formato y longitud', () => {
    assert.equal(isValidFcmToken(null), false);
    assert.equal(isValidFcmToken(''), false);
    assert.equal(isValidFcmToken('corta'), false);
    assert.equal(isValidFcmToken('token con espacios y caracteres <script>'), false);

    const validMockToken = 'eXamP1e_fCm-Token:APA91bF' + 'a'.repeat(120);
    assert.equal(isValidFcmToken(validMockToken), true);
  });

  await t.test('7. FCM Dispatcher: emite mensajes Data-Only de alta prioridad sin duplicar notificaciones del sistema', async () => {
    let subrequestCount = 0;
    let capturedUrl = null;
    let capturedBody = null;
    let capturedHeaders = null;

    const mockFetch = async (url, options) => {
      subrequestCount++;
      if (url.includes('oauth2.googleapis.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'mock-oauth-token-12345', expires_in: 3600 })
        };
      }
      if (url.includes('fcm.googleapis.com')) {
        capturedUrl = url;
        capturedBody = JSON.parse(options.body);
        capturedHeaders = options.headers;
        return {
          ok: true,
          status: 200,
          json: async () => ({ name: 'projects/sismopa-notificaciones/messages/msg-12345' })
        };
      }
      throw new Error(`URL no manejada: ${url}`);
    };

    _resetOAuthCache();

    const keyPair = await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256'
      },
      true,
      ['sign', 'verify']
    );
    const exportedPkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    const binaryStr = String.fromCharCode(...new Uint8Array(exportedPkcs8));
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binaryStr)}\n-----END PRIVATE KEY-----`;

    const serviceAccount = {
      project_id: 'sismopa-notificaciones',
      client_email: 'firebase-adminsdk@sismopa-notificaciones.iam.gserviceaccount.com',
      private_key: pem
    };

    const payload = {
      source_uid: '20261026_test_sismo',
      magnitud: '4.8',
      lugar: 'Golfo de Chiriquí',
      profundidad: '12',
      hora_local: '2026-10-26 15:30:00'
    };

    const res = await sendFcmTopicMessage(serviceAccount, 'sismos_panama', payload, mockFetch);
    assert.equal(res.ok, true);
    assert.equal(res.messageId, 'projects/sismopa-notificaciones/messages/msg-12345');

    assert.ok(capturedUrl.includes('projects/sismopa-notificaciones/messages:send'));
    assert.equal(capturedHeaders['Authorization'], 'Bearer mock-oauth-token-12345');

    assert.equal(capturedBody.message.topic, 'sismos_panama');
    assert.equal(capturedBody.message.data.source_uid, '20261026_test_sismo');
    assert.equal(capturedBody.message.data.magnitud, '4.8');
    assert.equal(capturedBody.message.android.priority, 'high');

    // PROTECCIÓN CRÍTICA CONTRA DUPLICADOS:
    // El mensaje debe ser Data-Only (sin bloque notification a nivel de raíz),
    // garantizando que Android no cree automáticamente una notificación genérica en background
    assert.equal(capturedBody.message.notification, undefined, 'No debe incluir bloque notification a nivel de raíz');

    // Reutilización de token OAuth en caché (1 subrequest a FCM, 0 a oauth2)
    const subrequestsBefore = subrequestCount;
    const res2 = await sendFcmTopicMessage(serviceAccount, 'sismos_panama', payload, mockFetch);
    assert.equal(res2.ok, true);
    assert.equal(subrequestCount - subrequestsBefore, 1);
  });

  await t.test('8. FCM Dispatcher: sendFcmDirectMessage despacha mensaje Data-Only a token individual', async () => {
    let capturedBody = null;
    const mockFetch = async (url, options) => {
      if (url.includes('fcm.googleapis.com')) {
        capturedBody = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ name: 'projects/sismopa-notificaciones/messages/direct-12345' })
        };
      }
      return { ok: true, json: async () => ({ access_token: 'tok' }) };
    };

    const serviceAccount = {
      project_id: 'sismopa-notificaciones',
      client_email: 'test@sismopa-notificaciones.iam.gserviceaccount.com'
    };

    const directToken = 'device_fcm_token_xyz_987654321';
    const res = await sendFcmDirectMessage(serviceAccount, directToken, { source_uid: 'TEST' }, mockFetch);
    assert.equal(res.ok, true);
    assert.equal(capturedBody.message.token, directToken);
    assert.equal(capturedBody.message.notification, undefined, 'Direct message debe ser Data-Only');
    assert.equal(capturedBody.message.android.priority, 'high');
  });

  await t.test('9. Supabase Migration: 20261026_fcm_device_tokens.sql define tablas, índices y RLS aditivas', () => {
    const sqlPath = path.join(rootDir, 'supabase/migrations/20261026_fcm_device_tokens.sql');
    assert.ok(fs.existsSync(sqlPath), 'Migración SQL de FCM debe existir');
    const sql = fs.readFileSync(sqlPath, 'utf8');

    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.fcm_device_tokens'), 'Debe crear tabla fcm_device_tokens');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.fcm_notificaciones_enviadas'), 'Debe crear tabla fcm_notificaciones_enviadas');
    assert.ok(sql.includes('ALTER TABLE public.fcm_device_tokens ENABLE ROW LEVEL SECURITY'), 'Debe habilitar RLS en fcm_device_tokens');
    assert.ok(sql.includes('idx_fcm_tokens_active_last_seen'), 'Debe incluir índice de tokens activos');
    assert.ok(sql.includes('uq_fcm_notif_sismo_target'), 'Debe incluir constraint única para prevención de duplicados');
  });

  await t.test('10. Web Client: assets/app.js detecta TWA con validación de origen y no confía solo en query params', () => {
    const appJsPath = path.join(rootDir, 'assets/app.js');
    assert.ok(fs.existsSync(appJsPath), 'assets/app.js debe existir');
    const content = fs.readFileSync(appJsPath, 'utf8');

    assert.ok(content.includes('hasAndroidAppReferrer'), 'Debe validar origen android-app://pa.sismodata.app');
    assert.ok(content.includes('sismopa://notifications'), 'Debe invocar deep link nativo sismopa://notifications');
    assert.ok(content.includes('SISMO_FCM_STATUS'), 'Debe escuchar eventos SISMO_FCM_STATUS vía postMessage');
    assert.ok(content.includes('Activas (App sismoPA)'), 'Debe etiquetar el estado activo nativo');
  });

  await t.test('11. Endpoint /api/fcm-subscribe: Retirado de forma segura en modo no-op para retrocompatibilidad', async () => {
    const { onRequest } = fcmSubscribeMod;

    // OPTIONS preflight
    const optReq = new Request('https://sismopa.pages.dev/api/fcm-subscribe', { method: 'OPTIONS' });
    const optRes = await onRequest({ request: optReq, env: {} });
    assert.equal(optRes.status, 204);

    // POST con token válido: 200 OK con flag retired: true, sin requerir conexión a Supabase
    const validToken = 'eXamP1e_fCm-Token:APA91bF' + 'a'.repeat(120);
    const postReq = new Request('https://sismopa.pages.dev/api/fcm-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'subscribe', token: validToken })
    });
    const postRes = await onRequest({ request: postReq, env: {} });
    assert.equal(postRes.status, 200);
    const data = await postRes.json();
    assert.equal(data.ok, true);
    assert.equal(data.retired, true);
    assert.equal(data.architecture, 'firebase_topics');
    assert.equal(data.topic, 'sismos_panama');

    // POST con token malformado: 400 Bad Request
    const badReq = new Request('https://sismopa.pages.dev/api/fcm-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'subscribe', token: 'invalido' })
    });
    const badRes = await onRequest({ request: badReq, env: {} });
    assert.equal(badRes.status, 400);
  });
});
