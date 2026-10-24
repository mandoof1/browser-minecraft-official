// playtest.mjs - drive the real client with real browser input events and
// answer one question per step: did the screen change?
//
// Screenshots are the evidence. Sampling the WebGL canvas with drawImage is not
// usable (no preserveDrawingBuffer, so the copy is the same cleared buffer no
// matter what the game drew), but a screenshot captures the composited page.
//
//   QS="mc=1.2.5" WAIT=60000 CLICKS="427,257,Singleplayer" node tools/playtest.mjs
//
// Coordinates are canvas-relative, which is how Minecraft lays its GUI out: the
// canvas is the framebuffer, so canvas pixels are GUI pixels.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = Number(process.env.PORT || 9210);
const QS = process.env.QS || 'version=1.12.2';
const TAG = process.env.TAG || 'x';
const srv = process.env.EXTERNAL ? null : spawn('python3', ['tools/serve.py'], { env: { ...process.env, PORT } });
if (srv) await sleep(1200);
let browser;
const shot = async (p, n) => {
  fs.mkdirSync('shots', { recursive: true });
  const buf = await p.screenshot({ encoding: 'binary' }).catch(() => null);
  if (!buf) return null;
  fs.writeFileSync(`shots/play-${String(n).padStart(2, '0')}-${TAG}.png`, buf);
  return crypto.createHash('sha1').update(buf).digest('hex');
};
try {
  browser = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true, protocolTimeout: 900000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1200,800'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  const con = [];
  page.on('console', m => { con.push(m.text()); if (con.length > 8000) con.splice(0, 4000); });
  const t0 = Date.now();
  const at = () => Math.round((Date.now() - t0) / 1000);
  await page.goto(`http://127.0.0.1:${PORT}/?${QS}`, { waitUntil: 'domcontentloaded' }).catch(() => {});

  while (Date.now() - t0 < Number(process.env.WINDOW_WAIT || 120000)) {
    if (await page.evaluate(() => document.querySelectorAll('.cjWindow canvas').length > 0).catch(() => false)) break;
    await sleep(3000);
  }
  console.log(`window at t+${at()}s`);

  // Mojang's own splash sits perfectly still for minutes before the menu
  // replaces it, so "the frame changed" is a reliable marker for the menu being
  // up. The baseline has to be taken after the splash settles, not the instant
  // the window appears, or the window-manager animation counts as a change.
  if (process.env.WAIT_FOR_TITLE) {
    const crypto = require('node:crypto');
    let prev = null, repeats = 0, base = null;
    while (Date.now() - t0 < Number(process.env.TITLE_WAIT || 600000)) {
      const buf = await page.screenshot({ encoding: 'binary' }).catch(() => null);
      if (!buf) { await sleep(5000); continue; }
      const h = crypto.createHash('sha1').update(buf).digest('hex');
      repeats = h === prev ? repeats + 1 : 0;
      prev = h;
      if (base === null) {
        if (repeats >= 3) { base = h; console.log(`  splash steady at t+${at()}s`); }
      } else if (h !== base) { console.log(`  title reached at t+${at()}s`); break; }
      await sleep(5000);
    }
  }
  await sleep(Number(process.env.WELCOME_WAIT || 60000));
  console.log(`settled at t+${at()}s`);

  const rect = () => page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')];
    // The game canvas is the biggest one; the window chrome has its own.
    const c = cs.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cw: c.width, ch: c.height };
  });

  let n = 0;
  let before = await shot(page, n++);
  const steps = (process.env.CLICKS || '').split(';').filter(Boolean);
  for (const s of steps) {
    const [xs, ys, label] = s.split(',');
    const b = await rect();
    if (!b) { console.log('no canvas'); break; }
    const x = b.x + Number(xs) * (b.w / b.cw), y = b.y + Number(ys) * (b.h / b.ch);
    console.log(`t+${at()}s click ${label} canvas(${xs},${ys}) -> page(${Math.round(x)},${Math.round(y)}) canvas=${b.cw}x${b.ch}`);
    await page.mouse.move(x, y); await sleep(500);
    await page.mouse.down(); await sleep(150); await page.mouse.up();
    await sleep(Number(process.env.AFTER_CLICK || 4000));
    const after = await shot(page, n++);
    console.log(`   screen ${before === after ? 'UNCHANGED' : 'CHANGED'} after ${label}`);
    before = after;
  }

  // Mouse look: LWJGL reads a relative mouse delta, so a move has to be a
  // sequence of small steps from the middle of the window, not a jump.
  for (const s of (process.env.LOOKS || '').split(';').filter(Boolean)) {
    const [dxs, dys, label] = s.split(',');
    const b = await rect();
    if (!b) { console.log('no canvas'); break; }
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const dx = Number(dxs) * (b.w / b.cw), dy = Number(dys) * (b.h / b.ch);
    console.log(`t+${at()}s look ${label} by ${dx.toFixed(0)},${dy.toFixed(0)} px`);
    await page.mouse.move(cx, cy);
    for (let i = 1; i <= 20; i++) { await page.mouse.move(cx + dx * i / 20, cy + dy * i / 20); await sleep(30); }
    await sleep(Number(process.env.AFTER_LOOK || 3000));
    const after = await shot(page, n++);
    console.log(`   screen ${before === after ? 'UNCHANGED' : 'CHANGED'} after look ${label}`);
    before = after;
  }

  for (const k of (process.env.KEYS || '').split(';').filter(Boolean)) {
    const b = await rect();
    if (b) await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2);
    console.log(`t+${at()}s key ${k}`);
    await page.keyboard.down(k); await sleep(600); await page.keyboard.up(k);
    await sleep(2500);
    const after = await shot(page, n++);
    console.log(`   screen ${before === after ? 'UNCHANGED' : 'CHANGED'} after key ${k}`);
    before = after;
  }
  fs.writeFileSync('/tmp/playtest-console.log', con.join('\n'));
  console.log(`console: /tmp/playtest-console.log (${con.length} lines)`);
} finally { try { await browser?.close(); } catch {} srv && srv.kill(); }
