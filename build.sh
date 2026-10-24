#!/usr/bin/env bash
# Build the pieces that are ours. The game itself is never built here: it is
# Mojang's own client.jar, fetched by tools/get-vanilla.py.
#
#   1. webmc-launcher.jar  - our launcher (see launcher/webmc/Launcher.java):
#      it turns Mojang's launch plan into a call to Mojang's own main class.
#   2. args.txt per version - the argument list, one per line, that a desktop
#      launcher would put on the command line.
set -euo pipefail
cd "$(dirname "$0")"

JDK="${JAVA_HOME:-}"
if [ -z "$JDK" ]; then
  for d in /usr/lib/jvm/java-17-openjdk /usr/lib/jvm/java-17 /usr/lib/jvm/default; do
    [ -x "$d/bin/javac" ] && JDK="$d" && break
  done
fi
[ -n "$JDK" ] || { echo "need a JDK (17) to compile the launcher"; exit 1; }

rm -rf build/classes
mkdir -p build/classes
# --release 8 because that is what Mojang's own 1.12.2/1.16.5 class files are;
# the launcher has to load under the same JVM level CheerpJ runs the game on.
"$JDK/bin/javac" --release 8 -d build/classes launcher/webmc/Launcher.java
"$JDK/bin/jar" --create --file build/mc-launcher.jar --main-class webmc.Launcher -C build/classes .
echo "[build] build/mc-launcher.jar"

# one argument per line, next to the plan that produced it
for pj in data/vanilla/*/plan.json; do
  python3 - "$pj" <<'PY'
import json,os,sys
pj=sys.argv[1]
plan=json.load(open(pj))
with open(os.path.join(os.path.dirname(pj),'args.txt'),'w') as f:
    f.write('\n'.join(plan['args'])+'\n')
print('[build] %s -> %s (%d args)' % (pj, os.path.join(os.path.dirname(pj),'args.txt'), len(plan['args'])))
PY
done

# our GL probe: calls the same LWJGL2 entry points Mojang's client hangs on
LW="$(pwd)/vendor/browsercraft/static/lwjgl"
LWJ="$LW/lwjgl-2.9.3.jar:$LW/lwjgl_util-2.9.3.jar"
mkdir -p build/probeclasses
"$JDK/bin/javac" --release 8 -cp "$LWJ" -d build/probeclasses probe/webmc/GlProbe.java probe/webmc/FileProbe.java probe/webmc/CrashProbe.java probe/webmc/GlProbe2.java probe/webmc/NpeProbe.java probe/webmc/GlProbe3.java probe/webmc/GlProbe4.java probe/webmc/GlProbe6.java probe/webmc/GlProbe7.java 2>&1 | head -5
"$JDK/bin/jar" --create --file build/probe.jar --main-class webmc.GlProbe -C build/probeclasses .
echo "[build] build/probe.jar"

# Two fixes live inside a copy of Leaning Technologies' LWJGL 2 jar (their jars
# seal org.lwjgl.*, so a patched class cannot come from a separate jar):
#
# 1. org.lwjgl.opengl.APIUtil - its shared scratch buffers from getBufferInt /
#    getBufferLong / getBufferFloat / getBufferDouble are handed back without
#    rewinding, so the next native call writes past the end. A desktop JVM lets
#    that corrupt the heap; CheerpJ's WebAssembly heap is bounds-checked and
#    throws ArrayIndexOutOfBoundsException on the second glGenFramebuffers.
# 2. org.lwjgl.opengl.Display.setResizable(boolean) - Minecraft 1.12.2 calls it
#    just before setTitle/create, which is the right moment to hand LWJGL an AWT
#    canvas parent (com.webmc.AwtParent). CheerpJ realizes AWT peers as DOM but
#    never realizes the X11 window Minecraft asks for, so without a parent the
#    display element stays at "Graphics system is initializing" forever.
mkdir -p build/fixclasses build/awtclasses
"$JDK/bin/javac" --release 8 -cp "$LW/lwjgl-2.9.3.jar" -d build/fixclasses lwjglfix/org/lwjgl/opengl/APIUtil.java 2>&1 | head -5
"$JDK/bin/javac" --release 8 -cp "$LW/lwjgl-2.9.3.jar" -d build/awtclasses awtfix/com/webmc/AwtParent.java 2>&1 | head -5
cp "$LW/lwjgl-2.9.3.jar" build/lwjgl.tmp.jar
(cd build/fixclasses && "$JDK/bin/jar" --update --file ../lwjgl.tmp.jar org/lwjgl/opengl/APIUtil.class)
(cd build/awtclasses && "$JDK/bin/jar" --update --file ../lwjgl.tmp.jar com/webmc/AwtParent.class)
python3 tools/patchclass.py build/lwjgl.tmp.jar build/lwjgl-2.9.3-webmc.jar \
  org/lwjgl/opengl/Display.class setResizable "(Z)V" \
  --static com/webmc/AwtParent attach "(Z)V"
rm -f build/lwjgl.tmp.jar

# A second copy with Display.setIcon(ByteBuffer[]) dropped as well, for A/B
# (?lwjgl=v2): it is the other display call 1.12.2 makes and 1.2.5 does not.
python3 tools/patchclass.py build/lwjgl-2.9.3-webmc.jar build/lwjgl.tmp.jar \
  org/lwjgl/opengl/Display.class setIcon "([Ljava/nio/ByteBuffer;)I" --const0
mv -f build/lwjgl.tmp.jar build/lwjgl-2.9.3-webmc2.jar
echo "[build] build/lwjgl-2.9.3-webmc.jar (APIUtil rewind + AWT parenting; v2 also drops setIcon)"

# A patched copy of Mojang's client jar (two classes; tools/patch-client.sh says
# why). Generated, never committed: it is Mojang's bytes plus two method bodies.
bash tools/patch-client.sh

# Stage the WebAssembly GL/LWJGL runtime that CheerpJ loads for Mojang's LWJGL 2
# jars (Minecraft up to 1.12.2 uses LWJGL 2). Leaning Technologies' browsercraft
# ships it: gl4es does OpenGL->WebGL, plus their wasm build of liblwjgl.
# Committed under web/lwjgl so the deployed app needs no vendor checkout.
SRC="$PWD/vendor/browsercraft/static/lwjgl"
if [ -d "$SRC" ]; then
  mkdir -p web/lwjgl/libraries
  cp -f "$SRC/lwjgl-2.9.3.jar" "$SRC/lwjgl_util-2.9.3.jar" web/lwjgl/
  cp -f "$SRC"/libraries/* web/lwjgl/libraries/ 2>/dev/null || true
  echo "[build] staged web/lwjgl: $(du -sh web/lwjgl | cut -f1) (LWJGL2 wasm runtime from browsercraft)"
else
  echo "[build] WARNING: vendor/browsercraft/static/lwjgl missing (git clone it first)"
fi
