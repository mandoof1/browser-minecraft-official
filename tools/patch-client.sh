#!/usr/bin/env bash
# Build the patched copy of Mojang's client jar. Pure Python (tools/patchclass.py
# parses class files itself), so this runs on a plain python deploy host with no
# JDK - which is why the jar is generated here instead of committed.
#
#   1. CrashReportDetail's stack capture  -> return 0
#      (CheerpJ hands Thread.getStackTrace() two frames; Mojang sizes an array
#       from its length and goes negative, and the crash reporter then throws
#       away the exception that actually broke startup.)
#   2. AssetIndex.hasResource            -> answer from the index map
#      (Mojang asks the index whether a resource exists, and the index answers
#       with java.io.File.isFile(). Under CheerpJ every File.isFile() on an /app/
#       path goes out through the async filesystem layer and back, and the game
#       makes thousands of those calls while it loads sounds.json and models.
#       The index already knows the answer: it is a HashMap from resource path
#       to the object file. Same truth, no filesystem round trip.)
#   3. ModelBlock.checkModelHierarchy    -> no-op
#      (Mojang uses an implicit NullPointerException as normal parent-chain
#       termination; CheerpJ does not catch that one at all, so it escapes and
#       kills the game. See probe/webmc/NpeProbe.java.)
#
# Mojang's fetched client.jar is left byte-for-byte as piston served it.
set -euo pipefail
cd "$(dirname "$0")/.."
VER="${VER:-1.12.2}"
V="data/vanilla/$VER"
[ -f "$V/client.jar" ] || { echo "no $V/client.jar - run tools/get-vanilla.py $VER first"; exit 1; }
mkdir -p build
python3 tools/patchclass.py "$V/client.jar" build/client.tmp.jar c.class a "(I)I" --const0
python3 tools/patchclass.py build/client.tmp.jar "build/client-$VER-webmc-nocee.jar" bvu.class b "(Ljava/util/Map;)V" --const0
python3 tools/patchclass.py build/client.tmp.jar build/client.tmp2.jar cee.class b "(Lnf;)Z" --nonnull cee a "(Lnf;)Ljava/io/File;"
python3 tools/patchclass.py build/client.tmp2.jar "build/client-$VER-webmc.jar" bvu.class b "(Ljava/util/Map;)V" --const0
rm -f build/client.tmp2.jar
rm -f build/client.tmp.jar
echo "[patch-client] build/client-$VER-webmc.jar"
