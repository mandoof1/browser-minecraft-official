package webmc;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;

/**
 * Prove that a world created in the browser survives the browser.
 *
 * /files/ is CheerpJ's IndexedDB-backed filesystem, so a second run with the
 * same browser profile must see the saves an earlier run wrote. This lists the
 * save directory, reads level.dat back, and pulls the world name out of it -
 * Mojang's own NBT, read straight off the persistent store.
 *
 * Run with `?probe=saves`.
 */
public class SaveProbe {
    public static void main(String[] a) throws Exception {
        File saves = new File(System.getProperty("webmc.gameDir", "/files/minecraft"), "saves");
        File[] worlds = saves.listFiles();
        System.out.println("[saves] " + saves + " -> " + (worlds == null ? "missing" : worlds.length + " worlds"));
        if (worlds == null) {
            return;
        }
        for (int i = 0; i < worlds.length; i++) {
            File lvl = new File(worlds[i], "level.dat");
            System.out.println("[saves] world dir " + worlds[i].getName()
                    + " level.dat exists=" + lvl.exists() + " size=" + lvl.length());
            if (!lvl.exists()) {
                continue;
            }
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            FileInputStream in = new FileInputStream(lvl);
            byte[] chunk = new byte[4096];
            int n;
            int total = 0;
            while ((n = in.read(chunk)) > 0 && total < 200000) {
                bos.write(chunk, 0, n);
                total += n;
            }
            in.close();
            byte[] raw = bos.toByteArray();
            System.out.println("[saves]   read " + raw.length + " bytes, NBT magic="
                    + (raw[0] == 10 ? "compound tag OK" : "unexpected " + raw[0]));
            System.out.println("[saves]   LevelName=" + findString(raw, "LevelName"));
            File icon = new File(worlds[i], "icon.png");
            System.out.println("[saves]   icon.png exists=" + icon.exists() + " size=" + icon.length());
        }
    }

    /**
     * Tiny scan over the raw NBT: find the named string tag rather than parsing
     * the whole tree. Enough to prove the save is real and readable.
     */
    private static String findString(byte[] b, String name) throws Exception {
        byte[] needle = name.getBytes();
        outer:
        for (int i = 0; i + needle.length + 3 < b.length; i++) {
            if (b[i] != 8) {
                continue;
            }
            int len = ((b[i + 1] & 0xff) << 8) | (b[i + 2] & 0xff);
            if (len != needle.length) {
                continue;
            }
            for (int k = 0; k < needle.length; k++) {
                if (b[i + 3 + k] != needle[k]) {
                    continue outer;
                }
            }
            int slen = ((b[i + 3 + len] & 0xff) << 8) | (b[i + 4 + len] & 0xff);
            if (slen <= 0 || i + 5 + len + slen > b.length) {
                continue;
            }
            return new String(b, i + 5 + len, slen, "UTF-8");
        }
        return "(not found)";
    }
}
