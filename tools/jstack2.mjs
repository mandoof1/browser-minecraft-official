// jstack2.mjs - repeated Java thread dumps, so a blocked call can be told
// apart from a loop that is simply slow. dumpAllThreads() prints the dump to the
// page console and returns nothing, so the console is the buffer.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = Number(process.env.PORT || 9090);
const RUNS = Number(process.env.RUNS || 3);
const GAP = Number(process.env.GAP || 20000);
const FIRST = Number(process.env.FIRST || 110000);
const server = spawn('python3', ['tools/serve.py'], { env: { ...process.env, PORT } });
let browser;
try {
  browser = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true, protocolTimeout: 900000,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--window-size=1200,800'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  const con = [];
  page.on('console', m => { con.push(m.text()); if (con.length > 8000) con.splice(0, 4000); });
  await page.goto(`http://127.0.0.1:${PORT}/?version=1.12.2`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(FIRST);
  for (let i = 0; i < RUNS; i++) {
    const mark = con.length;
    await page.evaluate(async () => { try { await dumpAllThreads(); } catch (e) { /* not exposed */ } }).catch(() => {});
    await sleep(2000);
    const dump = con.slice(mark).join('\n');
    fs.writeFileSync('/tmp/jd' + i + '.txt', dump);
    const blocks = dump.split(/\n(?=\tThread: )/);
    const hot = blocks.filter(b => /Main : main|bib : a \(\)V/.test(b));
    console.log(`--- dump ${i} t+${Math.round((FIRST + i * GAP) / 1000)}s blocks=${blocks.length} hot=${hot.length}`);
    for (const b of hot) console.log(b.split('\n').filter(l => !/Wasm|internal/.test(l)).slice(0, 14).join('\n'));
    if (i + 1 < RUNS) await sleep(GAP);
  }
  fs.mkdirSync('shots', { recursive: true });
  await page.screenshot({ path: 'shots/jstack2.png' });
} finally { try { await browser?.close(); } catch {} server.kill('SIGTERM'); }
