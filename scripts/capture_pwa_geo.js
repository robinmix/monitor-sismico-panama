const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ARTIFACT_DIR = 'C:\\Users\\robin\\.gemini\\antigravity\\brain\\5133a983-5a0a-4260-865b-1bb33c769499';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runBrowserTests() {
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const port = 9320;
  const tempDir = 'C:\\Users\\robin\\AppData\\Local\\Temp\\edge_cap_pwa_' + Date.now();

  const edge = spawn(edgePath, [
    '--headless=new',
    '--no-sandbox',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${tempDir}`,
    'http://localhost:8888'
  ]);

  await sleep(3500);

  try {
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const pageTab = tabs.find(t => t.url.includes('localhost:8888'));
    if (!pageTab) throw new Error('Tab not found for localhost:8888');

    const ws = new WebSocket(pageTab.webSocketDebuggerUrl);

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

    await new Promise((resolve) => { ws.onopen = resolve; });

    // 1. Desktop viewport
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 950,
      deviceScaleFactor: 2,
      mobile: false
    });

    await sleep(2500);

    // Initial desktop screenshot (unprompted)
    const cap1 = await sendCommand('Page.captureScreenshot', { format: 'png' });
    const file1 = path.join(ARTIFACT_DIR, 'captura-pwa-resumen-desktop.png');
    fs.writeFileSync(file1, Buffer.from(cap1.result.data, 'base64'));
    console.log('Saved:', file1);

    // 2. Set up mock Geolocation for Panama City (8.9824, -79.5199) and trigger click
    await sendCommand('Runtime.evaluate', {
      expression: `
        navigator.geolocation.getCurrentPosition = (success) => {
          setTimeout(() => {
            success({
              coords: {
                latitude: 8.9824,
                longitude: -79.5199,
                accuracy: 20
              }
            });
          }, 100);
        };
        document.querySelector('#btnRequestGeo')?.click();
      `
    });

    await sleep(2000);

    const geoCheck = await sendCommand('Runtime.evaluate', {
      expression: `({
        distActiveHidden: document.querySelector('#distActive')?.hidden,
        distValue: document.querySelector('#distValue')?.textContent?.trim(),
        distLabel: document.querySelector('.dist-label')?.textContent?.trim(),
        distNote: document.querySelector('.dist-note')?.textContent?.trim(),
        colDistanceHidden: document.querySelector('#colDistanceTh')?.hidden,
        tableFirstRowDist: document.querySelector('#recordsBody tr td .cell-distance')?.textContent
      })`,
      returnByValue: true
    });
    console.log('Geo active DOM check:', JSON.stringify(geoCheck.result.value, null, 2));

    // Capture Geo Active state (Desktop)
    const cap2 = await sendCommand('Page.captureScreenshot', { format: 'png' });
    const file2 = path.join(ARTIFACT_DIR, 'captura-geo-activa-desktop.png');
    fs.writeFileSync(file2, Buffer.from(cap2.result.data, 'base64'));
    console.log('Saved:', file2);

    // 3. Scroll to Records Table to show distance column in desktop table
    await sendCommand('Runtime.evaluate', {
      expression: `document.querySelector('#registros')?.scrollIntoView({ behavior: 'instant', block: 'start' })`
    });
    await sleep(1000);

    const cap3 = await sendCommand('Page.captureScreenshot', { format: 'png' });
    const file3 = path.join(ARTIFACT_DIR, 'captura-geo-tabla-desktop.png');
    fs.writeFileSync(file3, Buffer.from(cap3.result.data, 'base64'));
    console.log('Saved:', file3);

    // 4. Open individual sismo ficha to verify distance in ficha
    await sendCommand('Runtime.evaluate', {
      expression: `document.querySelector('#recordsBody tr a.table-action-btn')?.click()`
    });
    await sleep(1500);

    const fichaCheck = await sendCommand('Runtime.evaluate', {
      expression: `({
        fichaHidden: document.querySelector('#sismoView')?.hidden,
        distanceParamHidden: document.querySelector('#sismoDistanceParam')?.hidden,
        distanceVal: document.querySelector('#sismoDistanceVal')?.textContent?.trim()
      })`,
      returnByValue: true
    });
    console.log('Ficha individual DOM check:', JSON.stringify(fichaCheck.result.value, null, 2));

    const cap4 = await sendCommand('Page.captureScreenshot', { format: 'png' });
    const file4 = path.join(ARTIFACT_DIR, 'captura-geo-ficha-desktop.png');
    fs.writeFileSync(file4, Buffer.from(cap4.result.data, 'base64'));
    console.log('Saved:', file4);

    // Close ficha
    await sendCommand('Runtime.evaluate', {
      expression: `document.querySelector('#sismoBackBtn')?.click()`
    });
    await sleep(800);

    // 5. Mobile Viewport (iPhone 14 / 390x844)
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });
    await sendCommand('Runtime.evaluate', {
      expression: `window.scrollTo(0, 0)`
    });
    await sleep(1200);

    const cap5 = await sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    });
    const file5 = path.join(ARTIFACT_DIR, 'captura-pwa-geo-movil.png');
    fs.writeFileSync(file5, Buffer.from(cap5.result.data, 'base64'));
    console.log('Saved:', file5);

    // 6. Test iOS PWA Modal trigger on Mobile
    await sendCommand('Runtime.evaluate', {
      expression: `
        document.querySelector('#iosInstallModal').hidden = false;
      `
    });
    await sleep(600);

    const cap6 = await sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    });
    const file6 = path.join(ARTIFACT_DIR, 'captura-pwa-ios-modal.png');
    fs.writeFileSync(file6, Buffer.from(cap6.result.data, 'base64'));
    console.log('Saved:', file6);

    ws.close();
    console.log('All tests and captures completed successfully!');
  } finally {
    edge.kill();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

runBrowserTests().catch(err => {
  console.error('Error during browser tests:', err);
  process.exit(1);
});
