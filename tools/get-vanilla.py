#!/usr/bin/env python3
"""get-vanilla.py - fetch a real Mojang client, unmodified.

Nothing here is a port of Minecraft: this is Mojang's own distribution
metadata (piston-meta), Mojang's own client jar, Mojang's own libraries and
Mojang's own asset objects, all verified against Mojang's own SHA-1 hashes.
The browser layer is what we write; the game bytes are Mojang's.

  python3 tools/get-vanilla.py 1.12.2
  python3 tools/get-vanilla.py 1.16.5

Layout written under data/vanilla/<version>/ (never committed - Mojang's EULA
does not let us redistribute the game):

  client.jar                 the official client, byte for byte
  libraries/*.jar            the libraries the version json declares for linux
  natives/*.so               the native libraries (lwjgl, glfw, stb, ...)
  assets/objects/ab/cdef...  every object the asset index names
  assets/index-<id>.json     the asset index itself
  plan.json                  classpath, main class, launch args, hashes

`plan.json` is what the browser launcher reads. It is the same information a
desktop launcher turns into a command line, so the game is started the way
Mojang starts it.
"""
import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
MANIFEST = os.path.join(DATA, "manifest.json")

# What CheerpJ's JVM reports as its OS/arch pair. Keeping this aligned with the
# version json's rules is what makes Mojang's own "linux" libraries the ones we
# pick up, with no patching of the game.
OS_NAME = "linux"
ARCH = "x86_64"


def fetch(url, dest=None, sha1=None):
    req = urllib.request.Request(url, headers={"User-Agent": "browser-minecraft-official/0.1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = r.read()
    if sha1:
        got = hashlib.sha1(body).hexdigest()
        if got != sha1:
            raise SystemExit("sha1 mismatch for %s: got %s want %s (%s)" % (url, got, sha1, dest))
    if dest:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(body)
    return body


def rules_allow(rules):
    """Mojang's own allow/deny rules, evaluated the way a launcher does."""
    if not rules:
        return True
    allowed = False
    for r in rules:
        action = r.get("action")
        ok = True
        if "os" in r:
            ok = ok and r["os"].get("name") in (OS_NAME, "linux")
        if "features" in r:
            ok = False  # is_demo/has_storage etc. are not set for us
        allowed = (action == "allow") if ok else allowed
    return allowed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("version")
    ap.add_argument("--assets-only-missing", action="store_true", default=True)
    a = ap.parse_args()

    if not os.path.isfile(MANIFEST):
        fetch("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json", MANIFEST)
    man = json.load(open(MANIFEST))
    hits = [v for v in man["versions"] if v["id"] == a.version]
    if not hits:
        raise SystemExit("version %s not in Mojang's manifest" % a.version)
    ver = json.loads(fetch(hits[0]["url"]))
    out = os.path.join(DATA, "vanilla", a.version)
    os.makedirs(out, exist_ok=True)
    json.dump(ver, open(os.path.join(out, "version.json"), "w"), indent=1)

    print("== %s ==  mainClass=%s java=%s" % (a.version, ver["mainClass"], ver["javaVersion"]["majorVersion"]))

    # 1. the client jar, exactly as Mojang ships it
    dl = ver["downloads"]["client"]
    client = os.path.join(out, "client.jar")
    if not (os.path.isfile(client) and os.path.getsize(client) == dl["size"]):
        fetch(dl["url"], client, dl["sha1"])
    print("client.jar %d bytes sha1=%s" % (os.path.getsize(client), dl["sha1"]))

    # 2. libraries, with Mojang's own OS rules
    classpath, natives = [], []
    for lib in ver["libraries"]:
        name = lib["name"]
        allow = rules_allow(lib.get("rules"))
        art = lib.get("downloads", {}).get("artifact")
        if allow and art:
            path = os.path.join(out, "libraries", art["path"].split("/")[-1])
            if not (os.path.isfile(path) and os.path.getsize(path) == art["size"]):
                fetch(art["url"], path, art["sha1"])
            classpath.append(("libraries/" + os.path.basename(path), art["size"], art["sha1"]))
        nat = lib.get("downloads", {}).get("classifiers", {}).get("natives-linux")
        if allow and nat:
            path = os.path.join(out, "natives", "natives-linux.jar")
            if not os.path.isfile(path):
                fetch(nat["url"], path, nat["sha1"])
            natives.append(name)
    print("libraries: %d jars, natives for: %s" % (len(classpath), " ".join(n.split(":")[-1] for n in natives)))

    # 3. assets: every object the index names, in Mojang's own layout
    ai = ver["assetIndex"]
    index = json.loads(fetch(ai["url"]))
    os.makedirs(os.path.join(out, "assets", "indexes"), exist_ok=True)
    # Mojang's client reads the index from <assetsDir>/indexes/<id>.json, which is
    # the layout the desktop launcher uses; keep a copy at index-<id>.json too.
    idx_path = os.path.join(out, "assets", "indexes", "%s.json" % ai["id"])
    json.dump(index, open(idx_path, "w"))
    json.dump(index, open(os.path.join(out, "assets", "index-%s.json" % ai["id"]), "w"))
    objects = index["objects"]
    total = sum(o["size"] for o in objects.values())
    objects = {k: {"sha1": o.get("sha1") or o.get("hash"), "size": o["size"]} for k, o in objects.items()}
    print("asset index %s: %d objects, %.1f MiB" % (ai["id"], len(objects), total / 1048576.0))

    def get_object(h, size):
        dest = os.path.join(out, "assets", "objects", h[:2], h)
        if os.path.isfile(dest) and os.path.getsize(dest) == size:
            return None
        url = "https://resources.download.minecraft.net/%s/%s" % (h[:2], h)
        fetch(url, dest, h)
        return size

    with cf.ThreadPoolExecutor(max_workers=16) as ex:
        futs = [ex.submit(get_object, o["sha1"], o["size"]) for o in objects.values()]
        done = 0
        for f in cf.as_completed(futs):
            f.result()
            done += 1
            if done % 200 == 0:
                print("   assets %d/%d" % (done, len(objects)))
    print("assets: all %d objects present" % len(objects))

    # 4. the launch plan a desktop launcher would build
    args = [
        "--username", "browsermc",
        "--version", a.version,
        "--gameDir", "/files/minecraft",
        "--assetsDir", "/app/data/vanilla/%s/assets" % a.version,
        "--assetIndex", ai["id"],
        "--uuid", "0bce0e00b0e04b0a90e0b0e0b0e0b0e0",
        "--accessToken", "0",
        "--userType", "legacy",
        "--versionType", "release",
    ]
    plan = {
        "version": a.version,
        "mainClass": ver["mainClass"],
        "javaMajor": ver["javaVersion"]["majorVersion"],
        "assetIndex": ai["id"],
        "classpath": ["mc-launcher.jar"] + [c[0] for c in classpath] + ["client.jar"],
        "args": args,
        "clientSha1": dl["sha1"],
        "clientSize": dl["size"],
        "assetObjects": len(objects),
        "assetBytes": total,
        "totalJarBytes": sum(c[1] for c in classpath) + dl["size"],
        # Per-entry sizes, so the browser can hand CheerpJ a preload table
        # (path -> block offsets) without asking the server how big each jar is.
        "jarSizes": dict([(c[0], c[1]) for c in classpath] + [("client.jar", dl["size"])]),
    }
    json.dump(plan, open(os.path.join(out, "plan.json"), "w"), indent=1)
    print("plan.json written: %d classpath entries, %.1f MiB of jars"
          % (len(plan["classpath"]), plan["totalJarBytes"] / 1048576.0))


if __name__ == "__main__":
    main()
