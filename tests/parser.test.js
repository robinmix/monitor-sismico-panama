const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEvents, dateFromLocal, classifyRegion } = require('../netlify/functions/sismos');

test('interpretacion de hora local panamena', () => {
  assert.equal(dateFromLocal('2026-10-18','12:00:13AM'), '2026-10-18T05:00:13.000Z');
  assert.equal(dateFromLocal('2026-10-17','11:35:06PM'), '2026-10-18T04:35:06.000Z');
  assert.equal(dateFromLocal('2026-10-18','1:15:46AM'), '2026-10-18T06:15:46.000Z');
});

test('region y localidad', () => {
 assert.deepEqual(classifyRegion('Localizado en Panamá a 33km al oeste de Tonosí'), {zona:'Panamá',localidad:'Tonosí'});
 assert.deepEqual(classifyRegion('Localizado en Región Fronteriza Panamá-Costa Rica a 16km al noroeste de Chiriquí Grande'), {zona:'Región Fronteriza Panamá-Costa Rica',localidad:'Chiriquí Grande'});
});

test('parsea, ordena, valida y elimina duplicados', () => {
 const row = (state,date,time,lat,lon,depth,mag,region) => `<tr><td>${state}</td><td>${date}</td><td>${time}</td><td>${lat}</td><td>${lon}</td><td>${depth}</td><td>${mag}</td><td>${region}</td><td><a href="/ultimosismo.html?m=${mag}&amp;r=a">Ver</a></td></tr>`;
 const html = '<table>' + row('PRELIMINAR','2026-10-18','5:26:05AM','7.37419','-80.74211','19km','3.6','Localizado en Panamá a 33km al oeste de Tonosí') + row('REVISADO','2026-10-17','11:35:06PM','7.49653','-80.35973','10km','3.6','Localizado en Panamá a 13km al noreste de Tonosí') + row('PRELIMINAR','2026-10-18','5:26:05AM','7.37419','-80.74211','19km','3.6','Localizado en Panamá a 33km al oeste de Tonosí') + '</table>';
 const entries = parseEvents(html);
 assert.equal(entries.length,2);
 assert.equal(entries[0].timestamp, '2026-10-18T10:26:05.000Z');
 assert.equal(entries[0].zona,'Panamá');
 assert.equal(entries[0].localidad,'Tonosí');
 assert.ok(entries[0].detalle.startsWith('https://sismosgeociencias.up.ac.pa/ultimosismo.html?'));
});
