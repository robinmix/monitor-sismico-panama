const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS_PATH = path.join(process.cwd(), 'assets', 'style.css');
const css = fs.readFileSync(CSS_PATH, 'utf8');

test('Responsive Hero Card: Regla intermedia <= 860px existe para tablets y Galaxy con zoom', () => {
  assert.ok(css.includes('@media (max-width: 860px)'), 'Debe incluir @media (max-width: 860px) para evitar colapso de 3 columnas');
  assert.ok(css.includes('/* ADAPTACIÓN INTERMEDIA PARA TABLETS'), 'Debe incluir comentario explicativo de la adaptación');
});

test('Responsive Hero Card: .last-event cambia a flex-direction column en <= 860px', () => {
  const m860Match = css.match(/@media \(max-width: 860px\) \{([\s\S]*?)(?=@media|\n\})/);
  assert.ok(m860Match, 'Bloque de media query 860px debe existir');
  const block = m860Match[1];
  assert.ok(block.includes('display: flex !important;'), 'Debe usar flex layout');
  assert.ok(block.includes('flex-direction: column !important;'), 'Debe apilar en columna para evitar desbordamiento horizontal');
  assert.ok(block.includes('box-sizing: border-box !important;'), 'Debe forzar box-sizing border-box');
});

test('Responsive Hero Card: .hero-actions-grid usa repeat(auto-fit) anti-desbordamiento', () => {
  assert.ok(css.includes('grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)) !important;') ||
            css.includes('grid-template-columns: repeat(auto-fit, minmax(min(100%, 155px), 1fr)) !important;'),
    'Las columnas de botones deben usar auto-fit con minmax protector');
});

test('Responsive Hero Card: .geo-dist-btn permite envoltura multilínea (white-space: normal)', () => {
  assert.ok(css.includes('white-space: normal !important;'), 'El botón de distancia debe permitir white-space normal en móvil');
  assert.ok(css.includes('line-height: 1.25 !important;'), 'El botón de distancia debe definir altura de línea legible');
});

test('Responsive Hero Card: .timer-box incluye flex-wrap para evitar colisión de contador', () => {
  assert.ok(css.includes('flex-wrap: wrap !important;'), 'El contenedor del cronómetro debe permitir envoltura');
});

test('Responsive Hero Card: Protección para viewports ultra estrechos (<= 350px)', () => {
  assert.ok(css.includes('@media (max-width: 350px)'), 'Debe incluir media query para pantallas muy estrechas');
  assert.ok(css.includes('width: 66px !important;'), 'El dial debe compactarse a 66px en pantallas <= 350px');
});

test('Responsive Hero Card: Diseño de escritorio original intacto para pantallas > 860px', () => {
  assert.ok(css.includes('grid-template-columns: 210px 1fr 340px;'), 'El layout de 3 columnas de escritorio debe preservarse íntegro');
  assert.ok(css.includes('width: 154px;'), 'El dial circular de 154px de escritorio debe preservarse');
});
