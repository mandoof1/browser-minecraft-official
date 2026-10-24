package webmc;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Times the part of Minecraft's startup that is not the game: reading every
 * asset object once. The client does roughly this many reads while it loads
 * models, the texture atlas and sounds, so it is the phase that dominates the
 * boot, and it is the phase `?warm=1` is supposed to change.
 *
 * Run with `?probe=assets`. The list of paths comes from objects.txt, which
 * tools/make-object-list.py writes from Mojang's own asset index.
 */
public class AssetProbe {
    public static void main(String[] a) throws Exception {
        String ver = System.getProperty("mc.version", "1.12.2");
        File list = new File("/app/data/vanilla/" + ver + "/objects.txt");
        List<String> paths = new ArrayList<String>();
        InputStream in = new FileInputStream(list);
        StringBuilder sb = new StringBuilder();
        int b;
        while ((b = in.read()) >= 0) {
            if (b == '\n') { paths.add(sb.toString()); sb.setLength(0); }
            else sb.append((char) b);
        }
        in.close();
        if (sb.length() > 0) paths.add(sb.toString());
        System.out.println("[assets] " + paths.size() + " objects, warm=" + System.getProperty("webmc.warm", "?"));

        long t0 = System.currentTimeMillis();
        long bytes = 0;
        for (int i = 0; i < paths.size(); i++) {
            File f = new File(paths.get(i));
            InputStream s = new FileInputStream(f);
            byte[] buf = new byte[65536];
            int n;
            while ((n = s.read(buf)) > 0) bytes += n;
            s.close();
            if ((i + 1) % 100 == 0) {
                long el = System.currentTimeMillis() - t0;
                System.out.println("[assets] " + (i + 1) + "/" + paths.size()
                        + " in " + el + " ms  (" + (el * 1000L / (i + 1)) + " us/file)");
            }
        }
        System.out.println("[assets] done " + paths.size() + " files, " + bytes
                + " bytes in " + (System.currentTimeMillis() - t0) + " ms");
    }
}
