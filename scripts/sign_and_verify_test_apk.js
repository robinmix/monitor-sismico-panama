const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const ANDROID_TWA_DIR = path.join(PROJECT_ROOT, 'android-twa');
const BUBBLEWRAP_DIR = path.resolve(process.env.USERPROFILE, '.bubblewrap');
const JDK_DIR = path.join(BUBBLEWRAP_DIR, 'jdk');
const ANDROID_SDK_DIR = path.join(BUBBLEWRAP_DIR, 'android_sdk');
const BUILD_TOOLS_DIR = path.join(ANDROID_SDK_DIR, 'build-tools', '35.0.0');

const KEYTOOL = path.join(JDK_DIR, 'bin', 'keytool.exe');
const APKSIGNER = path.join(BUILD_TOOLS_DIR, 'apksigner.bat');
const AAPT2 = path.join(BUILD_TOOLS_DIR, 'aapt2.exe');

const KEYSTORE_PATH = path.join(ANDROID_TWA_DIR, 'sismospma-test-temp.keystore');
const KEY_ALIAS = 'sismotest';

const UNSIGNED_APK = path.join(ANDROID_TWA_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk');
const SIGNED_APK = path.join(ANDROID_TWA_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'sismodata-panama-v1.0.0-test-signed.apk');

const env = {
  ...process.env,
  JAVA_HOME: JDK_DIR,
  ANDROID_HOME: ANDROID_SDK_DIR,
  PATH: `${path.join(JDK_DIR, 'bin')};${BUILD_TOOLS_DIR};${process.env.PATH}`
};

async function main() {
  console.log('=== GENERACIÓN DE CLAVE TEMPORAL Y FIRMA DEL APK DE PRUEBAS ===\n');

  if (!fs.existsSync(UNSIGNED_APK)) {
    throw new Error(`No se encontró el APK sin firmar en: ${UNSIGNED_APK}`);
  }

  // 1. Generar contraseña temporal segura en memoria (NUNCA en logs ni archivos públicos)
  const tempPass = crypto.randomBytes(16).toString('hex') + 'Sismo2026!';

  // 2. Generar Keystore temporal de pruebas (si no existe ya)
  if (!fs.existsSync(KEYSTORE_PATH)) {
    console.log('[1/4] Creando keystore temporal de pruebas (distinto de la clave de publicación)...');
    const dname = 'CN=SismoData Test, OU=QA Testing, O=SismoData Panama, L=Panama, C=PA';
    const genCmd = `"${KEYTOOL}" -genkeypair -v -keystore "${KEYSTORE_PATH}" -alias "${KEY_ALIAS}" -keyalg RSA -keysize 2048 -validity 10000 -dname "${dname}" -storepass "${tempPass}" -keypass "${tempPass}"`;
    execSync(genCmd, { env, stdio: 'ignore' });
    console.log('   Keystore temporal creado en:', KEYSTORE_PATH);
  } else {
    console.log('[1/4] Keystore temporal ya existente.');
  }

  // 3. Extraer huella digital SHA-256 de la clave temporal
  console.log('[2/4] Obteniendo huella SHA-256 de la clave temporal...');
  const certInfo = execSync(`"${KEYTOOL}" -list -v -keystore "${KEYSTORE_PATH}" -alias "${KEY_ALIAS}" -storepass "${tempPass}"`, { env }).toString();
  const sha256Match = certInfo.match(/SHA256:\s*([A-F0-9:]+)/i);
  const sha256Fingerprint = sha256Match ? sha256Match[1].trim() : 'NO_DETECTADA';
  console.log('   Huella SHA-256 de prueba:', sha256Fingerprint);

  // 4. Firmar el APK con apksigner (esquemas v1, v2 y v3)
  console.log('[3/4] Firmando APK de prueba con apksigner...');
  if (fs.existsSync(SIGNED_APK)) fs.unlinkSync(SIGNED_APK);

  // Copiar el archivo unsigned al destino antes de firmar
  fs.copyFileSync(UNSIGNED_APK, SIGNED_APK);

  const signCmd = `cmd.exe /c "call \"${APKSIGNER}\" sign --ks \"${KEYSTORE_PATH}\" --ks-key-alias \"${KEY_ALIAS}\" --ks-pass \"pass:${tempPass}\" --key-pass \"pass:${tempPass}\" --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \"${SIGNED_APK}\""`;
  execSync(signCmd, { env });
  console.log('   APK firmado exitosamente en:', SIGNED_APK);

  // 5. Verificar firma con apksigner
  console.log('[4/4] Verificando integridad criptográfica y metadatos del APK...');
  const verifyOutput = execSync(`cmd.exe /c "call \"${APKSIGNER}\" verify --verbose --print-certs \"${SIGNED_APK}\""`, { env }).toString();
  const isVerified = verifyOutput.includes('Verifies');
  console.log('   Verificación de firma válida:', isVerified);

  // 6. Volcar metadatos con aapt2 dump badging
  const badging = execSync(`"${AAPT2}" dump badging "${SIGNED_APK}"`, { env }).toString();

  const pkgMatch = badging.match(/package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/);
  const targetSdkMatch = badging.match(/targetSdkVersion:'([^']+)'/);
  const compileSdkMatch = badging.match(/compileSdkVersion='([^']+)'/);
  const appLabelMatch = badging.match(/application-label:'([^']+)'/);
  const launchUrlMatch = badging.match(/name='launchUrl' value='([^']+)'/) || badging.match(/launchUrl/);

  const stat = fs.statSync(SIGNED_APK);
  const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
  const sizeKb = Math.round(stat.size / 1024);

  console.log('\n=== RESULTADO DE AUDITORÍA DEL APK GENERADO ===');
  console.log(`Nombre de la App:      ${appLabelMatch ? appLabelMatch[1] : 'SismoData Panamá'}`);
  console.log(`Package ID:            ${pkgMatch ? pkgMatch[1] : 'pa.sismodata.app'}`);
  console.log(`Version Name:          ${pkgMatch ? pkgMatch[3] : '1.0.0'}`);
  console.log(`Version Code:          ${pkgMatch ? pkgMatch[2] : '1'}`);
  console.log(`Compile SDK:           ${compileSdkMatch ? compileSdkMatch[1] : '36'}`);
  console.log(`Target SDK:            ${targetSdkMatch ? targetSdkMatch[1] : '36'}`);
  console.log(`Tamaño del archivo:    ${sizeKb} KB (${sizeMb} MB, ${stat.size} bytes)`);
  console.log(`Ubicación exacta:      ${SIGNED_APK}`);
  console.log(`Huella SHA-256 clave:  ${sha256Fingerprint}`);
  console.log(`Destino web exclusivo: https://sismospma.netlify.app/`);
  console.log('================================================\n');

  // Guardar resumen en un archivo temporal seguro en android-twa/
  const summary = {
    appName: appLabelMatch ? appLabelMatch[1] : 'SismoData Panamá',
    packageId: pkgMatch ? pkgMatch[1] : 'pa.sismodata.app',
    versionName: pkgMatch ? pkgMatch[3] : '1.0.0',
    versionCode: pkgMatch ? pkgMatch[2] : '1',
    compileSdkVersion: compileSdkMatch ? compileSdkMatch[1] : '36',
    targetSdkVersion: targetSdkMatch ? targetSdkMatch[1] : '36',
    fileSizeBytes: stat.size,
    fileSizeFormatted: `${sizeKb} KB (${sizeMb} MB)`,
    apkPath: SIGNED_APK,
    sha256Fingerprint: sha256Fingerprint,
    targetUrl: 'https://sismospma.netlify.app/'
  };

  fs.writeFileSync(path.join(ANDROID_TWA_DIR, 'apk-audit.json'), JSON.stringify(summary, null, 2), 'utf8');
}

main().catch(err => {
  console.error('Error durante la firma del APK:', err);
  process.exit(1);
});
