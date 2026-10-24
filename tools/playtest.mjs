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
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = Number(process.env.PORT || 9210);
const QS = process.env.QS || 'version=1.12.2';
const TAG = process.env.TAG || 'x';
const srv = process.env.EXTERNAL ? null : spawn('python3', ['tools/serve.py'], { env: { ...process.env, PORT } });
// The request log is how you tell a slow boot from a stuck one, so it has to
// reach this process' output instead of sitting in an unread pipe.
if (srv) { srv.stderr.on('data', d => process.stderr.write(d)); srv.stdout.on('data', d => process.stderr.write(d)); }
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
  // Echo the Java-side log live: a run that is slow and a run that is stuck
  // look identical from screenshots alone, and the client's own timestamps are
  // the only cheap way to tell them apart.
  const QUIET = /^(LIBGL|TODO|\s*$)/;
  page.on('console', m => {
    const t = m.text();
    con.push(t);
    if (con.length > 8000) con.splice(0, 4000);
    if (!QUIET.test(t)) console.log(`   C ${t.slice(0, 150)}`);
  });
  const t0 = Date.now();
  const at = () => Math.round((Date.now() - t0) / 1000);
  await page.goto(`http://127.0.0.1:${PORT}/?${QS}`, { waitUntil: 'domcontentloaded' }).catch(() => {});

  while (Date.now() - t0 < Number(process.env.WINDOW_WAIT || 120000)) {
    if (await page.evaluate(() => document.querySelectorAll('.cjWindow canvas').length > 0).catch(() => false)) break;
    await sleep(3000);
  }
  console.log(`window at t+${at()}s`);

  const rect = () => page.evaluate(() => {
    const cs = [...document.querySelectorAll('canvas')];
    // The game canvas is the biggest one; the window chrome has its own.
    const c = cs.sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, cw: c.width, ch: c.height };
  });

  // Mojang's own loading screen is a white background with the logo on it and
  // its main menu is near-black, so the mean luminance of the game area is a
  // far steadier marker than a screenshot hash (the hash also moves on its own
  // when the compositor repaints, and does not move at all if the canvas is
  // captured blank). The 20 px CheerpJ title bar is excluded.
  // page.screenshot({clip}) takes a different capture path that comes back all
  // black over a WebGL canvas, so the crop happens in Python instead.
  const PY_LUMA = `import sys
from PIL import Image
im = Image.open(sys.stdin.buffer).convert("RGB")
x0, y0, x1, y1 = [int(v) for v in sys.argv[1:5]]
px = im.load()
tot = 0; n = 0
for y in range(y0 + 21, min(y1, im.height), 3):
    for x in range(x0, min(x1, im.width), 3):
        r, g, b = px[x, y]
        tot += (r * 3 + g * 4 + b * 2) // 9; n += 1
print(tot // max(1, n))
`;
  const brightness = async (p) => {
    const b = await rect();
    if (!b) return -1;
    const buf = await p.screenshot({ encoding: 'binary' }).catch(() => null);
    if (!buf) return -1;
    try {
      return Number(execFileSync('python3', ['-c', PY_LUMA, String(Math.round(b.x)),
        String(Math.round(b.y)), String(Math.round(b.x + b.w)), String(Math.round(b.y + b.h))],
        { input: Buffer.from(buf), maxBuffer: 1 << 26 }).toString().trim());
    } catch { return -1; }
  };

  // Mojang's loading screen is a white page with the logo on it, so "the game
  // area is no longer white" is the marker for the menu. Zero is excluded: the
  // canvas reads black before the client has drawn its first frame.
  if (process.env.WAIT_FOR_TITLE) {
    let bright = -1, hits = 0;
    while (Date.now() - t0 < Number(process.env.TITLE_WAIT || 600000)) {
      bright = await brightness(page);
      hits = (bright >= 10 && bright < 200) ? hits + 1 : 0;
      if (hits >= 2) { console.log(`  title reached at t+${at()}s (luma ${bright})`); break; }
      await sleep(4000);
    }
    console.log(`  luma now ${bright}`);
  }
  await sleep(Number(process.env.WELCOME_WAIT || 60000));
  console.log(`settled at t+${at()}s`);

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
    console.log(`   screen ${before === after ? 'UNCHANGED' : 'CHANGED'} after ${label}, luma ${await brightness(page)}`);
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
    console.log(`   screen ${before === after ? 'UNCHANGED' : 'CHANGED'} after look ${label}, luma ${await brightness(page)}`);
    before = after;
  }

  for (const k of (process.env.KEYS || '').split(';').filter(Boolean)) {
    const b = await rect();
    if (b) await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2);
    console.log(`t+${at()}s key ${k}`);
    await page.keyboard.down(k); await sleep(600); await page.keyboard.up(k);
    await sleep(2500);
    const after = await shot(page, n++);
    console.log(`   screen ${before === after ? 'UNCHANGED' : 'CHANGED'} after key ${k}, luma ${await brightness(page)}`);
    before = after;
  }
  fs.writeFileSync('/tmp/playtest-console.log', con.join('\n'));
  console.log(`console: /tmp/playtest-console.log (${con.length} lines)`);
} finally { try { await browser?.close(); } catch {} srv && srv.kill(); }
