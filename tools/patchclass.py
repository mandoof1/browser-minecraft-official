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
    """Return (utf8_map, methods, cp_end, cp_count) for a class file.

    cp_end is the offset of the first byte after the constant pool, which is
    where a new constant pool entry can be appended without renumbering the
    existing ones."""
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
    cp_end = o
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
    return utf8, methods, cp_end, cp_count


def append_cp(b, cp_end, cp_count, entries):
    """Append constant pool entries. Constant pool indices are 1-based and
    cp_count is one past the last used index, so the first new entry lands at
    cp_count and the rest follow in order - nothing existing is renumbered."""
    base = cp_count
    blob = b"".join(entries)
    return b[:cp_end] + blob + b[cp_end:], cp_count + len(entries), base


def call_static_code(target_desc, ref_index):
    """Bytecode for a replaced method body that forwards to a static helper.

    Only the shapes this project needs are supported: a void method taking one
    boolean (Display.setResizable) forwards its argument, and a void method
    taking nothing forwards nothing."""
    if target_desc == "(Z)V":
        # aload_0 ; invokestatic #ref ; return
        return b"\x2a\xb8" + ref_index.to_bytes(2, "big") + b"\xb1", 1, 1
    if target_desc == "()V":
        return b"\xb8" + ref_index.to_bytes(2, "big") + b"\xb1", 1, 0
    raise SystemExit("--static does not support target descriptor %s" % target_desc)


def nonnull_code(target_desc, ref_index, ref_index2):
    """Bytecode for `return <receiver>.<method>(<args>) != null`.

    Used to replace a existence check that reaches the filesystem with the
    in-memory answer. Under CheerpJ every java.io.File.isFile() on an /app/ path
    goes through the async filesystem layer and back, which costs far more than
    the map lookup it is guarding.
    """
    if target_desc != "(Lnf;)Z":
        raise SystemExit("--nonnull only supports (Lnf;)Z for now")
    #  0 aload_0 ; 1 aload_1 ; 2 invokevirtual <get> ; 5 invokestatic
    #  java.util.Objects.nonnull ; 8 ireturn
    #
    # No branch: a class file version 52 verifier wants a StackMapTable frame at
    # every branch target, and synthesizing one is more trouble than the two
    # extra constant pool entries this costs.
    return (b"\x2a\x2b\xb6" + ref_index.to_bytes(2, "big")
            + b"\xb8" + ref_index2.to_bytes(2, "big") + b"\xac"), 2, 2

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
    static = None
    nonnull = None
    if "--nonnull" in sys.argv:
        i = sys.argv.index("--nonnull")
        nonnull = sys.argv[i + 1:i + 4]   # class, method, descriptor to call
        if len(nonnull) != 3:
            raise SystemExit("--nonnull wants <class> <method> <descriptor>")
    if "--static" in sys.argv:
        i = sys.argv.index("--static")
        static = sys.argv[i + 1:i + 4]   # helper class, helper method, helper desc
        if len(static) != 3:
            raise SystemExit("--static wants <class> <method> <descriptor>")
    if not const0 and not static and not nonnull:
        raise SystemExit("--const0, --static or --nonnull is required")
    # iconst_0 ; ireturn  - and for a void method just `return`:
    code = b"\x03\xac" if desc.endswith(")I") else b"\xb1"
    max_stack, max_locals = 1, 2
    zin = zipfile.ZipFile(src)
    if cls not in zin.namelist():
        raise SystemExit("%s not in %s (has %d entries)" % (cls, src, len(zin.namelist())))
    raw = zin.read(cls)
    _utf8, methods, cp_end, cp_count = parse(raw)
    hits = [m for m in methods if m["name"] == name and m["desc"] == desc]
    if len(hits) != 1:
        for m in methods:
            print("  candidate: %s%s" % (m["name"], m["desc"]))
        raise SystemExit("want exactly one %s%s, found %d" % (name, desc, len(hits)))
    if nonnull:
        hcls, hname, hdesc = nonnull
        base = cp_count
        # Two Methodrefs: the getter on the receiver, and Objects.nonnull.
        def cp_group(cls, nm, ds, at):
            return [
                b"\x01" + len(cls).to_bytes(2, "big") + cls.encode(),
                b"\x07" + at.to_bytes(2, "big"),
                b"\x01" + len(nm).to_bytes(2, "big") + nm.encode(),
                b"\x01" + len(ds).to_bytes(2, "big") + ds.encode(),
                b"\x0c" + (at + 2).to_bytes(2, "big") + (at + 3).to_bytes(2, "big"),
                b"\x0a" + (at + 1).to_bytes(2, "big") + (at + 4).to_bytes(2, "big"),
            ]
        entries = (cp_group(hcls, hname, hdesc, base)
                   + cp_group("java/util/Objects", "nonNull", "(Ljava/lang/Object;)Z", base + 6))
        body, max_stack, max_locals = nonnull_code(desc, base + 5, base + 11)
        patched = patch_code(raw, hits[0], body, max_stack, max_locals)
        patched, new_count, _b = append_cp(patched, cp_end, cp_count, entries)
        # magic(4) minor(2) major(2) constant_pool_count(2) - the count is at 8.
        patched = patched[:8] + new_count.to_bytes(2, "big") + patched[10:]
    elif static:
        hcls, hname, hdesc = static
        # Methodref -> Class(name) + NameAndType(name, descriptor).
        # Duplicated Utf8 entries are legal; reusing existing ones would mean
        # rescanning the pool, and this runs once per build.
        base = cp_count                      # first free constant pool index
        ref = base + 5                       # the Methodref, last entry added
        entries = [
            b"\x01" + len(hcls).to_bytes(2, "big") + hcls.encode(),
            b"\x07" + base.to_bytes(2, "big"),
            b"\x01" + len(hname).to_bytes(2, "big") + hname.encode(),
            b"\x01" + len(hdesc).to_bytes(2, "big") + hdesc.encode(),
            b"\x0c" + (base + 2).to_bytes(2, "big") + (base + 3).to_bytes(2, "big"),
            b"\x0a" + (base + 1).to_bytes(2, "big") + (base + 4).to_bytes(2, "big"),
        ]
        body, max_stack, max_locals = call_static_code(desc, ref)
        # The method body is at an offset in the unmodified file, so replace it
        # before appending constant pool entries (which sit before it and shift
        # everything after them).
        patched = patch_code(raw, hits[0], body, max_stack, max_locals)
        patched, new_count, _b = append_cp(patched, cp_end, cp_count, entries)
        # magic(4) minor(2) major(2) constant_pool_count(2) - the count is at 8.
        patched = patched[:8] + new_count.to_bytes(2, "big") + patched[10:]
    else:
        patched = patch_code(raw, hits[0], code, max_stack, max_locals)
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
    what = "const0" if const0 else ("nonnull %s.%s%s" % tuple(nonnull) if nonnull
                                    else "call %s.%s%s" % tuple(static))
    print("patched %s: %s%s -> %s in %s (%d -> %d bytes)"
          % (cls, name, desc, what, dst, len(raw), len(patched)))

if __name__ == "__main__":
    main()
