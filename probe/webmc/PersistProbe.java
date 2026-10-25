package webmc;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.Date;

/**
 * CheerpJ's /files/ is supposed to be an IndexedDB-backed filesystem that
 * survives a reload. This writes a marker and prints whatever an earlier run
 * left behind, so a second launch answers the question directly: does the
 * persistent filesystem actually persist, and does a world saved in the
 * browser come back?
 *
 * Run with `?probe=persist`.
 */
public class PersistProbe {
    public static void main(String[] a) throws Exception {
        File dir = new File(System.getProperty("webmc.gameDir", "/files/minecraft"));
        File marker = new File(dir, "webmc-persist.txt");
        // /files/ exists but our game directory inside it may not; without this
        // the write below fails and the test says "nothing persisted" when the
        // real problem is that nothing was ever written.
        System.out.println("[persist] mkdirs=" + dir.mkdirs());
        if (marker.exists()) {
            byte[] raw = new byte[(int) marker.length()];
            FileInputStream in = new FileInputStream(marker);
            int n = in.read(raw);
            in.close();
            System.out.println("[persist] FOUND from an earlier run (" + marker.length() + " bytes): "
                    + new String(raw, 0, Math.max(0, n), "UTF-8").replace("\n", " | "));
        } else {
            System.out.println("[persist] no marker yet; gameDir exists=" + dir.exists()
                    + " listing=" + java.util.Arrays.toString(dir.list()));
        }
        String line = "written " + new Date() + " pid-ish " + System.nanoTime() + "\n";
        FileOutputStream out = new FileOutputStream(marker, true);
        out.write(line.getBytes("UTF-8"));
        out.close();
        System.out.println("[persist] appended, file now " + marker.length() + " bytes");
        System.out.println("[persist] " + (marker.exists() ? "read-back ok" : "read-back FAILED"));
        // CheerpJ's filesystem is asynchronous: writes go to IndexedDB in the
        // background. Give that a chance to land before the JVM goes away.
        for (int i = 0; i < 10; i++) {
            System.out.println("[persist] flush " + i + " marker=" + marker.length());
            Thread.sleep(3000);
        }
    }
}
