// glwatch.mjs - watch the DOM while GlProbe3 walks Minecraft's display calls.
// Prints a timeline: which probe step was reached, and whether a canvas/window
// existed at that moment. That names the call CheerpJ needs to realize a window.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = process.env.PORT || '8901';
const srv = spawn('python3', ['tools/serve.py'], { env: { ...process.env, PORT } });
await sleep(1200);
const b = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--window-size=1200,800'] });
try {
  const p = await b.newPage();
  await p.setViewport({ width: 1200, height: 800 });
  let lastStep = '';
  const seen = new Set();
  p.on('console', m => {
    const t = m.text();
    if (/\[gl3\] STEP-(BEGIN|END) [a-z]/i.test(t) || /\[gl3\]/.test(t)) {
      const mm = t.match(/\[gl3\] (STEP-(?:BEGIN|END) .*)/);
      if (mm) { lastStep = mm[1]; if (!/PAUSE/.test(t)) console.log(`t+${Math.round((Date.now() - t0) / 1000)}s ${mm[1]}`.slice(0, 150)); }
      else console.log('   ' + t.slice(0, 160));
    }
  });
  await p.goto(`http://127.0.0.1:${PORT}/?probe=gl3&log=1`, { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  let lastSig = '';
  while (Date.now() - t0 < Number(process.env.WATCH || 150000)) {
    const sig = await p.evaluate(() => {
      const c = [...document.querySelectorAll('canvas')].map(x => x.width + 'x' + x.height + '.' + x.className);
      const w = [...document.querySelectorAll('.cjWindow')].length;
      const d = document.querySelector('#cheerpjDisplay');
      return JSON.stringify({ canvas: c, windows: w, status: d && d.getAttribute('data-status'),
        cls: d && d.className, kids: d ? [...d.children].map(e => e.tagName + (e.className ? '.' + e.className : '')) : [] });
    }).catch(() => '{}');
    if (sig !== lastSig) { console.log(`t+${Math.round((Date.now() - t0) / 1000)}s after[${lastStep.slice(0, 40)}] ${sig}`); lastSig = sig; }
    await sleep(1500);
  }
} finally { await b.close(); srv.kill(); }
