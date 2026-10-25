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

  // The stage line is user-facing. Internal phase names and counts belong in the
  // console and in ?log=1, not in the header of a page someone is trying to play.
  const LABELS = {
    plan: name => 'Mojang ' + name,
    cheerpj: () => 'Java 8 running',
    warm: () => 'Loading game files',
    display: () => 'Window ready',
    run: () => 'Starting Minecraft',
    missing: () => 'Mojang files not fetched yet',
  };

  function phase(name, detail) {
    phases[name] = { t: Math.round(performance.now()), detail: detail || null };
    const label = LABELS[name] ? LABELS[name](plan && plan.version ? plan.version : '') : null;
    stage(label !== null ? label : 'Starting the game');
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
    // ?cpdrop=a,b,c leaves those jars off. Used to bisect a classpath effect:
    // Minecraft 1.2.5 gets a window div but no canvas once Mojang's 1.12.2
    // libraries are added, so one of them changes what CheerpJ realizes.
    const drop = (params.get('cpdrop') || '').split(',').filter(Boolean);
    for (const entry of plan.classpath) {
      const name = entry.split('/').pop();
      if (drop.some(d => name.includes(d))) continue;
      if (/^lwjgl(_util)?-/.test(name)) continue;
      out.push(entry === 'mc-launcher.jar' ? '/app/mc-launcher.jar' : base + '/' + entry);
    }
    // Leaning Technologies' LWJGL 2.9.3 jars, with our APIUtil rewind patch
    // already inside (their jars seal packages, so the patch has to be in-jar).
    out.push(params.get('lwjgl') === 'v2' ? '/app/lwjgl-2.9.3-webmc2.jar'
                                          : '/app/lwjgl-2.9.3-webmc.jar');
    out.push('/app/lwjgl/lwjgl_util-2.9.3.jar');
    return out.join(':');
  }

  /* One patched Mojang class, ahead of client.jar.
   *
   * Minecraft's crash reporter captures its own stack with
   * `new StackTraceElement[Thread.currentThread().getStackTrace().length - 3 - skip]`.
   * CheerpJ's Java 8 runtime hands back two frames, so that size goes negative
   * and the reporter dies while building the report - which throws away the
   * exception that actually broke startup. Neutralising the capture (tools/
   * patchclass.py) makes Mojang's own crash report, and the real cause inside
   * it, visible again. Turn it off with ?crashfix=0. */
  async function crashfixJar(ver) {
    if (params.get('crashfix') === '0') return null;
    // ?cee=0 selects the same jar without the AssetIndex.hasResource patch, so
    // the two can be timed against each other.
    const p = '/app/client-' + ver + '-webmc' + (params.get('cee') === '0' ? '-nocee' : '') + '.jar';
    try { return (await fetch(p, { method: 'HEAD' })).ok ? p : null; } catch (e) { return null; }
  }

  async function main() {
    const ver = params.get('version') || '1.12.2';
    setVer(ver);
    // ?mc=1.2.5 is the control target (Leaning Technologies' demo game) run
    // through our stack; the header should say what is actually on screen.
    if (params.get('mc')) setVer(params.get('mc') + ' (control)');
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
    // ?warm=1 hands CheerpJ the whole asset tree up front. The client reads
    // ~1070 asset objects during startup, one serial fetch each; the preload
    // table is keyed by virtual path with 128 KiB block offsets as values, so
    // the same bytes arrive as parallel fetches instead.
    let preloads = self.CJ_PRELOAD_RESOURCES;
    if (params.get('warm') === '1') {
      const idx = await (await fetch(`/data/vanilla/${ver}/assets/indexes/${plan.assetIndex}.json`)).json();
      preloads = Object.assign({}, preloads);
      const blocks = (size) => {
        const out = [];
        for (let o = 0; o < Math.max(1, size | 0); o += 131072) out.push(o);
        return out;
      };
      for (const entry of Object.values(idx.objects)) {
        const h = entry.hash || entry.sha1;
        preloads[`/app/data/vanilla/${ver}/assets/objects/${h.slice(0, 2)}/${h}`] = blocks(entry.size);
      }
      phase('warm', Object.keys(preloads).length + ' files preloaded');
    }
    await cheerpjInit({
      version: javaMajor,
      javaProperties: [
        'java.library.path=/app/lwjgl/libraries/',
        'mc.argsFile=/app/data/vanilla/' + ver + '/args.txt',
        // ?via=launcher+?mc=1.2.5 runs Leaning Technologies' working demo target
        // *through our launcher*, to see whether the extra Java frame between
        // cheerpjRunMain and the game's own main is what stops the window.
        'mc.args=' + (params.get('via') === 'launcher' ? ' ' : plan.args.join('|')),
        'mc.mainClass=' + (params.get('mainclass') || plan.mainClass),
        // Mojang's client wants to know where its .minecraft is; /files/ is
        // CheerpJ's persistent (IndexedDB-backed) filesystem, so saves, resource
        // packs and screenshots survive a reload.
        'webmc.gameDir=/files/minecraft',
        'webmc.variant=' + (params.get('variant') || 'minimal'),
        'webmc.warm=' + (params.get('warm') === '1' ? '1' : '0'),
        'webmc.useVbo=' + (params.get('vbo') === '0' ? 'false' : 'true'),
        'mc.version=' + ver
      ],
      libraries: {
        'libGL.so.1': '/app/lwjgl/libraries/gl4es.wasm'
      },
      enableX11: params.get('x11') !== '0',
      // Leaning Technologies' own Minecraft demo preloads these ranges of its
      // runtime before starting. Without them the JVM pulls rt.jar, the
      // meta-index files, cheerpj-awt.jar and libEGL/libGLESv2 one small read
      // at a time - and the path that turns an X11 window into a DOM canvas
      // never completes. ?preload=0 turns it back off for A/B runs.
      preloadResources: params.get('preload') === '0' ? undefined : preloads
    });
    phase('cheerpj', 'jvm ready (java ' + javaMajor + ')');

    await cheerpjCreateDisplay(-1, -1, $('game'));
    phase('display');

    if (params.get('probe') === 'persist') {
      await cheerpjRunMain('webmc.PersistProbe', '/app/probe.jar');
      phase('persist-returned');
      return;
    }
    if (params.get('probe') === 'saves') {
      await cheerpjRunMain('webmc.SaveProbe', '/app/probe.jar');
      phase('saves-returned');
      return;
    }
    if (params.get('probe') === 'crashdump') {
      await cheerpjRunMain('webmc.CrashDump', '/app/probe.jar');
      phase('crashdump-returned');
      return;
    }
    if (params.get('probe') === 'awtimage') {
      await cheerpjRunMain('webmc.AwtImageProbe', '/app/probe.jar');
      phase('awtimage-returned');
      return;
    }
    if (params.get('probe') === 'assets') {
      // Times reading every asset object once, warm or not.
      await cheerpjRunMain('webmc.AssetProbe', '/app/probe.jar');
      phase('assets-probe-returned');
      return;
    }
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
    // ?mc=1.2.5 runs Leaning Technologies' demo target through OUR init, OUR
    // display element and OUR hosting. It is the control that separates "our
    // page is wrong" from "1.12.2's display path is wrong".
    if (params.get('mc') === '1.2.5') {
      // ?full=1 puts 1.2.5 on the *1.12.2* classpath (Mojang's 35 libraries and
      // our patched LWJGL). If the window disappears, one of those jars is what
      // stops CheerpJ realizing it - not the game.
      // ?full=1 = the whole 1.12.2 classpath; ?cpadd=x,y adds specific jars to
      // the minimal (working) one, which is how the canvas-less case gets
      // narrowed to a single jar.
      const minimal = ['/app/lwjgl/lwjgl-2.9.3.jar', '/app/lwjgl/lwjgl_util-2.9.3.jar',
                       '/app/data/minecraft/1.2.5-client.jar'];
      const add = (params.get('cpadd') || '').split(',').filter(Boolean)
        .map(a => a.startsWith('/') ? a : '/app/data/vanilla/' + ver + '/' + a);
      if (params.get('via') === 'launcher') {
        await cheerpjRunMain('webmc.Launcher', minimal.concat(['/app/mc-launcher.jar']).join(':'));
        phase('mc125-via-launcher-returned');
        return;
      }
      const cpbc = params.get('full') === '1'
        ? classpath(plan, ver) + ':/app/data/minecraft/1.2.5-client.jar'
        : minimal.concat(add).join(':');
      await cheerpjRunMain('net.minecraft.client.Minecraft', cpbc);
      phase('mc125-returned');
      return;
    }
    if (params.get('probe') === 'gl7') {
      const cp7 = '/app/probe.jar:/app/lwjgl-2.9.3-webmc.jar:/app/lwjgl/lwjgl_util-2.9.3.jar';
      await cheerpjRunMain('webmc.GlProbe7', cp7);
      phase('gl7-returned');
      return;
    }
    if (params.get('probe') === 'gl6') {
      const cp6 = '/app/probe.jar:/app/lwjgl-2.9.3-webmc.jar:/app/lwjgl/lwjgl_util-2.9.3.jar';
      await cheerpjRunMain('webmc.GlProbe6', cp6);
      phase('gl6-returned');
      return;
    }
    if (params.get('probe') === 'gl4') {
      // ?lwjgl=plain uses Browsercraft's untouched LWJGL jar; the default is our
      // APIUtil-rewind copy. If a window appears with one and not the other, the
      // patch is what is hiding the window.
      const lw = params.get('lwjgl') === 'plain' ? '/app/lwjgl/lwjgl-2.9.3.jar' : '/app/lwjgl-2.9.3-webmc.jar';
      const cp4 = '/app/probe.jar:' + lw + ':/app/lwjgl/lwjgl_util-2.9.3.jar';
      await cheerpjRunMain('webmc.GlProbe4', cp4);
      phase('gl4-returned');
      return;
    }
    if (params.get('probe') === 'gl3') {
      const cp3 = '/app/probe.jar:/app/lwjgl-2.9.3-webmc.jar:/app/lwjgl/lwjgl_util-2.9.3.jar';
      await cheerpjRunMain('webmc.GlProbe3', cp3);
      phase('gl3-returned');
      return;
    }
    if (params.get('probe') === 'npe') {
      await cheerpjRunMain('webmc.NpeProbe', '/app/probe.jar');
      phase('npe-probe-returned');
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
    const fix = await crashfixJar(ver);
    const cp = (fix ? fix + ':' : '') + classpath(plan, ver);
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
