const { spawn } = require('child_process');
const fs = require('fs');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function capture(url, width, height, isMobile, clickSelector, outFilename, scrollSelector) {
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const port = 9250 + Math.floor(Math.random() * 40);
  const tempDir = 'C:\\Users\\robin\\AppData\\Local\\Temp\\edge_cap_rubik_' + Math.random().toString(36).slice(2);
  const edge = spawn(edgePath, [
    '--headless=new',
    '--no-sandbox',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${tempDir}`,
    url
  ]);

  await sleep(3000);

  try {
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const pageTab = tabs.find(t => t.url.includes('localhost:8888'));
    if (!pageTab) throw new Error('Tab not found for localhost:8888');

    const ws = new WebSocket(pageTab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = async () => {
        ws.send(JSON.stringify({
          id: 1,
          method: 'Emulation.setDeviceMetricsOverride',
          params: { width, height, deviceScaleFactor: 2, mobile: isMobile }
        }));

        await sleep(3000);

        if (scrollSelector) {
          ws.send(JSON.stringify({
            id: 2,
            method: 'Runtime.evaluate',
            params: { expression: `document.querySelector('${scrollSelector}')?.scrollIntoView({behavior: 'instant', block: 'start'})` }
          }));
          await sleep(1200);
        }

        if (clickSelector) {
          ws.send(JSON.stringify({
            id: 3,
            method: 'Runtime.evaluate',
            params: { expression: `document.querySelector('${clickSelector}')?.click()` }
          }));
          await sleep(1200);
        }

        const screenshotParams = { format: 'png' };
        if (isMobile) {
          screenshotParams.captureBeyondViewport = false;
          screenshotParams.clip = { x: 0, y: 0, width, height, scale: 1 };
        }
        ws.send(JSON.stringify({
          id: 4,
          method: 'Page.captureScreenshot',
          params: screenshotParams
        }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id === 4 && msg.result && msg.result.data) {
          const buf = Buffer.from(msg.result.data, 'base64');
          fs.writeFileSync(outFilename, buf);
          console.log(`Saved ${outFilename} (${buf.length} bytes)`);
          resolve();
        }
      };

      ws.onerror = reject;
    });
  } finally {
    edge.kill();
  }
}

(async () => {
  try {
    console.log('Capturing Desktop Resumen with Rubik...');
    await capture('http://localhost:8888/#resumen', 1440, 960, false, null, 'captura-rubik-resumen-desktop.png', null);

    console.log('Capturing Desktop Registros / Catálogo...');
    await capture('http://localhost:8888/#registros', 1440, 960, false, null, 'captura-rubik-registros-desktop.png', '#registros');

    console.log('Capturing Desktop Histórico...');
    await capture('http://localhost:8888/#historico', 1440, 1050, false, null, 'captura-rubik-historico-desktop.png', '#historico');

    console.log('Capturing Mobile View (390px)...');
    await capture('http://localhost:8888/#resumen', 390, 844, true, null, 'captura-rubik-movil.png', null);

    console.log('All Rubik theme captures complete!');
  } catch (err) {
    console.error('Capture error:', err);
  }
})();
