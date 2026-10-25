// totitle.mjs - time from page load to the frame changing away from the Mojang
// splash. Used to A/B a startup change: QS=cee=0 vs QS= selects the two patched
// client jars. Run both at once and the comparison is under equal load.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = process.env.PORT || '9190';
const QS = process.env.QS || '';
const LABEL = process.env.LABEL || 'x';
const srv = process.env.EXTERNAL ? null : spawn('python3', ['tools/serve.py'], { env: { ...process.env, PORT } });
if (srv) await sleep(1200);
let out = { label: LABEL, qs: QS };
let b;
try {
  b = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true, protocolTimeout: 900000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1200,800'] });
  const p = await b.newPage();
  await p.setViewport({ width: 1200, height: 800 });
  const t0 = Date.now();
  await p.goto(`http://127.0.0.1:${PORT}/?${QS}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  const at = () => Math.round((Date.now() - t0) / 1000);
  let win = null;
  while (Date.now() - t0 < Number(process.env.WAIT || 480000)) {
    if (await p.evaluate(() => document.querySelectorAll('.cjWindow canvas').length > 0).catch(() => false)) { win = at(); break; }
    await sleep(3000);
  }
  out.windowAt = win;
  console.log(`${LABEL} window at t+${win}s`);
  let prev = null, repeats = 0, base = null;
  while (Date.now() - t0 < Number(process.env.WAIT || 480000)) {
    const buf = await p.screenshot({ encoding: 'binary' }).catch(() => null);
    if (!buf) { await sleep(5000); continue; }
    const h = crypto.createHash('sha1').update(buf).digest('hex');
    if (h === prev) repeats++; else repeats = 0;
    prev = h;
    if (base === null) { if (repeats >= 3) { base = h; console.log(`${LABEL} splash steady at t+${at()}s`); } }
    else if (h !== base) { out.titleAt = at(); console.log(`${LABEL} TITLE at t+${at()}s`); break; }
    await sleep(5000);
  }
  fs.mkdirSync('shots', { recursive: true });
  await p.screenshot({ path: `shots/title-${LABEL}.png` });
} finally { await b.close(); srv && srv.kill(); }
console.log(JSON.stringify(out));
