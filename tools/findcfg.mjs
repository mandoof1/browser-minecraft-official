import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const b = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true, protocolTimeout: 300000, args: ['--no-sandbox'] });
const p = await b.newPage();
const seen = new Set();
p.on('request', r => { if (r.url().endsWith('.js') || r.url().includes('.js?')) seen.add(r.url()); });
await p.goto('https://browsercraft.cheerpj.com/', { waitUntil: 'networkidle2', timeout: 90000 }).catch(()=>{});
await new Promise(r => setTimeout(r, 8000));
const urls = [...seen].filter(u => !u.includes('cjrtnc') && !u.includes('plausible'));
console.log('APP SCRIPTS', urls.length);
for (const u of urls) {
  let t; try { t = await (await fetch(u)).text(); } catch (e) { continue; }
  for (const key of ['cheerpjInit', 'cheerpjCreateDisplay', 'enableX11']) {
    const i = t.indexOf(key);
    if (i >= 0) console.log('== ' + key + ' in ' + u + '\n   ' + t.slice(Math.max(0, i - 80), i + 700).replace(/\s+/g, ' ') + '\n');
  }
}
await b.close();
