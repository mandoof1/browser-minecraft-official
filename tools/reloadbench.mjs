// reloadbench.mjs - how long does the *second* load take?
//
// A player who comes back should not pay for 1200 asset fetches and a dozen
// jar ranges again. The server now sends ETags and Cache-Control, so the
// question is whether that actually removes the work. This boots the page,
// waits for Mojang's own title screen, reloads in the same tab, waits again,
// and counts the requests the server saw in each phase.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 9710);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EXEC = '/usr/bin/brave';

const acc = path.join(ROOT, 'shots', 'reloadbench-access.log');
fs.mkdirSync(path.dirname(acc), { recursive: true });
const srv = spawn('python3', [path.join(ROOT, 'tools', 'serve.py'), String(PORT)],
  { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
let log = '';
srv.stderr.on('data', d => { log += d; });
for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {} await sleep(250); }

const browser = await puppeteer.launch({
  executablePath: EXEC, headless: 'new', protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--window-size=1200,800', ...(process.env.USERDATA ? ['--user-data-dir=' + process.env.USERDATA] : [])]
});
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 800 });

const rect = async () => page.evaluate(() => {
  const c = document.querySelector('.cjWindow canvas') || document.querySelector('#game canvas');
  if (!c) return null;
  const r = c.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
const luma = async () => {
  const b = await rect();
  if (!b) return -1;
  const buf = await page.screenshot({ encoding: 'binary' }).catch(() => null);
  if (!buf) return -1;
  const py = `
import sys,zlib
from struct import unpack
d=sys.stdin.buffer.read()
# decode the PNG quickly with PIL if present, else fall back to a rough mean of raw bytes
try:
    from PIL import Image
    import io
    im=Image.open(io.BytesIO(d)).convert('RGB')
    x0,y0,x1,y1=%d,%d,%d,%d
    im=im.crop((x0,y0,x1,y1))
    px=im.load()
    tot=0;n=0
    W,H=im.size
    for yy in range(0,H,3):
        for xx in range(0,W,3):
            r,g,b=px[xx,yy]; tot+=(r*3+g*4+b*2)//9; n+=1
    print(tot//max(1,n))
except Exception:
    print(-2)
` % (Math.round(b.x), Math.round(b.y), Math.round(b.x + b.w), Math.round(b.y + b.h));
  try {
    return Number(execFileSync('python3', ['-c', py], { input: Buffer.from(buf), maxBuffer: 1 << 26 }).toString().trim());
  } catch { return -1; }
};

async function waitTitle(label) {
  const t0 = Date.now();
  let hits = 0, v = -1;
  while (Date.now() - t0 < 700000) {
    v = await luma();
    hits = (v >= 10 && v < 200) ? hits + 1 : 0;
    if (hits >= 2) break;
    await sleep(4000);
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  const marks = log.split('\n').filter(l => l.includes('OPEN')).length;
  console.log(`${label}: title in ${secs}s (luma ${v}), requests so far ${marks}`);
  return marks;
}

await page.goto(`http://127.0.0.1:${PORT}/?version=1.12.2`, { waitUntil: 'domcontentloaded' });
const a = await waitTitle('first load ');
await page.reload({ waitUntil: 'domcontentloaded' });
const b = await waitTitle('second load');
console.log(`requests during the second load: ${b - a}`);
await browser.close();
srv.kill();
