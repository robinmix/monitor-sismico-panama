const test = require('node:test');
const assert = require('node:assert/strict');
const { haversineKm, formatDistanceKm, EARTH_RADIUS_KM } = require('../lib/haversine');

test('constante geodésica del radio terrestre IUGG', () => {
  assert.equal(EARTH_RADIUS_KM, 6371.0088);
});

test('distancia cero entre coordenadas idénticas', () => {
  const p1 = { lat: 8.9824, lon: -79.5199 };
  const d = haversineKm(p1.lat, p1.lon, p1.lat, p1.lon);
  assert.equal(d, 0);
  assert.equal(formatDistanceKm(d), '0.0 km');
});

test('distancia Ciudad de Panamá a David (~325.8 km)', () => {
  const panama = { lat: 8.9824, lon: -79.5199 };
  const david = { lat: 8.4273, lon: -82.4303 };

  const d = haversineKm(panama.lat, panama.lon, david.lat, david.lon);
  assert.ok(d > 325 && d < 327, `Distancia calculada ${d} fuera del rango esperado`);
  assert.equal(formatDistanceKm(d), '325.8 km');
});

test('distancia Tonosí a Las Tablas (~44.0 km)', () => {
  const tonosi = { lat: 7.4042, lon: -80.4439 };
  const lasTablas = { lat: 7.7667, lon: -80.2833 };

  const d = haversineKm(tonosi.lat, tonosi.lon, lasTablas.lat, lasTablas.lon);
  assert.ok(d > 43.5 && d < 44.5, `Distancia calculada ${d} fuera del rango esperado`);
  assert.equal(formatDistanceKm(d), '44.0 km');
});

test('simetría: la distancia A->B es igual a B->A', () => {
  const pA = { lat: 9.3598, lon: -79.9015 }; // Colón
  const pB = { lat: 8.2500, lon: -81.0833 }; // Santiago
  const d1 = haversineKm(pA.lat, pA.lon, pB.lat, pB.lon);
  const d2 = haversineKm(pB.lat, pB.lon, pA.lat, pA.lon);
  assert.equal(d1.toFixed(6), d2.toFixed(6));
});

test('acepta coordenadas pasadas como cadenas numéricas', () => {
  const d = haversineKm('8.9824', '-79.5199', '8.4273', '-82.4303');
  assert.equal(formatDistanceKm(d), '325.8 km');
});

test('manejo de valores nulos, inválidos o fuera de rango', () => {
  assert.equal(haversineKm(null, -79.5, 8.4, -82.4), null);
  assert.equal(haversineKm(8.9, undefined, 8.4, -82.4), null);
  assert.equal(haversineKm('abc', -79.5, 8.4, -82.4), null);
  assert.equal(haversineKm(95, -79.5, 8.4, -82.4), null); // Latitud fuera de [-90, 90]
  assert.equal(haversineKm(8.9, -190, 8.4, -82.4), null); // Longitud fuera de [-180, 180]
});

test('formateo de distancias a 1 decimal', () => {
  assert.equal(formatDistanceKm(12.38), '12.4 km');
  assert.equal(formatDistanceKm(0.04), '0.0 km');
  assert.equal(formatDistanceKm(1450.92), '1450.9 km');
  assert.equal(formatDistanceKm(null), '');
  assert.equal(formatDistanceKm(undefined), '');
  assert.equal(formatDistanceKm(NaN), '');
  assert.equal(formatDistanceKm(-5), '');
});
