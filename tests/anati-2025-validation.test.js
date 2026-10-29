/**
 * @fileoverview Batería de Pruebas de Validación ANATI DPA 2025
 * Verifica la integración vectorial completa de la División Político-Administrativa 2025
 * del Instituto Geográfico Nacional Tommy Guardia (IGNTG / ANATI).
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { resolveLocation, enrichEvent } = require('../lib/geo-resolver.js');
const { provincias } = require('../lib/geo-data/panama-provincias.js');
const { distritos } = require('../lib/geo-data/panama-distritos.js');
const { corregimientos } = require('../lib/geo-data/panama-corregimientos.js');
const { lugares } = require('../lib/geo-data/panama-lugares-poblados.js');
const mascara = require('../lib/geo-data/panama-mascara.js');
const { zonas: maritimo } = require('../lib/geo-data/panama-maritimo.js');

test('ANATI 2025: 1. Conteos oficiales y estructura cartográfica', () => {
  assert.equal(provincias.length, 13, 'Debe haber exactamente 13 provincias y comarcas mayores');
  assert.equal(distritos.length, 83, 'Debe haber exactamente 83 distritos oficiales');
  assert.equal(corregimientos.length, 699, 'Debe haber exactamente 699 corregimientos de tierra firme');

  // Máscara y marítimo preservados de la línea base estable
  assert.equal(mascara.poligonos.length, 481, 'panama-mascara.js debe conservar 481 polígonos');
  assert.equal(maritimo.length, 11, 'panama-maritimo.js debe conservar 11 zonas marítimas');
  assert.equal(lugares.length, 576, 'panama-lugares-poblados.js debe conservar exactamente 576 localidades');
});

test('ANATI 2025: 2. Preservación de códigos con ceros a la izquierda (strings)', () => {
  // Provincias
  assert.ok(provincias.every(p => typeof p.id === 'string' && p.id.length === 2));
  assert.equal(provincias.find(p => p.nombre === 'Bocas del Toro').id, '01');
  assert.equal(provincias.find(p => p.nombre === 'Los Santos').id, '07');
  assert.equal(provincias.find(p => p.nombre === 'Panamá Oeste').id, '13');

  // Distritos
  assert.ok(distritos.every(d => typeof d.id === 'string' && d.id.length === 4));
  assert.equal(distritos.find(d => d.nombre === 'Pedasí').id, '0705');
  assert.equal(distritos.find(d => d.nombre === 'Tierras Altas').id, '0414');
  assert.equal(distritos.find(d => d.nombre === 'Almirante').id, '0104', 'Almirante debe ser 0104 oficialmente');
  assert.equal(distritos.find(d => d.nombre === 'Changuinola').id, '0102', 'Changuinola debe ser 0102');

  // Corregimientos
  assert.ok(corregimientos.every(c => typeof c.id === 'string' && c.id.length === 6));
  assert.equal(corregimientos.find(c => c.nombre === 'Pedasí' && c.distrito_id === '0705').id, '070501');
  assert.equal(corregimientos.find(c => c.nombre === 'Los Asientos' && c.distrito_id === '0705').id, '070502');
  assert.equal(corregimientos.find(c => c.nombre === 'Almirante' && c.distrito_id === '0104').id, '010401');
});

test('ANATI 2025: 3. Cobertura de las 10 provincias y 3 comarcas mayores', () => {
  const testCoords = [
    { nombre: 'Bocas del Toro (Isla Colón)', lat: 9.340, lon: -82.242, prov: 'Bocas del Toro' },
    { nombre: 'Coclé (Penonomé)', lat: 8.518, lon: -80.355, prov: 'Coclé' },
    { nombre: 'Colón (Colón Centro)', lat: 9.355, lon: -79.900, prov: 'Colón' },
    { nombre: 'Chiriquí (David)', lat: 8.427, lon: -82.431, prov: 'Chiriquí' },
    { nombre: 'Darién (La Palma)', lat: 8.409, lon: -78.140, prov: 'Darién' },
    { nombre: 'Herrera (Chitré)', lat: 7.962, lon: -80.428, prov: 'Herrera' },
    { nombre: 'Los Santos (Las Tablas)', lat: 7.767, lon: -80.283, prov: 'Los Santos' },
    { nombre: 'Panamá (San Felipe)', lat: 8.953, lon: -79.534, prov: 'Panamá' },
    { nombre: 'Veraguas (Santiago)', lat: 8.100, lon: -80.970, prov: 'Veraguas' },
    { nombre: 'Panamá Oeste (La Chorrera)', lat: 8.880, lon: -79.783, prov: 'Panamá Oeste' },
    { nombre: 'Comarca Guna Yala (Narganá)', lat: 9.444, lon: -78.586, prov: 'Comarca Kuna Yala' },
    { nombre: 'Comarca Emberá-Wounaán (Unión Chocó)', lat: 8.083, lon: -77.583, prov: 'Comarca Emberá-Wounaán' },
    { nombre: 'Comarca Ngäbe-Buglé (Chichica)', lat: 8.350, lon: -81.650, prov: 'Comarca Ngäbe-Buglé' }
  ];

  for (const tc of testCoords) {
    const res = resolveLocation(tc.lat, tc.lon);
    assert.ok(['TERRESTRE', 'INSULAR'].includes(res.geo_tipo), `Fallo de tipo en ${tc.nombre}`);
    assert.ok(res.geo_provincia.includes(tc.prov) || tc.prov.includes(res.geo_provincia),
      `Provincia esperada ${tc.prov}, recibida ${res.geo_provincia} en ${tc.nombre}`);
  }
});

test('ANATI 2025: 4. Nuevos distritos creados o segregados (2014-2024)', () => {
  // 1. Tierras Altas (Chiriquí, Ley 55 de 2013 / vigencia 2017)
  const vol = resolveLocation(8.773, -82.639);
  assert.equal(vol.geo_distrito, 'Tierras Altas');
  assert.equal(vol.geo_provincia, 'Chiriquí');

  // 2. Omar Torrijos Herrera (Colón, Ley 11 de 2018)
  const oth = resolveLocation(8.783, -80.600);
  assert.equal(oth.geo_distrito, 'Omar Torrijos Herrera');
  assert.equal(oth.geo_provincia, 'Colón');

  // 3. Almirante (Bocas del Toro, Ley 39 de 2015, cod 0104)
  const alm = resolveLocation(9.300, -82.400);
  assert.equal(alm.geo_distrito, 'Almirante');
  assert.equal(alm.geo_provincia, 'Bocas del Toro');

  // 4. Comarca Naso Tjër Di (Ley 188 de 2020)
  const naso = resolveLocation(9.356, -82.684);
  assert.equal(naso.geo_distrito, 'Comarca Naso Tjër Di');
  assert.equal(naso.geo_comarca, 'Comarca Naso Tjër Di');
  assert.equal(naso.geo_provincia, 'Bocas del Toro');
});

test('ANATI 2025: 5. Caso de Estudio Los Asientos (7.4875° N, -80.1132° W)', () => {
  // Evento real del 28 de octubre de 2026: 7.4875, -80.1132
  const res = resolveLocation(7.4875, -80.1132);

  assert.equal(res.geo_tipo, 'TERRESTRE');
  assert.equal(res.geo_provincia, 'Los Santos');
  assert.equal(res.geo_distrito, 'Pedasí');
  assert.equal(res.geo_corregimiento, 'Pedasí');
  assert.equal(res.geo_poblado_ref, 'Los Asientos');
  assert.ok(res.geo_distancia_km >= 2.0 && res.geo_distancia_km <= 2.2, `Distancia esperada ~2.1 km, obtenida ${res.geo_distancia_km}`);
  assert.equal(res.geo_rumbo, 'al SE');

  // Verificación sintáctica: elimina la tautología
  assert.ok(!res.geo_ubicacion_texto.includes('de Pedasí)'), 'No debe repetir Pedasí como referencia redundante');
  assert.ok(res.geo_ubicacion_texto.includes('de Los Asientos'), 'Debe referenciar el poblado más cercano (Los Asientos)');
  assert.equal(res.geo_ubicacion_texto, 'Pedasí, Pedasí (Los Santos) · a 2.1 km al SE de Los Asientos');
});

test('ANATI 2025: 6. Exclusión estricta de masas de agua como corregimientos', () => {
  // Los 31 polígonos de agua interior (Bahía de San Miguel, Lagos Gatún, Alajuela, Bayano)
  // deben haber sido excluidos del catálogo de corregimientos administrativos
  const waterNames = [
    'Bahía de San Miguel', 'Lago Gatún', 'Lago Alajuela', 'Lago Bayano',
    'Bahía de Parita', 'Golfo de Montijo', 'Laguna de Chiriquí'
  ];

  for (const wn of waterNames) {
    const found = corregimientos.find(c => c.nombre.toLowerCase().includes(wn.toLowerCase()));
    assert.equal(found, undefined, `Masa de agua ${wn} no debe existir como corregimiento de tierra`);
  }
});

test('ANATI 2025: 7. Topología OGC de agujeros interiores (Holes), enclaves y límites compartidos', () => {
  // Helper Point-in-polygon
  function pip(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function inEntityWithHoles(x, y, polygons) {
    for (const poly of polygons) {
      const outer = poly[0];
      if (pip(x, y, outer)) {
        let inHole = false;
        for (let h = 1; h < poly.length; h++) {
          if (pip(x, y, poly[h])) { inHole = true; break; }
        }
        if (!inHole) return true;
      }
    }
    return false;
  }

  // 1. Enclave San Miguelito vs Distrito de Panamá:
  // Punto en San Miguelito: lat 9.0435, lon -79.4975
  const distPanama = distritos.find(d => d.id === '0808');
  const distSM = distritos.find(d => d.id === '0810');
  
  assert.equal(inEntityWithHoles(-79.4975, 9.0435, distPanama.coordinates), false, 'Punto en San Miguelito debe dar FALSE en Distrito Panamá por sustracción de agujero');
  assert.equal(inEntityWithHoles(-79.4975, 9.0435, distSM.coordinates), true, 'Punto en San Miguelito debe dar TRUE en Distrito San Miguelito');

  // 2. Agujero de agua interior (Laguna de La Yeguada en Corregimiento La Yeguada):
  // Punto en el centro del lago: lat 8.4562, lon -80.8560
  const corrYeguada = corregimientos.find(c => c.nombre.includes('Yeguada'));
  assert.equal(corrYeguada.coordinates[0].length, 2, 'Corregimiento La Yeguada debe tener exactamente 2 anillos (1 exterior, 1 agujero)');
  assert.equal(pip(-80.8560, 8.4562, corrYeguada.coordinates[0][0]), true, 'Punto centro del lago está dentro del exterior');
  assert.equal(pip(-80.8560, 8.4562, corrYeguada.coordinates[0][1]), true, 'Punto centro del lago está dentro del agujero');
  assert.equal(inEntityWithHoles(-80.8560, 8.4562, corrYeguada.coordinates), false, 'Punto dentro del lago no debe pertenecer a tierra de La Yeguada');

  // 3. Punto en tierra firme de La Yeguada (fuera del lago): lat 8.4500, lon -80.8400
  assert.equal(inEntityWithHoles(-80.8400, 8.4500, corrYeguada.coordinates), true, 'Punto en tierra debe ser TRUE');

  // 4. Punto en mar abierto (fuera de toda geometría): lat 7.000, lon -80.000
  const resMar = resolveLocation(7.000, -80.000);
  assert.equal(resMar.geo_tipo, 'MARITIMO');
});

test('ANATI 2025: 8. Paridad estricta ESM vs CJS para todos los casos DPA 2025', async () => {
  const esm = await import('../cloudflare/lib/geo-resolver.mjs');

  const checkPoints = [
    [7.4875, -80.1132, 'Caso Los Asientos'],
    [8.773, -82.639, 'Tierras Altas'],
    [8.783, -80.600, 'Omar Torrijos'],
    [9.356, -82.684, 'Naso Tjër Di'],
    [9.300, -82.400, 'Almirante'],
    [8.953, -79.534, 'San Felipe'],
    [8.427, -82.431, 'David'],
    [7.83901, -78.14188, 'Sambú Emberá'],
    [8.5322, -82.8350, 'Paso Canoas']
  ];

  for (const [lat, lon, desc] of checkPoints) {
    const cjs = resolveLocation(lat, lon, desc);
    const mjs = esm.resolveLocation(lat, lon, desc);
    assert.deepEqual(mjs, cjs, `Divergencia ESM/CJS en ${desc}`);
  }
});
