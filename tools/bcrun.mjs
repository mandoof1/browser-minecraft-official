// bcrun.mjs - drive Leaning Technologies' own working CheerpJ Minecraft demo
// (Browsercraft, Minecraft 1.2.5) and report what its display actually is.
// Same CheerpJ 4.3, same LWJGL 2, same wasm GL: if a canvas appears there and
// not here, the difference is our page, not the runtime.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--window-size=1200,800'] });
const p = await b.newPage();
await p.setViewport({ width: 1200, height: 800 });
const logs = [];
p.on('console', m => { const t = m.text(); if (/Minecraft|LWJGL|Setting user|LWJGL|Canvas|canvas/i.test(t)) logs.push(t.slice(0,140)); });
await p.goto('https://browsercraft.cheerpj.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
await sleep(4000);
await p.click('input[type=checkbox]').catch(e => console.log('checkbox fail', String(e).slice(0,60)));
await sleep(1000);
const clicked = await p.evaluate(() => {
  const els = [...document.querySelectorAll('button, a, [role=button]')];
  const play = els.find(e => /play/i.test(e.textContent || ''));
  if (play) { play.click(); return play.outerHTML.slice(0, 120); }
  return null;
});
console.log('PLAY:', clicked);
await sleep(Number(process.env.BOOT || 100000));
console.log('CANVAS:', JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('canvas')]
  .map(c => ({ w: c.width, h: c.height, cls: c.className, id: c.id, parent: c.parentElement && (c.parentElement.id || c.parentElement.className) })))));
console.log('DISPLAY:', JSON.stringify(await p.evaluate(() => {
  const d = document.querySelector('#cheerpjDisplay');
  return d ? { cls: d.className, status: d.getAttribute('data-status'), kids: [...d.children].map(e => e.tagName + (e.className ? '.' + e.className : '')) } : null;
})));
console.log('JAVA LOG:', JSON.stringify(logs.slice(0, 6)));
fs.mkdirSync('shots', { recursive: true });
await p.screenshot({ path: 'shots/bc-running.png' });
await b.close();
