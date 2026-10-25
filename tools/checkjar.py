#!/usr/bin/env python3
"""Prove the deployed patched client jar carries every patch, not just some.

serve.py regenerates this jar at boot, and it used to run a two-step copy of
tools/patch-client.sh that had silently drifted from the real script: Render
served a jar with the crash-report patch but without the Netty and AssetIndex
ones, so a generated world died the moment it finished loading while every
local run was fine. Comparing the patched classes by hash catches that.

    python3 tools/checkjar.py https://browser-minecraft-official.onrender.com 1.12.2
"""
import hashlib
import sys
import urllib.request
import zipfile

CLASSES = ["c.class", "oz.class", "bvu.class", "cee.class"]


def entries(blob):
    import io
    z = zipfile.ZipFile(io.BytesIO(blob))
    return {n: hashlib.sha1(z.read(n)).hexdigest() for n in CLASSES if n in z.namelist()}


def main():
    base = sys.argv[1].rstrip("/")
    ver = sys.argv[2] if len(sys.argv) > 2 else "1.12.2"
    url = "%s/client-%s-webmc.jar" % (base, ver)
    local = "build/client-%s-webmc.jar" % ver
    remote = entries(urllib.request.urlopen(url, timeout=60).read())
    with open(local, "rb") as f:
        want = entries(f.read())
    bad = [n for n in want if remote.get(n) != want[n]]
    for n in CLASSES:
        print("%-12s local=%s remote=%s %s" % (n, want.get(n, "-")[:12], remote.get(n, "-")[:12],
                                               "ok" if n not in bad else "DIFFERS"))
    if bad:
        print("FAIL: %s does not match the locally built patched jar" % url)
        return 1
    print("ok: every patched class on %s matches the local build" % base)
    return 0


if __name__ == "__main__":
    sys.exit(main())
