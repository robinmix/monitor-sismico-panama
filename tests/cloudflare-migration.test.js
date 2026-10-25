const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const get = name => fs.readFileSync(path.join(root, name), 'utf8');

test('Frontend usa exclusivamente rutas de API intercambiables', () => {
  const app = get('assets/app.js');
  for (const route of ['/api/sismos', '/api/historico-sismos', '/api/detalle-sismo']) assert.ok(app.includes(route));
  assert.ok(!app.includes("'/.netlify/functions/sismos'"));
});

test('Service worker omite cache para API dinamica de Cloudflare', () => {
  assert.ok(get('sw.js').includes("url.pathname.includes('/api/')"));
});

test('Netlify mantiene endpoints de compatibilidad sin cron duplicado', () => {
  const config = get('netlify.toml');
  assert.ok(!config.includes('schedule = "*/30 * * * *"')); 
  for (const name of ['sismos', 'historico-sismos', 'detalle-sismo']) {
    assert.ok(config.includes(`from = "/api/${name}"`));
    assert.ok(fs.existsSync(path.join(root, 'functions', 'api', `${name}.js`)));
  }
});

test('Secrets Supabase solo en servidor, Pages se conecta desde env', () => {
  for (const name of ['historico-sismos','detalle-sismo','archivar-sismos']) {
    const mod = get(`cloudflare/lib/${name}.mjs`);
    assert.ok(mod.includes('env.SUPABASE_SECRET_KEY'));
    assert.ok(!mod.includes('process.env.SUPABASE_SECRET_KEY'));
  }
});

test('Seguridad de proxy en Pages: solo lectura, sin reenvío de secretos y falla en producción', () => {
  for (const name of ['historico-sismos', 'detalle-sismo']) {
    const fn = get(`functions/api/${name}.js`);
    // 1. Métodos autorizados únicamente GET y OPTIONS
    assert.ok(fn.includes("['GET', 'OPTIONS'].includes(context.request.method)"));
    assert.ok(fn.includes('status: 405'));
    // 2. En producción o identidad desconocida debe fallar de manera detectable si no hay credenciales (no proxy silencioso)
    assert.ok(fn.includes("branchName !== 'main'"));
    assert.ok(fn.includes("!isExplicitPreview"));
    // 3. Endpoint oficial hardcoded sin permitir URLs arbitrarias
    assert.ok(fn.includes('https://sismospma.netlify.app/api/'));
    // 4. No divulga ni reenvía secretos
    assert.ok(!fn.includes('SUPABASE_SECRET_KEY"'));
    assert.ok(!fn.includes('authorization'));
  }
});

test('Configuración de Wrangler para sismopa-archivador: cron de 1 min, vars públicas y cero secretos expuestos', () => {
  const toml = get('cloudflare/archivador/wrangler.toml');

  // Identidad y runtime
  assert.ok(toml.includes('name = "sismopa-archivador"'));
  assert.ok(toml.includes('main = "worker.mjs"'));
  assert.ok(toml.includes('compatibility_date = "2026-10-01"'));
  assert.ok(toml.includes('crons = ["* * * * *"]'));

  // Variables públicas sincronizadas
  assert.ok(toml.includes('VAPID_PUBLIC_KEY = "BMMtfOw_OoVIt6bjp70GMXMn-oMACjTCn870_Gn4QCQbhiM43kHuP2oto_Uu6d7Az2TOkDvp7V1RJBd-oQfSijM"'));
  assert.ok(toml.includes('VAPID_SUBJECT = "mailto:rbtservices507@gmail.com"'));

  // Seguridad: AUTO_PUSH_ENABLED desactivado por defecto
  assert.ok(toml.includes('AUTO_PUSH_ENABLED = "false"'));

  // Cero secretos reales definidos en [vars]
  assert.ok(!toml.match(/^SUPABASE_SECRET_KEY\s*=/m), 'SUPABASE_SECRET_KEY no debe estar en [vars]');
  assert.ok(!toml.match(/^SUPABASE_URL\s*=/m), 'SUPABASE_URL no debe estar en [vars]');
  assert.ok(!toml.match(/^VAPID_PRIVATE_KEY_JWK\s*=/m), 'VAPID_PRIVATE_KEY_JWK no debe estar en [vars]');
});
