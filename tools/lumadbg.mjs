// Why does the sampled game area come back black? Dump every canvas with its
// box and backing size, screenshot the page, and report the mean luminance of
// each canvas' box.
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = Number(process.env.PORT || 9290);
const QS = process.env.QS || 'version=1.12.2';
const srv = spawn('python3', ['tools/serve.py'], { env: { ...process.env, PORT } });

const PY = `import sys
from PIL import Image
im = Image.open(sys.stdin.buffer).convert("RGB")
x0, y0, x1, y1 = [int(v) for v in sys.argv[1:5]]
px = im.load()
tot = 0; n = 0
for y in range(y0, min(y1, im.height)):
    for x in range(x0, min(x1, im.width)):
        r, g, b = px[x, y]
        tot += (r * 3 + g * 4 + b * 2) // 9; n += 1
print(tot // max(1, n))
`;

const browser = await puppeteer.launch({ headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--window-size=1200,800'],
  executablePath: '/usr/bin/brave' });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  await page.goto(`http://127.0.0.1:${PORT}/?${QS}`, { waitUntil: 'domcontentloaded' });
  await sleep(Number(process.env.WAIT || 90000));
  const info = await page.evaluate(() => [...document.querySelectorAll('canvas')].map(c => {
    const r = c.getBoundingClientRect();
    return { cw: c.width, ch: c.height, cls: c.className, x: Math.round(r.x), y: Math.round(r.y),
      w: Math.round(r.width), h: Math.round(r.height),
      parent: (c.parentElement && c.parentElement.className) || '' };
  }));
  console.log(JSON.stringify(info, null, 1));
  const buf = await page.screenshot({ encoding: 'binary' });
  require('node:fs').writeFileSync('shots/lumadbg.png', buf);
  for (const c of info) {
    const v = execFileSync('python3', ['-c', PY, String(c.x), String(c.y), String(c.x + c.w), String(c.y + c.h)],
      { input: Buffer.from(buf), maxBuffer: 1 << 26 }).toString().trim();
    console.log(`canvas ${c.cw}x${c.ch} box=${c.x},${c.y},${c.w}x${c.h} cls=${c.cls} luma=${v}`);
  }
  const all = execFileSync('python3', ['-c', PY, '0', '0', '1200', '800'],
    { input: Buffer.from(buf), maxBuffer: 1 << 26 }).toString().trim();
  console.log('whole page luma', all);
} finally { await browser.close(); srv.kill(); }
