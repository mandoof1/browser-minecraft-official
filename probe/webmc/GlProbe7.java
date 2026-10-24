package webmc;

import java.awt.Canvas;
import java.awt.Dimension;
import java.awt.Frame;

import org.lwjgl.LWJGLException;
import org.lwjgl.opengl.Display;
import org.lwjgl.opengl.DisplayMode;
import org.lwjgl.opengl.GL11;
import org.lwjgl.opengl.PixelFormat;

/**
 * GlProbe7 - the other way to give LWJGL 2 a window: Display.setParent(Canvas).
 *
 * CheerpJ realizes AWT peers as DOM (a Frame made visible in GlProbe6 produced
 * `div.cjWindow` + `canvas.cjSwapped`), and its WebAssembly liblwjgl imports the
 * AWTGL entry points - Java_org_lwjgl_opengl_AWTSurfaceLock_createHandle,
 * LinuxAWTGLCanvasPeerInfo_nInitHandle, LinuxDisplay_nLockAWT - so the AWT
 * parent path is implemented. If this probe gets a canvas, Minecraft's display
 * can be routed through AWT instead of the X11 route that never realizes one.
 */
public class GlProbe7 {

  static void say(String s) {
    System.out.println("[gl7] " + s);
  }

  static void pause(String what) {
    say("PAUSE " + what);
    try {
      Thread.sleep(9000);
    } catch (InterruptedException ie) {
    }
  }

  public static void main(String[] args) throws Exception {
    String variant = System.getProperty("webmc.variant", "parent");
    say("variant=" + variant);

    Frame frame = null;
    Canvas canvas = null;
    try {
      frame = new Frame("Minecraft (webmc)");
      canvas = new Canvas();
      canvas.setPreferredSize(new Dimension(854, 480));
      canvas.setMinimumSize(new Dimension(854, 480));
      frame.add(canvas);
      frame.pack();
      frame.setVisible(true);
      say("frame visible, canvas size=" + canvas.getWidth() + "x" + canvas.getHeight()
          + " displayable=" + canvas.isDisplayable());
    } catch (Throwable t) {
      say("frame FAILED " + t);
    }

    pause("after AWT frame");

    try {
      Display.setParent(canvas);
      say("setParent OK parentActive=" + Display.isCreated());
    } catch (Throwable t) {
      say("setParent FAILED " + t);
    }

    pause("after setParent");

    try {
      if (variant.equals("create")) {
        Display.create(new PixelFormat().withDepthBits(24));
        say("create after setParent OK");
      }
      GL11.glViewport(0, 0, 854, 480);
      GL11.glClearColor(0.0f, 1.0f, 0.0f, 0.0f);
      GL11.glClear(GL11.GL_COLOR_BUFFER_BIT | GL11.GL_DEPTH_BUFFER_BIT);
      Display.update();
      say("swap OK created=" + Display.isCreated() + " renderer=" + GL11.glGetString(GL11.GL_RENDERER));
    } catch (Throwable t) {
      say("gl FAILED " + t);
    }

    for (int i = 0; i < 25; i++) {
      try {
        GL11.glClearColor(i / 25.0f, 0.5f, 1.0f - i / 25.0f, 0.0f);
        GL11.glClear(GL11.GL_COLOR_BUFFER_BIT);
        Display.update();
        Thread.sleep(120);
      } catch (Throwable t) {
        say("loop FAILED " + t);
        break;
      }
    }

    pause("after loop");
    say("DONE");
  }
}
