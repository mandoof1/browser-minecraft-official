package webmc;

import java.awt.image.BufferedImage;
import java.awt.image.DataBufferInt;

/**
 * Mojang's NativeImage goes through BufferedImage/DataBufferInt, and the client
 * died with "NoClassDefFoundError: java/awt/image/DataBufferInt" about 100 s
 * after a world finished loading - which is when the integrated server first
 * saves and renders the level icon. CheerpJ's rt.jar does contain the class,
 * so this checks what actually happens when it is used.
 *
 * Run with `?probe=awtimage`.
 */
public class AwtImageProbe {
    public static void main(String[] a) {
        String[] steps = { "class forName", "new DataBufferInt", "new BufferedImage", "setRGB/getRGB" };
        for (String step : steps) {
            System.out.println("[awtimage] " + step);
            try {
                if (step.equals("class forName")) {
                    System.out.println("[awtimage]   " + Class.forName("java.awt.image.DataBufferInt"));
                } else if (step.equals("new DataBufferInt")) {
                    DataBufferInt d = new DataBufferInt(4);
                    System.out.println("[awtimage]   size=" + d.getSize() + " bank0=" + d.getData().length);
                } else if (step.equals("new BufferedImage")) {
                    BufferedImage img = new BufferedImage(8, 8, BufferedImage.TYPE_INT_ARGB);
                    System.out.println("[awtimage]   " + img.getWidth() + "x" + img.getHeight()
                            + " raster=" + img.getRaster().getClass().getName());
                } else {
                    BufferedImage img = new BufferedImage(8, 8, BufferedImage.TYPE_INT_ARGB);
                    img.setRGB(3, 3, 0x11223344);
                    System.out.println("[awtimage]   read back " + Integer.toHexString(img.getRGB(3, 3)));
                }
            } catch (Throwable t) {
                System.out.println("[awtimage]   FAILED " + t);
                for (int i = 0; i < Math.min(t.getStackTrace().length, 6); i++) {
                    System.out.println("[awtimage]     at " + t.getStackTrace()[i]);
                }
            }
        }
        System.out.println("[awtimage] done");
    }
}
