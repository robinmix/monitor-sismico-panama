const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ARTIFACT_DIR = 'C:\\Users\\robin\\.gemini\\antigravity\\brain\\5133a983-5a0a-4260-865b-1bb33c769499';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function testMobileDot() {
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const port = 9330;
  const tempDir = 'C:\\Users\\robin\\AppData\\Local\\Temp\\edge_cap_dot_' + Date.now();

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

    // Emulate 375x812 (standard iPhone / Samsung mobile screen)
    await sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 3,
      mobile: true
    });

    await sleep(2500);

    const checkRes = await sendCommand('Runtime.evaluate', {
      expression: `(() => {
        const statusEl = document.getElementById('sourceStatus');
        const textEl = statusEl ? statusEl.querySelector('.status-text') : null;
        const textVisible = textEl ? window.getComputedStyle(textEl).display !== 'none' : false;
        const pillWidth = statusEl ? statusEl.getBoundingClientRect().width : 0;
        const pillHeight = statusEl ? statusEl.getBoundingClientRect().height : 0;
        const docScrollWidth = document.documentElement.scrollWidth;
        const docClientWidth = document.documentElement.clientWidth;
        const hasHorizontalScroll = docScrollWidth > docClientWidth;

        return {
          pillClass: statusEl ? statusEl.className : '',
          pillWidth,
          pillHeight,
          textVisible,
          docScrollWidth,
          docClientWidth,
          hasHorizontalScroll
        };
      })()`,
      returnByValue: true
    });

    console.log('--- MOBILE CHECK RESULT ---');
    console.log(JSON.stringify(checkRes.result?.result?.value || checkRes.result?.value, null, 2));

    const cap = await sendCommand('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'captura-movil-punto-verde.png'), Buffer.from(cap.result.data, 'base64'));
    console.log('Saved captura-movil-punto-verde.png');

    ws.close();
  } finally {
    edge.kill();
  }
}

testMobileDot().catch(err => {
  console.error(err);
  process.exit(1);
});
