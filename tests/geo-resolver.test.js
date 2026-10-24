const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLocation, enrichEvent, enrichEvents, haversineKm, calculateBearing } = require('../lib/geo-resolver.js');

test('1. Tonosí terrestre (Los Santos)', () => {
  // Evento real IGC: 2026-10-18 M3.6, lat 7.46078, lon -80.46030
  const res = resolveLocation(7.46078, -80.46030, 'Localizado en Panamá a 6km al norte de Tonosí');
  assert.equal(res.geo_tipo, 'TERRESTRE');
  assert.equal(res.geo_pais, 'Panamá');
  assert.equal(res.geo_provincia, 'Los Santos');
  assert.equal(res.geo_distrito, 'Tonosí');
  assert.equal(res.geo_zona_maritima, null);
  assert.ok(res.geo_poblado_ref, 'Debe incluir localidad de referencia');
  assert.ok(res.geo_distancia_km >= 0);
  assert.ok(res.geo_ubicacion_texto.includes('Los Santos'));
});

test('2. Epicentro en el Pacífico sur de Azuero (Marítimo)', () => {
  // Evento real IGC: lat 7.14810, lon -79.41452 (Océano Pacífico a más de 70 km de la costa)
  const res = resolveLocation(7.14810, -79.41452, 'Localizado en Sur de Panamá a 116km al este de Tonosí');
  assert.equal(res.geo_tipo, 'MARITIMO');
  assert.equal(res.geo_provincia, null, 'Un sismo marítimo jamás debe asignarse a una provincia terrestre');
  assert.equal(res.geo_distrito, null);
  assert.equal(res.geo_corregimiento, null);
  assert.ok(res.geo_zona_maritima.includes('Pacífico'));
  assert.ok(res.geo_distancia_km > 50, 'Distancia a la costa debe ser representativa');
  assert.ok(res.geo_poblado_ref, 'Debe indicar referencia costera');
  assert.ok(res.geo_ubicacion_texto.includes('Pacífico'));
});

test('3. Chiriquí Grande y Bocas del Toro (Desambiguación provincial)', () => {
  // Evento real IGC: lat 8.95100, lon -82.11800
  // Pese a llamarse "Chiriquí Grande", pertenece a la provincia de Bocas del Toro
  const res = resolveLocation(8.95100, -82.11800, 'Localizado en Panamá a 4km al este de Chiriquí Grande');
  assert.equal(res.geo_tipo, 'TERRESTRE');
  assert.equal(res.geo_provincia, 'Bocas del Toro', 'Debe clasificar en Bocas del Toro, NO en Chiriquí');
  assert.equal(res.geo_distrito, 'Chiriquí Grande');
  assert.ok(res.geo_ubicacion_texto.includes('Bocas del Toro'));
});

test('4. Isla Coiba (Insular vs Fosa marina al SE)', () => {
  // 4a. Sismo en el mar al SE de Coiba: lat 7.13094, lon -81.46410
  const resSea = resolveLocation(7.13094, -81.46410, 'Localizado en Panamá a 56km al sureste de Coiba');
  assert.equal(resSea.geo_tipo, 'MARITIMO');
  assert.equal(resSea.geo_provincia, null);
  assert.ok(resSea.geo_zona_maritima.includes('Pacífico') || resSea.geo_zona_maritima.includes('Coiba'));
  assert.equal(resSea.geo_poblado_ref, 'Isla Coiba');
  assert.ok(resSea.geo_distancia_km >= 40 && resSea.geo_distancia_km <= 65);

  // 4b. Sismo sobre la masa terrestre de Isla Coiba: lat 7.47, lon -81.75
  const resLand = resolveLocation(7.47, -81.75);
  assert.equal(resLand.geo_tipo, 'INSULAR');
  assert.equal(resLand.geo_provincia, 'Veraguas');
  assert.equal(resLand.geo_distrito, 'Montijo');
});

test('5. Santiago de Veraguas (Terrestre)', () => {
  // Evento real IGC: lat 8.10200, lon -80.97800
  const res = resolveLocation(8.10200, -80.97800, 'Localizado en Panamá a 3km al norte de Santiago');
  assert.equal(res.geo_tipo, 'TERRESTRE');
  assert.equal(res.geo_provincia, 'Veraguas');
  assert.equal(res.geo_distrito, 'Santiago');
  assert.ok(res.geo_distancia_km < 10);
});

test('6. Mar Caribe (Cinturón Deformado del Norte de Panamá)', () => {
  // Evento real IGC: lat 9.85000, lon -80.12000
  const res = resolveLocation(9.85000, -80.12000, 'Localizado en Mar Caribe a 62km al noroeste de Colón');
  assert.equal(res.geo_tipo, 'MARITIMO');
  assert.equal(res.geo_provincia, null);
  assert.ok(res.geo_zona_maritima.includes('Caribe'));
  assert.ok(res.geo_distancia_km >= 50);
});

test('7. Zona fronteriza con Costa Rica', () => {
  // Coordenada en territorio costarricense próxima a la frontera: lat 8.65000, lon -83.15000
  const res = resolveLocation(8.65000, -83.15000, 'Localizado en Región Fronteriza Panamá-Costa Rica');
  assert.equal(res.geo_tipo, 'FRONTERIZO');
  assert.equal(res.geo_pais, 'Costa Rica');
  assert.ok(res.geo_provincia.includes('Costa Rica') || res.geo_provincia.includes('Puntarenas'));
  assert.ok(res.geo_ubicacion_texto.includes('Fronteriza'));
});

test('8. Zona fronteriza con Colombia', () => {
  // Coordenada en territorio colombiano (Chocó): lat 7.20000, lon -77.20000
  const res = resolveLocation(7.20000, -77.20000, 'Localizado en Región Fronteriza Panamá-Colombia');
  assert.equal(res.geo_tipo, 'FRONTERIZO');
  assert.equal(res.geo_pais, 'Colombia');
  assert.ok(res.geo_provincia.includes('Colombia') || res.geo_provincia.includes('Chocó'));
});

test('9. Punto costero (distinción rigurosa tierra vs mar)', () => {
  // Punto en pueblo de Cambutal (Tierra): lat 7.2850, lon -80.4850
  const resLand = resolveLocation(7.2850, -80.4850);
  assert.equal(resLand.geo_tipo, 'TERRESTRE');
  assert.equal(resLand.geo_provincia, 'Los Santos');
  assert.equal(resLand.geo_corregimiento, 'Cambutal');

  // Punto a 7 km mar adentro al sur de Cambutal: lat 7.2200, lon -80.4850
  const resSea = resolveLocation(7.2200, -80.4850);
  assert.equal(resSea.geo_tipo, 'MARITIMO');
  assert.equal(resSea.geo_provincia, null);
});

test('10. Isla pequeña (Taboga)', () => {
  // Centro de Isla Taboga: lat 8.7940, lon -79.5550
  const res = resolveLocation(8.7940, -79.5550);
  assert.equal(res.geo_tipo, 'INSULAR');
  assert.equal(res.geo_provincia, 'Panamá');
  assert.equal(res.geo_distrito, 'Taboga');
  assert.equal(res.geo_poblado_ref, 'Isla Taboga');
});

test('11. Coordenadas inválidas o ausentes', () => {
  const rNull = resolveLocation(null, null);
  assert.equal(rNull.geo_tipo, 'NO_DETERMINADO');
  assert.equal(rNull.geo_calidad, 'NO_DETERMINADA');

  const rNaN = resolveLocation('abc', 'def');
  assert.equal(rNaN.geo_tipo, 'NO_DETERMINADO');

  const rOutOfRange = resolveLocation(95.0, -80.0);
  assert.equal(rOutOfRange.geo_tipo, 'NO_DETERMINADO');
});

test('12. Punto fuera de la zona de monitoreo', () => {
  // Golfo de México / Cobertura ajena
  const res = resolveLocation(25.0, -100.0);
  assert.equal(res.geo_tipo, 'FUERA_DE_COBERTURA');
  assert.equal(res.geo_provincia, null);
  assert.equal(res.geo_poblado_ref, null);
});

test('13. Punto exactamente sobre frontera administrativa', () => {
  // Límite entre Herrera y Los Santos: lat 7.7500, lon -80.5000
  const res = resolveLocation(7.7500, -80.5000);
  assert.equal(res.geo_tipo, 'TERRESTRE');
  assert.ok(['Herrera', 'Los Santos'].includes(res.geo_provincia));
  assert.ok(res.geo_calidad);
});

test('14. Evento histórico reclasificado (antiguo "Panamá" a provincia real)', () => {
  // Sismo histórico en Azuero registrado por IGC como "Localizado en Panamá a 31km al noroeste de Tonosí"
  const rawEvent = {
    source_uid: 'igc_test_hist_1',
    fecha_hora: '2026-10-18T10:26:05.000Z',
    latitud: 7.63275,
    longitud: -80.61007,
    magnitud: 3.7,
    profundidad_km: 10,
    region: 'Panamá',
    ubicacion: 'Localizado en Panamá a 31km al noroeste de Tonosí'
  };

  const enriched = enrichEvent(rawEvent);

  // Inmutabilidad estricta: los campos originales IGC no deben haber cambiado
  assert.equal(enriched.latitud, rawEvent.latitud);
  assert.equal(enriched.longitud, rawEvent.longitud);
  assert.equal(enriched.magnitud, rawEvent.magnitud);
  assert.equal(enriched.profundidad_km, rawEvent.profundidad_km);
  assert.equal(enriched.region, 'Panamá', 'region original debe permanecer intacta');
  assert.equal(enriched.ubicacion, rawEvent.ubicacion);

  // Los campos geo_* revelan la ubicación real calculada
  assert.equal(enriched.geo_tipo, 'TERRESTRE');
  assert.equal(enriched.geo_provincia, 'Los Santos');
  assert.ok(enriched.geo_distrito);
  assert.ok(enriched.geo_poblado_ref);
  assert.ok(enriched.geo_ubicacion_texto.includes('Los Santos'));
});

test('15. Rendimiento: Enriquecimiento de lote grande (1,000 eventos)', () => {
  const events = [];
  for (let i = 0; i < 1000; i++) {
    events.push({
      id: `ev_${i}`,
      latitud: 7.0 + (i % 30) * 0.1,
      longitud: -82.0 + (i % 40) * 0.1,
      magnitud: 3.5,
      profundidad: 15,
      region: 'Panamá'
    });
  }

  const t0 = performance.now();
  const enrichedList = enrichEvents(events);
  const durationMs = performance.now() - t0;

  assert.equal(enrichedList.length, 1000);
  // Verificar que 1,000 eventos se resuelven en menos de 1,500 ms (< 1.5 ms por evento)
  assert.ok(durationMs < 1500, `El lote tardó ${durationMs.toFixed(1)} ms, superando el límite`);
  assert.ok(enrichedList[0].geo_tipo);
});
