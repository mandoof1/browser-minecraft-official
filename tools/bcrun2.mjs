// bcrun2.mjs - run the Browsercraft-faithful control page on OUR hosting.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = process.env.PORT || '8908';
const srv = spawn('python3', ['tools/serve.py'], { env: { ...process.env, PORT } });
await sleep(1200);
const b = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--window-size=1200,800'] });
try {
  const p = await b.newPage();
  await p.setViewport({ width: 1200, height: 800 });
  const logs = [];
  p.on('console', m => { const t = m.text(); if (/\[bc\]|Minecraft|LWJGL|Canvas|canvas|Exception|Error/.test(t)) logs.push(t.slice(0,160)); });
  p.on('pageerror', e => logs.push('PAGEERROR ' + String(e).slice(0, 160)));
  await p.goto(`http://127.0.0.1:${PORT}/bc.html`, { waitUntil: 'domcontentloaded' });
  const t0 = Date.now(); let last = '';
  while (Date.now() - t0 < Number(process.env.BOOT || 150000)) {
    const s = await p.evaluate(() => JSON.stringify({
      canvas: [...document.querySelectorAll('canvas')].map(c => c.width + 'x' + c.height + '.' + c.className),
      windows: document.querySelectorAll('.cjWindow').length,
      status: (document.querySelector('#bcDisplay') || {}).getAttribute?.('data-status') ?? null,
      hud: (document.querySelector('#hud') || {}).textContent })).catch(() => '{}');
    if (s !== last) { console.log(`t+${Math.round((Date.now()-t0)/1000)}s ${s}`); last = s; }
    await sleep(2000);
  }
  fs.mkdirSync('shots', { recursive: true });
  await p.screenshot({ path: 'shots/bc-control.png' });
  console.log('LOGS:'); logs.slice(-14).forEach(l => console.log('  ' + l));
} finally { await b.close(); srv.kill(); }
