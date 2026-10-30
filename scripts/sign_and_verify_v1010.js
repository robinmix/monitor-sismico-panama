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

const JARSIGNER = path.join(JDK_DIR, 'bin', 'jarsigner.exe');

const ANDROID_HOME_DIR = path.join(process.env.USERPROFILE, '.android');
const KEYSTORE_PATH = path.join(ANDROID_HOME_DIR, 'sismopa-test-signing.keystore');
const PASS_FILE = path.join(ANDROID_HOME_DIR, 'sismopa-signing.pass');
const KEY_ALIAS = 'sismotest';

const UNSIGNED_AAB = path.join(ANDROID_TWA_DIR, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab');
const SIGNED_TEST_AAB = path.join(ANDROID_TWA_DIR, 'app', 'build', 'outputs', 'bundle', 'release', 'sismopa-v1.0.10-test-signed.aab');

const env = {
  ...process.env,
  JAVA_HOME: JDK_DIR,
  ANDROID_HOME: ANDROID_SDK_DIR,
  PATH: `${path.join(JDK_DIR, 'bin')};${BUILD_TOOLS_DIR};${process.env.PATH}`
};

async function main() {
  console.log('=== FIRMA Y VERIFICACIÓN DE sismoPA Alpha 1.0.10 (versionCode 11) ===\n');

  if (!fs.existsSync(UNSIGNED_AAB)) {
    throw new Error(`No se encontró el AAB base compilado en: ${UNSIGNED_AAB}`);
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

  // 1. Firmar y verificar copia AAB con jarsigner
  console.log('[1/2] Firmando AAB (jarsigner) con clave de prueba autorizada...');
  if (fs.existsSync(SIGNED_TEST_AAB)) fs.unlinkSync(SIGNED_TEST_AAB);
  fs.copyFileSync(UNSIGNED_AAB, SIGNED_TEST_AAB);

  const jarsignerCmd = `"${JARSIGNER}" -keystore "${KEYSTORE_PATH}" -storepass:env SISMO_PASS -keypass:env SISMO_PASS -sigalg SHA256withRSA -digestalg SHA-256 "${SIGNED_TEST_AAB}" "${KEY_ALIAS}"`;
  execSync(jarsignerCmd, { env });

  // 2. Verificar firma digital
  console.log('[2/2] Verificando firma digital con jarsigner -verify...');
  const jarsignerVerify = execSync(`"${JARSIGNER}" -verify -verbose -certs "${SIGNED_TEST_AAB}"`, { env }).toString();
  const aabVerified = jarsignerVerify.includes('jar verified');
  console.log('   Verificación AAB:', aabVerified ? 'jar verified (OK)' : 'FALLIDO');

  if (!aabVerified) {
    throw new Error('La verificación jarsigner del AAB falló.');
  }

  console.log('\n=== RESULTADO ===');
  console.log('✔ AAB base generado:', UNSIGNED_AAB, `(${(fs.statSync(UNSIGNED_AAB).size / 1024 / 1024).toFixed(2)} MB)`);
  console.log('✔ AAB firmado verificado:', SIGNED_TEST_AAB, `(${(fs.statSync(SIGNED_TEST_AAB).size / 1024 / 1024).toFixed(2)} MB)`);
  console.log('✔ Proceso completado exitosamente.\n');
}

main().catch(err => {
  console.error('\n✖ Error en el proceso:', err.message);
  process.exit(1);
});
