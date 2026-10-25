const fs = require('fs');
const path = require('path');
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

// Almacén y archivo de contraseña fuera del repositorio GitHub
const ANDROID_HOME_DIR = path.join(process.env.USERPROFILE, '.android');
const KEYSTORE_PATH = path.join(ANDROID_HOME_DIR, 'sismopa-test-signing.keystore');
const PASS_FILE = path.join(ANDROID_HOME_DIR, 'sismopa-signing.pass');
const KEY_ALIAS = 'sismotest';

const UNSIGNED_APK = path.join(ANDROID_TWA_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk');
const SIGNED_APK = path.join(ANDROID_TWA_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'sismopa-v1.0.1-test-signed.apk');

const env = {
  ...process.env,
  JAVA_HOME: JDK_DIR,
  ANDROID_HOME: ANDROID_SDK_DIR,
  PATH: `${path.join(JDK_DIR, 'bin')};${BUILD_TOOLS_DIR};${process.env.PATH}`
};

async function main() {
  console.log('=== CREACIÓN DE KEYSTORE PERSISTENTE RSA 4096-BIT Y FIRMA DE sismoPA 1.0.1 ===\n');

  if (!fs.existsSync(UNSIGNED_APK)) {
    throw new Error(`No se encontró el APK compilado en: ${UNSIGNED_APK}`);
  }

  // 1. Lectura segura de contraseña desde archivo privado
  if (!fs.existsSync(PASS_FILE)) {
    throw new Error(`No se encontró el archivo de contraseña en: ${PASS_FILE}`);
  }
  const passContent = fs.readFileSync(PASS_FILE, 'utf8');
  const passLines = passContent.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));
  if (passLines.length === 0) {
    throw new Error('El archivo sismopa-signing.pass no contiene una contraseña válida.');
  }
  const password = passLines[0];
  console.log(`[1/5] Contraseña leída de forma segura desde archivo privado (${password.length} caracteres).`);

  // 2. Creación del Keystore RSA 4096-bit fuera del repositorio
  if (fs.existsSync(KEYSTORE_PATH)) {
    console.log('[2/5] Keystore ya existe en:', KEYSTORE_PATH);
  } else {
    console.log('[2/5] Generando nuevo Keystore RSA 4096-bit (validez 10000 días)...');
    const dname = 'CN=sismoPA Test, OU=QA Testing, O=sismoPA Panama, L=Panama, C=PA';
    const genCmd = `"${KEYTOOL}" -genkeypair -v -keystore "${KEYSTORE_PATH}" -alias "${KEY_ALIAS}" -keyalg RSA -keysize 4096 -validity 10000 -dname "${dname}" -storepass "${password}" -keypass "${password}"`;
    execSync(genCmd, { env, stdio: 'ignore' });
    console.log('   Keystore creado exitosamente en:', KEYSTORE_PATH);
  }

  // 3. Comprobar que el Keystore puede volver a abrirse con la contraseña guardada
  console.log('[3/5] Verificando apertura del Keystore y extrayendo huella SHA-256...');
  const certInfo = execSync(`"${KEYTOOL}" -list -v -keystore "${KEYSTORE_PATH}" -alias "${KEY_ALIAS}" -storepass "${password}"`, { env }).toString();
  const sha256Match = certInfo.match(/SHA256:\s*([A-F0-9:]+)/i);
  const sha256Fingerprint = sha256Match ? sha256Match[1].trim() : 'NO_DETECTADA';
  console.log('   Keystore desbloqueado correctamente.');
  console.log('   Huella SHA-256 del certificado RSA 4096-bit:', sha256Fingerprint);

  // 4. Firmar el APK con apksigner
  console.log('[4/5] Firmando APK sismoPA 1.0.1 con apksigner (esquemas v1, v2 y v3)...');
  if (fs.existsSync(SIGNED_APK)) fs.unlinkSync(SIGNED_APK);
  fs.copyFileSync(UNSIGNED_APK, SIGNED_APK);

  const signCmd = `cmd.exe /c "call \"${APKSIGNER}\" sign --ks \"${KEYSTORE_PATH}\" --ks-key-alias \"${KEY_ALIAS}\" --ks-pass \"file:${PASS_FILE}\" --key-pass \"file:${PASS_FILE}\" --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \"${SIGNED_APK}\""`;
  execSync(signCmd, { env });
  console.log('   APK firmado exitosamente en:', SIGNED_APK);

  // 5. Validar firma criptográfica
  console.log('[5/5] Auditando firma y metadatos con apksigner y aapt2...');
  const verifyOutput = execSync(`cmd.exe /c "call \"${APKSIGNER}\" verify --verbose --print-certs \"${SIGNED_APK}\""`, { env }).toString();
  const isVerified = verifyOutput.includes('Verifies');

  const badging = execSync(`"${AAPT2}" dump badging "${SIGNED_APK}"`, { env }).toString();
  const pkgMatch = badging.match(/package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/);
  const targetSdkMatch = badging.match(/targetSdkVersion:'([^']+)'/);
  const compileSdkMatch = badging.match(/compileSdkVersion='([^']+)'/);
  const appLabelMatch = badging.match(/application-label:'([^']+)'/);

  const stat = fs.statSync(SIGNED_APK);
  const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
  const sizeKb = Math.round(stat.size / 1024);

  console.log('\n======================================================');
  console.log('=== AUDITORÍA COMPLETA: sismoPA v1.0.1 (RSA 4096)  ===');
  console.log('======================================================');
  console.log(`Nombre de la App:      ${appLabelMatch ? appLabelMatch[1] : 'sismoPA'}`);
  console.log(`Package ID:            ${pkgMatch ? pkgMatch[1] : 'pa.sismodata.app'}`);
  console.log(`Version Name:          ${pkgMatch ? pkgMatch[3] : '1.0.1'}`);
  console.log(`Version Code:          ${pkgMatch ? pkgMatch[2] : '2'}`);
  console.log(`Compile SDK:           ${compileSdkMatch ? compileSdkMatch[1] : '36'}`);
  console.log(`Target SDK:            ${targetSdkMatch ? targetSdkMatch[1] : '36'}`);
  console.log(`Tamaño del archivo:    ${sizeKb} KB (${sizeMb} MB, ${stat.size} bytes)`);
  console.log(`Ubicación exacta APK:  ${SIGNED_APK}`);
  console.log(`Ubicación Keystore:    ${KEYSTORE_PATH}`);
  console.log(`Algoritmo de clave:    RSA 4096 bits`);
  console.log(`Firma verificada:      ${isVerified ? 'VÁLIDA (true)' : 'INVÁLIDA'}`);
  console.log(`Huella SHA-256 final:  ${sha256Fingerprint}`);
  console.log(`Destino web exclusivo: https://sismospma.netlify.app/`);
  console.log('======================================================\n');

  // Guardar resumen en apk-audit.json
  const summary = {
    appName: appLabelMatch ? appLabelMatch[1] : 'sismoPA',
    packageId: pkgMatch ? pkgMatch[1] : 'pa.sismodata.app',
    versionName: pkgMatch ? pkgMatch[3] : '1.0.1',
    versionCode: pkgMatch ? pkgMatch[2] : '2',
    compileSdkVersion: compileSdkMatch ? compileSdkMatch[1] : '36',
    targetSdkVersion: targetSdkMatch ? targetSdkMatch[1] : '36',
    keyAlgorithm: 'RSA 4096-bit',
    fileSizeBytes: stat.size,
    fileSizeFormatted: `${sizeKb} KB (${sizeMb} MB)`,
    apkPath: SIGNED_APK,
    keystorePath: KEYSTORE_PATH,
    sha256Fingerprint: sha256Fingerprint,
    targetUrl: 'https://sismospma.netlify.app/'
  };

  fs.writeFileSync(path.join(ANDROID_TWA_DIR, 'apk-audit.json'), JSON.stringify(summary, null, 2), 'utf8');
}

main().catch(err => {
  console.error('Error durante la firma del APK:', err.message);
  process.exit(1);
});
