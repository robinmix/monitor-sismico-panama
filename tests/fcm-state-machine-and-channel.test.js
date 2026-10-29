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

    // isOptedIn exige estrictamente ACTIVO, topic confirmado y token no nulo
    assert.ok(
      content.includes('isStateActivo && isTopic && (token != null && !token.isEmpty())'),
      'isOptedIn debe verificar simultáneamente State.ACTIVO, topic confirmado y token válido'
    );
  });

  await t.test('2. SismoNotificationSettingsActivity proporciona UI nativa y no indica ACTIVAS sin confirmar Firebase', () => {
    const activityPath = path.join(rootDir, 'android-twa/app/src/main/java/pa/sismodata/app/SismoNotificationSettingsActivity.java');
    assert.ok(fs.existsSync(activityPath), 'SismoNotificationSettingsActivity.java debe existir');
    const content = fs.readFileSync(activityPath, 'utf8');

    assert.ok(content.includes('SismoNotificationHelper.createNotificationChannel'), 'Debe asegurar canal nativo');
    assert.ok(content.includes('subscribeToTopic'), 'Debe ejecutar subscribeToTopic tras acción voluntaria');
    assert.ok(content.includes('unsubscribeFromTopic'), 'Debe ejecutar unsubscribeFromTopic al revocar');
    assert.ok(content.includes('sendLocalTestNotification'), 'Debe contar con botón para probar notificación nativa local');
    assert.ok(content.includes('ClipboardManager'), 'Debe permitir copiar el FCM token para pruebas directas');

    // Auditoría de indicación de «ALERTAS ACTIVAS»: solo tras isOptedIn() confirmado
    assert.ok(
      content.includes('boolean isTrulyActive = FcmPreferences.isOptedIn(this)'),
      'Debe verificar isOptedIn() real en updateUi()'
    );
    assert.ok(
      content.includes('SINCRONIZANDO...'),
      'Si el estado dice ACTIVO pero falta confirmación de Firebase, debe mostrar SINCRONIZANDO... y no ACTIVAS'
    );
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

  await t.test('6. assets/app.js migra Web Push de forma segura SOLO con FCM confirmado activo', () => {
    const appJsPath = path.join(rootDir, 'assets/app.js');
    const content = fs.readFileSync(appJsPath, 'utf8');

    // No desuscribir incondicionalmente por el simple hecho de ser TWA
    assert.ok(
      content.includes('function safeMigrateWebPushToFcm()'),
      'Debe definir función de migración segura y condicional safeMigrateWebPushToFcm'
    );
    assert.ok(
      content.includes('if (!isFcmConfirmedActive)'),
      'Debe abortar desuscripción si FCM no está confirmado activo'
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

  await t.test('10. Alpha 1.0.9 y versionCode 10 configurados en build.gradle y twa-manifest.json', () => {
    const gradlePath = path.join(rootDir, 'android-twa/app/build.gradle');
    const twaManifestPath = path.join(rootDir, 'android-twa/twa-manifest.json');

    const gradleContent = fs.readFileSync(gradlePath, 'utf8');
    assert.ok(gradleContent.includes('versionCode 10'), 'build.gradle debe tener versionCode 9');
    assert.ok(gradleContent.includes('versionName "1.0.9"'), 'build.gradle debe tener versionName "1.0.8"');

    const twaContent = JSON.parse(fs.readFileSync(twaManifestPath, 'utf8'));
    assert.equal(twaContent.appVersionCode, 10, 'twa-manifest debe tener appVersionCode 9');
    assert.equal(twaContent.appVersionName, '1.0.9', 'twa-manifest debe tener appVersionName 1.0.8');
  });

  await t.test('11. Migración defensiva desde Alpha 1.0.4 en FcmPreferences', () => {
    const prefsPath = path.join(rootDir, 'android-twa/app/src/main/java/pa/sismodata/app/FcmPreferences.java');
    const content = fs.readFileSync(prefsPath, 'utf8');

    // Valida que getState() maneje el caso en que KEY_STATE no existía previamente
    assert.ok(
      content.includes('legacyOptedIn && token != null && !token.isEmpty() && topicSub'),
      'Debe exigir token y topic confirmado para migrar un estado anterior como ACTIVO'
    );
    assert.ok(
      content.includes('return State.DESACTIVADO;'),
      'Debe caer en DESACTIVADO por defecto ante cualquier inconsistencia de datos'
    );
  });

  await t.test('12. Manejo de activación FCM fallida (error en topic o token)', () => {
    const activityPath = path.join(rootDir, 'android-twa/app/src/main/java/pa/sismodata/app/SismoNotificationSettingsActivity.java');
    const content = fs.readFileSync(activityPath, 'utf8');

    // Si subTask o tokenTask fallan, debe registrar State.ERROR y no dejar autoInit activo
    assert.ok(
      content.includes('FcmPreferences.setState(this, FcmPreferences.State.ERROR)'),
      'Debe transicionar a State.ERROR ante fallos'
    );
    assert.ok(
      content.includes('FirebaseMessaging.getInstance().setAutoInitEnabled(false)'),
      'Debe revocar autoInit ante fallos de conexión'
    );
  });

  await t.test('13. Manejo de permisos POST_NOTIFICATIONS denegados en Android 13+', () => {
    const activityPath = path.join(rootDir, 'android-twa/app/src/main/java/pa/sismodata/app/SismoNotificationSettingsActivity.java');
    const content = fs.readFileSync(activityPath, 'utf8');

    assert.ok(
      content.includes('Permiso POST_NOTIFICATIONS denegado'),
      'Debe registrar log y error explícito si el usuario niega el permiso'
    );
    assert.ok(
      content.includes('Permiso de notificaciones denegado en ajustes de Android'),
      'Debe almacenar mensaje descriptivo en getLastError()'
    );
  });

  await t.test('14. Coexistencia de navegadores: navegadores estándar fuera de TWA conservan Web Push', () => {
    const appJsPath = path.join(rootDir, 'assets/app.js');
    const content = fs.readFileSync(appJsPath, 'utf8');

    // La lógica de Web Push estándar (PushManager, getVapidPublicKey, /api/push-subscribe)
    // debe estar fuera del bloque `if (isTwa)` y permanecer 100% operativa para navegadores regulares
    assert.ok(
      content.includes("const isSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window"),
      'Debe verificar soporte estándar de Web Push para navegadores web'
    );
    assert.ok(
      content.includes('getVapidPublicKey()'),
      'Debe conservar llamada a getVapidPublicKey() para clientes web estándar'
    );
    assert.ok(
      content.includes('/api/push-subscribe'),
      'Debe conservar registro en /api/push-subscribe para clientes web estándar'
    );
  });

  await t.test('15. Revocación robusta en SismoNotificationSettingsActivity: valida éxito de Firebase', () => {
    const activityPath = path.join(rootDir, 'android-twa/app/src/main/java/pa/sismodata/app/SismoNotificationSettingsActivity.java');
    const content = fs.readFileSync(activityPath, 'utf8');

    // Debe comprobar explícitamente if (!unsubTask.isSuccessful())
    assert.ok(
      content.includes('!unsubTask.isSuccessful()'),
      'Debe comprobar !unsubTask.isSuccessful() antes de modificar estado'
    );
    assert.ok(
      content.includes('No se pudo cancelar la suscripción en Firebase'),
      'Debe reportar mensaje de error explícito si Firebase rechaza la desuscripción'
    );
    assert.ok(
      content.includes('Reintentar Desactivación'),
      'Debe permitir reintentar la desactivación si el topic sigue suscrito'
    );
  });

  await t.test('16. Desacoplamiento de tokens individuales: Android no realiza llamadas HTTP a /api/fcm-subscribe', () => {
    const servicePath = path.join(rootDir, 'android-twa/app/src/main/java/pa/sismodata/app/SismoFirebaseMessagingService.java');
    const serviceContent = fs.readFileSync(servicePath, 'utf8');

    const activityPath = path.join(rootDir, 'android-twa/app/src/main/java/pa/sismodata/app/SismoNotificationSettingsActivity.java');
    const actContent = fs.readFileSync(activityPath, 'utf8');

    // No debe contener la constante de URL hacia /api/fcm-subscribe
    assert.ok(
      !serviceContent.includes('https://sismopa.pages.dev/api/fcm-subscribe'),
      'SismoFirebaseMessagingService no debe conectar a /api/fcm-subscribe'
    );
    assert.ok(
      !actContent.includes('syncTokenWithServer'),
      'SismoNotificationSettingsActivity no debe llamar a syncTokenWithServer'
    );
  });
});
