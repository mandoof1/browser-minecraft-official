// Frame rate without Mojang's F3 overlay (which CheerpJ does not deliver: the
// function keys never reach the game). gl4es presents a frame by flushing the
// WebGL context, so counting WebGL entry points from JS gives a real, external
// measurement of what the GPU end is doing. This reports calls per second per
// entry point; the flush/finish line is the frame rate.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = Number(process.env.PORT || 9410);
const QS = process.env.QS || 'version=1.12.2';
const WAIT = Number(process.env.WAIT || 120000);
const srv = spawn('python3', ['tools/serve.py'], { env: { ...process.env, PORT } });

const browser = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1200,800'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  await page.evaluateOnNewDocument(() => {
    const counts = self.__gl = { calls: {}, frames: 0, t0: 0 };
    const wrap = (proto, tag) => {
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name.startsWith('constructor') || name.startsWith('__')) continue;
        const d = Object.getOwnPropertyDescriptor(proto, name);
        if (!d || typeof d.value !== 'function') continue;
        const orig = d.value;
        Object.defineProperty(proto, name, {
          ...d,
          value: function (...a) {
            if (!counts.t0) counts.t0 = performance.now();
            counts.calls[name] = (counts.calls[name] || 0) + 1;
            if (name === 'flush' || name === 'finish') counts.frames++;
            return orig.apply(this, a);
          }
        });
      }
    };
    wrap(WebGLRenderingContext.prototype, 'gl');
    if (self.WebGL2RenderingContext) wrap(WebGL2RenderingContext.prototype, 'gl2');
  });
  await page.goto(`http://127.0.0.1:${PORT}/?${QS}`, { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  let prev = {};
  while (Date.now() - t0 < WAIT) {
    await sleep(5000);
    const s = await page.evaluate(() => {
      const c = self.__gl;
      if (!c) return null;
      const el = (performance.now() - c.t0) / 1000;
      const top = Object.entries(c.calls).sort((a, b) => b[1] - a[1]).slice(0, 6)
        .map(([k, v]) => `${k}=${(v / el).toFixed(1)}/s`);
      return { el, frames: c.frames, fps: (c.frames / el).toFixed(1), top };
    });
    if (s) console.log(`t+${((Date.now() - t0) / 1000) | 0}s frames=${s.frames} fps=${s.fps} ${s.top.join(' ')}`);
  }
  await page.screenshot({ path: 'shots/fps.png' });
} finally { await browser.close(); srv.kill(); }
