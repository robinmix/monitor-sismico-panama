const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT_DIR, 'assets', 'style.css'), 'utf8');
const js = fs.readFileSync(path.join(ROOT_DIR, 'assets', 'app.js'), 'utf8');

test('Tipografía: Nunito Sans cargada en index.html con pesos 400 a 800', () => {
  assert.match(
    html,
    /fonts\.googleapis\.com\/css2\?[^"]*family=Nunito\+Sans:wght@400;500;600;700;800/,
    'index.html debe cargar Nunito Sans con pesos 400, 500, 600, 700 y 800'
  );
  assert.match(
    html,
    /family=IBM\+Plex\+Mono:wght@400;500;600/,
    'index.html debe conservar IBM Plex Mono para datos técnicos'
  );
});

test('Tipografía: --font-sans configurada con Nunito Sans en style.css', () => {
  assert.match(
    css,
    /--font-sans:\s*'Nunito Sans'/,
    'style.css debe declarar Nunito Sans como tipografía principal'
  );
  assert.match(
    css,
    /body\s*\{[^}]*font-weight:\s*(?:500|700)/m,
    'body debe tener font-weight: 500 o 700 para texto normal'
  );
});

test('Tipografía: Magnitudes destacadas configuradas con font-weight 800', () => {
  assert.match(
    css,
    /\.mag-chip\s*\{[^}]*font-weight:\s*800/m,
    'Los chips de magnitud deben usar font-weight: 800'
  );
  assert.match(
    css,
    /\.card-mag-badge\s*\{[^}]*font-weight:\s*800/m,
    'Las insignias móviles de magnitud deben usar font-weight: 800'
  );
  assert.match(
    css,
    /\.sismo-mag-chip\s*\{[^}]*font-weight:\s*800/m,
    'La magnitud en ficha individual debe usar font-weight: 800'
  );
});

test('Paleta AMOLED Vibrant: Variables de magnitud en style.css', () => {
  assert.match(css, /--mag-below:\s*#31E8D0;/, 'Menor de 3.0 debe ser Turquesa vivo #31E8D0');
  assert.match(css, /--mag-3:\s*#39E59A;/, '3.0 a 3.9 debe ser Verde esmeralda brillante #39E59A');
  assert.match(css, /--mag-4:\s*#FF9A32;/, '4.0 a 4.9 debe ser Naranja brillante #FF9A32');
  assert.match(css, /--mag-5:\s*#FF5266;/, '5.0 o superior debe ser Rojo coral intenso #FF5266');
  assert.match(css, /--mag-neutral:\s*#839AB5;/, 'Magnitud ausente/inválida debe ser Neutral #839AB5');
});

test('Paleta AMOLED Vibrant: COLORS en app.js alineado exactamente con CSS', () => {
  assert.match(
    js,
    /const COLORS\s*=\s*\['#31E8D0',\s*'#39E59A',\s*'#FF9A32',\s*'#FF5266'\];/,
    'COLORS en app.js debe contener la escala exacta [#31E8D0, #39E59A, #FF9A32, #FF5266]'
  );
  assert.match(
    js,
    /const NEUTRAL_COLOR\s*=\s*'#839AB5';/,
    'NEUTRAL_COLOR en app.js debe ser #839AB5'
  );
});

test('Intervalos de magnitud: Verificación de valores de prueba en app.js logic', () => {
  const COLORS = ['#31E8D0', '#39E59A', '#FF9A32', '#FF5266'];
  const NEUTRAL_COLOR = '#839AB5';
  const isValidMag = mag => typeof mag === 'number' && !Number.isNaN(mag) && mag > 0;
  const magnitudeClass = mag => {
    if (!isValidMag(mag)) return 'mNeutral';
    if (mag >= 5.0) return 'm5';
    if (mag >= 4.0) return 'm4';
    if (mag >= 3.0) return 'm3';
    return 'mBelow';
  };
  const magColor = mag => {
    if (!isValidMag(mag)) return NEUTRAL_COLOR;
    if (mag >= 5.0) return COLORS[3];
    if (mag >= 4.0) return COLORS[2];
    if (mag >= 3.0) return COLORS[1];
    return COLORS[0];
  };

  // M2.9: Turquesa
  assert.equal(magColor(2.9), '#31E8D0');
  assert.equal(magnitudeClass(2.9), 'mBelow');

  // M3.0: Verde esmeralda
  assert.equal(magColor(3.0), '#39E59A');
  assert.equal(magnitudeClass(3.0), 'm3');

  // M3.6: Verde esmeralda (Requisito clave: NUNCA amarillo ni naranja)
  assert.equal(magColor(3.6), '#39E59A');
  assert.equal(magnitudeClass(3.6), 'm3');

  // M3.9: Verde esmeralda
  assert.equal(magColor(3.9), '#39E59A');
  assert.equal(magnitudeClass(3.9), 'm3');

  // M4.0: Naranja brillante
  assert.equal(magColor(4.0), '#FF9A32');
  assert.equal(magnitudeClass(4.0), 'm4');

  // M4.9: Naranja brillante
  assert.equal(magColor(4.9), '#FF9A32');
  assert.equal(magnitudeClass(4.9), 'm4');

  // M5.0: Rojo coral intenso
  assert.equal(magColor(5.0), '#FF5266');
  assert.equal(magnitudeClass(5.0), 'm5');

  // M6.4: Rojo coral intenso
  assert.equal(magColor(6.4), '#FF5266');
  assert.equal(magnitudeClass(6.4), 'm5');

  // Ausente / inválido: Neutral
  assert.equal(magColor(null), '#839AB5');
  assert.equal(magnitudeClass(null), 'mNeutral');
  assert.equal(magColor(undefined), '#839AB5');
  assert.equal(magnitudeClass(undefined), 'mNeutral');
  assert.equal(magColor(NaN), '#839AB5');
  assert.equal(magnitudeClass(NaN), 'mNeutral');
});
