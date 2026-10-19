const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8899;
const ROOT_DIR = path.resolve(__dirname, '..');

// Servidor HTTP local con cabeceras correctas de Netlify
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = parsedUrl.pathname;

  if (pathname === '/') pathname = '/index.html';

  // Mock de la función de sismos para prueba local aislada
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
        magnitud: '3.8',
        profundidad: '12.4',
        region: 'Golfo de Panamá',
        localidad: 'Tonosí',
        estado: 'REVISADO',
        source_uid: 'IGC-20261019-053000-8123-80456'
      }]
    }));
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
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png'
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
});

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function testPwaRuntime() {
  await new Promise((resolve) => server.listen(PORT, resolve));
  console.log(`[Test Server] Escuchando en http://localhost:${PORT}`);

  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const cdpPort = 9338;
  const tempProfile = path.join('C:\\Users\\robin\\AppData\\Local\\Temp', 'edge_pwa_test_' + Date.now());

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

    if (!pageTab) throw new Error('No se encontró la pestaña de localhost en Edge');

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
        consoleErrors.push({ text: data.params.entry.text, url: data.params.entry.url });
      }
      if (data.method === 'Runtime.exceptionThrown') {
        consoleErrors.push({ text: data.params.exceptionDetails.text, url: data.params.exceptionDetails.url });
      }
    });

    await sendCommand('Runtime.enable');
    await sendCommand('Log.enable');

    console.log('[CDP] Esperando registro y activación del Service Worker...');
    await sleep(4000);

    // Evaluar estado del Service Worker y Cache Storage
    const evalResult = await sendCommand('Runtime.evaluate', {
      expression: `(async () => {
        const swReady = await navigator.serviceWorker.ready;
        const cacheNames = await caches.keys();
        const coreCache = await caches.open(cacheNames.find(c => c.includes('core')));
        const keys = await coreCache.keys();
        return {
          swScope: swReady.scope,
          cacheNames: cacheNames,
          cachedUrls: keys.map(k => k.url)
        };
      })()`,
      awaitPromise: true,
      returnByValue: true
    });

    console.log('[CDP] evalResult:', JSON.stringify(evalResult, null, 2));

    const val = evalResult.result?.result?.value;
    if (!val || !val.swScope) {
      throw new Error('Service Worker no se activó correctamente');
    }

    const hasCore = val.cacheNames.some(c => c.includes('sismodata-core'));
    const hasStatic = val.cacheNames.some(c => c.includes('sismodata-static'));

    if (!hasCore || !hasStatic) {
      throw new Error(`Cachés esperadas no encontradas: ${JSON.stringify(val.cacheNames)}`);
    }

    console.log(`[PASS] Service Worker activo en scope: ${val.swScope}`);
    console.log(`[PASS] Cachés inicializadas: ${val.cacheNames.join(', ')}`);
    console.log(`[PASS] Activos en core cache: ${val.cachedUrls.length}`);
    console.log(`[PASS] Errores de consola: ${consoleErrors.length}`, consoleErrors);

    ws.close();
  } finally {
    edgeProcess.kill();
    server.close();
    try {
      fs.rmSync(tempProfile, { recursive: true, force: true });
    } catch (_) {}
  }
}

testPwaRuntime()
  .then(() => {
    console.log('=== VERIFICACIÓN RUNTIME PWA EXITOSA ===');
    process.exit(0);
  })
  .catch((err) => {
    console.error('=== FALLO DE VERIFICACIÓN RUNTIME ===', err);
    process.exit(1);
  });
