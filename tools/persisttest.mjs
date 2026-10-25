// Does CheerpJ's /files/ survive a page reload in the same tab? That is the
// question a real player hits: create a world, press F5, is the world still
// there? Two separate browser launches are not the same test - and not even
// the same origin if the port changes.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT || 9600);
const WAIT = Number(process.env.WAIT || 120000);
const EXEC = ['/usr/bin/brave', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn('python3', [path.join(ROOT, 'tools', 'serve.py'), String(PORT)], { stdio: ['ignore', 'ignore', 'ignore'] });
for (let i = 0; i < 40; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {} await sleep(250); }

const browser = await puppeteer.launch({
  executablePath: EXEC,
  headless: 'new',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--window-size=1200,800', ...(process.env.USERDATA ? ['--user-data-dir=' + process.env.USERDATA] : [])]
});
const page = await browser.newPage();
const seen = [];
page.on('console', m => { const t = m.text(); if (t.includes('[persist]')) seen.push(t); });

async function run(label) {
  const before = seen.length;
  console.log(`--- ${label} ---`);
  await page.goto(`http://127.0.0.1:${PORT}/?probe=persist`, { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  while (Date.now() - t0 < WAIT && seen.length === before) await sleep(3000);
  for (const l of seen.slice(before)) console.log('  ' + l);
}

await run('first load');
await page.reload({ waitUntil: 'domcontentloaded' });
await run('after reload (same tab, same origin)');
await browser.close();
server.kill();
