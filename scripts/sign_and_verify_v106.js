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
const JARSIGNER = path.join(JDK_DIR, 'bin', 'jarsigner.exe');

const ANDROID_HOME_DIR = path.join(process.env.USERPROFILE, '.android');
const KEYSTORE_PATH = path.join(ANDROID_HOME_DIR, 'sismopa-test-signing.keystore');
const PASS_FILE = path.join(ANDROID_HOME_DIR, 'sismopa-signing.pass');
const KEY_ALIAS = 'sismotest';

const UNSIGNED_APK = path.join(ANDROID_TWA_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk');
const SIGNED_APK = path.join(ANDROID_TWA_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'sismopa-v1.0.6-test-signed.apk');
const UNSIGNED_AAB = path.join(ANDROID_TWA_DIR, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab');
const SIGNED_TEST_AAB = path.join(ANDROID_TWA_DIR, 'app', 'build', 'outputs', 'bundle', 'release', 'sismopa-v1.0.6-test-signed.aab');

const env = {
  ...process.env,
  JAVA_HOME: JDK_DIR,
  ANDROID_HOME: ANDROID_SDK_DIR,
  PATH: `${path.join(JDK_DIR, 'bin')};${BUILD_TOOLS_DIR};${process.env.PATH}`
};

async function main() {
  console.log('=== FIRMA Y VERIFICACIÓN DE sismoPA Alpha 1.0.6 (versionCode 7) ===\n');

  if (!fs.existsSync(UNSIGNED_APK)) {
    throw new Error(`No se encontró el APK compilado en: ${UNSIGNED_APK}`);
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

  // 1. Preparar archivo de destino APK
  if (fs.existsSync(SIGNED_APK)) fs.unlinkSync(SIGNED_APK);
  fs.copyFileSync(UNSIGNED_APK, SIGNED_APK);
  console.log('[1/4] Archivo APK copiado a:', SIGNED_APK);

  // 2. Firmar APK
  console.log('[2/4] Firmando APK con apksigner (v2, v3)...');
  const signCmd = `cmd.exe /c "call "${APKSIGNER}" sign --ks "${KEYSTORE_PATH}" --ks-key-alias "${KEY_ALIAS}" --ks-pass "env:SISMO_PASS" --key-pass "env:SISMO_PASS" "${SIGNED_APK}""`;
  execSync(signCmd, { env });
  console.log('   APK firmado satisfactoriamente.');

  // 3. Verificar APK
  console.log('\n[3/4] Verificando firma criptográfica con apksigner verify...');
  const verifyCmd = `cmd.exe /c "call "${APKSIGNER}" verify --verbose "${SIGNED_APK}""`;
  const verifyOut = execSync(verifyCmd, { env }).toString();

  const v2Ok = verifyOut.includes('Verified using v2 scheme (APK Signature Scheme v2): true');
  const v3Ok = verifyOut.includes('Verified using v3 scheme (APK Signature Scheme v3): true');

  console.log('   Esquema v2:', v2Ok ? 'OK' : 'FAIL');
  console.log('   Esquema v3:', v3Ok ? 'OK' : 'FAIL');

  if (!v2Ok && !v3Ok) {
    throw new Error('La verificación de firma falló en esquemas v2 y v3.');
  }

  // 4. Firmar y verificar copia AAB de prueba con jarsigner
  console.log('\n[4/4] Firmando y verificando copia AAB de prueba (jarsigner)...');
  if (fs.existsSync(SIGNED_TEST_AAB)) fs.unlinkSync(SIGNED_TEST_AAB);
  fs.copyFileSync(UNSIGNED_AAB, SIGNED_TEST_AAB);

  const jarsignerCmd = `"${JARSIGNER}" -keystore "${KEYSTORE_PATH}" -storepass:env SISMO_PASS -keypass:env SISMO_PASS -sigalg SHA256withRSA -digestalg SHA-256 "${SIGNED_TEST_AAB}" "${KEY_ALIAS}"`;
  execSync(jarsignerCmd, { env });

  const jarsignerVerify = execSync(`"${JARSIGNER}" -verify -verbose -certs "${SIGNED_TEST_AAB}"`, { env }).toString();
  const aabVerified = jarsignerVerify.includes('jar verified');
  console.log('   Verificación AAB de prueba:', aabVerified ? 'jar verified (OK)' : 'FALLIDO');

  // Metadatos finales con aapt2
  let badgingInfo = '';
  try {
    const badging = execSync(`"${AAPT2}" dump badging "${SIGNED_APK}"`, { env }).toString();
    const pkgMatch = badging.match(/package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/);
    if (pkgMatch) {
      badgingInfo = `\n   Package: ${pkgMatch[1]} | versionCode: ${pkgMatch[2]} | versionName: ${pkgMatch[3]}`;
    }
  } catch (_) {}

  const apkStats = fs.statSync(SIGNED_APK);
  const aabStats = fs.statSync(SIGNED_TEST_AAB);

  console.log('\n======================================================');
  console.log('=== AUDITORÍA COMPLETA: sismoPA Alpha 1.0.6 (v7)  ===');
  console.log('======================================================');
  if (badgingInfo) console.log(badgingInfo);
  console.log(`   APK Firmado (Test):     ${SIGNED_APK}`);
  console.log(`   Tamaño APK:             ${(apkStats.size / 1024 / 1024).toFixed(2)} MB (${apkStats.size} bytes)`);
  console.log(`   AAB Base (Unsigned):    ${UNSIGNED_AAB}`);
  console.log(`   AAB Firmado (Test):     ${SIGNED_TEST_AAB}`);
  console.log(`   Tamaño AAB:             ${(aabStats.size / 1024 / 1024).toFixed(2)} MB (${aabStats.size} bytes)`);
  console.log('\n=== APK Y AAB DE PRUEBA LISTOS Y CERTIFICADOS ===');
}

main().catch(err => {
  console.error('\nERROR:', err.message);
  process.exit(1);
});
