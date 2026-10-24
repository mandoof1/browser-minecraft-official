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


def _oplengths():
    """Instruction lengths from the JVM opcode table, as (total) bytes.

    Only needed to walk a Code array without mistaking an operand byte for an
    opcode, but the variable-length ones (wide, tableswitch, lookupswitch) are
    handled by walk() itself."""
    t = {}
    def rng(a, b, n):
        for o in range(a, b + 1):
            t[o] = n
    rng(0x00, 0x0f, 1)          # nop, aconst_*, lconst_*, fconst_*, dconst_*
    t[0x10] = 2                 # bipush
    t[0x11] = 3                 # sipush
    t[0x12] = 2                 # ldc
    t[0x13] = 3                 # ldc_w
    t[0x14] = 3                 # ldc2_w
    rng(0x15, 0x19, 2)          # iload .. aload
    rng(0x1a, 0x2d, 1)          # iload_0 .. aload_3
    rng(0x2e, 0x35, 1)          # *aload
    rng(0x36, 0x3a, 2)          # istore .. astore
    rng(0x3b, 0x4e, 1)          # istore_0 .. astore_3
    rng(0x4f, 0x56, 1)          # *astore
    rng(0x57, 0x5f, 1)          # pop, dup, swap
    rng(0x60, 0x81, 1)          # arithmetic and shifts
    t[0x82] = 3                 # iinc
    rng(0x83, 0x98, 1)          # comparisons and conversions
    rng(0x99, 0xa8, 3)          # if_*, goto, jsr
    rng(0xac, 0xb1, 1)          # returns
    rng(0xb2, 0xb8, 3)          # getstatic .. invokestatic
    t[0xb9] = 5                 # invokeinterface (index, 0, reserved)
    t[0xba] = 5                 # invokedynamic (index, reserved, reserved)
    t[0xbb] = 3                 # new
    t[0xbc] = 2                 # newarray
    t[0xbd] = 3                 # anewarray
    rng(0xbe, 0xc3, 1)          # arraylength, athrow, checkcast, instanceof, monitorenter/exit
    t[0xc5] = 4                 # multianewarray
    rng(0xc6, 0xd7, 3)          # if_acmpeq .. if_icmple
    t[0xd8] = 3                 # jsr
    t[0xd9] = 2                 # ret
    rng(0xda, 0xdb, 3)          # getfield, putfield
    rng(0xdc, 0xdd, 5)          # goto_w, jsr_w
    return t


LEN = _oplengths()


def walk(code):
    """Yield (offset, opcode) for every instruction in a Code array."""
    o, n = 0, len(code)
    while o < n:
        op = code[o]
        yield o, op
        if op in (0xaa, 0xab):                      # tableswitch / lookupswitch
            p = (o + 4) - ((o + 4) % 4)
            npairs = int.from_bytes(code[p + 4:p + 8], "big")
            l = 12 + 8 * npairs if op == 0xab else 16 + 4 * (int.from_bytes(code[p + 12:p + 16], "big")
                                                             - int.from_bytes(code[p + 8:p + 12], "big") + 1)
            o += l
        elif op == 0xc4:                            # wide
            o += 6 if code[o + 1] == 0x84 else 4
        else:
            l = LEN.get(op)
            if l is None:
                raise SystemExit("unknown opcode 0x%02x at %d" % (op, o))
            o += l


def fieldrefs(b, utf8, cp_count):
    """[(index, class_idx, field_name, descriptor)] for every Fieldref.

    A Fieldref points at a NameAndType, which is where the name and descriptor
    actually live, so the pool is collected in two passes."""
    o = 10
    raw = {}
    i = 1
    while i < cp_count:
        tag = b[o]; o += 1
        if tag == 1:
            n = u2(b, o); raw[i] = (tag, b[o:o + n]); o += 2 + n
        elif tag in (3, 4):
            raw[i] = (tag, b[o:o + 4]); o += 4
        elif tag in (5, 6):
            raw[i] = (tag, b[o:o + 8]); o += 8; i += 1
        elif tag in (7, 8, 16, 19, 20):
            raw[i] = (tag, b[o:o + 2]); o += 2
        elif tag in (9, 10, 11, 12, 17, 18):
            raw[i] = (tag, b[o:o + 4]); o += 4
        elif tag == 15:
            raw[i] = (tag, b[o:o + 3]); o += 3
        else:
            raise SystemExit("unknown constant pool tag %d" % tag)
        i += 1

    def nat(idx):
        tag, v = raw[idx]
        assert tag == 12, "constant pool index %d is not a NameAndType" % idx
        return utf8.get(u2(v, 0)), utf8.get(u2(v, 2))

    def cls_name(idx):
        tag, v = raw[idx]
        return utf8.get(u2(v, 0)) if tag == 7 else None

    out = []
    for idx, (tag, v) in raw.items():
        if tag == 9:
            name, desc = nat(u2(v, 2))
            out.append((idx, u2(v, 0), cls_name(u2(v, 0)), name, desc))
    return out, raw


def swap_getstatic(b, meth, old_idx, new_idx):
    """Rewrite getstatic operands inside one method's Code, in place.

    The operand pair is the same width either way, so the class file does not
    change length and no offsets move."""
    attr, _alen = meth["code"]
    if attr is None:
        raise SystemExit("%s%s has no Code attribute" % (meth["name"], meth["desc"]))
    start = attr + 14                 # name(2) len(4) max_stack(2) max_locals(2) code_len(4)
    clen = u4(b, attr + 10)
    code = bytearray(b[start:start + clen])
    n = 0
    for off, op in walk(code):
        if op in (0xb2, 0xb3) and u2(code, off + 1) == old_idx:
            code[off + 1:off + 3] = new_idx.to_bytes(2, "big")
            n += 1
    if n == 0:
        raise SystemExit("no getstatic of constant pool index %d in %s%s"
                         % (old_idx, meth["name"], meth["desc"]))
    out = bytearray(b)
    out[start:start + clen] = code
    return bytes(out), n


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
    fieldref = None
    if "--fieldref" in sys.argv:
        i = sys.argv.index("--fieldref")
        fieldref = sys.argv[i + 1:i + 3]      # old field name, new field name
        if len(fieldref) != 2:
            raise SystemExit("--fieldref wants <old field> <new field>")
    if not const0 and not static and not nonnull and not fieldref:
        raise SystemExit("--const0, --static, --nonnull or --fieldref is required")
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
    elif fieldref:
        old_field, new_field = fieldref
        refs, pool = fieldrefs(raw, _utf8, cp_count)
        this_class = u2(raw, 12)
        # The class of a Fieldref is a Class entry, and javac is free to emit a
        # second one naming the same class, so compare names, not indices.
        this_name = _utf8.get(u2(pool[u2(raw, cp_end + 2)][1], 0))
        want = [r for r in refs if r[3] == old_field and r[2] == this_name]
        if not want:
            raise SystemExit("no Fieldref for this class field %s (class %s)" % (old_field, this_name))
        oidx, cidx, _cn, _nm, desc = want[0]
        have = [r for r in refs if r[3] == new_field and r[2] == this_name and r[4] == desc]
        if have:
            nidx = have[0][0]
            entries, new_count = [], cp_count
        else:
            # Utf8(new name) + NameAndType(new name, same descriptor) + Fieldref.
            base = cp_count
            desc_i = None
            o = 10
            for i in range(1, cp_count):
                tag = raw[o]; o += 1
                if tag == 1:
                    n = u2(raw, o)
                    if u2(raw, o - 2) == n and raw[o:o + n] == desc.encode():
                        desc_i = i
                    o += 2 + n
                elif tag in (3, 4):
                    o += 4
                elif tag in (5, 6):
                    o += 8; i += 1
                elif tag in (7, 8, 16, 19, 20):
                    o += 2
                elif tag in (9, 10, 11, 12, 17, 18):
                    o += 4
                elif tag == 15:
                    o += 3
            if desc_i is None:
                raise SystemExit("descriptor %s is not in the pool" % desc)
            entries = [
                b"\x01" + len(new_field).to_bytes(2, "big") + new_field.encode(),
                b"\x0c" + base.to_bytes(2, "big") + desc_i.to_bytes(2, "big"),
                b"\x09" + cidx.to_bytes(2, "big") + (base + 1).to_bytes(2, "big"),
            ]
            nidx = base + 2
            new_count = cp_count + 3
        patched, n = swap_getstatic(raw, hits[0], oidx, nidx)
        patched, new_count, _b = append_cp(patched, cp_end, cp_count, entries) if entries \
            else (patched, new_count, None)
        patched = patched[:8] + new_count.to_bytes(2, "big") + patched[10:]
        print("patched %s: %s%s getstatic %s -> %s (%d site%s)"
              % (cls, name, desc, old_field, new_field, n, "s" if n != 1 else ""))
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
    if fieldref:
        what = "fieldref %s -> %s" % tuple(fieldref)
    else:
        what = "const0" if const0 else ("nonnull %s.%s%s" % tuple(nonnull) if nonnull
                                        else "call %s.%s%s" % tuple(static))
    print("patched %s: %s%s -> %s in %s (%d -> %d bytes)"
          % (cls, name, desc, what, dst, len(raw), len(patched)))

if __name__ == "__main__":
    main()
