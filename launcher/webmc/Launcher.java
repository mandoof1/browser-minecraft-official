package webmc;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;

/**
 * Our launcher, so the game is started exactly the way a desktop launcher
 * starts it: one classpath, Mojang's own main class, Mojang's own argument
 * names.
 *
 * CheerpJ's cheerpjRunMain(mainClass, classPath) takes no program arguments,
 * and Mojang's client insists on them (--gameDir, --assetIndex, --assetsDir,
 * --uuid, --accessToken ...). So this class reads the argument list that
 * tools/get-vanilla.py wrote, and calls the real main by reflection. Nothing
 * here knows anything about Minecraft's internals: it is a command line.
 */
public final class Launcher {

	public static void main(String[] argv) throws Exception {
		System.out.println("[webmc] java=" + System.getProperty("java.version") + " vm=" + System.getProperty("java.vm.name"));
		System.out.println("[webmc] os.name=" + System.getProperty("os.name") + " os.arch=" + System.getProperty("os.arch"));
		raiseDirectMemory();
		System.out.println("[webmc] java.library.path=" + System.getProperty("java.library.path"));

		List<String> args = new ArrayList<String>();
		String inline = System.getProperty("mc.args");
		String argsFile = System.getProperty("mc.argsFile", "/app/mcargs.txt");
		String text;
		if (inline != null && inline.length() > 0) {
			System.out.println("[webmc] args source: property (" + inline.length() + " chars)");
			text = inline.replace('|', '\n');
		} else {
			System.out.println("[webmc] args source: file " + argsFile);
			byte[] raw = readAll(new FileInputStream(argsFile));
			System.out.println("[webmc] read " + raw.length + " bytes");
			text = new String(raw, "UTF-8");
		}
		// Split by hand: no regex, no assumptions about the JVM's regexp engine.
		int n = text.length();
		int i = 0;
		while (i < n) {
			int j = i;
			while (j < n && text.charAt(j) != '\n' && text.charAt(j) != '\r') {
				j++;
			}
			String line = text.substring(i, j).trim();
			if (line.length() > 0) {
				args.add(line);
			}
			i = j + 1;
		}
		System.out.println("[webmc] " + args.size() + " launch arguments from " + argsFile);

		seedGameOptions(args);

		String mainClass = System.getProperty("mc.mainClass", "net.minecraft.client.main.Main");
		Class<?> game = Class.forName(mainClass);
		System.out.println("[webmc] resolved " + game.getName() + " from " + game.getProtectionDomain().getCodeSource().getLocation());
		Method main = game.getMethod("main", String[].class);
		System.out.println("[webmc] calling " + mainClass + ".main - this is Mojang's own bytecode");
		try {
			main.invoke(null, new Object[] { args.toArray(new String[0]) });
			System.out.println("[webmc] game main returned");
			// The client catches its own fatal exceptions, writes a crash report
			// and returns normally, so a clean return is not evidence of a clean
			// run. Look for a report either way.
			dumpGameLogs(args);
		} catch (Throwable t) {
			// Mojang's client turns failures into a crash report under the game
			// directory; print what it wrote, because that report names the layer
			// that actually failed.
			Throwable c = t;
			while (c != null) {
				System.out.println("[webmc] exception: " + c);
				for (int f = 0; f < Math.min(c.getStackTrace().length, 12); f++) {
					System.out.println("[webmc]     at " + c.getStackTrace()[f]);
				}
				c = c.getCause();
			}
			dumpGameLogs(args);
			throw t;
		}
	}

	/**
	 * Seed Mojang's own options file before the game starts.

	 * fboEnabled:false is the important one, and it is a real Minecraft video
	 * setting, not a hack: Mojang's client only touches framebuffer objects when
	 * it is on. The WebAssembly GL shim this port runs on (gl4es, for OpenGL 2.1
	 * on top of WebGL) reports ARB/EXT_framebuffer_object but its glGenFramebuffers
	 * path is broken under CheerpJ - the function pointer lookup fails, which
	 * shows up as an ArrayIndexOutOfBoundsException inside the first FBO call and
	 * hangs the game inside Framebuffer.createBindFramebuffer. Turning the setting
	 * off makes Mojang's own code take its no-FBO fallback, which is the same code
	 * path older and lower-end GPUs took.
	 *
	 * Everything else here is also a stock options.txt key.
	 */
	private static void seedGameOptions(List<String> args) throws Exception {
		String gameDir = null;
		for (int i = 0; i + 1 < args.size(); i++) {
			if ("--gameDir".equals(args.get(i))) {
				gameDir = args.get(i + 1);
			}
		}
		if (gameDir == null) {
			return;
		}
		java.io.File dir = new java.io.File(gameDir);
		dir.mkdirs();
		java.io.File opts = new java.io.File(dir, "options.txt");
		if (opts.exists()) {
			System.out.println("[webmc] options.txt already present (" + opts.length() + " bytes), leaving it alone");
			return;
		}
		String[] lines = new String[] {
			// keys are exactly as Mojang's own GameSettings parses them
			"lang:en_us",
			"fboEnable:false",
			// Mojang's own default is VBOs on. CheerpJ/gl4es still has to survive
			// glGenBuffers, so this stays switchable for A/B runs (?vbo=0).
			"useVbo:" + System.getProperty("webmc.useVbo", "true"),
			"fancyGraphics:false",
			"ao:false",
			"particles:0",
			"renderDistance:6",
			"renderClouds:false",
			"enableVsync:false",
			"fullscreen:false",
			"guiScale:2",
			"fov:0.75",
			"gamma:1.0",
			"maxFps:60",
			"mouseSensitivity:0.5",
			"snooperEnabled:false",
		};
		java.io.PrintWriter out = new java.io.PrintWriter(new java.io.OutputStreamWriter(
			new java.io.FileOutputStream(opts), "UTF-8"));
		for (String line : lines) {
			out.println(line);
		}
		out.close();
		System.out.println("[webmc] wrote " + opts + " (" + lines.length + " settings, fboEnabled=false)");
	}

	/**
	 * Give the client room for its chunk buffers.
	 *
	 * Mojang allocates a direct ByteBuffer per chunk section it builds geometry
	 * for (ByteBufferUtils.allocateByteBuffer, class bia.c). java.nio.Bits
	 * refuses past -XX:MaxDirectMemorySize, which defaults to the max heap and
	 * is read once from the VM at boot - and CheerpJ's max heap is small, so a
	 * world at render distance 6 dies with "OutOfMemoryError: Direct buffer
	 * memory" the moment chunk rendering starts. There is no VM flag to pass to
	 * CheerpJ, so set the field Bits itself uses.
	 */
	private static void raiseDirectMemory() {
		System.out.println("[webmc] heap max=" + Runtime.getRuntime().maxMemory()
				+ " total=" + Runtime.getRuntime().totalMemory());
		try {
			Class<?> bits = Class.forName("java.nio.Bits");
			// The field holding the cap is called maxMemory in java.nio.Bits; the
			// getter that feeds it is VM.maxDirectMemory(). Try both spellings so
			// this keeps working if a future runtime renames it.
			java.lang.reflect.Field limit = null;
			for (String name : new String[] { "maxMemory", "maxDirectMemory" }) {
				try {
					limit = bits.getDeclaredField(name);
					break;
				} catch (NoSuchFieldException ignore) {
					// next spelling
				}
			}
			if (limit == null) {
				throw new NoSuchFieldException("neither maxMemory nor maxDirectMemory");
			}
			java.lang.reflect.Field set = bits.getDeclaredField("memoryLimitSet");
			limit.setAccessible(true);
			set.setAccessible(true);
			long before = limit.getLong(null);
			long want = Math.max(512L * 1024 * 1024, Runtime.getRuntime().maxMemory());
			set.setBoolean(null, true);   // otherwise the VM's own value comes back
			limit.setLong(null, want);
			System.out.println("[webmc] maxDirectMemory " + before + " -> " + want);
		} catch (Throwable t) {
			System.out.println("[webmc] could not raise direct memory: " + t);
		}
	}

	private static void dumpGameLogs(List<String> args) {
		String gameDir = null;
		for (int i = 0; i + 1 < args.size(); i++) {
			if ("--gameDir".equals(args.get(i))) {
				gameDir = args.get(i + 1);
			}
		}
		if (gameDir == null) {
			return;
		}
		try {
			java.io.File logs = new java.io.File(gameDir, "logs");
			java.io.File latest = new java.io.File(logs, "latest.log");
			if (latest.isFile()) {
				System.out.println("[webmc] " + latest + " (" + latest.length() + " bytes) tail:");
				byte[] raw = readAll(new FileInputStream(latest));
				String[] lines = new String(raw, "UTF-8").split("\n");
				for (int i = Math.max(0, lines.length - 40); i < lines.length; i++) {
					System.out.println("[webmc]   | " + lines[i]);
				}
			} else {
				System.out.println("[webmc] no " + latest);
			}
			java.io.File reports = new java.io.File(gameDir, "crash-reports");
			java.io.File[] found = reports.listFiles();
			if (found != null) {
				for (int i = 0; i < found.length; i++) {
					System.out.println("[webmc] crash report: " + found[i].getName() + " (" + found[i].length() + " bytes)");
				}
				// The report body is the thing that names the failing layer, and
				// the client only ever prints the first couple of lines of it.
				java.io.File newest = found.length > 0 ? found[0] : null;
				for (int i = 1; i < found.length; i++) {
					if (found[i].lastModified() > newest.lastModified()) {
						newest = found[i];
					}
				}
				if (newest != null && newest.isFile()) {
					System.out.println("[webmc] ---- " + newest.getName() + " ----");
					byte[] raw = readAll(new FileInputStream(newest));
					String[] lines = new String(raw, "UTF-8").split("\n");
					for (int i = 0; i < Math.min(lines.length, 120); i++) {
						System.out.println("[webmc] > " + lines[i]);
					}
				}
			}
			java.io.File[] top = new java.io.File(gameDir).listFiles();
			if (top != null) {
				StringBuilder sb = new StringBuilder();
				for (int i = 0; i < top.length; i++) {
					sb.append(top[i].getName()).append(' ');
				}
				System.out.println("[webmc] gameDir contents: " + sb);
			}
		} catch (Throwable t) {
			System.out.println("[webmc] log dump failed: " + t);
		}
	}

	private static byte[] readAll(InputStream in) throws Exception {
		try {
			ByteArrayOutputStream out = new ByteArrayOutputStream();
			byte[] buf = new byte[8192];
			int n;
			while ((n = in.read(buf)) > 0) {
				out.write(buf, 0, n);
			}
			return out.toByteArray();
		} finally {
			in.close();
		}
	}
}
