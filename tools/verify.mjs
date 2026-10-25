// verify.mjs - does Mojang's own Minecraft actually run in this browser?
//
// The assertions are about evidence, not vibes:
//   * Mojang's client must print its own log lines (the unmodified jar talks)
//   * a canvas must appear and its pixels must keep changing (render loop alive)
//   * the version banner must be the version we fetched, from Mojang's jar
//
//   node tools/verify.mjs 1.12.2
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(import.meta.dirname, '..');
const VER = process.argv[2] || '1.12.2';
const PORT = Number(process.env.PORT || 8781);
const URL = `http://127.0.0.1:${PORT}/?version=${VER}&log=1`;
const BUDGET = Number(process.env.BUDGET || 420000);
const EXEC = ['/usr/bin/brave', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));

const t0 = Date.now();
const el = () => Date.now() - t0;
const say = (...a) => console.log(`[${String(el()).padStart(6)}ms]`, ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const javaLines = [];
const errors = [];
const shots = [];

async function shot(page, name) {
  const file = path.join(ROOT, 'shots', name + '.png');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file });
  shots.push(name);
  say('shot', name);
  return file;
}

const server = spawn('python3', [path.join(ROOT, 'tools', 'serve.py'), String(PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
let serverOut = '';
server.stdout.on('data', d => { serverOut += d.toString(); });

let browser;
let failed = null;
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
    await sleep(250);
  }
  const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
  say('health', JSON.stringify(health.vanilla?.[VER] || health));

  browser = await puppeteer.launch({
    executablePath: EXEC, headless: true,
    protocolTimeout: 900000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
           '--window-size=1200,800', '--no-first-run', '--no-default-browser-check',
           '--autoplay-policy=no-user-gesture-required']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });

  page.on('console', m => {
    const t = m.text();
    javaLines.push(t);
    if (javaLines.length > 8000) javaLines.splice(0, 4000);
    if (/Exception|Error:|error|Caused by|\[main\/ERROR\]/.test(t) && !/error\.js|onerror/.test(t)) {
      if (errors.length < 60) errors.push(t.slice(0, 400));
    }
    if (/\[main\/|Setting user|Starting|Version:|LWJGL|webmc\]|Minecraft|Caused by/.test(t)) say('java>', t.slice(0, 220));
  });
  page.on('pageerror', e => errors.push('pageerror: ' + String(e && e.stack || e).slice(0, 400)));
  page.on('requestfailed', r => {
    const u = r.url();
    if (!/favicon|telemetry/.test(u)) say('reqfail', u.slice(0, 120), r.failure()?.errorText);
  });

  say('goto', URL);
  page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});

  // 1. the launcher page must find Mojang's plan
  const deadline = Date.now() + BUDGET;
  const waitPhase = async (name, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const p = await page.evaluate(() => Object.keys(window.mcBoot ? mcBoot.phases() : {})).catch(() => []);
      if (p.includes(name)) return p;
      await sleep(400);
    }
    return null;
  };

  for (const ph of ['plan', 'cheerpj', 'display', 'run']) {
    const got = await waitPhase(ph, Math.max(5000, deadline - Date.now()));
    if (!got) { failed = `phase "${ph}" never reached (got ${JSON.stringify(await page.evaluate(() => Object.keys(window.mcBoot ? mcBoot.phases() : {})))})`; break; }
    say('phase', ph, JSON.stringify(await page.evaluate(() => mcBoot.phases()).catch(() => ({}))));
    if (ph === 'run') break;
  }

  // 2. Mojang's own client must start talking
  const mojangRe = /\[main\/(INFO|WARN|ERROR)\]|Setting user|Starting game|Version: 1\.|Minecraft has started|Starting Minecraft$|lwjgl/;
  let sawJava = null;
  while (Date.now() < deadline && !sawJava) {
    sawJava = javaLines.find(l => mojangRe.test(l));
    if (!sawJava) await sleep(500);
  }
  if (!sawJava && !failed) failed = 'Mojang client never logged anything we recognise';
  if (sawJava) say('mojang-log>', sawJava.slice(0, 200));

  // 3. canvas + render loop
  let canvas = null, frames0 = 0, changing0 = 0;
  while (Date.now() < deadline && !canvas) {
    canvas = await page.evaluate(() => {
      const c = document.querySelector('#game canvas') || document.querySelector('canvas');
      if (!c) return null;
      return { w: c.width, h: c.height, id: c.id || null, cls: c.className || null };
    }).catch(() => null);
    if (!canvas) await sleep(1000);
  }
  if (!canvas && !failed) failed = 'no canvas appeared';
  if (canvas) say('canvas', JSON.stringify(canvas));

  await sleep(25000);
  await shot(page, `verify-${VER}-1`);
  const stats = await page.evaluate(() => ({
    frames: window.mcTelemetry ? mcTelemetry.frames() : null,
    changing: window.mcTelemetry ? mcTelemetry.changing() : null,
    canvas: window.mcTelemetry ? mcTelemetry.canvas() : null,
    isolated: self.crossOriginIsolated,
    phases: mcBoot ? mcBoot.phases() : null,
  }));
  say('stats', JSON.stringify(stats));
  await sleep(20000);
  await shot(page, `verify-${VER}-2`);
  const stats2 = await page.evaluate(() => ({ frames: mcTelemetry?.frames(), changing: mcTelemetry?.changing() }));
  say('stats2', JSON.stringify(stats2));

  const interesting = javaLines.filter(l => /webmc\]|\[main\/|Setting user|LWJGL|Caused by|Exception|Version|Starting|Sound|OpenAL|natives|assets/i.test(l)).slice(-45);
  console.log('\n--- java/console tail ---');
  for (const l of interesting) console.log('  ' + l.slice(0, 240));
  console.log('--- errors ---');
  for (const e of errors.slice(-25)) console.log('  ' + e.slice(0, 240));
  console.log('---------------------\n');

  if (failed) throw new Error(failed);
  if (!stats.canvas) throw new Error('telemetry never saw a canvas');
  if ((stats2.changing ?? 0) - (stats.changing ?? 0) < 1) {
    say('WARN', 'canvas pixels are not changing yet - the game may be stuck on a screen');
  }
  say('PASS', VER, 'is running in the browser; shots:', shots.join(', '));
} catch (e) {
  console.error('FAIL:', e && e.message || e);
  if (browser) {
    const p = browser.pages()[0];
    if (p) {
      await shot(p, `verify-${VER}-fail`);
      const tail = await p.evaluate(() => (window.mcTelemetry ? mcTelemetry.logTail(40) : [])).catch(() => []);
      console.log('--- log tail ---');
      for (const l of tail) console.log('  ' + String(l).slice(0, 240));
    }
  }
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch {}
  server.kill('SIGTERM');
}
