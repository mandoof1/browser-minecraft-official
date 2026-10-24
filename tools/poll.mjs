// poll.mjs - timeline of "did CheerpJ make a window", for any URL on our server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = process.env.PORT || '8960';
const Q5 = process.env.QS || '';
const srv = process.env.EXTERNAL ? null : spawn('python3', ['tools/serve.py'], { env: { ...process.env, PORT } });
if (srv) await sleep(1200);
const b = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--window-size=1200,800'] });
try {
  const p = await b.newPage();
  await p.setViewport({ width: 1200, height: 800 });
  p.on('console', m => { const t = m.text();
    if (process.env.ALLCONSOLE) console.log('C[' + m.type() + '] ' + t.slice(0, 200));
    else if (/Exception|Error|error|LWJGL|pixel format|Canvas/.test(t) && !/\[bc\]|\[gl/.test(t)) console.log('   C ' + t.slice(0, 150)); });
  p.on('pageerror', e => console.log('PAGEERROR ' + String(e).slice(0, 200)));
  await p.goto(`http://127.0.0.1:${PORT}/?${Q5}`, { waitUntil: 'domcontentloaded' });
  const t0 = Date.now(); let last = '', nextShot = Number(process.env.SHOTS || 30);
  while (Date.now() - t0 < Number(process.env.WATCH || 120000)) {
    const s = await p.evaluate(() => JSON.stringify({
      canvas: [...document.querySelectorAll('canvas')].map(c => c.width + 'x' + c.height + '.' + c.className),
      windows: document.querySelectorAll('.cjWindow').length,
      // The page already samples canvas pixels; frames/changing is the answer
      // to "is Mojang actually drawing into that canvas".
      frames: self.mcTelemetry ? self.mcTelemetry.frames() : null,
      changing: self.mcTelemetry ? self.mcTelemetry.changing() : null,
      status: (document.querySelector('#game') || {}).getAttribute?.('data-status') ?? null })).catch(() => '{}');
    if (s !== last) { console.log(`t+${Math.round((Date.now()-t0)/1000)}s ${s}`); last = s; }
    if (process.env.SHOTS && (Date.now() - t0) / 1000 > nextShot) {
      const n = Math.round((Date.now() - t0) / 1000);
      fs.mkdirSync('shots', { recursive: true });
      await p.screenshot({ path: `shots/soak-${String(n).padStart(3, '0')}.png` });
      nextShot += Number(process.env.SHOTS);
    }
    await sleep(2000);
  }
  fs.mkdirSync('shots', { recursive: true });
  await p.screenshot({ path: 'shots/poll-final.png' });
} finally { await b.close(); srv && srv.kill(); }
