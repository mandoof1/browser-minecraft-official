// playtest.mjs - drive the real client with real browser input events.
//
// The title screen is drawn, so the question is whether CheerpJ's DOM -> AWT ->
// LWJGL input path reaches Mojang. Each step screenshots, because the only
// honest evidence that a click landed is the screen changing.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = Number(process.env.PORT || 9130);
const server = spawn('python3', ['tools/serve.py'], { env: { ...process.env, PORT } });
const shot = async (p, n) => {
  fs.mkdirSync('shots', { recursive: true });
  await p.screenshot({ path: `shots/play-${String(n).padStart(2, '0')}-${process.env.TAG || 'x'}.png` });
  console.log(`  shot play-${String(n).padStart(2, '0')}-${process.env.TAG || 'x'}.png`);
};
let browser;
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {} await sleep(250); }
  browser = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true, protocolTimeout: 900000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1200,800'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  const con = [];
  page.on('console', m => { con.push(m.text()); if (con.length > 8000) con.splice(0, 4000); });
  await page.goto(`http://127.0.0.1:${PORT}/?version=1.12.2`, { waitUntil: 'domcontentloaded' }).catch(() => {});

  // Wait for the game to draw something other than the Mojang splash. The
  // splash is drawn long before the menu, so "non-black" is not enough: the
  // signal is the frame *changing* away from the first stable frame.
  const WAIT = Number(process.env.TITLE_WAIT || 480000);
  console.log('waiting for the title screen (up to ' + (WAIT / 1000) + 's)');
  const t0 = Date.now();
  const sample = () => page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')];
    const c = cs[cs.length - 1];
    if (!c) return null;
    const off = document.createElement('canvas');
    off.width = off.height = 48;
    const g = off.getContext('2d');
    g.drawImage(c, 0, 0, 48, 48);
    const d = g.getImageData(0, 0, 48, 48).data;
    let h = 0, nonBlack = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] + d[i + 1] + d[i + 2] > 60) nonBlack++;
      h = (h * 31 + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7) | 0;
    }
    return { h, nonBlack };
  }).catch(() => null);

  let base = null, stable = 0, ready = false;
  while (Date.now() - t0 < WAIT) {
    const st = sample();
    if (st && st.nonBlack > 200) {
      if (base === null) { base = st.h; stable = 1; }
      else if (st.h !== base) { console.log(`  frame changed at t+${Math.round((Date.now() - t0) / 1000)}s`); ready = true; break; }
      else if (++stable > 6) { base = st.h; }
    }
    await sleep(4000);
  }
  console.log(ready ? 'title screen reached' : 'NO frame change within the wait');
  await sleep(6000);
  await shot(page, 0);

  // Click helper: canvas-relative coordinates, which is how Minecraft lays out
  // its GUI (the canvas is the framebuffer, 1:1 with GUI coordinates at scale 1).
  const click = async (x, y, label) => {
    const box = await page.evaluate(() => {
      const cs = [...document.querySelectorAll('canvas')];
      const c = cs[cs.length - 1];
      const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, cw: c.width, ch: c.height };
    });
    const sx = box.w / box.cw, sy = box.h / box.ch;
    console.log(`click ${label} at canvas(${x},${y}) -> page(${Math.round(box.x + x * sx)},${Math.round(box.y + y * sy)}) box=${box.cw}x${box.ch}`);
    await page.mouse.move(box.x + x * sx, box.y + y * sy);
    await sleep(400);
    await page.mouse.down(); await sleep(120); await page.mouse.up();
    await sleep(2500);
  };

  const key = async (k, label) => {
    console.log(`key ${label || k}`);
    await page.keyboard.down(k); await sleep(300); await page.keyboard.up(k);
    await sleep(1500);
  };

  const steps = (process.env.STEPS || 'single,newworld,confirm').split(',');
  let n = 1;
  for (const s of steps) {
    if (s === 'single') await click(427, 257, 'Singleplayer');
    if (s === 'newworld') await click(427, 440, 'Create New World');
    if (s === 'confirm') await click(427, 340, 'Create New World (confirm)');
    if (s === 'done') await click(427, 440, 'Done');
    if (s === 'w') await key('KeyW', 'walk forward');
    if (s === 'look') { const b = await page.evaluate(() => { const cs = [...document.querySelectorAll('canvas')]; const c = cs[cs.length - 1]; const r = c.getBoundingClientRect(); return r; });
      await page.mouse.move(b.x + 400, b.y + 240); await page.mouse.down(); await sleep(200); await page.mouse.up();
      await page.mouse.move(b.x + 520, b.y + 260, { steps: 8 }); await sleep(1500); console.log('look'); }
    if (s === 'mine') { await page.mouse.down(); await sleep(1200); await page.mouse.up(); console.log('mine'); await sleep(2000); }
    await shot(page, n++);
  }
  fs.writeFileSync('/tmp/playtest-console.log', con.join('\n'));
  console.log('console written to /tmp/playtest-console.log (' + con.length + ' lines)');
} finally { try { await browser?.close(); } catch {} server.kill('SIGTERM'); }
