# browser-minecraft-official

Running **Mojang's own, unmodified Minecraft client** in a browser, built from
scratch: no third-party browser port of Minecraft is used here, and nothing in
this repository is a reimplementation of the game.

Target version: **Minecraft 1.12.2** (Java 8, LWJGL 2).

Status: **Mojang's Minecraft 1.12.2 runs, generates a world and is played in
the browser.** Details under [Where it stands](#where-it-stands). Startup time
and tick rate are the parts that are still poor.

The sibling project `../browser-minecraft` is a different approach (EaglercraftX,
a pre-existing browser port) and is fully playable/deployed. This one is the
"do it ourselves against the official client" attempt.

## What is whose

| part | whose |
|---|---|
| the game (`client.jar`, libraries, assets) | Mojang, byte for byte, SHA-1 verified |
| the JVM | [CheerpJ 4.3](https://cheerpj.com) — Java-in-WebAssembly (community edition) |
| GL for LWJGL 2 | gl4es 1.1.6 + Leaning Technologies' wasm `liblwjgl` (from `browsercraft`) |
| launcher, classpath, launch arguments, asset pipeline, options seeding, web server, probes, tests | **us** |

The game is started the way a desktop launcher starts it: one classpath,
`net.minecraft.client.main.Main.main`, and Mojang's own argument list
(`--gameDir`, `--assetsDir`, `--assetIndex`, `--uuid`, `--accessToken`, ...).
CheerpJ's `cheerpjRunMain` takes no program arguments, so `launcher/webmc/Launcher.java`
(our jar) reads the argument list and calls Mojang's main by reflection.

## Layout

```
launcher/webmc/Launcher.java    our launcher: launch args + Mojang's main + options seeding
lwjglfix/.../APIUtil.java       our patched LWJGL 2 helper (see below)
probe/webmc/*.java              our probes: GlProbe, GlProbe2, FileProbe, CrashProbe
tools/get-vanilla.py            fetch + verify Mojang's client, libraries, assets
tools/serve.py                  the hosting this port actually requires
tools/make-manifest.py          -
tools/verify.mjs                boot the page in a real browser and assert on evidence
tools/trace.mjs                 Java thread dumps from inside the wasm JVM
tools/jstack.mjs                one-shot Java stack dump
tools/runpage.mjs               open any page/probe, capture the Java console + access log
build.sh                        compile our jars, stage the wasm LWJGL runtime, write args.txt
web/index.html, web/app/*.js    the launcher page (boot, telemetry)
web/lwjgl/                      wasm LWJGL2 runtime (gl4es.wasm, liblwjgl.so, lwjgl.js)
build/*.jar                     our jars + the patched LWJGL2 jar (committed)
data/vanilla/<ver>/             Mojang's files (fetched, gitignored)
```

## Commands

```bash
python3 tools/get-vanilla.py 1.12.2      # ~175 MB from piston-data / resources.download.minecraft.net
bash build.sh                            # needs a JDK 17 to compile our jars
python3 tools/serve.py 8780              # http://127.0.0.1:8780/?version=1.12.2
node tools/verify.mjs 1.12.2             # real-browser boot + assertions
node tools/trace.mjs 1.12.2              # Java thread dumps while it runs
node tools/runpage.mjs                   # Q="version=1.12.2&probe=gl" NAME=gl ...
```

Page query params: `?version=1.12.2` · `?theater=1` · `?log=1` (Java console on
the page) · `?probe=gl|gl2|file|crash|npe` (run one of our probes instead of the
game) · `?crashfix=0` (drop the two patched Mojang classes, to watch the failure
come back) · `?x11=0` (CheerpJ `enableX11:false`).

`tools/` also holds the diagnostic harnesses used to find the above:
`livecheck.mjs` (assert against a deployed port), `runpage.mjs` (boot a page and
copy every console line to `shots/`), `trace.mjs` (repeated Java thread dumps -
identical program counters mean a real hang, and the frame names the layer to
fix), `frames.mjs` / `dom.mjs` / `shadow.mjs` (what is actually on the page:
canvas, iframe, shadow root), `cdnreq.mjs` (which CheerpJ runtime files were
fetched), `probe_iso.mjs` (isolation state and blocked requests), `bc.mjs` and
`findcfg.mjs` (read Leaning Technologies' own working Browsercraft page and
print the `cheerpjInit` options it uses).

## Things this port had to get right (and one it didn't)

**1. Range responses must be clamped, in both directions.** CheerpJ reads files
through fixed 128 KiB windows, so it asks for `bytes=0-131071` of a 15 KiB
asset. Our server sent the right bytes but advertised the requested length, and
the JVM blocked forever in `FileInputStream.open` waiting for bytes that were
never coming. That single bug looked like a CheerpJ hang.

**2. Missing files should answer 204, not 404.** Leaning Technologies' own nginx
recipe uses `try_files $uri $uri/ =204`; a 404 in the middle of a read is what
stalls the JVM. `tools/serve.py` now answers 204 for anything under the
CheerpJ-facing root that is not there.

**3. LWJGL 2's shared scratch buffers (`org.lwjgl.opengl.APIUtil`).** The
generated bindings do

```java
IntBuffer b = APIUtil.getBufferInt(caps);
nglGenFramebuffers(1, MemoryUtil.getAddress(b), fn);   // address = base + position*4
return b.get(0);
```

and `getBufferInt` hands out a shared buffer **without rewinding it** (the byte
variant does call `clear()`). Once anything advances the position, the native
write lands past the end of the buffer. On a desktop JVM that is silent heap
corruption; under CheerpJ the wasm heap is bounds-checked and it throws
`ArrayIndexOutOfBoundsException` — which is how Mojang's client died inside
`Framebuffer.createBindFramebuffer`. Our patched copy lives in
`lwjglfix/org/lwjgl/opengl/APIUtil.java` and is injected into a copy of the
LWJGL 2 jar (`build/lwjgl-2.9.3-webmc.jar`), because LWJGL's jars seal their
packages so the class cannot come from a separate jar.

**4. `fboEnable:false`.** `OpenGlHelper.isFramebufferEnabled()` is
`capabilities && Minecraft.gameSettings.fboEnable`, and `fboEnable` is a real
Minecraft video setting. gl4es's `glGenFramebuffers` path is broken under
CheerpJ (function-pointer dispatch fails: `TypeError: a[(0+f)|0] is not a
function` inside `cj3.js`), so our launcher seeds Mojang's own `options.txt`
with `fboEnable:false` before the game starts. Mojang then takes its own no-FBO
fallback — the code path older and lower-end GPUs took. Every other key we write
is a stock `options.txt` key (`useVbo`, `fancyGraphics`, `ao`, `renderDistance`,
`renderClouds`, `lang`, ...), spelled the way Mojang's parser expects
(`fboEnable`, not `fboEnabled`).

**5. Asset index location.** Minecraft 1.12.2 reads
`<assetsDir>/indexes/1.12.json`, not the newer launcher layout
`assets/index-1.12.json`. `tools/get-vanilla.py` writes both.

**6. Cross-Origin-Embedder-Policy is our enemy, and duplicated headers hid it.**
The first version of `serve.py` called `isolation_headers()` *and* sent it again
from `end_headers()`. Browsers join duplicate headers into one value, so the
response carried `Cross-Origin-Embedder-Policy: require-corp, require-corp`,
which is invalid, which silently disabled isolation - and the port worked. When
the duplicate was removed the port stopped booting at all. With real isolation
on, CheerpJ's own OS/clipboard iframe (`https://cjrtnc.leaningtech.com/4.3/c.html`,
which it needs for file access) is a cross-origin iframe, and COEP blocks
cross-origin iframes that do not opt in: `net::ERR_BLOCKED_BY_RESPONSE`. Then
`cheerpjRunMain` never fetches a single jar and never returns, with no error
anywhere. `credentialless` does not help either. Java 8 Minecraft needs no
SharedArrayBuffer, so `serve.py` sends COOP only and says so in a comment.
`tools/livecheck.mjs` now asserts COEP is *absent*, because "COEP sent once" is
the wrong assertion here.

**7. Mojang's crash reporter assumes a deep stack, and CheerpJ gives it two
frames.** `CrashReportDetail` (class `c` in the 1.12.2 obfuscated namespace)
captures its caller with

```java
StackTraceElement[] st = Thread.currentThread().getStackTrace();
if (st.length <= 0) return 0;
this.d = new StackTraceElement[st.length - 3 - skip];   // negative under CheerpJ
```

so the reporter died while building the report, and the exception that actually
broke startup was thrown away with it. `tools/patchclass.py` rewrites that one
method body to `return 0` inside a **copy** of Mojang's jar
(`build/client-1.12.2-webmc.jar`, first on the classpath); the fetched
`client.jar` stays byte-for-byte what piston served. Patching a class inside
`client.jar` also means dropping `META-INF/*.SF` and `*.RSA`, because Mojang
signs the jar and an edited class fails its digest - which surfaces as a bare
`NoClassDefFoundError: c`, not as a signature error.

**8. CheerpJ does not catch the implicit NullPointerException from a field
read.** `probe/webmc/NpeProbe.java` runs each case on its own thread with an
uncaught-exception handler, so one uncatchable NPE does not hide the rest:

```
[npeprobe] matrix getfield=ESCAPED(java.lang.NullPointerException) | virtual=caught
           | array=caught | explicit=caught | throwable=ESCAPED | walk=NPE escaped
```

A null dereference in `getfield` walks straight past `catch (NullPointerException)`
*and* past `catch (Throwable)`, while virtual-call and array-length NPEs are
caught normally. That matters because Mojang's startup uses NPE as control flow:
`ModelBlock.checkModelHierarchy` (class `bvu`, `b(Map)`) walks a model's parent
chain and treats running off the end as an exception, with the whole walk inside
`try { ... } catch (NullPointerException e) { }`. Under CheerpJ the NPE escapes,
makes it out of `bib.aq()` and kills the game with
`NullPointerException: Initializing game at bvu.b`. So that one check - it exists
only to report model cycles - is neutralised in the same patched jar copy.
After it, the client gets all the way through model loading.

**9. CheerpJ realizes AWT windows, not the X11 window LWJGL asks for.** The
display element sat at `Graphics system is initializing` forever while GL itself
worked (`Display.create` returned, `Display.update` swapped, `renderer=GL4ES
wrapper`). The fix is to give LWJGL an AWT canvas parent instead - see
[How the window got there](#how-the-window-got-there) for the bisection that
proved it. `Display.setResizable(boolean)` is replaced with a call to
`com.webmc.AwtParent` (in `awtfix/`), which is inside the patched LWJGL jar
because it has to be loadable next to `Display`.

**10. `AssetIndex.hasResource` answers with `java.io.File.isFile()`.** Under
CheerpJ every `File.isFile()` on an `/app/` path goes out through the async
filesystem layer and back, and the client makes thousands of them while it loads
`sounds.json` and models - `tools/jstack2.mjs` spent 5 of 8 samples inside that
one call. The index is a `HashMap` from resource path to the object file, so it
already knows: `cee.b(nf)` is rewritten to `return a(nf) != null`. Checked
against an unsigned copy of the unpatched jar on a desktop JVM - same answers.
`?cee=0` selects the jar without that patch (`build/client-1.12.2-webmc-nocee.jar`)
so the two can be timed against each other.

**11. The integrated server binds a local channel to a Nio event loop.** When a
world finishes generating, 1.12.2 starts its integrated server and connects to it
over Netty's `LocalChannel`. `NetworkSystem` (class `oz`) binds a
`LocalServerChannel` but groups it with the **Nio** group, and there is no Nio
`Selector` under CheerpJ:

```
java.lang.IllegalStateException: failed to create a child event loop
    at io.netty.channel.nio.NioEventLoopGroup.<init>
    at oz$1.a -> rh.c -> oz.a -> bib.a -> boi.a -> blk.q -> bib.t
Description: Updating screen events
```

Mojang already has the pure-Java `LocalEventLoopGroup` in the same class (field
`c`); the client side of the same connection already uses it. So the fix is one
constant: that `getstatic oz.a` becomes `getstatic oz.c`, which is what
`--fieldref a c` in `tools/patchclass.py` does - it walks the method's bytecode
and rewrites the operand, keeping the class file the same length.

**12. 64 MB of direct buffer memory is not enough for a world.** Once the world
finished generating and chunk rendering started, the client died with
`OutOfMemoryError: Direct buffer memory` inside `java.nio.Bits.reserveMemory`.
Mojang allocates a direct `ByteBuffer` per chunk section it builds geometry for
(`ByteBufferUtils`, class `bia`, method `c(int)`), and the cap is
`-XX:MaxDirectMemorySize`, which defaults to the max heap and is read from the
VM once at boot. CheerpJ reports a 2 GiB heap but a 64 MiB direct cap, and there
is no VM flag to hand it. So `Launcher.raiseDirectMemory()` sets the field
`java.nio.Bits` itself reads (`maxMemory`; the getter is `VM.maxDirectMemory()`,
so both spellings are tried) and marks `memoryLimitSet` so the VM value does not
come back:

```
[webmc] heap max=2147483648 total=2147483648
[webmc] maxDirectMemory 67108864 -> 2147483648
```

## Where it stands

Working, with evidence from the unmodified client's own log:

```
[webmc] java=1.8.0_492-internal vm=CheerpJ
[webmc] 18 launch arguments ...
[webmc] resolved net.minecraft.client.main.Main from file:/app/data/vanilla/1.12.2/client.jar
[11:53] [Client thread/INFO]: Setting user: browsermc
[11:53] [Client thread/INFO]: LWJGL Version: 2.9.3
[11:53] [Sound Library Loader/INFO]: Could not locate OpenAL library.
[11:53] [Thread-7/INFO]: Switching to No Sound  (Silent Mode)
[11:53] [Sound Library Loader/INFO]: Sound engine started
[11:53] [Client thread/INFO]: Reloading ResourceManager: Default
```

plus ~2500 Range requests streaming Mojang's jars and asset objects, the GL
context created through gl4es (`vendor=ptitSeb glversion=2.1 gl4es wrapper 1.1.6`),
and `options.txt` / `resourcepacks` / `saves` created in CheerpJ's persistent
`/files/minecraft`.

Working further now, after the two patched classes:

```
[14:21:56] [Client thread/INFO]: Setting user: browsermc
[14:21:5x] [Client thread/INFO]: LWJGL Version: 2.9.3
[14:22:52] [Sound Library Loader/INFO]: Sound engine started
[14:22:59] [Client thread/INFO]: Created: 1024x512 textures-atlas
[14:23:03] [Client thread/WARN]: Failed to load shader: minecraft:shaders/post/entity_outline.json
           nj: Invalid shaders/program/blur.fsh: Couldn't compile fragment program:
           ERROR: 0:21: 'r' : Loop index cannot be initialized with non-constant expression
```

`Created: 1024x512 textures-atlas` is the whole model + texture-stitching
pipeline, and the crash report Mojang now writes names the real failure instead
of its own internals:

```
java.lang.NullPointerException: Initializing game
    at bvu.b(Unknown Source)        <- ModelBlock.checkModelHierarchy
    at cgb.l(Unknown Source)        <- ModelLoader
    at cgc.a(Unknown Source) / cev.a(Unknown Source)
    at bib.aq(Unknown Source) / bib.a(Unknown Source)
    at net.minecraft.client.main.Main.main(Unknown Source)
```

Still not working: **nothing is drawn.** The display element stays at
`data-status="Graphics system is initializing"` and no `<canvas>` ever appears
anywhere in the document, so there are no pixels to compare. That is not the
client's fault: `probe/webmc/GlProbe2.java` calls `Display.setDisplayMode` and
`Display.create(PixelFormat)` directly and they succeed
(`renderer=GL4ES wrapper`, `GL_DEPTH_BITS=24`), and CheerpJ does fetch
`x11.wasm`, `cheerpj-awt.jar` and the font/fontconfig data from its CDN. The
GL context exists; the window that should carry it does not.

### How the window got there

That last paragraph was the blocker, and it took a bisection against Leaning
Technologies' own working demo to find. The chain of evidence:

1. `tools/bcrun.mjs` drives `browsercraft.cheerpj.com` (CheerpJ 4.3, LWJGL 2.9.3,
   gl4es, Minecraft 1.2.5). Its DOM gains `div.cjWindow cjBordered` containing
   `canvas.cjSwapped`. Ours never gained a `.cjWindow` at all.
2. `web/bc.html` + `web/app/bc.js` transcribe Browsercraft's `cheerpjInit`
   options - including its whole `preloadResources` table - onto **our** hosting
   and get the same window. So our hosting and init were never the problem.
3. `?mc=1.2.5` runs Minecraft 1.2.5 through **our** boot path and gets the same
   window. So the difference is the game, not the page.
4. `probe/webmc/GlProbe4.java` repeats Minecraft 1.2.5's display calls call for
   call (`setDisplayMode(854x480)` -> `setTitle` -> `create(withDepthBits(24))`)
   and gets **no** window. So it is not the display calls either.
5. `probe/webmc/GlProbe6.java` makes a plain `java.awt.Frame` visible and **that
   does** produce `div.cjWindow` + `canvas.cjSwapped`. CheerpJ realizes AWT
   peers as DOM; the `cjWindow`/`cjSwapped` classes live in
   `com/leaningtech/cheerpj/CheerpJWindowPeer.class` and `CheerpJRasterPeer.class`
   inside `cheerpj-awt.jar`.
6. `probe/webmc/GlProbe7.java` calls `Display.setParent(Canvas)` and the whole
   window appears - the same DOM shape the demo gets. CheerpJ's wasm `liblwjgl`
   implements the AWTGL entry points (`Java_org_lwjgl_opengl_AWTSurfaceLock_*`,
   `LinuxAWTGLCanvasPeerInfo_nInitHandle`, `LinuxDisplay_nLockAWT`), so the AWT
   parent path is real; it is the plain X11 route that never realizes.

So the display is parented to an AWT canvas. The hook is a body replacement on
`Display.setResizable(boolean)`: Minecraft 1.12.2 calls it immediately before
`setTitle`/`create`, which is exactly the right moment, and it is reachable with
one method-body patch instead of bytecode surgery inside `create()`.
`awtfix/com/webmc/AwtParent.java` is the helper; `--static` in
`tools/patchclass.py` appends the two constant pool entries and rewrites the body.

The result, from a real browser against the local server:

```
[19:44:06] [Client thread/INFO]: [STDOUT]: [webmc] AwtParent: LWJGL display parented to an AWT canvas 854x480
```

and the screenshot shows Mojang's own splash, then Mojang's own main menu:
Singleplayer / Multiplayer / Minecraft Realms / Options / Quit Game, the "Deja Vu"
splash text, "Minecraft 1.12.2" and "Copyright Mojang AB. Do not distribute!".

Past the menu, the client generates a world and then renders it:

```
t+36s   window (div.cjWindow + canvas.cjSwapped)
t+125s  Mojang's own main menu
t+133s  click Singleplayer      -> screen changes
t+174s  click Create New World  -> screen changes
t+215s  click Create New World  -> "Loading world / Building terrain"
t+383s  in world (luma 149)
t+384s  mouse look right        -> screen changes
t+391s  mouse look down         -> screen changes
t+398s  W                       -> screen changes
```

`shots/play-09-w9.png` is the payoff: sky, ocean, a mountain, grass, the
crosshair, a full health bar, the hunger bar, the hotbar and Mojang's own
"Move with W, A, S and D / Jump with SPACE" toast - all drawn by Mojang's
bytecode through gl4es, with no canvas reimplementation anywhere in between.

The integrated server is not keeping up:

```
[Server thread/WARN]: Can't keep up! Did the system time change, or is the
server overloaded? Running 6721ms behind, skipping 134 tick(s)
```

That is an interpreted 1.12.2 on a WebAssembly JVM, so it is the honest cost of
this route rather than a bug to file.

What is left:

- **Waiting on it.** An interpreted 1.12.2 takes 2-12 minutes to reach its own
  menu on this machine depending on what else is running, and world generation
  outlasts that. `tools/playtest.mjs` therefore waits on evidence rather than
  sleeps: Mojang's own `Changing view distance to 6` line is the marker that a
  world is up, and luminance of the game area separates the loading pan from
  sky and terrain.
- **A crash that was fixed by loading one class earlier.** Sitting in a loaded
  world, the client used to die about 90 s later with
  `java.lang.NoClassDefFoundError: java/awt/image/DataBufferInt`, immediately
  after gl4es logged `ReadPixels error: (GL_BGRA, UNSIGNED_BYTE -> ...)`.
  CheerpJ prints no frames for it, and Mojang's own crash report - read back
  out of the persistent filesystem by `probe/webmc/CrashDump.java` - carries no
  stack either, so the report names the class but not the call site. The only
  class in Mojang's 1.12.2 that touches `DataBufferInt` is `buz` (`NativeImage`),
  whose `a(BufferedImage)` does `getRaster().getDataBuffer()` then `checkcast
  DataBufferInt` - the framebuffer-readback / level-icon path. The same calls
  work from a probe at startup (`probe/webmc/AwtImageProbe.java`), so the
  failure is contextual rather than a missing class: by the time the game makes
  that call, the GL and AWT threads exist. `Launcher` now forces the path to
  initialize on its own thread before Minecraft starts:
  ```text
  [webmc] pre-loaded java.awt.image.DataBufferInt raster=java.awt.image.DataBufferInt
  ```
  and the run that follows stayed in a loaded world for over six minutes with
  no crash, where every earlier run died inside 100 s.
- **Saving works; rejoining is still flaky in the harness.**
  `probe/webmc/PersistProbe.java` writes a marker under `/files/minecraft` and
  `tools/persisttest.mjs` reloads the page in the same tab: the second load
  reads the first run's bytes back, so CheerpJ's IndexedDB-backed filesystem
  does survive a reload. Note that two *separate* browser launches on
  different ports are different origins and therefore different IndexedDB
  stores - that is why an earlier version of this test looked like saves were
  vanishing. `tools/playtest.mjs` now drives the reload itself
  (`reload;waittitle;...`) and the world list is found by shape with
  `tools/findbuttons.py` rather than by fixed coordinates, because the CheerpJ
  window height changes between runs.
- **Sound.** `Unable to initialize OpenAL. Probable cause: OpenAL not supported.`
  The client falls back to its own silent mode. Leaning Technologies' own
  Minecraft demo has the same limitation - Browsercraft ships no OpenAL.
- **`blur.fsh`.** gl4es's GLSL front end rejects the loop in Mojang's
  `shaders/program/blur.fsh` (`Loop index cannot be initialized with
  non-constant expression`), so the `entity_outline` post-processing effect
  fails to load. It is a warning, not a crash.
- **Realms** tries to reach `pc.realms.minecraft.net` and is blocked by CORS.
- **Frame rate.** `tools/fps.mjs` counts frames by wrapping the GL flush, and
  measures about 13 fps on the 1.2.5 control target. 1.12.2 is slower still,
  and the integrated server says so: `Can't keep up! ... Running 6721ms
  behind, skipping 134 tick(s)`.

### What the large browser ports do, and what this one took from them

The GTA V port that made the rounds in October 2026 is worth reading as a
teardown rather than a demo: RAGE and the game's own code compiled to **wasm64**
(one 63 MB `game.wasm`, 91k functions still carrying `rage::` names), 75 real
threads on a shared 3 GB / 16 GB linear memory, Direct3D 11 recorded into a
32 MB ring buffer and replayed by a worker that owns the WebGPU device, 4,919
DXBC shaders translated ahead of time into WGSL, and 20.9 GB of untouched
Rockstar game data that never ships - the tab pulls 4 KB blocks of it with
HTTP Range requests into an append-only Origin Private File System store. Its
own numbers: 582 MB of recorded boot reads, 743 MB before the world appeared,
world up at 188 s and 2,736 draw calls per frame at 0.3 fps on SwiftShader.

Four of its techniques transfer to a Java game and are in this port:

| What it does | Here |
|---|---|
| A progress bar driven by regular expressions against lines the engine has always printed - nothing in RAGE reports progress | `boot.js` maps Mojang's own `Setting user`, `LWJGL Version`, `textures-atlas`, `Starting game` and `Preparing spawn area: NN%` lines onto the bar |
| `data/bootset.json`: the byte ranges a real boot actually read, prefetched in parallel | `web/bootset-1.12.2.json`, generated by `tools/make-bootset.py` out of the server's access log (1113 files, 1263 block requests) and handed to CheerpJ as its preload table |
| Engine files cached for a year, game URLs versioned so a URL always means the same bytes | asset objects are named by their own SHA-1 and served `immutable`; everything else carries an ETag, because a patched jar must never go stale |
| Eight retries with a doubling, jittered wait against a host that answers 503 when it is overloaded | CheerpJ's `fetch` is ours now, with the same shape - a free tier that is spinning up would otherwise become a stalled JVM with no error anywhere |

What does not transfer is the shape of the compute. That port owns its binary:
threads, shared memory, ahead-of-time shader translation. CheerpJ gives one
JVM on the page's main thread, a GL 2.1 -> GLES translation layer instead of
WebGPU, and no ahead-of-time path for a jar it has never seen. Enabling COEP
for `SharedArrayBuffer` is not free either: CheerpJ renders its window inside a
cross-origin iframe that COEP then blocks (see `isolation_headers` in
`tools/serve.py`).

The lesson that did transfer is the one its source comments keep repeating: at
this scale the cost is not compute, it is **many small file reads**. That is
exactly what the `AssetIndex.hasResource` patch and the boot set attack.

### Version notes

* 1.12.2 is the newest target that fits this stack: Java 8 and **LWJGL 2**.
* 1.16.5 (also Java 8) uses **LWJGL 3 + GLFW**, for which CheerpJ's community
  runtime ships no wasm equivalent — that is a separate, larger problem.
* Mojang's 1.12.2 declares LWJGL `2.9.4-nightly-20150209`, whose
  `Display.create(PixelFormat, DisplayMode[])` overload does not exist in the
  2.9.3 jars whose wasm native we run against. Both jar sets were tried; the
  framebuffer failure is identical, so it is the runtime, not the jar set.

## Licensing / redistribution

* Mojang's client, libraries and assets are **fetched, never committed**
  (`data/` is gitignored; Render re-fetches them at build time).
* CheerpJ is used under its community licence (personal / non-commercial).
* `web/lwjgl/` and `build/lwjgl-2.9.3-webmc.jar` come from Leaning
  Technologies' `browsercraft` (LWJGL 2 is BSD-3-Clause, gl4es MIT); our only
  change to them is the `APIUtil` patch.
* The `vendor/` clones (browsercraft, cheerpj-meta) are reference material and
  are not committed.
