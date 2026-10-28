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

test('16. Sismo Coiba 28-Oct-2026 15:58:03 UTC (Marítimo adyacente a costa NO de Coiba)', () => {
  // Evento obligatorio: Lat 7.61967, Lon -81.81950, M3.5
  const res = resolveLocation(7.61967, -81.81950, 'Localizado en Panamá a 11km al noroeste de Coiba');
  assert.equal(res.geo_tipo, 'MARITIMO');
  assert.equal(res.geo_provincia, null, 'No debe asignar provincia terrestre a aguas marinas');
  assert.equal(res.geo_distrito, null, 'No debe asignar distrito terrestre a aguas marinas');
  assert.equal(res.geo_corregimiento, null, 'No debe inventar corregimiento terrestre para el océano');
  assert.ok(res.geo_zona_maritima.includes('Coiba') || res.geo_zona_maritima.includes('Pacífico'));
  assert.equal(res.geo_poblado_ref, 'Isla Coiba');
  assert.ok(res.geo_distancia_km >= 2.0 && res.geo_distancia_km <= 3.5, `Distancia a costa de Coiba debe ser ~2.8 km (obtenido: ${res.geo_distancia_km})`);
  assert.equal(res.geo_rumbo, 'al NO');
  assert.equal(res.geo_provincia_ref, 'Veraguas');
  assert.equal(res.geo_distrito_ref, 'Montijo');
  assert.ok(!res.geo_ubicacion_texto.includes('al norte de Montijo'), 'Jamas debe decir al norte de Montijo');
  assert.ok(res.geo_ubicacion_texto.includes('Isla Coiba'));
});

test('17. Montijo Cabecera en tierra firme de Veraguas', () => {
  // Coordenada oficial ANATI Cab_Distrito 090601: lat 7.99171, lon -81.05507
  const res = resolveLocation(7.99171, -81.05507);
  assert.equal(res.geo_tipo, 'TERRESTRE');
  assert.equal(res.geo_provincia, 'Veraguas');
  assert.equal(res.geo_distrito, 'Montijo');
  assert.equal(res.geo_corregimiento, 'Montijo');
  assert.equal(res.geo_distancia_km, 0);

  // La distancia entre Montijo cabecera y el centro de Coiba (7.47, -81.75) debe ser > 90 km
  const distCoiba = haversineKm(7.99171, -81.05507, 7.47, -81.75);
  assert.ok(distCoiba > 90, `Montijo debe estar en tierra firme a más de 90 km de Coiba (obtenido: ${distCoiba.toFixed(1)} km)`);
});

test('18. Isla Gobernadora en su posición insular real', () => {
  // Coordenada oficial ANATI Cab_Corregimiento La Punta: lat 7.55933, lon -81.18551
  const res = resolveLocation(7.55933, -81.18551);
  assert.equal(res.geo_tipo, 'INSULAR');
  assert.equal(res.geo_provincia, 'Veraguas');
  assert.equal(res.geo_distrito, 'Montijo');
  assert.equal(res.geo_corregimiento, 'Gobernadora');
  assert.equal(res.geo_poblado_ref, 'Isla Gobernadora');

  // Distancia entre Gobernadora y Coiba debe ser > 60 km
  const distCoiba = haversineKm(7.55933, -81.18551, 7.47, -81.75);
  assert.ok(distCoiba > 60, `Gobernadora debe estar en el Golfo de Montijo a más de 60 km de Coiba (obtenido: ${distCoiba.toFixed(1)} km)`);
});

test('19. San Miguelito: Jerarquía completa sin oclusión por Distrito de Panamá', () => {
  // Cabecera de San Miguelito: lat 9.0552, lon -79.48856
  const res = resolveLocation(9.0552, -79.48856);
  assert.equal(res.geo_tipo, 'TERRESTRE');
  assert.equal(res.geo_provincia, 'Panamá');
  assert.equal(res.geo_distrito, 'San Miguelito', 'Debe resolver Distrito San Miguelito, no Distrito de Panamá');
  assert.ok(res.geo_corregimiento, 'Debe resolver corregimiento de San Miguelito (Belisario Porras)');
  assert.ok(['Belisario Porras', 'Arnulfo Arias'].includes(res.geo_corregimiento), 'Debe resolver corregimiento de San Miguelito');
  assert.ok(res.geo_ubicacion_texto.includes('San Miguelito'));
});

test('20. Sambú (Comarca Emberá-Wounaan) sin oclusión por Chepigana / Darién', () => {
  // Cabecera distrital de Sambú: lat 7.83901, lon -78.14188
  const res = resolveLocation(7.83901, -78.14188);
  assert.equal(res.geo_tipo, 'TERRESTRE');
  assert.ok(res.geo_provincia.includes('Emberá'));
  assert.ok(res.geo_comarca.includes('Emberá'));
  assert.equal(res.geo_distrito, 'Sambú', 'Debe resolver Sambú, no Chepigana');
  assert.ok(res.geo_corregimiento, 'Debe resolver corregimiento de Sambú');
  assert.ok(res.geo_ubicacion_texto.includes('Sambú') || res.geo_ubicacion_texto.includes('Emberá'));
});

test('21. Paso Canoas: Distinción lado Panamá vs lado Costa Rica', () => {
  // Lado panameño (aduana/corregimiento Progreso, Barú): lat 8.5322, lon -82.8400
  const resPA = resolveLocation(8.5322, -82.8350);
  assert.equal(resPA.geo_tipo, 'TERRESTRE');
  assert.equal(resPA.geo_pais, 'Panamá');
  assert.equal(resPA.geo_provincia, 'Chiriquí');
  assert.equal(resPA.geo_distrito, 'Barú');
  assert.ok(resPA.geo_corregimiento);

  // Lado costarricense: lat 8.5322, lon -82.8450
  const resCR = resolveLocation(8.5322, -82.8450);
  assert.equal(resCR.geo_tipo, 'FRONTERIZO');
  assert.equal(resCR.geo_pais, 'Costa Rica');
  assert.ok(resCR.geo_provincia.includes('Costa Rica') || resCR.geo_provincia.includes('Puntarenas'));
});

test('22. Isla Cébaco insular en tierra firme insular', () => {
  // Centroide de Isla Cébaco: lat 7.5275, lon -81.1531
  const res = resolveLocation(7.5275, -81.1531);
  assert.equal(res.geo_tipo, 'INSULAR');
  assert.equal(res.geo_provincia, 'Veraguas');
  assert.equal(res.geo_distrito, 'Montijo');
  assert.equal(res.geo_poblado_ref, 'Isla Cébaco');
  assert.ok(res.geo_ubicacion_texto.includes('Isla Cébaco'));
});

test('23. Paridad ESM (Cloudflare Worker) vs CommonJS (Node.js)', async () => {
  const esm = await import('../cloudflare/lib/geo-resolver.mjs');
  const sampleCoords = [
    [7.61967, -81.81950, 'Sismo Coiba'],
    [7.99171, -81.05507, 'Montijo'],
    [9.0552, -79.48856, 'San Miguelito'],
    [7.83901, -78.14188, 'Sambú'],
    [8.5322, -82.8400, 'Paso Canoas']
  ];

  for (const [lat, lon, desc] of sampleCoords) {
    const cjsRes = resolveLocation(lat, lon, desc);
    const esmRes = esm.resolveLocation(lat, lon, desc);
    assert.deepEqual(esmRes, cjsRes, `Discrepancia detectada en lat: ${lat}, lon: ${lon}`);
  }
});

test('24. Sismo cercano a una isla con nombre verificado (Isla Taboga)', () => {
  // Coordenada en aguas a ~2.5 km de Isla Taboga: lat 8.780, lon -79.540
  const res = resolveLocation(8.780, -79.540);
  assert.equal(res.geo_tipo, 'MARITIMO');
  assert.equal(res.geo_poblado_ref, 'Isla Taboga');
  assert.ok(res.geo_distancia_km <= 5, 'Distancia a Isla Taboga debe ser <= 5 km');
  assert.ok(res.geo_ubicacion_texto.includes('Isla Taboga'));
  assert.ok(!res.geo_ubicacion_texto.includes('Isla Menor'), 'No debe contener nombres sintéticos');
});

test('25. Sismo cercano a un islote sin nombre no expone identificadores sintéticos', () => {
  // Caso real del catálogo: lat 7.38472, lon -80.10867 (adyacente al islote 288 pero frente a costa de Azuero)
  const res = resolveLocation(7.38472, -80.10867, 'Localizado en Panamá a 36km al este de Tonosí');
  assert.equal(res.geo_tipo, 'MARITIMO');
  assert.notEqual(res.geo_poblado_ref, 'Isla Menor (288)', 'Bajo ninguna circunstancia debe exponer Isla Menor');
  assert.ok(!res.geo_poblado_ref.includes('Isla Menor'));
  assert.ok(!res.geo_ubicacion_texto.includes('Isla Menor'));
  assert.equal(res.geo_poblado_ref, 'Los Asientos', 'Debe seleccionar la referencia verificada más cercana');
  assert.ok(res.geo_zona_maritima.includes('Pacífico'));
});

test('26. Sismo entre varias islas verificadas (Canal entre Coiba y Jicarón)', () => {
  // Coordenada en canal marítimo entre Isla Coiba e Isla Jicarón: lat 7.300, lon -81.780
  const res = resolveLocation(7.300, -81.780);
  assert.equal(res.geo_tipo, 'MARITIMO');
  assert.ok(['Isla Coiba', 'Isla Jicarón'].includes(res.geo_poblado_ref), 'Debe resolver una de las islas verificadas adyacentes');
  assert.ok(!res.geo_ubicacion_texto.includes('Isla Menor'));
  assert.ok(res.geo_zona_maritima.includes('Pacífico'));
});

test('27. Sismo marítimo en alta mar / mar abierto sin referencia costera cercana', () => {
  // Coordenada en mar abierto ZEE Pacífico (> 105 km de tierra): lat 6.000, lon -80.000
  const res = resolveLocation(6.000, -80.000);
  assert.equal(res.geo_tipo, 'MARITIMO');
  assert.equal(res.geo_poblado_ref, null, 'En mar abierto a > 100 km no debe asociar localidades distantes');
  assert.ok(res.geo_ubicacion_texto.includes('en mar abierto'));
  assert.ok(res.geo_zona_maritima.includes('Pacífico'));
});

test('28. Sismo sobre un islote sin nombre: clasifica INSULAR, conserva jurisdicción y cero nombres sintéticos', () => {
  // Epicentro dentro del polígono del islote 13 (Archipiélago de las Perlas): lat 8.400, lon -79.100
  const res = resolveLocation(8.400, -79.100);
  assert.equal(res.geo_tipo, 'INSULAR');
  assert.equal(res.geo_provincia, 'Panamá');
  assert.equal(res.geo_distrito, 'Balboa');
  assert.notEqual(res.geo_poblado_ref, 'Isla Menor (13)');
  assert.ok(!res.geo_poblado_ref.includes('Isla Menor'));
  assert.ok(!res.geo_ubicacion_texto.includes('Isla Menor'));
  assert.ok(res.geo_ubicacion_texto.includes('Balboa (Panamá)'));
});

test('29. Conservación íntegra de la descripción original del IGC y atributos administrativos', () => {
  const origDesc = 'Localizado en Panamá a 11km al noroeste de Coiba';
  const res = resolveLocation(7.61967, -81.81950, origDesc);
  assert.equal(res.geo_tipo, 'MARITIMO');
  assert.equal(res.geo_poblado_ref, 'Isla Coiba');
  assert.equal(res.geo_distancia_km, 2.8);
  assert.equal(res.geo_rumbo, 'al NO');
  assert.equal(res.geo_provincia_ref, 'Veraguas');
  assert.equal(res.geo_distrito_ref, 'Montijo');
  assert.equal(res.geo_provincia, null);
  assert.equal(res.geo_distrito, null);
  assert.equal(res.geo_corregimiento, null);
});

test('30. Ausencia total de identificadores sintéticos en todas las salidas públicas del catálogo', () => {
  const testCoords = [
    [7.38472, -80.10867], // Azuero / Los Asientos
    [9.02783, -82.24867], // Bocas / Chiriquí Grande
    [7.67317, -81.51217], // Coiba NE
    [7.67117, -81.56383], // Coiba NE
    [7.41934, -80.24680], // Cañas / Tonosí
    [7.66657, -81.61082], // Coiba
    [7.70981, -81.54607], // Pixvae
    [7.37228, -80.12955], // Los Asientos
    [7.20799, -81.03366], // Arenas
    [7.65711, -81.16217]  // Cébaco
  ];

  for (const [lat, lon] of testCoords) {
    const res = resolveLocation(lat, lon);
    const serialized = JSON.stringify(res);
    assert.ok(!serialized.includes('Isla Menor'), `Salida pública contiene Isla Menor en (${lat}, ${lon}): ${serialized}`);
    assert.ok(!serialized.includes('(') || !serialized.match(/Isla Menor \(\d+\)/), 'No debe contener patrón Isla Menor (X)');
  }
});

test('31. Paridad ESM vs CJS extendida para casos de toponimia insular y marítima', async () => {
  const esm = await import('../cloudflare/lib/geo-resolver.mjs');
  const testCases = [
    [7.38472, -80.10867],
    [9.02783, -82.24867],
    [8.400, -79.100],
    [6.000, -80.000],
    [8.780, -79.540]
  ];

  for (const [lat, lon] of testCases) {
    const cjs = resolveLocation(lat, lon);
    const esmRes = esm.resolveLocation(lat, lon);
    assert.deepEqual(esmRes, cjs, `Divergencia ESM/CJS en (${lat}, ${lon})`);
  }
});
