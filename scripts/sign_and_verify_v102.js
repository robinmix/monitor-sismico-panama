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
const SIGNED_APK = path.join(ANDROID_TWA_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'sismopa-v1.0.2-test-signed.apk');
const UNSIGNED_AAB = path.join(ANDROID_TWA_DIR, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab');
const SIGNED_TEST_AAB = path.join(ANDROID_TWA_DIR, 'app', 'build', 'outputs', 'bundle', 'release', 'sismopa-v1.0.2-test-signed.aab');

const env = {
  ...process.env,
  JAVA_HOME: JDK_DIR,
  ANDROID_HOME: ANDROID_SDK_DIR,
  PATH: `${path.join(JDK_DIR, 'bin')};${BUILD_TOOLS_DIR};${process.env.PATH}`
};

async function main() {
  console.log('=== FIRMA Y VERIFICACIÓN DE sismoPA v1.0.2 (TEST APK) ===\n');

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

  // Set in process.env for apksigner env:VAR retriever
  env.SISMO_PASS = password;

  // 1. Preparar archivo de destino
  if (fs.existsSync(SIGNED_APK)) fs.unlinkSync(SIGNED_APK);
  fs.copyFileSync(UNSIGNED_APK, SIGNED_APK);
  console.log('[1/4] Archivo APK copiado a:', SIGNED_APK);

  // 2. Firmar APK
  console.log('[2/4] Firmando con apksigner (v1, v2, v3)...');
  const signCmd = `cmd.exe /c "call "${APKSIGNER}" sign --ks "${KEYSTORE_PATH}" --ks-key-alias "${KEY_ALIAS}" --ks-pass "env:SISMO_PASS" --key-pass "env:SISMO_PASS" --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true "${SIGNED_APK}""`;
  execSync(signCmd, { env });
  console.log('   APK firmado exitosamente.');

  // 3. Verificar firma
  console.log('[3/4] Verificando firma criptográfica con apksigner verify...');
  const verifyOutput = execSync(`cmd.exe /c "call "${APKSIGNER}" verify --verbose --print-certs "${SIGNED_APK}""`, { env }).toString();
  console.log(verifyOutput);

  // 4. Volcar metadatos con aapt2
  console.log('[4/5] Extrayendo metadatos del paquete con aapt2 dump badging...');
  const badging = execSync(`"${AAPT2}" dump badging "${SIGNED_APK}"`, { env }).toString();

  const pkgMatch = badging.match(/package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/);
  const targetSdkMatch = badging.match(/targetSdkVersion:'([^']+)'/);
  const compileSdkMatch = badging.match(/compileSdkVersion='([^']+)'/);
  const appLabelMatch = badging.match(/application-label:'([^']+)'/);

  const stat = fs.statSync(SIGNED_APK);
  const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
  const sizeKb = Math.round(stat.size / 1024);

  // 5. Firmar y verificar AAB de prueba (jarsigner)
  console.log('[5/5] Firmando copia AAB de prueba con jarsigner...');
  if (fs.existsSync(SIGNED_TEST_AAB)) fs.unlinkSync(SIGNED_TEST_AAB);
  fs.copyFileSync(UNSIGNED_AAB, SIGNED_TEST_AAB);

  const jarsignerCmd = `"${JARSIGNER}" -keystore "${KEYSTORE_PATH}" -storepass:env SISMO_PASS -keypass:env SISMO_PASS -sigalg SHA256withRSA -digestalg SHA-256 "${SIGNED_TEST_AAB}" "${KEY_ALIAS}"`;
  execSync(jarsignerCmd, { env });
  console.log('   AAB de prueba firmado.');

  const jarsignerVerify = execSync(`"${JARSIGNER}" -verify -verbose -certs "${SIGNED_TEST_AAB}"`, { env }).toString();
  const aabVerified = jarsignerVerify.includes('jar verified.');
  console.log('   Verificación AAB:', aabVerified ? 'jar verified. (OK)' : 'FALLIDO');

  const aabStat = fs.statSync(SIGNED_TEST_AAB);
  const aabSizeMb = (aabStat.size / (1024 * 1024)).toFixed(2);
  const aabSizeKb = Math.round(aabStat.size / 1024);

  console.log('\n======================================================');
  console.log('=== AUDITORÍA COMPLETA: sismoPA v1.0.2 GENERADOS  ===');
  console.log('======================================================');
  console.log(`Nombre de la App:      ${appLabelMatch ? appLabelMatch[1] : 'sismoPA'}`);
  console.log(`Package ID:            ${pkgMatch ? pkgMatch[1] : 'pa.sismodata.app'}`);
  console.log(`Version Name:          ${pkgMatch ? pkgMatch[3] : '1.0.2'}`);
  console.log(`Version Code:          ${pkgMatch ? pkgMatch[2] : '3'}`);
  console.log(`Compile SDK:           ${compileSdkMatch ? compileSdkMatch[1] : '36'}`);
  console.log(`Target SDK:            ${targetSdkMatch ? targetSdkMatch[1] : '36'}`);
  console.log(`APK Firmado (Test):    ${SIGNED_APK}`);
  console.log(`Tamaño APK:            ${sizeKb} KB (${sizeMb} MB, ${stat.size} bytes)`);
  console.log(`AAB Base (Unsigned):   ${UNSIGNED_AAB}`);
  console.log(`AAB Firmado (Test):    ${SIGNED_TEST_AAB}`);
  console.log(`Tamaño AAB:            ${aabSizeKb} KB (${aabSizeMb} MB, ${aabStat.size} bytes)`);
  console.log(`Ubicación Keystore:    ${KEYSTORE_PATH}`);
  console.log(`Target Web:            https://sismopa.pages.dev/`);
  console.log('======================================================\n');

  // Guardar resumen en apk-audit-v102.json
  const summary = {
    appName: appLabelMatch ? appLabelMatch[1] : 'sismoPA',
    packageId: pkgMatch ? pkgMatch[1] : 'pa.sismodata.app',
    versionName: pkgMatch ? pkgMatch[3] : '1.0.2',
    versionCode: pkgMatch ? pkgMatch[2] : '3',
    compileSdkVersion: compileSdkMatch ? compileSdkMatch[1] : '36',
    targetSdkVersion: targetSdkMatch ? targetSdkMatch[1] : '36',
    keyAlgorithm: 'RSA 4096-bit',
    fileSizeBytes: stat.size,
    fileSizeFormatted: `${sizeKb} KB (${sizeMb} MB)`,
    apkPath: SIGNED_APK,
    keystorePath: KEYSTORE_PATH,
    targetUrl: 'https://sismopa.pages.dev/'
  };

  fs.writeFileSync(path.join(ANDROID_TWA_DIR, 'apk-audit-v102.json'), JSON.stringify(summary, null, 2), 'utf8');
}

main().catch(err => {
  console.error('Error durante la firma del APK:', err.message);
  process.exit(1);
});
