#!/usr/bin/env python3
"""Record what a real boot actually reads, and hand that list back to the browser.

An unmodified client asks for what it asks for; guessing is not a strategy. So
this takes the access log of a real session (the OPEN lines tools/serve.py
writes) and turns it into the exact preload table CheerpJ wants: virtual path
-> the block offsets that were actually requested. Prefetching those is not a
guess, it is a replay of a boot that already happened.

This is the same shape as the GTA V browser port's data/bootset.json, which
lists the byte ranges the engine reads while booting so the IO worker can pull
them in parallel instead of one at a time.

    python3 tools/make-bootset.py evidence/play33-inworld-12min.log 1.12.2
"""
import json
import os
import re
import sys

OPEN = re.compile(r"OPEN (?:GET|HEAD) (\S+) range=(?:bytes=(\d+)-)?")


def main():
    log, ver = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "1.12.2")
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    blocks = {}
    for line in open(log, errors="replace"):
        m = OPEN.search(line)
        if not m:
            continue
        path, start = m.group(1), m.group(2)
        if path.startswith("/telemetry") or path == "/favicon.ico":
            continue
        # resolve() maps /app/... onto this origin's root, so the virtual path
        # CheerpJ wants is the URL path itself.
        key = path if path.startswith('/app/') else '/app' + path
        blocks.setdefault(key, set()).add(int(start or 0))
    out = {p: sorted(v) for p, v in sorted(blocks.items())}
    # Committed, not generated: it is our own measurement of a real boot, not
    # Mojang's bytes, and the deploy host has no session to measure.
    dest = os.path.join(root, "web", "bootset-%s.json" % ver)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    json.dump(out, open(dest, "w"))
    total = sum(len(v) for v in out.values())
    print("bootset.json: %d files, %d block requests -> %s"
          % (len(out), total, os.path.relpath(dest, root)))


if __name__ == "__main__":
    main()
