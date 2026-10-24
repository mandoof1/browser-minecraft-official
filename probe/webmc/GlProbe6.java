package webmc;

import java.awt.Frame;

import org.lwjgl.opengl.Display;
import org.lwjgl.opengl.DisplayMode;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.PixelFormat;

/**
 * GlProbe6 - separate the two ways a window can appear under CheerpJ.
 *
 * CheerpJ realizes windows through AWT peers (com.leaningtech.cheerpj.
 * CheerpJWindowPeer in cheerpj-awt.jar is what carries the `cjWindow` class and
 * `cjSwapped` canvas). Minecraft 1.2.5 gets one; Minecraft 1.12.2 never does,
 * and neither does a probe that repeats 1.2.5's LWJGL calls call for call. So
 * the LWJGL/X11 route and the AWT route have to be tested apart.
 *
 * Step 1 asks whether AWT is even usable here (headless? which graphicsenv?).
 * Step 2 makes an AWT Frame visible: if that produces div.cjWindow, the AWT
 * route works and the question is why LWJGL's X11 client never reaches it.
 * Step 3 then does the LWJGL display, as before.
 */
public class GlProbe6 {

  static void say(String s) {
    System.out.println("[gl6] " + s);
  }

  static void pause(String what) {
    say("PAUSE " + what);
    try {
      Thread.sleep(9000);
    } catch (InterruptedException ie) {
    }
  }

  public static void main(String[] args) throws Exception {
    say("headless=" + java.awt.GraphicsEnvironment.isHeadless()
        + " graphicsenv=" + System.getProperty("java.awt.graphicsenv")
        + " toolkit=" + System.getProperty("awt.toolkit"));

    pause("after reporting awt environment");

    try {
      Frame f = new Frame("webmc awt probe");
      f.setSize(640, 480);
      f.setVisible(true);
      say("AWT frame visible: " + f.isDisplayable() + " peer=" + (f.getPeer() == null ? "none" : f.getPeer().getClass().getName()));
    } catch (Throwable t) {
      say("AWT frame FAILED " + t);
    }

    pause("after AWT frame");

    try {
      Display.setDisplayMode(new DisplayMode(854, 480));
      Display.setTitle("Minecraft Minecraft 1.2.5");
      Display.create(new PixelFormat().withDepthBits(24));
      say("lwjgl create OK");
      GL11.glClearColor(1.0f, 0.0f, 0.0f, 0.0f);
      GL11.glClear(GL11.GL_COLOR_BUFFER_BIT);
      Display.update();
      say("lwjgl swap OK renderer=" + GL11.glGetString(GL11.GL_RENDERER));
    } catch (Throwable t) {
      say("lwjgl FAILED " + t);
    }

    pause("after lwjgl");
    say("DONE");
  }
}
