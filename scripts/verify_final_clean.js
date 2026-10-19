const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ARTIFACT_DIR = 'C:\\Users\\robin\\.gemini\\antigravity\\brain\\5133a983-5a0a-4260-865b-1bb33c769499';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runVerification() {
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const port = 9325;
  const tempDir = 'C:\\Users\\robin\\AppData\\Local\\Temp\\edge_cap_clean_' + Date.now();

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

    // Enable console & runtime error capturing
    const consoleLogs = [];
    const jsErrors = [];
    ws.addEventListener('message', (event) => {
      const data = JSON.parse(event.data);
      if (data.method === 'Runtime.exceptionThrown') {
        jsErrors.push(data.params.exceptionDetails);
      }
      if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') {
        consoleLogs.push(data.params.entry);
      }
    });

    await sendCommand('Runtime.enable');
    await sendCommand('Log.enable');

    // 1. Desktop viewport
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 950,
      deviceScaleFactor: 2,
      mobile: false
    });

    await sleep(3000);

    // Evaluate DOM state
    const evalRes = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const hasLatestLink = !!document.getElementById('latestLink');
        const hasSismoOfficialLink = !!document.getElementById('sismoOfficialLink');
        const externalIgclinks = Array.from(document.querySelectorAll('a[href*="sismosgeociencias.up.ac.pa"]')).map(a => ({
          text: a.textContent.trim(),
          href: a.href,
          parentClass: a.parentElement ? a.parentElement.className : ''
        }));
        const tableFichaBtns = document.querySelectorAll('.table-action-btn').length;
        const tableLinkEls = document.querySelectorAll('.table-link').length;
        const latestRegion = document.getElementById('latestRegion')?.textContent || '';
        const snapshotStatus = document.getElementById('snapshotStatus')?.textContent || '';
        const headerTitle = document.querySelector('.masthead h1')?.textContent || '';
        const footerText = document.getElementById('sourceTimestamp')?.textContent || '';

        return {
          hasLatestLink,
          hasSismoOfficialLink,
          externalIgclinks,
          tableFichaBtns,
          tableLinkEls,
          latestRegion,
          snapshotStatus,
          headerTitle,
          footerText
        };
      })()`,
      returnByValue: true
    });

    console.log('--- DOM EVALUATION RESULTS ---');
    const domVal = evalRes.result?.result?.value || evalRes.result?.value;
    console.log(JSON.stringify(domVal, null, 2));

    // Capture desktop summary (masthead + latest event)
    const capResumen = await sendCommand('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'captura-final-resumen-desktop.png'), Buffer.from(capResumen.result.data, 'base64'));
    console.log('Saved captura-final-resumen-desktop.png');

    // Scroll to Registros (table)
    await sendCommand('Runtime.evaluate', {
      expression: `document.getElementById('registros').scrollIntoView({ behavior: 'instant' });`
    });
    await sleep(800);
    const capTabla = await sendCommand('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'captura-final-tabla-desktop.png'), Buffer.from(capTabla.result.data, 'base64'));
    console.log('Saved captura-final-tabla-desktop.png');

    // Click first Ficha button in the table to open individual view
    await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const firstFichaBtn = document.querySelector('.table-action-btn');
        if (firstFichaBtn) firstFichaBtn.click();
      })()`
    });
    await sleep(2500);

    const fichaEval = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const isFichaVisible = !document.getElementById('sismoView').hidden;
        const hasOfficialLinkInFicha = !!document.getElementById('sismoOfficialLink');
        const sismoRegion = document.getElementById('sismoRegionTitle')?.textContent || '';
        const sismoMag = document.getElementById('sismoMagChip')?.textContent || '';
        const sismoUid = document.getElementById('sismoUidText')?.textContent || '';
        return { isFichaVisible, hasOfficialLinkInFicha, sismoRegion, sismoMag, sismoUid };
      })()`,
      returnByValue: true
    });
    console.log('--- FICHA VIEW EVALUATION ---');
    const fichaVal = fichaEval.result?.result?.value || fichaEval.result?.value;
    console.log(JSON.stringify(fichaVal, null, 2));

    const capFicha = await sendCommand('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'captura-final-ficha-desktop.png'), Buffer.from(capFicha.result.data, 'base64'));
    console.log('Saved captura-final-ficha-desktop.png');

    // Click back to dashboard
    await sendCommand('Runtime.evaluate', {
      expression: `document.getElementById('sismoBackBtn').click();`
    });
    await sleep(800);

    // 2. Mobile Viewport (iPhone 14 / modern compact screen: 390x844)
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true
    });
    await sendCommand('Runtime.evaluate', {
      expression: `window.scrollTo({ top: 0, behavior: 'instant' });`
    });
    await sleep(1500);

    const capMovil = await sendCommand('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'captura-final-movil.png'), Buffer.from(capMovil.result.data, 'base64'));
    console.log('Saved captura-final-movil.png');

    console.log('--- JS ERRORS ENCOUNTERED ---');
    console.log('Exceptions thrown:', jsErrors.length);
    if (jsErrors.length > 0) console.log(jsErrors);
    console.log('Console errors:', consoleLogs.length);
    if (consoleLogs.length > 0) console.log(consoleLogs);

    ws.close();
  } finally {
    edge.kill();
  }
}

runVerification().catch(err => {
  console.error('Execution error:', err);
  process.exit(1);
});
