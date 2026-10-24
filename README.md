# browser-minecraft-official

Running **Mojang's own, unmodified Minecraft client** in a browser, built from
scratch: no third-party browser port of Minecraft is used here, and nothing in
this repository is a reimplementation of the game.

Target version: **Minecraft 1.12.2** (Java 8, LWJGL 2).

Status: **the game boots and initialises; it does not reach the title screen
yet.** Details under [Where it stands](#where-it-stands).

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
the page) · `?probe=gl|gl2|file|crash` (run one of our probes instead of the game).

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

Not working: `Minecraft.init()` throws somewhere after the resource manager
loads, and **the original exception is hidden** because Mojang's own crash
reporter fails under CheerpJ: `Thread.getAllStackTraces()` returns an empty map
and `Thread.currentThread().getStackTrace()` returns only 2 frames, and
`CrashReportDetail` depends on both. So the failure surfaces as
`NullPointerException at c.a <- b.a <- b.a <- bib.a` (crash-report internals)
instead of the real cause. Our `probe/webmc/CrashProbe.java` confirms the
crash-report classes work when driven directly, so this is thread-introspection
specific, not a general crash-report failure.

That is the next thing to attack: get Mojang's original throwable visible (the
report never gets written, so there is no `crash-reports/*.txt` to read), then
fix whatever the actual failure is.

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
