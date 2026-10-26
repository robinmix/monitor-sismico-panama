'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');

test('FCM State Machine, Native UI & Robust Channel Suite', async (t) => {

  await t.test('1. Máquina de estados en FcmPreferences.java contempla los 6 estados canónicos', () => {
    const prefsPath = path.join(rootDir, 'android-twa/app/src/main/java/pa/sismodata/app/FcmPreferences.java');
    assert.ok(fs.existsSync(prefsPath), 'FcmPreferences.java debe existir');
    const content = fs.readFileSync(prefsPath, 'utf8');

    const expectedStates = [
      'DESACTIVADO',
      'SOLICITANDO_PERMISO',
      'SUSCRIBIENDO',
      'ACTIVO',
      'ERROR',
      'REVOCANDO'
    ];

    for (const st of expectedStates) {
      assert.ok(content.includes(st), `FcmPreferences debe contener el estado ${st}`);
    }

    // isOptedIn exige estrictamente ACTIVO y confirmación de topic
    assert.ok(
      content.includes('getState(context) == State.ACTIVO && isTopicSubscribed(context)'),
      'isOptedIn debe verificar simultáneamente State.ACTIVO y topic confirmado'
    );
  });

  await t.test('2. SismoNotificationSettingsActivity proporciona UI nativa y no confía en parámetros URL', () => {
    const activityPath = path.join(rootDir, 'android-twa/app/src/main/java/pa/sismodata/app/SismoNotificationSettingsActivity.java');
    assert.ok(fs.existsSync(activityPath), 'SismoNotificationSettingsActivity.java debe existir');
    const content = fs.readFileSync(activityPath, 'utf8');

    assert.ok(content.includes('SismoNotificationHelper.createNotificationChannel'), 'Debe asegurar canal nativo');
    assert.ok(content.includes('subscribeToTopic'), 'Debe ejecutar subscribeToTopic tras acción voluntaria');
    assert.ok(content.includes('unsubscribeFromTopic'), 'Debe ejecutar unsubscribeFromTopic al revocar');
    assert.ok(content.includes('sendLocalTestNotification'), 'Debe contar con botón para probar notificación nativa local');
    assert.ok(content.includes('ClipboardManager'), 'Debe permitir copiar el FCM token para pruebas directas');
  });

  await t.test('3. LauncherActivity eliminó autorización automática por parámetros URL manipulables', () => {
    const launcherPath = path.join(rootDir, 'android-twa/app/src/main/java/pa/sismodata/app/LauncherActivity.java');
    assert.ok(fs.existsSync(launcherPath), 'LauncherActivity.java debe existir');
    const content = fs.readFileSync(launcherPath, 'utf8');

    // No debe ejecutar auto-enrollment por 'action=twa_fcm_opt_in'
    assert.ok(
      !content.includes('executeFcmEnrollment()'),
      'LauncherActivity no debe contener executeFcmEnrollment automático por URL'
    );
    assert.ok(
      !content.includes('twa_fcm_opt_in'),
      'LauncherActivity no debe procesar acciones de autorización por query params'
    );

    // Debe abrir SismoNotificationSettingsActivity si se recibe esquema sismopa://
    assert.ok(
      content.includes('"sismopa".equalsIgnoreCase(scheme)'),
      'Debe procesar el esquema sismopa:// para abrir ajustes nativos'
    );
  });

  await t.test('4. AndroidManifest declara SismoNotificationSettingsActivity con deep link sismopa://', () => {
    const manifestPath = path.join(rootDir, 'android-twa/app/src/main/AndroidManifest.xml');
    const content = fs.readFileSync(manifestPath, 'utf8');

    assert.ok(
      content.includes('.SismoNotificationSettingsActivity'),
      'AndroidManifest debe registrar SismoNotificationSettingsActivity'
    );
    assert.ok(
      content.includes('android:scheme="sismopa"'),
      'Debe registrar esquema nativo sismopa'
    );
    assert.ok(
      content.includes('android:host="notifications"'),
      'Debe registrar host notifications'
    );
  });

  await t.test('5. Canal TWA postMessage implementado en LauncherActivity con validación de origen', () => {
    const launcherPath = path.join(rootDir, 'android-twa/app/src/main/java/pa/sismodata/app/LauncherActivity.java');
    const content = fs.readFileSync(launcherPath, 'utf8');

    assert.ok(content.includes('getCustomTabsCallback()'), 'Debe sobreescribir getCustomTabsCallback');
    assert.ok(content.includes('onRelationshipValidationResult'), 'Debe escuchar onRelationshipValidationResult');
    assert.ok(content.includes('onMessageChannelReady'), 'Debe escuchar onMessageChannelReady');
    assert.ok(content.includes('onPostMessage'), 'Debe escuchar onPostMessage');
    assert.ok(content.includes('requestPostMessageChannel'), 'Debe invocar requestPostMessageChannel');
    assert.ok(content.includes('sismopa.pages.dev'), 'Debe validar origen sismopa.pages.dev');
  });

  await t.test('6. assets/app.js desuscribe Web Push residual en APK y redirige a interfaz nativa', () => {
    const appJsPath = path.join(rootDir, 'assets/app.js');
    const content = fs.readFileSync(appJsPath, 'utf8');

    assert.ok(
      content.includes('[TWA] Cancelando suscripción Web Push residual en la APK'),
      'Debe incluir desuscripción preventiva de Web Push en TWA para evitar notificaciones duplicadas'
    );
    assert.ok(
      content.includes('window.location.href = \'sismopa://notifications\''),
      'Botón de ajustes en TWA debe disparar el deep link sismopa://notifications'
    );
    assert.ok(
      !content.includes('window.location.href = `https://sismopa.pages.dev/?action=${action}'),
      'No debe realizar navegaciones HTTP ficticias con parámetros action para activar FCM'
    );
  });

  await t.test('7. SismoNotificationHelper incluye emisor de prueba local heads-up prioritario', () => {
    const helperPath = path.join(rootDir, 'android-twa/app/src/main/java/pa/sismodata/app/SismoNotificationHelper.java');
    const content = fs.readFileSync(helperPath, 'utf8');

    assert.ok(
      content.includes('sendLocalTestNotification'),
      'Debe contener método sendLocalTestNotification'
    );
    assert.ok(
      content.includes('TEST_NOTIFICATION_ID = 9999'),
      'Debe usar ID de prueba aislado 9999'
    );
    assert.ok(
      content.includes('PRIORITY_MAX'),
      'Debe usar PRIORITY_MAX para alerta inmediata'
    );
  });

  await t.test('8. SismoFirebaseMessagingService respeta deduplicación de 3 horas y consentimiento', () => {
    const servicePath = path.join(rootDir, 'android-twa/app/src/main/java/pa/sismodata/app/SismoFirebaseMessagingService.java');
    const content = fs.readFileSync(servicePath, 'utf8');

    assert.ok(
      content.includes('!FcmPreferences.isOptedIn(this)'),
      'Debe verificar isOptedIn antes de construir notificación'
    );
    assert.ok(
      content.includes('FcmPreferences.isAlreadyNotified(this, sourceUid)'),
      'Debe verificar deduplicación defensiva por sourceUid'
    );
    assert.ok(
      content.includes('FcmPreferences.markAsNotified(this, sourceUid)'),
      'Debe registrar el sismo notificado tras emitir la alerta'
    );
  });

  await t.test('9. Script send_fcm_direct_test.js existe para pruebas directas por token sin enviar al topic', () => {
    const scriptPath = path.join(rootDir, 'scripts/send_fcm_direct_test.js');
    assert.ok(fs.existsSync(scriptPath), 'scripts/send_fcm_direct_test.js debe existir');
    const content = fs.readFileSync(scriptPath, 'utf8');

    assert.ok(content.includes('sendFcmDirectMessage'), 'Debe utilizar sendFcmDirectMessage');
    assert.ok(content.includes('--token'), 'Debe requerir argumento --token');
    assert.ok(content.includes('sismopa-notificaciones'), 'Debe apuntar al proyecto oficial sismopa-notificaciones');
  });

  await t.test('10. Alpha 1.0.5 y versionCode 6 configurados en build.gradle y twa-manifest.json', () => {
    const gradlePath = path.join(rootDir, 'android-twa/app/build.gradle');
    const twaManifestPath = path.join(rootDir, 'android-twa/twa-manifest.json');

    const gradleContent = fs.readFileSync(gradlePath, 'utf8');
    assert.ok(gradleContent.includes('versionCode 6'), 'build.gradle debe tener versionCode 6');
    assert.ok(gradleContent.includes('versionName "1.0.5"'), 'build.gradle debe tener versionName "1.0.5"');

    const twaContent = JSON.parse(fs.readFileSync(twaManifestPath, 'utf8'));
    assert.equal(twaContent.appVersionCode, 6, 'twa-manifest debe tener appVersionCode 6');
    assert.equal(twaContent.appVersionName, '1.0.5', 'twa-manifest debe tener appVersionName 1.0.5');
  });
});
