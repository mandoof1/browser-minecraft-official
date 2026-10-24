#!/usr/bin/env python3
"""serve.py - the hosting half of this port, and it is not optional.

A vanilla-Minecraft-in-the-browser port needs four things a static host cannot
give it:

  1. Range / 206. CheerpJ reads Mojang's jars lazily: it asks the web server
     for the parts of client.jar it actually needs. Python's stock server
     answers Range with a plain 200, which silently turns lazy class loading
     into a full download of every jar on the classpath.
  2. COOP/COEP. Cross-origin isolation for SharedArrayBuffer, which the JVM's
     threads want, and for OPFS, which the asset cache wants.
  3. /health and /telemetry. A deployed port has to be able to say which Mojang
     version it is running, and the harness has to be able to read the Java
     side's own log back. Telemetry records append to telemetry.jsonl.
  4. A path map. CheerpJ's /app/ mount point is this origin's root, so Mojang's
     files (data/vanilla/...), our launcher jar, and the LWJGL-in-WebAssembly
     runtime all have to come from one origin with one set of headers.

Mojang's own files are never committed to git (their EULA does not allow
redistributing the game); tools/get-vanilla.py fetches them from Mojang.
"""
import json
import os
import subprocess
import sys
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
BUILD = os.path.join(ROOT, "build")
DATA = os.path.join(ROOT, "data")
LWJGL = os.path.join(WEB, "lwjgl")
TELEMETRY = os.path.join(ROOT, "tools", "telemetry.jsonl")
try:
    with open(TELEMETRY, "a"):
        pass
except OSError:
    TELEMETRY = os.path.join(os.environ.get("TMPDIR", "/tmp"), "browser-mc-official-telemetry.jsonl")

MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".wasm": "application/wasm",
    ".json": "application/json",
    ".jar": "application/java-archive",
    ".so": "application/octet-stream",
    ".png": "image/png",
    ".css": "text/css; charset=utf-8",
    ".dat": "application/octet-stream",
}


def resolve(path):
    """Map a URL path onto a file. CheerpJ's /app/ mount point is this origin's
    root, so Mojang's tree, our launcher jar and the WebAssembly LWJGL runtime
    all come from one origin with one set of headers."""
    p = unquote(path).lstrip("/")
    if p in ("", "index.html"):
        return os.path.join(WEB, "index.html")
    q = p[len("app/"):] if p.startswith("app/") else p
    if q.startswith("data/"):
        return os.path.join(ROOT, q)
    if q.startswith("lwjgl/"):
        return os.path.join(LWJGL, q[len("lwjgl/"):])
    if "/" not in q and q.endswith(".jar"):
        return os.path.join(BUILD, q)
    for base in (WEB, os.path.join(WEB, "app")):
        cand = os.path.join(base, p)
        if os.path.isfile(cand):
            return cand
    return os.path.join(WEB, p)


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **MIME}
    protocol_version = "HTTP/1.1"

    def isolation_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        if os.environ.get("COEP", "0") == "1":
            self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        # No Cross-Origin-Embedder-Policy, deliberately. COEP would give us
        # SharedArrayBuffer, but it also blocks cross-origin iframes that do not
        # opt in, and CheerpJ renders the AWT/X11 display in exactly such an
        # iframe (https://cjrtnc.leaningtech.com/4.3/c.html). The request dies as
        # net::ERR_BLOCKED_BY_RESPONSE and cheerpjRunMain then waits forever with
        # no error anywhere. Java 8 Minecraft does not need SharedArrayBuffer, so
        # isolation costs more than it buys. COOP alone is harmless and keeps the
        # document in its own browsing group.
        self.send_header("Permissions-Policy", "cross-origin-isolated=(self)")

    def end_headers(self):
        self.isolation_headers()
        super().end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            return self.health()
        return self.serve_file(resolve(path))

    def missing(self):
        """CheerpJ reads this origin as its /app/ filesystem. For a path that is
        not there, Leaning Technologies' own nginx recipe answers 204
        (try_files $uri $uri/ =204), not 404: a 404 mid-read is what stalls the
        JVM inside FileInputStream.open. So: 204 with no body."""
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_HEAD(self):
        sys.stderr.write("%s - OPEN %s %s range=%s\n" % (self.address_string(), self.command, self.path, self.headers.get("Range")))
        sys.stderr.flush()
        f = resolve(urlparse(self.path).path)
        if not os.path.isfile(f):
            return self.missing()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(os.path.splitext(f)[1], "application/octet-stream"))
        self.send_header("Content-Length", str(os.path.getsize(f)))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()

    def plans(self):
        out = {}
        base = os.path.join(DATA, "vanilla")
        if os.path.isdir(base):
            for v in sorted(os.listdir(base)):
                pj = os.path.join(base, v, "plan.json")
                if os.path.isfile(pj):
                    with open(pj) as f:
                        out[v] = json.load(f)
        return out

    def health(self):
        plans = self.plans()
        out = json.dumps({
            "ok": bool(plans),
            # COEP is deliberately absent (see isolation_headers), so this page is
            # not cross-origin isolated and SharedArrayBuffer is unavailable.
            # It used to say True unconditionally, which was a claim, not a check.
            "isolated": False,
            "vanilla": {v: {"clientSha1": p["clientSha1"], "jars": len(p["classpath"]),
                            "assets": p["assetObjects"], "bytes": p["totalJarBytes"],
                            "javaMajor": p["javaMajor"]} for v, p in plans.items()},
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def serve_file(self, fpath):
        fpath = os.path.abspath(fpath)
        # log at open, not at close: a client that blocks mid-request is exactly
        # what a port harness needs to see, and the completion log hides it
        sys.stderr.write("%s - OPEN %s %s range=%s\n" % (self.address_string(), self.command, self.path, self.headers.get("Range")))
        sys.stderr.flush()
        if not os.path.isfile(fpath):
            return self.missing()
        size = os.path.getsize(fpath)
        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range")
        if rng:
            unit, _, spec = rng.partition("=")
            lo, _, hi = spec.partition("-")
            if not lo and hi:
                # suffix form: last N bytes
                start = max(0, size - int(hi))
                end = size - 1
            else:
                start = int(lo or 0)
                # CheerpJ asks for fixed 128 KiB windows past the end of small
                # files (bytes=0-131071 for a 15 KiB asset). The range must be
                # clamped *and* Content-Length must describe what is actually
                # sent, or the JVM blocks in FileInputStream.open waiting for
                # bytes that were never going to arrive.
                end = min(int(hi) if hi else size - 1, size - 1)
            if start >= size or end < start:
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % size)
                self.send_header("Content-Length", "0")
                self.isolation_headers()
                self.end_headers()
                return
            status = 206
        self.send_response(status)
        self.send_header("Content-Type", MIME.get(os.path.splitext(fpath)[1], "application/octet-stream"))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if rng:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        # Mojang's files are content-addressed, so they never need revalidating
        if "/objects/" in fpath or "/vanilla/" in fpath:
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.end_headers()
        with open(fpath, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def do_POST(self):
        if urlparse(self.path).path != "/telemetry":
            self.send_error(404)
            return
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n) if n else b"{}"
        try:
            rec = json.loads(body)
        except Exception:
            rec = {"raw": body[:4000].decode("utf-8", "replace")}
        rec["ts"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        try:
            with open(TELEMETRY, "a") as f:
                f.write(json.dumps(rec) + "\n")
        except OSError as e:
            sys.stderr.write("telemetry write failed: %s\n" % e)
        out = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def ensure_patched_client():
    """Generate the patched copy of Mojang's client jar if it is not there.

    It is not committed (it is Mojang's bytes plus two method bodies, ~10 MB),
    and a deploy host should not need a build step, a JDK, or a correctly
    configured buildCommand to produce it: tools/patchclass.py is pure Python,
    so we just run it here after Mojang's files exist. If this is skipped the
    page still loads, it simply falls back to Mojang's unpatched jar and dies
    inside the crash reporter again - which is a worse failure than a slow
    start.
    """
    base = os.path.join(DATA, "vanilla")
    if not os.path.isdir(base):
        return
    os.makedirs(BUILD, exist_ok=True)
    for ver in sorted(os.listdir(base)):
        src = os.path.join(base, ver, "client.jar")
        out = os.path.join(BUILD, "client-%s-webmc.jar" % ver)
        if not os.path.isfile(src) or os.path.isfile(out):
            continue
        tmp = os.path.join(BUILD, "client-%s.tmp.jar" % ver)
        steps = [[src, tmp, "c.class", "a", "(I)I"], [tmp, out, "bvu.class", "b", "(Ljava/util/Map;)V"]]
        ok = True
        for args in steps:
            r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "patchclass.py")]
                               + args + ["--const0"], cwd=ROOT, capture_output=True, text=True)
            if r.returncode != 0:
                sys.stderr.write("patchclass failed for %s: %s" % (ver, (r.stderr or r.stdout)[:200]))
                ok = False
        if ok:
            print("[serve] generated %s" % os.path.relpath(out, ROOT), flush=True)
        if os.path.exists(tmp):
            os.remove(tmp)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", "8780"))
    hosted = bool(os.environ.get("RENDER")) or bool(os.environ.get("DYNO"))
    host = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("HOST", "0.0.0.0" if hosted else "127.0.0.1")
    ensure_patched_client()
    httpd = ThreadingHTTPServer((host, port), Handler)
    print("http://%s:%d/  (root=%s)" % (host, port, ROOT), flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
