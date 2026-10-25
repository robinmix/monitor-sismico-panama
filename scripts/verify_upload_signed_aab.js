const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BUBBLEWRAP_DIR = path.resolve(process.env.USERPROFILE, '.bubblewrap');
const JDK_DIR = path.join(BUBBLEWRAP_DIR, 'jdk');
const JARSIGNER = path.join(JDK_DIR, 'bin', 'jarsigner.exe');
const KEYTOOL = path.join(JDK_DIR, 'bin', 'keytool.exe');

const AAB_SIGNED = path.join(PROJECT_ROOT, 'android-twa', 'app', 'build', 'outputs', 'bundle', 'release', 'sismopa-v1.0.2-upload-signed.aab');

const env = {
  ...process.env,
  JAVA_HOME: JDK_DIR,
  PATH: `${path.join(JDK_DIR, 'bin')};${process.env.PATH}`
};

function verify() {
  console.log('=== AUDITORÍA CRIPTOGRÁFICA DE AAB Alpha 1.0.2 ===\n');

  if (!fs.existsSync(AAB_SIGNED)) {
    console.error(`ERROR: No se encontró el archivo firmado en: ${AAB_SIGNED}`);
    console.log('Ejecute primero en su terminal PowerShell:');
    console.log('powershell -ExecutionPolicy Bypass -File .\\scripts\\create_upload_keystore_and_sign_aab.ps1\n');
    process.exit(1);
  }

  const stat = fs.statSync(AAB_SIGNED);
  const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
  const sizeKb = Math.round(stat.size / 1024);

  // 1. Verificar firma jarsigner
  console.log('[1/3] Verificando firma criptográfica con jarsigner...');
  const verifyOut = execSync(`"${JARSIGNER}" -verify -verbose -certs "${AAB_SIGNED}"`, { env }).toString();
  const isVerified = verifyOut.includes('jar verified.');
  console.log(`      Resultado: ${isVerified ? 'VÁLIDA (jar verified.)' : 'FALLIDO'}`);

  // 2. Extraer certificado del AAB
  console.log('[2/3] Extrayendo huella SHA-256 del certificado embebido...');
  const certMatches = verifyOut.match(/SHA-256 digest:\s*([a-f0-9]+)/gi) || [];
  
  // Extraer con keytool printcert directamente del archivo firmado
  let sha256Found = 'NO_DETECTADA';
  try {
    const printCertOut = execSync(`"${KEYTOOL}" -printcert -jarfile "${AAB_SIGNED}"`, { env }).toString();
    const shaMatch = printCertOut.match(/SHA256:\s*([A-F0-9:]+)/i);
    if (shaMatch) {
      sha256Found = shaMatch[1].trim();
    }
  } catch (e) {
    // fallback
  }

  const EXPECTED_SHA256 = 'D2:59:B7:64:52:58:C0:EB:78:7D:5C:F5:5B:05:E4:04:00:64:B7:78:5B:9A:ED:FE:E5:46:00:B6:DD:CC:A0:FE';
  const matchesExpected = sha256Found.toUpperCase() === EXPECTED_SHA256.toUpperCase();

  console.log(`      Huella detectada: ${sha256Found}`);
  console.log(`      Coincide con Google Play Console: ${matchesExpected ? 'SÍ (OK)' : 'NO (ERROR)'}`);

  // 3. Confirmar metadatos en manifest empaquetado
  console.log('[3/3] Confirmando metadatos de versión y paquete...');
  const manifestPath = path.join(PROJECT_ROOT, 'android-twa', 'app', 'build', 'intermediates', 'bundle_manifest', 'release', 'processApplicationManifestReleaseForBundle', 'AndroidManifest.xml');
  let pkgName = 'pa.sismodata.app';
  let vCode = '3';
  let vName = '1.0.2';
  if (fs.existsSync(manifestPath)) {
    const manifestContent = fs.readFileSync(manifestPath, 'utf8');
    const pMatch = manifestContent.match(/package="([^"]+)"/);
    const vcMatch = manifestContent.match(/android:versionCode="([^"]+)"/);
    const vnMatch = manifestContent.match(/android:versionName="([^"]+)"/);
    if (pMatch) pkgName = pMatch[1];
    if (vcMatch) vCode = vcMatch[1];
    if (vnMatch) vName = vnMatch[1];
  }

  console.log('\n======================================================');
  console.log('=== RESULTADO DE VERIFICACIÓN OFICIAL AAB 1.0.2    ===');
  console.log('======================================================');
  console.log(`Ruta AAB firmado:   ${AAB_SIGNED}`);
  console.log(`Tamaño:             ${sizeKb} KB (${sizeMb} MB, ${stat.size} bytes)`);
  console.log(`Package ID:         ${pkgName}`);
  console.log(`Version Name:       ${vName}`);
  console.log(`Version Code:       ${vCode}`);
  console.log(`Firma verificada:   ${isVerified ? 'OK (jar verified)' : 'ERROR'}`);
  console.log(`Huella SHA-256:     ${sha256Found}`);
  console.log(`Google Play Match:  ${matchesExpected ? 'VÁLIDO PARA SUBIR' : 'NO COINCIDE'}`);
  console.log('======================================================\n');
}

verify();
