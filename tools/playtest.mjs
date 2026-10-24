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
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1200,800',
    ...(process.env.USERDATA ? ['--user-data-dir=' + process.env.USERDATA] : [])] });
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
    if (!QUIET.test(t)) console.log(`   C ${t.slice(0, 1200)}`);
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

  // One action per ';' entry: click:x,y | key:KeyE | look:dx,dy | sleep:1200 |
  // quit. Every action that changes the frame is followed by a screenshot and
  // a luminance reading, which is how "the game responded" is shown rather than
  // assumed. The old CLICKS/LOOKS/KEYS variables still work.
  const doClick = async (xs, ys, label) => {
    const b = await rect();
    if (!b) { console.log('no canvas'); return; }
    const x = b.x + Number(xs) * (b.w / b.cw), y = b.y + Number(ys) * (b.h / b.ch);
    await page.mouse.move(x, y); await sleep(500);
    await page.mouse.down(); await sleep(150); await page.mouse.up();
    await sleep(Number(process.env.AFTER_CLICK || 4000));
  };
  const doLook = async (dxs, dys) => {
    const b = await rect();
    if (!b) return;
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const dx = Number(dxs) * (b.w / b.cw), dy = Number(dys) * (b.h / b.ch);
    await page.mouse.move(cx, cy);
    for (let i = 1; i <= 20; i++) { await page.mouse.move(cx + dx * i / 20, cy + dy * i / 20); await sleep(30); }
    await sleep(Number(process.env.AFTER_LOOK || 3000));
  };
  const doKey = async (k) => {
    const b = await rect();
    if (b) await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2);
    if (k.startsWith('press:')) {
      try { await page.keyboard.press(k.slice(6)); } catch (e) { console.log(`   (key ${k} not accepted: ${e.message.slice(0, 60)})`); }
      await sleep(2500); return;
    }
    await page.keyboard.down(k); await sleep(600); await page.keyboard.up(k);
    await sleep(2500);
  };

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

  // World generation under an interpreted JVM outlasts any fixed sleep, and
  // the loading screen is a dark dirt pan while a loaded world is sky and
  // terrain, so luminance is the marker again.
  // Luminance alone is not enough here: the main menu's panorama is as bright
  // as a loaded world, which made the old check fire while terrain was still
  // being generated. Mojang's own log line is the marker - the integrated
  // server sets the view distance once the spawn area is ready.
  if (process.env.WORLD_WAIT) {
    const want = /Changing view distance to|Preparing spawn area: 100/;
    const w0 = Date.now();
    let hit = null;
    while (Date.now() - w0 < Number(process.env.WORLD_WAIT)) {
      hit = con.find(l => want.test(l));
      if (hit) break;
      await sleep(3000);
    }
    if (hit) console.log(`  world loaded at t+${at()}s: ${hit.slice(0, 90)}`);
    else console.log(`  no world-load log line within ${process.env.WORLD_WAIT}ms`);
    await sleep(8000);
    await shot(page, n++);
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
  if (process.env.ACTIONS) {
    let m = 0;
    let prev = await shot(page, m++);
    for (const a of process.env.ACTIONS.split(';').filter(Boolean)) {
      const [kind, ...rest] = a.split(':');
      const arg = rest.join(':');
      if (kind === 'click') { const [x, y, label] = arg.split(','); console.log(`t+${at()}s click ${label || arg} canvas(${x},${y})`); await doClick(x, y, label); }
      else if (kind === 'key') { console.log(`t+${at()}s key ${arg}`); await doKey(arg); }
      else if (kind === 'look') { const [dx, dy] = arg.split(','); console.log(`t+${at()}s look ${arg}`); await doLook(dx, dy); }
      else if (kind === 'sleep') { console.log(`t+${at()}s sleep ${arg}ms`); await sleep(Number(arg)); }
      else if (kind === 'waitluma') {
        // The client's own loading screen outlasts the integrated server's
        // "world loaded" line, so the usable marker is the frame going bright:
        // sky and terrain, not the dark dirt pan.
        const target = Number(arg);
        const w0 = Date.now();
        let v = 0;
        while (Date.now() - w0 < 120000) {
          v = await brightness(page);
          if (v >= target) break;
          await sleep(4000);
        }
        console.log(`t+${at()}s waitluma ${target} -> ${v}`);
      }
      else if (kind === 'closewin') {
        // CheerpJ draws a window manager close box in the title bar. Closing the
        // AWT frame is what makes Display.isCloseRequested() true, which is how
        // Minecraft exits normally - and a normal exit is what lets the launcher
        // print the game directory afterwards.
        const b = await rect();
        if (b && b.w > 100 && b.h > 100) {
          const x = b.x + b.w - 8, y = b.y + 10;
          console.log(`t+${at()}s closewin -> page(${Math.round(x)},${Math.round(y)})`);
          await page.mouse.move(x, y); await sleep(400);
          await page.mouse.down(); await sleep(150); await page.mouse.up();
        }
      }
      else if (kind === 'clickfrac') {
        // fraction of the canvas box, for things that are not buttons (the
        // world-list row) and that move when the window is a different size
        const [fx, fy] = arg.split(',').map(Number);
        const b = await rect();
        if (b) {
          const x = b.x + fx * b.w, y = b.y + fy * b.h;
          console.log(`t+${at()}s clickfrac ${arg} -> page(${Math.round(x)},${Math.round(y)}) canvas=${b.w}x${b.h}`);
          await page.mouse.move(x, y); await sleep(400);
          await page.mouse.down(); await sleep(150); await page.mouse.up();
          await sleep(Number(process.env.AFTER_CLICK || 4000));
        }
      }
      else if (kind === 'clickbtn') {
        // Mojang's buttons are found by colour, not by remembered coordinates:
        // the CheerpJ window is not the same height in every run, and a y that
        // worked in one run lands on Delete in the next.
        const idx = Number(arg);
        const buf = await page.screenshot({ encoding: 'binary' });
        fs.writeFileSync('/tmp/_btn.png', buf);
        const lines = execFileSync('python3', ['tools/findbuttons.py', '/tmp/_btn.png']).toString().trim().split('\n').filter(Boolean);
        const parts = (lines[idx] || '').split(' ').map(Number);
        if (!parts.length || isNaN(parts[0])) { console.log(`   no button #${idx} (found ${lines.length})`); }
        else {
          console.log(`t+${at()}s clickbtn #${idx} page(${parts[0]},${parts[1]}) of ${lines[idx]} [${lines.length} buttons]`);
          await page.mouse.move(parts[0], parts[1]); await sleep(400);
          await page.mouse.down(); await sleep(150); await page.mouse.up();
          await sleep(Number(process.env.AFTER_CLICK || 4000));
        }
      }
      else { console.log(`unknown action ${a}`); continue; }
      const now = await shot(page, m++);
      console.log(`   screen ${prev === now ? 'UNCHANGED' : 'CHANGED'} after ${a}, luma ${await brightness(page)}`);
      prev = now;
    }
  }

  fs.writeFileSync('/tmp/playtest-console.log', con.join('\n'));
  console.log(`console: /tmp/playtest-console.log (${con.length} lines)`);
} finally { try { await browser?.close(); } catch {} srv && srv.kill(); }
