import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const srv = spawn('python3', ['tools/serve.py'], { env: { ...process.env, PORT: process.env.PORT || '8840' } });
await sleep(1200);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true, protocolTimeout: 300000,
  args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0,300)));
  page.on('console', m => console.log('CONSOLE', m.type(), m.text().slice(0,200)));
  page.on('requestfailed', r => console.log('REQFAIL', r.url().slice(0,120), r.failure() && r.failure().errorText));
  await page.goto(`http://127.0.0.1:${process.env.PORT||'8840'}/?version=1.12.2&log=1&x11=0`, { waitUntil: 'domcontentloaded' });
  await sleep(45000);
  console.log('isolated=', await page.evaluate(() => self.crossOriginIsolated));
  console.log('SAB=', await page.evaluate(() => typeof SharedArrayBuffer));
  console.log('phases=', await page.evaluate(() => JSON.stringify(window.mcBoot ? mcBoot.phases() : {})));
  const h = await page.evaluate(async () => { const r = await fetch('/app/boot.js'); return [...r.headers.entries()].filter(([k])=>/cross-origin|permissions/i.test(k)); });
  console.log('headers on a subresource:', JSON.stringify(h));
} finally { await browser.close(); srv.kill(); }
