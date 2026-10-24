// livecheck.mjs - is the deployed port actually running Mojang's client?
//
// Checks the three things a static host gets wrong (isolation headers, Range
// clamping, the version it is serving) and then boots the live URL in a real
// browser and waits for the unmodified client's own log line.
//
//   node tools/livecheck.mjs https://browser-minecraft-official.onrender.com
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const BASE = (process.argv[2] || 'https://browser-minecraft-official.onrender.com').replace(/\/$/, '');
const VER = process.argv[3] || '1.12.2';
const WAIT = Number(process.env.WAIT || 180000);
const EXEC = ['/usr/bin/brave', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const say = (...a) => console.log(...a);
let bad = 0;
const check = (ok, what, detail) => { say(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  ' + detail : ''}`); if (!ok) bad++; };

// 1. what is it running?
const health = await (await fetch(`${BASE}/health`)).json().catch(() => null);
check(health && health.ok, 'health ok', health ? JSON.stringify(health.vanilla?.[VER] || health).slice(0, 160) : 'no json');
check(health?.vanilla?.[VER]?.clientSha1 === '0f275bc1547d01fa5f56ba34bdc87d981ee12daf', 'serving Mojang 1.12.2 by sha1', health?.vanilla?.[VER]?.clientSha1);

// 2. headers, exactly once
const res = await fetch(`${BASE}/`);
const raw = res.headers.getSetHeader ? res.headers.getSetHeader() : [...res.headers.entries()];
const count = (n) => raw.filter(([k]) => k.toLowerCase() === n).length;
check(count('cross-origin-opener-policy') === 1, 'COOP sent exactly once', String(count('cross-origin-opener-policy')));
check(res.headers.get('cross-origin-opener-policy') === 'same-origin', 'COOP value', res.headers.get('cross-origin-opener-policy'));
// COEP must be absent, not merely once: a duplicated COEP is joined into the
// invalid value "require-corp, require-corp", which silently disables isolation
// - and that is exactly what made the port work while it looked broken.
check(count('cross-origin-embedder-policy') === 0, 'COEP absent (CheerpJ needs its OS iframe unblocked)', String(count('cross-origin-embedder-policy')));

// 3. Range: CheerpJ over-requests a 128 KiB window for small files; the server
// must clamp what it advertises, not just what it sends.
const obj = '5f/5ff04807c356f1beed0b86ccf659b44b9983e3fa'; // icon_16x16.png, 781 bytes
const r = await fetch(`${BASE}/data/vanilla/${VER}/assets/objects/${obj}`, { headers: { Range: 'bytes=0-131071' } });
const body = Buffer.from(await r.arrayBuffer());
check(r.status === 206, 'Range -> 206', String(r.status));
check(body.length === 781, 'body is the whole small file', `${body.length} bytes`);
check(Number(r.headers.get('content-length')) === body.length, 'content-length matches bytes sent', r.headers.get('content-length'));
check(r.headers.get('content-range') === 'bytes 0-780/781', 'content-range clamped', r.headers.get('content-range'));

// 4. boot the live page and wait for Mojang's own log
const browser = await puppeteer.launch({
  executablePath: EXEC, headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1200,800']
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  const lines = [];
  page.on('console', m => lines.push(m.text()));
  const t0 = Date.now();
  say(`booting ${BASE}/?version=${VER}`);
  await page.goto(`${BASE}/?version=${VER}`, { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
  const want = /Setting user:|LWJGL Version:|Reloading ResourceManager/;
  let hit = null;
  while (Date.now() - t0 < WAIT && !hit) {
    hit = lines.find(l => want.test(l));
    if (!hit) await sleep(1000);
  }
  check(!!hit, 'unmodified client logged its own line', hit ? hit.slice(0, 120) : `nothing within ${WAIT}ms`);
  const phases = await page.evaluate(() => (window.mcBoot ? mcBoot.phases() : {})).catch(() => ({}));
  say('     phases:', JSON.stringify(phases));
  const isolated = await page.evaluate(() => self.crossOriginIsolated).catch(() => null);
  check(isolated === false, 'page not cross-origin isolated (deliberate, see serve.py)', String(isolated));
  fs.mkdirSync(path.join(process.cwd(), 'shots'), { recursive: true });
  await page.screenshot({ path: path.join(process.cwd(), 'shots', 'live.png') });
  say('     shot: shots/live.png');
} finally {
  await browser.close();
}
process.exitCode = bad ? 1 : 0;
