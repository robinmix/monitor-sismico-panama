const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8897;
const ROOT_DIR = path.resolve(__dirname, '..');

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  let pathname = parsedUrl.pathname;
  if (pathname === '/') pathname = '/index.html';

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

  res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function diagnoseManifest() {
  await new Promise(r => server.listen(PORT, r));

  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const cdpPort = 9345;
  const tempProfile = path.join('C:\\Users\\robin\\AppData\\Local\\Temp', 'edge_diag_' + Date.now());

  const edge = spawn(edgePath, [
    '--headless=new',
    '--no-sandbox',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${tempProfile}`,
    `http://localhost:${PORT}/`
  ]);

  await sleep(3500);

  try {
    const tabs = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    const pageTab = tabs.find(t => t.url.includes(`localhost:${PORT}`));
    const ws = new WebSocket(pageTab.webSocketDebuggerUrl);
    await new Promise(r => { ws.onopen = r; });

    let msgId = 1;
    function sendCommand(method, params = {}) {
      return new Promise((resolve) => {
        const id = msgId++;
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

    await sendCommand('Page.enable');
    await sleep(2000);

    const manifestResult = await sendCommand('Page.getAppManifest');
    console.log('[CDP Page.getAppManifest RESULT]:');
    console.log(JSON.stringify(manifestResult, null, 2));

    const appIdResult = await sendCommand('Page.getAppId');
    console.log('[CDP Page.getAppId RESULT]:');
    console.log(JSON.stringify(appIdResult, null, 2));

    ws.close();
  } finally {
    edge.kill();
    server.close();
    try { fs.rmSync(tempProfile, { recursive: true, force: true }); } catch (_) {}
  }
}

diagnoseManifest().catch(console.error);
