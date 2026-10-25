/* telemetry.js - the port's own record of what the game did.
 *
 * For a vanilla port there is no engine hook API to lean on: the client is
 * Mojang's unmodified jar. So the observable signals are (a) the Java side's
 * own log, which CheerpJ forwards to the JS console, (b) the canvas, and
 * (c) whether the pixels are actually changing. All three are recorded here
 * and POSTed to /telemetry, which is how a hosted port can be checked against
 * the build that was deployed.
 */
window.mcTelemetry = (function () {
  const log = [];
  const events = [];
  let t0 = performance.now();
  let canvasSeen = false, frames = 0, lastHash = null, changing = 0;

  function record(kind, detail) {
    events.push({ t: Math.round(performance.now() - t0), kind, detail });
    if (events.length > 2000) events.splice(0, 500);
  }

  /* CheerpJ forwards Java's stdout/stderr to the JS console. Minecraft's own
   * log lines are the ground truth that Mojang's code is running. */
  const GAME_LOG = /\[main\/(INFO|WARN|ERROR)\]|\[Client thread\/(INFO|WARN|ERROR)\]|Setting user|Starting game|Minecraft has started|Version:|lwjgl|LWJGL|Exception|Error|Caused by/;

  function note(msg, level) {
    const s = String(msg);
    log.push(s);
    if (log.length > 6000) log.splice(0, 4000);
    if (GAME_LOG.test(s)) record('java', s.slice(0, 400));
    const el = document.getElementById('log');
    if (el && document.body.classList.contains('showlog')) {
      el.textContent += (el.textContent ? '\n' : '') + s;
      el.scrollTop = el.scrollHeight;
    }
  }

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level].bind(console);
    console[level] = function (...args) {
      note(args.map(a => (a && a.message) || String(a)).join(' '), level);
      orig(...args);
    };
  }

  let posted = 0, failed = 0;
  function flush() {
    if (!events.length) return;
    const batch = events.splice(0, events.length);
    fetch('/telemetry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        uptimeMs: Math.round(performance.now() - t0),
        events: batch,
        logTail: log.slice(-40),
        canvas: canvasSeen,
        frames,
        fps: fps(),
        paints,
        glFinish,
        glFlush,
        changing,
        posted
      })
    }).then(r => { if (!r.ok) failed++; posted++; }, () => { failed++; });
  }
  setInterval(flush, 10000);

  /* A real frame counter. The 1 Hz canvas sampler below can only say "the
   * pixels differ from last second", which is useless for measuring frame rate.
   * CheerpJ paints a Java canvas into the DOM with putImageData (and
   * createImageBitmap), so counting those calls on the game canvas is counting
   * the frames the game actually presented. */
  let paints = 0, paintSamples = [], glSamples = [];
  // A DOM query per call would be silly: this wraps every pixel blit the page
  // makes. Resolve each canvas once and remember it.
  const canvasIsGame = new WeakMap();
  const isGameCanvas = (c) => {
    if (!c) return false;
    if (canvasIsGame.has(c)) return canvasIsGame.get(c);
    const v = !!(c.className || '').toString().match(/cjSwapped|cjCanvas/) ||
      !!(c.closest && c.closest('#game'));
    canvasIsGame.set(c, v);
    return v;
  };
  for (const proto of [CanvasRenderingContext2D.prototype, OffscreenCanvasRenderingContext2D && OffscreenCanvasRenderingContext2D.prototype].filter(Boolean)) {
    for (const name of ['putImageData', 'drawImage']) {
      const orig = proto[name];
      if (!orig) continue;
      proto[name] = function (...args) {
        const target = name === 'drawImage' ? this.canvas : null;
        if (target === null || isGameCanvas(target)) paints++;
        return orig.apply(this, args);
      };
    }
  }

  /* Measured: the 2D blit counter sees two calls in a whole session. The game
   * canvas is not painted with putImageData - gl4es draws straight into a
   * WebGL context - so the frame boundary has to come from the GL side: the
   * swap is a finish, and Mojang also flushes mid-frame. */
  let glFinish = 0, glFlush = 0;
  for (const proto of [typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext.prototype : null,
                      typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext.prototype : null].filter(Boolean)) {
    for (const [name, sink] of [['finish', () => glFinish++], ['flush', () => glFlush++]]) {
      const orig = proto[name];
      if (!orig) continue;
      proto[name] = function (...args) {
        sink();
        return orig.apply(this, args);
      };
    }
  }
  setInterval(() => {
    paintSamples.push(paints);
    glSamples.push([glFinish, glFlush]);
    if (paintSamples.length > 10) paintSamples.shift();
    if (glSamples.length > 10) glSamples.shift();
  }, 1000);

  // frames presented per second over the last few seconds. Prefer the finish
  // count (one per swap); fall back to flush when the runtime never calls it.
  function fps() {
    if (paintSamples.length < 2) return 0;
    const dt = paintSamples.length - 1;
    const blits = (paintSamples[dt] - paintSamples[0]) / dt;
    let f = 0, l = 0;
    for (const s of glSamples) { f += s[0]; l += s[1]; }
    const fin = (glSamples[glSamples.length - 1][0] - glSamples[0][0]) / dt;
    const fl = (glSamples[glSamples.length - 1][1] - glSamples[0][1]) / dt;
    const cand = fin > 0.5 ? fin : fl;
    return Math.round(Math.max(blits, cand) * 10) / 10;
  }

  /* is the canvas actually producing new content? for a vanilla client this is
   * the only signal that the render loop is alive */
  function watchCanvas() {
    const c = document.querySelector('#game canvas');
    if (!c) return false;
    canvasSeen = true;
    try {
      const s = Math.min(64, c.width || 64);
      const off = document.createElement('canvas');
      off.width = off.height = s;
      const ctx = off.getContext('2d');
      ctx.drawImage(c, 0, 0, s, s);
      const h = ctx.getImageData(0, 0, s, s).data;
      let sum = 0;
      for (let i = 0; i < h.length; i += 4) sum = (sum * 31 + h[i] + h[i + 1] * 7 + h[i + 2] * 13) >>> 0;
      if (lastHash !== null && sum !== lastHash) changing++;
      lastHash = sum;
      frames++;
    } catch (e) { /* tainted or zero-sized canvas */ }
    return true;
  }
  setInterval(watchCanvas, 1000);

  return {
    note,
    record,
    event: (k, d) => record(k, d),
    logTail: (n = 60) => log.slice(-n),
    logMatch: (re) => log.filter(l => re.test(l)).slice(-10),
    events: () => events.slice(),
    screens: () => ({ name: null, seq: 0 }),   // no GUI hook in a vanilla client
    heap: () => ({
      jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      wasmMB: (() => {
        try {
          const m = WebAssembly.memory || (window.__cj3 && window.__cj3.memory);
          return m ? Math.round(m.buffer.byteLength / 1048576) : null;
        } catch (e) { return null; }
      })()
    }),
    canvas: () => canvasSeen,
    frames: () => frames,
    fps,
    paints: () => paints,
    changing: () => changing,
    flush
  };
})();
