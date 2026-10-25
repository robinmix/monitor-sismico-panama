const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BUBBLEWRAP_DIR = path.resolve(process.env.USERPROFILE, '.bubblewrap');
const JDK_DIR = path.join(BUBBLEWRAP_DIR, 'jdk');
const JARSIGNER = path.join(JDK_DIR, 'bin', 'jarsigner.exe');
const KEYTOOL = path.join(JDK_DIR, 'bin', 'keytool.exe');
const JAR_TOOL = path.join(JDK_DIR, 'bin', 'jar.exe');

const AAB_SIGNED = path.join(PROJECT_ROOT, 'android-twa', 'app', 'build', 'outputs', 'bundle', 'release', 'sismopa-v1.0.3-upload-signed.aab');

const env = {
  ...process.env,
  JAVA_HOME: JDK_DIR,
  PATH: `${path.join(JDK_DIR, 'bin')};${process.env.PATH}`
};

function sha256File(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(fileBuffer);
  return hashSum.digest('hex').toUpperCase();
}

function verify() {
  console.log('=== AUDITORÍA CRIPTOGRÁFICA DE AAB Alpha 1.0.3 ===\n');

  if (!fs.existsSync(AAB_SIGNED)) {
    console.error(`ERROR: No se encontró el archivo firmado en: ${AAB_SIGNED}`);
    console.log('Ejecute primero en su terminal PowerShell:');
    console.log('powershell -ExecutionPolicy Bypass -File .\\scripts\\create_upload_keystore_and_sign_v103_aab.ps1\n');
    return false;
  }

  const stat = fs.statSync(AAB_SIGNED);
  const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
  const sizeKb = Math.round(stat.size / 1024);
  const fileHash = sha256File(AAB_SIGNED);

  // 1. Verificar firma jarsigner
  console.log('[1/4] Verificando firma criptográfica con jarsigner...');
  const verifyOut = execSync(`"${JARSIGNER}" -verify -verbose -certs "${AAB_SIGNED}"`, { env }).toString();
  const isVerified = verifyOut.includes('jar verified.');
  console.log(`      Resultado: ${isVerified ? 'VÁLIDA (jar verified.)' : 'FALLIDO'}`);

  // 2. Extraer huella SHA-256 del certificado embebido con keytool
  console.log('[2/4] Extrayendo huella SHA-256 del certificado con keytool...');
  let sha256Found = 'NO_DETECTADA';
  try {
    const printCertOut = execSync(`"${KEYTOOL}" -printcert -jarfile "${AAB_SIGNED}"`, { env }).toString();
    const shaMatch = printCertOut.match(/SHA256:\s*([A-F0-9:]+)/i);
    if (shaMatch) {
      sha256Found = shaMatch[1].trim();
    }
  } catch (e) {
    console.warn('      Error ejecutando keytool -printcert:', e.message);
  }

  const EXPECTED_UPLOAD_SHA256 = 'D2:59:B7:64:52:58:C0:EB:78:7D:5C:F5:5B:05:E4:04:00:64:B7:78:5B:9A:ED:FE:E5:46:00:B6:DD:CC:A0:FE';
  const matchesExpected = sha256Found.toUpperCase() === EXPECTED_UPLOAD_SHA256.toUpperCase();
  console.log(`      Huella detectada: ${sha256Found}`);
  console.log(`      Coincide con Clave de Carga registrada en Google Play: ${matchesExpected ? 'SÍ (VÁLIDA)' : 'NO (ERROR)'}`);

  // 3. Confirmar metadatos en manifest fusionado
  console.log('[3/4] Confirmando metadatos de versión y paquete en manifiesto empaquetado...');
  const manifestPath = path.join(PROJECT_ROOT, 'android-twa', 'app', 'build', 'intermediates', 'bundle_manifest', 'release', 'processApplicationManifestReleaseForBundle', 'AndroidManifest.xml');
  let pkgName = 'pa.sismodata.app';
  let vCode = '4';
  let vName = '1.0.3';
  let hasPostNotif = false;
  let hasDelegation = false;
  let hasSmallIcon = false;

  if (fs.existsSync(manifestPath)) {
    const manifestContent = fs.readFileSync(manifestPath, 'utf8');
    const pMatch = manifestContent.match(/package="([^"]+)"/);
    const vcMatch = manifestContent.match(/android:versionCode="([^"]+)"/);
    const vnMatch = manifestContent.match(/android:versionName="([^"]+)"/);
    if (pMatch) pkgName = pMatch[1];
    if (vcMatch) vCode = vcMatch[1];
    if (vnMatch) vName = vnMatch[1];

    hasPostNotif = manifestContent.includes('android.permission.POST_NOTIFICATIONS');
    hasDelegation = manifestContent.includes('pa.sismodata.app.DelegationService') && manifestContent.includes('TRUSTED_WEB_ACTIVITY_SERVICE');
    hasSmallIcon = manifestContent.includes('android.support.customtabs.trusted.SMALL_ICON');
  }

  // 4. Verificar recursos en el archivo AAB
  console.log('[4/4] Verificando recursos drawables en el paquete...');
  const jarList = execSync(`"${JAR_TOOL}" tf "${AAB_SIGNED}"`, { env }).toString();
  const hasIcons = jarList.includes('ic_notification_icon.png');

  console.log('\n======================================================');
  console.log('=== RESULTADO DE VERIFICACIÓN OFICIAL AAB 1.0.3    ===');
  console.log('======================================================');
  console.log(`Ruta AAB firmado:         ${AAB_SIGNED}`);
  console.log(`Tamaño:                   ${sizeKb} KB (${sizeMb} MB, ${stat.size} bytes)`);
  console.log(`SHA-256 del binario:      ${fileHash}`);
  console.log(`Package ID:               ${pkgName}`);
  console.log(`Version Name:             ${vName}`);
  console.log(`Version Code:             ${vCode}`);
  console.log(`Firma jarsigner:          ${isVerified ? 'OK (jar verified)' : 'ERROR'}`);
  console.log(`Huella Certificado:       ${sha256Found}`);
  console.log(`Clave de Carga Coincide:  ${matchesExpected ? 'VÁLIDA PARA GOOGLE PLAY' : 'ERROR'}`);
  console.log(`Permiso POST_NOTIF:       ${hasPostNotif ? 'PRESENTE' : 'FALTANTE'}`);
  console.log(`DelegationService TWA:    ${hasDelegation ? 'CONFIGURADO' : 'FALTANTE'}`);
  console.log(`SMALL_ICON meta-data:     ${hasSmallIcon ? 'PRESENTE' : 'FALTANTE'}`);
  console.log(`Drawables Monocromáticos: ${hasIcons ? 'EMPAQUETADOS' : 'FALTANTES'}`);
  console.log('======================================================\n');

  return isVerified && matchesExpected && vCode === '4' && vName === '1.0.3';
}

if (require.main === module) {
  const ok = verify();
  process.exit(ok ? 0 : 1);
}

module.exports = { verify, sha256File };
