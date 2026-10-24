package webmc;

import org.lwjgl.opengl.ContextCapabilities;
import org.lwjgl.opengl.Display;
import org.lwjgl.opengl.DisplayMode;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.GL20;
import org.lwjgl.opengl.GL30;
import org.lwjgl.opengl.ARBFramebufferObject;
import org.lwjgl.opengl.EXTFramebufferObject;
import org.lwjgl.opengl.GLContext;

/**
 * Not part of the game: our probe for the WebAssembly GL layer.
 *
 * Mojang's 1.12.2 client hangs on its first framebuffer call. The point of this
 * file is to call the same entry points one at a time, in the order the game
 * calls them, and to repeat each one, so the failure can be attributed to a
 * layer: gl4es, LWJGL's Java bindings, or the browser.
 */
public class GlProbe {

	static void step(String what, Runnable r) {
		System.out.println("[glprobe] " + what + " ...");
		try {
			r.run();
			System.out.println("[glprobe] " + what + " OK");
		} catch (Throwable t) {
			System.out.println("[glprobe] " + what + " FAILED " + t);
			for (StackTraceElement e : t.getStackTrace()) {
				System.out.println("[glprobe]     at " + e);
			}
		}
	}

	static void repeat(String what, final int times, final java.util.concurrent.Callable<Integer> c) {
		step(what, new Runnable() {
			public void run() {
				for (int i = 0; i < times; i++) {
					try {
						System.out.println("[glprobe]   call " + (i + 1) + " -> " + c.call());
					} catch (Throwable t) {
						System.out.println("[glprobe]   call " + (i + 1) + " threw " + t);
					}
				}
			}
		});
	}

	public static void main(String[] args) throws Exception {
		System.out.println("[glprobe] java=" + System.getProperty("java.version") + " arch=" + System.getProperty("os.arch"));
		step("Class.forName org.lwjgl.opengl.APIUtil", new Runnable() {
			public void run() {
				try {
					Class<?> c = Class.forName("org.lwjgl.opengl.APIUtil");
					System.out.println("[glprobe] loaded " + c + " from " + c.getProtectionDomain().getCodeSource().getLocation());
					java.lang.reflect.Method[] ms = c.getDeclaredMethods();
					System.out.println("[glprobe] APIUtil methods: " + ms.length);
				} catch (Throwable t) {
					System.out.println("[glprobe] forName threw " + t);
					Throwable c2 = t.getCause();
					while (c2 != null) { System.out.println("[glprobe]   cause " + c2); c2 = c2.getCause(); }
					throw new RuntimeException(t);
				}
			}
		});
		step("setDisplayMode", new Runnable() {
			public void run() {
				try {
					Display.setDisplayMode(new DisplayMode(640, 480));
					Display.setTitle("webmc-glprobe");
					Display.create();
				} catch (Exception e) {
					throw new RuntimeException(e);
				}
			}
		});
		step("glGetString", new Runnable() {
			public void run() {
				System.out.println("[glprobe] vendor=" + GL11.glGetString(GL11.GL_VENDOR)
					+ " glversion=" + GL11.glGetString(GL11.GL_VERSION));
			}
		});
		step("capabilities", new Runnable() {
			public void run() {
				ContextCapabilities c = GLContext.getCapabilities();
				System.out.println("[glprobe] OpenGL30=" + c.OpenGL30 + " ARB_fbo=" + c.GL_ARB_framebuffer_object
					+ " EXT_fbo=" + c.GL_EXT_framebuffer_object + " ARB_mt=" + c.GL_ARB_multitexture
					+ " EXT_pbo=" + c.GL_EXT_pixel_buffer_object + " ARB_vbo=" + c.GL_ARB_vertex_buffer_object
					+ " EXT_blit=" + c.GL_EXT_framebuffer_blit + " OpenGL21=" + c.OpenGL21);
				System.out.println("[glprobe] which variant would OpenGlHelper pick? "
					+ (c.OpenGL30 ? "GL30" : c.GL_ARB_framebuffer_object ? "ARB" : c.GL_EXT_framebuffer_object ? "EXT" : "none"));
			}
		});

		// The exact sequence Minecraft 1.12.2's Framebuffer constructor runs through
		// OpenGlHelper, repeated so a first-call failure becomes visible.
		repeat("ARBFramebufferObject.glGenFramebuffers() x3", 3, new java.util.concurrent.Callable<Integer>() {
			public Integer call() {
				return Integer.valueOf(ARBFramebufferObject.glGenFramebuffers());
			}
		});
		repeat("EXTFramebufferObject.glGenFramebuffersEXT() x2", 2, new java.util.concurrent.Callable<Integer>() {
			public Integer call() {
				return Integer.valueOf(EXTFramebufferObject.glGenFramebuffersEXT());
			}
		});
		repeat("GL30.glGenFramebuffers() x2", 2, new java.util.concurrent.Callable<Integer>() {
			public Integer call() {
				return Integer.valueOf(GL30.glGenFramebuffers());
			}
		});
		repeat("ARBFramebufferObject.glGenRenderbuffers() x2", 2, new java.util.concurrent.Callable<Integer>() {
			public Integer call() {
				return Integer.valueOf(ARBFramebufferObject.glGenRenderbuffers());
			}
		});

		step("full ARB framebuffer flow", new Runnable() {
			public void run() {
				int fbo = ARBFramebufferObject.glGenFramebuffers();
				ARBFramebufferObject.glBindFramebuffer(ARBFramebufferObject.GL_FRAMEBUFFER, fbo);
				int tex = GL11.glGenTextures();
				GL11.glBindTexture(GL11.GL_TEXTURE_2D, tex);
				GL11.glTexParameteri(GL11.GL_TEXTURE_2D, GL11.GL_TEXTURE_MIN_FILTER, GL11.GL_NEAREST);
				GL11.glTexParameteri(GL11.GL_TEXTURE_2D, GL11.GL_TEXTURE_MAG_FILTER, GL11.GL_NEAREST);
				GL11.glTexImage2D(GL11.GL_TEXTURE_2D, 0, GL11.GL_RGBA, 640, 480, 0, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, (java.nio.ByteBuffer) null);
				ARBFramebufferObject.glFramebufferTexture2D(ARBFramebufferObject.GL_FRAMEBUFFER, ARBFramebufferObject.GL_COLOR_ATTACHMENT0, GL11.GL_TEXTURE_2D, tex, 0);
				int rbo = ARBFramebufferObject.glGenRenderbuffers();
				ARBFramebufferObject.glBindRenderbuffer(ARBFramebufferObject.GL_RENDERBUFFER, rbo);
				ARBFramebufferObject.glRenderbufferStorage(ARBFramebufferObject.GL_RENDERBUFFER, GL11.GL_DEPTH_COMPONENT, 640, 480);
				ARBFramebufferObject.glFramebufferRenderbuffer(ARBFramebufferObject.GL_FRAMEBUFFER, ARBFramebufferObject.GL_DEPTH_ATTACHMENT, ARBFramebufferObject.GL_RENDERBUFFER, rbo);
				System.out.println("[glprobe] fbo=" + fbo + " tex=" + tex + " rbo=" + rbo
					+ " status=" + ARBFramebufferObject.glCheckFramebufferStatus(ARBFramebufferObject.GL_FRAMEBUFFER)
					+ " (GL_FRAMEBUFFER_COMPLETE=" + ARBFramebufferObject.GL_FRAMEBUFFER_COMPLETE + ")");
				GL11.glClear(GL11.GL_COLOR_BUFFER_BIT | GL11.GL_DEPTH_BUFFER_BIT);
				System.out.println("[glprobe] cleared inside fbo, glGetError=" + GL11.glGetError());
				ARBFramebufferObject.glBindFramebuffer(ARBFramebufferObject.GL_FRAMEBUFFER, 0);
			}
		});
		step("readPixels inside fbo", new Runnable() {
			public void run() {
				java.nio.ByteBuffer buf = java.nio.ByteBuffer.allocateDirect(4);
				GL11.glReadPixels(0, 0, 1, 1, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, buf);
				System.out.println("[glprobe] readPixels r=" + (buf.get(0) & 0xff));
			}
		});
		step("shader program", new Runnable() {
			public void run() {
				int p = GL20.glCreateProgram();
				int v = GL20.glCreateShader(GL20.GL_VERTEX_SHADER);
				GL20.glShaderSource(v, "void main(){gl_Position=gl_Vertex;}");
				GL20.glCompileShader(v);
				GL20.glAttachShader(p, v);
				GL20.glLinkProgram(p);
				System.out.println("[glprobe] link status=" + GL20.glGetProgrami(p, GL20.GL_LINK_STATUS));
			}
		});
		step("swap", new Runnable() {
			public void run() {
				Display.update();
				Display.sync(10);
			}
		});
		System.out.println("[glprobe] done");
	}
}
