/* bc.js - A/B control for the missing-window problem.
 *
 * Our Minecraft 1.12.2 gets a working GL context under CheerpJ (gl4es answers
 * glGetString, Display.create returns, Display.update swaps) but CheerpJ never
 * realizes a window: no `div.cjWindow`, no `canvas.cjSwapped`. Leaning
 * Technologies' own Browsercraft demo does get both, on the same CheerpJ 4.3,
 * the same LWJGL 2.9.3 and the same gl4es.wasm.
 *
 * So this page transcribes Browsercraft's setup as literally as possible -
 * their cheerpjInit options including the whole preloadResources table, their
 * classpath shape, their main class - and runs Minecraft 1.2.5 on our hosting.
 * If the window appears here, the difference is in our page or in 1.12.2's
 * display path; if it does not, the difference is in our hosting.
 *
 * The only deliberate deviation is the loader path pin (see boot.js): on a
 * deployed origin loader.js guesses its own runtime location from a stack trace
 * and asks our server for /cj3n8.wasm.
 */
const CJ = 'https://cjrtnc.leaningtech.com/4.3';

function loadScript(u) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = u; s.onload = res; s.onerror = () => rej(new Error('load failed ' + u));
    document.head.appendChild(s);
  });
}

const hud = document.getElementById('hud');
function say(m) {
  console.log('[bc] ' + m);
  hud.textContent = m;
}

// Watch for the window CheerpJ is supposed to make, and report the moment it
// appears (or never does).
function watchDisplay() {
  let last = '';
  setInterval(() => {
    const c = [...document.querySelectorAll('canvas')]
      .map(x => x.width + 'x' + x.height + '.' + x.className);
    const w = document.querySelectorAll('.cjWindow').length;
    const d = document.getElementById('bcDisplay');
    const sig = JSON.stringify({ canvas: c, windows: w,
      status: d && d.getAttribute('data-status'),
      kids: d ? [...d.children].map(e => e.tagName + (e.className ? '.' + e.className : '')) : [] });
    if (sig !== last) { say('DISPLAY ' + sig); last = sig; }
  }, 1500);
}

async function main() {
  await loadScript(CJ + '/loader.js');
  self.cj3LoaderPath = CJ;          // after the loader body, before any fetch
  if (!self.cheerpjInit) throw new Error('loader did not expose cheerpjInit');

  say('cheerpjInit (Browsercraft options)');
  await cheerpjInit({
    version: 8,
    javaProperties: ['java.library.path=/app/lwjgl/libraries/'],
    libraries: { 'libGL.so.1': '/app/lwjgl/libraries/gl4es.wasm' },
    enableX11: true,
    preloadResources: self.CJ_PRELOAD_RESOURCES
  });

  say('createDisplay');
  await cheerpjCreateDisplay(-1, -1, document.getElementById('bcDisplay'));
  watchDisplay();

  // Browsercraft's shape: `<pathJarLibs>` = lwjgl : lwjgl_util : client jar.
  // Their jar lives in /files (written by hand); ours is served from /app, which
  // CheerpJ reads with HTTP Range - same trick our 1.12.2 launch already uses.
  const cp = '/app/lwjgl/lwjgl-2.9.3.jar:/app/lwjgl/lwjgl_util-2.9.3.jar'
           + ':/app/data/minecraft/1.2.5-client.jar';
  say('runMain net.minecraft.client.Minecraft');
  await cheerpjRunMain('net.minecraft.client.Minecraft', cp);
  say('runMain returned');
}

main().catch(e => say('FATAL ' + (e && e.message ? e.message : e)));
