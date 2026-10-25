// gl4.mjs - one display-variant per run; report whether CheerpJ made a window.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = process.env.PORT || '8920';
const VARIANT = process.env.VARIANT || 'minimal';
const LWJGL = process.env.LWJGLMODE || '';
const srv = spawn('python3', ['tools/serve.py'], { env: { ...process.env, PORT } });
await sleep(1200);
const b = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--window-size=1200,800'] });
let made = false;
try {
  const p = await b.newPage();
  await p.setViewport({ width: 1200, height: 800 });
  const marks = [];
  p.on('console', m => { const t = m.text(); if (/\[gl4\]/.test(t)) { marks.push(t.slice(0, 120)); console.log('   ' + t.slice(0, 140)); } });
  await p.goto(`http://127.0.0.1:${PORT}/?probe=gl4&variant=${VARIANT}${LWJGL ? '&lwjgl=' + LWJGL : ''}`, { waitUntil: 'domcontentloaded' });
  const t0 = Date.now(); let last = '';
  while (Date.now() - t0 < Number(process.env.WATCH || 90000)) {
    const s = await p.evaluate(() => JSON.stringify({
      canvas: [...document.querySelectorAll('canvas')].map(c => c.width + 'x' + c.height + '.' + c.className),
      windows: document.querySelectorAll('.cjWindow').length })).catch(() => '{}');
    if (s !== last) { console.log(`${VARIANT} t+${Math.round((Date.now()-t0)/1000)}s ${s}`); last = s; if (JSON.parse(s).windows > 0) made = true; }
    await sleep(1500);
  }
  console.log(`${VARIANT} java: ${marks.filter(m => /OK|FAILED|DONE/.test(m)).join(' | ').slice(0, 300)}`);
} finally { await b.close(); srv.kill(); }
console.log(`${VARIANT} RESULT window=${made}`);
