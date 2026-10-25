'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

test('Validación Estricta de Sintaxis JavaScript (node --check)', () => {
  const root = path.join(__dirname, '..');
  const criticalFiles = [
    'assets/app.js',
    'sw.js',
    'cloudflare/lib/web-push.mjs',
    'functions/api/push-subscribe.js',
    'functions/api/push-test.js',
    'functions/api/push-vapid-key.js',
    'functions/api/sismos.js',
    'functions/api/historico-sismos.js',
    'functions/api/detalle-sismo.js'
  ];

  for (const rel of criticalFiles) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue;
    try {
      execSync(`node --check "${full}"`, { encoding: 'utf8' });
      assert.ok(true, `${rel} tiene sintaxis válida`);
    } catch (err) {
      assert.fail(`Error de sintaxis detectado en ${rel}: ${err.message}`);
    }
  }
});
