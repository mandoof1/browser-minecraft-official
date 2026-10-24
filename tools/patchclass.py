#!/usr/bin/env python3
"""
patchclass.py - rewrite one method body inside a class inside a jar.

Why this exists: Minecraft's crash reporter assumes the JVM can hand it a deep
stack. org.lwjgl-style code is not the problem here - class `c` (CrashReport-
Category in the 1.12.2 obfuscated namespace) does

    StackTraceElement[] st = Thread.currentThread().getStackTrace();
    if (st.length <= 0) return 0;
    this.d = new StackTraceElement[st.length - 3 - skip];   // negative under CheerpJ

CheerpJ's Java 8 runtime returns two frames, so the array size goes negative and
the *reporter* dies before Mojang ever prints the exception that actually broke
startup. Patching the capture to a no-op makes Mojang's own crash report - and
therefore the real cause - visible again.

The patch is applied to a copy of Mojang's jar; the fetched client.jar stays
byte-for-byte what piston served.

  python3 tools/patchclass.py <in.jar> <out.jar> <class/path> <method> <desc> [--const0]
"""
import io
import re
import sys
import zipfile

def u1(b, o):  return b[o]
def u2(b, o):  return (b[o] << 8) | b[o + 1]
def u4(b, o):  return (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]

def parse(b):
    """Return (utf8_map, methods) for a class file, plus offsets we need."""
    assert b[:4] == b"\xca\xfe\xba\xbe", "not a class file"
    o = 8
    cp_count = u2(b, o); o += 2
    utf8 = {}
    i = 1
    while i < cp_count:
        tag = b[o]; o += 1
        if tag == 1:
            n = u2(b, o); o += 2
            utf8[i] = b[o:o + n].decode("utf-8", "replace")
            o += n
        elif tag in (3, 4):        # int, float
            o += 4
        elif tag in (5, 6):        # long, double - take two slots
            o += 8; i += 1
        elif tag in (7, 8, 16, 19, 20):
            o += 2
        elif tag in (9, 10, 11, 12, 17, 18):
            o += 4
        elif tag == 15:
            o += 3
        else:
            raise SystemExit("unknown constant pool tag %d" % tag)
        i += 1
    # access, this, super, interfaces
    o += 2 + 2 + 2
    n = u2(b, o); o += 2 + 2 * n
    n = u2(b, o); o += 2
    fields = []
    for _ in range(n):
        start = o
        o += 6
        an = u2(b, o); o += 2
        for _a in range(an):
            alen = u4(b, o + 2)
            o += 6 + alen
        fields.append((start, o))
    n = u2(b, o); o += 2
    methods = []
    for _ in range(n):
        start = o
        acc, name_i, desc_i = u2(b, o), u2(b, o + 2), u2(b, o + 4)
        o += 6
        attrs_start = o
        an = u2(b, o); o += 2
        code_attr = None
        for _a in range(an):
            aname = u2(b, o); alen = u4(b, o + 2)
            if utf8.get(aname) == "Code":
                code_attr = (o, alen)
            o += 6 + alen
        methods.append({"start": start, "end": o, "name": utf8.get(name_i),
                        "desc": utf8.get(desc_i), "attrs_start": attrs_start,
                        "code": code_attr})
    return utf8, methods

def patch_code(b, meth, code, max_stack=1, max_locals=2):
    """Replace the Code attribute of `meth` with `code`."""
    off, alen = meth["code"]
    body = (max_stack).to_bytes(2, "big") + (max_locals).to_bytes(2, "big") \
        + len(code).to_bytes(4, "big") + code \
        + (0).to_bytes(2, "big") + (0).to_bytes(2, "big")
    # `off` is the start of the attribute: name_index (2) | length (4) | info.
    # Keep the name, rewrite length + info. attribute_length counts only info.
    return b[:off + 2] + len(body).to_bytes(4, "big") + body + b[off + 6 + alen:]

def main():
    src, dst, cls, name, desc = sys.argv[1:6]
    const0 = "--const0" in sys.argv
    if not const0:
        raise SystemExit("only --const0 (return 0 / void) is supported")
    # iconst_0 ; ireturn  - and for a void method just `return`:
    code = b"\x03\xac" if desc.endswith(")I") else b"\xb1"
    zin = zipfile.ZipFile(src)
    if cls not in zin.namelist():
        raise SystemExit("%s not in %s (has %d entries)" % (cls, src, len(zin.namelist())))
    raw = zin.read(cls)
    _utf8, methods = parse(raw)
    hits = [m for m in methods if m["name"] == name and m["desc"] == desc]
    if len(hits) != 1:
        for m in methods:
            print("  candidate: %s%s" % (m["name"], m["desc"]))
        raise SystemExit("want exactly one %s%s, found %d" % (name, desc, len(hits)))
    patched = patch_code(raw, hits[0], code)
    # Mojang ships client.jar signed: every class has a digest in META-INF/*.SF
    # and the jar is sealed. Editing one class invalidates those digests, and the
    # JVM then refuses the class ("SHA-256 digest error for c.class"), which
    # surfaces as a bare NoClassDefFoundError. Drop the signature blocks so the
    # jar is simply unsigned. The manifest's own per-entry digest attributes are
    # left alone: with no .SF file nothing verifies them, and rewriting an 845 KB
    # manifest with a regex is a good way to make it invalid.
    drop = re.compile(r"^META-INF/.*\.(SF|RSA|DSA|EC)$")
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            if drop.match(item.filename):
                continue
            data = patched if item.filename == cls else zin.read(item.filename)
            zout.writestr(item, data)
    print("patched %s: %s%s -> %s in %s (%d -> %d bytes)"
          % (cls, name, desc, "const0", dst, len(raw), len(patched)))

if __name__ == "__main__":
    main()
