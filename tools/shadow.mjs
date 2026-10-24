import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = process.env.PORT || '8890';
const srv = spawn('python3', ['tools/serve.py'], { env: { ...process.env, PORT } });
await sleep(1200);
const b = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true, protocolTimeout: 600000,
  args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader'] });
const p = await b.newPage();
await p.goto(`http://127.0.0.1:${PORT}/?${process.env.Q || 'probe=gl2&log=1'}`, { waitUntil: 'domcontentloaded' });
await sleep(Number(process.env.BOOT || 45000));
console.log(await p.evaluate(() => {
  const d = document.querySelector('#cheerpjDisplay');
  const walk = (root, depth) => {
    let out = [];
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'CANVAS' || el.shadowRoot) {
        out.push(`${'  '.repeat(depth)}${el.tagName}#${el.id}.${el.className} shadow=${!!el.shadowRoot}`
          + (el.tagName === 'CANVAS' ? ` ${el.width}x${el.height}` : ''));
      }
      if (el.shadowRoot) out = out.concat(walk(el.shadowRoot, depth + 1));
    }
    return out;
  };
  const found = walk(document, 0);
  return JSON.stringify({ shadowOnDisplay: !!d.shadowRoot, found,
    allElements: document.querySelectorAll('*').length }, null, 1);
}));
srv.kill(); await b.close();
