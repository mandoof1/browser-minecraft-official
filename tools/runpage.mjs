// runpage.mjs - open any page in this project and print what the JVM says.
// Used for the GL probe and for any experiment page; it is the smallest possible
// harness: boot, wait, dump the console, screenshot.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 8788);
const Q = process.env.Q || '';
const WAIT = Number(process.env.WAIT || 90000);
const NAME = process.env.NAME || 'page';
const EXEC = ['/usr/bin/brave', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const accLog = path.join(ROOT, 'shots', NAME + '-access.log');
const server = spawn('python3', [path.join(ROOT, 'tools', 'serve.py'), String(PORT)], { stdio: ['ignore', 'ignore', fs.openSync(accLog, 'w')] });
let browser;
try {
  for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {} await sleep(250); }
  browser = await puppeteer.launch({
    executablePath: EXEC, headless: true, protocolTimeout: 900000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1200,800',
    ...(process.env.USERDATA ? ['--user-data-dir=' + process.env.USERDATA] : [])]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  const all = [];
  page.on('console', m => { const t = m.text(); all.push(t); if (/\[glprobe\]|\[webmc\]|Exception|Caused by|LIBGL:.*(error|Error)|FAILED/.test(t)) console.log('  ' + t.slice(0, 200)); });
  page.on('pageerror', e => console.log('pageerror ' + String(e.stack || e).slice(0, 300)));
  console.log(`--- ${NAME} (${Q}) ---`);
  await page.goto(`http://127.0.0.1:${PORT}/?${Q}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(WAIT);
  await page.screenshot({ path: path.join(ROOT, 'shots', NAME + '.png') });
  fs.mkdirSync('shots', { recursive: true });
  fs.writeFileSync(`shots/${NAME}-console.log`, all.join('\n') + '\n');
  console.log('--- console: ' + all.length + ' lines (full copy in shots/' + NAME + '-console.log) ---');
  for (const l of all.slice(-60)) console.log('  ' + String(l).slice(0, 300));
} finally {
  try { await browser?.close(); } catch {}
  server.kill('SIGTERM');
}
