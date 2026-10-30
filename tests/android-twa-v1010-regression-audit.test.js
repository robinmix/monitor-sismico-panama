'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const BUILD_GRADLE_PATH = path.join(ROOT_DIR, 'android-twa/app/build.gradle');
const TWA_MANIFEST_PATH = path.join(ROOT_DIR, 'android-twa/twa-manifest.json');
const ANDROID_MANIFEST_PATH = path.join(ROOT_DIR, 'android-twa/app/src/main/AndroidManifest.xml');
const FCM_SERVICE_PATH = path.join(ROOT_DIR, 'android-twa/app/src/main/java/pa/sismodata/app/SismoFirebaseMessagingService.java');
const SETTINGS_ACTIVITY_PATH = path.join(ROOT_DIR, 'android-twa/app/src/main/java/pa/sismodata/app/SismoNotificationSettingsActivity.java');
const SIGN_SCRIPT_PATH = path.join(ROOT_DIR, 'scripts/create_upload_keystore_and_sign_v1010_aab.ps1');
const VERIFY_SCRIPT_PATH = path.join(ROOT_DIR, 'scripts/verify_upload_signed_v1010_aab.js');

test('sismoPA Alpha 1.0.10 (versionCode 11) - Auditoría de Versión y Configuración', async (t) => {
  await t.test('build.gradle tiene versionCode 11 y versionName "1.0.10"', () => {
    const content = fs.readFileSync(BUILD_GRADLE_PATH, 'utf8');
    assert.match(content, /versionCode\s+11/, 'versionCode debe ser 11');
    assert.match(content, /versionName\s+["']1\.0\.10["']/, 'versionName debe ser 1.0.10');
  });

  await t.test('twa-manifest.json tiene appVersionCode 11 y appVersionName "1.0.10"', () => {
    const raw = fs.readFileSync(TWA_MANIFEST_PATH, 'utf8');
    const json = JSON.parse(raw);
    assert.strictEqual(json.appVersionCode, 11, 'appVersionCode en twa-manifest.json debe ser 11');
    assert.strictEqual(json.appVersionName, '1.0.10', 'appVersionName en twa-manifest.json debe ser 1.0.10');
    assert.strictEqual(json.packageId, 'pa.sismodata.app');
    assert.strictEqual(json.host, 'sismopa.pages.dev');
  });
});

test('sismoPA Alpha 1.0.10 - Auditoría de Delegación GPS (Alternativa A: Multiplataforma)', async (t) => {
  const manifestXml = fs.readFileSync(ANDROID_MANIFEST_PATH, 'utf8');

  await t.test('AndroidManifest.xml NO contiene permisos nativos de ubicación (desactiva delegación Chromium)', () => {
    assert.doesNotMatch(manifestXml, /android\.permission\.ACCESS_FINE_LOCATION/, 'ACCESS_FINE_LOCATION debe estar excluido');
    assert.doesNotMatch(manifestXml, /android\.permission\.ACCESS_COARSE_LOCATION/, 'ACCESS_COARSE_LOCATION debe estar excluido');
    assert.doesNotMatch(manifestXml, /android\.permission\.ACCESS_BACKGROUND_LOCATION/, 'ACCESS_BACKGROUND_LOCATION debe estar excluido');
  });

  await t.test('AndroidManifest.xml conserva permisos necesarios de Red y Notificaciones', () => {
    assert.match(manifestXml, /android\.permission\.POST_NOTIFICATIONS/, 'POST_NOTIFICATIONS debe estar presente');
  });

  await t.test('SismoNotificationSettingsActivity redirige ajustes de ubicación a la web app', () => {
    assert.ok(fs.existsSync(SETTINGS_ACTIVITY_PATH), 'SismoNotificationSettingsActivity debe existir');
    const javaContent = fs.readFileSync(SETTINGS_ACTIVITY_PATH, 'utf8');
    assert.doesNotMatch(javaContent, /Manifest\.permission\.ACCESS_FINE_LOCATION/, 'No debe solicitar ACCESS_FINE_LOCATION nativo');
    assert.match(javaContent, /sismopa\.pages\.dev\/#alertas/, 'Debe redirigir al ancla #alertas en la web app');
  });
});

test('sismoPA Alpha 1.0.10 - Auditoría de Servicios FCM Nativos', async (t) => {
  const manifestXml = fs.readFileSync(ANDROID_MANIFEST_PATH, 'utf8');

  await t.test('AndroidManifest.xml registra SismoFirebaseMessagingService con exportación segura', () => {
    assert.match(manifestXml, /android:name="\.SismoFirebaseMessagingService"/);
    assert.match(manifestXml, /<action android:name="com\.google\.firebase\.MESSAGING_EVENT"\s*\/>/);
  });

  await t.test('SismoFirebaseMessagingService y Helper implementan canal de alta prioridad', () => {
    assert.ok(fs.existsSync(FCM_SERVICE_PATH), 'SismoFirebaseMessagingService.java debe existir');
    const fcmContent = fs.readFileSync(FCM_SERVICE_PATH, 'utf8');
    assert.match(fcmContent, /SismoNotificationHelper\.CHANNEL_ID/);
    assert.match(fcmContent, /PRIORITY_MAX/);

    const helperPath = path.join(ROOT_DIR, 'android-twa/app/src/main/java/pa/sismodata/app/SismoNotificationHelper.java');
    const helperContent = fs.readFileSync(helperPath, 'utf8');
    assert.match(helperContent, /CHANNEL_ID\s*=\s*"sismo_alertas_channel"/);
    assert.match(helperContent, /IMPORTANCE_HIGH/);
  });
});

test('sismoPA Alpha 1.0.10 - Scripts de Compilación, Firma y Verificación', async (t) => {
  await t.test('create_upload_keystore_and_sign_v1010_aab.ps1 existe y apunta a v1.0.10', () => {
    assert.ok(fs.existsSync(SIGN_SCRIPT_PATH), 'El script PowerShell de firma v1010 debe existir');
    const scriptContent = fs.readFileSync(SIGN_SCRIPT_PATH, 'utf8');
    assert.match(scriptContent, /sismopa-v1\.0\.10-upload-signed\.aab/);
    assert.match(scriptContent, /sismopa-upload-keystore\.jks/);
  });

  await t.test('verify_upload_signed_v1010_aab.js existe y valida versionCode 11', () => {
    assert.ok(fs.existsSync(VERIFY_SCRIPT_PATH), 'El script de verificación v1010 debe existir');
    const scriptContent = fs.readFileSync(VERIFY_SCRIPT_PATH, 'utf8');
    assert.match(scriptContent, /sismopa-v1\.0\.10-upload-signed\.aab/);
    assert.match(scriptContent, /Esperado: 11/);
    assert.match(scriptContent, /Esperado: 1\.0\.10/);
  });
});
