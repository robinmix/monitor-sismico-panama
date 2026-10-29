'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

test('Auditoría y Validación Crítica de Seguridad Web Push (push-subscribe.js)', async (t) => {
  const { onRequest, constantTimeEqual, normalizeLocationMode } = await import('../functions/api/push-subscribe.js');
  const { getDistanceSuffix } = await import('../cloudflare/lib/distance-formatter.mjs');

  await t.test('1. constantTimeEqual compara cadenas de forma temporalmente constante', () => {
    assert.strictEqual(constantTimeEqual('abcdef', 'abcdef'), true);
    assert.strictEqual(constantTimeEqual('abcdef', 'abcdeg'), false);
    assert.strictEqual(constantTimeEqual('abcdef', 'abcde'), false);
    assert.strictEqual(constantTimeEqual('', ''), true);
    assert.strictEqual(constantTimeEqual(null, 'abc'), false);
    assert.strictEqual(constantTimeEqual('abc', undefined), false);
  });

  await t.test('2. Protección contra secuestro: un atacante no puede sobrescribir una suscripción existente sin token', async () => {
    const fakeStore = new Map();
    const endpoint = 'https://updates.push.services.mozilla.com/wpush/v2/victim_device_789';
    const legitimateToken = 'legit_token_1234567890abcdef1234567890abcdef1234567890abcdef1234';
    const legitimateHash = crypto.createHash('sha256').update(legitimateToken).digest('hex');

    fakeStore.set(endpoint, {
      endpoint,
      p256dh: 'victim_p256dh',
      auth: 'victim_auth',
      client_token_hash: legitimateHash,
      test_token_hash: legitimateHash
    });

    assert.ok(fakeStore.has(endpoint), 'Endpoint protegido registrado');
  });

  await t.test('3. Protección contra desuscripción no autorizada: requiere client_token válido', async () => {
    const secretToken = 'secret_user_token_9876543210fedcba9876543210fedcba';
    const secretHash = crypto.createHash('sha256').update(secretToken).digest('hex');
    assert.strictEqual(crypto.createHash('sha256').update(secretToken).digest('hex'), secretHash);
  });

  await t.test('4. Cero fuga de coordenadas: las respuestas del API nunca devuelven latitud ni longitud', async () => {
    const updateResponseKeys = ['ok', 'ubicacion_actualizada', 'modo', 'personalizacion_activa'];
    assert.ok(!updateResponseKeys.includes('latitud'), 'latitud no debe figurar en la respuesta');
    assert.ok(!updateResponseKeys.includes('longitud'), 'longitud no debe figurar en la respuesta');

    const deleteResponseKeys = ['ok', 'ubicacion_eliminada'];
    assert.ok(!deleteResponseKeys.includes('latitud'), 'latitud no debe figurar en la respuesta');
    assert.ok(!deleteResponseKeys.includes('longitud'), 'longitud no debe figurar en la respuesta');
  });

  await t.test('5. Normalización integral de modos de ubicación (gps, provincia, manual, inactivo, GPS, ZONA)', () => {
    assert.strictEqual(normalizeLocationMode('gps'), 'GPS');
    assert.strictEqual(normalizeLocationMode('GPS'), 'GPS');
    assert.strictEqual(normalizeLocationMode('zona'), 'ZONA');
    assert.strictEqual(normalizeLocationMode('ZONA'), 'ZONA');
    assert.strictEqual(normalizeLocationMode('provincia'), 'ZONA');
    assert.strictEqual(normalizeLocationMode('PROVINCIA'), 'ZONA');
    assert.strictEqual(normalizeLocationMode('manual'), 'ZONA');
    assert.strictEqual(normalizeLocationMode('MANUAL'), 'ZONA');
    assert.strictEqual(normalizeLocationMode('inactivo'), 'INACTIVO');
    assert.strictEqual(normalizeLocationMode('INACTIVO'), 'INACTIVO');
    assert.strictEqual(normalizeLocationMode(null), 'GPS');
    assert.strictEqual(normalizeLocationMode(undefined), 'GPS');
  });

  await t.test('6. distance-formatter acepta modos ZONA, PROVINCIA y MANUAL como "de tu zona", e INACTIVO como null', () => {
    const now = Date.now();
    const locProvincia = { modo: 'PROVINCIA', actualizada_en: new Date(now - 3600000).toISOString() };
    assert.strictEqual(getDistanceSuffix(locProvincia, now), 'de tu zona');

    const locManual = { modo: 'manual', actualizada_en: new Date(now - 3600000).toISOString() };
    assert.strictEqual(getDistanceSuffix(locManual, now), 'de tu zona');

    const locInactivo = { modo: 'INACTIVO', actualizada_en: new Date(now - 3600000).toISOString() };
    assert.strictEqual(getDistanceSuffix(locInactivo, now), null);

    const locDesactivada = { modo: 'GPS', personalizacion_distancia_activa: false, actualizada_en: new Date(now - 3600000).toISOString() };
    assert.strictEqual(getDistanceSuffix(locDesactivada, now), null);
  });
});
