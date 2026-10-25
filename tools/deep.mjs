// deep.mjs - walk every frame and shadow root; report any canvas or cj* node.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PORT = process.env.PORT || '9001';
const QS = process.env.QS || '';
const srv = spawn('python3', ['tools/serve.py'], { env: { ...process.env, PORT } });
await sleep(1200);
const b = await puppeteer.launch({ executablePath: '/usr/bin/brave', headless: true, protocolTimeout: 900000,
  args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=angle','--use-angle=swiftshader','--window-size=1200,800'] });
try {
  const p = await b.newPage();
  await p.setViewport({ width: 1200, height: 800 });
  await p.goto(`http://127.0.0.1:${PORT}/?${QS}`, { waitUntil: 'domcontentloaded' });
  await sleep(Number(process.env.WAIT || 120000));
  for (const f of p.frames()) {
    const info = await f.evaluate(() => {
      const out = [];
      const walk = (root, path, depth) => {
        if (depth > 12) return;
        for (const el of root.querySelectorAll ? root.querySelectorAll('*') : []) {
          const cls = (el.getAttribute && el.getAttribute('class')) || '';
          if (el.tagName === 'CANVAS' || /cj[A-Z]/.test(cls)) {
            out.push(path + ' ' + el.tagName + (cls ? '.' + cls : '') +
              (el.width ? ' ' + el.width + 'x' + el.height : '') +
              (el.offsetWidth !== undefined ? ' box=' + el.offsetWidth + 'x' + el.offsetHeight : ''));
          }
          if (el.shadowRoot) walk(el.shadowRoot, path + '/SHADOW(' + el.tagName + ')', depth + 1);
          if (el.tagName === 'IFRAME') { try { walk(el.contentDocument, path + '/IFRAME(' + el.src.slice(0, 40) + ')', depth + 1); } catch (e) {} }
        }
      };
      walk(document, 'DOC', 0);
      return { url: location.href.slice(0, 70), n: document.querySelectorAll('*').length, hits: out.slice(0, 40) };
    }).catch(e => ({ err: String(e).slice(0, 80) }));
    console.log(JSON.stringify(info));
  }
} finally { await b.close(); srv.kill(); }
