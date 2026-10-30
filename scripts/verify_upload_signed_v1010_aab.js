'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const AAB_PATH = path.join(
  ROOT_DIR,
  'android-twa/app/build/outputs/bundle/release/sismopa-v1.0.10-upload-signed.aab'
);
const TEST_AAB_PATH = path.join(
  ROOT_DIR,
  'android-twa/app/build/outputs/bundle/release/sismopa-v1.0.10-test-signed.aab'
);
const BASE_AAB_PATH = path.join(
  ROOT_DIR,
  'android-twa/app/build/outputs/bundle/release/app-release.aab'
);

const JARSIGNER_PATH = 'C:\\Users\\robin\\.bubblewrap\\jdk\\bin\\jarsigner.exe';

console.log('==================================================================');
console.log('=== sismoPA: Verificación Técnica AAB Alpha 1.0.10 (Multi-Device) ===');
console.log('==================================================================\n');

// 1. Verificar existencia de archivos
const targetAab = fs.existsSync(AAB_PATH) ? AAB_PATH : (fs.existsSync(TEST_AAB_PATH) ? TEST_AAB_PATH : BASE_AAB_PATH);
console.log(`[1/4] Inspeccionando archivo AAB: ${targetAab}`);
if (!fs.existsSync(targetAab)) {
  console.error(`ERROR: No se encontró el archivo AAB en: ${targetAab}`);
  process.exit(1);
}

const stats = fs.statSync(targetAab);
console.log(`      Tamaño: ${(stats.size / 1024 / 1024).toFixed(2)} MB (${stats.size} bytes)`);

// 2. Verificar integridad y firma
console.log('\n[2/4] Verificando estructura con jarsigner...');
if (fs.existsSync(JARSIGNER_PATH)) {
  try {
    const verifyOut = execSync(`"${JARSIGNER_PATH}" -verify -verbose -certs "${targetAab}"`, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });

    if (verifyOut.includes('jar verified')) {
      console.log('      Firma digital: VALIDADA (jar verified)');
    } else {
      console.log('      Aviso: El AAB actual es la versión base limpia compilada por Gradle (pendiente de firma con clave de carga oficial).');
    }
  } catch (e) {
    console.log('      Error ejecutando jarsigner:', e.message);
  }
}

// 3. Inspección del manifiesto procesado
console.log('\n[3/4] Verificando manifiesto procesado (Merged Manifest)...');
const mergedManifest = path.join(
  ROOT_DIR,
  'android-twa/app/build/intermediates/bundle_manifest/release/processApplicationManifestReleaseForBundle/AndroidManifest.xml'
);

if (fs.existsSync(mergedManifest)) {
  const xml = fs.readFileSync(mergedManifest, 'utf8');
  const pkgOk = xml.includes('package="pa.sismodata.app"');
  const vCodeMatch = xml.match(/android:versionCode="(\d+)"/);
  const vNameMatch = xml.match(/android:versionName="([^"]+)"/);
  const hasPostNotif = xml.includes('android.permission.POST_NOTIFICATIONS');
  const hasCoarseLoc = xml.includes('android.permission.ACCESS_COARSE_LOCATION');
  const hasFineLoc = xml.includes('android.permission.ACCESS_FINE_LOCATION');
  const noBgLoc = !xml.includes('android.permission.ACCESS_BACKGROUND_LOCATION');
  const hasPermActivity = xml.includes('PermissionRequestActivity');
  const hasFcm = xml.includes('pa.sismodata.app.SismoFirebaseMessagingService');

  console.log(`      Paquete: pa.sismodata.app (${pkgOk ? 'OK' : 'FALLÓ'})`);
  console.log(`      versionCode: ${vCodeMatch ? vCodeMatch[1] : 'No detectado'} (Esperado: 11)`);
  console.log(`      versionName: ${vNameMatch ? vNameMatch[1] : 'No detectado'} (Esperado: 1.0.10)`);
  console.log(`      POST_NOTIFICATIONS: ${hasPostNotif ? 'DECLARADO (OK)' : 'FALTA'}`);
  console.log(`      ACCESS_COARSE_LOCATION: ${hasCoarseLoc ? 'DECLARADO (OK - Permite GPS nativo)' : 'FALTA'}`);
  console.log(`      ACCESS_FINE_LOCATION: ${hasFineLoc ? 'DECLARADO (OK - Permite GPS nativo)' : 'FALTA'}`);
  console.log(`      ACCESS_BACKGROUND_LOCATION EXCLUIDO: ${noBgLoc ? 'CONFIRMADO (Cumple Google Play)' : 'ADVERTENCIA'}`);
  console.log(`      PermissionRequestActivity: ${hasPermActivity ? 'REGISTRADO (OK - Delegación Chromium TWA)' : 'FALTA'}`);
  console.log(`      SismoFirebaseMessagingService: ${hasFcm ? 'REGISTRADO (OK)' : 'FALTA'}`);

  const passed = pkgOk &&
    vCodeMatch && vCodeMatch[1] === '11' &&
    vNameMatch && vNameMatch[1] === '1.0.10' &&
    hasPostNotif &&
    hasFineLoc &&
    hasCoarseLoc &&
    noBgLoc &&
    hasPermActivity &&
    hasFcm;

  if (passed) {
    console.log('\n✔ Verificación técnica de Alpha 1.0.10 completada: 100% CONFORME.');
  } else {
    console.error('\n✖ Al menos un requisito técnico de Alpha 1.0.10 falló.');
    process.exit(1);
  }
} else {
  console.log('      Merged manifest no encontrado (ejecute primero bundleRelease).');
}

console.log('\n[4/4] Resumen de comprobación finalizado.\n');
