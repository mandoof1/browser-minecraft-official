#!/usr/bin/env python3
"""Write the list of asset objects, as CheerpJ-facing paths, for AssetProbe.

Mojang's asset index already names every object; this just flattens it into
the path the client will actually open, one per line.
"""
import json
import os
import sys

ver = sys.argv[1] if len(sys.argv) > 1 else "1.12.2"
root = os.path.join("data", "vanilla", ver)
plan = json.load(open(os.path.join(root, "plan.json")))
index = json.load(open(os.path.join(root, "assets", "indexes", plan["assetIndex"] + ".json")))
out = os.path.join(root, "objects.txt")
n = 0
with open(out, "w") as f:
    for entry in index["objects"].values():
        h = entry.get("sha1") or entry["hash"]
        f.write("/app/data/vanilla/%s/assets/objects/%s/%s\n" % (ver, h[:2], h))
        n += 1
print("[objects] %s: %d paths" % (out, n))
