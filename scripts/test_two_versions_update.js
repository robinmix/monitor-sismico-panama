const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8898;
const ROOT_DIR = path.resolve(__dirname, '..');

// Estado dinámico del servidor para simular dos versiones sucesivas (v1 -> v2)
let currentVersion = '20261019b';
let appJsContent = fs.readFileSync(path.join(ROOT_DIR, 'assets', 'app.js'), 'utf8');
let styleCssContent = fs.readFileSync(path.join(ROOT_DIR, 'assets', 'style.css'), 'utf8');
let swJsContent = fs.readFileSync(path.join(ROOT_DIR, 'sw.js'), 'utf8');
let htmlContent = fs.readFileSync(path.join(ROOT_DIR, 'index.html'), 'utf8');

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = parsedUrl.pathname;

  if (pathname === '/') pathname = '/index.html';

  // Mock de APIs sísmicas para simulación
  if (pathname.includes('/.netlify/functions/seismic-feed') || pathname.includes('/.netlify/functions/sismos')) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      ok: true,
      data: [{
        fecha: '19/10/2026',
        hora: '05:30:00',
        latitud: '8.123',
        longitud: '-80.456',
        magnitud: '4.2',
        profundidad: '15.0',
        region: 'Golfo de Panamá',
        localidad: 'Tonosí',
        estado: 'REVISADO',
        source_uid: 'IGC-20261019-053000-8123-80456'
      }]
    }));
    return;
  }

  // Entrega dinámica de archivos según la versión activa
  if (pathname === '/index.html') {
    const customizedHtml = htmlContent
      .replace(/style\.css\?v=[^"]+/g, `style.css?v=${currentVersion}`)
      .replace(/app\.js\?v=[^"]+/g, `app.js?v=${currentVersion}`);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, must-revalidate'
    });
    res.end(customizedHtml);
    return;
  }

  if (pathname === '/sw.js') {
    const customizedSw = swJsContent
      .replace(/core-v[a-zA-Z0-9_-]+/g, `core-v${currentVersion}`);
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(customizedSw);
    return;
  }

  if (pathname === '/assets/app.js') {
    // Inyectar marca de versión en el JS para verificar qué versión corre el navegador
    const customizedApp = `window.__APP_VERSION__ = "${currentVersion}";\n` + appJsContent;
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, must-revalidate'
    });
    res.end(customizedApp);
    return;
  }

  if (pathname === '/assets/style.css') {
    res.writeHead(200, {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, must-revalidate'
    });
    res.end(styleCssContent);
    return;
  }

  const filePath = path.join(ROOT_DIR, pathname);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png'
  };
  res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runTwoVersionsTest() {
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`[Test Server] Servidor de versiones escuchando en http://localhost:${PORT}`);

  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const cdpPort = 9339;
  const tempProfile = path.join('C:\\Users\\robin\\AppData\\Local\\Temp', 'edge_update_sim_' + Date.now());

  const edgeProcess = spawn(edgePath, [
    '--headless=new',
    '--no-sandbox',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${tempProfile}`,
    `http://localhost:${PORT}/`
  ]);

  await sleep(4000);

  try {
    const tabsResp = await fetch(`http://127.0.0.1:${cdpPort}/json`);
    const tabs = await tabsResp.json();
    const pageTab = tabs.find((t) => t.url.includes(`localhost:${PORT}`));

    if (!pageTab) throw new Error('No se encontró la pestaña en Edge');

    const ws = new WebSocket(pageTab.webSocketDebuggerUrl);
    await new Promise((resolve) => { ws.onopen = resolve; });

    let reqId = 1;
    function sendCommand(method, params = {}) {
      return new Promise((resolve) => {
        const id = reqId++;
        const handler = (event) => {
          const res = JSON.parse(event.data);
          if (res.id === id) {
            ws.removeEventListener('message', handler);
            resolve(res);
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    const consoleErrors = [];
    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') {
        consoleErrors.push(data.params.entry.text);
      }
      if (data.method === 'Runtime.exceptionThrown') {
        consoleErrors.push(data.params.exceptionDetails.text);
      }
    });

    await sendCommand('Runtime.enable');
    await sendCommand('Log.enable');
    await sendCommand('Page.enable');
    await sendCommand('Network.enable');

    console.log('\n--- FASE 1: INSTALACIÓN DE VERSIÓN INICIAL (v1: 20261019b) ---');
    await sleep(4000);

    const checkV1 = await sendCommand('Runtime.evaluate', {
      expression: `(async () => {
        const swReady = await navigator.serviceWorker.ready;
        const cacheNames = await caches.keys();
        return {
          appVersion: window.__APP_VERSION__,
          swScope: swReady.scope,
          cacheNames: cacheNames
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const v1Result = checkV1.result?.result?.value;
    console.log('[FASE 1] Versión cargada en navegador:', v1Result.appVersion);
    console.log('[FASE 1] Cachés creadas:', v1Result.cacheNames);

    if (v1Result.appVersion !== '20261019b') {
      throw new Error(`Esperaba v1 20261019b pero obtuve ${v1Result.appVersion}`);
    }
    if (!v1Result.cacheNames.some(c => c.includes('core-v20261019b'))) {
      throw new Error(`Caché core-v20261019b no encontrada`);
    }

    console.log('\n--- FASE 2: ACTUALIZACIÓN EN SERVIDOR A VERSIÓN 2 (v2: 20261019c) ---');
    console.log('[Servidor] Desplegando versión 20261019c en el mismo origen...');
    currentVersion = '20261019c';

    console.log('[Navegador] Recargando aplicación (sin borrar caché manualmente)...');
    await sendCommand('Page.reload');
    await sleep(4500);

    const checkV2 = await sendCommand('Runtime.evaluate', {
      expression: `(async () => {
        const cacheNames = await caches.keys();
        return {
          appVersion: window.__APP_VERSION__,
          cacheNames: cacheNames
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    const v2Result = checkV2.result?.result?.value;
    console.log('[FASE 2] Versión en ejecución tras actualización:', v2Result.appVersion);
    console.log('[FASE 2] Cachés en almacenamiento tras actualización:', v2Result.cacheNames);

    if (v2Result.appVersion !== '20261019c') {
      throw new Error(`Error: la app no recibió la nueva versión v20261019c (quedó en ${v2Result.appVersion})`);
    }
    console.log('[PASS] ¡La aplicación recibió exitosamente la nueva versión sin borrar caché!');

    console.log('\n--- FASE 3: PRUEBA DE COMPORTAMIENTO OFFLINE ---');
    console.log('[CDP] Emulando desconexión de red (modo avión)...');
    await sendCommand('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0
    });

    console.log('[CDP] Recargando página en modo offline...');
    await sendCommand('Page.reload');
    await sleep(3500);

    const checkOffline = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        return {
          hasAppShell: Boolean(document.querySelector('.topbar')),
          title: document.title,
          totalSismosEl: Boolean(document.getElementById('statTotal')),
          appVersion: window.__APP_VERSION__
        };
      })()`,
      returnByValue: true
    });

    const offResult = checkOffline.result?.result?.value;
    console.log('[FASE 3] Resultado Offline:', JSON.stringify(offResult, null, 2));

    if (!offResult || !offResult.hasAppShell) {
      throw new Error('Fallo: La aplicación no cargó el App Shell en modo offline');
    }
    console.log('[PASS] ¡El App Shell carga perfectamente sin conexión desde la caché!');

    console.log('\n--- FASE 4: RECUPERACIÓN TRAS VOLVER A CONECTARSE ---');
    console.log('[CDP] Restaurando conexión de red normal...');
    await sendCommand('Network.emulateNetworkConditions', {
      offline: false,
      latency: 20,
      downloadThroughput: 10 * 1024 * 1024,
      uploadThroughput: 5 * 1024 * 1024
    });

    await sendCommand('Page.reload');
    await sleep(3500);

    const checkRecover = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const rowCount = document.querySelectorAll('#recordsBody tr').length;
        const lastReg = document.getElementById('latestRegion')?.textContent;
        return {
          rowCount,
          lastRegion: lastReg
        };
      })()`,
      returnByValue: true
    });

    console.log('[FASE 4] Datos sísmicos tras reconexión:', JSON.stringify(checkRecover.result?.result?.value, null, 2));
    console.log('[PASS] Errores de consola totales durante las 4 fases:', consoleErrors.length);

    ws.close();
  } finally {
    edgeProcess.kill();
    server.close();
    try {
      fs.rmSync(tempProfile, { recursive: true, force: true });
    } catch (_) {}
  }
}

runTwoVersionsTest()
  .then(() => {
    console.log('\n======================================================');
    console.log('✅ TODAS LAS FASES DE VALIDACIÓN DE ACTUALIZACIÓN PASARON');
    console.log('======================================================');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n❌ FALLO EN LA SIMULACIÓN DE ACTUALIZACIÓN:', err);
    process.exit(1);
  });
