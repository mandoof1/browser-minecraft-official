package webmc;

import java.nio.ByteBuffer;

import org.lwjgl.LWJGLException;
import org.lwjgl.opengl.Display;
import org.lwjgl.opengl.DisplayMode;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.PixelFormat;

/**
 * GlProbe4 - bisect which call in Minecraft 1.12.2's display sequence stops
 * CheerpJ from realizing a window.
 *
 * Facts this is built on:
 *   - Minecraft 1.2.5 on this same origin, same CheerpJ 4.3, same LWJGL 2.9.3,
 *     same gl4es.wasm: `div.cjWindow` + `canvas.cjSwapped` appear ~20s in.
 *   - Minecraft 1.12.2 on the same origin: GL works, Display.create() returns,
 *     Display.update() swaps, and no window ever appears.
 *   - 1.12.2 adds calls 1.2.5 does not make: Display.setResizable(true),
 *     Display.setIcon(ByteBuffer[]), and create(PixelFormat.withDepthBits(24)).
 *
 * One variant per page load (a window, once made, cannot be unmade), chosen by
 * the `webmc.variant` Java property. The JS side watches the DOM the whole time.
 */
public class GlProbe4 {

  static void say(String s) {
    System.out.println("[gl4] " + s);
  }

  static void pause(String what) {
    say("PAUSE " + what);
    try {
      Thread.sleep(9000);
    } catch (InterruptedException ie) {
    }
  }

  public static void main(String[] args) throws Exception {
    String variant = System.getProperty("webmc.variant", "minimal");
    say("variant=" + variant + " java=" + System.getProperty("java.version"));

    if (variant.equals("available")) {
      DisplayMode[] modes = Display.getAvailableDisplayModes();
      say("modes=" + modes.length + " first=" + modes[0].getWidth() + "x" + modes[0].getHeight()
          + " depth=" + modes[0].getBitsPerPixel() + " freq=" + modes[0].getFrequency());
      Display.setDisplayMode(modes[0]);
      say("setDisplayMode(available[0]) OK");
    } else {
      Display.setDisplayMode(new DisplayMode(640, 480));
      say("setDisplayMode(640x480) OK");
    }

    if (variant.equals("mc125")) {
      // Leaning Technologies' demo target, call for call: setDisplayMode(854x480)
      // -> setTitle -> create(new PixelFormat().withDepthBits(24)).
      Display.setDisplayMode(new DisplayMode(854, 480));
      Display.setTitle("Minecraft Minecraft 1.2.5");
      Display.create(new PixelFormat().withDepthBits(24));
      say("mc125 sequence done");
      for (int i = 0; i < 40; i++) {
        GL11.glClear(GL11.GL_COLOR_BUFFER_BIT);
        Display.update();
        try { Thread.sleep(120); } catch (InterruptedException ie) {}
      }
      say("DONE variant=" + variant);
      return;
    }

    if (variant.equals("resizable")) {
      Display.setResizable(true);
      say("setResizable OK");
    }
    if (variant.equals("title")) {
      Display.setTitle("Minecraft 1.12.2");
      say("setTitle OK");
    }
    if (variant.equals("icon")) {
      ByteBuffer b = ByteBuffer.allocateDirect(16 * 16 * 4);
      for (int i = 0; i < b.capacity(); i++) b.put(i, (byte) (i * 7));
      Display.setIcon(new ByteBuffer[]{ b });
      say("setIcon OK");
    }

    pause("before create");

    if (variant.equals("depth24")) {
      Display.create(new PixelFormat().withDepthBits(24));
      say("create(withDepthBits(24)) OK");
    } else {
      Display.create();
      say("create() OK");
    }

    pause("after create");

    try {
      GL11.glViewport(0, 0, 640, 480);
      GL11.glClearColor(0.0f, 1.0f, 0.0f, 0.0f);
      GL11.glClear(GL11.GL_COLOR_BUFFER_BIT | GL11.GL_DEPTH_BUFFER_BIT);
      Display.update();
      say("clear+update OK, renderer=" + GL11.glGetString(GL11.GL_RENDERER));
    } catch (Throwable t) {
      say("clear+update FAILED " + t);
    }

    pause("after first swap");

    if (variant.equals("input")) {
      // Minecraft 1.2.5 gets a window and a probe repeating its Display calls
      // does not, so the window must come from something else 1.2.5 does. Its
      // next calls after create() are Keyboard.create()/Mouse.create() (the log
      // shows "Native cursors not supported" from org.lwjgl.input.Cursor).
      try {
        org.lwjgl.input.Keyboard.create();
        say("Keyboard.create OK");
      } catch (Throwable t) {
        say("Keyboard.create FAILED " + t);
      }
      try {
        org.lwjgl.input.Mouse.create();
        say("Mouse.create OK");
      } catch (Throwable t) {
        say("Mouse.create FAILED " + t);
      }
      for (int i = 0; i < 30; i++) {
        GL11.glClear(GL11.GL_COLOR_BUFFER_BIT);
        Display.update();
        try { Thread.sleep(120); } catch (InterruptedException ie) {}
      }
      say("input loop done");
    }

    if (variant.equals("pump")) {
      // A window may only be realized once the X11 client pumps events, the way
      // a game loop does, rather than once per frame. 60 iterations of
      // update()+processMessages() with a real gap between them.
      for (int i = 0; i < 60; i++) {
        GL11.glClear(GL11.GL_COLOR_BUFFER_BIT);
        Display.update();
        Display.processMessages();
        try {
          Thread.sleep(100);
        } catch (InterruptedException ie) {
        }
        if ((i % 10) == 0) say("pump " + i + " created=" + Display.isCreated() + " active=" + Display.isActive());
      }
      say("pump done");
    }

    say("DONE variant=" + variant);
  }
}
