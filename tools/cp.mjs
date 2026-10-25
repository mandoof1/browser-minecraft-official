// cp.mjs - does the canvas appear for a given classpath drop-set?
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = process.env.PORT || '8970';
const DROP = process.env.DROP || '';
const ADD = process.env.ADD || '';
const FULL = process.env.FULL || '';
const srv = spawn('python3', ['tools/serve.py'], { env: { ...process.env, PORT } });
await sleep(1200);
const b = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--window-size=1200,800'] });
let canvas = 0, windows = 0, last = '';
try {
  const p = await b.newPage();
  await p.setViewport({ width: 1200, height: 800 });
  const q = ['mc=1.2.5'];
  if (FULL) q.push('full=1');
  if (DROP) q.push('cpdrop=' + DROP);
  if (ADD) q.push('cpadd=' + ADD);
  await p.goto(`http://127.0.0.1:${PORT}/?${q.join('&')}`, { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  while (Date.now() - t0 < Number(process.env.WATCH || 55000)) {
    const s = await p.evaluate(() => ({
      canvas: document.querySelectorAll('canvas').length,
      windows: document.querySelectorAll('.cjWindow').length })).catch(() => ({canvas:0,windows:0}));
    canvas = Math.max(canvas, s.canvas); windows = Math.max(windows, s.windows);
    const sig = 'canvas=' + s.canvas + ' windows=' + s.windows;
    if (sig !== last) { console.log(`  t+${Math.round((Date.now()-t0)/1000)}s ${sig}`); last = sig; }
    await sleep(2000);
  }
} finally { await b.close(); srv.kill(); }
console.log(`ADD[${ADD || 'none'}] DROP[${DROP || 'none'}] FULL[${FULL || 'no'}] canvas=${canvas} windows=${windows}`);
