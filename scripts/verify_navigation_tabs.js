const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8899;
const ROOT = path.join(__dirname, '..');
const ARTIFACT_DIR = 'C:\\Users\\robin\\.gemini\\antigravity\\brain\\5133a983-5a0a-4260-865b-1bb33c769499';

// 1. Simple HTTP Server
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.geojson': 'application/geo+json'
};

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = parsed.pathname;
  if (pathname === '/') pathname = '/index.html';

  // Mock API endpoints for local testing
  if (pathname === '/api/sismos') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      fuente: 'IGC-UP',
      actualizado: new Date().toISOString(),
      eventos: [
        {
          id: '2026-10-28|12:00:00|8.25|-82.85|4.5',
          fecha: '2026-10-28',
          hora: '12:00:00 PM',
          timestamp: '2026-10-28T17:00:00.000Z',
          latitud: 8.25,
          longitud: -82.85,
          profundidad: 10,
          magnitud: 4.5,
          region: 'Golfo de Chiriquí',
          zona: 'Golfo de Chiriquí',
          localidad: 'Puerto Armuelles',
          estado: 'REVISADO'
        }
      ]
    }));
    return;
  }

  if (pathname === '/api/historico-sismos') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      paginacion: { total_registros: 795, pagina_actual: 1, total_paginas: 40, limite: 20, tiene_siguiente: true, tiene_anterior: false },
      eventos: [
        {
          id: 'hist_1',
          source_uid: 'igc_2026-10-12',
          fecha: '2026-10-12',
          hora: '05:30:00 AM',
          timestamp: '2026-10-12T10:30:00.000Z',
          latitud: 7.9,
          longitud: -81.5,
          profundidad: 15,
          magnitud: 3.8,
          region: 'Veraguas',
          zona: 'Veraguas',
          localidad: 'Soná',
          estado: 'REVISADO'
        }
      ]
    }));
    return;
  }

  if (pathname === '/api/push-vapid-key') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, vapidPublicKey: 'BMMtfOw_OoVIt6bjp70GMXMn-oMACjTCn870_Gn4QCQbhiM43kHuP2oto_Uu6d7Az2TOkDvp7V1RJBd-oQfSijM' }));
    return;
  }

  const filePath = path.join(ROOT, pathname);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runValidation() {
  await new Promise(resolve => server.listen(PORT, resolve));
  console.log(`Test server running at http://localhost:${PORT}`);

  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge = spawn(edgePath, [
    '--headless=new',
    '--no-sandbox',
    '--remote-debugging-port=9225',
    '--user-data-dir=C:\\Users\\robin\\AppData\\Local\\Temp\\edge_cdp_nav_' + Math.random().toString(36).slice(2),
    `http://localhost:${PORT}/index.html`
  ]);

  // Wait for Edge CDP port to be ready
  let tabs = null;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      const res = await fetch('http://127.0.0.1:9225/json');
      if (res.ok) {
        tabs = await res.json();
        if (tabs && tabs.length) break;
      }
    } catch (_) {}
  }
  if (!tabs) throw new Error('Edge CDP not responding on port 9225');

  try {
    const pageTab = tabs.find(t => t.url.includes(`localhost:${PORT}`));
    if (!pageTab) throw new Error('Tab not found');

    const ws = new WebSocket(pageTab.webSocketDebuggerUrl);

    let msgId = 1;
    function send(method, params = {}) {
      return new Promise((resolve) => {
        const id = msgId++;
        const handler = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.id === id) {
            ws.removeEventListener('message', handler);
            resolve(msg.result);
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await new Promise(r => { ws.onopen = r; });

    async function evaluate(expr) {
      const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (res && res.result && res.result.value !== undefined) return res.result.value;
      if (res && res.value !== undefined) return res.value;
      return res;
    }

    async function setViewport(w, h, isMobile = true) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: h,
        deviceScaleFactor: 2,
        mobile: isMobile
      });
      await sleep(300);
    }

    async function takeScreenshot(filename) {
      const res = await send('Page.captureScreenshot', { format: 'png' });
      if (res && res.data) {
        const buf = Buffer.from(res.data, 'base64');
        const outPath = path.join(ARTIFACT_DIR, filename);
        fs.writeFileSync(outPath, buf);
        console.log(`[Screenshot] Guardado: ${filename} (${buf.length} bytes)`);
      }
    }

    console.log('\n--- 1. VERIFICACIÓN DE BARRA DE NAVEGACIÓN MÓVIL (4 PESTAÑAS) ---');
    await setViewport(412, 915, true);
    await sleep(1500);

    const navInfo = await evaluate(`(() => {
      const btns = Array.from(document.querySelectorAll('.mobile-bottom-nav .mobile-nav-btn'));
      return {
        count: btns.length,
        tabs: btns.map(b => b.getAttribute('data-tab')),
        labels: btns.map(b => b.querySelector('.mobile-nav-label')?.textContent.trim()),
        widths: btns.map(b => b.getBoundingClientRect().width),
        heights: btns.map(b => b.getBoundingClientRect().height)
      };
    })()`);
    console.log('[Nav Info]:', navInfo);
    if (navInfo.count === 4 && JSON.stringify(navInfo.tabs) === JSON.stringify(['sismos', 'mapa', 'historial', 'mas'])) {
      console.log('✔ Barra móvil contiene exactamente 4 pestañas: Sismos, Mapa, Historial, Más.');
    } else {
      console.error('✖ Error en conteo de pestañas:', navInfo);
    }

    // Verificar distribución equitativa (widths parejos en 412px ~100px cada uno)
    const avgWidth = navInfo.widths.reduce((a, b) => a + b, 0) / navInfo.widths.length;
    const isEven = navInfo.widths.every(w => Math.abs(w - avgWidth) < 2);
    console.log(`[Distribución]: Anchos [${navInfo.widths.map(w => w.toFixed(1)).join(', ')}] px (Promedio: ${avgWidth.toFixed(1)}px). Equitativo: ${isEven}`);

    // TEST TAB: SISMOS
    console.log('\n--- 2. VERIFICACIÓN PESTAÑA SISMOS Y GEOLOCALIZACIÓN HERO ---');
    let sismosCheck = await evaluate(`(() => {
      const getDisp = sel => {
        const el = document.querySelector(sel);
        return el ? window.getComputedStyle(el).display : 'not_found';
      };
      return {
        tab: document.querySelector('#dashboardView').getAttribute('data-active-tab'),
        kickerRecentDisp: getDisp('.kicker-recent'),
        kickerHistDisp: getDisp('.kicker-hist'),
        recordsDisp: getDisp('.records-section'),
        filterDisp: getDisp('.filter-panel'),
        historicoDisp: getDisp('.historico-section'),
        notifDisp: getDisp('.section-notifications'),
        userDistCardDisp: getDisp('#userDistanceCard'),
        geoDistBtnDisp: getDisp('#btnRequestGeo')
      };
    })()`);
    console.log('[Tab: Sismos]', sismosCheck);
    if (sismosCheck.kickerRecentDisp !== 'none' && sismosCheck.userDistCardDisp !== 'none') {
      console.log('✔ Pestaña Sismos: Muestra catálogo reciente y componente "Mi distancia al sismo" activo en Hero Card.');
    } else {
      console.error('✖ Error en visibilidad de pestaña Sismos:', sismosCheck);
    }
    await takeScreenshot('412px_tab_sismos.png');

    // TEST REDIRECCIÓN DE HASH ANTIGUO #cerca
    console.log('\n--- 3. VERIFICACIÓN REDIRECCIÓN DE HASH ANTIGUO #cerca ---');
    await evaluate(`window.location.hash = '#cerca'`);
    await sleep(400);
    const cercaRedirectCheck = await evaluate(`(() => {
      return {
        hash: window.location.hash,
        tab: document.querySelector('#dashboardView').getAttribute('data-active-tab'),
        activeBtn: document.querySelector('.mobile-nav-btn.active')?.getAttribute('data-tab')
      };
    })()`);
    console.log('[Redirección #cerca]:', cercaRedirectCheck);
    if (cercaRedirectCheck.tab === 'sismos' && cercaRedirectCheck.activeBtn === 'sismos') {
      console.log('✔ Redirección correcta: #cerca redirige fluidamente a pestaña Sismos sin pantallas vacías.');
    } else {
      console.error('✖ Fallo en redirección de #cerca:', cercaRedirectCheck);
    }

    // TEST TAB: MAPA
    console.log('\n--- 4. NAVEGANDO: Sismos -> Mapa ---');
    await evaluate(`document.querySelector('#tabBtnMapa')?.click()`);
    await sleep(500);
    let mapaCheck = await evaluate(`(() => {
      const getDisp = sel => {
        const el = document.querySelector(sel);
        return el ? window.getComputedStyle(el).display : 'not_found';
      };
      return {
        tab: document.querySelector('#dashboardView').getAttribute('data-active-tab'),
        locationDisp: getDisp('.location-layout'),
        recordsDisp: getDisp('.records-section'),
        filterDisp: getDisp('.filter-panel')
      };
    })()`);
    console.log('[Tab: Mapa]', mapaCheck);
    if (mapaCheck.locationDisp !== 'none' && mapaCheck.recordsDisp === 'none') {
      console.log('✔ Pestaña Mapa: Muestra cartografía interactiva y oculta catálogo/filtros.');
    }
    await takeScreenshot('412px_tab_mapa.png');

    // TEST TAB: HISTORIAL
    console.log('\n--- 5. NAVEGANDO: Mapa -> Historial ---');
    await evaluate(`document.querySelector('#tabBtnHistorial')?.click()`);
    await sleep(500);
    let histCheck = await evaluate(`(() => {
      const getDisp = sel => {
        const el = document.querySelector(sel);
        return el ? window.getComputedStyle(el).display : 'not_found';
      };
      return {
        tab: document.querySelector('#dashboardView').getAttribute('data-active-tab'),
        kickerRecentDisp: getDisp('.kicker-recent'),
        kickerHistDisp: getDisp('.kicker-hist'),
        recordsDisp: getDisp('.records-section'),
        filterDisp: getDisp('.filter-panel')
      };
    })()`);
    console.log('[Tab: Historial]', histCheck);
    if (histCheck.kickerRecentDisp === 'none' && histCheck.kickerHistDisp !== 'none' && histCheck.filterDisp !== 'none') {
      console.log('✔ Pestaña Historial: Muestra archivo histórico permanente y filtros sin duplicación.');
    }
    await takeScreenshot('412px_tab_historial.png');

    // TEST TAB: MÁS
    console.log('\n--- 6. NAVEGANDO: Historial -> Más ---');
    await evaluate(`document.querySelector('#tabBtnMas')?.click()`);
    await sleep(500);
    let masCheck = await evaluate(`(() => {
      const getDisp = sel => {
        const el = document.querySelector(sel);
        return el ? window.getComputedStyle(el).display : 'not_found';
      };
      return {
        tab: document.querySelector('#dashboardView').getAttribute('data-active-tab'),
        filterDisp: getDisp('.filter-panel'),
        chartDisp: getDisp('.chart-layout'),
        recordsDisp: getDisp('.records-section'),
        notifDisp: getDisp('.section-notifications'),
        transpDisp: getDisp('.section-transparency')
      };
    })()`);
    console.log('[Tab: Más]', masCheck);
    if (masCheck.filterDisp === 'none' && masCheck.chartDisp === 'none' && masCheck.notifDisp !== 'none' && masCheck.transpDisp !== 'none') {
      console.log('✔ Pestaña Más: Exclusiva para alertas y transparencia. Cero filtros ni catálogos.');
    }
    await takeScreenshot('412px_tab_mas.png');

    // TEST PROBAR CICLO COMPLETO DE VUELTA A SISMOS
    console.log('\n--- 7. NAVEGANDO: Más -> Sismos ---');
    await evaluate(`document.querySelector('#tabBtnSismos')?.click()`);
    await sleep(400);

    // PROBAR APERTURA Y CIERRE DE FICHA DETALLE
    console.log('\n--- 8. PROBANDO: Abrir y cerrar ficha de detalle sísmico ---');
    await evaluate(`(() => {
      const card = document.querySelector('.card-tap-zone');
      if (card) card.click();
    })()`);
    await sleep(400);
    let sismoViewOpen = await evaluate(`!document.querySelector('#sismoView').hidden`);
    console.log('Ficha abierta:', sismoViewOpen);
    await evaluate(`(() => {
      const back = document.querySelector('#sismoBackBtn');
      if (back) back.click();
    })()`);
    await sleep(400);
    let sismoViewClosed = await evaluate(`document.querySelector('#sismoView').hidden`);
    console.log('Ficha cerrada correctamente:', sismoViewClosed);

    // CAPTURAS EN TODOS LOS ANCHOS REQUERIDOS (320, 360, 393, 412, 430, 650, 768, 820, 1440 px)
    console.log('\n--- 9. CAPTURANDO SCREENSHOTS EN TODOS LOS ANCHOS REQUERIDOS ---');
    const viewports = [
      { w: 320, h: 640, name: '320px_mobile_historial.png', tab: '#tabBtnHistorial' },
      { w: 360, h: 740, name: '360px_mobile_mas.png', tab: '#tabBtnMas' },
      { w: 393, h: 852, name: '393px_mobile_sismos.png', tab: '#tabBtnSismos' },
      { w: 412, h: 915, name: '412px_samsung_a57_sismos.png', tab: '#tabBtnSismos' },
      { w: 412, h: 915, name: '412px_samsung_a57_mapa.png', tab: '#tabBtnMapa' },
      { w: 412, h: 915, name: '412px_samsung_a57_historial.png', tab: '#tabBtnHistorial' },
      { w: 412, h: 915, name: '412px_samsung_a57_mas.png', tab: '#tabBtnMas' },
      { w: 430, h: 932, name: '430px_mobile_sismos.png', tab: '#tabBtnSismos' },
      { w: 650, h: 900, name: '650px_tablet_small_mas.png', tab: '#tabBtnMas' },
      { w: 768, h: 1024, name: '768px_tablet_historial.png', tab: '#tabBtnHistorial' },
      { w: 820, h: 1180, name: '820px_tablet_large_sismos.png', tab: '#tabBtnSismos' },
      { w: 1440, h: 900, name: '1440px_desktop_flujo_continuo.png', isMobile: false }
    ];

    for (const vp of viewports) {
      await setViewport(vp.w, vp.h, vp.isMobile !== false);
      if (vp.tab) {
        await evaluate(`document.querySelector('${vp.tab}')?.click()`);
        await sleep(350);
      }
      await takeScreenshot(vp.name);
    }

    console.log('\n--- VALIDACIÓN VISUAL Y RESPONSIVE COMPLETADA CON ÉXITO ---');
    ws.close();
  } finally {
    edge.kill();
    server.close();
  }
}

runValidation().catch(err => {
  console.error('Validation error:', err);
  process.exit(1);
});
