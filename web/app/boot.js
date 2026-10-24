/* boot.js - the launcher we wrote, for a game we did not write.
 *
 * What a desktop launcher does is: read Mojang's version json, build a
 * classpath out of Mojang's jars, and start Mojang's main class with Mojang's
 * arguments. That is exactly what happens here, with two substitutions that
 * are the whole point of the port:
 *
 *   java            -> CheerpJ's JVM, compiled to WebAssembly
 *   libGL.so / glfw -> gl4es (OpenGL->OpenGL ES) inside WebAssembly, and
 *                      CheerpJ's X11/AWT shim for the window
 *
 * The game jar, the libraries, the asset index and the asset objects are
 * Mojang's own bytes, verified against Mojang's own SHA-1 sums.
 */
window.mcBoot = (function () {
  const params = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const stage = (s) => { const e = $('stage'); if (e) e.textContent = s; };
  const setVer = (s) => { const e = $('vername'); if (e) e.textContent = s; };
  const phases = {};
  let plan = null;

  function phase(name, detail) {
    phases[name] = { t: Math.round(performance.now()), detail: detail || null };
    stage(name + (detail ? ' ' + detail : ''));
    if (window.mcTelemetry) mcTelemetry.event('phase', name + (detail ? ' ' + detail : ''));
    console.log('[boot] ' + name + (detail ? ' ' + detail : ''));
  }

  async function loadScript(src) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error('script failed: ' + src));
      document.head.appendChild(s);
    });
  }

  /* Mojang's classpath, in the order their launcher assembles it.
   *
   * The one deliberate swap: Mojang's LWJGL 2 jars ship x86-64 Linux/Windows
   * natives, which no browser can load. CheerpJ's runtime supplies an LWJGL 2
   * native built for WebAssembly plus gl4es for GL, and those are matched to
   * Leaning Technologies' LWJGL 2.9.3 jars, so the same jars are used for the
   * Java side too. Everything else on the classpath is Mojang's. */
  function classpath(plan, ver) {
    const base = '/app/data/vanilla/' + ver;
    const out = [];
    for (const entry of plan.classpath) {
      const name = entry.split('/').pop();
      if (/^lwjgl(_util)?-/.test(name)) continue;
      out.push(entry === 'mc-launcher.jar' ? '/app/mc-launcher.jar' : base + '/' + entry);
    }
    // Leaning Technologies' LWJGL 2.9.3 jars, with our APIUtil rewind patch
    // already inside (their jars seal packages, so the patch has to be in-jar).
    out.push('/app/lwjgl-2.9.3-webmc.jar');
    out.push('/app/lwjgl/lwjgl_util-2.9.3.jar');
    return out.join(':');
  }

  async function main() {
    const ver = params.get('version') || '1.12.2';
    setVer(ver);
    if (params.get('theater') === '1') document.body.classList.add('theater');
    if (params.get('log') === '1') document.body.classList.add('showlog');

    phase('plan');
    try {
      const r = await fetch('/data/vanilla/' + ver + '/plan.json');
      if (!r.ok) throw new Error('no plan for ' + ver + ' (run: python3 tools/get-vanilla.py ' + ver + ')');
      plan = await r.json();
    } catch (e) {
      phase('missing', String(e.message || e));
      setVer('Mojang ' + ver + ' not fetched yet');
      return;
    }
    phase('plan', plan.classpath.length + ' jars, ' + plan.assetObjects + ' assets, java ' + plan.javaMajor);

    phase('cheerpj');
    await loadScript('https://cjrtnc.leaningtech.com/4.3/loader.js');
    if (typeof cheerpjInit !== 'function') throw new Error('CheerpJ loader did not expose cheerpjInit');

    const javaMajor = params.get('java') || (Number(plan.javaMajor) >= 17 ? 17 : 8);
    await cheerpjInit({
      version: javaMajor,
      javaProperties: [
        'java.library.path=/app/lwjgl/libraries/',
        'mc.argsFile=/app/data/vanilla/' + ver + '/args.txt',
        'mc.args=' + plan.args.join('|'),
        'mc.mainClass=' + plan.mainClass,
        // Mojang's client wants to know where its .minecraft is; /files/ is
        // CheerpJ's persistent (IndexedDB-backed) filesystem, so saves, resource
        // packs and screenshots survive a reload.
        'webmc.gameDir=/files/minecraft'
      ],
      libraries: {
        'libGL.so.1': '/app/lwjgl/libraries/gl4es.wasm'
      },
      enableX11: true
    });
    phase('cheerpj', 'jvm ready (java ' + javaMajor + ')');

    await cheerpjCreateDisplay(-1, -1, $('game'));
    phase('display');

    if (params.get('probe') === 'file') {
      await cheerpjRunMain('webmc.FileProbe', '/app/probe.jar');
      phase('file-probe-returned');
      return;
    }
    if (params.get('probe') === 'gl2') {
      const cp = '/app/probe.jar:/app/lwjgl-2.9.3-webmc.jar:/app/lwjgl/lwjgl_util-2.9.3.jar';
      await cheerpjRunMain('webmc.GlProbe2', cp);
      phase('gl2-returned');
      return;
    }
    if (params.get('probe') === 'crash') {
      await cheerpjRunMain('webmc.CrashProbe', '/app/probe.jar:' + classpath(plan, ver));
      phase('crash-probe-returned');
      return;
    }
    if (params.get('probe') === 'gl') {
      const mojang = params.get('lwjgl') === 'mojang';
      const cp = mojang
        ? '/app/probe.jar:/app/data/vanilla/' + ver + '/libraries/lwjgl-2.9.4-nightly-20150209.jar:/app/data/vanilla/' + ver + '/libraries/lwjgl_util-2.9.4-nightly-20150209.jar'
        : '/app/probe.jar:/app/lwjgl-2.9.3-webmc.jar:/app/lwjgl/lwjgl_util-2.9.3.jar';
      phase('probe', cp);
      await cheerpjRunMain('webmc.GlProbe', cp);
      phase('probe-returned');
      return;
    }
    const cp = classpath(plan, ver);
    phase('run', cp.split(':').length + ' classpath entries');
    if (window.mcTelemetry) mcTelemetry.event('classpath', cp);
    await cheerpjRunMain('webmc.Launcher', cp);
    phase('returned');
  }

  main().catch(e => {
    phase('error', String(e && e.message || e));
    console.error('[boot] ' + (e && e.stack || e));
  });

  return {
    phases: () => phases,
    plan: () => plan,
    canvas: () => document.querySelector('#game canvas'),
    isolated: () => self.crossOriginIsolated
  };
})();
