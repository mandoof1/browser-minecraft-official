import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = process.env.PORT || '8870';
const srv = spawn('python3', ['tools/serve.py'], { env: { ...process.env, PORT } });
await sleep(1200);
const browser = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--window-size=1200,800'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  const Q = process.env.Q || 'version=1.12.2&log=1';
  await page.goto(`http://127.0.0.1:${PORT}/?${Q}`, { waitUntil: 'domcontentloaded' });
  await sleep(Number(process.env.BOOT || 90000));
  const game = await page.evaluate(() => {
    const g = document.querySelector('#game');
    return { exists: !!g, html: g ? g.innerHTML.slice(0, 900) : null,
             body: document.body.innerHTML.slice(0, 500) };
  });
  console.log('PARENT #game:', JSON.stringify(game));
  for (const f of page.frames()) {
    if (f.url().includes('c.html')) {
      const d = await f.evaluate(() => ({ title: document.title, body: document.body ? document.body.innerHTML.slice(0, 900) : null,
        kids: document.body ? document.body.children.length : -1, all: [...document.querySelectorAll('*')].map(e => e.tagName).join(',') }));
      console.log('CDN FRAME:', JSON.stringify(d));
    }
  }
  await page.screenshot({ path: 'shots/frames.png' });
} finally { await browser.close(); srv.kill(); }
