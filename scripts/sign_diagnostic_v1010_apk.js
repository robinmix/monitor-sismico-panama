'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ANDROID_TWA_DIR = path.join(PROJECT_ROOT, 'android-twa');
const BUBBLEWRAP_DIR = path.resolve(process.env.USERPROFILE, '.bubblewrap');
const JDK_DIR = path.join(BUBBLEWRAP_DIR, 'jdk');
const ANDROID_SDK_DIR = path.join(BUBBLEWRAP_DIR, 'android_sdk');
const BUILD_TOOLS_DIR = path.join(ANDROID_SDK_DIR, 'build-tools', '35.0.0');

const APKSIGNER = path.join(BUILD_TOOLS_DIR, 'apksigner.bat');
const AAPT2 = path.join(BUILD_TOOLS_DIR, 'aapt2.exe');

const ANDROID_HOME_DIR = path.join(process.env.USERPROFILE, '.android');
const KEYSTORE_PATH = path.join(ANDROID_HOME_DIR, 'sismopa-test-signing.keystore');
const PASS_FILE = path.join(ANDROID_HOME_DIR, 'sismopa-signing.pass');
const KEY_ALIAS = 'sismotest';

const UNSIGNED_APK = path.join(ANDROID_TWA_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk');
const SIGNED_APK = path.join(ANDROID_TWA_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'sismopa-v1.0.10-diagnostic.apk');

const env = {
  ...process.env,
  JAVA_HOME: JDK_DIR,
  ANDROID_HOME: ANDROID_SDK_DIR,
  PATH: `${path.join(JDK_DIR, 'bin')};${BUILD_TOOLS_DIR};${process.env.PATH}`
};

async function main() {
  console.log('=== FIRMA DE APK DE DIAGNÓSTICO sismoPA Alpha 1.0.10 (versionCode 11) ===\n');

  if (!fs.existsSync(UNSIGNED_APK)) {
    throw new Error(`No se encontró el APK sin firmar en: ${UNSIGNED_APK}`);
  }
  if (!fs.existsSync(KEYSTORE_PATH)) {
    throw new Error(`No se encontró el Keystore en: ${KEYSTORE_PATH}`);
  }
  if (!fs.existsSync(PASS_FILE)) {
    throw new Error(`No se encontró el archivo de contraseña en: ${PASS_FILE}`);
  }

  const passContent = fs.readFileSync(PASS_FILE, 'utf8');
  const password = passContent.trim().split(/\r?\n/)[0];

  env.SISMO_PASS = password;

  // 1. Firmar APK con apksigner (v1, v2, v3)
  console.log('[1/2] Firmando APK con apksigner (esquemas v1, v2, v3)...');
  const signCmd = `"${APKSIGNER}" sign --ks "${KEYSTORE_PATH}" --ks-key-alias "${KEY_ALIAS}" --ks-pass env:SISMO_PASS --key-pass env:SISMO_PASS --out "${SIGNED_APK}" "${UNSIGNED_APK}"`;
  execSync(signCmd, { env });

  // 2. Verificar firma digital
  console.log('[2/2] Verificando firma del APK...');
  const verifyCmd = `"${APKSIGNER}" verify --verbose "${SIGNED_APK}"`;
  const verifyOut = execSync(verifyCmd, { env }).toString();
  const apkVerified = verifyOut.includes('Verifies');
  console.log('   Verificación APK:', apkVerified ? 'Verifies (OK)' : 'FALLIDO');

  if (!apkVerified) {
    throw new Error('La verificación del APK falló.');
  }

  console.log('\n=== RESULTADO ===');
  console.log('✔ APK firmado:', SIGNED_APK, `(${(fs.statSync(SIGNED_APK).size / 1024 / 1024).toFixed(2)} MB)`);
  console.log('✔ Listo para instalación física directa (adb install o descarga).\n');
}

main().catch(err => {
  console.error('\n✖ Error en el proceso:', err.message);
  process.exit(1);
});
