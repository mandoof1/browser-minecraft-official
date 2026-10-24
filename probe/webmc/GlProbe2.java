package webmc;

import org.lwjgl.opengl.Display;
import org.lwjgl.opengl.DisplayMode;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.PixelFormat;

/**
 * Not part of the game. Mojang's 1.12.2 createDisplay() does not call the plain
 * Display.create() our first probe used; it asks for a specific PixelFormat
 * (depth 24, stencil 8, no samples) and passes the list of available display
 * modes so LWJGL can pick a shared context. This probe runs that exact sequence
 * against the WebAssembly GL layer, because that is the last thing the game does
 * before it stops logging and fails.
 */
public class GlProbe2 {

	static void step(String what, Runnable r) {
		System.out.println("[gl2] " + what + " ...");
		try {
			r.run();
			System.out.println("[gl2] " + what + " OK");
		} catch (Throwable t) {
			System.out.println("[gl2] " + what + " FAILED " + t);
			for (int i = 0; i < Math.min(8, t.getStackTrace().length); i++) {
				System.out.println("[gl2]     at " + t.getStackTrace()[i]);
			}
		}
	}

	static DisplayMode[] modes;

	public static void main(String[] args) throws Exception {
		step("getDisplayModes", new Runnable() {
			public void run() {
				DisplayMode[] m;
				try {
					m = Display.getAvailableDisplayModes();
				} catch (Exception e) {
					throw new RuntimeException(e);
				}
				System.out.println("[gl2] available modes: " + (m == null ? "null" : m.length));
				for (int i = 0; i < (m == null ? 0 : Math.min(4, m.length)); i++) {
					System.out.println("[gl2]   " + m[i]);
				}
				modes = m;
			}
		});
		step("setDisplayMode(640x480)", new Runnable() {
			public void run() {
				try {
					Display.setDisplayMode(new DisplayMode(640, 480));
				} catch (Exception e) {
					throw new RuntimeException(e);
				}
			}
		});
		step("create(PixelFormat depth24 stencil8 samples0, modes[])", new Runnable() {
			public void run() {
				try {
					// exactly what Minecraft 1.12.2 asks for
					// Note: Mojang's 1.12.2 createDisplay() asks LWJGL for
					// create(PixelFormat, DisplayMode[]), an overload that only exists in
					// the 2.9.4-nightly jars Mojang ships, not in the 2.9.3 jars this port
					// runs on. So we exercise the closest call that does exist.
					PixelFormat pf = new PixelFormat().withDepthBits(24).withSamples(0).withStencilBits(8);
					Display.setTitle("webmc-gl2");
					Display.create(pf);
				} catch (Throwable e) {
					throw new RuntimeException(e);
				}
			}
		});
		step("glGetString after create", new Runnable() {
			public void run() {
				System.out.println("[gl2] renderer=" + GL11.glGetString(GL11.GL_RENDERER));
				java.nio.IntBuffer db = java.nio.ByteBuffer.allocateDirect(64).order(java.nio.ByteOrder.nativeOrder()).asIntBuffer();
				GL11.glGetInteger(GL11.GL_DEPTH_BITS, db);
				System.out.println("[gl2] GL_DEPTH_BITS=" + db.get(0));
				java.nio.IntBuffer sb = java.nio.ByteBuffer.allocateDirect(64).order(java.nio.ByteOrder.nativeOrder()).asIntBuffer();
				GL11.glGetInteger(GL11.GL_STENCIL_BITS, sb);
				System.out.println("[gl2] GL_STENCIL_BITS=" + sb.get(0));
			}
		});
		step("texture upload like the atlas does", new Runnable() {
			public void run() {
				int[] pixels = new int[256 * 256];
				for (int i = 0; i < pixels.length; i++) {
					pixels[i] = 0x80FF00FF;
				}
				int tex = GL11.glGenTextures();
				GL11.glBindTexture(GL11.GL_TEXTURE_2D, tex);
				GL11.glTexParameteri(GL11.GL_TEXTURE_2D, GL11.GL_TEXTURE_MIN_FILTER, GL11.GL_NEAREST);
				GL11.glTexParameteri(GL11.GL_TEXTURE_2D, GL11.GL_TEXTURE_MAG_FILTER, GL11.GL_NEAREST);
				java.nio.IntBuffer buf = java.nio.ByteBuffer.allocateDirect(pixels.length * 4)
					.order(java.nio.ByteOrder.nativeOrder()).asIntBuffer();
				buf.put(pixels);
				buf.flip();
				GL11.glTexImage2D(GL11.GL_TEXTURE_2D, 0, GL11.GL_RGBA, 256, 256, 0, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, buf);
				System.out.println("[gl2] atlas-sized texture uploaded, glGetError=" + GL11.glGetError());
			}
		});
		step("swap", new Runnable() {
			public void run() {
				Display.update();
				Display.sync(20);
			}
		});
		System.out.println("[gl2] done");
	}
}
