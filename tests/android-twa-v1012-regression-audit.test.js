'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const BUILD_GRADLE_PATH = path.join(ROOT_DIR, 'android-twa/app/build.gradle');
const TWA_MANIFEST_PATH = path.join(ROOT_DIR, 'android-twa/twa-manifest.json');
const ANDROID_MANIFEST_PATH = path.join(ROOT_DIR, 'android-twa/app/src/main/AndroidManifest.xml');
const DELEGATION_SERVICE_PATH = path.join(ROOT_DIR, 'android-twa/app/src/main/java/pa/sismodata/app/DelegationService.java');
const LOCATION_PERM_ACTIVITY_PATH = path.join(ROOT_DIR, 'android-twa/app/src/main/java/pa/sismodata/app/LocationPermissionActivity.java');
const FCM_SERVICE_PATH = path.join(ROOT_DIR, 'android-twa/app/src/main/java/pa/sismodata/app/SismoFirebaseMessagingService.java');
const SETTINGS_ACTIVITY_PATH = path.join(ROOT_DIR, 'android-twa/app/src/main/java/pa/sismodata/app/SismoNotificationSettingsActivity.java');
const HELPER_PATH = path.join(ROOT_DIR, 'android-twa/app/src/main/java/pa/sismodata/app/SismoNotificationHelper.java');
const SIGN_SCRIPT_PATH = path.join(ROOT_DIR, 'scripts/create_upload_keystore_and_sign_v1012_aab.ps1');

test('sismoPA Alpha 1.0.12 (versionCode 13) - Auditoría de Versión y Configuración', async (t) => {
  await t.test('build.gradle tiene versionCode 13 y versionName "1.0.12"', () => {
    const content = fs.readFileSync(BUILD_GRADLE_PATH, 'utf8');
    assert.match(content, /versionCode\s+13/, 'versionCode debe ser 13');
    assert.match(content, /versionName\s+["']1\.0\.12["']/, 'versionName debe ser 1.0.12');
  });

  await t.test('build.gradle incluye dependencias requeridas de Firebase y LocationDelegation', () => {
    const content = fs.readFileSync(BUILD_GRADLE_PATH, 'utf8');
    assert.match(content, /com\.google\.androidbrowserhelper:locationdelegation:1\.1\.2/);
    assert.match(content, /com\.google\.androidbrowserhelper:androidbrowserhelper:2\.7\.4/);
  });

  await t.test('twa-manifest.json tiene appVersionCode 13 y appVersionName "1.0.12"', () => {
    const raw = fs.readFileSync(TWA_MANIFEST_PATH, 'utf8');
    const json = JSON.parse(raw);
    assert.strictEqual(json.appVersionCode, 13, 'appVersionCode en twa-manifest.json debe ser 13');
    assert.strictEqual(json.appVersionName, '1.0.12', 'appVersionName en twa-manifest.json debe ser 1.0.12');
    assert.strictEqual(json.packageId, 'pa.sismodata.app');
    assert.strictEqual(json.host, 'sismopa.pages.dev');
  });
});

test('sismoPA Alpha 1.0.12 - Auditoría de Permisos, Actividades y Delegación Chromium TWA', async (t) => {
  const manifestXml = fs.readFileSync(ANDROID_MANIFEST_PATH, 'utf8');

  await t.test('AndroidManifest.xml declara permisos necesarios para GPS nativo y notificaciones', () => {
    assert.match(manifestXml, /android\.permission\.ACCESS_FINE_LOCATION/);
    assert.match(manifestXml, /android\.permission\.ACCESS_COARSE_LOCATION/);
    assert.match(manifestXml, /android\.permission\.POST_NOTIFICATIONS/);
  });

  await t.test('AndroidManifest.xml EXCLUYE ACCESS_BACKGROUND_LOCATION (Políticas Google Play)', () => {
    assert.doesNotMatch(manifestXml, /android\.permission\.ACCESS_BACKGROUND_LOCATION/);
  });

  await t.test('AndroidManifest.xml registra LocationPermissionActivity para interacción de primer uso', () => {
    assert.match(manifestXml, /LocationPermissionActivity/, 'Debe declarar LocationPermissionActivity');
    assert.match(manifestXml, /android:scheme="sismopa"\s+android:host="request-location"/, 'Debe registrar host request-location');
    assert.match(manifestXml, /android:scheme="sismopa"\s+android:host="location"/, 'Debe registrar host location');
  });

  await t.test('LocationPermissionActivity solicita permisos de ubicación en primer plano', () => {
    assert.ok(fs.existsSync(LOCATION_PERM_ACTIVITY_PATH), 'LocationPermissionActivity.java debe existir');
    const content = fs.readFileSync(LOCATION_PERM_ACTIVITY_PATH, 'utf8');
    assert.match(content, /Manifest\.permission\.ACCESS_FINE_LOCATION/);
    assert.match(content, /Manifest\.permission\.ACCESS_COARSE_LOCATION/);
    assert.match(content, /ActivityCompat\.requestPermissions/);
    assert.match(content, /finish\(\)/);
  });

  await t.test('DelegationService registra LocationDelegationExtraCommandHandler', () => {
    const dsContent = fs.readFileSync(DELEGATION_SERVICE_PATH, 'utf8');
    assert.match(dsContent, /LocationDelegationExtraCommandHandler/);
    assert.match(dsContent, /registerExtraCommandHandler/);
  });
});

test('sismoPA Alpha 1.0.12 - Interfaz Compacta y Flujo GPS Autónomo en SismoNotificationSettingsActivity', async (t) => {
  const javaContent = fs.readFileSync(SETTINGS_ACTIVITY_PATH, 'utf8');

  await t.test('Diseño compactado: incluye título breve y estados exactos sin párrafos largos ni selector de zona', () => {
    assert.match(javaContent, /"Distancia en notificaciones"/, 'Título breve debe coincidir');
    assert.match(javaContent, /"Estado: Desactivada"/);
    assert.match(javaContent, /"Estado: GPS activado"/);
    assert.match(javaContent, /"ACTIVAR GPS"/);
    assert.match(javaContent, /"ACTUALIZAR GPS"/);
    assert.match(javaContent, /"DESACTIVAR"/);
    assert.doesNotMatch(javaContent, /Recibirás el formato general/, 'Párrafo largo debe ser eliminado');
    assert.doesNotMatch(javaContent, /Elegir provincia o zona fija/, 'Botón de zona fija debe ser eliminado');
  });

  await t.test('Flujo GPS autónomo: solicita permisos Android en tiempo de ejecución sin redirigir a web ni a Más', () => {
    assert.doesNotMatch(javaContent, /sismopa\.pages\.dev\/#alertas/, 'No debe contener redirección a #alertas');
    assert.match(javaContent, /requestPermissions\(/);
    assert.match(javaContent, /onRequestPermissionsResult/);
    assert.match(javaContent, /LocationManager/);
    assert.match(javaContent, /getLastKnownLocation/);
    assert.match(javaContent, /requestSingleUpdate/);
    assert.match(javaContent, /FcmPreferences\.setUserLocation/);
    assert.match(javaContent, /FcmPreferences\.clearUserLocation/);
  });
});

test('sismoPA Alpha 1.0.12 - Auditoría de Formato de Notificación FCM con Distancia Personalizada', async (t) => {
  const fcmContent = fs.readFileSync(FCM_SERVICE_PATH, 'utf8');

  await t.test('SismoFirebaseMessagingService genera el formato limpio: "M3.5 · Nuevo sismo" y "A XX km de ti"', () => {
    assert.match(fcmContent, /magStr \+ " · Nuevo sismo"/);
    assert.match(fcmContent, /sb\.append\(" · A "\)\.append\(personalizedDistKm\)\.append\(" km de ti"\)/);
    assert.doesNotMatch(fcmContent, /personalizedDistStr = roundedDist \+ " km " \+ suffix/, 'No debe usar el formato duplicado anterior');
  });

  await t.test('SismoNotificationHelper implementa canal prioritario y prueba con formato limpio', () => {
    const helperContent = fs.readFileSync(HELPER_PATH, 'utf8');
    assert.match(helperContent, /CHANNEL_ID\s*=\s*"sismo_alertas_channel"/);
    assert.match(helperContent, /A 42 km de ti/);
  });
});

test('sismoPA Alpha 1.0.12 - Scripts de Compilación, Firma y Verificación', async (t) => {
  await t.test('create_upload_keystore_and_sign_v1012_aab.ps1 existe y apunta a v1.0.12 con huella oficial confirmada', () => {
    assert.ok(fs.existsSync(SIGN_SCRIPT_PATH), 'El script PowerShell de firma v1012 debe existir');
    const scriptContent = fs.readFileSync(SIGN_SCRIPT_PATH, 'utf8');
    assert.match(scriptContent, /sismopa-v1\.0\.12-upload-signed\.aab/);
    assert.match(scriptContent, /sismopa-upload-keystore\.jks/);
    assert.match(scriptContent, /D2:59:B7:64:52:58:C0:EB:78:7D:5C:F5:5B:05:E4:04:00:64:B7:78:5B:9A:ED:FE:E5:46:00:B6:DD:CC:A0:FE/);
  });
});
