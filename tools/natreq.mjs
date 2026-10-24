// natreq.mjs - every file CheerpJ asks our origin for while a display is made.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = process.env.PORT || '8907';
const srv = spawn('python3', ['tools/serve.py'], { env: { ...process.env, PORT } });
await sleep(1200);
const b = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--window-size=1200,800'] });
try {
  const p = await b.newPage();
  await p.setViewport({ width: 1200, height: 800 });
  const reqs = [], fails = [];
  p.on('response', r => { const u = r.url(); if (u.includes(`127.0.0.1:${PORT}/app/`)) reqs.push(r.status() + ' ' + u.split('/app/')[1].slice(0, 90)); });
  p.on('requestfailed', r => fails.push(r.failure()?.errorText + ' ' + r.url().slice(0, 110)));
  p.on('console', m => { const t = m.text(); if (/lwjgl|jawt|native|Native|X11|x11|window|Window/.test(t) && !/\[gl3\]/.test(t)) console.log('C ' + t.slice(0, 150)); });
  await p.goto(`http://127.0.0.1:${PORT}/?probe=gl3&log=1`, { waitUntil: 'domcontentloaded' });
  await sleep(Number(process.env.WAIT || 90000));
  console.log('--- /app/ requests (' + reqs.length + '):');
  for (const r of [...new Set(reqs)].sort()) if (/lwjgl|jawt|GL|gl4es|\.so|\.wasm|\.js/.test(r)) console.log('  ' + r);
  console.log('--- failed:', JSON.stringify(fails.slice(0, 8)));
  console.log('CANVAS:', JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('canvas')].map(c => c.width + 'x' + c.height + '.' + c.className))));
} finally { await b.close(); srv.kill(); }
