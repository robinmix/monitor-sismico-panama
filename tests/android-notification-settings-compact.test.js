'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');

test('Suite Android Native — Notificaciones Sísmicas Compactas y Centradas', async (t) => {
  const activityPath = path.join(rootDir, 'android-twa/app/src/main/java/pa/sismodata/app/SismoNotificationSettingsActivity.java');
  assert.ok(fs.existsSync(activityPath), 'SismoNotificationSettingsActivity.java debe existir');
  const code = fs.readFileSync(activityPath, 'utf8');

  await t.test('1. Encabezado centrado, subtítulo recomendado y separación reducida', () => {
    assert.match(code, /title\.setGravity\(Gravity\.CENTER\);/, 'Título debe estar centrado');
    assert.match(code, /title\.setTextSize\(TypedValue\.COMPLEX_UNIT_SP,\s*20\);/, 'Título debe tener tamaño compacto (20sp)');
    assert.ok(code.includes('Avisos informativos de sismos en Panamá'), 'Subtítulo debe tener el texto recomendado');
    assert.match(code, /subtitle\.setGravity\(Gravity\.CENTER\);/, 'Subtítulo debe estar centrado');
    assert.match(code, /subtitle\.setPadding\(0,\s*dp\(2\),\s*0,\s*dp\(12\)\);/, 'Separación vertical del subtítulo debe ser reducida (12dp)');
  });

  await t.test('2. Tarjeta FCM centrada y descripción breve para estado activo', () => {
    assert.match(code, /card\.setGravity\(Gravity\.CENTER_HORIZONTAL\);/, 'Tarjeta FCM debe centrar su contenido');
    assert.match(code, /badgeParams\.gravity\s*=\s*Gravity\.CENTER_HORIZONTAL;/, 'Badge de estado debe estar centrado');
    assert.match(code, /mStatusDesc\.setGravity\(Gravity\.CENTER\);/, 'Descripción de estado debe estar centrada');
    assert.ok(
      code.includes('Recibirás avisos cuando el IGC-UP publique nuevos reportes sísmicos.'),
      'Descripción para estado activo debe ser breve'
    );
    assert.ok(code.includes('Desactivar Alertas'), 'Botón Desactivar Alertas debe conservarse');
  });

  await t.test('3. Distancia en notificaciones centrada y botones táctiles accesibles', () => {
    assert.match(code, /distTitle\.setGravity\(Gravity\.CENTER\);/, 'Título de distancia debe estar centrado');
    assert.match(code, /mDistStatus\.setGravity\(Gravity\.CENTER\);/, 'Estado de distancia debe estar centrado');
    assert.match(code, /mActiveActionRow\.setGravity\(Gravity\.CENTER\);/, 'Fila de acciones de distancia debe estar centrada');
    assert.ok(code.includes('ACTUALIZAR GPS'), 'Botón ACTUALIZAR GPS debe conservarse');
    assert.ok(code.includes('DESACTIVAR'), 'Botón DESACTIVAR ubicación debe conservarse');
  });

  await t.test('4. Botón de prueba de notificación compactado', () => {
    assert.ok(code.includes('Probar notificación de ejemplo'), 'Texto de botón de prueba conservado');
    assert.match(code, /mBtnTest\.setPadding\(0,\s*dp\(10\),\s*0,\s*dp\(10\)\);/, 'Padding de botón de prueba compactado a 10dp');
  });

  await t.test('5. Información del servicio compactada con los tres mensajes esenciales', () => {
    assert.match(code, /infoTitle\.setGravity\(Gravity\.CENTER\);/, 'Título de información debe estar centrado');
    assert.match(code, /infoText\.setGravity\(Gravity\.CENTER\);/, 'Texto de información debe estar centrado');
    assert.ok(code.includes('Instituto de Geociencias de la Universidad de Panamá (IGC-UP)'), 'Mensaje 1: Fuente IGC-UP');
    assert.ok(code.includes('Avisos informativos comunitarios, no alerta temprana de terremotos'), 'Mensaje 2: Avisos informativos');
    assert.ok(code.includes('Las coordenadas se procesan en tu dispositivo y nunca se transmiten a servidores'), 'Mensaje 3: Coordenadas locales');
  });

  await t.test('6. Preservación absoluta de lógica FCM y GPS', () => {
    assert.ok(code.includes('FcmPreferences.isOptedIn'), 'Lógica de opt-in conservada');
    assert.ok(code.includes('FirebaseMessaging.getInstance()'), 'Lógica FCM conservada');
    assert.ok(code.includes('LocationManager.GPS_PROVIDER'), 'Lógica GPS conservada');
    assert.ok(code.includes('onGpsLocationClicked'), 'Callback de GPS intacto');
  });
});
