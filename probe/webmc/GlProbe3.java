package webmc;

import java.nio.ByteBuffer;
import java.util.Iterator;

import org.lwjgl.LWJGLException;
import org.lwjgl.opengl.Display;
import org.lwjgl.opengl.DisplayMode;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.PixelFormat;

/**
 * GlProbe3 - reproduce Minecraft 1.12.2's display sequence step by step, slowly,
 * so a JS poller can watch the DOM for the window CheerpJ is supposed to make.
 *
 * Minecraft 1.12.2 does, in order (bib.at()/au()/av() in the obfuscated
 * namespace):
 *
 *     Display.setIcon(new ByteBuffer[]{ icon_16x16, icon_32x32 });
 *     Display.setDisplayMode(new DisplayMode(w, h));
 *     Display.setResizable(true);
 *     Display.setTitle("Minecraft 1.12.2");
 *     Display.create(new PixelFormat().withDepthBits(24));
 *     ... later, in the game loop: Display.update()
 *
 * On Leaning Technologies' own working demo the display element gains
 * `div.cjWindow cjBordered` containing `<canvas class="cjSwapped" 800x500>`.
 * "cjSwapped" hints the canvas is realized on the first buffer swap, which is
 * what this probe exists to test: each step sleeps, so the harness can tell
 * which call (if any) makes the canvas appear.
 */
public class GlProbe3 {

  interface Step { void run() throws Exception; }

  /* Everything on the calling thread: an OpenGL context belongs to the thread
   * that created it, so a per-step worker thread reports "No OpenGL context
   * found" and hides the real answer. Instead mark begin/end and let the JS
   * poller time the gap - a step that never ends is a hang, and the poller is
   * watching the DOM the whole time. */
  static void step(String label, Step s) {
    say("STEP-BEGIN " + label);
    try {
      s.run();
      say("STEP-END " + label + " OK");
    } catch (Throwable t) {
      say("STEP-END " + label + " FAILED " + t.getClass().getName() + ": " + t.getMessage());
    }
    try {
      Thread.sleep(4000);
    } catch (InterruptedException ie) {
    }
  }

  static void say(String s) {
    System.out.println("[gl3] " + s);
  }

  public static void main(String[] args) throws Exception {
    say("java=" + System.getProperty("java.version") + " vm=" + System.getProperty("java.vm.name"));
    say("lwjgl=" + org.lwjgl.Sys.getVersion());

    step("available modes", new Step() {
      public void run() throws LWJGLException {
        int n = 0;
        for (DisplayMode m : Display.getAvailableDisplayModes()) n++;
        say("modes=" + n);
      }
    });

    step("setIcon (1.12.2 does this before create)", new Step() {
      public void run() throws LWJGLException {
        ByteBuffer b = ByteBuffer.allocateDirect(16 * 16 * 4);
        Display.setIcon(new ByteBuffer[]{ b });
      }
    });

    step("setDisplayMode(640x480)", new Step() {
      public void run() throws LWJGLException {
        Display.setDisplayMode(new DisplayMode(640, 480));
        say("mode=" + Display.getDisplayMode().getWidth() + "x" + Display.getDisplayMode().getHeight());
      }
    });

    step("setResizable(true)", new Step() {
      public void run() throws LWJGLException { Display.setResizable(true); }
    });

    step("setTitle", new Step() {
      public void run() { Display.setTitle("Minecraft 1.12.2"); }
    });

    step("create(PixelFormat depth24)", new Step() {
      public void run() throws LWJGLException {
        Display.create(new PixelFormat().withDepthBits(24));
        say("created, current display=" + Display.getDisplayMode().getWidth() + "x" + Display.getDisplayMode().getHeight());
      }
    });

    step("glGetString(RENDERER)", new Step() {
      public void run() { say("renderer=" + GL11.glGetString(GL11.GL_RENDERER)); }
    });

    step("glClear only (no swap)", new Step() {
      public void run() {
        GL11.glViewport(0, 0, 640, 480);
        GL11.glClearColor(0.0f, 1.0f, 0.0f, 0.0f);
        GL11.glClear(GL11.GL_COLOR_BUFFER_BIT | GL11.GL_DEPTH_BUFFER_BIT);
      }
    });

    step("Display.update() x1 (first swap)", new Step() {
      public void run() { Display.update(); }
    });

    step("Display.update() x10 with colour changes", new Step() {
      public void run() {
        for (int i = 0; i < 10; i++) {
          float c = i / 10.0f;
          GL11.glClearColor(c, 0.0f, 1.0f - c, 0.0f);
          GL11.glClear(GL11.GL_COLOR_BUFFER_BIT | GL11.GL_DEPTH_BUFFER_BIT);
          Display.update();
          try { Thread.sleep(200); } catch (InterruptedException ie) {}
        }
      }
    });

    step("Display.isCreated()/isVisible", new Step() {
      public void run() {
        say("isCreated=" + Display.isCreated());
        say("active=" + Display.isActive());
      }
    });

    say("DONE");
  }
}
