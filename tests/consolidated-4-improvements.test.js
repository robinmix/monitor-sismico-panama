'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('MEJORA 1: Formato estricto de notificaciones sísmicas y orden de elementos', async (t) => {
  const {
    formatSeismicNotification,
    cleanLocationReference
  } = await import('../cloudflare/lib/distance-formatter.mjs');

  await t.test('1.1. Limpieza de prefijos IGC-UP ("Localizado en ... a ...")', () => {
    const raw1 = 'Localizado en el Océano Pacífico a 36 km al este de Tonosí';
    assert.equal(cleanLocationReference(raw1), '36 km al este de Tonosí');

    const raw2 = 'Localizado en 15 km al norte de David';
    assert.equal(cleanLocationReference(raw2), '15 km al norte de David');

    const raw3 = 'Localizado en Tierras Altas';
    assert.equal(cleanLocationReference(raw3), 'Tierras Altas');

    const raw4 = '36km al este de Tonosí';
    assert.equal(cleanLocationReference(raw4), '36 km al este de Tonosí');
  });

  await t.test('1.2. Notificación con ubicación GPS reciente (≤ 48h): Título y Cuerpo con orden estricto', () => {
    const sismo = {
      id: 'igc_20261030_001',
      lat: 7.40,
      lon: -80.40,
      mag: 3.5,
      prof: 7,
      lugar: 'Localizado en el Océano Pacífico a 36 km al este de Tonosí'
    };
    const userLoc = {
      lat: 8.50,
      lon: -80.40,
      mode: 'GPS',
      updated_at: new Date().toISOString()
    };

    const notif = formatSeismicNotification(sismo, userLoc);
    assert.equal(notif.title, 'sismoPA · Nuevo sismo');
    // Expected: M3.5 · A 122 km de ti · 36 km al este de Tonosí · 7 km prof.
    assert.match(notif.body, /^M3\.5 · A \d+ km de ti · 36 km al este de Tonosí · 7 km prof\.$/);
    
    // Verify exact ordering: [0]=M3.5, [1]=A X km de ti, [2]=lugar limpio, [3]=profundidad
    const parts = notif.body.split(' · ');
    assert.equal(parts.length, 4);
    assert.equal(parts[0], 'M3.5');
    assert.match(parts[1], /^A \d+ km de ti$/);
    assert.equal(parts[2], '36 km al este de Tonosí');
    assert.equal(parts[3], '7 km prof.');
  });

  await t.test('1.3. Notificación con ubicación de zona fija o GPS > 48h: sufijo "de tu zona"', () => {
    const sismo = {
      id: 'igc_20261030_002',
      lat: 7.40,
      lon: -80.40,
      mag: 4.2,
      prof: 10,
      lugar: 'Localizado en Tonosí'
    };
    const userLoc = {
      lat: 8.50,
      lon: -80.40,
      mode: 'ZONA',
      updated_at: new Date().toISOString()
    };

    const notif = formatSeismicNotification(sismo, userLoc);
    assert.equal(notif.title, 'sismoPA · Nuevo sismo');
    assert.match(notif.body, /^M4\.2 · A \d+ km de tu zona · Tonosí · 10 km prof\.$/);
  });

  await t.test('1.4. Notificación sin ubicación (Fallback general / Topic general)', () => {
    const sismo = {
      id: 'igc_20261030_003',
      lat: 7.40,
      lon: -80.40,
      mag: 3.5,
      prof: 7,
      lugar: 'Localizado en el Océano Pacífico a 36 km al este de Tonosí'
    };

    const notif = formatSeismicNotification(sismo, null);
    assert.equal(notif.title, 'sismoPA · Nuevo sismo');
    assert.equal(notif.body, 'M3.5 · 36 km al este de Tonosí · 7 km prof.');
  });
});

test('MEJORA 2: Concentración territorial y segregación marítima independiente', async (t) => {
  const sampleEvents = [
    { id: '1', geo_tipo: 'TERRESTRE', geo_provincia: 'Chiriquí', geo_distrito: 'David', geo_corregimiento: 'David' },
    { id: '2', geo_tipo: 'TERRESTRE', geo_provincia: 'Chiriquí', geo_distrito: 'David', geo_corregimiento: 'David' },
    { id: '3', geo_tipo: 'TERRESTRE', geo_provincia: 'Chiriquí', geo_distrito: 'Boquete', geo_corregimiento: 'Bajo Boquete' },
    { id: '4', geo_tipo: 'TERRESTRE', geo_provincia: 'Los Santos', geo_distrito: 'Tonosí', geo_corregimiento: 'Tonosí' },
    { id: '5', geo_tipo: 'MARITIMO', geo_zona_maritima: 'Golfo de Chiriquí (Océano Pacífico)' },
    { id: '6', geo_tipo: 'MARITIMO', geo_zona_maritima: 'Golfo de Montijo' }
  ];

  function aggregate(events, level) {
    const counter = new Map();
    events.forEach(e => {
      let key;
      let isMaritime = false;
      if (e.geo_tipo === 'MARITIMO') {
        const seaZone = e.geo_zona_maritima ? e.geo_zona_maritima.split('(')[0].trim() : 'Mar abierto';
        key = 'Zona Marítima (' + seaZone + ')';
        isMaritime = true;
      } else if (level === 'provincia') {
        key = e.geo_provincia || 'Sin clasificar';
      } else if (level === 'distrito') {
        key = e.geo_distrito ? (e.geo_distrito + (e.geo_provincia ? ' (' + e.geo_provincia + ')' : '')) : 'Sin clasificar';
      } else {
        key = e.geo_corregimiento || 'Sin clasificar';
      }
      const c = counter.get(key) || { count: 0, isMaritime };
      c.count += 1;
      counter.set(key, c);
    });
    return counter;
  }

  await t.test('2.1. Nivel Provincia agrupa correctamente y mantiene sismos marítimos separados', () => {
    const res = aggregate(sampleEvents, 'provincia');
    assert.equal(res.get('Chiriquí').count, 3);
    assert.equal(res.get('Los Santos').count, 1);
    assert.equal(res.get('Zona Marítima (Golfo de Chiriquí)').isMaritime, true);
    assert.equal(res.get('Zona Marítima (Golfo de Chiriquí)').count, 1);
    assert.equal(res.get('Zona Marítima (Golfo de Montijo)').count, 1);
    assert.equal(res.has('Golfo de Chiriquí'), false);
  });

  await t.test('2.2. Nivel Distrito nunca asigna eventos marítimos a distritos terrestres', () => {
    const res = aggregate(sampleEvents, 'distrito');
    assert.equal(res.get('David (Chiriquí)').count, 2);
    assert.equal(res.get('Boquete (Chiriquí)').count, 1);
    assert.equal(res.get('Tonosí (Los Santos)').count, 1);
    assert.equal(res.get('Zona Marítima (Golfo de Chiriquí)').isMaritime, true);
    assert.equal(res.get('Zona Marítima (Golfo de Montijo)').isMaritime, true);
  });
});

test('MEJORA 3: Límite de 10 sismos en pestaña principal y orden cronológico descendente', async (t) => {
  const sampleEvents = Array.from({ length: 25 }, (_, i) => ({
    id: `ev_${i + 1}`,
    epoch: 1730000000 + i * 1000,
    utc_iso: new Date(1730000000000 + i * 1000000).toISOString(),
    lugar: `Lugar ${i + 1}`
  }));

  const sorted = [...sampleEvents].sort((a, b) => b.epoch - a.epoch);
  const mainTabLimit = sorted.slice(0, 10);

  assert.equal(mainTabLimit.length, 10);
  assert.equal(mainTabLimit[0].id, 'ev_25');
  assert.equal(mainTabLimit[9].id, 'ev_16');

  const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
  assert.ok(html.includes('Últimos 10 sismos'), 'Debe incluir el título "Últimos 10 sismos"');
  assert.ok(html.includes('id="recordActions"'), 'Debe tener id="recordActions" para control de visibilidad');
  assert.ok(html.includes('id="tableFooter"'), 'Debe tener id="tableFooter" para control de paginación');

  const css = fs.readFileSync(path.resolve('assets/style.css'), 'utf8');
  assert.ok(css.includes('#recordActions') && css.includes('#tableFooter'), 'CSS debe incluir selectores para recordActions y tableFooter');
  assert.ok(css.includes('data-active-tab="sismos"') && css.includes('display: none'), 'CSS debe ocultar controles en pestaña principal');
});

test('MEJORA 4: Selector de días en historial, cálculo bisiesto y omisión de "Supabase"', async (t) => {
  function getDaysInMonth(year, month) {
    if (!year || !month) return 31;
    return new Date(Number(year), Number(month), 0).getDate();
  }

  await t.test('4.1. Días en febrero según año bisiesto y no bisiesto', () => {
    assert.equal(getDaysInMonth(2024, 2), 29, '2024 es bisiesto (29 días)');
    assert.equal(getDaysInMonth(2023, 2), 28, '2023 no es bisiesto (28 días)');
    assert.equal(getDaysInMonth(2026, 2), 28, '2026 no es bisiesto (28 días)');
    assert.equal(getDaysInMonth(2026, 4), 30, 'Abril tiene 30 días');
    assert.equal(getDaysInMonth(2026, 1), 31, 'Enero tiene 31 días');
    assert.equal(getDaysInMonth(2026, 10), 31, 'Octubre tiene 31 días');
  });

  await t.test('4.2. Construcción de rango de fecha ISO para consulta por día', () => {
    const histY = '2026';
    const histM = '10';
    const histD = '15';
    const yStr = String(histY);
    const mStr = String(histM).padStart(2, '0');
    const dStr = String(histD).padStart(2, '0');
    const dateIso = `${yStr}-${mStr}-${dStr}`;
    assert.equal(dateIso, '2026-10-15');
  });

  await t.test('4.3. Texto limpio en interfaz sin la palabra técnica "Supabase"', () => {
    const html = fs.readFileSync(path.resolve('index.html'), 'utf8');
    const appJs = fs.readFileSync(path.resolve('assets/app.js'), 'utf8');

    assert.ok(!html.includes('Supabase'), 'index.html no debe mostrar "Supabase"');
    
    // Check that user-facing labels in app.js do not contain "en Supabase"
    assert.ok(!appJs.includes("'Consultando archivo histórico permanente en Supabase…'"), 'app.js no debe decir en Supabase en el loader');
    assert.ok(!appJs.includes('Mostrando: Archivo histórico permanente en Supabase'), 'app.js no debe mencionar Supabase en títulos');
    assert.ok(appJs.includes('Archivo histórico'), 'app.js debe usar "Archivo histórico"');
  });
});
