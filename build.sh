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
"$JDK/bin/javac" --release 8 -cp "$LWJ" -d build/probeclasses probe/webmc/GlProbe.java probe/webmc/FileProbe.java probe/webmc/CrashProbe.java probe/webmc/GlProbe2.java probe/webmc/NpeProbe.java 2>&1 | head -5
"$JDK/bin/jar" --create --file build/probe.jar --main-class webmc.GlProbe -C build/probeclasses .
echo "[build] build/probe.jar"

# Our patched copy of LWJGL 2's package-private scratch-buffer helper, injected
# into a copy of the LWJGL 2 jar (LWJGL's jars seal their packages, so the class
# cannot come from a separate jar).
mkdir -p build/fixclasses
"$JDK/bin/javac" --release 8 -cp "$LW/lwjgl-2.9.3.jar" -d build/fixclasses lwjglfix/org/lwjgl/opengl/APIUtil.java 2>&1 | head -5
cp "$LW/lwjgl-2.9.3.jar" build/lwjgl-2.9.3-webmc.jar
(cd build/fixclasses && "$JDK/bin/jar" --update --file ../lwjgl-2.9.3-webmc.jar org/lwjgl/opengl/APIUtil.class)
echo "[build] build/lwjgl-2.9.3-webmc.jar (org.lwjgl.opengl.APIUtil rewind fix inside)"

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
  cp -f "$SRC/lwjgl_util-2.9.3.jar" web/lwjgl/
  cp -f "$SRC"/libraries/* web/lwjgl/libraries/ 2>/dev/null || true
  echo "[build] staged web/lwjgl: $(du -sh web/lwjgl | cut -f1) (LWJGL2 wasm runtime from browsercraft)"
else
  echo "[build] WARNING: vendor/browsercraft/static/lwjgl missing (git clone it first)"
fi
