package webmc;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;

/**
 * Not part of the game. Mojang's client reads the same asset file more than once
 * through CheerpJ's /app/ HTTP filesystem, and the second open never reaches our
 * web server. This probe reproduces that in isolation: open, read, close, open
 * again, and time every step, so the port can tell whether the hang is in the
 * server, in CheerpJ's cache, or in Java's file layer.
 */
public class FileProbe {

	static long t0 = System.currentTimeMillis();

	static void say(String s) {
		System.out.println("[fileprobe] +" + (System.currentTimeMillis() - t0) + "ms " + s);
	}

	static void step(String what, Runnable r) {
		say(what + " ...");
		long a = System.currentTimeMillis();
		try {
			r.run();
			say(what + " OK in " + (System.currentTimeMillis() - a) + "ms");
		} catch (Throwable t) {
			say(what + " FAILED after " + (System.currentTimeMillis() - a) + "ms: " + t);
		}
	}

	static String read(String path) throws Exception {
		InputStream in = new FileInputStream(path);
		try {
			ByteArrayOutputStream out = new ByteArrayOutputStream();
			byte[] buf = new byte[4096];
			int n;
			while ((n = in.read(buf)) > 0) {
				out.write(buf, 0, n);
			}
			return new String(out.toByteArray(), "UTF-8");
		} finally {
			in.close();
		}
	}

	public static void main(String[] args) {
		final String a = "/app/data/vanilla/1.12.2/assets/objects/e5/e5feeef31d7e3f83208c2c565fcf096ec9a91219";
		final String b = "/app/data/vanilla/1.12.2/assets/objects/5f/5ff04807c356f1beed0b86ccf659b44b9983e3fa";
		step("stat", new Runnable() {
			public void run() {
				File f = new File(a);
				say("  exists=" + f.exists() + " length=" + f.length() + " isFile=" + f.isFile());
			}
		});
		step("first open+read", new Runnable() {
			public void run() {
				try {
					String s = read(a);
					say("  read " + s.length() + " chars, starts with: " + s.substring(0, Math.min(40, s.length())).replace('\n', ' '));
				} catch (Exception e) {
					throw new RuntimeException(e);
				}
			}
		});
		step("second open+read (same file)", new Runnable() {
			public void run() {
				try {
					String s = read(a);
					say("  read " + s.length() + " chars again");
				} catch (Exception e) {
					throw new RuntimeException(e);
				}
			}
		});
		step("open a different file", new Runnable() {
			public void run() {
				try {
					String s = read(b);
					say("  read " + s.length() + " bytes of another object");
				} catch (Exception e) {
					throw new RuntimeException(e);
				}
			}
		});
		step("open missing file", new Runnable() {
			public void run() {
				try {
					read(a + "nope");
					say("  missing file did NOT throw");
				} catch (java.io.FileNotFoundException expected) {
					say("  FileNotFoundException as expected: " + expected.getMessage());
				} catch (Exception e) {
					throw new RuntimeException(e);
				}
			}
		});
		step("list directory", new Runnable() {
			public void run() {
				String[] names = new File("/app/data/vanilla/1.12.2/assets/objects/e5").list();
				say("  listing: " + (names == null ? "null" : names.length + " entries"));
			}
		});
		step("third open+read of first file", new Runnable() {
			public void run() {
				try {
					say("  read " + read(a).length() + " chars (third time)");
				} catch (Exception e) {
					throw new RuntimeException(e);
				}
			}
		});
		say("done");
	}
}
