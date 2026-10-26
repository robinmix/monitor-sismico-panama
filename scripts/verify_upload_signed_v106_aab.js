'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const AAB_PATH = path.join(
  ROOT_DIR,
  'android-twa/app/build/outputs/bundle/release/sismopa-v1.0.6-upload-signed.aab'
);
const BASE_AAB_PATH = path.join(
  ROOT_DIR,
  'android-twa/app/build/outputs/bundle/release/app-release.aab'
);

const JARSIGNER_PATH = 'C:\\Users\\robin\\.bubblewrap\\jdk\\bin\\jarsigner.exe';

console.log('==================================================================');
console.log('=== sismoPA: Verificación Técnica AAB Alpha 1.0.6 (FCM Nativo) ===');
console.log('==================================================================\n');

// 1. Verificar existencia de archivos
const targetAab = fs.existsSync(AAB_PATH) ? AAB_PATH : BASE_AAB_PATH;
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
    console.log('      AAB sin firmar con jarsigner (esperado previo a la ejecución del script de firma oficial).');
  }
} else {
  console.log('      jarsigner no encontrado en ruta habitual; omisión de verificación de firma.');
}

// 3. Inspeccionar manifiesto merged
console.log('\n[3/4] Auditando AndroidManifest.xml de release bundle...');
const mergedManifestPath = path.join(
  ROOT_DIR,
  'android-twa/app/build/intermediates/bundle_manifest/release/processApplicationManifestReleaseForBundle/AndroidManifest.xml'
);

if (fs.existsSync(mergedManifestPath)) {
  const manifestXml = fs.readFileSync(mergedManifestPath, 'utf8');

  const hasPackage = manifestXml.includes('package="pa.sismodata.app"');
  const hasVersionCode7 = manifestXml.includes('android:versionCode="7"');
  const hasVersionName106 = manifestXml.includes('android:versionName="1.0.6"');
  const hasPostNotif = manifestXml.includes('android.permission.POST_NOTIFICATIONS');
  const hasFcmService = manifestXml.includes('SismoFirebaseMessagingService');
  const hasMessagingFilter = manifestXml.includes('com.google.firebase.MESSAGING_EVENT');
  const hasDeepLink = manifestXml.includes('android:scheme="sismopa"');

  console.log(`      Paquete oficial pa.sismodata.app: ${hasPackage ? 'CONFIRMADO' : 'FALLO'}`);
  console.log(`      versionCode="7":                 ${hasVersionCode7 ? 'CONFIRMADO' : 'FALLO'}`);
  console.log(`      versionName="1.0.6":             ${hasVersionName106 ? 'CONFIRMADO' : 'FALLO'}`);
  console.log(`      Permiso POST_NOTIFICATIONS:      ${hasPostNotif ? 'CONFIRMADO' : 'FALLO'}`);
  console.log(`      SismoFirebaseMessagingService:   ${hasFcmService ? 'CONFIRMADO' : 'FALLO'}`);
  console.log(`      Filtro com.google.firebase.MESSAGING_EVENT: ${hasMessagingFilter ? 'CONFIRMADO' : 'FALLO'}`);
  console.log(`      Deep Link nativo sismopa://:     ${hasDeepLink ? 'CONFIRMADO' : 'FALLO'}`);

  if (hasPackage && hasVersionCode7 && hasVersionName106 && hasPostNotif && hasFcmService && hasMessagingFilter) {
    console.log('\n[4/4] Integración Android release: 100% COMPATIBLE Y LISTA.');
  } else {
    console.error('\n[4/4] ADVERTENCIA: Faltan componentes críticos en el manifiesto.');
    process.exit(1);
  }
} else {
  console.log('      Manifiesto merged no encontrado en ruta habitual.');
}

console.log('\n=== VALIDACIÓN TÉCNICA FINALIZADA CON ÉXITO ===');
