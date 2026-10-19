const { spawn } = require('child_process');
const fs = require('fs');

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function capture(url, width, height, isMobile, outFilename, scrollSelector) {
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edge = spawn(edgePath, [
    '--headless=new',
    '--no-sandbox',
    '--remote-debugging-port=9227',
    '--user-data-dir=C:\\Users\\robin\\AppData\\Local\\Temp\\edge_cdp_cap_' + Math.random().toString(36).slice(2),
    url
  ]);

  await sleep(3000);

  try {
    const tabs = await (await fetch('http://127.0.0.1:9227/json')).json();
    const pageTab = tabs.find(t => t.url.includes('localhost:8888'));
    if (!pageTab) throw new Error('Tab not found');

    const ws = new WebSocket(pageTab.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = async () => {
        ws.send(JSON.stringify({
          id: 1,
          method: 'Emulation.setDeviceMetricsOverride',
          params: { width, height, deviceScaleFactor: 2, mobile: isMobile }
        }));

        await sleep(3500);

        if (scrollSelector) {
          ws.send(JSON.stringify({
            id: 2,
            method: 'Runtime.evaluate',
            params: { expression: `document.querySelector('${scrollSelector}')?.scrollIntoView({behavior: 'instant', block: 'center'})` }
          }));
          await sleep(1000);
        }

        ws.send(JSON.stringify({
          id: 3,
          method: 'Page.captureScreenshot',
          params: { format: 'png' }
        }));
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id === 3 && msg.result && msg.result.data) {
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
  console.log('Capturing mobile table...');
  await capture('http://localhost:8888/#registros', 390, 844, true, 'captura-v4-tabla-movil.png', '#registros');

  console.log('Capturing mobile masthead...');
  await capture('http://localhost:8888/#resumen', 390, 844, true, 'captura-v4-resumen-movil.png', '#resumen');

  console.log('Done!');
})();
