// _dom.mjs - what is actually on the page while Mojang runs?
// Canvas count, sizes, and whether their pixels change over time.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = process.env.PORT || '8860';
const srv = spawn('python3', ['tools/serve.py'], { env: { ...process.env, PORT } });
await sleep(1200);
const browser = await puppeteer.launch({
  executablePath: ['/usr/bin/brave', '/usr/bin/chromium'].find(p => fs.existsSync(p)),
  headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1200,800']
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  page.on('console', m => { const t = m.text(); if (/Client thread|Sound Library|Exception|Crash/.test(t)) console.log('J:', t.slice(0, 140)); });
  await page.goto(`http://127.0.0.1:${PORT}/?version=1.12.2&log=1`, { waitUntil: 'domcontentloaded' });
  await sleep(Number(process.env.BOOT || 110000));
  const frames = page.frames().map(f => ({ url: f.url(), name: f.name() }));
  console.log('FRAMES:', JSON.stringify(frames));
  for (const f of page.frames()) {
    try {
      const inner = await f.evaluate(() => [...document.querySelectorAll('canvas')].map(c => ({
        w: c.width, h: c.height, id: c.id, cls: c.className,
        body: document.body ? document.body.innerHTML.slice(0, 120) : null })));
      console.log('FRAME CANVAS', f.url().slice(0, 60), JSON.stringify(inner).slice(0, 400));
    } catch (e) { console.log('FRAME ERR', f.url().slice(0, 60), String(e).slice(0, 90)); }
  }
  const info = await page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')];
    return cs.map(c => {
      const r = c.getBoundingClientRect();
      return { w: c.width, h: c.height, css: [Math.round(r.width), Math.round(r.height)],
        vis: getComputedStyle(c).visibility, id: c.id, cls: c.className, parent: c.parentElement && c.parentElement.id };
    });
  });
  console.log('CANVASES:', JSON.stringify(info, null, 1));
  const sample = async () => page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    try {
      const o = document.createElement('canvas'); o.width = c.width; o.height = c.height;
      o.getContext('2d').drawImage(c, 0, 0);
      const d = o.getContext('2d').getImageData(0, 0, o.width, o.height).data;
      let sum = 0, nonzero = 0;
      for (let i = 0; i < d.length; i += 4) { const v = d[i] + d[i + 1] + d[i + 2]; sum = (sum + v) % 1e9; if (v > 0) nonzero++; }
      return { sum, nonzero, total: d.length / 4 };
    } catch (e) { return { err: String(e).slice(0, 80) }; }
  });
  const a = await sample(); await sleep(2500); const b = await sample();
  console.log('PIXELS a=', JSON.stringify(a), ' b=', JSON.stringify(b), ' changed=', !!(a && b && a.sum !== b.sum));
  const stats = await page.evaluate(() => window.mcTelemetry ? { frames: mcTelemetry.frames(), changing: mcTelemetry.changing(), canvas: mcTelemetry.canvas() } : null);
  console.log('TELEMETRY:', JSON.stringify(stats));
  await page.screenshot({ path: 'shots/dom.png' });
} finally { await browser.close(); srv.kill(); }
