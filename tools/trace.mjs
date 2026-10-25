// trace.mjs - is Mojang's client hung, or just slow inside the WebAssembly JVM?
//
// Takes several Java thread dumps and compares program counters. Same PC in
// two dumps = a real hang, and the frame it is stuck in names the layer to fix.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(import.meta.dirname, '..');
const VER = process.argv[2] || '1.12.2';
const PORT = Number(process.env.PORT || 8787);
const EXEC = ['/usr/bin/brave', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn('python3', [path.join(ROOT, 'tools', 'serve.py'), String(PORT)], { stdio: ['ignore', 'pipe', 'ignore'] });
let browser;
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {} await sleep(250); }
  browser = await puppeteer.launch({
    executablePath: EXEC, headless: true, protocolTimeout: 900000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1200,800']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  const all = [];
  page.on('console', m => all.push(m.text()));
  page.on('pageerror', e => all.push('pageerror ' + String(e.stack || e)));
  await page.goto(`http://127.0.0.1:${PORT}/?version=${VER}&log=1`, { waitUntil: 'domcontentloaded' }).catch(() => {});

  // wait until Mojang's own log says it got to LWJGL
  const deadline = Date.now() + Number(process.env.WAIT || 180000);
  while (Date.now() < deadline && !all.some(l => /LWJGL Version/.test(l))) await sleep(1000);
  console.log('reached LWJGL at', Date.now());

  for (let i = 0; i < 3; i++) {
    await sleep(25000);
    const before = all.length;
    await page.evaluate(() => { try { dumpAllThreads(); } catch (e) { console.log('dump fail ' + e); } });
    await sleep(2500);
    const chunk = all.slice(before).join('\n');
    const m = chunk.match(/Thread: 4[\s\S]{0,900}/);
    console.log(`\n===== dump ${i + 1} (main thread) =====`);
    console.log(m ? m[0].split('\n').slice(0, 16).join('\n') : chunk.slice(0, 900));
  }
  await page.screenshot({ path: path.join(ROOT, 'shots', 'trace-' + VER + '.png') });
  console.log('\n===== last java/console lines =====');
  for (const l of all.filter(l => /\[Client thread|webmc\]|Exception|Caused by|LIBGL|error/i.test(l)).slice(-25)) console.log('  ' + l.slice(0, 200));
} finally {
  try { await browser?.close(); } catch {}
  server.kill('SIGTERM');
}
