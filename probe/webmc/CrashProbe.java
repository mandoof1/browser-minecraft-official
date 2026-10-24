package webmc;

import java.lang.reflect.Method;

/**
 * Not part of the game. Mojang's client turns any startup failure into a crash
 * report, and under CheerpJ building that report throws NullPointerException,
 * which hides the failure we actually care about. This probe drives Mojang's own
 * crash-report classes (the obfuscated b/c/f in client.jar) directly, so the
 * port can tell whether crash reports are usable at all - and if they are, print
 * one, which is where the original exception would be named.
 */
public class CrashProbe {

	static void say(String s) {
		System.out.println("[crashprobe] " + s);
	}

	static Object call(Object receiver, String name, Class<?>[] types, Object[] args) throws Exception {
		Class<?> c = receiver.getClass();
		Method m = c.getMethod(name, types);
		m.setAccessible(true);
		return m.invoke(receiver, args);
	}

	public static void main(String[] args) throws Exception {
		StackTraceElement[] st = Thread.currentThread().getStackTrace();
		say("Thread.getStackTrace() -> " + (st == null ? "null" : st.length + " frames"));
		say("Thread.getAllStackTraces() -> " + Thread.getAllStackTraces());

		// Mojang's own crash-report entry point: CrashReport.makeCrashReport
		Class<?> crashReport = Class.forName("b");
		Object report;
		try {
			report = crashReport.getMethod("a", Throwable.class, String.class)
				.invoke(null, new RuntimeException("probe: what the game would have reported"), "Initializing game");
			say("makeCrashReport OK: " + report);
		} catch (Throwable t) {
			say("makeCrashReport FAILED: " + t);
			Throwable c = t.getCause();
			while (c != null) {
				say("   cause " + c);
				for (int i = 0; i < Math.min(6, c.getStackTrace().length); i++) {
					say("      at " + c.getStackTrace()[i]);
				}
				c = c.getCause();
			}
			return;
		}
		try {
			crashReport.getMethod("a", String.class).invoke(report, "Initialization");
			say("addDetails OK");
		} catch (Throwable t) {
			say("addDetails FAILED: " + t);
			Throwable c = t.getCause();
			while (c != null) {
				say("   cause " + c);
				for (int i = 0; i < Math.min(8, c.getStackTrace().length); i++) {
					say("      at " + c.getStackTrace()[i]);
				}
				c = c.getCause();
			}
		}
		try {
			String text = (String) crashReport.getMethod("a").invoke(report);
			say("report follows:\n" + text);
		} catch (Throwable t) {
			say("report text FAILED: " + t);
		}
		say("done");
	}
}
