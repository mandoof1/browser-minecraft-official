package com.webmc;

import java.awt.Canvas;
import java.awt.Dimension;
import java.awt.Frame;

import org.lwjgl.opengl.Display;

/**
 * AwtParent - give LWJGL 2 a window CheerpJ can actually put on screen.
 *
 * CheerpJ realizes AWT peers as DOM (a visible java.awt.Frame becomes
 * `div.cjWindow` containing `canvas.cjSwapped`), and its WebAssembly liblwjgl
 * implements the AWTGL entry points (Java_org_lwjgl_opengl_AWTSurfaceLock_*,
 * LinuxAWTGLCanvasPeerInfo_nInitHandle, LinuxDisplay_nLockAWT). Proven by
 * probe/webmc/GlProbe7: setParent(Canvas) + create() yields the same DOM shape
 * Leaning Technologies' own Minecraft demo gets, while the plain X11 route
 * leaves the display element at "Graphics system is initializing" forever.
 *
 * So Minecraft's display is parented to an AWT canvas. The hook is a body
 * replacement on Display.setResizable(boolean), which Minecraft 1.12.2 calls
 * immediately before Display.setTitle and Display.create - the one place in the
 * game's own startup that runs at exactly the right moment, reachable with a
 * single method-body patch (tools/patchclass.py) rather than bytecode surgery
 * inside create().
 */
public class AwtParent {

  private static boolean attached;
  // The frame and canvas are kept in statics: CheerpJ's peer owns the DOM
  // window, and dropping the last Java reference mid-frame is not worth the
  // risk. A shutdown hook would need an inner class, and every class this file
  // compiles to has to be inside the sealed LWJGL jar.
  private static Frame frame;
  private static Canvas canvas;

  public static void attach(boolean ignoredResizable) {
    if (attached) {
      return;
    }
    attached = true;
    try {
      if (Display.getParent() != null) {
        System.out.println("[webmc] AwtParent: a parent is already set, leaving it alone");
        return;
      }
      final Frame frame = new Frame("Minecraft");
      final Canvas canvas = new Canvas();
      AwtParent.frame = frame;
      AwtParent.canvas = canvas;
      canvas.setPreferredSize(new Dimension(854, 480));
      canvas.setMinimumSize(new Dimension(854, 480));
      frame.add(canvas);
      frame.pack();
      frame.setVisible(true);
      Display.setParent(canvas);
      System.out.println("[webmc] AwtParent: LWJGL display parented to an AWT canvas "
          + canvas.getWidth() + "x" + canvas.getHeight());
    } catch (Throwable t) {
      System.out.println("[webmc] AwtParent FAILED " + t);
      t.printStackTrace();
    }
  }
}
