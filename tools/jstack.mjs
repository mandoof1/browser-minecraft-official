// jstack.mjs - where is Mojang's client stuck inside the WebAssembly JVM?
//
// CheerpJ exports dumpAllThreads(); this boots the game, waits, and dumps the
// Java stack so the port layer can be fixed against a real frame, not a guess.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(import.meta.dirname, '..');
const VER = process.argv[2] || '1.12.2';
const WAIT = Number(process.env.WAIT || 90000);
const PORT = Number(process.env.PORT || 8783);
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
  page.on('console', m => { all.push(m.text()); if (all.length > 6000) all.splice(0, 3000); });
  page.on('pageerror', e => all.push('pageerror ' + String(e.stack || e)));
  page.on('requestfailed', r => all.push('reqfail ' + r.url() + ' ' + (r.failure()?.errorText || '')));
  page.on('request', r => { const u = r.url(); if (!/cjrtnc|127.0.0.1/.test(u)) all.push('net ' + u.slice(0, 140)); });

  await page.goto(`http://127.0.0.1:${PORT}/?version=${VER}&log=1`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(WAIT);

  const dump = await page.evaluate(async () => {
    const out = [];
    try { out.push('dumpAllThreads: ' + (typeof dumpAllThreads)); if (typeof dumpAllThreads === 'function') out.push(String(await dumpAllThreads())); } catch (e) { out.push('dumpAllThreads failed ' + e); }
    try { out.push('dumpClass: ' + String(await dumpClass('net.minecraft.client.main.Main')).slice(0, 4000)); } catch (e) { out.push('dumpClass failed ' + e); }
    return out.join('\n');
  }).catch(e => 'eval failed ' + e);
  console.log('===== DUMP =====\n' + String(dump).slice(0, 6000));
  console.log('===== CONSOLE (all, tail 80) =====');
  for (const l of all.slice(-80)) console.log('  ' + String(l).slice(0, 220));
  fs.mkdirSync(path.join(ROOT, 'shots'), { recursive: true });
  await page.screenshot({ path: path.join(ROOT, 'shots', 'jstack-' + VER + '.png') });
} finally {
  try { await browser?.close(); } catch {}
  server.kill('SIGTERM');
}
