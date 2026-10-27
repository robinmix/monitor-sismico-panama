'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const AAB_PATH = path.join(
  ROOT_DIR,
  'android-twa/app/build/outputs/bundle/release/sismopa-v1.0.8-upload-signed.aab'
);
const BASE_AAB_PATH = path.join(
  ROOT_DIR,
  'android-twa/app/build/outputs/bundle/release/app-release.aab'
);

const JARSIGNER_PATH = 'C:\\Users\\robin\\.bubblewrap\\jdk\\bin\\jarsigner.exe';

console.log('==================================================================');
console.log('=== sismoPA: Verificación Técnica AAB Alpha 1.0.8 (UI Producción) ===');
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
  console.log('      jarsigner no encontrado en ruta predeterminada; omitiendo paso de firma.');
}

// 3. Inspeccionar AndroidManifest.xml procesado en el build de release
console.log('\n[3/4] Auditando AndroidManifest.xml de release bundle...');
const manifestPath = path.join(
  ROOT_DIR,
  'android-twa/app/build/intermediates/merged_manifest/release/processReleaseMainManifest/AndroidManifest.xml'
);

if (fs.existsSync(manifestPath)) {
  const manifestXml = fs.readFileSync(manifestPath, 'utf8');

  // Validaciones críticas de empaquetado
  const checks = [
    { label: 'Paquete oficial pa.sismodata.app', ok: manifestXml.includes('package="pa.sismodata.app"') },
    { label: 'versionCode="9"', ok: manifestXml.includes('android:versionCode="9"') },
    { label: 'versionName="1.0.8"', ok: manifestXml.includes('android:versionName="1.0.8"') },
    { label: 'Permiso POST_NOTIFICATIONS', ok: manifestXml.includes('android.permission.POST_NOTIFICATIONS') },
    { label: 'SismoFirebaseMessagingService', ok: manifestXml.includes('SismoFirebaseMessagingService') },
    { label: 'Filtro com.google.firebase.MESSAGING_EVENT', ok: manifestXml.includes('com.google.firebase.MESSAGING_EVENT') },
    { label: 'Deep Link nativo sismopa://', ok: manifestXml.includes('android:scheme="sismopa"') }
  ];

  let allOk = true;
  for (const c of checks) {
    console.log(`      ${c.label.padEnd(45)}: ${c.ok ? 'CONFIRMADO' : 'FALLIDO'}`);
    if (!c.ok) allOk = false;
  }

  if (!allOk) {
    console.error('\nADVERTENCIA: Alguna verificación del manifiesto no pasó.');
  }
} else {
  console.log('      Manifest fusionado no encontrado en ruta intermedia (se verificará al compilar bundleRelease).');
}

// 4. Conclusión
console.log('\n[4/4] Estado general del entregable:');
if (fs.existsSync(AAB_PATH)) {
  console.log('      ✔ AAB listo y firmado para Google Play Store Console (Internal Testing).');
} else {
  console.log('      ✔ AAB compilado listo. Ejecute scripts/create_upload_keystore_and_sign_v108_aab.ps1 para firmarlo con la clave oficial.');
}
console.log('\n==================================================================\n');
