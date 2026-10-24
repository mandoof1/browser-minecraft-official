package webmc;

import java.io.File;
import java.io.FileInputStream;

/**
 * Print the crash reports Mojang wrote into the persistent game directory.
 * /files/ is CheerpJ's IndexedDB-backed filesystem, so a later run with the
 * same browser profile can read what an earlier run wrote - which is the only
 * way to see a crash the launcher's own handler never got to print.
 *
 * Run with `?probe=crashdump`.
 */
public class CrashDump {
    public static void main(String[] a) throws Exception {
        File dir = new File(System.getProperty("webmc.gameDir", "/files/minecraft"), "crash-reports");
        File[] found = dir.listFiles();
        System.out.println("[crashdump] " + dir + " -> " + (found == null ? "missing" : found.length + " files"));
        if (found == null) {
            return;
        }
        for (int i = 0; i < found.length; i++) {
            System.out.println("[crashdump] === " + found[i].getName() + " (" + found[i].length() + " bytes)");
            byte[] raw = new byte[(int) Math.min(found[i].length(), 20000)];
            FileInputStream in = new FileInputStream(found[i]);
            int n = in.read(raw);
            in.close();
            String[] lines = new String(raw, 0, Math.max(0, n), "UTF-8").split("\n");
            for (int k = 0; k < Math.min(lines.length, 60); k++) {
                System.out.println("[crashdump] > " + lines[k]);
            }
        }
    }
}
