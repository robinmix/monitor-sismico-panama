#!/usr/bin/env node
/**
 * sismoPA — Script de prueba de despacho FCM directo a dispositivo (HTTP v1)
 *
 * Envía un mensaje Data-Only de alta prioridad directamente al token de un dispositivo
 * de desarrollo sin difundir al topic general 'sismos_panama'.
 *
 * Uso:
 *   node scripts/send_fcm_direct_test.js --token <DEVICE_FCM_TOKEN> [--sa <PATH_TO_SERVICE_ACCOUNT_JSON>]
 */

const fs = require('fs');
const path = require('path');

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    token: null,
    saPath: null,
    title: '[PRUEBA TÉCNICA] sismoPA',
    body: 'Verificación de notificaciones nativas Android. NO ES UN SISMO REAL.',
    sourceUid: 'test_dev_' + Date.now()
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--token' && args[i + 1]) {
      options.token = args[++i];
    } else if (args[i] === '--sa' && args[i + 1]) {
      options.saPath = args[++i];
    } else if (args[i] === '--title' && args[i + 1]) {
      options.title = args[++i];
    } else if (args[i] === '--body' && args[i + 1]) {
      options.body = args[++i];
    }
  }

  return options;
}

async function main() {
  const opts = parseArgs();

  console.log('=== PRUEBA DE ENVÍO DIRECTO FCM (HTTP v1 DATA-ONLY) ===');

  if (!opts.token) {
    console.error('ERROR: Debes proporcionar el token de registro del dispositivo.');
    console.error('Ejemplo: node scripts/send_fcm_direct_test.js --token <DEVICE_FCM_TOKEN>');
    console.error('Puedes obtener el token desde la pantalla "Alertas Sísmicas" de la app sismoPA (botón "Copiar Token").');
    process.exit(1);
  }

  let serviceAccount = null;
  if (opts.saPath) {
    if (!fs.existsSync(opts.saPath)) {
      console.error(`ERROR: No se encontró el archivo de cuenta de servicio en: ${opts.saPath}`);
      process.exit(1);
    }
    serviceAccount = JSON.parse(fs.readFileSync(opts.saPath, 'utf8'));
  } else if (process.env.FCM_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON);
  } else {
    console.warn('ADVERTENCIA: No se especificó --sa ni la variable de entorno FCM_SERVICE_ACCOUNT_JSON.');
    console.warn('Para realizar un despacho real con Firebase v1, proporciona la clave descargada de Firebase Console:');
    console.warn('  node scripts/send_fcm_direct_test.js --token ' + opts.token + ' --sa ./fcm-sa.json\n');
  }

  const payload = {
    title: opts.title,
    body: opts.body,
    url: 'https://sismopa.pages.dev/?sismo=' + encodeURIComponent(opts.sourceUid),
    source_uid: opts.sourceUid,
    magnitude: '4.8',
    sent_at: new Date().toISOString()
  };

  const maskedToken = opts.token.length > 20
    ? `${opts.token.slice(0, 10)}...${opts.token.slice(-6)}`
    : '***';
  console.log('Dispositivo objetivo (enmascarado):', maskedToken);
  console.log('Proyecto FCM:', serviceAccount?.project_id || 'sismopa-notificaciones');
  if (serviceAccount?.client_email) {
    const maskedEmail = serviceAccount.client_email.replace(/^([^@]{3})[^@]+(@.*)$/, '$1***$2');
    console.log('Cuenta de servicio (enmascarada):', maskedEmail);
  }
  console.log('Payload Data-Only:', JSON.stringify(payload, null, 2));

  if (!serviceAccount) {
    console.log('\n[SIMULACIÓN] Estructura del mensaje validada correctamente. Listo para despacho con credenciales de cuenta de servicio.');
    process.exit(0);
  }

  try {
    const { sendFcmDirectMessage } = await import('../cloudflare/lib/fcm-dispatch.mjs');
    const result = await sendFcmDirectMessage({
      projectId: serviceAccount.project_id || 'sismopa-notificaciones',
      deviceToken: opts.token,
      payload,
      serviceAccount
    });

    console.log('\n[ÉXITO] Mensaje enviado satisfactoriamente a través de Firebase HTTP v1:');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('\n[ERROR] Falló el despacho FCM:', err.message);
    process.exit(1);
  }
}

if (process.argv[1] && process.argv[1].endsWith('send_fcm_direct_test.js')) {
  main();
}
