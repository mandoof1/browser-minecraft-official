#!/usr/bin/env python3
"""Find Mojang's own buttons in a screenshot and print their centres.

Mojang draws every GuiButton with the same gray face, so the buttons can be
found by colour rather than by guessing coordinates - which matters because the
CheerpJ window is not the same size in every run, and a coordinate that worked
in one run lands on "Delete" in the next.

Usage: findbuttons.py <png> [x0 y0 x1 y1]   (crop, in case you want to restrict
the search to the game area)
Prints one "cx cy w h" per button, top-to-bottom then left-to-right.
"""
import sys
from PIL import Image

im = Image.open(sys.argv[1]).convert("RGB")
x0, y0 = 0, 0
x1, y1 = im.size
if len(sys.argv) > 4:
    x0, y0, x1, y1 = (int(v) for v in sys.argv[2:6])
px = im.load()


def face(c):
    r, g, b = c
    return abs(r - g) < 12 and abs(g - b) < 12 and 95 <= r <= 140


rows = []
y = y0
while y < y1:
    xs = [x for x in range(x0, x1) if face(px[x, y])]
    if len(xs) > 120:
        start = y
        while y < y1:
            xs = [x for x in range(x0, x1) if face(px[x, y])]
            if len(xs) <= 120:
                break
            y += 1
        rows.append((start, y - 1))
    y += 1

out = []
for a, b in rows:
    # a 1-2 px band is texture, not a button
    if b - a < 10:
        continue
    # split the band into runs of face pixels along x
    xs = sorted({x for y in range(a, b + 1) for x in range(x0, x1) if face(px[x, y])})
    runs = []
    s = p = None
    for x in xs:
        if s is None:
            s = x
        elif x != p + 1:
            runs.append((s, p))
            s = x
        p = x
    if s is not None:
        runs.append((s, p))
    for u, v in runs:
        if v - u < 60:
            continue
        out.append(((u + v) // 2, (a + b) // 2, v - u + 1, b - a + 1))

for cx, cy, w, h in out:
    print(cx, cy, w, h)
