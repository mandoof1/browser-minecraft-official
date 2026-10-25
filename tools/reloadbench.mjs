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

// Mojang's own log is the marker, not a screenshot: CheerpJ runs the JVM on
// the page's main thread, so screenshotting every few seconds measurably
// slows the boot it is supposed to be measuring.
const READY = /Starting game|Reloading ResourceManager: Default/;
const seen = [];
page.on('console', m => { const t = m.text(); if (READY.test(t)) seen.push(t); });

async function waitTitle(label) {
  const t0 = Date.now();
  const before = seen.length;
  while (Date.now() - t0 < 700000 && seen.length === before) await sleep(2000);
  const secs = Math.round((Date.now() - t0) / 1000);
  const marks = log.split('\n').filter(l => l.includes('OPEN')).length;
  console.log(`${label}: menu in ${secs}s, requests so far ${marks}`);
  return marks;
}

await page.goto(`http://127.0.0.1:${PORT}/?version=1.12.2`, { waitUntil: 'domcontentloaded' });
const a = await waitTitle('first load ');
await page.reload({ waitUntil: 'domcontentloaded' });
const b = await waitTitle('second load');
console.log(`requests during the second load: ${b - a}`);
await browser.close();
srv.kill();
